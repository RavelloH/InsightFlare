import type {
  FilterScope,
  FilterScopePreference,
  ScopedFilterMetadata,
} from "@/lib/edge/analytics/contract";

export type AnalyticsDataSource = "raw" | "rollup" | "mixed" | "mock";

export interface D1ReadDiagnostics {
  rowsRead: number;
  rowsReadAvailable: boolean;
  requestedScope?: FilterScopePreference;
  resolvedScope?: FilterScope;
  requiredSources?: readonly string[];
  requiresRawSource?: boolean;
}

interface D1ResultWithMeta {
  meta?: {
    rows_read?: unknown;
  };
}

export function createD1ReadDiagnostics(): D1ReadDiagnostics {
  return { rowsRead: 0, rowsReadAvailable: true };
}

export function recordScopedFilterDiagnostics(
  diagnostics: D1ReadDiagnostics | undefined,
  metadata: ScopedFilterMetadata | undefined,
): void {
  if (!diagnostics || !metadata) return;
  diagnostics.requestedScope = metadata.requestedScope;
  diagnostics.resolvedScope = metadata.resolvedScope;
  diagnostics.requiredSources = [...metadata.plan.requiredSources].sort();
  diagnostics.requiresRawSource = metadata.plan.requiresRawSource;
}

export function recordD1RowsRead(
  diagnostics: D1ReadDiagnostics | undefined,
  result: D1ResultWithMeta,
): void {
  if (!diagnostics) return;
  const rowsRead = result.meta?.rows_read;
  if (typeof rowsRead !== "number" || !Number.isFinite(rowsRead)) {
    diagnostics.rowsReadAvailable = false;
    return;
  }
  diagnostics.rowsRead += Math.max(0, Math.trunc(rowsRead));
}

export function analyticsDiagnosticHeaders(
  source: AnalyticsDataSource,
  diagnostics: D1ReadDiagnostics,
): Record<string, string> {
  return {
    "x-insightflare-data-source": source,
    "x-insightflare-d1-rows-read": diagnostics.rowsReadAvailable
      ? String(diagnostics.rowsRead)
      : "unavailable",
    ...(diagnostics.requestedScope
      ? { "x-insightflare-scope-requested": diagnostics.requestedScope }
      : {}),
    ...(diagnostics.resolvedScope
      ? { "x-insightflare-scope-resolved": diagnostics.resolvedScope }
      : {}),
    ...(diagnostics.requiredSources
      ? {
          "x-insightflare-scope-required-sources":
            diagnostics.requiredSources.join(","),
        }
      : {}),
    ...(diagnostics.requiresRawSource === undefined
      ? {}
      : {
          "x-insightflare-scope-requires-raw": String(
            diagnostics.requiresRawSource,
          ),
        }),
  };
}
