import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { DemoCustomEventFact } from "@/lib/demo/realtime/events-facts";
import { demoEventRecordPayload } from "@/lib/demo/realtime/events-payload";
import { applyDemoFilters } from "@/lib/demo/realtime/fact-filters";
import type { DemoFactDataset, DemoVisitFact } from "@/lib/demo/realtime/types";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  createTimeRange,
  prepareScopedQuery,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { compileFilterDocument } from "@/lib/edge/analytics/providers/d1/internal/filter-compiler";
import { compileScopedDatasetSql } from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import { expandCustomEventDataJson } from "@/lib/edge/ingest/custom-event-json";
import type { Env } from "@/lib/edge/types";
import {
  analyticsFilterRegistry,
  normalizeFilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";

const SITE_ID = "site-advanced-filter";
interface SharedActivityBase {
  readonly visitId: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly pageTimeMs: number;
  readonly pathname: string;
  readonly title?: string;
  readonly hostname?: string;
}
type SharedActivity = SharedActivityBase &
  (
    | {
        readonly event: {
          readonly id: string;
          readonly name: string;
          readonly timeMs: number;
          readonly payload?: Readonly<Record<string, unknown>>;
        };
      }
    | { readonly event?: never }
  );
const SHARED_ACTIVITIES = [
  {
    visitId: "history-signup",
    sessionId: "session-a",
    visitorId: "visitor-a",
    pageTimeMs: 10,
    pathname: "/history",
    event: { id: "history-signup:signup", name: "signup", timeMs: 1_010 },
  },
  {
    visitId: "history-purchase",
    sessionId: "session-a",
    visitorId: "visitor-a",
    pageTimeMs: 20,
    pathname: "/history",
    event: {
      id: "history-purchase:purchase",
      name: "purchase",
      timeMs: 1_020,
    },
  },
  {
    visitId: "history-cancel",
    sessionId: "session-a",
    visitorId: "visitor-a",
    pageTimeMs: 15,
    pathname: "/history",
    event: {
      id: "history-cancel:cancellation",
      name: "cancellation",
      timeMs: 1_015,
    },
  },
  {
    visitId: "same-millisecond-page",
    sessionId: "session-a",
    visitorId: "visitor-a",
    pageTimeMs: 1_020,
    pathname: "/same-millisecond",
  },
  {
    visitId: "candidate-a",
    sessionId: "session-a",
    visitorId: "visitor-a",
    pageTimeMs: 15_000,
    pathname: "/candidate",
  },
  {
    visitId: "candidate-b",
    sessionId: "session-b",
    visitorId: "visitor-b",
    pageTimeMs: 16_000,
    pathname: "/candidate",
  },
] as const satisfies readonly SharedActivity[];
const SHARED_FILTER_DSL =
  'page.path eq "/candidate" AND SESSION { count(PAGE { $.path eq "/history" }) gte 1 AND sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists AND EVENT { $.name eq "purchase" AND $.payload("/order/amount") gt 0 } exists } exists';
const RAW_COLUMNS = [
  "started_at",
  "status",
  "last_activity_at",
  "ended_at",
  "finalized_at",
  "duration_ms",
  "duration_source",
  "exit_reason",
  "pathname",
  "query_string",
  "hash_fragment",
  "hostname",
  "title",
  "referrer_url",
  "referrer_host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "is_eu",
  "country",
  "region",
  "region_code",
  "city",
  "continent",
  "latitude",
  "longitude",
  "postal_code",
  "metro_code",
  "timezone",
  "as_organization",
  "ua_raw",
  "browser",
  "browser_version",
  "os",
  "os_version",
  "device_type",
  "screen_width",
  "screen_height",
  "language",
  "user_id",
  "user_name",
  "perf_ttfb_ms",
  "perf_fcp_ms",
  "perf_lcp_ms",
  "perf_cls",
  "perf_inp_ms",
] as const;

function sqliteEnv(activities: readonly SharedActivity[] = SHARED_ACTIVITIES): {
  readonly env: Env;
  readonly database: DatabaseSync;
  readonly queries: string[];
} {
  const database = new DatabaseSync(":memory:");
  const queries: string[] = [];
  database.exec(`
    CREATE TABLE sites (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE site_identities (site_pk INTEGER PRIMARY KEY, site_id TEXT NOT NULL UNIQUE);
    CREATE TABLE visits (
      visit_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      site_pk INTEGER NOT NULL,
      visitor_id TEXT,
      session_id TEXT,
      ${RAW_COLUMNS.map((column) => `${column} ${column === "started_at" || column.endsWith("_ms") || column === "is_eu" ? "INTEGER" : "TEXT"}`).join(",\n      ")}
    );
    CREATE TABLE custom_event_names (
      id INTEGER PRIMARY KEY,
      site_pk INTEGER NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE custom_event_json_paths (
      id INTEGER PRIMARY KEY,
      site_pk INTEGER NOT NULL,
      path TEXT NOT NULL
    );
    CREATE TABLE custom_event_json_keys (
      id INTEGER PRIMARY KEY,
      site_pk INTEGER NOT NULL,
      key TEXT NOT NULL
    );
    CREATE TABLE custom_events (
      event_pk INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      site_pk INTEGER NOT NULL,
      visit_id TEXT NOT NULL,
      event_name_id INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL
    );
    CREATE TABLE custom_event_json_nodes (
      event_pk INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      parent_node_id INTEGER,
      key_id INTEGER,
      path_id INTEGER NOT NULL,
      value_type INTEGER NOT NULL,
      array_index INTEGER,
      depth INTEGER NOT NULL
    );
    CREATE TABLE custom_event_json_values (
      event_pk INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      value_type INTEGER NOT NULL,
      string_value TEXT,
      number_value REAL,
      boolean_value INTEGER
    );
  `);
  database
    .prepare("INSERT INTO sites (id, created_at) VALUES (?, ?)")
    .run(SITE_ID, 0);
  database
    .prepare("INSERT INTO site_identities (site_pk, site_id) VALUES (?, ?)")
    .run(1, SITE_ID);
  const insertVisit = database.prepare(`
    INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, started_at, pathname, title, duration_ms, hostname)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, 5, ?)
  `);
  for (const activity of activities) {
    insertVisit.run(
      activity.visitId,
      SITE_ID,
      activity.visitorId,
      activity.sessionId,
      activity.pageTimeMs,
      activity.pathname,
      activity.title ?? activity.pathname,
      activity.hostname ?? "example.test",
    );
  }
  database
    .prepare(
      "INSERT INTO custom_event_names (id, site_pk, name) VALUES (1, 1, 'signup'), (2, 1, 'purchase'), (3, 1, 'cancellation'), (4, 1, 'refund'), (5, 1, 'view')",
    )
    .run();
  const insertEvent = database.prepare(`
    INSERT INTO custom_events (event_pk, event_id, site_id, site_pk, visit_id, event_name_id, occurred_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `);
  let eventPk = 1;
  const pathIds = new Map<string, number>();
  const keyIds = new Map<string, number>();
  const ensurePathId = (path: string): number => {
    const existing = pathIds.get(path);
    if (existing !== undefined) return existing;
    const id = pathIds.size + 1;
    database
      .prepare(
        "INSERT INTO custom_event_json_paths (id, site_pk, path) VALUES (?, 1, ?)",
      )
      .run(id, path);
    pathIds.set(path, id);
    return id;
  };
  const ensureKeyId = (key: string): number => {
    const existing = keyIds.get(key);
    if (existing !== undefined) return existing;
    const id = keyIds.size + 1;
    database
      .prepare(
        "INSERT INTO custom_event_json_keys (id, site_pk, key) VALUES (?, 1, ?)",
      )
      .run(id, key);
    keyIds.set(key, id);
    return id;
  };
  const eventNameIds: Readonly<Record<string, number>> = {
    signup: 1,
    purchase: 2,
    cancellation: 3,
    refund: 4,
    view: 5,
  };
  for (const activity of activities) {
    if (!activity.event) continue;
    const currentEventPk = eventPk++;
    insertEvent.run(
      currentEventPk,
      activity.event.id,
      SITE_ID,
      activity.visitId,
      eventNameIds[activity.event.name]!,
      activity.event.timeMs,
    );
    const event: DemoCustomEventFact = {
      eventId: activity.event.id,
      eventName: activity.event.name,
      occurredAt: activity.event.timeMs,
      receivedAt: activity.event.timeMs + 120,
      sequence: 1,
      visit: demoVisit(activity),
    };
    const expanded = expandCustomEventDataJson(
      JSON.stringify(activity.event.payload ?? demoEventRecordPayload(event)),
    );
    if (!expanded.ok) throw new Error(expanded.error);
    for (const node of expanded.data.nodes) {
      const pathId = ensurePathId(node.path);
      const keyId = node.key === null ? null : ensureKeyId(node.key);
      database
        .prepare(
          `INSERT INTO custom_event_json_nodes (
            event_pk, node_id, parent_node_id, key_id, path_id, value_type,
            array_index, depth
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          currentEventPk,
          node.nodeId,
          node.parentNodeId,
          keyId,
          pathId,
          node.valueType,
          node.arrayIndex,
          node.depth,
        );
    }
    for (const value of expanded.data.values) {
      database
        .prepare(
          `INSERT INTO custom_event_json_values (
            event_pk, node_id, value_type, string_value, number_value,
            boolean_value
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          currentEventPk,
          value.nodeId,
          value.valueType,
          value.stringValue,
          value.numberValue,
          value.booleanValue,
        );
    }
  }

  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: Array<string | number | null>) => ({
          all: async <T extends object>() => {
            queries.push(sql);
            return {
              results: database.prepare(sql).all(...bindings) as T[],
            };
          },
        }),
      }),
    },
    DAILY_SALT_SECRET: "test-secret",
    INGEST_DO: {},
  } as unknown as Env;
  return { env, database, queries };
}

function demoVisit(activity: SharedActivity): DemoVisitFact {
  return {
    visitId: activity.visitId,
    sessionId: activity.sessionId,
    visitorId: activity.visitorId,
    startedAt: activity.pageTimeMs,
    pathname: activity.pathname,
    title: activity.title ?? activity.pathname,
    hostname: activity.hostname ?? "example.test",
    referrerHost: "",
    referrerUrl: "",
    browser: "Chrome",
    browserVersion: "1",
    osVersion: "Test OS",
    deviceType: "Desktop",
    language: "en",
    screenSize: "1280x720",
    country: "US",
    regionCode: "",
    regionName: "",
    region: "",
    cityName: "",
    city: "",
    continent: "",
    timezone: "UTC",
    organization: "",
    latitude: 0,
    longitude: 0,
    eventType: activity.event?.name ?? "pageview",
    durationMs: 5,
    ...(activity.event?.payload !== undefined
      ? { customEventPayload: activity.event.payload }
      : {}),
  };
}

function sharedDemoDataset(
  activities: readonly SharedActivity[] = SHARED_ACTIVITIES,
  from = 0,
  to = 20_000,
): DemoFactDataset {
  const visits = activities.map(demoVisit);
  return {
    from,
    to,
    viewWeight: 1,
    visits,
    sessions: new Map(),
    visitors: new Map(),
  };
}

interface SharedFilterRequest {
  readonly activities: readonly SharedActivity[];
  readonly filterDsl: string;
  readonly scope: "session" | "visitor";
  readonly candidateRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly filterRange?: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly reportingTimeZone: string;
  readonly capturedAtMs: number;
}

async function evaluateSharedFixture(request: SharedFilterRequest): Promise<{
  readonly d1: readonly string[];
  readonly mock: readonly string[];
  readonly mockVisitIds: readonly string[];
}> {
  const document = parseFilterDsl(request.filterDsl, analyticsFilterRegistry);
  const { env, database } = sqliteEnv(request.activities);
  try {
    const baseTime = createQueryTime(
      request.candidateRange.startMs,
      request.candidateRange.endExclusiveMs,
      request.reportingTimeZone,
      request.capturedAtMs,
    );
    const time = request.filterRange
      ? {
          ...baseTime,
          filterRange: createTimeRange(
            request.filterRange.startMs,
            request.filterRange.endExclusiveMs,
          ),
        }
      : baseTime;
    const input = prepareScopedQuery("overview", {
      context: siteQueryContext(SITE_ID, "private-dashboard"),
      filters: document,
      scopePreference: request.scope,
      time,
    });
    if (!input.scopePlan || !input.filters || !("time" in input))
      throw new Error("expected_prepared_scoped_filter_query");
    const preparedTime = (input as typeof input & { time: QueryTime }).time;
    const output = await d1AdvancedFilterMiddleware(env)(
      "overview",
      input,
      async (prepared) => prepared,
    );
    const prepared = output as typeof input;
    const d1Ids = (prepared.scopePlan?.advancedMatches?.entityIds ?? [])
      .map((item) => item.id)
      .sort();

    const fixtureStart = Math.min(
      ...request.activities.flatMap((activity) => [
        activity.pageTimeMs,
        ...(activity.event ? [activity.event.timeMs] : []),
      ]),
    );
    const coverageStart = Math.min(
      request.candidateRange.startMs,
      preparedTime.readRange?.startMs ?? request.candidateRange.startMs,
      preparedTime.filterRange?.startMs ?? request.candidateRange.startMs,
      preparedTime.fullHistory ? fixtureStart : Number.MAX_SAFE_INTEGER,
    );
    const coverageEnd = Math.max(
      request.candidateRange.endExclusiveMs,
      preparedTime.readRange?.endExclusiveMs ??
        request.candidateRange.endExclusiveMs,
      preparedTime.filterRange?.endExclusiveMs ??
        request.candidateRange.endExclusiveMs,
      preparedTime.fullHistory ? request.capturedAtMs + 1 : 0,
    );
    const mockResult = applyDemoFilters(
      sharedDemoDataset(request.activities, coverageStart, coverageEnd),
      {
        filterDocument: prepared.filters ?? document,
        scope: request.scope,
        candidateRange: request.candidateRange,
        ...(preparedTime.filterRange
          ? { filterRange: preparedTime.filterRange }
          : {}),
        ...(preparedTime.filterRangeEmpty ? { filterRangeEmpty: true } : {}),
        ...(preparedTime.readRange
          ? { readRange: preparedTime.readRange }
          : {}),
        ...(preparedTime.fullHistory ? { fullHistory: true } : {}),
        reportingTimeZone: request.reportingTimeZone,
        capturedAtMs: request.capturedAtMs,
      },
    );
    const mockIds = [
      ...(request.scope === "session"
        ? mockResult.sessions
        : mockResult.visitors),
    ].sort();
    return {
      d1: d1Ids,
      mock: mockIds,
      mockVisitIds: mockResult.visits.map((visit) => visit.visitId).sort(),
    };
  } finally {
    database.close();
  }
}

describe("D1 advanced filter execution", () => {
  it("uses evaluation history for Core and Relation while legacy fields stay in the candidate range", async () => {
    const { env, database } = sqliteEnv();
    try {
      const document = parseFilterDsl(
        SHARED_FILTER_DSL,
        analyticsFilterRegistry,
      );
      const time = {
        ...createQueryTime(10_000, 20_000, "UTC", 25_000),
        readRange: createTimeRange(0, 10_000),
      };
      const plan = createScopedFilterPlan("overview", document, "session");
      expect(plan).not.toBeNull();
      const filters = attachScopedFilterMetadata(document, {
        requestedScope: "session",
        resolvedScope: "session",
        plan: plan!,
        time,
        siteIds: [SITE_ID],
      });
      const input = {
        context: siteQueryContext(SITE_ID, "private-dashboard"),
        filters,
        scopePreference: "session" as const,
        scopePlan: plan!,
        time,
      };
      const middleware = d1AdvancedFilterMiddleware(env);
      const output = await middleware(
        "overview",
        input,
        async (prepared) => prepared,
      );
      const prepared = output as typeof input;
      const resolvedPlan = prepared.scopePlan!;
      expect(resolvedPlan.advancedMatches?.entityIds).toEqual([
        { siteId: SITE_ID, id: "session-a" },
      ]);

      const compiled = compileScopedDatasetSql({
        filters: prepared.filters!,
        plan: resolvedPlan,
        siteIds: [SITE_ID],
        window: {
          startMs: 10_000,
          endExclusiveMs: 20_000,
          nowMs: 25_000,
          timeZone: "UTC",
        },
      });
      expect(compiled.ctes).toContain("scope_advanced_matching_entities");
      expect(compiled.ctes).toContain(
        "matching_entities.entity_id = rv.session_id",
      );
      expect(compiled.bindings.map((binding) => binding.value)).toContain(
        "session-a",
      );

      const mockResult = applyDemoFilters(sharedDemoDataset(), {
        filterDocument: document,
        scope: "session",
        candidateRange: { startMs: 10_000, endExclusiveMs: 20_000 },
        readRange: { startMs: 0, endExclusiveMs: 10_000 },
        reportingTimeZone: "UTC",
        capturedAtMs: 25_000,
      });
      expect([...mockResult.sessions]).toEqual(
        (resolvedPlan.advancedMatches?.entityIds ?? []).map((item) => item.id),
      );
      expect([...mockResult.sessions]).toEqual(["session-a"]);
    } finally {
      database.close();
    }
  });

  it("compiles session and visitor fact filters with typed SQL bindings", () => {
    const cases = [
      ["session.views gt 1", "scope_session_facts", [1]],
      ["session.bounce eq true", "session_bounce", [1]],
      ["session.views between [1, 3]", " BETWEEN ? AND ?", [1, 3]],
      ["session.events notIn [2, 4]", " NOT IN (?, ?)", [2, 4]],
      ["visitor.sessions gte 2", "scope_visitor_facts", [2]],
    ] as const;
    const window = {
      startMs: 0,
      endExclusiveMs: 20_000,
      nowMs: 25_000,
      timeZone: "UTC",
    };

    for (const [source, expectedSql, expectedValues] of cases) {
      const document = parseFilterDsl(source, analyticsFilterRegistry);
      const plan = createScopedFilterPlan("overview", document, "session");
      expect(plan).not.toBeNull();
      const time = createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        window.timeZone,
        window.nowMs,
      );
      const filters = attachScopedFilterMetadata(document, {
        requestedScope: "session",
        resolvedScope: "session",
        plan: plan!,
        time,
        siteIds: [SITE_ID],
      });
      const compiled = compileScopedDatasetSql({
        filters,
        plan: plan!,
        siteIds: [SITE_ID],
        window,
      });

      expect(compiled.ctes).toContain(expectedSql);
      expect(compiled.bindings.map((binding) => binding.value)).toEqual(
        expect.arrayContaining([...expectedValues]),
      );
    }
  });

  it("rejects whole-payload object members when a JSON path is required", () => {
    const eventRoot = { kind: "entity-root", entity: "event" } as const;
    const payloadProjection = {
      kind: "selector",
      collection: eventRoot,
      predicate: {
        kind: "condition",
        target: {
          kind: "projection",
          collection: eventRoot,
          member: "payload",
        },
        operator: "exists",
      },
    } as const;
    const document = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "condition",
          target: {
            kind: "selector",
            collection: { kind: "entity-root", entity: "session" },
            predicate: {
              kind: "condition",
              target: payloadProjection,
              operator: "exists",
            },
          },
          operator: "exists",
        },
      },
      analyticsFilterRegistry,
    );
    expect(() =>
      prepareScopedQuery("overview", {
        context: siteQueryContext(SITE_ID, "private-dashboard"),
        filters: document,
        scopePreference: "session",
        time: createQueryTime(0, 20_000, "UTC", 25_000),
      } as never),
    ).toThrow(expect.objectContaining({ code: "invalid_member" }));
  });

  it("prepares both comparison sides and rejects advanced filters without execution metadata", async () => {
    const { env, database } = sqliteEnv();
    try {
      const document = parseFilterDsl(
        "count(PAGE) gte 1",
        analyticsFilterRegistry,
      );
      const makeSide = (from: number, to: number) => {
        const time = createQueryTime(from, to, "UTC", 25_000);
        const plan = createScopedFilterPlan("comparison", document, "session");
        if (!plan) throw new Error("expected_scoped_filter_plan");
        return {
          time,
          filters: attachScopedFilterMetadata(document, {
            requestedScope: "session",
            resolvedScope: "session",
            plan,
            time,
            siteIds: [SITE_ID],
          }),
        };
      };
      const current = makeSide(10_000, 20_000);
      const reference = makeSide(0, 10_000);
      const prepared = (await d1AdvancedFilterMiddleware(env)(
        "comparison",
        {
          context: siteQueryContext(SITE_ID, "private-dashboard"),
          current,
          reference,
        },
        async (input) => input,
      )) as {
        current: ReturnType<typeof makeSide>;
        reference: ReturnType<typeof makeSide>;
      };

      expect(
        scopedFilterMetadata(prepared.current.filters)?.plan.advancedMatches,
      ).toEqual({
        entityIds: [
          { siteId: SITE_ID, id: "session-a" },
          { siteId: SITE_ID, id: "session-b" },
        ],
      });
      expect(
        scopedFilterMetadata(prepared.reference.filters)?.plan.advancedMatches,
      ).toEqual({ entityIds: [{ siteId: SITE_ID, id: "session-a" }] });

      const unscoped = parseFilterDsl(
        "count(PAGE) gte 1",
        analyticsFilterRegistry,
      );
      await expect(
        d1AdvancedFilterMiddleware(env)(
          "comparison",
          {
            context: siteQueryContext(SITE_ID, "private-dashboard"),
            filters: unscoped,
          },
          async (input) => input,
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [
            {
              path: "filters",
              code: "advanced_filter_execution_context_required",
            },
          ],
        },
      });
    } finally {
      database.close();
    }
  });

  it("keeps Relation semantics consistent across D1 and Mock fixtures", async () => {
    const sharedRange = { startMs: 0, endExclusiveMs: 20_000 };
    const sameMillisecond = await evaluateSharedFixture({
      activities: SHARED_ACTIVITIES,
      filterDsl:
        'SESSION { adjacent(sequence([PAGE { $.path eq "/same-millisecond" }, EVENT { $.name eq "purchase" }])) exists } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(sameMillisecond.d1).toEqual(["session-a"]);
    expect(sameMillisecond.mock).toEqual(sameMillisecond.d1);

    const reverseSameMillisecond = await evaluateSharedFixture({
      activities: SHARED_ACTIVITIES,
      filterDsl:
        'SESSION { sequence([EVENT { $.name eq "purchase" }, PAGE { $.path eq "/same-millisecond" }]) exists } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(reverseSameMillisecond.d1).toEqual([]);
    expect(reverseSameMillisecond.mock).toEqual(reverseSameMillisecond.d1);

    const withoutBetweenEndpoints = await evaluateSharedFixture({
      activities: SHARED_ACTIVITIES,
      filterDsl:
        'SESSION { sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists AND without(sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]), EVENT { $.name eq "cancellation" }) notExists } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(withoutBetweenEndpoints.d1).toEqual(["session-a"]);
    expect(withoutBetweenEndpoints.mock).toEqual(withoutBetweenEndpoints.d1);

    const descendantActivities: readonly SharedActivity[] = [
      {
        visitId: "descendant-page-a",
        sessionId: "descendant-session",
        visitorId: "descendant-visitor",
        pageTimeMs: 10,
        pathname: "/home",
        title: "Home",
      },
      {
        visitId: "descendant-page-b",
        sessionId: "descendant-session",
        visitorId: "descendant-visitor",
        pageTimeMs: 20,
        pathname: "/pricing",
        title: "Checkout",
      },
      {
        visitId: "descendant-event-c",
        sessionId: "descendant-session",
        visitorId: "descendant-visitor",
        pageTimeMs: 25,
        pathname: "/other",
        event: {
          id: "descendant-event-c:purchase",
          name: "purchase",
          timeMs: 30,
        },
      },
    ];
    const lifted = await evaluateSharedFixture({
      activities: descendantActivities,
      filterDsl:
        'SESSION { PAGE { $.path eq "/pricing" } exists AND EVENT { $.name eq "purchase" } exists } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(lifted.d1).toEqual(["descendant-session"]);
    expect(lifted.mock).toEqual(lifted.d1);

    const independentlyLifted = await evaluateSharedFixture({
      activities: descendantActivities,
      filterDsl:
        'SESSION { PAGE { $.path eq "/pricing" } exists AND PAGE { $.title eq "Home" } exists } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(independentlyLifted.d1).toEqual(["descendant-session"]);
    expect(independentlyLifted.mock).toEqual(independentlyLifted.d1);

    const samePageOnly = await evaluateSharedFixture({
      activities: descendantActivities,
      filterDsl:
        'SESSION { PAGE { $.path eq "/pricing" AND $.title eq "Home" } exists } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(samePageOnly.d1).toEqual([]);
    expect(samePageOnly.mock).toEqual(samePageOnly.d1);
  });

  it("keeps Legacy string predicates and canonical scope facts consistent across providers", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "legacy-docs",
        sessionId: "legacy-session-a",
        visitorId: "legacy-visitor-a",
        pageTimeMs: 10,
        pathname: "/Docs/start",
        hostname: "Example.Test",
      },
      {
        visitId: "legacy-lower",
        sessionId: "legacy-session-b",
        visitorId: "legacy-visitor-b",
        pageTimeMs: 20,
        pathname: "/docs/start",
        hostname: "example.test",
      },
      {
        visitId: "legacy-wildcard",
        sessionId: "legacy-session-c",
        visitorId: "legacy-visitor-c",
        pageTimeMs: 30,
        pathname: "/Docs/100X_ready",
        hostname: "api.example.test",
      },
      {
        visitId: "legacy-empty-title",
        sessionId: "legacy-session-empty",
        visitorId: "legacy-visitor-empty",
        pageTimeMs: 40,
        pathname: "/empty-title",
        title: "",
        hostname: "empty.example.test",
      },
    ];
    const { database } = sqliteEnv(activities);
    const legacyIds = (filterDsl: string) => {
      const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
      const compiled = compileFilterDocument(document);
      return (
        database
          .prepare(
            `SELECT DISTINCT visitor_id FROM visits visit_source WHERE site_pk = 1 AND (${compiled.clause.replace(/^WHERE\s+/u, "")}) ORDER BY visitor_id`,
          )
          .all(...compiled.bindings) as Array<{ visitor_id: string }>
      ).map((row) => row.visitor_id);
    };
    try {
      const parityCases = [
        ['page.path eq "/Docs/start"', ["legacy-visitor-a"]],
        [
          'page.path neq "/elsewhere"',
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          'page.path in ["/Docs/start", "/docs/start"]',
          ["legacy-visitor-a", "legacy-visitor-b"],
        ],
        [
          'page.path notIn ["/elsewhere"]',
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        ['page.path contains "Docs"', ["legacy-visitor-a", "legacy-visitor-c"]],
        [
          'page.path startsWith "/Docs"',
          ["legacy-visitor-a", "legacy-visitor-c"],
        ],
        [
          'page.path endsWith "start"',
          ["legacy-visitor-a", "legacy-visitor-b"],
        ],
        [
          "page.durationMs gt 4",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          "page.durationMs gte 5",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          "page.durationMs lt 6",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          "page.durationMs lte 5",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          "page.durationMs between [5, 5]",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          "page.path exists",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        ["page.path notExists", []],
        ["page.path isNull", []],
        [
          "page.path notNull",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        ["page.title isEmpty", ["legacy-visitor-empty"]],
        [
          "page.title notEmpty",
          ["legacy-visitor-a", "legacy-visitor-b", "legacy-visitor-c"],
        ],
        [
          'page.hostname eq "EXAMPLE.TEST"',
          ["legacy-visitor-a", "legacy-visitor-b"],
        ],
      ] as const;
      for (const [legacyFilter, expected] of parityCases) {
        const mixedFilter = `${legacyFilter} AND count(EVENT) gte 0`;
        const baseline = legacyIds(legacyFilter);
        const result = await evaluateSharedFixture({
          activities,
          filterDsl: mixedFilter,
          scope: "visitor",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 100,
        });
        expect(baseline).toEqual(expected);
        expect(result.d1).toEqual(baseline);
        expect(result.mock).toEqual(baseline);
      }
    } finally {
      database.close();
    }

    const factParity = await evaluateSharedFixture({
      activities: [
        {
          visitId: "fact-entry",
          sessionId: "fact-session-a",
          visitorId: "fact-visitor",
          pageTimeMs: 10,
          pathname: "/entry",
        },
        {
          visitId: "fact-event",
          sessionId: "fact-session-a",
          visitorId: "fact-visitor",
          pageTimeMs: 15,
          pathname: "/event",
          event: { id: "fact-event:purchase", name: "purchase", timeMs: 16 },
        },
        {
          visitId: "fact-exit",
          sessionId: "fact-session-a",
          visitorId: "fact-visitor",
          pageTimeMs: 20,
          pathname: "/exit",
        },
        {
          visitId: "fact-bounce",
          sessionId: "fact-session-b",
          visitorId: "fact-visitor",
          pageTimeMs: 30,
          pathname: "/bounce",
        },
      ],
      filterDsl:
        'VISITOR { $.sessions eq 2 AND $.views eq 4 AND $.events eq 1 AND SESSION { $.durationMs eq 15 AND $.views eq 3 AND $.events eq 1 AND $.bounce eq false AND $.entryPath eq "/entry" AND $.exitPath eq "/exit" } exists } exists',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 2_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 2_000,
    });
    expect(factParity.d1).toEqual(["fact-visitor"]);
    expect(factParity.mock).toEqual(factParity.d1);
  });

  it("keeps numeric arithmetic, typed payloads, Duration ranges, auto history, and root Relations in provider parity", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "advanced-candidate-a",
        sessionId: "candidate-session-a",
        visitorId: "advanced-visitor",
        pageTimeMs: 15_000,
        pathname: "/candidate-a",
      },
      {
        visitId: "advanced-candidate-b",
        sessionId: "candidate-session-b",
        visitorId: "advanced-visitor",
        pageTimeMs: 16_000,
        pathname: "/candidate-b",
      },
      {
        visitId: "advanced-signup",
        sessionId: "history-session-a",
        visitorId: "advanced-visitor",
        pageTimeMs: 10,
        pathname: "/signup",
        event: { id: "advanced-signup:signup", name: "signup", timeMs: 1_010 },
      },
      {
        visitId: "advanced-purchase-text",
        sessionId: "history-session-b",
        visitorId: "advanced-visitor",
        pageTimeMs: 20,
        pathname: "/purchase-text",
        event: {
          id: "advanced-purchase-text:purchase",
          name: "purchase",
          timeMs: 1_020,
          payload: { amount: "0", productId: "123" },
        },
      },
      {
        visitId: "advanced-purchase-number-a",
        sessionId: "history-session-b",
        visitorId: "advanced-visitor",
        pageTimeMs: 30,
        pathname: "/purchase-number-a",
        event: {
          id: "advanced-purchase-number-a:purchase",
          name: "purchase",
          timeMs: 1_030,
          payload: { amount: 20, productId: 123 },
        },
      },
      {
        visitId: "advanced-purchase-number-b",
        sessionId: "history-session-b",
        visitorId: "advanced-visitor",
        pageTimeMs: 40,
        pathname: "/purchase-number-b",
        event: {
          id: "advanced-purchase-number-b:purchase",
          name: "purchase",
          timeMs: 1_040,
          payload: { amount: 30, productId: "123" },
        },
      },
    ];
    const automaticHistory = await evaluateSharedFixture({
      activities,
      filterDsl:
        'count(EVENT { $.name eq "purchase" }) gte 3 AND min(EVENT { $.name eq "purchase" } -> payload("/amount")) gt 15 AND countDistinct(EVENT { $.name eq "purchase" } -> payload("/productId")) eq 2 AND sub(count(EVENT { $.name eq "purchase" }), count(PAGE)) lt 0 AND div(sub(count(EVENT { $.name eq "purchase" }), count(PAGE)), count(PAGE)) lt 0',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(automaticHistory.d1).toEqual(["advanced-visitor"]);
    expect(automaticHistory.mock).toEqual(automaticHistory.d1);

    const narrowedNumber = await evaluateSharedFixture({
      activities,
      filterDsl: 'first(EVENT -> payload("/amount")) eq 20',
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(narrowedNumber.d1).toEqual(["advanced-visitor"]);
    expect(narrowedNumber.mock).toEqual(narrowedNumber.d1);

    const narrowedString = await evaluateSharedFixture({
      activities,
      filterDsl: 'first(EVENT -> payload("/amount")) eq "0"',
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(narrowedString.d1).toEqual(["advanced-visitor"]);
    expect(narrowedString.mock).toEqual(narrowedString.d1);

    const narrowedSet = await evaluateSharedFixture({
      activities,
      filterDsl: 'first(EVENT -> payload("/amount")) in [20, 30]',
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(narrowedSet.d1).toEqual(["advanced-visitor"]);
    expect(narrowedSet.mock).toEqual(narrowedSet.d1);

    const wrappedHistory = await evaluateSharedFixture({
      activities,
      filterDsl:
        'first(periods(EVENT { $.name eq "purchase" }, 1d) { count($items) gte 1 }) exists',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(wrappedHistory.d1).toEqual(["advanced-visitor"]);
    expect(wrappedHistory.mock).toEqual(wrappedHistory.d1);

    const entityAnchoredWindow = await evaluateSharedFixture({
      activities,
      filterDsl:
        'count(window(EVENT { $.name eq "purchase" }, first(EVENT { $.name eq "signup" }), [0ms, 20ms])) gte 1',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(entityAnchoredWindow.d1).toEqual(["advanced-visitor"]);
    expect(entityAnchoredWindow.mock).toEqual(entityAnchoredWindow.d1);

    const visitorSequence =
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists';
    const visitorRelation = await evaluateSharedFixture({
      activities,
      filterDsl: visitorSequence,
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(visitorRelation.d1).toEqual(["advanced-visitor"]);
    expect(visitorRelation.mock).toEqual(visitorRelation.d1);

    const sessionRelation = await evaluateSharedFixture({
      activities,
      filterDsl: visitorSequence,
      scope: "session",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(sessionRelation.d1).toEqual([]);
    expect(sessionRelation.mock).toEqual(sessionRelation.d1);

    const contextualActivities: readonly SharedActivity[] = [
      {
        visitId: "same-view-a",
        sessionId: "same-session-a",
        visitorId: "same-visitor-a",
        pageTimeMs: 10,
        pathname: "/view-a",
        event: {
          id: "same-view-a:event",
          name: "view",
          timeMs: 10,
          payload: { productId: "A" },
        },
      },
      {
        visitId: "same-purchase-a",
        sessionId: "same-session-a",
        visitorId: "same-visitor-a",
        pageTimeMs: 20,
        pathname: "/purchase-a",
        event: {
          id: "same-purchase-a:event",
          name: "purchase",
          timeMs: 20,
          payload: { productId: "A" },
        },
      },
      {
        visitId: "same-view-b",
        sessionId: "same-session-b",
        visitorId: "same-visitor-b",
        pageTimeMs: 10,
        pathname: "/view-b",
        event: {
          id: "same-view-b:event",
          name: "view",
          timeMs: 10,
          payload: { productId: "A" },
        },
      },
      {
        visitId: "same-purchase-b",
        sessionId: "same-session-b",
        visitorId: "same-visitor-b",
        pageTimeMs: 20,
        pathname: "/purchase-b",
        event: {
          id: "same-purchase-b:event",
          name: "purchase",
          timeMs: 20,
          payload: { productId: "B" },
        },
      },
    ];
    const contextualParity = await evaluateSharedFixture({
      activities: contextualActivities,
      filterDsl:
        'sequence([EVENT { $.name eq "view" }, EVENT { $.name eq "purchase" }]) { $span lte 20ms AND $gap(1, 2) eq 10ms AND $same($.payload("/productId")) } exists',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 2_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 2_000,
    });
    expect(contextualParity.d1).toEqual(["same-visitor-a"]);
    expect(contextualParity.mock).toEqual(contextualParity.d1);

    const occurrenceTimeParity = await evaluateSharedFixture({
      activities: contextualActivities,
      filterDsl:
        'sub(time(first(EVENT { $.name eq "purchase" })), time(first(EVENT { $.name eq "view" }))) eq 10ms',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 2_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 2_000,
    });
    expect(occurrenceTimeParity.d1).toEqual([
      "same-visitor-a",
      "same-visitor-b",
    ]);
    expect(occurrenceTimeParity.mock).toEqual(occurrenceTimeParity.d1);
  });

  it("evaluates complete Visitor filters in Filter time and projects only Query time", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "aug-signup-match",
        sessionId: "aug-session-match",
        visitorId: "visitor-history-match",
        pageTimeMs: 105,
        pathname: "/signup",
        event: {
          id: "aug-signup-event",
          name: "signup",
          timeMs: 115,
        },
      },
      {
        visitId: "aug-page-match",
        sessionId: "aug-session-match",
        visitorId: "visitor-history-match",
        pageTimeMs: 110,
        pathname: "/august",
        event: {
          id: "aug-purchase-match",
          name: "purchase",
          timeMs: 120,
        },
      },
      {
        visitId: "sep-page-match",
        sessionId: "sep-session-match",
        visitorId: "visitor-history-match",
        pageTimeMs: 3_220,
        pathname: "/september",
      },
      {
        visitId: "aug-page-no-purchase",
        sessionId: "aug-session-no-purchase",
        visitorId: "visitor-current-only-purchase",
        pageTimeMs: 130,
        pathname: "/august",
      },
      {
        visitId: "sep-page-current-purchase",
        sessionId: "sep-session-current-purchase",
        visitorId: "visitor-current-only-purchase",
        pageTimeMs: 3_230,
        pathname: "/september",
        event: {
          id: "sep-purchase-current-only",
          name: "purchase",
          timeMs: 3_240,
        },
      },
    ];
    const filters = [
      'event.name eq "purchase"',
      'count(EVENT { $.name eq "purchase" }) eq 1',
      'first(EVENT).name eq "signup"',
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists',
    ];
    for (const expression of filters) {
      const result = await evaluateSharedFixture({
        activities,
        filterDsl: `time between ["1970-01-01T00:00:00.100Z", "1970-01-01T00:00:01.999Z"] AND ${expression}`,
        scope: "visitor",
        candidateRange: { startMs: 3_000, endExclusiveMs: 4_000 },
        reportingTimeZone: "UTC",
        capturedAtMs: 3_999,
      });

      expect(result.d1).toEqual(["visitor-history-match"]);
      expect(result.mock).toEqual(result.d1);
      expect(result.mockVisitIds).toEqual(["sep-page-match"]);
    }

    const sessionActivities: readonly SharedActivity[] = [
      {
        visitId: "session-history-purchase",
        sessionId: "session-history",
        visitorId: "visitor-session-history",
        pageTimeMs: 110,
        pathname: "/august",
        event: {
          id: "session-history-purchase-event",
          name: "purchase",
          timeMs: 120,
        },
      },
      {
        visitId: "session-current-page",
        sessionId: "session-history",
        visitorId: "visitor-session-history",
        pageTimeMs: 3_220,
        pathname: "/september",
      },
      {
        visitId: "session-current-only-purchase",
        sessionId: "session-current-only",
        visitorId: "visitor-current-only",
        pageTimeMs: 3_230,
        pathname: "/september",
        event: {
          id: "session-current-only-purchase-event",
          name: "purchase",
          timeMs: 3_240,
        },
      },
    ];
    const sessionResult = await evaluateSharedFixture({
      activities: sessionActivities,
      filterDsl:
        'time between ["1970-01-01T00:00:00.100Z", "1970-01-01T00:00:01.999Z"] AND event.name eq "purchase"',
      scope: "session",
      candidateRange: { startMs: 3_000, endExclusiveMs: 4_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 3_999,
    });
    expect(sessionResult.d1).toEqual(["session-history"]);
    expect(sessionResult.mock).toEqual(sessionResult.d1);
    expect(sessionResult.mockVisitIds).toEqual(["session-current-page"]);
  });

  it("short-circuits future-only Filter ranges in D1 and Mock", async () => {
    const result = await evaluateSharedFixture({
      activities: SHARED_ACTIVITIES,
      filterDsl: "time gte @now+1ms AND count(EVENT) gte 1",
      scope: "visitor",
      candidateRange: { startMs: 10_000, endExclusiveMs: 20_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(result.d1).toEqual([]);
    expect(result.mock).toEqual([]);
    expect(result.mockVisitIds).toEqual([]);
  });

  it("extends Window reads beyond Filter time without widening candidate projection", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "window-purchase",
        sessionId: "window-session",
        visitorId: "visitor-window",
        pageTimeMs: 1_100,
        pathname: "/history/purchase",
        event: {
          id: "window-purchase-event",
          name: "purchase",
          timeMs: 1_200,
        },
      },
      {
        visitId: "window-refund",
        sessionId: "window-session",
        visitorId: "visitor-window",
        pageTimeMs: 8_000_000,
        pathname: "/history/refund",
        event: {
          id: "window-refund-event",
          name: "refund",
          timeMs: 8_000_100,
        },
      },
      {
        visitId: "window-query-projection",
        sessionId: "query-session",
        visitorId: "visitor-window",
        pageTimeMs: 9_000_000,
        pathname: "/current-window",
      },
    ];
    const result = await evaluateSharedFixture({
      activities,
      filterDsl:
        'time between ["1970-01-01T00:00:01.000Z", "1970-01-01T00:00:03.000Z"] AND count(window(EVENT, first(EVENT { $.name eq "purchase" }), [0d, 7d])) gte 2',
      scope: "visitor",
      candidateRange: { startMs: 9_000_000, endExclusiveMs: 10_000_000 },
      filterRange: { startMs: 1_000, endExclusiveMs: 3_001 },
      reportingTimeZone: "UTC",
      capturedAtMs: 10_000_000,
    });
    expect(result.d1).toEqual(["visitor-window"]);
    expect(result.mock).toEqual(result.d1);
    expect(result.mockVisitIds).toEqual(["window-query-projection"]);
  });

  it("applies top-level Activity time to aggregate Scopes without removing the predicate", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "old-history",
        sessionId: "old-session",
        visitorId: "visitor-with-old-activity",
        pageTimeMs: 500,
        pathname: "/candidate",
      },
      {
        visitId: "old-candidate",
        sessionId: "old-session",
        visitorId: "visitor-with-old-activity",
        pageTimeMs: 15_000,
        pathname: "/candidate",
      },
      {
        visitId: "new-candidate",
        sessionId: "new-session",
        visitorId: "visitor-without-old-activity",
        pageTimeMs: 16_000,
        pathname: "/candidate",
      },
    ];
    const result = await evaluateSharedFixture({
      activities,
      filterDsl: 'time lt @now-19s AND page.path eq "/candidate"',
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(result.d1).toEqual(["visitor-with-old-activity"]);
    expect(result.mock).toEqual(result.d1);

    const beforeCoverage = await evaluateSharedFixture({
      activities,
      filterDsl:
        'time lt "1969-12-31T23:59:59.999Z" AND page.path eq "/candidate"',
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(beforeCoverage.d1).toEqual([]);
    expect(beforeCoverage.mock).toEqual(beforeCoverage.d1);
  });

  it("uses Filter Range Visitor facts for the full Filter and keeps D1/Mock aligned", async () => {
    const filterDsl =
      'time between ["1970-01-01T00:00:01.000Z", "1970-01-01T00:00:03.000Z"] AND visitor.sessions gte 2';
    const candidateRange = { startMs: 10_000, endExclusiveMs: 20_000 };

    const filterRangeOneSession = await evaluateSharedFixture({
      activities: [
        {
          visitId: "visitor-filter-one",
          sessionId: "filter-session-a",
          visitorId: "visitor-range-a",
          pageTimeMs: 1_100,
          pathname: "/filter",
        },
        {
          visitId: "visitor-query-one",
          sessionId: "query-session-a",
          visitorId: "visitor-range-a",
          pageTimeMs: 15_000,
          pathname: "/query",
        },
        {
          visitId: "visitor-query-two",
          sessionId: "query-session-b",
          visitorId: "visitor-range-a",
          pageTimeMs: 16_000,
          pathname: "/query",
        },
      ],
      filterDsl,
      scope: "visitor",
      candidateRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(filterRangeOneSession.d1).toEqual([]);
    expect(filterRangeOneSession.mock).toEqual(filterRangeOneSession.d1);
    expect(filterRangeOneSession.mockVisitIds).toEqual([]);

    const filterRangeTwoSessions = await evaluateSharedFixture({
      activities: [
        {
          visitId: "visitor-filter-one",
          sessionId: "filter-session-a",
          visitorId: "visitor-range-b",
          pageTimeMs: 1_100,
          pathname: "/filter",
        },
        {
          visitId: "visitor-filter-two",
          sessionId: "filter-session-b",
          visitorId: "visitor-range-b",
          pageTimeMs: 1_200,
          pathname: "/filter",
        },
        {
          visitId: "visitor-query-one",
          sessionId: "query-session-a",
          visitorId: "visitor-range-b",
          pageTimeMs: 15_000,
          pathname: "/query",
        },
      ],
      filterDsl,
      scope: "visitor",
      candidateRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(filterRangeTwoSessions.d1).toEqual(["visitor-range-b"]);
    expect(filterRangeTwoSessions.mock).toEqual(filterRangeTwoSessions.d1);
    expect(filterRangeTwoSessions.mockVisitIds).toEqual(["visitor-query-one"]);
  });

  it("uses Filter Range Session facts instead of Query Range candidates", async () => {
    const result = await evaluateSharedFixture({
      activities: [
        {
          visitId: "session-filter-one",
          sessionId: "session-range-a",
          visitorId: "visitor-range-a",
          pageTimeMs: 1_100,
          pathname: "/filter-one",
        },
        {
          visitId: "session-filter-two",
          sessionId: "session-range-a",
          visitorId: "visitor-range-a",
          pageTimeMs: 1_200,
          pathname: "/filter-two",
        },
        {
          visitId: "session-query-one",
          sessionId: "session-range-a",
          visitorId: "visitor-range-a",
          pageTimeMs: 15_000,
          pathname: "/query",
        },
      ],
      filterDsl:
        'time between ["1970-01-01T00:00:01.000Z", "1970-01-01T00:00:03.000Z"] AND session.views eq 2 AND session.durationMs eq 10',
      scope: "session",
      candidateRange: { startMs: 10_000, endExclusiveMs: 20_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });

    expect(result.d1).toEqual(["session-range-a"]);
    expect(result.mock).toEqual(result.d1);
    expect(result.mockVisitIds).toEqual(["session-query-one"]);
  });

  it("keeps DST calendar bucket counts, periods, and empty reducers consistent across providers", async () => {
    for (const timestamp of [
      Date.parse("2026-03-08T20:00:00Z"),
      Date.parse("2026-11-01T20:00:00Z"),
    ] as const) {
      const range = { startMs: timestamp - 1, endExclusiveMs: timestamp + 1 };
      const activity: SharedActivity = {
        visitId: `dst-${timestamp}`,
        sessionId: `session-dst-${timestamp}`,
        visitorId: `visitor-dst-${timestamp}`,
        pageTimeMs: timestamp,
        pathname: "/dst",
      };
      const expressions = [
        "countDistinct(bucket(PAGE, 1d)) eq 1",
        "count(periods(PAGE, 1d)) eq 1",
      ];
      for (const filterDsl of expressions) {
        const result = await evaluateSharedFixture({
          activities: [activity],
          filterDsl,
          scope: "session",
          candidateRange: range,
          reportingTimeZone: "America/Los_Angeles",
          capturedAtMs: timestamp + 1,
        });
        expect(result.d1).toEqual([activity.sessionId]);
        expect(result.mock).toEqual(result.d1);
      }
    }

    const sunday = Date.parse("2026-03-08T20:00:00Z");
    const saturday = Date.parse("2026-03-14T20:00:00Z");
    const weekRange = { startMs: sunday - 1, endExclusiveMs: saturday + 1 };
    const weekActivities: readonly SharedActivity[] = [
      {
        visitId: "week-sunday",
        sessionId: "session-week",
        visitorId: "visitor-week",
        pageTimeMs: sunday,
        pathname: "/sunday",
      },
      {
        visitId: "week-saturday",
        sessionId: "session-week",
        visitorId: "visitor-week",
        pageTimeMs: saturday,
        pathname: "/saturday",
      },
    ];
    const mondayWeeks = await evaluateSharedFixture({
      activities: weekActivities,
      filterDsl: "count(periods(PAGE, 1w)) eq 2",
      scope: "session",
      candidateRange: weekRange,
      reportingTimeZone: "America/Los_Angeles",
      capturedAtMs: saturday + 1,
    });
    expect(mondayWeeks.d1).toEqual(["session-week"]);
    expect(mondayWeeks.mock).toEqual(mondayWeeks.d1);

    const emptyReducers = await evaluateSharedFixture({
      activities: [
        {
          visitId: "empty-reducer-page",
          sessionId: "session-empty",
          visitorId: "visitor-empty",
          pageTimeMs: 10,
          pathname: "/candidate",
        },
      ],
      filterDsl:
        'count(EVENT) eq 0 AND sum(EVENT -> payload("/amount")) eq 0 AND avg(EVENT -> payload("/amount")) isNull AND min(EVENT -> payload("/amount")) isNull AND max(EVENT -> payload("/amount")) isNull AND first(EVENT) notExists AND last(PAGE) exists AND nth(EVENT, 2) notExists AND countDistinct(EVENT -> payload("/amount")) eq 0 AND div(count(EVENT), count(EVENT)) isNull',
      scope: "session",
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      reportingTimeZone: "UTC",
      capturedAtMs: 100,
    });
    expect(emptyReducers.d1).toEqual(["session-empty"]);
    expect(emptyReducers.mock).toEqual(emptyReducers.d1);
  });

  it("rejects evaluation ranges that begin before confirmed site coverage", async () => {
    const { env, database, queries } = sqliteEnv();
    try {
      const document = parseFilterDsl(
        "count(PAGE) gte 1",
        analyticsFilterRegistry,
      );
      const time = {
        ...createQueryTime(100, 200, "UTC", 250),
        readRange: createTimeRange(-1, 100),
      };
      const plan = createScopedFilterPlan("overview", document, "session");
      const filters = attachScopedFilterMetadata(document, {
        requestedScope: "session",
        resolvedScope: "session",
        plan: plan!,
        time,
        siteIds: [SITE_ID],
      });
      const input = {
        context: siteQueryContext(SITE_ID, "private-dashboard"),
        filters,
        scopePreference: "session" as const,
        scopePlan: plan!,
        time,
      };
      await expect(
        d1AdvancedFilterMiddleware(env)(
          "overview",
          input,
          async (prepared) => prepared,
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [
            {
              path: "readRange",
              code: "filter_evaluation_range_unavailable",
            },
          ],
        },
      });
      expect(queries.some((sql) => /FROM visits\b/iu.test(sql))).toBe(false);
      expect(queries.some((sql) => /FROM custom_events\b/iu.test(sql))).toBe(
        false,
      );
    } finally {
      database.close();
    }
  });
});
