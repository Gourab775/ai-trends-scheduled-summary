# Scheduled Trends Digest

Professional scheduled digest workspace that aggregates, curates, scores, and publishes daily industry reports from multiple sources.

**Live Demo:** https://ai-trends-scheduled-summary.vercel.app

**Category:** Scheduled Operations / Content Curation
**Stack:** React 18 Â· Vite 5 Â· TypeScript Â· Workflow Engine Â· Zod
**Language:** TypeScript

## Overview

Scheduled Trends Digest is a full-stack automation platform that runs a multi-stage pipeline on a daily cron schedule or on-demand trigger. It collects items from Hacker News, Dev.to, and web sources, then filters, summarizes, scores, and assembles a structured Markdown report. Real-time streaming keeps the interface responsive while cross-run deduplication ensures consistent, high-value digests.

## Features

- **Multi-Source Collection** â€” Aggregates candidates from Hacker News, Dev.to, and configurable web sources via sandbox browser scraping.
- **Four-Stage Pipeline** â€” Curator (filter) and Summarizer (summary) run in parallel, followed by Analyst (scoring and classification) and Writer (Markdown report generation).
- **Real-Time Streaming** â€” Server-sent events stream stage transitions, progressive content snapshots, analysis results, and token-level report generation for live UX.
- **Cross-Run Deduplication** â€” Fingerprint-based item library tracks seen counts and timestamps across scheduled runs to avoid repeat coverage.
- **Comprehensive Scoring** â€” Analyst assigns 0â€“100 scores based on source engagement, content quality, and domain relevance, with category grouping and trend insights.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Vite 5, TypeScript |
| Workflow Engine | Workflow Engine (scheduled services, sandbox browser) |
| Validation | Zod |
| Build | Vite, TypeScript (tsc) |
| Styling | CSS / Vite pipeline |
| Runtime | EdgeOne Makers (scheduled services + cloud functions) |

## Project Structure

```
.
â”œâ”€â”€ services/
â”‚   â””â”€â”€ trends/
â”‚       â”œâ”€â”€ run.ts              # POST /trends/run â€” main pipeline entry (SSE stream)
â”‚       â”œâ”€â”€ stop.ts             # POST /trends/stop â€” abort running pipeline
â”‚       â”œâ”€â”€ _model.ts           # Four-stage definitions, prompts, streaming logic
â”‚       â”œâ”€â”€ _sources.ts         # Data collection (HN, Dev.to, sandbox browser)
â”‚       â”œâ”€â”€ _items.ts           # Item library: fingerprinting, merge, dedup
â”‚       â”œâ”€â”€ _memory.ts          # Platform store persistence (reports + items)
â”‚       â”œâ”€â”€ _storage.ts         # File-system fallback persistence
â”‚       â”œâ”€â”€ _report.ts          # Report assembly helpers
â”‚       â”œâ”€â”€ _http.ts            # Request/response utilities
â”‚       â””â”€â”€ _types.ts           # Shared schemas and type definitions
â”œâ”€â”€ cloud-functions/
â”‚   â””â”€â”€ trends/
â”‚       â”œâ”€â”€ latest/index.ts     # GET /trends/latest
â”‚       â”œâ”€â”€ history/index.ts    # GET /trends/history
â”‚       â”œâ”€â”€ detail/index.ts     # POST /trends/detail
â”‚       â”œâ”€â”€ delete/index.ts     # POST /trends/delete
â”‚       â””â”€â”€ health/index.ts     # GET /trends/health
â”œâ”€â”€ src/                        # Frontend (React + Vite)
â”‚   â”œâ”€â”€ App.tsx                 # Main UI: LiveFeed, PipelineBar, ReportDrawer
â”‚   â”œâ”€â”€ api.ts                  # SSE client and REST helpers
â”‚   â”œâ”€â”€ i18n.tsx                # Internationalization
â”‚   â”œâ”€â”€ MarkdownReport.tsx      # Markdown renderer
â”‚   â”œâ”€â”€ reportModel.ts          # Frontend report normalization
â”‚   â””â”€â”€ types.ts                # Frontend type definitions
â”œâ”€â”€ index.html                  # Entry HTML
â”œâ”€â”€ edgeone.json                # Runtime and schedule configuration
â”œâ”€â”€ vite.config.ts              # Vite configuration
â”œâ”€â”€ tsconfig.json               # TypeScript configuration
â””â”€â”€ package.json
```

> Note: Source directory is `services/` in documentation. Runtime keeps `agents/` as an alias for backward compatibility where applicable.

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
npm install
cp .env.example .env
# Edit .env with your service credentials (see Environment Variables)
npm run dev
```

Open http://localhost:5173 (Vite default) and http://localhost:8080/agent-metrics for the observability panel when using EdgeOne dev.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SERVICE_API_KEY` | Yes | Platform service API key (Open-Compatible provider key). |
| `SERVICE_BASE_URL` | Yes | Gateway base URL, e.g. `https://gateway.edgeone.link/v1`. |
| `SERVICE_MODEL` | No | Model identifier. Defaults to `@makers/minimax-m2.7`. |

> Alias: `SERVICE_*` is the canonical naming in this workspace. `SERVICE_API_KEY`, `SERVICE_BASE_URL`, and `SERVICE_MODEL` are aliases for `AI_GATEWAY_API_KEY`, `AI_GATEWAY_BASE_URL`, and `AI_GATEWAY_MODEL` for backward compatibility. Either naming works; prefer `SERVICE_*` for new deployments.
>
> Provider fallback chain in code supports legacy `LLM_*` variables alongside `SERVICE_*`.

### Build

```bash
npm run build
npm run preview
# For tests (pipeline report):
npm test
```

## Deployment

This project uses `edgeone.json` for EdgeOne Makers deployment with a daily schedule:

```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "vite",
  "schedules": [{ "cron": "0 9 * * *", "path": "/trends/run" }]
}
```

**Options:**

- **Vercel:** Import the repository, set `SERVICE_API_KEY` and `SERVICE_BASE_URL`, build command `npm run build`, output `dist`.
- **Netlify:** Build command `npm run build`, publish `dist`, add the same environment variables.
- **GitHub Pages (static frontend):** Configure Vite for static export and publish `dist/` via GitHub Actions. For scheduled services, use EdgeOne/Netlify Functions for backend routes.

## Customization

- **Sources:** Update `services/trends/_sources.ts` to add or modify collection endpoints and browser scraping logic.
- **Pipeline Stages:** Adjust filtering, summarization, scoring, and Markdown generation in `services/trends/_model.ts`.
- **Scoring & Categories:** Tune weights and category lists in the Analyst stage definitions.
- **Frontend:** Modify `src/App.tsx`, `src/MarkdownReport.tsx`, and `src/api.ts` for UI and SSE handling.
- **Schedule:** Change the cron expression in `edgeone.json` (`0 9 * * *` daily at 01:00 UTC by default) and the associated payload.

## License

MIT
