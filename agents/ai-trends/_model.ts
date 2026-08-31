import { Agent, OpenAIChatCompletionsModel, run, tool } from '@openai/agents';
import { OpenAI } from 'openai';
import { z } from 'zod';

import type { TrendLibraryItem } from './_items.js';
import { generateFallbackReport, utcNow } from './_report.js';
import type {
  CuratorOutput,
  FinishedReport,
  SummarizerOutput,
  TrendAnalysis,
  TrendGroup,
  TrendReport,
  TrendSourceItem,
} from './_types.js';
import {
  ComparePeriodsParamsSchema,
  GetHistoryItemsParamsSchema,
} from './_types.js';

// ── OpenAI client setup (via AI Gateway) ──────────────────────────

export function buildOpenAIClientOptions(env: Record<string, string | undefined>): { apiKey?: string; baseURL?: string } {
  return {
    apiKey: env.LLM_API_KEY || env.AI_GATEWAY_API_KEY || env.OPENAI_API_KEY,
    baseURL: env.LLM_BASE_URL || env.AI_GATEWAY_BASE_URL || env.OPENAI_BASE_URL,
  };
}

function createModel(env: Record<string, string | undefined>): OpenAIChatCompletionsModel {
  const opts = buildOpenAIClientOptions(env);
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    timeout: 600000,
  });
  const modelName = env.LLM_MODEL || env.AI_GATEWAY_MODEL || '@makers/minimax-m2.7';
  return new OpenAIChatCompletionsModel(client as any, modelName);
}

// ── JSON parsing helpers ──────────────────────────────────────────

/**
 * Strip <think>...</think> reasoning tags that some models (DeepSeek, etc.)
 * emit in their output. These should never appear in final user-facing content.
 * Handles multiline content and multiple occurrences.
 */
function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function parseJsonFromText<T>(text: string): T | null {
  // Strip thinking tags first — some models prepend <think>...</think> before JSON
  const cleaned = stripThinkingTags(text);

  // Helper: fix common JSON issues (trailing commas, etc.)
  function tryParse(json: string): T | null {
    // Direct attempt
    try { return JSON.parse(json) as T; } catch { /* continue */ }
    // Fix trailing commas: ,] or ,}
    const fixed = json
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/,\s*$/g, '');
    try { return JSON.parse(fixed) as T; } catch { /* continue */ }
    // Try to fix truncated JSON by closing brackets
    let attempt = fixed;
    const opens = (attempt.match(/[{[]/g) || []).length;
    const closes = (attempt.match(/[}\]]/g) || []).length;
    for (let i = 0; i < opens - closes; i++) {
      // Determine which bracket to close
      const lastOpen = Math.max(attempt.lastIndexOf('{'), attempt.lastIndexOf('['));
      attempt += attempt[lastOpen] === '{' ? '}' : ']';
    }
    try { return JSON.parse(attempt) as T; } catch { /* continue */ }
    return null;
  }

  // Try direct parse
  const direct = tryParse(cleaned);
  if (direct) return direct;

  // Try extracting JSON block from markdown code fence
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const result = tryParse(fenceMatch[1]);
    if (result) return result;
  }
  // Try extracting first { ... } or [ ... ]
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const result = tryParse(objMatch[0]);
    if (result) return result;
  }
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    const result = tryParse(arrMatch[0]);
    if (result) return result;
  }
  // Last resort: find the first { and try to parse from there (handles preamble text)
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace > 0) {
    const result = tryParse(cleaned.slice(firstBrace));
    if (result) return result;
  }
  console.warn('[parseJson] all attempts failed, first 200 chars:', cleaned.slice(0, 200));
  return null;
}

// ── Tool definitions ──────────────────────────────────────────────

/**
 * Create a sandbox-powered fetch tool for Agents (usage A).
 * Uses context.sandbox.commands.run('curl ...') to fetch URL content.
 * Compatible with ChatCompletions API via @openai/agents tool().
 */
function createSandboxFetchTool(sandbox: any) {
  return tool({
    name: 'fetch_url',
    description: 'Fetch webpage content for given URL via sandbox curl (first 3000 chars). Use this tool when you need to understand detailed content of an article to assist trend judgment.',
    parameters: z.object({
      url: z.string().min(1).describe('Full URL to fetch'),
    }),
    execute: async (input: { url: string }) => {
      console.log(`[fetch_url] Agent called fetch_url: ${input.url}`);
      try {
        const result = await sandbox.commands.run(
          `curl -sL --max-time 10 '${input.url.replace(/'/g, "'\\''")}' | head -c 3000`,
        );
        if (result?.exitCode && result.exitCode !== 0) {
          console.warn(`[fetch_url] curl failed: exit=${result.exitCode}`);
          return JSON.stringify({ error: `curl failed: ${result.stderr || 'unknown error'}` });
        }
        console.log(`[fetch_url] success, ${(result?.stdout || '').length} chars`);
        return result?.stdout || '(empty response)';
      } catch (err: any) {
        console.warn(`[fetch_url] error:`, err?.message);
        return JSON.stringify({ error: err?.message || 'fetch failed' });
      }
    },
  });
}

function createGetHistoryItemsTool(historyItems: TrendLibraryItem[]) {
  return tool({
    name: 'get_history_items',
    description: 'Retrieve historical AI news items to compare current vs past trends. Returns items within a specified time range.',
    parameters: GetHistoryItemsParamsSchema,
    execute: async (input: { maxItems?: number; daysBack?: number }) => {
      const maxItems = input.maxItems ?? 50;
      const daysBack = input.daysBack ?? 7;
      const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
      const filtered = historyItems
        .filter(item => (item.lastSeenAt || item.firstSeenAt || '') >= cutoff)
        .slice(0, maxItems);
      return JSON.stringify({
        count: filtered.length,
        items: filtered.map(item => ({
          id: item.id, title: item.title, category: item.category,
          source: item.source, seenCount: item.seenCount,
          firstSeenAt: item.firstSeenAt, lastSeenAt: item.lastSeenAt,
          isNew: item.isNew,
        })),
      });
    },
  });
}

function createComparePeriodsTool(
  currentItems: TrendSourceItem[],
  historyItems: TrendLibraryItem[],
) {
  return tool({
    name: 'compare_periods',
    description: 'Compare trend data differences between current and previous period by specified dimension (count/categories/sources).',
    parameters: ComparePeriodsParamsSchema,
    execute: async (input: { currentItemIds: string[]; metric: 'count' | 'categories' | 'sources' }) => {
      const currentSet = new Set(input.currentItemIds);
      const current = currentItems.filter(i => currentSet.has(i.id));
      const previous = historyItems.filter(i => !currentSet.has(i.id));

      const countBy = (items: TrendSourceItem[], key: 'category' | 'source') => {
        const map: Record<string, number> = {};
        for (const i of items) {
          const k = (key === 'category' ? i.category : i.source) || 'Other';
          map[k] = (map[k] || 0) + 1;
        }
        return map;
      };

      if (input.metric === 'count') {
        return JSON.stringify({ currentCount: current.length, previousCount: previous.length, delta: current.length - previous.length });
      }
      if (input.metric === 'categories') {
        return JSON.stringify({ current: countBy(current, 'category'), previous: countBy(previous, 'category') });
      }
      return JSON.stringify({ current: countBy(current, 'source'), previous: countBy(previous, 'source') });
    },
  });
}

// ── Agent factory functions (no outputType — prompt-guided JSON) ──

function createCuratorAgent(env: Record<string, string | undefined>) {
  return new Agent({
    name: 'CuratorAgent',
    instructions: [
      'You are an AI trend curation expert. Filter and classify from raw candidate content.',
      '',
      'Curation criteria:',
      '1. Keep only content directly related to AI Agent, LLM, Multimodal, Open Source Model, AI Infra, AI Products;',
      '2. Exclude pure job postings, marketing advertorials, duplicate/low-quality content;',
      '3. Re-evaluate category for each item (AI Agent / LLM / Multimodal / Open Source Model / AI Infra / AI Industry);',
      '4. keep=true means keep, keep=false means discard;',
      '5. reason briefly explains the keep/discard reason (in English).',
      '',
      'You must output only JSON, format as follows (no other text):',
      '{"items":[{"id":"...","title":"...","url":"...","category":"...","reason":"...","keep":true}],"droppedCount":5,"curatorNotes":"..."}',
    ].join('\n'),
    model: createModel(env),
  });
}

function createSummarizerAgent(env: Record<string, string | undefined>) {
  return new Agent({
    name: 'SummarizerAgent',
    instructions: [
      'You are an AI news summarization expert. Generate concise English summaries for each AI-related update.',
      '',
      'Requirements:',
      '1. Each summary 1-2 sentences, distill core information;',
      '2. Do not output HTML;',
      '3. Do not use generic placeholders like "Please verify with source";',
      '',
      'You must output only JSON, format as follows (no other text):',
      '{"items":[{"id":"...","aiSummary":"..."}]}',
    ].join('\n'),
    model: createModel(env),
  });
}

function createAnalystAgent(
  env: Record<string, string | undefined>,
  currentItems: TrendSourceItem[],
  historyItems: TrendLibraryItem[],
  sandbox?: unknown,
) {
  const tools: any[] = [
    createGetHistoryItemsTool(historyItems),
    createComparePeriodsTool(currentItems, historyItems),
  ];
  // Inject sandbox fetch tool if sandbox is available (usage A: Agent autonomously calls sandbox)
  if (sandbox && typeof (sandbox as any)?.commands?.run === 'function') {
    tools.push(createSandboxFetchTool(sandbox));
  }
  return new Agent({
    name: 'AnalystAgent',
    instructions: [
      'You are a senior AI industry analyst. Classify and assess importance based on current news and historical data.',
      '',
      'Analysis requirements:',
      '1. Objectively classify items as:',
      '   - new: first collected in this run (isNew=true)',
      '   - active: appeared consecutively multiple times (seenCount >= 2)',
      '   - single: appeared only once but worth recording',
      '2. Group items by category (AI Agent / LLM / Multimodal / Open Source Model / AI Infra / AI Industry);',
      '3. Use get_history_items tool to retrieve historical data and determine which items are continuously active;',
      '4. If fetch_url tool is available, select 2-3 items you consider most important to fetch and provide brief analysis;',
      '5. All conclusions must be based on actual data, do not fabricate facts;',
      '6. Limit fetch_url to the most important 2-3 items, do not call for every item;',
      '',
      'You must output only JSON (no other text), format as follows:',
      '{"categories":[{"name":"AI Agent","items":[{"id":"...","title":"...","status":"new|active|single","importance":"high|medium|low"}]}],"deepDives":[{"id":"...","title":"...","insight":"one-sentence analysis"}],"keyInsight":"comprehensive core insight (under 80 characters)","scores":[{"id":"...","score":82}]}',
      '',
      'Where scores is the comprehensive recommendation score (0-100) for each retained item, every item must have one.',
    ].join('\n'),
    model: createModel(env),
    tools,
  });
}

function createWriterAgent(env: Record<string, string | undefined>) {
  return new Agent({
    name: 'WriterAgent',
    instructions: [
      'You are an AI trend report writer. Based on structured analysis data, write a standardized Markdown report in English.',
      '',
      'Report must strictly follow the structure below (do not add or remove sections):',
      '',
      '# AI Trend Daily',
      '',
      '## Key Highlights',
      '(2-3 core findings, under 100 words, expanded from keyInsight field)',
      '',
      '## Trending Now',
      '(Grouped by category. Each item format: `- [Title](url) — one-sentence summary`)',
      '',
      '### AI Agent',
      '- [Title](url) — summary',
      '',
      '### LLM',
      '- [Title](url) — summary',
      '',
      '(Other categories likewise, omit categories with no items)',
      '',
      '## New Arrivals',
      '(Items with status=new, indicating first-time collection)',
      '',
      '## Sustained Activity',
      '(Items with status=active, indicating consecutive appearances, list seenCount)',
      '',
      '## Deep Dive',
      '(Based on deepDives field, 2-3 deeply analyzed items with insight)',
      '',
      'Writing requirements:',
      '1. All source links use Markdown hyperlink format [title](url);',
      '2. Do not fabricate sources, all links must come from input data;',
      '3. Style concise and professional, total length 1500-3000 words;',
      '4. Output Markdown content directly, do not wrap in JSON or code blocks;',
      '5. Do not add unsupported sections like "Follow-up Questions".',
    ].join('\n'),
    model: createModel(env),
  });
}

// ── Prompt builders ───────────────────────────────────────────────

function buildItemsJson(items: TrendSourceItem[]): string {
  return JSON.stringify(items.slice(0, 30).map(item => ({
    id: item.id, title: item.title, url: item.url,
    source: item.source, category: item.category,
    sourceScore: item.score ?? 0, // Real engagement data from source (HN upvotes / DevTo reactions / 0=no data)
    summary: item.summary,
    isNew: item.isNew ?? false, seenCount: item.seenCount ?? 1,
  })));
}

function buildAnalystPrompt(items: TrendSourceItem[], noNewItems?: boolean): string {
  const lines = [
    'Please analyze the following AI news items, group by category and assess importance.',
    'First use get_history_items to retrieve historical data and determine which items are continuously active.',
    'Then select 2-3 most important items to fetch via fetch_url for deeper understanding.',
    'Finally output analysis result JSON.',
    '',
    '[IMPORTANT] You must assign a 0-100 comprehensive recommendation score (scores field) for each retained item:',
    '  - Popularity (30%): reference sourceScore (real engagement data from source) + topic volume. sourceScore=0 means no engagement data, judge by title/content.',
    '  - Quality (40%): original deep content, first-hand news, technical breakthrough > second-hand repost > marketing fluff. You have read some articles via fetch_url, judge depth accordingly.',
    '  - Relevance (30%): direct alignment with AI core topics (Agent/LLM/Multimodal/Open Source Model/Infra).',
    '',
    'Scoring reference:',
    '  95-100: Epoch-making event (e.g. GPT-5 release)',
    '  80-94: Major progress / deep exclusive (e.g. new model open source, important paper)',
    '  65-79: Noteworthy industry update / technical blog',
    '  50-64: General news / second-hand repost',
    '  <50: Marginally relevant (usually filtered by Curator)',
    '',
  ];
  if (noNewItems) {
    lines.push('Note: No new content found in this collection, please focus on continuously active items.', '');
  }
  lines.push(`Current news items: ${buildItemsJson(items)}`);
  return lines.join('\n');
}

function buildWriterPrompt(items: TrendSourceItem[], analysis: TrendAnalysis | null, noNewItems?: boolean): string {
  const lines: string[] = [];
  if (analysis) {
    lines.push('Please write the report strictly according to your report structure template based on the following structured analysis data:', '', `Analysis data: ${JSON.stringify(analysis)}`);
  } else {
    lines.push('Analyst failed to generate analysis data, please write directly based on the following news items according to the report structure template:');
  }
  // Data source summary for the report header
  const sourceCounts = items.reduce((acc, i) => { const k = i.source || 'unknown'; acc[k] = (acc[k] || 0) + 1; return acc; }, {} as Record<string, number>);
  const newCount = items.filter(i => i.isNew).length;
  lines.push('', `Data source stats: ${JSON.stringify(sourceCounts)}, ${newCount} new items`);
  lines.push('', 'Original items (including url, category, aiSummary for filling report links and summaries):', buildItemsJson(items));
  if (noNewItems) {
    lines.push('', 'Note: No new content found. Mention in "Key Highlights", write "No new items in this run" in the "New Arrivals" section.');
  }
  return lines.join('\n');
}

// ── Report assembly helpers ───────────────────────────────────────

function buildTrendGroups(items: TrendSourceItem[]): TrendGroup[] {
  const grouped = new Map<string, TrendSourceItem[]>();
  for (const item of items) {
    const category = item.category || 'AI Industry';
    grouped.set(category, [...(grouped.get(category) || []), item]);
  }
  return Array.from(grouped.entries()).map(([category, catItems]) => ({
    category,
    summary: catItems.slice(0, 3).map(i => i.title).join('; '),
    count: catItems.length,
    items: catItems.slice(0, 5),
  }));
}

function assembleReportFromWriter(items: TrendSourceItem[], markdown: string, runId: string, trigger: string): TrendReport {
  const firstLine = markdown.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() || '';
  const summary = firstLine.slice(0, 120) || `${items.length} AI news trend analysis`;
  return {
    runId,
    status: 'success',
    trigger,
    generatedAt: utcNow(),
    itemCount: items.length,
    summary,
    reportMarkdown: markdown,
    trends: buildTrendGroups(items),
    items,
  };
}

function assembleReportFromAnalysis(items: TrendSourceItem[], analysis: TrendAnalysis, runId: string, trigger: string): TrendReport {
  const lines = ['# AI Trend Daily', '', `> ${analysis.keyInsight}`, ''];

  // Group by category from analyst output
  if (analysis.categories?.length) {
    lines.push('## Trending Now', '');
    for (const cat of analysis.categories) {
      lines.push(`### ${cat.name}`, '');
      for (const entry of cat.items) {
        const item = items.find(i => i.id === entry.id);
        if (item) {
          lines.push(`- [${item.title}](${item.url}) — ${item.aiSummary || item.summary || entry.status}`);
        }
      }
      lines.push('');
    }
  }

  // Deep dives
  if (analysis.deepDives?.length) {
    lines.push('## Deep Dive', '');
    for (const dd of analysis.deepDives) {
      const item = items.find(i => i.id === dd.id);
      const url = item?.url || '';
      lines.push(`- [${dd.title}](${url}) — ${dd.insight}`);
    }
    lines.push('');
  }

  const report = generateFallbackReport(items, runId, trigger);
  report.reportMarkdown = lines.join('\n');
  report.summary = analysis.keyInsight;
  report.agentWarning = 'Writer agent failed; report generated from analyst output';
  return report;
}

// ── Pipeline ──────────────────────────────────────────────────────

export type PipelineStage = 'fetch' | 'curator' | 'summarizer' | 'analyst' | 'writer' | 'complete' | 'error';
export type PipelineStatus = 'running' | 'done' | 'failed' | 'skipped';

export interface PipelineEvent {
  stage: PipelineStage;
  status: PipelineStatus;
  duration?: number;
  detail?: string;
}

/**
 * Generic SSE payload — either the legacy bare-shape stage event or a typed
 * StreamEvent (`{ type: 'stage' | 'items' | 'analysis' | 'token' | ... }`).
 * The handler is responsible for serializing this to a `data:` SSE frame.
 */
export type PipelineEmit = PipelineEvent | { type: string; [key: string]: unknown };

export interface PipelineInput {
  items: TrendSourceItem[];
  historyItems: TrendLibraryItem[];
  runId: string;
  trigger: string;
  env: Record<string, string | undefined>;
  noNewItems?: boolean;
  onProgress?: (event: PipelineEmit) => void;
  /** Sandbox instance (context.sandbox) — used to create sandbox tools for Agent */
  sandbox?: unknown;
  /** AbortSignal from the platform — when triggered, pipeline should stop ASAP */
  signal?: AbortSignal;
}

export interface PipelineStageResult {
  curatorOutput?: CuratorOutput;
  summarizerOutput?: SummarizerOutput;
  analystOutput?: TrendAnalysis;
  writerMarkdown?: string;
  failedStage?: string;
  error?: string;
}

/**
 * Run an agent in streaming mode, emitting `progress` events every few seconds
 * to keep the SSE connection alive (avoids CDN idle-timeout, typically 60s).
 *
 * If the stream fails with a transient error ("terminated", socket closed, etc.),
 * automatically retries once with a non-streaming call so the pipeline isn't
 * blocked by intermittent AI Gateway connection resets.
 *
 * The caller gets the same result shape as non-streaming `run()`.
 */
async function streamWithProgress(
  agent: Agent<unknown>,
  prompt: string,
  stage: string,
  emit: (event: PipelineEmit) => void,
  intervalMs = 8000,
  signal?: AbortSignal,
): Promise<{ finalOutput: string }> {
  try {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    let accumulated = '';
    let tokenCount = 0;
    let lastEmitAt = Date.now();

    const result = await run(agent, prompt, { stream: true, signal });

    for await (const event of result.toStream() as AsyncIterable<unknown>) {
      if (signal?.aborted) break;
      const ev = event as { type?: string; data?: { type?: string; delta?: unknown } };
      if (ev.type === 'raw_model_stream_event' && ev.data?.type === 'output_text_delta') {
        const delta = String(ev.data.delta || '');
        if (delta) {
          accumulated += delta;
          tokenCount++;
          // Emit progress periodically to keep the SSE alive and show activity.
          if (Date.now() - lastEmitAt >= intervalMs) {
            emit({ type: 'progress', stage, tokenCount, chars: accumulated.length });
            lastEmitAt = Date.now();
          }
        }
      }
    }

    // SDK's finalOutput is preferred (it strips internal framing if any).
    const finalOutput = (result as { finalOutput?: string }).finalOutput;
    const raw = typeof finalOutput === 'string' ? finalOutput : accumulated;
    return { finalOutput: stripThinkingTags(raw) };
  } catch (streamError) {
    // If aborted, rethrow immediately — don't retry
    if (signal?.aborted || (streamError instanceof Error && streamError.name === 'AbortError')) {
      throw streamError;
    }
    // Transient failures (AI Gateway connection reset, "terminated", socket closed)
    // → retry once without streaming. The pipeline keeps going.
    const msg = streamError instanceof Error ? streamError.message : String(streamError);
    console.warn(`[pipeline] ${stage} stream failed (${msg}), retrying without stream`);
    console.warn(`[pipeline] ${stage} full error:`, streamError);
    const retryResult = await run(agent, prompt, { signal });
    return { finalOutput: stripThinkingTags(String(retryResult.finalOutput || '')) };
  }
}

export async function runAgentPipeline(input: PipelineInput): Promise<{
  report: TrendReport;
  stages: PipelineStageResult;
}> {
  const { items, historyItems, runId, trigger, env, noNewItems, onProgress, sandbox, signal } = input;
  const stages: PipelineStageResult = {};
  const emit = onProgress ?? (() => {});

  // ── Stage 1+2: Curator & Summarizer (parallel) ─────────────────
  let curatedItems: TrendSourceItem[] = items;
  let enrichedItems: TrendSourceItem[] = items;

  try {
    const t0 = Date.now();
    console.log('[pipeline] Stage 1+2 (Curator+Summarizer) start');
    emit({ stage: 'curator', status: 'running' });
    emit({ stage: 'summarizer', status: 'running' });
    const curatorAgent = createCuratorAgent(env);
    const summarizerAgent = createSummarizerAgent(env);
    const itemsJson = buildItemsJson(items);

    const [curatorResult, summarizerResult] = await Promise.allSettled([
      streamWithProgress(curatorAgent, `Please curate the following candidate content:\n${itemsJson}`, 'curator', emit, 8000, signal),
      streamWithProgress(summarizerAgent, `Please generate English summaries for the following news:\n${itemsJson}`, 'summarizer', emit, 8000, signal),
    ]);
    console.log(`[pipeline] Stage 1+2 done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    const stage12Duration = (Date.now() - t0) / 1000;

    // Process Curator
    if (curatorResult.status === 'fulfilled') {
      const raw = String(curatorResult.value.finalOutput || '');
      const parsed = parseJsonFromText<CuratorOutput>(raw);
      if (parsed?.items?.length) {
        stages.curatorOutput = parsed;
        const keepIds = new Set(parsed.items.filter(i => i.keep).map(i => i.id));
        const curatorMap = new Map(parsed.items.map(i => [i.id, i]));
        curatedItems = items
          .filter(item => keepIds.has(item.id))
          .map(item => {
            const curated = curatorMap.get(item.id);
            return curated ? { ...item, category: curated.category } : item;
          });
        if (!curatedItems.length) curatedItems = items;
        const detail = `kept ${curatedItems.length}/${items.length}`;
        console.log(`[pipeline] Curator: ${detail}`);
        // Log dropped items with reasons
        const dropped = parsed.items.filter(i => !i.keep);
        if (dropped.length) {
          console.log(`[pipeline] Curator dropped (explicit):`, dropped.map(i => `${i.id}: ${i.reason}`).join(' | '));
        }
        // Log items omitted entirely by curator (not mentioned in output)
        const mentionedIds = new Set(parsed.items.map(i => i.id));
        const omitted = items.filter(i => !mentionedIds.has(i.id));
        if (omitted.length) {
          console.log(`[pipeline] Curator omitted ${omitted.length} items (not in output):`, omitted.map(i => `[${i.source}] ${i.title?.slice(0, 30)}`).join(' | '));
        }
        emit({ stage: 'curator', status: 'done', duration: stage12Duration, detail });
        // Phase 2 of progressive content: emit kept items so frontend can
        // fade out the dropped ones. We send only the items that survived
        // curation; frontend computes droppedIds = previousIds − newIds.
        emit({ type: 'items', phase: 'curated', items: curatedItems });
      } else {
        console.log('[pipeline] Curator: output parse failed, using all items');
        emit({ stage: 'curator', status: 'failed', duration: stage12Duration, detail: 'parse failed' });
      }
    } else {
      console.log('[pipeline] Curator failed:', curatorResult.reason);
      emit({ stage: 'curator', status: 'failed', duration: stage12Duration, detail: 'agent error' });
    }

    // Process Summarizer
    if (summarizerResult.status === 'fulfilled') {
      const raw = String(summarizerResult.value.finalOutput || '');
      const parsed = parseJsonFromText<SummarizerOutput>(raw);
      if (parsed?.items?.length) {
        stages.summarizerOutput = parsed;
        const summaryMap = new Map(
          parsed.items.filter(i => i.id && i.aiSummary).map(i => [i.id, i.aiSummary]),
        );
        enrichedItems = curatedItems.map(item => ({
          ...item,
          aiSummary: summaryMap.get(item.id) || item.aiSummary,
        }));
        const detail = `${summaryMap.size} summaries`;
        console.log(`[pipeline] Summarizer: ${detail}`);
        emit({ stage: 'summarizer', status: 'done', duration: stage12Duration, detail });
        // Phase 3 of progressive content: emit items with aiSummary filled in.
        // Frontend merges by id and fades the summary text in.
        emit({ type: 'items', phase: 'summarized', items: enrichedItems });
      } else {
        enrichedItems = curatedItems;
        console.log('[pipeline] Summarizer: output parse failed, no summaries');
        emit({ stage: 'summarizer', status: 'failed', duration: stage12Duration, detail: 'parse failed' });
      }
    } else {
      enrichedItems = curatedItems;
      console.log('[pipeline] Summarizer failed:', summarizerResult.reason);
      emit({ stage: 'summarizer', status: 'failed', duration: stage12Duration, detail: 'agent error' });
    }
  } catch (error) {
    // If aborted, rethrow to skip remaining stages
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      console.log('[pipeline] Stage 1+2 aborted by user');
      throw error;
    }
    stages.failedStage = 'curator+summarizer';
    stages.error = error instanceof Error ? error.message : String(error);
    console.log('[pipeline] Stage 1+2 error:', stages.error);
  }

  // ── Abort check between stages ──
  if (signal?.aborted) {
    console.log('[pipeline] Aborted before Stage 3');
    throw new DOMException('Aborted', 'AbortError');
  }

  // ── Stage 3: Analyst ────────────────────────────────────────────
  let analysis: TrendAnalysis | null = null;

  try {
    const t1 = Date.now();
    console.log('[pipeline] Stage 3 (Analyst) start');
    emit({ stage: 'analyst', status: 'running' });
    const analystAgent = createAnalystAgent(env, enrichedItems, historyItems, sandbox);
    const analystResult = await streamWithProgress(analystAgent, buildAnalystPrompt(enrichedItems, noNewItems), 'analyst', emit, 8000, signal);
    const raw = String(analystResult.finalOutput || '');
    const parsed = parseJsonFromText<TrendAnalysis>(raw);
    const d1 = +(((Date.now() - t1) / 1000).toFixed(1));
    if (parsed?.keyInsight || parsed?.categories?.length) {
      analysis = parsed;
      stages.analystOutput = analysis;
      // Write back Analyst scores (0-100) to enrichedItems for sorting and display.
      if (analysis.scores?.length) {
        const scoreMap = new Map(analysis.scores.map(s => [s.id, s.score]));
        enrichedItems = enrichedItems.map(item => {
          const aiScore = scoreMap.get(item.id);
          return aiScore != null ? { ...item, score: aiScore } : item;
        });
      }
      const categoryCount = analysis.categories?.length || 0;
      const deepDiveCount = analysis.deepDives?.length || 0;
      const detail = `${categoryCount} categories, ${deepDiveCount} deep dives`;
      console.log(`[pipeline] Analyst done (${d1}s): ${detail}`);
      emit({ stage: 'analyst', status: 'done', duration: d1, detail });
      // Phase 4 of progressive content: emit categories + scored items so
      // frontend can re-group, show keyInsight, and update displayed scores.
      emit({
        type: 'analysis',
        categories: analysis.categories || [],
        deepDives: analysis.deepDives || [],
        keyInsight: analysis.keyInsight,
      });
      // Re-emit items with Analyst scores so frontend LiveFeed picks up 0-100 scores.
      emit({ type: 'items', phase: 'summarized', items: enrichedItems });
    } else {
      console.log(`[pipeline] Analyst done (${d1}s): output parse failed`);
      console.log(`[pipeline] Analyst raw output (first 500 chars):`, raw.slice(0, 500));
      emit({ stage: 'analyst', status: 'failed', duration: d1, detail: 'parse failed' });
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      console.log('[pipeline] Stage 3 aborted by user');
      throw error;
    }
    stages.failedStage = stages.failedStage || 'analyst';
    stages.error = stages.error || (error instanceof Error ? error.message : String(error));
    console.log('[pipeline] Analyst error:', stages.error);
    emit({ stage: 'analyst', status: 'failed', detail: stages.error });
  }

  // ── Abort check between stages ──
  if (signal?.aborted) {
    console.log('[pipeline] Aborted before Stage 4');
    throw new DOMException('Aborted', 'AbortError');
  }

  // ── Stage 4: Writer (token-streaming with non-stream fallback) ───
  try {
    const t2 = Date.now();
    console.log('[pipeline] Stage 4 (Writer) start — streaming');
    emit({ stage: 'writer', status: 'running' });
    const writerAgent = createWriterAgent(env);
    const writerPrompt = buildWriterPrompt(enrichedItems, analysis, noNewItems);

    let markdown = '';

    try {
      // Primary path: stream tokens to the client for live-typing UX.
      let accumulated = '';
      let insideThink = false; // Track if we're inside <think>...</think>
      let thinkBuffer = '';    // Buffer to detect partial <think> or </think> tags
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const writerStreamResult = await run(writerAgent, writerPrompt, { stream: true, signal });

      for await (const event of writerStreamResult.toStream() as AsyncIterable<unknown>) {
        if (signal?.aborted) break;
        const ev = event as { type?: string; data?: { type?: string; delta?: unknown } };
        if (ev.type === 'raw_model_stream_event' && ev.data?.type === 'output_text_delta') {
          const delta = String(ev.data.delta || '');
          if (delta) {
            accumulated += delta;
            // Filter out <think>...</think> from live stream
            thinkBuffer += delta;
            if (insideThink) {
              const closeIdx = thinkBuffer.indexOf('</think>');
              if (closeIdx !== -1) {
                insideThink = false;
                const afterClose = thinkBuffer.slice(closeIdx + 8);
                thinkBuffer = '';
                if (afterClose) emit({ type: 'token', delta: afterClose });
              }
              // else: still inside think, swallow token
            } else {
              const openIdx = thinkBuffer.indexOf('<think>');
              if (openIdx !== -1) {
                insideThink = true;
                const beforeOpen = thinkBuffer.slice(0, openIdx);
                thinkBuffer = thinkBuffer.slice(openIdx + 7);
                if (beforeOpen) emit({ type: 'token', delta: beforeOpen });
              } else if (thinkBuffer.length > 7) {
                // Safe to flush — no partial <think> tag possible
                const safe = thinkBuffer.slice(0, -7);
                thinkBuffer = thinkBuffer.slice(-7);
                emit({ type: 'token', delta: safe });
              }
            }
          }
        }
      }
      // Flush remaining buffer (if not inside think)
      if (!insideThink && thinkBuffer) {
        emit({ type: 'token', delta: thinkBuffer });
      }

      const finalOutput = (writerStreamResult as { finalOutput?: string }).finalOutput;
      markdown = stripThinkingTags(
        (typeof finalOutput === 'string' && finalOutput.trim())
          ? finalOutput.trim()
          : accumulated.trim()
      );
    } catch (streamError) {
      // If aborted, rethrow — don't retry
      if (signal?.aborted || (streamError instanceof Error && streamError.name === 'AbortError')) {
        throw streamError;
      }
      // Fallback: if streaming fails ("terminated", connection reset, etc.),
      // retry without streaming. User won't see live-typing but still gets the report.
      const msg = streamError instanceof Error ? streamError.message : String(streamError);
      console.warn(`[pipeline] Writer stream failed (${msg}), retrying without stream`);
      console.warn(`[pipeline] Writer full error:`, streamError);
      const writerResult = await run(writerAgent, writerPrompt, { signal });
      markdown = stripThinkingTags(String(writerResult.finalOutput || '').trim());
    }

    const d2 = +(((Date.now() - t2) / 1000).toFixed(1));
    if (markdown && markdown.length > 50) {
      stages.writerMarkdown = markdown;
      const detail = `${markdown.length} chars`;
      console.log(`[pipeline] Writer done (${d2}s): ${detail}`);
      emit({ stage: 'writer', status: 'done', duration: d2, detail });
      return { report: assembleReportFromWriter(enrichedItems, markdown, runId, trigger), stages };
    }
    console.log(`[pipeline] Writer done (${d2}s): output too short`);
    emit({ stage: 'writer', status: 'failed', duration: d2, detail: 'output too short' });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      console.log('[pipeline] Stage 4 aborted by user');
      throw error;
    }
    stages.failedStage = stages.failedStage || 'writer';
    stages.error = stages.error || (error instanceof Error ? error.message : String(error));
    console.log('[pipeline] Writer error:', stages.error);
    emit({ stage: 'writer', status: 'failed', detail: stages.error });
  }

  // ── Fallback from Analyst output ────────────────────────────────
  if (analysis) {
    console.log('[pipeline] Falling back to analyst-based report');
    return { report: assembleReportFromAnalysis(enrichedItems, analysis, runId, trigger), stages };
  }

  // ── Ultimate fallback ───────────────────────────────────────────
  console.log('[pipeline] All agents failed, using code-generated fallback');
  const fallback = generateFallbackReport(enrichedItems, runId, trigger);
  fallback.agentWarning = stages.error || 'All agents failed';
  return { report: fallback, stages };
}
