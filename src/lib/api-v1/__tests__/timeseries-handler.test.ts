import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { aggregateCache } from "@/lib/api-v1/analytics-overview";
import { executeApiV1SiteTimeseries } from "@/lib/api-v1/analytics-timeseries";
import { handlePlannedSiteTimeseries } from "@/lib/api-v1/timeseries-handler";
import { AnalyticsTimeseriesResponseSchema } from "@/lib/api-v1/wire";
import type { OverviewReader } from "@/lib/edge/analytics/contract";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

beforeEach(() => aggregateCache.clear());

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
  status: "active",
};

const input = {
  timeRange: {
    kind: "absolute",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
    timeZone: "UTC",
  },
  interval: "hour",
};

function reader(): OverviewReader {
  return {
    readOverview: vi.fn(),
    readTrend: vi.fn().mockResolvedValue({
      value: [
        {
          bucket: 0,
          timestampMs: Date.parse("2026-08-01T00:00:00.000Z"),
          views: 20,
          sessions: 5,
          visitors: 4,
          bounces: 1,
          totalDurationMs: 5000,
          durationViews: 20,
        },
      ],
      source: "raw",
      approximateVisitors: false,
    }),
  };
}

describe("planned site timeseries HTTP adapter", () => {
  it("serves a typed Hono response with analytics metadata", async () => {
    const app = new Hono();
    app.post("/api/v1/sites/:siteId/analytics/timeseries", (context) =>
      handlePlannedSiteTimeseries(
        context.req.raw,
        principal,
        context.req.param("siteId"),
        reader(),
        {},
      ),
    );
    const response = await app.fetch(
      new Request("https://app.test/api/v1/sites/site-1/analytics/timeseries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(AnalyticsTimeseriesResponseSchema.safeParse(body).success).toBe(
      true,
    );
    expect(response.headers.get("X-Request-Id")).toBe(
      (body as { meta: { requestId: string } }).meta.requestId,
    );
    expect(body).toMatchObject({
      data: {
        interval: "hour",
        points: [{ sessions: 5, avgDurationMs: 1000, bounceRate: 0.2 }],
      },
      meta: {
        timeRange: { timeZone: "UTC" },
        source: "raw",
        accuracy: "exact",
      },
    });
  });

  it("rejects transport/body/policy boundaries before provider access", async () => {
    const provider = reader();
    const url = "https://app.test/api/v1/sites/site-1/analytics/timeseries";
    const request = (body: BodyInit | null, init: RequestInit = {}) =>
      new Request(url, {
        ...init,
        method: "POST",
        headers: { "Content-Type": "application/json", ...init.headers },
        body,
      });
    expect(
      (
        await handlePlannedSiteTimeseries(
          request(null),
          principal,
          "site-1",
          provider,
          {},
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handlePlannedSiteTimeseries(
          request(JSON.stringify(input), { headers: { Accept: "text/plain" } }),
          principal,
          "site-1",
          provider,
          {},
        )
      ).status,
    ).toBe(406);
    expect(
      (
        await handlePlannedSiteTimeseries(
          request(JSON.stringify(input)),
          { ...principal, scopes: [] },
          "site-1",
          provider,
          {},
        )
      ).status,
    ).toBe(403);
    expect(provider.readTrend).not.toHaveBeenCalled();
  });

  it("covers typed adapter cancellation, deadline, range, and saved-filter gates", async () => {
    const provider = reader();
    const controller = new AbortController();
    controller.abort();
    const aborted = await executeApiV1SiteTimeseries(
      input,
      principal,
      "site-1",
      provider,
      { signal: controller.signal },
    );
    expect(aborted).toMatchObject({
      ok: false,
      error: { kind: "request_cancelled" },
    });

    const deadline = await executeApiV1SiteTimeseries(
      input,
      principal,
      "site-1",
      provider,
      { now: () => 10, deadlineMs: 10 },
    );
    expect(deadline).toMatchObject({
      ok: false,
      error: { kind: "deadline_exceeded" },
    });

    const invalidRange = await executeApiV1SiteTimeseries(
      { ...input, timeRange: { ...input.timeRange, to: input.timeRange.from } },
      principal,
      "site-1",
      provider,
      {},
    );
    expect(invalidRange).toMatchObject({
      ok: false,
      error: { kind: "invalid_input" },
    });

    const siteDenied = await executeApiV1SiteTimeseries(
      input,
      { ...principal, siteIds: ["site-2"] },
      "site-1",
      provider,
      {},
    );
    expect(siteDenied).toMatchObject({
      ok: false,
      error: { kind: "site_not_found" },
    });

    const saved = { ...input, filter: { type: "saved", id: "filter-1" } };
    const savedDenied = await executeApiV1SiteTimeseries(
      saved,
      principal,
      "site-1",
      provider,
      {},
    );
    expect(savedDenied).toMatchObject({
      ok: false,
      error: { kind: "missing_scope" },
    });

    const unavailable = await executeApiV1SiteTimeseries(
      saved,
      { ...principal, scopes: ["analytics:read", "analysis:read"] },
      "site-1",
      provider,
      {},
    );
    expect(unavailable).toMatchObject({
      ok: false,
      error: { kind: "saved_filter_not_available" },
    });

    const definitions = {
      resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue({
        document: { version: 1, root: null },
        fingerprint: "fingerprint",
      }),
    };
    const resolved = await executeApiV1SiteTimeseries(
      saved,
      { ...principal, scopes: ["analytics:read", "analysis:read"] },
      "site-1",
      provider,
      {},
      definitions,
    );
    expect(resolved.ok).toBe(true);
  });

  it("rejects unsupported media types before reading the body", async () => {
    const response = await handlePlannedSiteTimeseries(
      new Request("https://app.test/api/v1/sites/site-1/analytics/timeseries", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(input),
      }),
      principal,
      "site-1",
      reader(),
      {},
    );
    expect(response.status).toBe(415);
  });

  it("maps inactive, invalid, and deadline service outcomes to stable errors", async () => {
    const url = "https://app.test/api/v1/sites/site-1/analytics/timeseries";
    const request = (body: unknown) =>
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (
        await handlePlannedSiteTimeseries(
          request(input),
          { ...principal, status: "revoked" },
          "site-1",
          reader(),
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedSiteTimeseries(
          request({
            ...input,
            timeRange: { kind: "absolute", from: "bad", to: "bad" },
          }),
          principal,
          "site-1",
          reader(),
          {},
        )
      ).status,
    ).toBe(400);
    let now = 0;
    const response = await handlePlannedSiteTimeseries(
      request(input),
      principal,
      "site-1",
      reader(),
      { now: () => (now++ === 0 ? 0 : 100), deadlineMs: 50 },
    );
    expect(response.status).toBe(504);
  });
});
