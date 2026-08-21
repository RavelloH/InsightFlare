import { describe, expect, it, vi } from "vitest";

import { handleSiteOverviewComparison } from "@/lib/api-v1/comparison-handler";
import { handleSiteTimeseriesComparison } from "@/lib/api-v1/comparison-timeseries-handler";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { OverviewReader } from "@/lib/edge/query-contract";

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
  status: "active",
};

const overviewBody = {
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
  query: { metrics: ["views"] },
};

function request(
  body: unknown = overviewBody,
  init: RequestInit = {},
): Request {
  return new Request("https://app.test/api/v1/sites/site-1/analytics/compare", {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(body),
  });
}

function overviewReader(): OverviewReader {
  return {
    readOverview: vi.fn().mockResolvedValue({
      value: {
        views: 10,
        sessions: 2,
        visitors: 2,
        bounces: 1,
        totalDurationMs: 20,
        durationViews: 2,
      },
      source: "raw",
      approximateVisitors: false,
    }),
    readTrend: vi.fn(),
  };
}

function trendReader(): OverviewReader {
  return {
    readOverview: vi.fn(),
    readTrend: vi.fn().mockResolvedValue({
      value: [
        {
          bucket: 0,
          timestampMs: Date.parse("2026-08-01T00:00:00.000Z"),
          views: 10,
          sessions: 2,
          visitors: 2,
          bounces: 1,
          totalDurationMs: 20,
          durationViews: 2,
        },
      ],
      source: "raw",
      approximateVisitors: false,
    }),
  };
}

describe("site comparison HTTP adapters", () => {
  it.each([
    [new Request("https://app.test", { method: "GET" }), 405],
    [request(overviewBody, { headers: { "content-encoding": "gzip" } }), 415],
    [request(overviewBody, { headers: { accept: "text/html" } }), 406],
    [request({}), 400],
  ])("validates overview requests before execution", async (input, status) => {
    const response = await handleSiteOverviewComparison(
      input,
      principal,
      "site-1",
      overviewReader(),
      { capturedAtMs: Date.parse("2026-08-02T00:00:00.000Z") },
    );
    expect(response.status).toBe(status);
  });

  it("maps overview execution guards to stable HTTP errors before the reader", async () => {
    const source = overviewReader();
    const saved = {
      ...overviewBody,
      a: {
        ...overviewBody.a,
        filter: { type: "saved", id: "filter-1" },
      },
    };
    const cases: readonly [
      Request,
      ApiKeyPrincipal,
      string,
      Parameters<typeof handleSiteOverviewComparison>[4],
      number,
    ][] = [
      [request({}), principal, "site-1", {}, 400],
      [request(), { ...principal, siteIds: ["site-2"] }, "site-1", {}, 404],
      [request(saved), principal, "site-1", {}, 403],
      [request(), principal, "site-1", { now: () => 10, deadlineMs: 10 }, 504],
    ];
    for (const [input, inputPrincipal, siteId, context, status] of cases) {
      expect(
        (
          await handleSiteOverviewComparison(
            input,
            inputPrincipal,
            siteId,
            source,
            context,
          )
        ).status,
      ).toBe(status);
    }
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await handleSiteOverviewComparison(
          request(),
          principal,
          "site-1",
          source,
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);
    expect(source.readOverview).not.toHaveBeenCalled();
  });

  it("rejects malformed media and maps overview provider and budget failures", async () => {
    const source = overviewReader();
    expect(
      (
        await handleSiteOverviewComparison(
          request(overviewBody, { headers: { "content-type": "text/plain" } }),
          principal,
          "site-1",
          source,
          {},
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handleSiteOverviewComparison(
          new Request("https://app.test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
          }),
          principal,
          "site-1",
          source,
          {},
        )
      ).status,
    ).toBe(400);
    const throwing: OverviewReader = {
      readOverview: vi.fn().mockRejectedValue(new Error("provider failed")),
      readTrend: vi.fn(),
    };
    expect(
      (
        await handleSiteOverviewComparison(
          request(),
          principal,
          "site-1",
          throwing,
          {},
        )
      ).status,
    ).toBe(500);
    const huge = {
      ...overviewBody,
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
    };
    expect(
      (
        await handleSiteOverviewComparison(
          request(huge),
          principal,
          "site-1",
          source,
          {},
        )
      ).status,
    ).toBe(422);
  });

  it("serializes an overview comparison through the strict wire boundary", async () => {
    const response = await handleSiteOverviewComparison(
      request(),
      principal,
      "site-1",
      overviewReader(),
      { capturedAtMs: Date.parse("2026-08-02T00:00:00.000Z") },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { a: { avgDurationMs: 10 }, delta: { views: 0 } },
      meta: { source: "raw", accuracy: "exact" },
    });
  });

  it("rejects bad content negotiation for timeseries and serializes aligned points", async () => {
    const invalid = await handleSiteTimeseriesComparison(
      request(
        { ...overviewBody, query: { interval: "day" } },
        { headers: { accept: "text/html" } },
      ),
      principal,
      "site-1",
      trendReader(),
      {},
    );
    expect(invalid.status).toBe(406);

    const response = await handleSiteTimeseriesComparison(
      request({ ...overviewBody, query: { interval: "day" } }),
      principal,
      "site-1",
      trendReader(),
      { capturedAtMs: Date.parse("2026-08-02T00:00:00.000Z") },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { interval: "day", delta: { points: [{ ordinal: 0, views: 0 }] } },
    });
  });

  it("maps typed timeseries execution guards before either provider call", async () => {
    const source = trendReader();
    const saved = {
      ...overviewBody,
      a: {
        ...overviewBody.a,
        filter: { type: "saved", id: "filter-1" },
      },
      query: { interval: "day" },
    };
    const cases: readonly [
      Request,
      ApiKeyPrincipal,
      string,
      Parameters<typeof handleSiteTimeseriesComparison>[4],
      number,
    ][] = [
      [request({}), principal, "site-1", {}, 400],
      [
        request({ ...overviewBody, query: { interval: "day" } }),
        { ...principal, siteIds: ["site-2"] },
        "site-1",
        {},
        404,
      ],
      [request(saved), principal, "site-1", {}, 403],
      [
        request({ ...overviewBody, query: { interval: "day" } }),
        principal,
        "site-1",
        { now: () => 10, deadlineMs: 10 },
        504,
      ],
    ];
    for (const [input, inputPrincipal, siteId, context, status] of cases) {
      expect(
        (
          await handleSiteTimeseriesComparison(
            input,
            inputPrincipal,
            siteId,
            source,
            context,
          )
        ).status,
      ).toBe(status);
    }
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await handleSiteTimeseriesComparison(
          request({ ...overviewBody, query: { interval: "day" } }),
          principal,
          "site-1",
          source,
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);
    expect(source.readTrend).not.toHaveBeenCalled();
  });

  it("maps mismatched and failed timeseries providers without partial data", async () => {
    const mismatched: OverviewReader = {
      readOverview: vi.fn(),
      readTrend: vi
        .fn()
        .mockResolvedValueOnce({
          value: [],
          source: "raw",
          approximateVisitors: false,
        })
        .mockResolvedValueOnce({
          value: [
            {
              bucket: 0,
              timestampMs: Date.parse("2026-08-01T00:00:00.000Z") as never,
              views: 1,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 0,
              durationViews: 0,
            },
          ],
          source: "raw",
          approximateVisitors: false,
        }),
    };
    expect(
      (
        await handleSiteTimeseriesComparison(
          request({ ...overviewBody, query: { interval: "day" } }),
          principal,
          "site-1",
          mismatched,
          {},
        )
      ).status,
    ).toBe(422);
    const throwing: OverviewReader = {
      readOverview: vi.fn(),
      readTrend: vi.fn().mockRejectedValue(new Error("provider failed")),
    };
    expect(
      (
        await handleSiteTimeseriesComparison(
          request({ ...overviewBody, query: { interval: "day" } }),
          principal,
          "site-1",
          throwing,
          {},
        )
      ).status,
    ).toBe(500);
  });

  it("enforces the full comparison transport contract before reading JSON", async () => {
    const overviewMethod = await handleSiteOverviewComparison(
      new Request("https://app.test", { method: "GET" }),
      principal,
      "site-1",
      overviewReader(),
      {},
    );
    expect(overviewMethod.headers.get("Allow")).toBe("POST");
    for (const handler of [
      (input: Request) =>
        handleSiteOverviewComparison(
          input,
          principal,
          "site-1",
          overviewReader(),
          {},
        ),
      (input: Request) =>
        handleSiteTimeseriesComparison(
          input,
          principal,
          "site-1",
          trendReader(),
          {},
        ),
    ]) {
      for (const requestInput of [
        request(overviewBody, { headers: { "content-encoding": "gzip" } }),
        request(overviewBody, { headers: { "content-type": "text/plain" } }),
        new Request("https://app.test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      ]) {
        const response = await handler(requestInput);
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    }
    const timeseriesMethod = await handleSiteTimeseriesComparison(
      new Request("https://app.test", { method: "GET" }),
      principal,
      "site-1",
      trendReader(),
      {},
    );
    expect(timeseriesMethod.headers.get("Allow")).toBe("POST");
  });

  it("serializes zero-safe overview metrics and accepts JSON wildcards", async () => {
    const zeroReader: OverviewReader = {
      readOverview: vi.fn().mockResolvedValue({
        value: {
          views: 0,
          sessions: 0,
          visitors: 0,
          bounces: 0,
          totalDurationMs: 0,
          durationViews: 0,
        },
        source: "raw",
        approximateVisitors: false,
      }),
      readTrend: vi.fn(),
    };
    for (const accept of ["application/*", "*/*"]) {
      const response = await handleSiteOverviewComparison(
        request(overviewBody, { headers: { accept } }),
        principal,
        "site-1",
        zeroReader,
        { capturedAtMs: Date.parse("2026-08-02T00:00:00.000Z") },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        data: { a: { avgDurationMs: 0, bounceRate: 0 } },
      });
    }
  });
});
