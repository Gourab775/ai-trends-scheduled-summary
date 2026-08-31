import type { TrendGroup, TrendReport, TrendSourceItem } from './_types.js';

export function utcNow(): string {
  return new Date().toISOString();
}

function formatReportTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute} UTC`;
}

function summarizeCategory(category: string, items: TrendSourceItem[]): string {
  const titles = items.slice(0, 3).map(item => item.title).filter(Boolean);
  if (!titles.length) return `${category} has limited activity, suggest continued observation.`;
  return `${category} shows ${items.length} related updates, including: ${titles.join('; ')}.`;
}

export function generateMarkdown(items: TrendSourceItem[], generatedAt: string): { markdown: string; trends: TrendGroup[] } {
  const grouped = new Map<string, TrendSourceItem[]>();
  for (const item of items) {
    const category = item.category || 'AI Industry';
    grouped.set(category, [...(grouped.get(category) || []), item]);
  }

  const trends: TrendGroup[] = [];
  const lines = [
    '# AI Trend Daily',
    '',
    `Generated: ${formatReportTime(generatedAt)}`,
    `Analysis: ${items.length} candidate updates`,
    '',
    "## Today's Trend Overview",
    '',
  ];

  if (!items.length) {
    lines.push('No qualified AI trend content found. Please try again later or expand data sources.', '');
    return { markdown: lines.join('\n'), trends };
  }

  Array.from(grouped.entries()).forEach(([category, categoryItems], index) => {
    const summary = summarizeCategory(category, categoryItems);
    trends.push({ category, summary, count: categoryItems.length, items: categoryItems.slice(0, 5) });
    lines.push(`${index + 1}. **${category}**: ${summary}`);
  });

  lines.push('', '## Key Trends', '');
  for (const trend of trends) {
    lines.push(`### ${trend.category}`, '', trend.summary, '', 'Representative Sources:');
    for (const item of trend.items) {
      lines.push(`- [${item.title}](${item.url}) — ${item.source || 'Unknown'} · score ${item.score || 0}`);
    }
    lines.push('');
  }

  lines.push(
    '## Follow-up Questions',
    '',
    '- Which Agent toolchains are gaining real production users?',
    '- Has multimodal capability moved from demo to stable business workflows?',
    '- Is the gap between open-source and closed-source models narrowing in cost, performance, and controllability?',
    '',
    '## Notes',
    '',
    'This report is automatically generated from public technical sources. Please verify key facts against original links.',
  );

  return { markdown: lines.join('\n'), trends };
}

export function generateFallbackReport(items: TrendSourceItem[], runId: string, trigger = 'manual'): TrendReport {
  const generatedAt = utcNow();
  const { markdown, trends } = generateMarkdown(items, generatedAt);
  return {
    runId,
    status: 'success',
    trigger,
    generatedAt,
    itemCount: items.length,
    summary: trends[0]?.summary || 'No qualified AI trend content found.',
    reportMarkdown: markdown,
    trends,
    items,
  };
}

// buildAgentPrompt removed — prompt logic moved to _model.ts agent instructions
