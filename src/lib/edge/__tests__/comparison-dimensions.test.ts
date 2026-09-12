import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
} from "@/lib/edge/analytics/contract";
import {
  decodeComparisonDimensionCursor,
  queryComparisonDimensionPageFromD1,
  queryComparisonSessionPathPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/comparison-dimensions";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";

type Binding = string | number | null;

function createEnv(resultSets: Record<string, unknown>[][]): {
  env: Env;
  calls: Array<{ sql: string; bindings: Binding[] }>;
} {
  const pending = [...resultSets];
  const calls: Array<{ sql: string; bindings: Binding[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: Binding[]) => ({
      all: vi.fn(async () => {
        calls.push({ sql, bindings });
        return { results: pending.shift() ?? [] };
      }),
    })),
  }));
  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      DAILY_SALT_SECRET: "comparison-test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    },
    calls,
  };
}

const current: QueryWindow = {
  startMs: 1_000,
  endExclusiveMs: 2_000,
  nowMs: 3_000,
  timeZone: "UTC",
};
const reference: QueryWindow = {
  startMs: 4_000,
  endExclusiveMs: 5_000,
  nowMs: 6_000,
  timeZone: "UTC",
};
const filters: FilterDocument = EMPTY_FILTER_DOCUMENT;

function dimensionRow(key: string, views: number, referenceViews: number) {
  return {
    key,
    current_views: views,
    current_sessions: views,
    current_visitors: views,
    reference_views: referenceViews,
    reference_sessions: referenceViews,
    reference_visitors: referenceViews,
  };
}

function sessionRow(key: string, views: number, referenceViews: number) {
  return {
    key,
    current_views: views,
    current_sessions: views,
    current_visitors: views,
    reference_views: referenceViews,
    reference_sessions: referenceViews,
    reference_visitors: referenceViews,
  };
}

describe("comparison dimension readers", () => {
  it("joins current and reference rollups and creates a signed cursor", async () => {
    const { env, calls } = createEnv([
      [dimensionRow("alpha", 10, 5), dimensionRow("beta", 1, 0)],
    ]);
    const page = await queryComparisonDimensionPageFromD1(
      env,
      "site-1",
      current,
      filters,
      reference,
      filters,
      1,
      "pathname",
      { metric: "views", sortBy: "current", direction: "desc" },
      null,
      "private-dashboard",
    );

    expect(page.items).toEqual([
      expect.objectContaining({
        key: "alpha",
        views: 10,
        reference: { views: 5, sessions: 5, visitors: 5 },
        change: expect.objectContaining({
          views: { absolute: 5, relative: 1 },
        }),
      }),
    ]);
    expect(page.pagination).toMatchObject({
      limit: 1,
      returned: 1,
      hasMore: true,
    });
    expect(page.pagination.nextCursor).toEqual(expect.any(String));
    expect(calls[0]?.sql).toContain("UNION");

    const cursor = await decodeComparisonDimensionCursor(
      env,
      "site-1",
      current,
      filters,
      reference,
      filters,
      "pathname",
      undefined,
      page.pagination.nextCursor,
      "private-dashboard",
      "views",
      "current",
      "desc",
    );
    expect(cursor).toEqual({
      sortClass: 0,
      primary: 10,
      secondary: 5,
      key: "alpha",
    });
  });

  it("supports reference sorting, escaped search, and change ordering", async () => {
    const { env, calls } = createEnv([
      [dimensionRow("one", 0, 4)],
      [dimensionRow("new", 3, 0), dimensionRow("existing", 2, 1)],
    ]);
    const referencePage = await queryComparisonDimensionPageFromD1(
      env,
      "site-1",
      current,
      filters,
      reference,
      filters,
      10,
      "pathname",
      {
        metric: "visitors",
        sortBy: "reference",
        direction: "asc",
        search: "a_%",
      },
      null,
      "private-dashboard",
    );
    expect(referencePage.items[0]?.change.visitors.relative).toBe(-1);
    expect(calls[0]?.sql).toContain("LOWER(key) LIKE");

    const changePage = await queryComparisonDimensionPageFromD1(
      env,
      "site-1",
      current,
      filters,
      reference,
      filters,
      1,
      "pathname",
      { metric: "views", sortBy: "change", direction: "desc" },
      {
        sortClass: 0,
        primary: 0,
        secondary: 0,
        key: "old",
      },
      "private-dashboard",
    );
    expect(changePage.items[0]?.change.views.relative).toBeNull();
    expect(changePage.pagination.nextCursor).toEqual(expect.any(String));
    expect(calls[1]?.bindings).toContain(0);
  });

  it("uses the session edge reader for entry and exit comparisons", async () => {
    const { env, calls } = createEnv([
      [sessionRow("/entry", 2, 1)],
      [sessionRow("/new-exit", 2, 0), sessionRow("/exit", 1, 2)],
    ]);
    const entry = await queryComparisonSessionPathPageFromD1(
      env,
      "site-1",
      current,
      filters,
      reference,
      filters,
      10,
      "entry",
      { metric: "views", sortBy: "current", direction: "desc" },
      null,
      "private-dashboard",
    );
    const exit = await queryComparisonSessionPathPageFromD1(
      env,
      "site-1",
      current,
      filters,
      reference,
      filters,
      1,
      "exit",
      { metric: "visitors", sortBy: "change", direction: "asc" },
      { sortClass: 0, primary: 0, secondary: 0, key: "/before" },
      "private-dashboard",
    );

    expect(entry.items[0]?.key).toBe("/entry");
    expect(exit.items[0]?.key).toBe("/new-exit");
    expect(calls[0]?.sql).toContain("current_ranked");
    expect(calls[1]?.sql).toContain("latest_rank");
    expect(exit.pagination.nextCursor).toEqual(expect.any(String));
  });

  it("handles visitor sorting, empty rollups, and cursor variants", async () => {
    const { env, calls } = createEnv([
      [
        {
          key: "empty",
          current_views: undefined,
          current_sessions: undefined,
          current_visitors: undefined,
          reference_views: undefined,
          reference_sessions: undefined,
          reference_visitors: undefined,
        },
        dimensionRow("filled", 2, 1),
      ],
    ]);
    const page = await queryComparisonDimensionPageFromD1(
      env,
      "site-1",
      current,
      filters,
      reference,
      filters,
      1,
      "pathname",
      {
        metric: "visitors",
        sortBy: "reference",
        direction: "desc",
      },
      { sortClass: 0, primary: 99, secondary: 99, key: "before" },
      "private-dashboard",
    );

    expect(page.items[0]).toMatchObject({
      key: "empty",
      visitors: 0,
      reference: { visitors: 0 },
      change: { visitors: { absolute: 0, relative: 0 } },
    });
    expect(page.pagination.nextCursor).toEqual(expect.any(String));
    expect(calls[0]?.bindings).toContain(99);

    const { env: sessionEnv } = createEnv([
      [{ key: "/empty" }, { ...sessionRow("/filled", 2, 1) }],
    ]);
    const sessionPage = await queryComparisonSessionPathPageFromD1(
      sessionEnv,
      "site-1",
      current,
      filters,
      reference,
      filters,
      1,
      "entry",
      { metric: "visitors", sortBy: "current", direction: "asc" },
      { sortClass: 0, primary: 0, secondary: 0, key: "/before" },
      "private-dashboard",
      undefined,
    );
    expect(sessionPage.items[0]).toMatchObject({
      key: "/empty",
      visitors: 0,
      change: { visitors: { absolute: 0, relative: 0 } },
    });
    expect(sessionPage.pagination.nextCursor).toEqual(expect.any(String));
  });
});
