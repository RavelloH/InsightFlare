import { describe, expect, it, vi } from "vitest";

import {
  handleTeamComparisonBreakdown,
  handleTeamComparisonOverview,
  handleTeamComparisonTimeseries,
  type TeamComparisonBreakdownReader,
  type TeamComparisonOverviewReader,
  type TeamComparisonTimeseriesReader,
} from "@/lib/api-v1/team-comparison-handler";
import {
  AnalyticsComparisonBreakdownResponseSchema,
  AnalyticsComparisonOverviewResponseSchema,
  AnalyticsComparisonTimeseriesResponseSchema,
} from "@/lib/api-v1/wire";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
  status: "active",
};

const base = {
  mode: "explicit",
  timeZone: "UTC",
  a: {
    timeRange: {
      kind: "absolute",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    },
  },
  b: {
    timeRange: {
      kind: "absolute",
      from: "2026-07-31T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
  },
};

function request(body: unknown, init: RequestInit = {}) {
  return new Request("https://app.test/api/v1/team/analytics/comparison", {
    ...init,
    method: "POST",
    headers: { "Content-Type": "application/json", ...init.headers },
    body: JSON.stringify(body),
  });
}

const overview = {
  data: {
    views: 10,
    sessions: 2,
    visitors: 2,
    bounces: 1,
    totalDurationMs: 20,
    durationViews: 2,
  },
  source: "raw" as const,
  approximateVisitors: false,
};

describe("team comparison adapters", () => {
  it.each([
    [new Request("https://app.test", { method: "GET" }), principal, 405],
    [
      request(
        { ...base, query: { metrics: ["views"] } },
        {
          headers: { "content-encoding": "gzip" },
        },
      ),
      principal,
      415,
    ],
    [
      request(
        { ...base, query: { metrics: ["views"] } },
        { headers: { "content-type": "text/plain" } },
      ),
      principal,
      415,
    ],
    [
      request(
        { ...base, query: { metrics: ["views"] } },
        {
          headers: { accept: "text/html" },
        },
      ),
      principal,
      406,
    ],
    [
      request({ ...base, query: { metrics: ["views"] } }),
      { ...principal, scopes: [] },
      403,
    ],
    [request({}), principal, 400],
  ])(
    "rejects invalid overview HTTP requests before execution",
    async (input, inputPrincipal, status) => {
      const reader = vi.fn<TeamComparisonOverviewReader>();
      const response = await handleTeamComparisonOverview(
        input,
        inputPrincipal,
        reader,
        {},
      );
      expect(response.status).toBe(status);
      expect(reader).not.toHaveBeenCalled();
    },
  );

  it("uses two distinct inline filters and aggregates both overview sides", async () => {
    const reader = vi
      .fn<TeamComparisonOverviewReader>()
      .mockResolvedValue(overview);
    const response = await handleTeamComparisonOverview(
      request({
        ...base,
        a: {
          ...base.a,
          filter: {
            type: "inline",
            expression: {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "eq",
              value: "/pricing",
            },
          },
        },
        b: base.b,
        query: { metrics: ["views"] },
      }),
      principal,
      reader,
      {},
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(
      AnalyticsComparisonOverviewResponseSchema.safeParse(body).success,
    ).toBe(true);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(reader.mock.calls[0]?.[0].filters.root).not.toBeNull();
    expect(reader.mock.calls[1]?.[0].filters.root).toBeNull();
  });

  it("maps team overview provider and combined-cost failures", async () => {
    const failing = vi
      .fn<TeamComparisonOverviewReader>()
      .mockRejectedValue(new Error("provider failed"));
    expect(
      (
        await handleTeamComparisonOverview(
          request({ ...base, query: { metrics: ["views"] } }),
          principal,
          failing,
          {},
        )
      ).status,
    ).toBe(500);
    const huge = {
      ...base,
      a: {
        timeRange: {
          kind: "absolute",
          from: "1970-01-01T00:00:00.000Z",
          to: "9999-01-01T00:00:00.000Z",
        },
      },
      b: {
        timeRange: {
          kind: "absolute",
          from: "1970-01-01T00:00:00.000Z",
          to: "9999-01-01T00:00:00.000Z",
        },
      },
      query: {},
    };
    expect(
      (
        await handleTeamComparisonOverview(
          request(huge),
          principal,
          vi.fn<TeamComparisonOverviewReader>(),
          {},
        )
      ).status,
    ).toBe(422);
  });

  it("rejects unequal team time-series bucket counts without returning partial data", async () => {
    const reader = vi
      .fn<TeamComparisonTimeseriesReader>()
      .mockResolvedValueOnce({
        data: {
          interval: "day",
          points: [
            {
              bucket: 1,
              timestampMs: 1 as never,
              views: 1,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 0,
              durationViews: 0,
            },
          ],
        },
        source: "raw",
        approximateVisitors: false,
      })
      .mockResolvedValueOnce({
        data: { interval: "day", points: [] },
        source: "raw",
        approximateVisitors: false,
      });
    const response = await handleTeamComparisonTimeseries(
      request({ ...base, query: { interval: "day" } }),
      principal,
      reader,
      {},
    );
    expect(response.status).toBe(422);
    expect(
      AnalyticsComparisonTimeseriesResponseSchema.safeParse(
        await response.json(),
      ).success,
    ).toBe(false);
  });

  it("serializes aligned team time-series and maps an already-aborted request", async () => {
    const reader = vi.fn<TeamComparisonTimeseriesReader>().mockResolvedValue({
      data: {
        interval: "day",
        points: [
          {
            bucket: 0,
            timestampMs: Date.parse("2026-08-01T00:00:00.000Z") as never,
            views: 10,
            sessions: 2,
            visitors: 2,
            bounces: 1,
            totalDurationMs: 20,
            durationViews: 2,
          },
        ],
      },
      source: "raw",
      approximateVisitors: false,
    });
    const response = await handleTeamComparisonTimeseries(
      request({ ...base, query: { interval: "day" } }),
      principal,
      reader,
      { capturedAtMs: Date.parse("2026-08-02T00:00:00.000Z") },
    );
    const body = (await response.json()) as {
      readonly data: {
        readonly delta: { readonly points: readonly unknown[] };
      };
    };
    expect(response.status).toBe(200);
    expect(
      AnalyticsComparisonTimeseriesResponseSchema.safeParse(body).success,
    ).toBe(true);
    expect(body.data.delta.points).toMatchObject([{ views: 0 }]);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await handleTeamComparisonTimeseries(
      request({ ...base, query: { interval: "day" } }),
      principal,
      reader,
      { signal: controller.signal },
    );
    expect(cancelled.status).toBe(499);
  });

  it("maps failed team timeseries and breakdown readers", async () => {
    const failingTimeseries = vi
      .fn<TeamComparisonTimeseriesReader>()
      .mockRejectedValue(new Error("provider failed"));
    expect(
      (
        await handleTeamComparisonTimeseries(
          request({ ...base, query: { interval: "day" } }),
          principal,
          failingTimeseries,
          {},
        )
      ).status,
    ).toBe(500);
    const failingBreakdown = vi
      .fn<TeamComparisonBreakdownReader>()
      .mockRejectedValue(new Error("provider failed"));
    expect(
      (
        await handleTeamComparisonBreakdown(
          request({
            ...base,
            query: {
              limit: 20,
              sort: { metric: "views", side: "a", direction: "desc" },
            },
          }),
          principal,
          "page.path",
          failingBreakdown,
          {},
        )
      ).status,
    ).toBe(500);
  });

  it("executes the breakdown union with a validated dimension", async () => {
    const reader = vi
      .fn<TeamComparisonBreakdownReader>()
      .mockResolvedValueOnce({
        items: [
          { key: "/a", label: "/a", views: 10, sessions: 1, visitors: 1 },
        ],
      })
      .mockResolvedValueOnce({
        items: [{ key: "/b", label: "/b", views: 5, sessions: 9, visitors: 2 }],
      });
    const response = await handleTeamComparisonBreakdown(
      request({
        ...base,
        query: {
          limit: 20,
          sort: { metric: "sessions", side: "b", direction: "desc" },
        },
      }),
      principal,
      "page.path",
      reader,
      { capturedAtMs: Date.parse("2026-08-02T00:00:00.000Z") },
    );
    const body = (await response.json()) as {
      readonly data: { readonly items: readonly unknown[] };
    };
    expect(response.status).toBe(200);
    expect(
      AnalyticsComparisonBreakdownResponseSchema.safeParse(body).success,
    ).toBe(true);
    expect(body.data.items).toMatchObject([
      { key: "/b", a: { views: 0 }, b: { sessions: 9 } },
      { key: "/a", b: { views: 0 } },
    ]);

    const invalidDimension = await handleTeamComparisonBreakdown(
      request({ ...base, query: { limit: 20 } }),
      principal,
      "not-a-dimension",
      reader,
      {},
    );
    expect(invalidDimension.status).toBe(400);
  });

  it("reports mixed source metadata and carries unrestricted team access", async () => {
    const reader = vi
      .fn<TeamComparisonOverviewReader>()
      .mockResolvedValueOnce(overview)
      .mockResolvedValueOnce({
        ...overview,
        source: "rollup",
        approximateVisitors: true,
      });
    const response = await handleTeamComparisonOverview(
      request({ ...base, query: { metrics: ["views"] } }),
      { ...principal, siteIds: [] },
      reader,
      { capturedAtMs: Date.parse("2026-08-02T00:00:00.000Z") },
    );
    const body = (await response.json()) as {
      readonly meta: { readonly source: string; readonly accuracy: string };
    };
    expect(response.status).toBe(200);
    expect(body.meta).toMatchObject({
      source: "mixed",
      accuracy: "approximate",
    });
    expect(reader).toHaveBeenCalledWith(
      expect.objectContaining({ allowedSiteIds: undefined }),
    );
  });

  it("returns cancellation rather than partial comparison data after execution starts", async () => {
    const controller = new AbortController();
    const overviewReader: TeamComparisonOverviewReader = async () => {
      controller.abort();
      return overview;
    };
    expect(
      (
        await handleTeamComparisonOverview(
          request({ ...base, query: { metrics: ["views"] } }),
          principal,
          overviewReader,
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);

    const seriesReader: TeamComparisonTimeseriesReader = async () => {
      controller.abort();
      return {
        data: { interval: "day", points: [] },
        source: "raw",
        approximateVisitors: false,
      };
    };
    expect(
      (
        await handleTeamComparisonTimeseries(
          request({ ...base, query: { interval: "day" } }),
          principal,
          seriesReader,
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);

    const breakdownReader: TeamComparisonBreakdownReader = async () => {
      controller.abort();
      return { items: [] };
    };
    expect(
      (
        await handleTeamComparisonBreakdown(
          request({ ...base, query: { limit: 20 } }),
          principal,
          "page.path",
          breakdownReader,
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);
  });
});
