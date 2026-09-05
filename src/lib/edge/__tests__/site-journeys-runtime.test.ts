import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/journey-detail-queries",
  () => ({
    queryJourneyEventDetailFromD1: vi.fn(),
    queryVisitorDetailFromD1: vi.fn(),
    querySessionDetailFromD1: vi.fn(),
    stripVisitorDetailCollections: vi.fn((detail) => detail),
    stripSessionDetailCollections: vi.fn((detail) => detail),
  }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/journey-list-queries",
  () => ({
    querySessionListPageFromD1: vi.fn(),
    queryJourneyEventsFromD1: vi.fn(),
    queryJourneyEventsPageFromD1: vi.fn(),
    queryJourneyTargetExistsFromD1: vi.fn(),
    querySessionsFromD1: vi.fn(),
    queryVisitorListPageFromD1: vi.fn(),
  }),
);

import {
  queryJourneyEventDetailFromD1,
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-detail-queries";
import {
  queryJourneyEventsFromD1,
  queryJourneyEventsPageFromD1,
  queryJourneyTargetExistsFromD1,
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  readSiteJourneyEventDetail,
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

  it("reads journey event details with the optional event kind", async () => {
    vi.mocked(queryJourneyEventDetailFromD1).mockResolvedValue({
      eventId: "event-1",
      eventKind: "pageview",
      eventName: "Signup",
    } as never);

    await expect(
      readSiteJourneyEventDetail({
        ...base,
        eventId: "event-1",
        eventKind: "pageview",
      }),
    ).resolves.toEqual({
      eventId: "event-1",
      eventKind: "pageview",
      eventName: "Signup",
    });
    expect(queryJourneyEventDetailFromD1).toHaveBeenCalledWith(
      base.env,
      base.siteId,
      "event-1",
      base.window,
      "pageview",
    );

    vi.mocked(queryJourneyEventDetailFromD1).mockResolvedValueOnce(null);
    await expect(
      readSiteJourneyEventDetail({ ...base, eventId: "missing" }),
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
        sortValue: 19,
        visitorId: "visitor-1",
      },
    });
    vi.mocked(querySessionListPageFromD1).mockResolvedValue({
      rows: [],
      nextCursor: {
        sortValue: 19,
        sessionId: "session-1",
      },
    });
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
    expect(visitors.pagination).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(sessions.pagination).toMatchObject({
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(queryVisitorListPageFromD1).toHaveBeenCalledWith(
      cursorEnv,
      "site-1",
      base.window,
      { version: 1, root: null },
      expect.objectContaining({ limit: 20, cursor: null }),
    );
    expect(querySessionListPageFromD1).toHaveBeenCalledWith(
      cursorEnv,
      "site-1",
      base.window,
      { version: 1, root: null },
      expect.objectContaining({ limit: 20, cursor: null }),
    );

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
        page: { limit: 20, cursor: visitors.pagination.nextCursor },
      }),
    ).resolves.toMatchObject({ pagination: { hasMore: false } });
    await expect(
      readSiteSessions({
        ...base,
        env: cursorEnv,
        filters: { version: 1, root: null },
        sort: { field: "startedAt", direction: "desc" },
        page: { limit: 20, cursor: sessions.pagination.nextCursor },
      }),
    ).resolves.toMatchObject({ pagination: { hasMore: false } });
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
    ).resolves.toMatchObject({
      pagination: { hasMore: false, nextCursor: null },
    });
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
    vi.mocked(queryJourneyEventsPageFromD1).mockResolvedValue({
      items: [],
      pagination: {
        limit: 50,
        returned: 0,
        hasMore: false,
        nextCursor: null,
      },
    });
    vi.mocked(querySessionListPageFromD1).mockResolvedValue({
      rows: [],
      nextCursor: null,
    });
    const common = {
      ...base,
      filters: { version: 1 as const, root: null },
      page: { limit: 50 },
      limit: 50,
    };

    await expect(
      readSiteVisitorEvents({ ...common, visitorId: "visitor-1" }),
    ).resolves.toMatchObject({
      items: [],
      pagination: { limit: 50, returned: 0, hasMore: false, nextCursor: null },
    });
    await expect(
      readSiteSessionEvents({ ...common, sessionId: "session-1" }),
    ).resolves.toMatchObject({
      items: [],
      pagination: { limit: 50, returned: 0, hasMore: false, nextCursor: null },
    });
    await expect(
      readSiteVisitorSessions({ ...common, visitorId: "visitor-1" }),
    ).resolves.toMatchObject({
      items: [],
      pagination: { limit: 50, returned: 0, hasMore: false, nextCursor: null },
    });

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
    expect(queryJourneyEventsPageFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      { version: 1, root: null },
      { type: "visitor", value: "visitor-1" },
      50,
      null,
    );
    expect(queryJourneyEventsPageFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      { version: 1, root: null },
      { type: "session", value: "session-1" },
      50,
      null,
    );
    expect(querySessionListPageFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      { version: 1, root: null },
      expect.objectContaining({
        limit: 50,
        cursor: null,
        target: { type: "visitor", value: "visitor-1" },
      }),
    );
  });
});
