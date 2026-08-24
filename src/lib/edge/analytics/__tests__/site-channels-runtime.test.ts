import { describe, expect, it, vi } from "vitest";

import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { readSiteChannels } from "@/lib/edge/analytics/providers/d1/operations/site-channels";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/analytics/providers/d1/internal/channels", () => ({
  queryChannelsFromD1: vi.fn(),
}));

import { queryChannelsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/channels";

describe("site channel operation", () => {
  it("reads channel aggregates through the D1 operation boundary", async () => {
    vi.mocked(queryChannelsFromD1).mockResolvedValue([
      { channel: "organic_search", views: 3, sessions: 2, visitors: 1 },
    ]);

    await expect(
      readSiteChannels({
        env: {} as Env,
        siteId: "site-1",
        window: {
          startMs: 100,
          endExclusiveMs: 200,
          nowMs: 200,
          timeZone: "UTC",
        },
        filters: EMPTY_FILTER_DOCUMENT,
        limit: 10,
      }),
    ).resolves.toEqual({
      items: [
        { channel: "organic_search", views: 3, sessions: 2, visitors: 1 },
      ],
    });
  });
});
