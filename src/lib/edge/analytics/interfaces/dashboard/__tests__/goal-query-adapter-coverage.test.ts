import { beforeEach, describe, expect, it, vi } from "vitest";

import { executePrivateQuery } from "@/lib/edge/analytics/interfaces/dashboard/private";
import type { Env } from "@/lib/edge/types";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/lib/edge/analytics/composition", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createEdgeSiteAnalyticsRuntime: () => ({
      resources: { goals: { get: mocks.get } },
      execute: mocks.execute,
    }),
    createAnalyticsReadDiagnostics: () => ({}),
    analyticsDiagnosticHeaders: () => ({}),
  };
});

const goal = { filterDslVersion: 1, filterDsl: 'event.name eq "purchase"' };
function query(
  pathname: "goal-timeseries" | "goal-summary",
  queryString = "from=0&to=86400000&interval=day&id=goal-1",
) {
  const url = new URL(
    "https://example.test/api/private/" + pathname + "?" + queryString,
  );
  return executePrivateQuery({
    env: {} as Env,
    siteId: "site-1",
    pathname,
    url,
    request: new Request(url),
  });
}

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(goal);
  mocks.execute.mockReset().mockResolvedValue({
    ok: true,
    data: { value: 42 },
    meta: { source: "d1" },
  });
});

describe("private goal analytics contract and bounded SQL cost", () => {
  it("rejects malformed or inverted times without opening goal storage", async () => {
    expect((await query("goal-timeseries", "from=invalid&to=12")).status).toBe(
      400,
    );
    expect((await query("goal-summary", "from=100&to=50")).status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("returns safe internal error for failed goal lookup and 404 for missing goal", async () => {
    mocks.get.mockRejectedValueOnce(new Error("sensitive storage message"));
    const failed = await query("goal-summary");
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("sensitive storage message");
    mocks.get.mockResolvedValueOnce(null);
    expect((await query("goal-summary")).status).toBe(404);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("denies high-cardinality minute timeseries before provider execution", async () => {
    const response = await query(
      "goal-timeseries",
      "from=0&to=86400000&interval=minute&id=goal-1",
    );
    expect(response.status).toBe(422);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("executes a bounded goal query with the canonical goal and decoded context", async () => {
    const response = await query(
      "goal-timeseries",
      "from=0&to=86400000&interval=day&id=goal-1",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { value: 42 },
    });
    expect(mocks.execute).toHaveBeenCalledWith(
      "goal-timeseries",
      expect.objectContaining({ goalId: "goal-1", interval: "day" }),
      expect.objectContaining({
        cost: expect.objectContaining({ provider: "d1" }),
      }),
    );
  });

  it("converts provider contract failures and empty records to safe HTTP responses", async () => {
    mocks.execute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "invalid-cursor" },
    });
    expect((await query("goal-summary")).status).toBe(400);
    mocks.execute.mockResolvedValueOnce({
      ok: true,
      data: undefined,
      meta: { source: "d1" },
    });
    expect((await query("goal-summary")).status).toBe(404);
  });
});
