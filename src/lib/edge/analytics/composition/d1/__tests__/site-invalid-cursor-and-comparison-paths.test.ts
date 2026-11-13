import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    deferredComparisonPageQualificationFromQuery: vi.fn(),
    deferredOverviewPageTableQualificationFromQuery: vi.fn(),
    deferredReferrerOverviewQualificationFromQuery: vi.fn(),
    prepareDeferredComparisonPageQualificationFallback: vi.fn(),
    prepareDeferredEventQualificationFallback: vi.fn(),
    prepareDeferredPageVisitQualification: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/dimensions",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    decodeDimensionCursor: vi.fn(),
    preflightQualifiedDimensionPageCursorFromD1: vi.fn(),
    queryDimensionPageFromD1: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/comparison-dimensions",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    decodeComparisonDimensionCursor: vi.fn(),
    queryComparisonDimensionPageFromD1: vi.fn(),
    queryComparisonSessionPathPageFromD1: vi.fn(),
    tryQueryQualifiedComparisonDimensionPageFromD1: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/referrers",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    decodeReferrersCursor: vi.fn(),
    queryQualifiedReferrersPageFromD1: vi.fn(),
    queryReferrersPageFromD1: vi.fn(),
  }),
);
vi.mock("@/lib/edge/analytics/providers/d1/internal/pages-dashboard", () => ({
  queryPagesDashboard: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-program",
  () => ({ executePagesDashboardQualificationProgram: vi.fn() }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request",
  () => ({ deferredPagesDashboardQualificationFromQuery: vi.fn() }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/event-membership-fallback",
  () => ({ prepareEventMembershipFallback: vi.fn() }),
);

import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { registerSiteContractProviders } from "@/lib/edge/analytics/composition/d1/site";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  deferredComparisonPageQualificationFromQuery,
  deferredOverviewPageTableQualificationFromQuery,
  deferredReferrerOverviewQualificationFromQuery,
  prepareDeferredComparisonPageQualificationFallback,
  prepareDeferredEventQualificationFallback,
  prepareDeferredPageVisitQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  decodeComparisonDimensionCursor,
  queryComparisonDimensionPageFromD1,
  queryComparisonSessionPathPageFromD1,
  tryQueryQualifiedComparisonDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/comparison-dimensions";
import {
  decodeDimensionCursor,
  preflightQualifiedDimensionPageCursorFromD1,
  queryDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { prepareEventMembershipFallback } from "@/lib/edge/analytics/providers/d1/internal/event-membership-fallback";
import { queryPagesDashboard } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard";
import { executePagesDashboardQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-program";
import { deferredPagesDashboardQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import {
  decodeReferrersCursor,
  queryQualifiedReferrersPageFromD1,
  queryReferrersPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/referrers";
import type { Env } from "@/lib/edge/types";
import { InvalidCursorError } from "@/lib/pagination";

const env = {} as Env;
const siteId = "site-cursors";
const time = createQueryTime(0, 100, "UTC", 100);
const context = siteQueryContext(siteId, "private-dashboard");
const emptyPagination = {
  limit: 1,
  returned: 0,
  hasMore: false,
  nextCursor: null,
};
const comparisonControls = {
  metric: "views",
  sortBy: "views",
  direction: "desc",
};

function input(fields: Record<string, unknown> = {}) {
  return { context, time, filters: EMPTY_FILTER_DOCUMENT, ...fields } as never;
}
function comparisonInput(fields: Record<string, unknown>) {
  return input({
    mode: "overview-tab",
    comparison: comparisonControls,
    current: { time },
    reference: { time },
    ...fields,
  });
}
function provider(name: string) {
  const registry = new AnalyticsProviderRegistry();
  registerSiteContractProviders(registry, { env, siteId });
  return registry.resolve(name as never)!;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(decodeDimensionCursor).mockResolvedValue(null);
  vi.mocked(decodeReferrersCursor).mockResolvedValue(null);
  vi.mocked(decodeComparisonDimensionCursor).mockResolvedValue(null);
  vi.mocked(queryDimensionPageFromD1).mockResolvedValue({
    items: [{ value: "x", views: 3, sessions: 2, visitors: 1 }],
    pagination: emptyPagination,
  } as never);
  vi.mocked(queryReferrersPageFromD1).mockResolvedValue({
    items: [],
    pagination: emptyPagination,
  } as never);
  vi.mocked(queryComparisonDimensionPageFromD1).mockResolvedValue({
    items: [],
    pagination: emptyPagination,
  } as never);
});

describe("page.query overview table", () => {
  it("maps rows to value/label pairs without tab decoration", async () => {
    const result = await provider("dimension").execute(
      input({ mode: "overview-tab", tab: "page.query", limit: 5 }),
    );
    expect(queryDimensionPageFromD1).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      value: {
        data: {
          items: [
            { value: "x", label: "x", views: 3, sessions: 2, visitors: 1 },
          ],
        },
      },
    });
  });
});

describe("qualified overview page-table cursors", () => {
  const qualified = { qualification: "deferred" };

  beforeEach(() => {
    vi.mocked(deferredOverviewPageTableQualificationFromQuery).mockReturnValue(
      qualified as never,
    );
  });

  it("propagates unexpected cursor decoding failures unchanged", async () => {
    vi.mocked(decodeDimensionCursor).mockRejectedValue(new Error("decode io"));
    await expect(
      provider("dimension").execute(
        input({ mode: "overview-tab", tab: "client.browser", cursor: "c" }),
      ),
    ).rejects.toThrow("decode io");
    expect(preflightQualifiedDimensionPageCursorFromD1).not.toHaveBeenCalled();
  });

  it("preflights the qualified plan before rejecting an undecodable cursor", async () => {
    await expect(
      provider("dimension").execute(
        input({ mode: "overview-tab", tab: "client.browser", cursor: "stale" }),
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(preflightQualifiedDimensionPageCursorFromD1).toHaveBeenCalledTimes(
      1,
    );
    expect(preflightQualifiedDimensionPageCursorFromD1).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId,
        tab: "client.browser",
        cursorToken: "stale",
        deferred: qualified,
      }),
    );
    expect(queryDimensionPageFromD1).not.toHaveBeenCalled();
  });
});

describe("qualified referrer overview cursors", () => {
  const deferred = {
    metadata: { plan: { id: "plan" } },
    time,
    requestTime: time,
  };

  beforeEach(() => {
    vi.mocked(deferredReferrerOverviewQualificationFromQuery).mockReturnValue(
      deferred as never,
    );
    vi.mocked(prepareDeferredEventQualificationFallback).mockResolvedValue(
      "FALLBACK" as never,
    );
  });

  const request = () =>
    input({ mode: "overview-tab", tab: "source.link", cursor: "stale" });

  it("propagates unexpected cursor decoding failures unchanged", async () => {
    vi.mocked(decodeReferrersCursor).mockRejectedValue(new Error("io"));
    await expect(provider("dimension").execute(request())).rejects.toThrow(
      "io",
    );
    expect(queryQualifiedReferrersPageFromD1).not.toHaveBeenCalled();
  });

  it("replays the first page through the legacy reader when decoding reports an invalid cursor", async () => {
    vi.mocked(decodeReferrersCursor).mockRejectedValue(
      new InvalidCursorError("overview-tab"),
    );
    vi.mocked(queryQualifiedReferrersPageFromD1).mockResolvedValue({
      kind: "fallback",
    } as never);
    await expect(
      provider("dimension").execute(request()),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(queryQualifiedReferrersPageFromD1).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: null, cursorToken: "stale" }),
    );
    expect(queryReferrersPageFromD1).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryReferrersPageFromD1).mock.calls[0]![3]).toBe(
      "FALLBACK",
    );
  });

  it("rejects a stale cursor after the qualified first page executes", async () => {
    vi.mocked(queryQualifiedReferrersPageFromD1).mockResolvedValue({
      kind: "executed",
    } as never);
    await expect(
      provider("dimension").execute(request()),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(queryQualifiedReferrersPageFromD1).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: null, cursorToken: "stale" }),
    );
    expect(queryReferrersPageFromD1).not.toHaveBeenCalled();
  });

  it("runs the legacy first page when the qualified reader falls back, then rejects", async () => {
    vi.mocked(queryQualifiedReferrersPageFromD1).mockResolvedValue({
      kind: "fallback",
    } as never);
    vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValue({
      prepared: true,
    } as never);
    await expect(
      provider("dimension").execute(request()),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(queryReferrersPageFromD1).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryReferrersPageFromD1).mock.calls[0]![3]).toBe(
      EMPTY_FILTER_DOCUMENT,
    );
    expect(vi.mocked(queryReferrersPageFromD1).mock.calls[0]![12]).toEqual({
      preparation: { prepared: true },
      queryTime: time,
      scopePlan: { id: "plan" },
    });
  });

  it("falls back to event-qualified filters when no page-visit preparation exists", async () => {
    vi.mocked(decodeReferrersCursor).mockResolvedValue({
      primary: 1,
      secondary: 1,
      referrer: "x",
    });
    vi.mocked(queryQualifiedReferrersPageFromD1).mockResolvedValue({
      kind: "fallback",
    } as never);
    vi.mocked(prepareDeferredPageVisitQualification).mockResolvedValue(
      undefined as never,
    );
    // A decodable cursor must not be rejected; the fallback page is returned.
    const result = await provider("dimension").execute(request());
    expect(result).toMatchObject({ value: { data: { items: [] } } });
    expect(vi.mocked(queryReferrersPageFromD1).mock.calls[0]![3]).toBe(
      "FALLBACK",
    );
  });
});

describe("session boundary comparison cursors", () => {
  const request = (cursor?: string) =>
    comparisonInput({ tab: "page.entry", ...(cursor ? { cursor } : {}) });

  it("propagates decoder failures that are not invalid cursors", async () => {
    vi.mocked(decodeComparisonDimensionCursor).mockRejectedValue(
      new Error("storage"),
    );
    await expect(provider("dimension").execute(request("c"))).rejects.toThrow(
      "storage",
    );
    vi.mocked(decodeComparisonDimensionCursor).mockRejectedValue(
      new InvalidCursorError("overview-tab"),
    );
    // Without a deferred qualification an invalid cursor is rethrown as is.
    await expect(
      provider("dimension").execute(request("c")),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(queryComparisonSessionPathPageFromD1).not.toHaveBeenCalled();
  });

  it("rejects an undecodable cursor without a deferred qualification", async () => {
    await expect(
      provider("dimension").execute(request("stale")),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(queryComparisonSessionPathPageFromD1).not.toHaveBeenCalled();
  });

  it("still rejects an invalid cursor after the deferred fallback prepares its filters", async () => {
    vi.mocked(deferredComparisonPageQualificationFromQuery).mockReturnValue({
      qualification: "deferred",
    } as never);
    vi.mocked(decodeComparisonDimensionCursor).mockRejectedValue(
      new InvalidCursorError("overview-tab"),
    );
    vi.mocked(tryQueryQualifiedComparisonDimensionPageFromD1).mockResolvedValue(
      { kind: "fallback" } as never,
    );
    vi.mocked(
      prepareDeferredComparisonPageQualificationFallback,
    ).mockResolvedValue({
      currentFilters: "CURRENT",
      referenceFilters: "REFERENCE",
    } as never);
    await expect(
      provider("dimension").execute(request("stale")),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(
      prepareDeferredComparisonPageQualificationFallback,
    ).toHaveBeenCalledTimes(1);
    expect(queryComparisonSessionPathPageFromD1).not.toHaveBeenCalled();
  });
});

describe("dimension comparison cursors and expressions", () => {
  const request = (tab: string, cursor?: string) =>
    comparisonInput({ tab, ...(cursor ? { cursor } : {}) });

  it.each([
    ["geo.timezone", "TRIM(COALESCE(timezone, ''))"],
    ["geo.organization", "TRIM(COALESCE(as_organization, ''))"],
  ])("compares %s using its trimmed column expression", async (tab, sql) => {
    await provider("dimension").execute(request(tab));
    expect(decodeComparisonDimensionCursor).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decodeComparisonDimensionCursor).mock.calls[0]![6]).toBe(
      sql,
    );
    expect(
      vi.mocked(queryComparisonDimensionPageFromD1).mock.calls[0]![7],
    ).toBe(sql);
  });

  it("does not run comparison reads for an unknown geo tab", async () => {
    await expect(
      provider("dimension").execute(request("geo.bogus")),
    ).rejects.toThrow("unsupported-dimension:geo.bogus");
    expect(decodeComparisonDimensionCursor).not.toHaveBeenCalled();
  });

  it("propagates decoder failures that are not invalid cursors", async () => {
    vi.mocked(decodeComparisonDimensionCursor).mockRejectedValue(
      new Error("storage"),
    );
    await expect(
      provider("dimension").execute(request("geo.country", "c")),
    ).rejects.toThrow("storage");
  });

  it("rejects an undecodable cursor without a deferred qualification", async () => {
    await expect(
      provider("dimension").execute(request("geo.country", "stale")),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(queryComparisonDimensionPageFromD1).not.toHaveBeenCalled();
  });

  it("still rejects an invalid cursor after the deferred fallback prepares its filters", async () => {
    vi.mocked(deferredComparisonPageQualificationFromQuery).mockReturnValue({
      qualification: "deferred",
    } as never);
    vi.mocked(decodeComparisonDimensionCursor).mockRejectedValue(
      new InvalidCursorError("overview-tab"),
    );
    vi.mocked(tryQueryQualifiedComparisonDimensionPageFromD1).mockResolvedValue(
      { kind: "fallback" } as never,
    );
    vi.mocked(
      prepareDeferredComparisonPageQualificationFallback,
    ).mockResolvedValue({
      currentFilters: "CURRENT",
      referenceFilters: "REFERENCE",
    } as never);
    await expect(
      provider("dimension").execute(request("geo.country", "stale")),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(queryComparisonDimensionPageFromD1).not.toHaveBeenCalled();
  });
});

describe("referrers provider cursor failures", () => {
  it("does not mask unexpected cursor decoding errors", async () => {
    vi.mocked(decodeReferrersCursor).mockRejectedValue(new Error("io"));
    await expect(
      provider("referrers").execute(input({ page: { limit: 5, cursor: "c" } })),
    ).rejects.toThrow("io");
    expect(queryReferrersPageFromD1).not.toHaveBeenCalled();
  });
});

describe("pages-dashboard deferred fallbacks", () => {
  const deferred = {
    qualification: {
      filters: "QUALIFIED",
      metadata: { plan: { mode: "entity" } },
    },
    configuration: {
      interval: "day",
      search: "docs",
      limit: 7,
      cursorText: "next",
      audience: "private-dashboard",
    },
  };

  beforeEach(() => {
    vi.mocked(deferredPagesDashboardQualificationFromQuery).mockReturnValue(
      deferred as never,
    );
    vi.mocked(executePagesDashboardQualificationProgram).mockResolvedValue({
      kind: "fallback",
    } as never);
    vi.mocked(queryPagesDashboard).mockResolvedValue({
      dashboard: true,
    } as never);
  });

  it("reuses a request-private entity membership when one can be prepared", async () => {
    vi.mocked(prepareEventMembershipFallback).mockResolvedValue({
      membership: true,
    } as never);
    const result = await provider("pages-dashboard").execute(
      input({ sort: "views" }),
    );
    expect(result).toEqual({ value: { dashboard: true }, source: "raw" });
    expect(queryPagesDashboard).toHaveBeenCalledWith(
      env,
      siteId,
      expect.objectContaining({
        filters: "QUALIFIED",
        interval: "day",
        search: "docs",
        sort: "views",
        page: { limit: 7, cursor: "next" },
      }),
      { membership: { membership: true } },
    );
  });

  it("falls back to event-qualified filters without a membership", async () => {
    vi.mocked(prepareEventMembershipFallback).mockResolvedValue(
      undefined as never,
    );
    vi.mocked(prepareDeferredEventQualificationFallback).mockResolvedValue(
      "FALLBACK" as never,
    );
    const result = await provider("pages-dashboard").execute(
      input({ sort: "sessions" }),
    );
    expect(result).toEqual({ value: { dashboard: true }, source: "raw" });
    expect(prepareDeferredEventQualificationFallback).toHaveBeenCalledWith(
      deferred.qualification,
    );
    expect(queryPagesDashboard).toHaveBeenCalledWith(
      env,
      siteId,
      expect.objectContaining({
        filters: "FALLBACK",
        sort: "sessions",
        page: { limit: 7, cursor: "next" },
        audience: "private-dashboard",
      }),
    );
    expect(vi.mocked(queryPagesDashboard).mock.calls[0]).toHaveLength(3);
  });
});
