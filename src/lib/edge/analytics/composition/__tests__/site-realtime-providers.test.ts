import { beforeEach, describe, expect, it, vi } from "vitest";

import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { registerSiteRealtimeProviders } from "@/lib/edge/analytics/composition/site-realtime-providers";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type RealtimeQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  readSiteRealtimeActiveVisitors,
  readSiteRealtimeEvents,
  readSiteRealtimeSessions,
  readSiteRealtimeSnapshot,
} from "@/lib/edge/analytics/providers/realtime/operations/site-realtime";
import type { Env } from "@/lib/edge/types";

vi.mock(
  "@/lib/edge/analytics/providers/realtime/operations/site-realtime",
  () => ({
    readSiteRealtimeActiveVisitors: vi.fn(),
    readSiteRealtimeEvents: vi.fn(),
    readSiteRealtimeSessions: vi.fn(),
    readSiteRealtimeSnapshot: vi.fn(),
  }),
);

const env = {} as Env;
const time = createQueryTime(100, 200, "UTC", 200);
const baseQuery = {
  context: siteQueryContext("site-1", "api-v1"),
  time,
  filters: EMPTY_FILTER_DOCUMENT,
  siteId: "site-1",
  limit: 10,
} satisfies Omit<RealtimeQuery, "mode">;

describe("site realtime canonical provider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readSiteRealtimeSnapshot).mockResolvedValue({} as never);
    vi.mocked(readSiteRealtimeActiveVisitors).mockResolvedValue({} as never);
    vi.mocked(readSiteRealtimeEvents).mockResolvedValue({} as never);
    vi.mocked(readSiteRealtimeSessions).mockResolvedValue({} as never);
  });

  it("dispatches every declared mode through the same realtime operation", async () => {
    const registry = new AnalyticsProviderRegistry();
    registerSiteRealtimeProviders(registry, { env, siteId: "site-1" });
    const provider = registry.resolve("realtime")!;

    for (const mode of [
      "snapshot",
      "active-visitors",
      "events",
      "sessions",
    ] as const) {
      const query: RealtimeQuery = { ...baseQuery, mode };
      await provider.execute(query);
    }

    expect(readSiteRealtimeSnapshot).toHaveBeenCalledTimes(1);
    expect(readSiteRealtimeActiveVisitors).toHaveBeenCalledTimes(1);
    expect(readSiteRealtimeEvents).toHaveBeenCalledTimes(1);
    expect(readSiteRealtimeSessions).toHaveBeenCalledTimes(1);
    await expect(
      provider.execute({ ...baseQuery, mode: "invalid" } as never),
    ).rejects.toThrow("unsupported-realtime-query-mode");

    const defaultedQuery: RealtimeQuery = {
      context: baseQuery.context,
      time: baseQuery.time,
      filters: baseQuery.filters,
      mode: "snapshot",
    };
    await provider.execute(defaultedQuery);
    expect(readSiteRealtimeSnapshot).toHaveBeenLastCalledWith({
      env,
      siteId: "site-1",
      startMs: 100,
      endExclusiveMs: 200,
      limit: 20,
      signal: undefined,
    });
  });
});
