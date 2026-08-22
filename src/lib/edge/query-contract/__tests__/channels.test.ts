import { describe, expect, it, vi } from "vitest";

import {
  type ChannelsReader,
  executeChannels,
  siteQueryContext,
} from "@/lib/edge/query-contract";

const time = {
  range: { startMs: 0, endExclusiveMs: 1 },
  reportingTimeZone: "UTC",
  capturedAtMs: 1,
} as never;

describe("channels query contract", () => {
  it("has a dedicated operation and returns typed channel metrics", async () => {
    const reader: ChannelsReader = {
      readChannels: vi.fn().mockResolvedValue({
        source: "raw",
        value: [{ channel: "direct", views: 4, sessions: 2, visitors: 2 }],
      }),
    };

    await expect(
      executeChannels(reader, {
        context: siteQueryContext("site-1", "api-v1"),
        time,
        filters: { version: 1, root: null },
        limit: 20,
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ channel: "direct", views: 4, sessions: 2, visitors: 2 }],
      },
    });
  });

  it("allows aggregated channels for public-share policy", async () => {
    const reader: ChannelsReader = {
      readChannels: vi.fn().mockResolvedValue({
        source: "raw",
        value: [],
      }),
    };
    const result = await executeChannels(reader, {
      context: siteQueryContext("site-1", "public-share"),
      time,
      filters: { version: 1, root: null },
      limit: 20,
    });

    expect(result).toMatchObject({ ok: true, data: { items: [] } });
    expect(reader.readChannels).toHaveBeenCalledOnce();
  });
});
