import { describe, expect, it, vi } from "vitest";

import { executeApiV1SiteOverviewComparison } from "@/lib/api-v1/analytics-comparison";
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

function reader(): OverviewReader {
  return {
    readOverview: vi.fn().mockImplementation(({ time }) =>
      Promise.resolve({
        value: {
          views:
            time.range.startMs === Date.parse("2026-08-01T00:00:00Z") ? 10 : 0,
          sessions: 4,
          visitors: 3,
          bounces: 1,
          totalDurationMs: 100,
          durationViews: 4,
        },
        source: "raw",
        approximateVisitors: false,
      }),
    ),
    readTrend: vi.fn(),
  };
}

describe("API v1 overview comparison", () => {
  it("enforces schema, execution, subject, and saved-filter guards before both reads", async () => {
    const source = reader();
    const explicit = {
      mode: "explicit" as const,
      timeZone: "UTC",
      a: { timeRange: { kind: "preset" as const, preset: "today" as const } },
      b: {
        timeRange: { kind: "preset" as const, preset: "yesterday" as const },
      },
      query: {},
    };

    await expect(
      executeApiV1SiteOverviewComparison({}, principal, "site-1", source, {}),
    ).resolves.toMatchObject({ ok: false, error: { kind: "invalid_input" } });

    const controller = new AbortController();
    controller.abort();
    await expect(
      executeApiV1SiteOverviewComparison(
        explicit,
        principal,
        "site-1",
        source,
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "request_cancelled" },
    });
    await expect(
      executeApiV1SiteOverviewComparison(
        explicit,
        principal,
        "site-1",
        source,
        { now: () => 10, deadlineMs: 10 },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "deadline_exceeded" },
    });
    await expect(
      executeApiV1SiteOverviewComparison(
        explicit,
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
      ...explicit,
      a: { ...explicit.a, filter: { type: "saved" as const, id: "filter-1" } },
    };
    await expect(
      executeApiV1SiteOverviewComparison(
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
      executeApiV1SiteOverviewComparison(
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
      executeApiV1SiteOverviewComparison(
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
    expect(source.readOverview).toHaveBeenCalledTimes(2);
  });

  it("fails the whole comparison for invalid datasets, saved-filter resolution, and shared cost", async () => {
    const explicit = {
      mode: "explicit" as const,
      timeZone: "UTC",
      a: { timeRange: { kind: "preset" as const, preset: "today" as const } },
      b: {
        timeRange: { kind: "preset" as const, preset: "yesterday" as const },
      },
      query: {},
    };
    const source = reader();
    await expect(
      executeApiV1SiteOverviewComparison(
        { ...explicit, timeZone: "Mars/Olympus" },
        principal,
        "site-1",
        source,
        {},
      ),
    ).resolves.toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    await expect(
      executeApiV1SiteOverviewComparison(
        {
          ...explicit,
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
    const saved = {
      ...explicit,
      a: { ...explicit.a, filter: { type: "saved" as const, id: "filter-a" } },
      b: { ...explicit.b, filter: { type: "saved" as const, id: "filter-b" } },
    };
    await expect(
      executeApiV1SiteOverviewComparison(
        saved,
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

    await expect(
      executeApiV1SiteOverviewComparison(
        {
          ...explicit,
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
        },
        principal,
        "site-1",
        source,
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { ok: false, error: { kind: "query-cost-exceeded" } },
    });
    expect(source.readOverview).not.toHaveBeenCalled();
  });

  it("runs explicit A/B datasets under one top-level timezone and computes zero-safe deltas", async () => {
    const source = reader();
    const result = await executeApiV1SiteOverviewComparison(
      {
        mode: "explicit",
        timeZone: "UTC",
        a: {
          timeRange: {
            kind: "absolute",
            from: "2026-08-01T00:00:00Z",
            to: "2026-08-02T00:00:00Z",
          },
        },
        b: {
          timeRange: {
            kind: "absolute",
            from: "2026-07-31T00:00:00Z",
            to: "2026-08-01T00:00:00Z",
          },
        },
        query: { metrics: ["views"] },
      },
      principal,
      "site-1",
      source,
      { capturedAtMs: Date.parse("2026-08-02T00:00:00Z") },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: true,
        value: {
          ok: true,
          data: { delta: { views: null, sessions: 0 } },
        },
      },
    });
    expect(source.readOverview).toHaveBeenCalledTimes(2);
  });

  it("derives the prior interval from exact milliseconds and never returns partial output", async () => {
    const source = reader();
    const result = await executeApiV1SiteOverviewComparison(
      {
        mode: "previous-period",
        timeRange: {
          kind: "absolute",
          from: "2026-08-01T00:00:00Z",
          to: "2026-08-03T00:00:00Z",
          timeZone: "UTC",
        },
        query: {},
      },
      principal,
      "site-1",
      source,
      { capturedAtMs: Date.parse("2026-08-03T00:00:00Z") },
    );

    expect(result).toMatchObject({ ok: true, value: { ok: true } });
    const times = vi
      .mocked(source.readOverview)
      .mock.calls.map(([input]) => input.time.range);
    expect(times).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          startMs: Date.parse("2026-08-01T00:00:00Z"),
          endExclusiveMs: Date.parse("2026-08-03T00:00:00Z"),
        }),
        expect.objectContaining({
          startMs: Date.parse("2026-07-30T00:00:00Z"),
          endExclusiveMs: Date.parse("2026-08-01T00:00:00Z"),
        }),
      ]),
    );
  });

  it("makes a provider failure fail the whole comparison", async () => {
    const source = reader();
    vi.mocked(source.readOverview).mockRejectedValueOnce(new Error("A failed"));
    await expect(
      executeApiV1SiteOverviewComparison(
        {
          mode: "explicit",
          timeZone: "UTC",
          a: { timeRange: { kind: "preset", preset: "today" } },
          b: { timeRange: { kind: "preset", preset: "yesterday" } },
          query: {},
        },
        principal,
        "site-1",
        source,
        { capturedAtMs: Date.parse("2026-08-03T12:00:00Z") },
      ),
    ).rejects.toThrow("A failed");
  });
});
