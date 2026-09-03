import { describe, expect, it } from "vitest";

import {
  analyticsDiagnosticHeaders,
  createD1ReadDiagnostics,
  recordD1RowsRead,
  recordScopedFilterDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";

describe("analytics query diagnostics", () => {
  it("reports the cumulative D1 rows read when every query exposes metadata", () => {
    const diagnostics = createD1ReadDiagnostics();

    recordD1RowsRead(diagnostics, { meta: { rows_read: 12 } });
    recordD1RowsRead(diagnostics, { meta: { rows_read: 8 } });

    expect(analyticsDiagnosticHeaders("rollup", diagnostics)).toEqual({
      "x-insightflare-data-source": "rollup",
      "x-insightflare-d1-rows-read": "20",
    });
  });

  it("does not report a partial total when a D1 result omits metadata", () => {
    const diagnostics = createD1ReadDiagnostics();

    recordD1RowsRead(diagnostics, { meta: { rows_read: 12 } });
    recordD1RowsRead(diagnostics, {});

    expect(analyticsDiagnosticHeaders("raw", diagnostics)).toEqual({
      "x-insightflare-data-source": "raw",
      "x-insightflare-d1-rows-read": "unavailable",
    });
  });

  it("reports the resolved scope plan without exposing filter values", () => {
    const diagnostics = createD1ReadDiagnostics();
    recordScopedFilterDiagnostics(diagnostics, {
      requestedScope: "auto",
      resolvedScope: "visitor",
      plan: {
        scope: "visitor",
        mode: "entity",
        membership: { kind: "entity", entityKind: "visitor", expression: null },
        expansion: "matching-visitors",
        requiredSources: new Set(["event", "payload"]),
        requiresRawSource: true,
      },
      time: {} as never,
      siteIds: ["site-1"],
    });

    expect(analyticsDiagnosticHeaders("raw", diagnostics)).toMatchObject({
      "x-insightflare-scope-requested": "auto",
      "x-insightflare-scope-resolved": "visitor",
      "x-insightflare-scope-required-sources": "event,payload",
      "x-insightflare-scope-requires-raw": "true",
    });
  });
});
