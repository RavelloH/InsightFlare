import { describe, expect, it, vi } from "vitest";

import { executeApiV1SiteTimeseriesComparison } from "@/lib/api-v1/analytics-comparison-timeseries";
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

function point(bucket: number, views: number) {
  return {
    bucket,
    timestampMs: Date.parse(`2026-08-0${bucket + 1}T00:00:00.000Z`) as never,
    views,
    sessions: views,
    visitors: views,
    bounces: 0,
    totalDurationMs: views * 10,
    durationViews: views,
  };
}

function reader(): OverviewReader {
  let calls = 0;
  return {
    readOverview: vi.fn(),
    readTrend: vi.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve({
        value:
          calls === 1
            ? [point(0, 10), point(1, 20)]
            : [point(0, 5), point(1, 0)],
        source: "raw",
        approximateVisitors: false,
      });
    }),
  };
}

const input = {
  mode: "explicit" as const,
  timeZone: "UTC",
  a: { timeRange: { kind: "preset" as const, preset: "last_7_days" } },
  b: { timeRange: { kind: "preset" as const, preset: "last_30_days" } },
  query: { interval: "day" as const },
};

describe("API v1 comparison timeseries", () => {
  it("enforces typed execution, subject, and saved-filter guards", async () => {
    const source = reader();
    await expect(
      executeApiV1SiteTimeseriesComparison({}, principal, "site-1", source, {}),
    ).resolves.toMatchObject({ ok: false, error: { kind: "invalid_input" } });

    const controller = new AbortController();
    controller.abort();
    await expect(
      executeApiV1SiteTimeseriesComparison(input, principal, "site-1", source, {
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "request_cancelled" },
    });
    await expect(
      executeApiV1SiteTimeseriesComparison(input, principal, "site-1", source, {
        now: () => 10,
        deadlineMs: 10,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "deadline_exceeded" },
    });
    await expect(
      executeApiV1SiteTimeseriesComparison(
        input,
        { ...principal, siteIds: ["site-2"] },
        "site-1",
        source,
        {},
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "site_not_found" },
    });

    const saved = {
      ...input,
      a: { ...input.a, filter: { type: "saved" as const, id: "filter-1" } },
    };
    await expect(
      executeApiV1SiteTimeseriesComparison(
        saved,
        principal,
        "site-1",
        source,
        {},
      ),
    ).resolves.toMatchObject({ ok: false, error: { kind: "missing_scope" } });
    const savedPrincipal: ApiKeyPrincipal = {
      ...principal,
      scopes: ["analytics:read", "analysis:read"],
    };
    await expect(
      executeApiV1SiteTimeseriesComparison(
        saved,
        savedPrincipal,
        "site-1",
        source,
        {},
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "saved_filter_not_available" },
    });
    await expect(
      executeApiV1SiteTimeseriesComparison(
        saved,
        savedPrincipal,
        "site-1",
        source,
        {},
        {
          resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue({
            document: { version: 1, root: null },
            fingerprint: "saved-filter",
          }),
        },
      ),
    ).resolves.toMatchObject({ ok: true, value: { ok: true } });
    expect(source.readTrend).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid ranges and never executes a partially resolved saved query", async () => {
    const source = reader();
    await expect(
      executeApiV1SiteTimeseriesComparison(
        { ...input, timeZone: "Mars/Olympus" },
        principal,
        "site-1",
        source,
        {},
      ),
    ).resolves.toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    await expect(
      executeApiV1SiteTimeseriesComparison(
        {
          ...input,
          a: {
            timeRange: {
              kind: "absolute",
              from: "2026-08-02T00:00:00.000Z",
              to: "2026-08-01T00:00:00.000Z",
            },
          },
        },
        principal,
        "site-1",
        source,
        {},
      ),
    ).resolves.toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    const savedPrincipal: ApiKeyPrincipal = {
      ...principal,
      scopes: ["analytics:read", "analysis:read"],
    };
    await expect(
      executeApiV1SiteTimeseriesComparison(
        {
          ...input,
          a: { ...input.a, filter: { type: "saved", id: "filter-a" } },
          b: { ...input.b, filter: { type: "saved", id: "filter-b" } },
        },
        savedPrincipal,
        "site-1",
        source,
        {},
        {
          resolveTeamVisibleSavedFilter: vi
            .fn()
            .mockResolvedValueOnce({
              document: { version: 1, root: null },
              fingerprint: "a",
            })
            .mockResolvedValueOnce(null),
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "site_not_found" },
    });
    expect(source.readTrend).not.toHaveBeenCalled();
  });

  it("keeps dataset buckets and aligns relative deltas by ordinal", async () => {
    const result = await executeApiV1SiteTimeseriesComparison(
      input,
      principal,
      "site-1",
      reader(),
      { capturedAtMs: Date.parse("2026-08-08T00:00:00.000Z") },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: true,
        value: {
          ok: true,
          data: {
            interval: "day",
            delta: [
              { ordinal: 0, values: { views: 1 } },
              { ordinal: 1, values: { views: null } },
            ],
          },
        },
      },
    });
  });

  it("rejects differently sized provider bucket sequences without partial data", async () => {
    const source = reader();
    vi.mocked(source.readTrend)
      .mockResolvedValueOnce({
        value: [point(0, 10)],
        source: "raw",
        approximateVisitors: false,
      })
      .mockResolvedValueOnce({
        value: [point(0, 5), point(1, 5)],
        source: "raw",
        approximateVisitors: false,
      });
    const result = await executeApiV1SiteTimeseriesComparison(
      input,
      principal,
      "site-1",
      source,
      { capturedAtMs: Date.parse("2026-08-08T00:00:00.000Z") },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: true,
        value: { ok: false, error: { kind: "unsupported-operation" } },
      },
    });
  });
});
