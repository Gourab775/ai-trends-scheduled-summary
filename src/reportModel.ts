import type { TrendReport } from './types';

export const EMPTY_REPORT: TrendReport = {
  status: 'empty',
  summary: 'No AI trend report generated yet.',
  reportMarkdown: '# AI Trend Daily\n\nClick \'Generate\' to start collecting AI updates from Hacker News and Dev.to.',
  trends: [],
  items: [],
};

export function normalizeReport(input: Partial<TrendReport> | null | undefined): TrendReport {
  return {
    ...EMPTY_REPORT,
    ...(input ?? {}),
    status: input?.status ?? EMPTY_REPORT.status,
    reportMarkdown: input?.reportMarkdown ?? EMPTY_REPORT.reportMarkdown,
    trends: Array.isArray(input?.trends) ? input.trends : [],
    items: Array.isArray(input?.items) ? input.items : [],
  };
}
