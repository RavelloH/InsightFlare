import { describe, expect, it, vi } from "vitest";

import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  parseSessionListCursor,
  parseVisitorListCursor,
  queryJourneyEventsPageFromD1,
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  queryVisitorsFromD1,
  serializeSessionListCursor,
  serializeVisitorListCursor,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import type { Env } from "@/lib/edge/types";

import { filterFixture } from "./filter-fixtures";

type QueryBinding = string | number | null;

function createD1Env(resultSets: Record<string, unknown>[][]): {
  env: Env;
  calls: Array<{ sql: string; bindings: QueryBinding[] }>;
} {
  const calls: Array<{ sql: string; bindings: QueryBinding[] }> = [];
  const pendingResults = [...resultSets];
  return {
    env: {
      DB: {
        prepare(sql: string) {
          return {
            bind(...bindings: QueryBinding[]) {
              return {
                all: vi.fn(async () => {
                  calls.push({ sql, bindings });
                  return { results: pendingResults.shift() ?? [] };
                }),
              };
            },
          };
        },
      } as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    } as Env,
    calls,
  };
}

const siteId = "journey-list-lowlevel";
const window = createQueryTime(0, 100, "UTC", 100);
const queryWindow = {
  startMs: window.range.startMs,
  endExclusiveMs: window.range.endExclusiveMs,
  nowMs: window.capturedAtMs,
  timeZone: window.reportingTimeZone,
};

const visitorRow = {
  visitorId: "visitor-1",
  sessionId: "session-1",
  firstSeenAt: 10,
  lastSeenAt: 20,
  views: 3,
  sessions: 1,
  events: 2,
};

const sessionRow = {
  sessionId: "session-1",
  visitorId: "visitor-1",
  startedAt: 10,
  endedAt: 20,
  totalDurationMs: 10,
  views: 3,
  events: 2,
};

const journeyRow = {
  id: "event-1",
  kind: "custom",
  eventType: "signup",
  occurredAt: 20,
  visitId: "visit-1",
  sessionId: "session-1",
  visitorId: "visitor-1",
};

function scopedFilters() {
  return prepareScopedQuery("overview", {
    context: siteQueryContext(siteId, "private-dashboard"),
    time: window,
    filters: filterFixture({ path: "/docs" }),
    scopePreference: "visitor",
  } as never).filters!;
}

describe("D1 journey list low-level query coverage", () => {
  it("covers visitor list filters, search, targets, cursors, and scoped datasets", async () => {
    const first = createD1Env([[visitorRow]]);
    await expect(
      queryVisitorsFromD1(
        first.env,
        siteId,
        queryWindow,
        EMPTY_FILTER_DOCUMENT,
        5,
      ),
    ).resolves.toHaveLength(1);

    const filtered = createD1Env([[visitorRow]]);
    await queryVisitorsFromD1(
      filtered.env,
      siteId,
      queryWindow,
      filterFixture({ country: "US" }),
      3,
      "visitor-1",
      2,
      { key: "sessions", direction: "asc" },
      "Chrome%",
    );
    expect(filtered.calls[0].sql).toContain("matched_visitors AS");
    expect(filtered.calls[0].sql).toContain("visitor_id = ?");

    const scoped = createD1Env([[visitorRow]]);
    await queryVisitorsFromD1(
      scoped.env,
      siteId,
      queryWindow,
      scopedFilters(),
      3,
      "visitor-1",
      0,
      { key: "lastSeenAt", direction: "desc" },
    );
    expect(scoped.calls[0].sql).toContain("scope_final_visits");

    const page = createD1Env([
      [visitorRow, { ...visitorRow, visitorId: "visitor-2" }],
    ]);
    await expect(
      queryVisitorListPageFromD1(
        page.env,
        siteId,
        queryWindow,
        EMPTY_FILTER_DOCUMENT,
        {
          pageSize: 1,
          sort: { key: "lastSeenAt", direction: "asc" },
          cursor: {
            sortKey: "lastSeenAt",
            sortDirection: "asc",
            sortValue: 20,
            lastSeenAt: 20,
            visitorId: "visitor-0",
          },
        },
      ),
    ).resolves.toMatchObject({
      rows: [{ visitorId: "visitor-1" }],
      nextCursor: expect.anything(),
    });
    expect(page.calls[0].sql).toContain("vm.lastSeenAt >");

    const searched = createD1Env([[]]);
    await queryVisitorListPageFromD1(
      searched.env,
      siteId,
      queryWindow,
      filterFixture({ path: "/docs" }),
      {
        pageSize: 2,
        sort: { key: "views", direction: "desc" },
        search: "docs",
      },
    );
    expect(searched.calls[0].sql).toContain("matched_visitors AS");

    const scopedPage = createD1Env([[]]);
    await queryVisitorListPageFromD1(
      scopedPage.env,
      siteId,
      queryWindow,
      scopedFilters(),
      { pageSize: 2, sort: { key: "firstSeenAt", direction: "desc" } },
    );
    expect(scopedPage.calls[0].sql).toContain("scope_final_visits");
  });

  it("covers session list target variants, duration cursors, searches, and scope", async () => {
    const visitorTarget = createD1Env([[sessionRow]]);
    await querySessionsFromD1(
      visitorTarget.env,
      siteId,
      queryWindow,
      EMPTY_FILTER_DOCUMENT,
      3,
      { type: "visitor", value: "visitor-1" },
      0,
      { key: "startedAt", direction: "asc" },
    );
    expect(visitorTarget.calls[0].sql).toContain("visitor_id = ?");

    const sessionTarget = createD1Env([[sessionRow]]);
    await querySessionsFromD1(
      sessionTarget.env,
      siteId,
      queryWindow,
      filterFixture({ browser: "Chrome" }),
      3,
      { type: "session", value: "session-1" },
      1,
      { key: "durationMs", direction: "desc" },
      "Chrome",
    );
    expect(sessionTarget.calls[0].sql).toContain("matched_sessions AS");
    expect(sessionTarget.calls[0].sql).toContain("session_id = ?");

    const scoped = createD1Env([[sessionRow]]);
    await querySessionsFromD1(
      scoped.env,
      siteId,
      queryWindow,
      scopedFilters(),
      3,
      undefined,
      0,
      { key: "views", direction: "desc" },
    );
    expect(scoped.calls[0].sql).toContain("scope_final_visits");

    const page = createD1Env([
      [sessionRow, { ...sessionRow, sessionId: "session-2" }],
    ]);
    await expect(
      querySessionListPageFromD1(
        page.env,
        siteId,
        queryWindow,
        EMPTY_FILTER_DOCUMENT,
        {
          pageSize: 1,
          sort: { key: "durationMs", direction: "asc" },
          cursor: {
            sortKey: "durationMs",
            sortDirection: "asc",
            sortValue: 10,
            startedAt: 10,
            sessionId: "session-0",
          },
          target: { type: "session", value: "session-1" },
        },
      ),
    ).resolves.toMatchObject({
      rows: [{ sessionId: "session-1" }],
      nextCursor: expect.anything(),
    });
    expect(page.calls[0].sql).toContain("sm.totalDurationMs >");

    const scopedPage = createD1Env([[]]);
    await querySessionListPageFromD1(
      scopedPage.env,
      siteId,
      queryWindow,
      scopedFilters(),
      {
        pageSize: 2,
        sort: { key: "startedAt", direction: "desc" },
        target: { type: "visitor", value: "visitor-1" },
        search: "session",
      },
    );
    expect(scopedPage.calls[0].sql).toContain("scope_final_visits");
    expect(scopedPage.calls[0].bindings).toContain("visitor-1");
  });

  it("covers journey event pages for both targets, scopes, cursors, and result states", async () => {
    const visitor = createD1Env([
      [journeyRow, { ...journeyRow, id: "event-2", occurredAt: 10 }],
    ]);
    await expect(
      queryJourneyEventsPageFromD1(
        visitor.env,
        siteId,
        queryWindow,
        filterFixture({ path: "/docs" }),
        { type: "visitor", value: "visitor-1" },
        1,
        { occurredAt: 30, id: "event-3" },
      ),
    ).resolves.toMatchObject({
      items: [{ id: "event-1" }],
      pagination: {
        hasMore: true,
        nextCursor: { occurredAt: 20, id: "event-1" },
      },
    });
    expect(visitor.calls[0].sql).toContain("visitor_id = ?");
    expect(visitor.calls[0].sql).toContain("occurredAt < ?");

    const session = createD1Env([[]]);
    await expect(
      queryJourneyEventsPageFromD1(
        session.env,
        siteId,
        queryWindow,
        scopedFilters(),
        { type: "session", value: "session-1" },
        5,
      ),
    ).resolves.toMatchObject({
      items: [],
      pagination: { hasMore: false, nextCursor: null },
    });
    expect(session.calls[0].sql).toContain("scope_final_events");
    expect(session.calls[0].sql).toContain("session_id");
  });

  it("parses and rejects visitor and session cursors against their sort contracts", () => {
    const visitor = serializeVisitorListCursor({
      sortKey: "views",
      sortDirection: "desc",
      sortValue: 3,
      lastSeenAt: 20,
      visitorId: "visitor-1",
    });
    expect(
      parseVisitorListCursor(visitor, { key: "views", direction: "desc" }),
    ).toMatchObject({
      sortValue: 3,
    });
    expect(
      parseVisitorListCursor(visitor, { key: "views", direction: "asc" }),
    ).toBeNull();
    expect(
      parseVisitorListCursor("not-base64", { key: "views", direction: "desc" }),
    ).toBeNull();

    const session = serializeSessionListCursor({
      sortKey: "startedAt",
      sortDirection: "asc",
      sortValue: 10,
      startedAt: 10,
      sessionId: "session-1",
    });
    expect(
      parseSessionListCursor(session, { key: "startedAt", direction: "asc" }),
    ).toMatchObject({
      sessionId: "session-1",
    });
    expect(
      parseSessionListCursor(session, { key: "durationMs", direction: "asc" }),
    ).toBeNull();
    expect(
      parseSessionListCursor("", { key: "startedAt", direction: "asc" }),
    ).toBeNull();
  });
});
