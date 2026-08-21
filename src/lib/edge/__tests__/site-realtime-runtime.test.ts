import { beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = vi.fn();
const activeVisitors = vi.fn();
vi.mock("@/lib/edge/realtime-provider", () => ({
  RealtimeProvider: class {
    snapshot = snapshot;
    activeVisitors = activeVisitors;
  },
}));

import {
  readSiteRealtimeActiveVisitors,
  readSiteRealtimeEvents,
  readSiteRealtimeSessions,
  readSiteRealtimeSnapshot,
} from "@/lib/edge/query-runtime/site-realtime";

const base = {
  env: {} as never,
  siteId: "site-1",
  startMs: 10,
  endExclusiveMs: 20,
};

describe("site realtime runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates snapshot projections to the encapsulated realtime provider", async () => {
    snapshot.mockResolvedValue({
      activeVisitors: 2,
      events: [{ id: "event" }],
      sessions: [{ visitId: "visit" }],
    });
    await expect(
      readSiteRealtimeSnapshot({ ...base, limit: 50 }),
    ).resolves.toMatchObject({ activeVisitors: 2 });
    await expect(
      readSiteRealtimeEvents({ ...base, limit: 50 }),
    ).resolves.toEqual({ items: [{ id: "event" }] });
    await expect(
      readSiteRealtimeSessions({ ...base, limit: 50 }),
    ).resolves.toEqual({ items: [{ visitId: "visit" }] });
    expect(snapshot).toHaveBeenCalledWith({
      siteId: "site-1",
      fromMs: 10,
      toMs: 20,
      limit: 50,
      signal: undefined,
    });
  });

  it("reads active visitors without a snapshot request", async () => {
    activeVisitors.mockResolvedValue(3);
    await expect(readSiteRealtimeActiveVisitors(base)).resolves.toEqual({
      activeVisitors: 3,
    });
    expect(activeVisitors).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-1" }),
    );
    expect(snapshot).not.toHaveBeenCalled();
  });
});
