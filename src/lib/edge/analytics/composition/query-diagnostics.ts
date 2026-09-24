import type {
  FilterScope,
  FilterScopePreference,
} from "@/lib/edge/analytics/contract";
import {
  type AnalyticsDataSource,
  analyticsDiagnosticHeaders as d1AnalyticsDiagnosticHeaders,
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";

export interface AnalyticsReadDiagnostics {
  rowsRead: number;
  rowsReadAvailable: boolean;
  requestedScope?: FilterScopePreference;
  resolvedScope?: FilterScope;
  requiredSources?: readonly string[];
  requiresRawSource?: boolean;
}

export function createAnalyticsReadDiagnostics(): AnalyticsReadDiagnostics {
  return createD1ReadDiagnostics();
}
export function analyticsDiagnosticHeaders(
  source: AnalyticsDataSource,
  diagnostics: AnalyticsReadDiagnostics,
): Record<string, string> {
  return d1AnalyticsDiagnosticHeaders(source, diagnostics as D1ReadDiagnostics);
}
