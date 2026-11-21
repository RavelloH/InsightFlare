import { describe, expect, it } from "vitest";

import { buildInvocationStatements } from "@/lib/edge/admin/observability/invocation-metrics-sql";

const now = 1_790_000_000_555;
const build = (query: string) =>
  buildInvocationStatements(new URLSearchParams(query), now);
const id = "analytics.overview.raw.summary";
const base =
  "view=samples&source=worker&routeKey=api%3A%2Fcollect&appVersion=1.2.3";

describe("AE v2 retained-sample investigation filters", () => {
  it("restricts a selected API hot query to blob14 and the appropriate presence flags", () => {
    const statement = build(
      base + "&sampleQueryId=" + id + "&sampleKind=api-hot",
    )!.statements[0]!.sql;
    expect(statement).toContain("blob14 = '" + id + "'");
    expect(statement).toContain("blob4 = 'api:/collect'");
    expect(statement).toContain("blob10 = '1.2.3'");
    expect(statement).toContain("intDiv(double19, 512) % 2 = 1");
    expect(statement).not.toContain("blob19 =");
    expect(statement).toMatch(
      /ORDER BY timestamp DESC LIMIT 100 FORMAT JSONEachRow$/,
    );
  });
  it("uses only selected scanQueryId blob17, not secondary detail queries or blob14", () => {
    const statement = build(base + "&sampleQueryId=" + id + "&sampleKind=scan")!
      .statements[0]!.sql;
    expect(statement).toContain("blob17 = '" + id + "'");
    expect(statement).toContain("intDiv(double19, 67108864) % 4 = 2");
    expect(statement).not.toContain("blob14 =");
    expect(statement).not.toContain("blob19 =");
  });
  it("filters matching retained error samples by a safe exact error code", () => {
    const statement = build(
      base + "&resultClass=failure&sampleErrorCode=d1_query_failed",
    )!.statements[0]!.sql;
    expect(statement).toContain("blob6 = 'failure'");
    expect(statement).toContain("blob12 = 'd1_query_failed'");
  });
  it.each([
    "view=hotspots&sampleQueryId=" + id,
    "view=overview&sampleErrorCode=d1_query_failed",
    "view=samples&sampleKind=api-hot",
    "view=samples&sampleQueryId=DROP",
    "view=samples&sampleQueryId=%27%20OR%201%3D1--",
    "view=samples&sampleErrorCode=d1_query_failed%27",
    "view=samples&sampleQueryId=" + id + "&sampleKind=invalid",
  ])("rejects illegal sample filters: %s", (query) => {
    expect(build(query)).toBeNull();
  });
});
