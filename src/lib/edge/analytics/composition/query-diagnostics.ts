import {
  type AnalyticsDataSource,
  analyticsDiagnosticHeaders as d1AnalyticsDiagnosticHeaders,
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
export type AnalyticsReadDiagnostics = D1ReadDiagnostics;
export function createAnalyticsReadDiagnostics(): AnalyticsReadDiagnostics {
  return createD1ReadDiagnostics();
}
export function analyticsDiagnosticHeaders(
  source: AnalyticsDataSource,
  diagnostics: AnalyticsReadDiagnostics,
): Record<string, string> {
  return d1AnalyticsDiagnosticHeaders(source, diagnostics);
}
