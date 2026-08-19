export type AnalyticsDataSource = "raw" | "rollup" | "mixed" | "mock";

export interface D1ReadDiagnostics {
  rowsRead: number;
  rowsReadAvailable: boolean;
}

interface D1ResultWithMeta {
  meta?: {
    rows_read?: unknown;
  };
}

export function createD1ReadDiagnostics(): D1ReadDiagnostics {
  return { rowsRead: 0, rowsReadAvailable: true };
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
  };
}
