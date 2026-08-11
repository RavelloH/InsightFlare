import { describe, expect, it } from "vitest";

import {
  analyticsDiagnosticHeaders,
  createD1ReadDiagnostics,
  recordD1RowsRead,
} from "@/lib/edge/query/diagnostics";

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
});
