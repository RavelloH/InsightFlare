import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  lowerLogicalPlan,
} from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  DEFAULT_SESSION_LIST_SORT,
  DEFAULT_VISITOR_LIST_SORT,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  buildJourneySessionListReportPlan,
  buildJourneyVisitorListReportPlan,
  JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  querySessionListPageFromD1 as querySessionListParentOracle,
  queryVisitorListPageFromD1 as queryVisitorListParentOracle,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-oracle";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  querySessionListPageFromD1,
  queryVisitorListPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const window = {
  startMs: 1_700_000_000_000,
  endExclusiveMs: 1_700_086_400_000,
  nowMs: 1_700_086_400_000,
  timeZone: "UTC",
} as const;

function compileOutput(plan: ValidatedLogicalPlan, outputId: string) {
  const output = plan.outputs.find((candidate) => candidate.id === outputId);
  if (!output) throw new Error(`missing_output:${outputId}`);
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: plan.context.subject.siteIds[0]!,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const physical = lowerLogicalPlan(relation);
  return compileD1Query(physical);
}

describe("Journey entity list Logical report plans", () => {
  it("builds a single typed visitor and session page statement", () => {
    const visitor = buildJourneyVisitorListReportPlan({
      siteId: "journey-list-site",
      window,
      filters: EMPTY_FILTER_DOCUMENT,
      limit: 20,
      sort: DEFAULT_VISITOR_LIST_SORT,
    });
    const session = buildJourneySessionListReportPlan({
      siteId: "journey-list-site",
      window,
      filters: EMPTY_FILTER_DOCUMENT,
      limit: 20,
      sort: DEFAULT_SESSION_LIST_SORT,
    });

    const visitorQuery = compileOutput(
      visitor,
      JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
    );
    const sessionQuery = compileOutput(
      session,
      JOURNEY_SESSION_LIST_REPORT_OUTPUT,
    );
    for (const query of [visitorQuery, sessionQuery]) {
      expect(query.sql).toContain("LIMIT");
      expect(query.bindings?.length ?? 0).toBeLessThanOrEqual(100);
      expect(new TextEncoder().encode(query.sql).length).toBeLessThanOrEqual(
        100_000,
      );
    }
  });

  it.each(["visitor", "session"] as const)(
    "keeps the worst 12-step %s query plan within D1 budgets",
    (scope) => {
      const siteId = "journey-list-site";
      const sourceFilter = parseFilterDsl(
        "session.views gte 2",
        analyticsFilterRegistry,
      );
      const scoped = createScopedFilterPlan(
        "goal-summary",
        sourceFilter,
        "session",
      );
      expect(scoped).not.toBeNull();
      if (!scoped) throw new Error("Expected prepared Session filter plan.");
      const filters = attachScopedFilterMetadata(sourceFilter, {
        requestedScope: "session",
        resolvedScope: scoped.scope,
        plan: scoped,
        time: createQueryTime(
          window.startMs,
          window.endExclusiveMs,
          window.timeZone,
          window.nowMs,
        ),
        siteIds: [siteId],
      });
      const analysis = {
        type: "funnel" as const,
        stepIndex: 11,
        outcome: "converted" as const,
        config: {
          filterDslVersion: 1 as const,
          progressionScope: "visitor" as const,
          conversionWindowMs: 86_400_000,
          steps: Array.from({ length: 12 }, (_unused, index) => ({
            id: `history-${index}`,
            filterDsl: `page.path contains "/history-${index}"`,
          })),
        },
      };
      const query =
        scope === "visitor"
          ? compileOutput(
              buildJourneyVisitorListReportPlan({
                siteId,
                window,
                filters,
                limit: 20,
                sort: DEFAULT_VISITOR_LIST_SORT,
                search: "  browser os version /history  ",
                analysis,
              }),
              JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
            )
          : compileOutput(
              buildJourneySessionListReportPlan({
                siteId,
                window,
                filters,
                limit: 20,
                sort: { key: "durationMs", direction: "asc" },
                cursor: {
                  sortValue: 100,
                  startedAt: window.startMs + 1,
                  sessionId: "s-fixture",
                },
                sessionTarget: { type: "visitor", value: "fixture-visitor" },
                search: "  browser os version /history  ",
                analysis,
              }),
              JOURNEY_SESSION_LIST_REPORT_OUTPUT,
            );

      expect(
        new TextEncoder().encode(query.sql).byteLength,
        `${scope} SQL bytes`,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(
        query.bindings?.length ?? 0,
        `${scope} bindings`,
      ).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(query.physicalPlanShape).toBeDefined();
    },
  );

  it("matches the parent Session DTO for two Event-only observations with owner coordinates", async () => {
    const database = createMigratedDatabase();
    const siteId = "journey-list-site";
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    try {
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(siteId);
      const site = database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId) as { readonly site_pk: number };
      const sitePk = Number(site.site_pk);
      const ownerStartedAt = window.startMs - 1;
      database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, site_pk, visitor_id, session_id, status,
            started_at, last_activity_at, pathname, hostname, latitude,
            longitude, user_id, user_name, browser, browser_version, os,
            os_version, device_type
          ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "event-only-owner",
          siteId,
          sitePk,
          "event-only-visitor",
          "event-only-session",
          ownerStartedAt,
          ownerStartedAt,
          "/owner-path",
          "owner.example.test",
          37.77,
          -122.42,
          "event-user",
          "Event User",
          "Firefox",
          "132.0",
          "Linux",
          "6.1",
          "desktop",
        );
      database
        .prepare(
          `INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk)
           VALUES (?, ?, ?, ?)`,
        )
        .run(siteId, "signup", window.startMs + 2_000, sitePk);
      const eventName = database
        .prepare(
          "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
        )
        .get(sitePk, "signup") as { readonly id: number };
      const insertEvent = database.prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      );
      for (const [eventId, occurredAt, sequence] of [
        ["event-only-signup-1", window.startMs + 1_000, 1],
        ["event-only-signup-2", window.startMs + 2_000, 2],
      ] as const) {
        insertEvent.run(
          eventId,
          siteId,
          sitePk,
          "event-only-owner",
          Number(eventName.id),
          occurredAt,
          occurredAt,
          sequence,
        );
      }

      const time = createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        window.timeZone,
        window.nowMs,
      );
      const preparedResult = prepareScopedQuery("sessions", {
        context: siteQueryContext(siteId, "private-dashboard"),
        time,
        filters: parseFilterDsl(
          'event.name eq "signup"',
          analyticsFilterRegistry,
        ),
        scopePreference: "session",
      } as never) as { readonly filters?: FilterDocument };
      if (!preparedResult.filters)
        throw new Error("journey_list_event_filter_prepare_failed");
      const filters = preparedResult.filters;
      const env = {
        DB: createSqliteD1Database(database, trace),
      } as unknown as Env;
      const options = { limit: 10, sort: DEFAULT_SESSION_LIST_SORT };
      const parent = await querySessionListParentOracle(
        env,
        siteId,
        window,
        filters,
        options,
      );
      expect(parent.rows).toHaveLength(1);
      expect(parent.rows[0]).toMatchObject({
        sessionId: "event-only-session",
        visitorId: "event-only-visitor",
        views: 0,
        events: 2,
        bounce: false,
        latitude: null,
        longitude: null,
      });
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;

      const actual = await querySessionListPageFromD1(
        env,
        siteId,
        window,
        filters,
        options,
      );
      expect(actual).toEqual(parent);
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.bindings).toHaveLength(1);
      for (const limit of [0, -1, -2]) {
        trace.preparedSql.length = 0;
        trace.bindings.length = 0;
        const limitOptions = { limit, sort: DEFAULT_SESSION_LIST_SORT };
        const expected = await querySessionListParentOracle(
          env,
          siteId,
          window,
          filters,
          limitOptions,
        );
        const actualLimitPage = await querySessionListPageFromD1(
          env,
          siteId,
          window,
          filters,
          limitOptions,
        );
        expect(actualLimitPage).toEqual(expected);
        expect(trace.preparedSql).toHaveLength(2);
      }
      trace.preparedSql.length = 0;
      await expect(
        querySessionListPageFromD1(env, siteId, window, filters, {
          limit: -1.5,
          sort: DEFAULT_SESSION_LIST_SORT,
        }),
      ).rejects.toThrow();
      expect(trace.preparedSql).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("preserves browser major DTOs while searching raw multi-part versions", async () => {
    const database = createMigratedDatabase();
    const siteId = "journey-list-browser-site";
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const fixtures = [
      { key: "dotted", version: "132.0.6213.0" },
      { key: "multi-dot", version: "7..1" },
      { key: "empty", version: "" },
    ] as const;
    try {
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(siteId);
      const site = database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId) as { readonly site_pk: number };
      const sitePk = Number(site.site_pk);
      const insertVisit = database.prepare(
        `INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, hostname, latitude,
          longitude, user_id, user_name, browser, browser_version, os,
          os_version, device_type
        ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      );
      fixtures.forEach(({ key, version }, index) => {
        const visitId = `browser-${key}`;
        const occurredAt = window.startMs + index * 1_000;
        insertVisit.run(
          visitId,
          siteId,
          sitePk,
          `visitor-${key}`,
          `session-${key}`,
          occurredAt,
          occurredAt,
          `/browser-${key}`,
          "browser.test",
          "",
          "",
          "Firefox",
          version,
          "Linux",
          "",
          "desktop",
        );
      });
      const env = {
        DB: createSqliteD1Database(database, trace),
      } as unknown as Env;

      const [expectedVisitors, actualVisitors] = await Promise.all([
        queryVisitorListParentOracle(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          {
            limit: 10,
            sort: DEFAULT_VISITOR_LIST_SORT,
          },
        ),
        queryVisitorListPageFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, {
          limit: 10,
          sort: DEFAULT_VISITOR_LIST_SORT,
        }),
      ]);
      expect(actualVisitors).toEqual(expectedVisitors);
      expect(
        Object.fromEntries(
          actualVisitors.rows.map((row) => [row.visitorId, row.browserVersion]),
        ),
      ).toEqual({
        "visitor-dotted": "132",
        "visitor-multi-dot": "7",
        "visitor-empty": "",
      });

      const [expectedSessions, actualSessions] = await Promise.all([
        querySessionListParentOracle(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          {
            limit: 10,
            sort: DEFAULT_SESSION_LIST_SORT,
          },
        ),
        querySessionListPageFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, {
          limit: 10,
          sort: DEFAULT_SESSION_LIST_SORT,
        }),
      ]);
      expect(actualSessions).toEqual(expectedSessions);
      expect(
        Object.fromEntries(
          actualSessions.rows.map((row) => [row.sessionId, row.browserVersion]),
        ),
      ).toEqual({
        "session-dotted": "132",
        "session-multi-dot": "7",
        "session-empty": "",
      });

      const visitorSearchOptions = {
        limit: 10,
        sort: DEFAULT_VISITOR_LIST_SORT,
        search: "132.0.6213.0",
      } as const;
      const [expectedVisitorSearch, actualVisitorSearch] = await Promise.all([
        queryVisitorListParentOracle(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          visitorSearchOptions,
        ),
        queryVisitorListPageFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          visitorSearchOptions,
        ),
      ]);
      expect(actualVisitorSearch).toEqual(expectedVisitorSearch);
      expect(actualVisitorSearch.rows.map((row) => row.browserVersion)).toEqual(
        ["132"],
      );

      const sessionSearchOptions = {
        limit: 10,
        sort: DEFAULT_SESSION_LIST_SORT,
        search: "7..1",
      } as const;
      const [expectedSessionSearch, actualSessionSearch] = await Promise.all([
        querySessionListParentOracle(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          sessionSearchOptions,
        ),
        querySessionListPageFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          sessionSearchOptions,
        ),
      ]);
      expect(actualSessionSearch).toEqual(expectedSessionSearch);
      expect(actualSessionSearch.rows.map((row) => row.browserVersion)).toEqual(
        ["7"],
      );

      const nullableEnv = {
        DB: {
          prepare: () => ({
            bind: () => ({
              all: async () => ({
                results: [
                  {
                    visitorId: "visitor-null-version",
                    sessionId: "session-null-version",
                    browserVersion: null,
                    startedAt: window.startMs,
                    endedAt: window.startMs,
                  },
                ],
              }),
            }),
          }),
        },
      } as unknown as Env;
      const [expectedNullableSession, actualNullableSession] =
        await Promise.all([
          querySessionListParentOracle(
            nullableEnv,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            { limit: 10, sort: DEFAULT_SESSION_LIST_SORT },
          ),
          querySessionListPageFromD1(
            nullableEnv,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            { limit: 10, sort: DEFAULT_SESSION_LIST_SORT },
          ),
        ]);
      expect(actualNullableSession).toEqual(expectedNullableSession);
      expect(actualNullableSession.rows[0]?.browserVersion).toBe("");

      const [expectedNullableVisitor, actualNullableVisitor] =
        await Promise.all([
          queryVisitorListParentOracle(
            nullableEnv,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            { limit: 10, sort: DEFAULT_VISITOR_LIST_SORT },
          ),
          queryVisitorListPageFromD1(
            nullableEnv,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            { limit: 10, sort: DEFAULT_VISITOR_LIST_SORT },
          ),
        ]);
      expect(actualNullableVisitor).toEqual(expectedNullableVisitor);
      expect(actualNullableVisitor.rows[0]?.browserVersion).toBe("");
    } finally {
      database.close();
    }
  });

  it.each(["visitor", "session"] as const)(
    "preflights a prepared fact base, full Funnel history, and full-field search for %s scope",
    (scope) => {
      const filter = parseFilterDsl(
        "session.views gte 2",
        analyticsFilterRegistry,
      );
      const plan = createScopedFilterPlan("goal-summary", filter, "session");
      if (!plan) throw new Error("wave70_preflight_scope_missing");
      const queryTime = createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        window.timeZone,
        window.nowMs,
      );
      const prepared = attachScopedFilterMetadata(filter, {
        requestedScope: "session",
        resolvedScope: plan.scope,
        plan,
        time: queryTime,
        siteIds: ["journey-list-site"],
      });
      const config = {
        filterDslVersion: 1 as const,
        progressionScope: "visitor" as const,
        conversionWindowMs: 86_400_000,
        steps: Array.from({ length: 12 }, (_, index) => ({
          id: `history-${index}`,
          filterDsl: `page.path contains "/history-${index}"`,
        })),
      };
      const analysis = {
        type: "funnel" as const,
        config,
        stepIndex: 11,
        outcome: "converted" as const,
      };
      const search = "  browser os version /history  ";
      const query =
        scope === "visitor"
          ? compileOutput(
              buildJourneyVisitorListReportPlan({
                siteId: "journey-list-site",
                window,
                filters: prepared,
                limit: 20,
                sort: DEFAULT_VISITOR_LIST_SORT,
                search,
                analysis,
              }),
              JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
            )
          : compileOutput(
              buildJourneySessionListReportPlan({
                siteId: "journey-list-site",
                window,
                filters: prepared,
                limit: 20,
                sort: { key: "durationMs", direction: "asc" },
                cursor: {
                  sortValue: 100,
                  startedAt: 1_700_000_000_001,
                  sessionId: "s-fixture",
                },
                sessionTarget: { type: "visitor", value: "fixture-visitor" },
                search,
                analysis,
              }),
              JOURNEY_SESSION_LIST_REPORT_OUTPUT,
            );
      const preflight = [query].map((compiledQuery) => ({
        bytes: new TextEncoder().encode(compiledQuery.sql).length,
        binds: compiledQuery.bindings?.length ?? 0,
        ctes: compiledQuery.physicalPlanShape?.cteCount,
      }));
      expect(query.bindings?.length ?? 0).toBeLessThanOrEqual(100);
      expect(preflight[0]!.bytes).toBeLessThanOrEqual(100_000);
    },
  );
});
