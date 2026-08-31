/**
 * GET /ai-trends/latest — Cloud Function
 * Returns the latest generated report.
 */

import { jsonResponse } from '../../_http';
import { getStore, loadLatestReport } from '../../_store';

export async function onRequestGet(context: any): Promise<Response> {
  const store = getStore(context);
  if (store) {
    const report = await loadLatestReport(store);
    if (report) return jsonResponse(report);
  }
  return jsonResponse({
    status: 'empty',
    summary: 'No AI trend report generated yet.',
    reportMarkdown: '# AI Trend Daily\n\nNo report generated yet. Click "Generate" to start.',
    trends: [],
    items: [],
  });
}
