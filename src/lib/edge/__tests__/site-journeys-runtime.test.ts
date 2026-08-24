import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/journey-detail-queries",
  () => ({
    queryVisitorDetailFromD1: vi.fn(),
    querySessionDetailFromD1: vi.fn(),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/journey-list-queries",
  () => ({
    parseSessionListCursor: vi.fn(),
    parseVisitorListCursor: vi.fn(),
    querySessionListPageFromD1: vi.fn(),
    queryJourneyEventsFromD1: vi.fn(),
    queryJourneyTargetExistsFromD1: vi.fn(),
    querySessionsFromD1: vi.fn(),
    queryVisitorListPageFromD1: vi.fn(),
    serializeSessionListCursor: vi.fn(),
    serializeVisitorListCursor: vi.fn(),
  }),
);

import {
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-detail-queries";
import {
  parseSessionListCursor,
  parseVisitorListCursor,
  queryJourneyEventsFromD1,
  queryJourneyTargetExistsFromD1,
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  serializeSessionListCursor,
  serializeVisitorListCursor,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  readSiteSessionDetail,
  readSiteSessionEvents,
  readSiteSessions,
  readSiteVisitorDetail,
  readSiteVisitorEvents,
  readSiteVisitors,
  readSiteVisitorSessions,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";

const base = {
  env: {} as never,
  siteId: "site-1",
  window: { startMs: 10, endExclusiveMs: 20, nowMs: 20, timeZone: "UTC" },
};

describe("site journey detail runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes site, opaque ID, and half-open window to the detail readers", async () => {
    const visitor = { visitor: { visitorId: "visitor-1" } };
    const session = { session: { sessionId: "session-1" } };
    vi.mocked(queryVisitorDetailFromD1).mockResolvedValue(visitor as never);
    vi.mocked(querySessionDetailFromD1).mockResolvedValue(session as never);

    await expect(
      readSiteVisitorDetail({ ...base, visitorId: "visitor-1" }),
    ).resolves.toEqual(visitor);
    await expect(
      readSiteSessionDetail({ ...base, sessionId: "session-1" }),
    ).resolves.toEqual(session);
    expect(queryVisitorDetailFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      "visitor-1",
      "UTC",
      base.window,
    );
    expect(querySessionDetailFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      "session-1",
      base.window,
    );
  });

  it("does not expose an ID that is absent from the requested window", async () => {
    vi.mocked(queryVisitorDetailFromD1).mockResolvedValue(null);
    vi.mocked(querySessionDetailFromD1).mockResolvedValue(null);

    await expect(
      readSiteVisitorDetail({ ...base, visitorId: "visitor-outside" }),
    ).rejects.toThrow("resource-not-found");
    await expect(
      readSiteSessionDetail({ ...base, sessionId: "session-outside" }),
    ).rejects.toThrow("resource-not-found");
  });

  it("preserves reader failures for the application boundary", async () => {
    vi.mocked(queryVisitorDetailFromD1).mockRejectedValueOnce(
      new Error("down"),
    );
    await expect(
      readSiteVisitorDetail({ ...base, visitorId: "visitor-1" }),
    ).rejects.toThrow("down");
    vi.mocked(querySessionDetailFromD1).mockRejectedValueOnce(
      new Error("down"),
    );
    await expect(
      readSiteSessionDetail({ ...base, sessionId: "session-1" }),
    ).rejects.toThrow("down");
  });

  it("signs visitor and session keyset cursors against their typed query", async () => {
    vi.mocked(queryVisitorListPageFromD1).mockResolvedValue({
      rows: [],
      nextCursor: {
        sortKey: "lastSeenAt",
        sortDirection: "desc",
        sortValue: 19,
        lastSeenAt: 19,
        visitorId: "visitor-1",
      },
    });
    vi.mocked(querySessionListPageFromD1).mockResolvedValue({
      rows: [],
      nextCursor: {
        sortKey: "startedAt",
        sortDirection: "desc",
        sortValue: 19,
        startedAt: 19,
        sessionId: "session-1",
      },
    });
    vi.mocked(serializeVisitorListCursor).mockReturnValue("visitor-inner");
    vi.mocked(serializeSessionListCursor).mockReturnValue("session-inner");
    const cursorEnv = { MAIN_SECRET: "cursor-secret" } as never;

    const visitors = await readSiteVisitors({
      ...base,
      env: cursorEnv,
      filters: { version: 1, root: null },
      sort: { field: "lastSeenAt", direction: "desc" },
      page: { limit: 20 },
    });
    const sessions = await readSiteSessions({
      ...base,
      env: cursorEnv,
      filters: { version: 1, root: null },
      sort: { field: "startedAt", direction: "desc" },
      page: { limit: 20 },
    });
    expect(visitors.page).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(sessions.page).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(queryVisitorListPageFromD1).toHaveBeenCalledWith(
      cursorEnv,
      "site-1",
      base.window,
      { version: 1, root: null },
      expect.objectContaining({ pageSize: 20, cursor: null }),
    );
    expect(querySessionListPageFromD1).toHaveBeenCalledWith(
      cursorEnv,
      "site-1",
      base.window,
      { version: 1, root: null },
      expect.objectContaining({ pageSize: 20, cursor: null }),
    );

    vi.mocked(parseVisitorListCursor).mockReturnValue({
      sortKey: "lastSeenAt",
      sortDirection: "desc",
      sortValue: 19,
      lastSeenAt: 19,
      visitorId: "visitor-1",
    });
    vi.mocked(parseSessionListCursor).mockReturnValue({
      sortKey: "startedAt",
      sortDirection: "desc",
      sortValue: 19,
      startedAt: 19,
      sessionId: "session-1",
    });
    vi.mocked(queryVisitorListPageFromD1).mockResolvedValueOnce({
      rows: [],
      nextCursor: null,
    });
    vi.mocked(querySessionListPageFromD1).mockResolvedValueOnce({
      rows: [],
      nextCursor: null,
    });
    await expect(
      readSiteVisitors({
        ...base,
        env: cursorEnv,
        filters: { version: 1, root: null },
        sort: { field: "lastSeenAt", direction: "desc" },
        page: { limit: 20, cursor: visitors.page.nextCursor },
      }),
    ).resolves.toMatchObject({ page: { hasMore: false } });
    await expect(
      readSiteSessions({
        ...base,
        env: cursorEnv,
        filters: { version: 1, root: null },
        sort: { field: "startedAt", direction: "desc" },
        page: { limit: 20, cursor: sessions.page.nextCursor },
      }),
    ).resolves.toMatchObject({ page: { hasMore: false } });
    expect(parseVisitorListCursor).toHaveBeenCalledWith("visitor-inner", {
      key: "lastSeenAt",
      direction: "desc",
    });
    expect(parseSessionListCursor).toHaveBeenCalledWith("session-inner", {
      key: "startedAt",
      direction: "desc",
    });
  });

  it("rejects a malformed search cursor before the D1 reader", async () => {
    await expect(
      readSiteVisitors({
        ...base,
        env: { MAIN_SECRET: "cursor-secret" } as never,
        filters: { version: 1, root: null },
        sort: { field: "lastSeenAt", direction: "desc" },
        page: { limit: 20, cursor: "bad" },
      }),
    ).rejects.toThrow("invalid-cursor");
    expect(queryVisitorListPageFromD1).not.toHaveBeenCalled();
  });

  it("accepts DAILY_SALT_SECRET as the existing deployment root", async () => {
    vi.mocked(queryVisitorListPageFromD1).mockResolvedValue({
      rows: [],
      nextCursor: null,
    });

    await expect(
      readSiteVisitors({
        ...base,
        env: { DAILY_SALT_SECRET: "legacy-root" } as never,
        filters: { version: 1, root: null },
        sort: { field: "lastSeenAt", direction: "desc" },
        page: { limit: 20 },
      }),
    ).resolves.toMatchObject({ page: { hasMore: false, nextCursor: null } });
  });

  it("checks the opaque target after receiving canonical filters", async () => {
    await expect(
      readSiteVisitorEvents({
        ...base,
        visitorId: "visitor-1",
        limit: 20,
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "not-a-public-field" as never },
            operator: "eq",
            value: "x",
          },
        },
        page: { limit: 20 },
      }),
    ).rejects.toThrow("resource-not-found");
    expect(queryJourneyTargetExistsFromD1).toHaveBeenCalled();
  });

  it("enforces target presence in the requested half-open window", async () => {
    vi.mocked(queryJourneyTargetExistsFromD1).mockResolvedValue(false);
    await expect(
      readSiteSessionEvents({
        ...base,
        sessionId: "outside-window",
        limit: 20,
        filters: { version: 1, root: null },
        page: { limit: 20 },
      }),
    ).rejects.toThrow("resource-not-found");
    expect(queryJourneyEventsFromD1).not.toHaveBeenCalled();
  });

  it("reads all journey trajectories with the requested target and limit", async () => {
    vi.mocked(queryJourneyTargetExistsFromD1).mockResolvedValue(true);
    vi.mocked(queryJourneyEventsFromD1).mockResolvedValue([]);
    vi.mocked(querySessionsFromD1).mockResolvedValue([]);
    const common = {
      ...base,
      filters: { version: 1 as const, root: null },
      page: { limit: 50 },
      limit: 50,
    };

    await expect(
      readSiteVisitorEvents({ ...common, visitorId: "visitor-1" }),
    ).resolves.toEqual({ items: [] });
    await expect(
      readSiteSessionEvents({ ...common, sessionId: "session-1" }),
    ).resolves.toEqual({ items: [] });
    await expect(
      readSiteVisitorSessions({ ...common, visitorId: "visitor-1" }),
    ).resolves.toEqual({ items: [] });

    expect(queryJourneyTargetExistsFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      { type: "visitor", value: "visitor-1" },
      base.window,
    );
    expect(queryJourneyTargetExistsFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      { type: "session", value: "session-1" },
      base.window,
    );
    expect(queryJourneyEventsFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      { version: 1, root: null },
      { type: "visitor", value: "visitor-1" },
      50,
    );
    expect(queryJourneyEventsFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      { version: 1, root: null },
      { type: "session", value: "session-1" },
      50,
    );
    expect(querySessionsFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      { version: 1, root: null },
      50,
      { type: "visitor", value: "visitor-1" },
    );
  });
});
