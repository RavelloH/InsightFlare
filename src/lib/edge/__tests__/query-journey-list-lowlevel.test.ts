import { describe, expect, it, vi } from "vitest";

import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  querySessionListPageFromD1 as querySessionListPageFromParentOracle,
  queryVisitorListPageFromD1 as queryVisitorListPageFromParentOracle,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-oracle";
import {
  queryJourneyEventsPageFromD1,
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  queryVisitorsFromD1,
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

function expectQueryBudget(call: {
  readonly sql: string;
  readonly bindings: readonly QueryBinding[];
}) {
  expect(call.bindings.length).toBeLessThanOrEqual(100);
  expect(new TextEncoder().encode(call.sql).length).toBeLessThanOrEqual(
    100_000,
  );
  expect(call.sql).toContain("LIMIT");
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
  it("freezes complete Wave69 parent DTO and query assembly before migration", async () => {
    const funnel = {
      filterDslVersion: 1 as const,
      progressionScope: "visitor" as const,
      conversionWindowMs: 86_400_000,
      steps: [
        { id: "landing", filterDsl: 'page.path eq "/landing"' },
        { id: "signup", filterDsl: 'event.name eq "signup"' },
      ],
    };
    const cases = [
      {
        name: "visitor direct default",
        row: visitorRow,
        run: (env: Env, query: typeof queryVisitorListPageFromD1) =>
          query(env, siteId, queryWindow, EMPTY_FILTER_DOCUMENT, {
            limit: 5,
            sort: { key: "lastSeenAt", direction: "desc" },
          }),
      },
      {
        name: "visitor direct filter search cursor",
        row: visitorRow,
        run: (env: Env, query: typeof queryVisitorListPageFromD1) =>
          query(env, siteId, queryWindow, filterFixture({ path: "/docs" }), {
            limit: 2,
            sort: { key: "views", direction: "asc" },
            search: "Docs%_\\\\",
            cursor: { sortValue: 3, lastSeenAt: 20, visitorId: "visitor-0" },
          }),
      },
      {
        name: "visitor prepared scope",
        row: visitorRow,
        run: (env: Env, query: typeof queryVisitorListPageFromD1) =>
          query(env, siteId, queryWindow, scopedFilters(), {
            limit: 3,
            sort: { key: "firstSeenAt", direction: "asc" },
          }),
      },
      {
        name: "visitor goal analysis with global filter",
        row: visitorRow,
        run: (env: Env, query: typeof queryVisitorListPageFromD1) =>
          query(env, siteId, queryWindow, filterFixture({ country: "US" }), {
            limit: 4,
            sort: { key: "sessions", direction: "desc" },
            analysis: {
              type: "goal",
              filter: filterFixture({ path: "/docs" }),
            },
          }),
      },
      {
        name: "visitor funnel analysis",
        row: visitorRow,
        run: (env: Env, query: typeof queryVisitorListPageFromD1) =>
          query(env, siteId, queryWindow, EMPTY_FILTER_DOCUMENT, {
            limit: 4,
            sort: { key: "lastSeenAt", direction: "desc" },
            analysis: { type: "funnel", config: funnel, stepIndex: 1 },
          }),
      },
      {
        name: "session direct target filter search cursor",
        row: sessionRow,
        run: (env: Env, query: typeof querySessionListPageFromD1) =>
          query(
            env,
            siteId,
            queryWindow,
            filterFixture({ browser: "Chrome" }),
            {
              limit: 2,
              sort: { key: "durationMs", direction: "asc" },
              target: { type: "session", value: "session-1" },
              search: "Chrome%_\\\\",
              cursor: { sortValue: 10, startedAt: 10, sessionId: "session-0" },
            },
          ),
      },
      {
        name: "session prepared scope",
        row: sessionRow,
        run: (env: Env, query: typeof querySessionListPageFromD1) =>
          query(env, siteId, queryWindow, scopedFilters(), {
            limit: 3,
            sort: { key: "views", direction: "desc" },
            target: { type: "visitor", value: "visitor-1" },
          }),
      },
      {
        name: "session goal analysis",
        row: sessionRow,
        run: (env: Env, query: typeof querySessionListPageFromD1) =>
          query(env, siteId, queryWindow, EMPTY_FILTER_DOCUMENT, {
            limit: 4,
            sort: { key: "startedAt", direction: "desc" },
            analysis: {
              type: "goal",
              filter: filterFixture({ path: "/docs" }),
            },
          }),
      },
      {
        name: "session funnel analysis",
        row: sessionRow,
        run: (env: Env, query: typeof querySessionListPageFromD1) =>
          query(env, siteId, queryWindow, EMPTY_FILTER_DOCUMENT, {
            limit: 4,
            sort: { key: "startedAt", direction: "desc" },
            analysis: {
              type: "funnel",
              config: {
                ...funnel,
                progressionScope: "session",
                conversionWindowMs: null,
              },
              stepIndex: 1,
            },
          }),
      },
    ];

    for (const item of cases) {
      const actual = createD1Env([[item.row]]);
      const parent = createD1Env([[item.row]]);
      const actualQuery = item.run as (
        env: Env,
        query:
          typeof queryVisitorListPageFromD1 | typeof querySessionListPageFromD1,
      ) => Promise<unknown>;
      const query = item.name.startsWith("visitor")
        ? queryVisitorListPageFromD1
        : querySessionListPageFromD1;
      const oracle = item.name.startsWith("visitor")
        ? queryVisitorListPageFromParentOracle
        : querySessionListPageFromParentOracle;

      await expect(actualQuery(actual.env, query)).resolves.toEqual(
        await actualQuery(parent.env, oracle),
      );
      expect(actual.calls, item.name).toHaveLength(1);
      expect(parent.calls, item.name).toHaveLength(1);
      expectQueryBudget(actual.calls[0]!);
      expectQueryBudget(parent.calls[0]!);
    }
  });

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
      { key: "sessions", direction: "asc" },
      "Chrome%",
    );
    expectQueryBudget(filtered.calls[0]!);
    expectQueryBudget(filtered.calls[0]!);

    const scoped = createD1Env([[visitorRow]]);
    await queryVisitorsFromD1(
      scoped.env,
      siteId,
      queryWindow,
      scopedFilters(),
      3,
      "visitor-1",
      { key: "lastSeenAt", direction: "desc" },
    );
    expectQueryBudget(scoped.calls[0]!);

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
          limit: 1,
          sort: { key: "lastSeenAt", direction: "asc" },
          cursor: {
            sortValue: 20,
            visitorId: "visitor-0",
          },
        },
      ),
    ).resolves.toMatchObject({
      rows: [{ visitorId: "visitor-1" }],
      nextCursor: expect.anything(),
    });
    expectQueryBudget(page.calls[0]!);

    const searched = createD1Env([[]]);
    await queryVisitorListPageFromD1(
      searched.env,
      siteId,
      queryWindow,
      filterFixture({ path: "/docs" }),
      {
        limit: 2,
        sort: { key: "views", direction: "desc" },
        search: "docs",
      },
    );
    expectQueryBudget(searched.calls[0]!);

    const scopedPage = createD1Env([[]]);
    await queryVisitorListPageFromD1(
      scopedPage.env,
      siteId,
      queryWindow,
      scopedFilters(),
      { limit: 2, sort: { key: "firstSeenAt", direction: "desc" } },
    );
    expectQueryBudget(scopedPage.calls[0]!);
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
      { key: "startedAt", direction: "asc" },
    );
    expectQueryBudget(visitorTarget.calls[0]!);

    const sessionTarget = createD1Env([[sessionRow]]);
    await querySessionsFromD1(
      sessionTarget.env,
      siteId,
      queryWindow,
      filterFixture({ browser: "Chrome" }),
      3,
      { type: "session", value: "session-1" },
      { key: "durationMs", direction: "desc" },
      "Chrome",
    );
    expectQueryBudget(sessionTarget.calls[0]!);
    expectQueryBudget(sessionTarget.calls[0]!);

    const scoped = createD1Env([[sessionRow]]);
    await querySessionsFromD1(
      scoped.env,
      siteId,
      queryWindow,
      scopedFilters(),
      3,
      undefined,
      { key: "views", direction: "desc" },
    );
    expectQueryBudget(scoped.calls[0]!);

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
          limit: 1,
          sort: { key: "durationMs", direction: "asc" },
          cursor: {
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
    expectQueryBudget(page.calls[0]!);

    const scopedPage = createD1Env([[]]);
    await querySessionListPageFromD1(
      scopedPage.env,
      siteId,
      queryWindow,
      scopedFilters(),
      {
        limit: 2,
        sort: { key: "startedAt", direction: "desc" },
        target: { type: "visitor", value: "visitor-1" },
        search: "session",
      },
    );
    expectQueryBudget(scopedPage.calls[0]!);
    expect(scopedPage.calls[0].bindings).toContain("visitor-1");
  });

  it("covers goal and funnel analysis datasets for visitor and session lists", async () => {
    const goalFilter = filterFixture({ path: "/docs" });

    const goalVisitors = createD1Env([[visitorRow]]);
    await expect(
      queryVisitorListPageFromD1(
        goalVisitors.env,
        siteId,
        queryWindow,
        EMPTY_FILTER_DOCUMENT,
        {
          limit: 5,
          sort: { key: "lastSeenAt", direction: "desc" },
          analysis: { type: "goal", filter: goalFilter },
        },
      ),
    ).resolves.toMatchObject({ rows: [{ visitorId: "visitor-1" }] });
    expectQueryBudget(goalVisitors.calls[0]!);

    const goalVisitorsWithGlobalFilter = createD1Env([[visitorRow]]);
    await queryVisitorListPageFromD1(
      goalVisitorsWithGlobalFilter.env,
      siteId,
      queryWindow,
      filterFixture({ country: "US" }),
      {
        limit: 5,
        sort: { key: "lastSeenAt", direction: "desc" },
        analysis: { type: "goal", filter: goalFilter },
      },
    );
    expectQueryBudget(goalVisitorsWithGlobalFilter.calls[0]!);

    const goalSessions = createD1Env([[sessionRow]]);
    await querySessionListPageFromD1(
      goalSessions.env,
      siteId,
      queryWindow,
      EMPTY_FILTER_DOCUMENT,
      {
        limit: 5,
        sort: { key: "startedAt", direction: "desc" },
        analysis: { type: "goal", filter: goalFilter },
      },
    );
    expectQueryBudget(goalSessions.calls[0]!);

    const funnel = {
      filterDslVersion: 1 as const,
      progressionScope: "visitor" as const,
      conversionWindowMs: 86_400_000,
      steps: [
        { id: "landing", filterDsl: 'page.path eq "/landing"' },
        { id: "signup", filterDsl: 'event.name eq "signup"' },
      ],
    };
    const funnelVisitors = createD1Env([[visitorRow]]);
    await queryVisitorListPageFromD1(
      funnelVisitors.env,
      siteId,
      queryWindow,
      EMPTY_FILTER_DOCUMENT,
      {
        limit: 5,
        sort: { key: "lastSeenAt", direction: "desc" },
        analysis: { type: "funnel", config: funnel, stepIndex: 1 },
      },
    );
    expectQueryBudget(funnelVisitors.calls[0]!);

    const sessionFunnel = {
      ...funnel,
      progressionScope: "session" as const,
      conversionWindowMs: null,
    };
    const funnelSessions = createD1Env([[sessionRow]]);
    await querySessionListPageFromD1(
      funnelSessions.env,
      siteId,
      queryWindow,
      EMPTY_FILTER_DOCUMENT,
      {
        limit: 5,
        sort: { key: "startedAt", direction: "desc" },
        analysis: {
          type: "funnel",
          config: sessionFunnel,
          stepIndex: 1,
        },
      },
    );
    expectQueryBudget(funnelSessions.calls[0]!);
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
    expect(visitor.calls).toHaveLength(1);
    expect(visitor.calls[0].bindings).toEqual(
      expect.arrayContaining(["visitor-1", 30, "event-3"]),
    );

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
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0].bindings).toContain("session-1");
  });
});
