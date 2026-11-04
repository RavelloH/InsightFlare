import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  handlePlannedSiteSessionsSearch,
  handlePlannedSiteVisitorsSearch,
} from "@/lib/api-v1/analytics/site-list";
import {
  SiteSessionsSearchQueryDtoSchema,
  SiteVisitorsSearchQueryDtoSchema,
} from "@/lib/api-v1/contract/dto/analytics";
import { ApiV1ErrorEnvelopeSchema } from "@/lib/api-v1/contract/wire";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type { AnalyticsQueryExecutor } from "@/lib/edge/analytics/composition/query-runtime";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  type CanonicalQuery,
  createQueryTime,
  prepareScopedQuery,
  type QueryInput,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { deferredSessionListQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";
import * as sessionQualificationRequest from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";
import { deferredVisitorListQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/visitor-list-qualification-request";
import * as visitorQualificationRequest from "@/lib/edge/analytics/providers/d1/internal/visitor-list-qualification-request";
import type { ApiKeyPrincipal } from "@/lib/edge/auth/api-key-auth";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE_ID = "api-v1-qualified-list";
const OTHER_SITE_ID = "api-v1-qualified-list-other";
const BASE = Date.UTC(2026, 9, 1);
const END = BASE + 24 * 60 * 60 * 1000;
const MAIN_SECRET = "api-v1-qualified-list-test-secret";
const COUNT_FILTER = 'count(page { page.path eq "/match" }) gte 1';
const MIXED_OR_FILTER =
  'page.path eq "/native-only" or count(event { event.name eq "count-hit" }) gte 1';
const MIXED_NOT_FILTER =
  'not (page.path eq "/blocked" or count(event { event.name eq "reject" }) gte 1)';
const MIXED_BOOLEAN_FIXTURE = [
  ["visit-native", "visitor-native", "session-native-a", "/native-only"],
  [
    "visit-native-history",
    "visitor-native",
    "session-native-a",
    "/native-history",
  ],
  [
    "visit-native-second-session",
    "visitor-native",
    "session-native-b",
    "/native-second",
  ],
  ["visit-count", "visitor-count", "session-count-a", "/count-only"],
  ["visit-count-history", "visitor-count", "session-count-a", "/count-history"],
  ["visit-count-second-session", "visitor-count", "session-count-b", "/other"],
  ["visit-both-native", "visitor-both", "session-both", "/native-only"],
  ["visit-both-count", "visitor-both", "session-both", "/count-only"],
  ["visit-neither", "visitor-neither", "session-neither", "/other"],
  ["visit-blocked", "visitor-blocked", "session-blocked", "/blocked"],
  [
    "visit-blocked-history",
    "visitor-blocked",
    "session-blocked",
    "/blocked-history",
  ],
  [
    "visit-count-reject",
    "visitor-count-reject",
    "session-count-reject",
    "/count-reject",
  ],
  [
    "visit-count-reject-history",
    "visitor-count-reject",
    "session-count-reject",
    "/count-reject-history",
  ],
] as const;
const LIST_ANALYSIS_VISITS = [
  [
    "visit-97cz-goal-v-native",
    "97cz-goal-v-native",
    "97cz-gvn",
    "/native-only",
  ],
  ["visit-97cz-goal-v-count", "97cz-goal-v-count", "97cz-gvc", "/other"],
  ["visit-97cz-goal-v-cross-count", "97cz-goal-v-cross", "97cz-gvca", "/other"],
  ["visit-97cz-goal-v-cross-event", "97cz-goal-v-cross", "97cz-gvcb", "/other"],
  ["visit-97cz-goal-s-cross-count", "97cz-goal-s-cross", "97cz-gsca", "/other"],
  ["visit-97cz-goal-s-cross-event", "97cz-goal-s-cross", "97cz-gscb", "/other"],
  [
    "visit-97cz-goal-s-native",
    "97cz-goal-s-native",
    "97cz-gsn",
    "/native-only",
  ],
  [
    "visit-97cz-funnel-v-converted",
    "97cz-funnel-v-converted",
    "97cz-fvc",
    "/funnel-visitor-start",
  ],
  [
    "visit-97cz-funnel-v-dropoff",
    "97cz-funnel-v-dropoff",
    "97cz-fvd",
    "/funnel-visitor-start",
  ],
  [
    "visit-97cz-funnel-v-unqualified-start",
    "97cz-funnel-v-unqualified",
    "97cz-fvua",
    "/funnel-visitor-start",
  ],
  [
    "visit-97cz-funnel-v-unqualified-finish",
    "97cz-funnel-v-unqualified",
    "97cz-fvub",
    "/other",
  ],
  [
    "visit-97cz-funnel-s-count-converted",
    "97cz-funnel-s-converted",
    "97cz-fsca",
    "/other",
  ],
  [
    "visit-97cz-funnel-s-converted",
    "97cz-funnel-s-converted",
    "97cz-fscb",
    "/funnel-session-start",
  ],
  [
    "visit-97cz-funnel-s-count-dropoff",
    "97cz-funnel-s-dropoff",
    "97cz-fsda",
    "/other",
  ],
  [
    "visit-97cz-funnel-s-dropoff",
    "97cz-funnel-s-dropoff",
    "97cz-fsdb",
    "/funnel-session-start",
  ],
  ["visit-97cz-target-not-reject", "97cz-target-not", "97cz-tnr", "/other"],
  ["visit-97cz-target-not-clean", "97cz-target-not", "97cz-tnc", "/other"],
  [
    "visit-97cz-target-count-native",
    "visitor-count",
    "session-count-b",
    "/native-only",
  ],
] as const;
const LIST_ANALYSIS_EVENTS = [
  ["event-97cz-goal-v-native", "visit-97cz-goal-v-native", "goal-visitor-hit"],
  ["event-97cz-goal-v-count", "visit-97cz-goal-v-count", "count-hit"],
  [
    "event-97cz-goal-v-count-goal",
    "visit-97cz-goal-v-count",
    "goal-visitor-hit",
  ],
  [
    "event-97cz-goal-v-cross-count",
    "visit-97cz-goal-v-cross-count",
    "count-hit",
  ],
  [
    "event-97cz-goal-v-cross-hit",
    "visit-97cz-goal-v-cross-event",
    "goal-visitor-hit",
  ],
  [
    "event-97cz-goal-s-cross-count",
    "visit-97cz-goal-s-cross-count",
    "count-hit",
  ],
  [
    "event-97cz-goal-s-cross-hit",
    "visit-97cz-goal-s-cross-event",
    "goal-session-hit",
  ],
  ["event-97cz-goal-s-native", "visit-97cz-goal-s-native", "goal-session-hit"],
  [
    "event-97cz-funnel-v-converted-count",
    "visit-97cz-funnel-v-converted",
    "count-hit",
  ],
  [
    "event-97cz-funnel-v-converted-finish",
    "visit-97cz-funnel-v-converted",
    "funnel-visitor-finish",
  ],
  [
    "event-97cz-funnel-v-dropoff-count",
    "visit-97cz-funnel-v-dropoff",
    "count-hit",
  ],
  [
    "event-97cz-funnel-v-unqualified-count",
    "visit-97cz-funnel-v-unqualified-start",
    "count-hit",
  ],
  [
    "event-97cz-funnel-v-unqualified-finish",
    "visit-97cz-funnel-v-unqualified-finish",
    "funnel-visitor-finish",
  ],
  [
    "event-97cz-funnel-s-converted-count",
    "visit-97cz-funnel-s-count-converted",
    "count-hit",
  ],
  [
    "event-97cz-funnel-s-converted-finish",
    "visit-97cz-funnel-s-converted",
    "funnel-session-finish",
  ],
  [
    "event-97cz-funnel-s-dropoff-count",
    "visit-97cz-funnel-s-count-dropoff",
    "count-hit",
  ],
  ["event-97cz-target-not-reject", "visit-97cz-target-not-reject", "reject"],
] as const;
const LIST_ANALYSIS_FUNNEL_CONFIGS = {
  visitor: {
    filterDslVersion: 1,
    steps: [
      { id: "start", filterDsl: 'page.path eq "/funnel-visitor-start"' },
      { id: "finish", filterDsl: 'event.name eq "funnel-visitor-finish"' },
    ],
  },
  session: {
    filterDslVersion: 1,
    steps: [
      { id: "start", filterDsl: 'page.path eq "/funnel-session-start"' },
      { id: "finish", filterDsl: 'event.name eq "funnel-session-finish"' },
    ],
  },
} as const;

type SearchOperation = "visitors" | "sessions";
type SearchPage = {
  readonly items: readonly Record<string, unknown>[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
};
type ForwardedRequest = {
  readonly operation: SearchOperation | "visitor-sessions";
  readonly audience: string;
  readonly qualificationAudience?: string;
  readonly hasQualification: boolean;
  readonly hasAdvancedMatches: boolean;
};

const principal: ApiKeyPrincipal = {
  keyId: "api-v1-qualified-list-key",
  teamId: "api-v1-qualified-list-team",
  prefix: "api-v1",
  status: "active",
  scopes: ["analytics:read"],
  siteIds: [SITE_ID, OTHER_SITE_ID],
};

function seedFixture(
  database: DatabaseSync,
  siteId = SITE_ID,
  mixedBooleanFixture = false,
  listAnalysisFixture = false,
): void {
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  const identity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(siteId) as { readonly site_pk: number };
  database
    .prepare(
      "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, 'API qualified list', 'api-qualified.test', 0)",
    )
    .run(siteId, principal.teamId);

  const insert = database.prepare(
    "INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'api-qualified.test')",
  );
  const visits = mixedBooleanFixture
    ? [
        ...MIXED_BOOLEAN_FIXTURE,
        ...(listAnalysisFixture ? LIST_ANALYSIS_VISITS : []),
      ]
    : ([
        ["visit-a", "visitor-a", "session-a", "/match"],
        ["visit-b", "visitor-b", "session-b", "/match"],
        ["visit-c", "visitor-c", "session-c", "/other"],
      ] as const);
  for (const [visitId, visitorId, sessionId, pathname] of visits) {
    insert.run(
      visitId,
      siteId,
      identity.site_pk,
      visitorId,
      sessionId,
      BASE + 10_000,
      BASE + 11_000,
      pathname,
    );
  }
  if (mixedBooleanFixture) {
    const insertName = database.prepare(
      "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
    );
    insertName.run(siteId, "count-hit", BASE + 15_000, identity.site_pk);
    insertName.run(siteId, "reject", BASE + 15_000, identity.site_pk);
    const names = database
      .prepare(
        "SELECT id, name FROM custom_event_names WHERE site_pk = ? AND name IN ('count-hit', 'reject')",
      )
      .all(identity.site_pk) as unknown as readonly {
      readonly id: number;
      readonly name: string;
    }[];
    const nameIds = new Map(names.map(({ id, name }) => [name, id]));
    const insertEvent = database.prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
    );
    for (const [eventId, visitId, name] of [
      ["event-count-hit", "visit-count", "count-hit"],
      ["event-both-count-hit", "visit-both-count", "count-hit"],
      ["event-reject", "visit-count-reject", "reject"],
    ] as const) {
      const eventNameId = nameIds.get(name);
      if (eventNameId === undefined)
        throw new Error(`mixed_boolean_event_name_missing:${name}`);
      insertEvent.run(
        eventId,
        siteId,
        identity.site_pk,
        visitId,
        eventNameId,
        BASE + 15_000,
        BASE + 15_000,
      );
    }
  }
  if (listAnalysisFixture) {
    const insertName = database.prepare(
      "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
    );
    for (const name of [
      "goal-visitor-hit",
      "goal-session-hit",
      "funnel-visitor-finish",
      "funnel-session-finish",
    ])
      insertName.run(siteId, name, BASE + 15_000, identity.site_pk);
    const names = database
      .prepare(
        "SELECT id, name FROM custom_event_names WHERE site_pk = ? AND name IN ('count-hit', 'reject', 'goal-visitor-hit', 'goal-session-hit', 'funnel-visitor-finish', 'funnel-session-finish')",
      )
      .all(identity.site_pk) as unknown as readonly {
      readonly id: number;
      readonly name: string;
    }[];
    const nameIds = new Map(names.map(({ id, name }) => [name, id]));
    const insertEvent = database.prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
    );
    for (const [eventId, visitId, name] of LIST_ANALYSIS_EVENTS) {
      const eventNameId = nameIds.get(name);
      if (eventNameId === undefined)
        throw new Error(`list_analysis_event_name_missing:${name}`);
      insertEvent.run(
        eventId,
        siteId,
        identity.site_pk,
        visitId,
        eventNameId,
        BASE + 15_000,
        BASE + 15_000,
      );
    }
    const insertAnalysis = database.prepare(
      `INSERT INTO analysis_definitions (
        id, site_id, kind, name, config_json, config_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [goalId, filterDsl] of [
      ["goal-mixed-list-visitors", 'event.name eq "goal-visitor-hit"'],
      ["goal-mixed-list-sessions", 'event.name eq "goal-session-hit"'],
    ] as const)
      insertAnalysis.run(
        goalId,
        siteId,
        "goal",
        goalId,
        JSON.stringify({ filterDslVersion: 1, filterDsl }),
        1,
        BASE,
        BASE,
      );
    for (const progressionScope of ["visitor", "session"] as const)
      insertAnalysis.run(
        `funnel-${progressionScope}-mixed-list`,
        siteId,
        "funnel",
        `funnel-${progressionScope}-mixed-list`,
        JSON.stringify({
          ...LIST_ANALYSIS_FUNNEL_CONFIGS[progressionScope],
          progressionScope,
          conversionWindowMs: progressionScope === "visitor" ? 60_000 : null,
        }),
        2,
        BASE,
        BASE,
      );
  }
}

function createHarness(
  siteId = SITE_ID,
  mixedBooleanFixture = false,
  listAnalysisFixture = false,
): {
  readonly database: DatabaseSync;
  readonly diagnostics: D1ReadDiagnostics;
  readonly trace: SqliteD1Trace;
  readonly forwarded: ForwardedRequest[];
  readonly executor: AnalyticsQueryExecutor;
} {
  const database = createMigratedDatabase();
  seedFixture(database, siteId, mixedBooleanFixture, listAnalysisFixture);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const diagnostics = createD1ReadDiagnostics();
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET,
  } as unknown as Env;
  const registry = createD1SiteProviderRegistry({
    env,
    siteId,
    diagnostics,
  });
  const forwarded: ForwardedRequest[] = [];
  registry.useMiddleware(async (operation, input, next) => {
    if (
      operation === "visitors" ||
      operation === "sessions" ||
      operation === "visitor-sessions"
    ) {
      const query = input as QueryInput & {
        readonly scopePlan?: { readonly advancedMatches?: unknown };
      };
      const deferred =
        operation === "visitors"
          ? deferredVisitorListQualificationFromQuery(input)
          : deferredSessionListQualificationFromQuery(input);
      forwarded.push({
        operation,
        audience: query.context.policy.audience,
        ...(deferred
          ? { qualificationAudience: deferred.configuration.audience }
          : {}),
        hasQualification: deferred !== undefined,
        hasAdvancedMatches: query.scopePlan?.advancedMatches !== undefined,
      });
    }
    return next(input);
  });
  return {
    database,
    diagnostics,
    trace,
    forwarded,
    executor: createAnalyticsQueryRuntime(registry),
  };
}

function bodyFor(
  operation: SearchOperation,
  input: {
    readonly cursor?: string | null;
    readonly filter?: string;
    readonly sort?: {
      readonly field: string;
      readonly direction: "asc" | "desc";
    };
    readonly limit?: number;
    readonly scope?: "visitor" | "session";
  } = {},
) {
  return {
    timeRange: {
      kind: "absolute" as const,
      from: new Date(BASE).toISOString(),
      to: new Date(END).toISOString(),
      timeZone: "UTC",
    },
    scope: input.scope ?? (operation === "visitors" ? "visitor" : "session"),
    filter: {
      type: "dsl" as const,
      expression: input.filter ?? COUNT_FILTER,
    },
    sort:
      input.sort ??
      (operation === "visitors"
        ? { field: "lastSeenAt", direction: "desc" as const }
        : { field: "startedAt", direction: "desc" as const }),
    page: { limit: input.limit ?? 1, cursor: input.cursor ?? null },
  };
}

function postSearch(
  operation: SearchOperation,
  executor: AnalyticsQueryExecutor,
  body: unknown,
  options: {
    readonly siteId?: string;
    readonly requestPrincipal?: ApiKeyPrincipal;
  } = {},
): Promise<Response> {
  const siteId = options.siteId ?? SITE_ID;
  const request = new Request(
    "https://api.test/api/v1/sites/" +
      siteId +
      "/analytics/" +
      operation +
      "/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const execution = { capturedAtMs: END };
  return operation === "visitors"
    ? handlePlannedSiteVisitorsSearch(
        request,
        options.requestPrincipal ?? principal,
        siteId,
        executor,
        execution,
      )
    : handlePlannedSiteSessionsSearch(
        request,
        options.requestPrincipal ?? principal,
        siteId,
        executor,
        execution,
      );
}

async function readSuccess(response: Response): Promise<SearchPage> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return (body as { readonly data: SearchPage }).data;
}

async function expectApiError(response: Response, code: string): Promise<void> {
  const body = ApiV1ErrorEnvelopeSchema.parse(await response.json());
  expect(response.status).toBe(code === "resource_not_found" ? 404 : 400);
  expect(body.error.code, JSON.stringify(body)).toBe(code);
}

function isQualificationReportSql(sql: string): boolean {
  return sql.includes('"rowKind"') && sql.includes('"outputId"');
}

type PrivateListOperation = SearchOperation | "visitor-sessions";
type PrivateAnalysisContext =
  | { readonly type: "goal"; readonly goalId: string }
  | {
      readonly type: "funnel";
      readonly funnelId: string;
      readonly stepId: string;
      readonly outcome?: "converted" | "dropoff";
    };
type PrivateListPage = SearchPage & {
  readonly pagination: SearchPage["pagination"] & {
    readonly nextCursor: string | null;
  };
};

function privateListQuery(input: {
  readonly operation: PrivateListOperation;
  readonly filter: string;
  readonly countScope: "visitor" | "session";
  readonly context?: PrivateAnalysisContext;
  readonly visitorId?: string;
  readonly cursor: string | null;
}): QueryInput {
  const query = {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: createQueryTime(BASE, END, "UTC", END),
    filters: parseFilterDsl(input.filter, analyticsFilterRegistry),
    scopePreference: input.countScope,
    ...(input.context ? { analysisContext: input.context } : {}),
    ...(input.visitorId ? { visitorId: input.visitorId } : {}),
    page: { limit: 1, cursor: input.cursor },
    ...(input.operation === "visitors"
      ? { sort: { key: "lastSeenAt", direction: "desc" as const } }
      : input.operation === "sessions"
        ? { sort: { key: "startedAt", direction: "desc" as const } }
        : {}),
  };
  return prepareScopedQuery(
    input.operation as never,
    query as never,
  ) as QueryInput;
}

function journeyTargetPresenceSql(sql: string): boolean {
  return !isQualificationReportSql(sql) && sql.includes('"present"');
}

function journeyObservationSql(sql: string): boolean {
  return /(?:FROM|JOIN)\s+["`]?\s*(?:visits|custom_events)\b/i.test(sql);
}

function tracedCallsSince(trace: SqliteD1Trace, start: number) {
  return trace.preparedSql.slice(start).map((sql, index) => {
    const bindings = trace.bindings[start + index] ?? [];
    const kind = isQualificationReportSql(sql)
      ? "qualification-envelope"
      : journeyTargetPresenceSql(sql)
        ? "journey-target-presence"
        : journeyObservationSql(sql)
          ? "other-observation-read"
          : "metadata-or-control";
    return {
      kind,
      sql,
      bindings,
      sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
      boundParameterCount: bindings.length,
    };
  });
}

async function assertPrivateListScenario(input: {
  readonly name: string;
  readonly operation: PrivateListOperation;
  readonly filter: string;
  readonly countScope: "visitor" | "session";
  readonly visitorId?: string;
  readonly cases: readonly {
    readonly context?: PrivateAnalysisContext;
    readonly expectedIds: readonly string[];
  }[];
}): Promise<void> {
  const harness = createHarness(SITE_ID, true, true);
  const { database, executor, trace, forwarded } = harness;
  const idField = input.operation === "visitors" ? "visitorId" : "sessionId";
  const evidence: Array<Record<string, unknown>> = [];
  try {
    for (const scenario of input.cases) {
      const parserSpy =
        input.operation === "visitors"
          ? vi
              .spyOn(
                visitorQualificationRequest,
                "visitorListQualificationConfigurationFromQuery",
              )
              .mockReturnValue(undefined)
          : vi
              .spyOn(
                sessionQualificationRequest,
                "sessionListQualificationConfigurationFromQuery",
              )
              .mockReturnValue(undefined);
      const legacyPages: PrivateListPage[] = [];
      const legacyCaptures: Array<Record<string, unknown>> = [];
      let cursor: string | null = null;
      try {
        for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
          const sqlStart = trace.preparedSql.length;
          const forwardedStart = forwarded.length;
          const query = privateListQuery({
            operation: input.operation,
            filter: input.filter,
            countScope: input.countScope,
            context: scenario.context,
            visitorId: input.visitorId,
            cursor,
          });
          const result = (await executor.execute(
            input.operation as never,
            query as never,
          )) as { readonly ok: boolean; readonly data?: PrivateListPage };
          expect(result.ok, JSON.stringify(result)).toBe(true);
          if (!result.ok || !result.data)
            throw new Error(`legacy_${input.name}_request_failed`);
          legacyPages.push(result.data);
          legacyCaptures.push({
            pageIndex,
            requestCursor: cursor,
            page: result.data,
            forwarded: forwarded.slice(forwardedStart),
            calls: tracedCallsSince(trace, sqlStart),
          });
          cursor = result.data.pagination.nextCursor;
          if (cursor === null) break;
        }
      } finally {
        parserSpy.mockRestore();
      }
      expect(legacyPages.at(-1)?.pagination.nextCursor).toBeNull();

      const nativePages: PrivateListPage[] = [];
      const nativeCaptures: Array<Record<string, unknown>> = [];
      for (let pageIndex = 0; pageIndex < legacyPages.length; pageIndex += 1) {
        const sqlStart = trace.preparedSql.length;
        const forwardedStart = forwarded.length;
        const requestCursor =
          pageIndex === 0
            ? null
            : legacyPages[pageIndex - 1]!.pagination.nextCursor;
        const query = privateListQuery({
          operation: input.operation,
          filter: input.filter,
          countScope: input.countScope,
          context: scenario.context,
          visitorId: input.visitorId,
          cursor: requestCursor,
        });
        const result = (await executor.execute(
          input.operation as never,
          query as never,
        )) as { readonly ok: boolean; readonly data?: PrivateListPage };
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok || !result.data)
          throw new Error(`native_${input.name}_request_failed`);
        nativePages.push(result.data);
        const calls = tracedCallsSince(trace, sqlStart);
        const forwardedRequest = forwarded.slice(forwardedStart);
        nativeCaptures.push({
          pageIndex,
          requestCursor,
          page: result.data,
          forwarded: forwardedRequest,
          calls,
          factReads: calls.filter(({ kind }) =>
            [
              "qualification-envelope",
              "journey-target-presence",
              "other-observation-read",
            ].includes(String(kind)),
          ),
          sqlByteLimit: D1_MAX_SQL_UTF8_BYTES,
          bindingLimit: D1_MAX_BOUND_PARAMETERS,
        });
      }
      evidence.push({
        context: scenario.context ?? null,
        legacy: legacyCaptures,
        native: nativeCaptures,
      });
      const evidenceDirectory = process.env.INSIGHTFLARE_97CZ_EVIDENCE_DIR;
      if (evidenceDirectory) {
        mkdirSync(evidenceDirectory, { recursive: true });
        writeFileSync(
          join(evidenceDirectory, `runtime-${input.name}.json`),
          JSON.stringify(
            {
              operation: input.operation,
              filter: input.filter,
              countScope: input.countScope,
              visitorId: input.visitorId ?? null,
              cases: evidence,
            },
            null,
            2,
          ),
          "utf8",
        );
      }

      expect(nativePages).toEqual(legacyPages);
      const actualIds = nativePages.flatMap((page) =>
        page.items.map((item) => item[idField]),
      );
      expect(actualIds).toEqual(scenario.expectedIds);
      expect(new Set(actualIds).size).toBe(actualIds.length);
      expect(nativePages.length).toBeGreaterThan(0);
      expect(nativePages.at(-1)?.pagination.nextCursor).toBeNull();
      for (const [pageIndex, capture] of nativeCaptures.entries()) {
        const calls = capture.calls as ReturnType<typeof tracedCallsSince>;
        const factReads = capture.factReads as ReturnType<
          typeof tracedCallsSince
        >;
        expect(
          calls.every(
            ({ sqlUtf8Bytes, boundParameterCount }) =>
              sqlUtf8Bytes <= D1_MAX_SQL_UTF8_BYTES &&
              boundParameterCount <= D1_MAX_BOUND_PARAMETERS,
          ),
        ).toBe(true);
        expect(
          factReads.filter(({ kind }) => kind === "qualification-envelope"),
        ).toHaveLength(1);
        expect(
          factReads.filter(({ kind }) => kind === "journey-target-presence"),
        ).toHaveLength(input.operation === "visitor-sessions" ? 1 : 0);
        expect(
          factReads.filter(({ kind }) => kind === "other-observation-read"),
        ).toHaveLength(0);
        expect(nativeCaptures[pageIndex]!.forwarded).toHaveLength(1);
        expect(nativeCaptures[pageIndex]!.forwarded).toMatchObject([
          {
            operation: input.operation,
            audience: "private-dashboard",
            qualificationAudience: "private-dashboard",
            hasQualification: true,
            hasAdvancedMatches: false,
          },
        ]);
      }
    }
    const evidenceDirectory = process.env.INSIGHTFLARE_97CZ_EVIDENCE_DIR;
    if (evidenceDirectory) {
      mkdirSync(evidenceDirectory, { recursive: true });
      writeFileSync(
        join(evidenceDirectory, `runtime-${input.name}.json`),
        JSON.stringify(
          {
            operation: input.operation,
            filter: input.filter,
            countScope: input.countScope,
            visitorId: input.visitorId ?? null,
            cases: evidence,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
  } finally {
    database.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(["visitors", "sessions"] as const)(
  "API v1 %s Count qualified search",
  (operation) => {
    it("matches legacy pages, reuses the old cursor, and forwards api-v1 without IDs", async () => {
      const harness = createHarness();
      const { database, executor, trace, forwarded } = harness;
      try {
        const legacySpy =
          operation === "visitors"
            ? vi
                .spyOn(
                  visitorQualificationRequest,
                  "visitorListQualificationConfigurationFromQuery",
                )
                .mockReturnValue(undefined)
            : vi
                .spyOn(
                  sessionQualificationRequest,
                  "sessionListQualificationConfigurationFromQuery",
                )
                .mockReturnValue(undefined);

        let legacyFirst: SearchPage;
        let legacySecond: SearchPage;
        try {
          legacyFirst = await readSuccess(
            await postSearch(operation, executor, bodyFor(operation)),
          );
          expect(legacyFirst.pagination.nextCursor).toEqual(expect.any(String));
          legacySecond = await readSuccess(
            await postSearch(
              operation,
              executor,
              bodyFor(operation, {
                cursor: legacyFirst.pagination.nextCursor,
              }),
            ),
          );
        } finally {
          legacySpy.mockRestore();
        }

        const legacyForwarded = forwarded.slice(0, 2);
        expect(legacyForwarded).toHaveLength(2);
        expect(legacyForwarded.every((item) => !item.hasQualification)).toBe(
          true,
        );
        expect(legacyForwarded.every((item) => item.hasAdvancedMatches)).toBe(
          true,
        );
        expect(trace.preparedSql.some(isQualificationReportSql)).toBe(false);

        const nativeStart = forwarded.length;
        const sqlStart = trace.preparedSql.length;
        const nativeFirst = await readSuccess(
          await postSearch(operation, executor, bodyFor(operation)),
        );
        const nativeSecond = await readSuccess(
          await postSearch(
            operation,
            executor,
            bodyFor(operation, {
              cursor: legacyFirst.pagination.nextCursor,
            }),
          ),
        );
        expect(nativeFirst.items).toEqual(legacyFirst.items);
        expect(nativeSecond.items).toEqual(legacySecond.items);
        expect(nativeFirst.pagination.limit).toBe(1);
        expect(nativeSecond.pagination.hasMore).toBe(false);
        expect(nativeSecond.pagination.nextCursor).toBeNull();
        expect(nativeFirst.pagination.nextCursor).toEqual(expect.any(String));

        const nativeForwarded = forwarded.slice(nativeStart);
        expect(nativeForwarded).toHaveLength(2);
        expect(
          nativeForwarded.map((item) => ({
            audience: item.audience,
            qualificationAudience: item.qualificationAudience,
            hasQualification: item.hasQualification,
            hasAdvancedMatches: item.hasAdvancedMatches,
          })),
        ).toEqual(
          Array.from({ length: 2 }, () => ({
            audience: "api-v1",
            qualificationAudience: "api-v1",
            hasQualification: true,
            hasAdvancedMatches: false,
          })),
        );
        expect(
          trace.preparedSql.slice(sqlStart).some(isQualificationReportSql),
        ).toBe(true);

        const allIds = [...legacyFirst.items, ...legacySecond.items].map(
          (item) =>
            operation === "visitors" ? item.visitorId : item.sessionId,
        );
        expect(allIds).toHaveLength(2);
        expect(new Set(allIds).size).toBe(2);
        expect(allIds.every((id) => typeof id === "string")).toBe(true);

        const stableCursor = nativeFirst.pagination.nextCursor!;
        await expectApiError(
          await postSearch(
            operation,
            executor,
            bodyFor(operation, {
              cursor: stableCursor,
              filter: 'count(page { page.path eq "/other" }) gte 1',
            }),
          ),
          "invalid_cursor",
        );
        const differentSort =
          operation === "visitors"
            ? { field: "firstSeenAt", direction: "desc" as const }
            : { field: "durationMs", direction: "desc" as const };
        await expectApiError(
          await postSearch(
            operation,
            executor,
            bodyFor(operation, {
              cursor: stableCursor,
              sort: differentSort,
            }),
          ),
          "invalid_cursor",
        );
        const originalRequest = bodyFor(operation);
        await expectApiError(
          await postSearch(operation, executor, {
            ...originalRequest,
            timeRange: {
              ...originalRequest.timeRange,
              from: new Date(BASE - 60_000).toISOString(),
            },
            page: { ...originalRequest.page, cursor: stableCursor },
          }),
          "invalid_cursor",
        );
        await expectApiError(
          await postSearch(operation, executor, {
            ...originalRequest,
            scope: operation === "visitors" ? "session" : "visitor",
            page: { ...originalRequest.page, cursor: stableCursor },
          }),
          "invalid_cursor",
        );
        await expectApiError(
          await postSearch(operation, executor, {
            ...originalRequest,
            search: "different search",
            page: { ...originalRequest.page, cursor: stableCursor },
          }),
          "invalid_cursor",
        );
        if (operation === "visitors") {
          await expectApiError(
            await postSearch(
              "sessions",
              executor,
              bodyFor("sessions", { cursor: stableCursor }),
            ),
            "invalid_cursor",
          );
        }
        const otherSiteHarness = createHarness(OTHER_SITE_ID);
        try {
          await expectApiError(
            await postSearch(
              operation,
              otherSiteHarness.executor,
              bodyFor(operation, { cursor: stableCursor }),
              { siteId: OTHER_SITE_ID },
            ),
            "invalid_cursor",
          );
        } finally {
          otherSiteHarness.database.close();
        }
      } finally {
        database.close();
      }
    });
  },
);

describe.each(["visitors", "sessions"] as const)(
  "API v1 %s mixed Boolean Count qualification",
  (operation) => {
    it("uses whole-tree membership for OR and NOT, including the original cursor scope", async () => {
      const harness = createHarness(SITE_ID, true);
      const { database, executor, trace, forwarded } = harness;
      const parserSpy =
        operation === "visitors"
          ? vi
              .spyOn(
                visitorQualificationRequest,
                "visitorListQualificationConfigurationFromQuery",
              )
              .mockReturnValue(undefined)
          : vi
              .spyOn(
                sessionQualificationRequest,
                "sessionListQualificationConfigurationFromQuery",
              )
              .mockReturnValue(undefined);
      const hasQualification = false;
      const startSqlCount = (start: number) =>
        trace.preparedSql.slice(start).filter(isQualificationReportSql).length;
      const collect = async (input: {
        readonly filter: string;
        readonly scope: "visitor" | "session";
        readonly limit: number;
        readonly qualified: boolean;
      }): Promise<SearchPage[]> => {
        const pages: SearchPage[] = [];
        let cursor: string | null = null;
        for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
          const sqlStart = trace.preparedSql.length;
          const forwardedStart = forwarded.length;
          const page = await readSuccess(
            await postSearch(
              operation,
              executor,
              bodyFor(operation, {
                cursor,
                filter: input.filter,
                limit: input.limit,
                scope: input.scope,
              }),
            ),
          );
          expect(forwarded).toHaveLength(forwardedStart + 1);
          expect(forwarded.at(-1)).toMatchObject(
            input.qualified
              ? {
                  operation,
                  audience: "api-v1",
                  qualificationAudience: "api-v1",
                  hasQualification: true,
                  hasAdvancedMatches: false,
                }
              : {
                  operation,
                  audience: "api-v1",
                  hasQualification,
                  hasAdvancedMatches: true,
                },
          );
          expect(startSqlCount(sqlStart)).toBe(input.qualified ? 1 : 0);
          pages.push(page);
          if (!page.pagination.hasMore) {
            expect(page.pagination.nextCursor).toBeNull();
            return pages;
          }
          expect(page.pagination.nextCursor).toEqual(expect.any(String));
          cursor = page.pagination.nextCursor;
        }
        throw new Error("mixed_boolean_list_cursor_did_not_terminate");
      };

      try {
        let legacyOr: SearchPage[];
        let legacyNot: SearchPage[];
        try {
          legacyOr = await collect({
            filter: MIXED_OR_FILTER,
            scope: operation === "visitors" ? "session" : "visitor",
            limit: 2,
            qualified: false,
          });
          legacyNot = await collect({
            filter: MIXED_NOT_FILTER,
            scope: operation === "visitors" ? "visitor" : "session",
            limit: 20,
            qualified: false,
          });
        } finally {
          parserSpy.mockRestore();
        }

        const nativeOr = await collect({
          filter: MIXED_OR_FILTER,
          scope: operation === "visitors" ? "session" : "visitor",
          limit: 2,
          qualified: true,
        });
        const nativeNot = await collect({
          filter: MIXED_NOT_FILTER,
          scope: operation === "visitors" ? "visitor" : "session",
          limit: 20,
          qualified: true,
        });
        const legacyCursor = legacyOr[0]!.pagination.nextCursor;
        expect(legacyCursor).toEqual(expect.any(String));
        const cursorSqlStart = trace.preparedSql.length;
        const cursorForwardedStart = forwarded.length;
        const continuedWithLegacyCursor = await readSuccess(
          await postSearch(
            operation,
            executor,
            bodyFor(operation, {
              cursor: legacyCursor,
              filter: MIXED_OR_FILTER,
              limit: 2,
              scope: operation === "visitors" ? "session" : "visitor",
            }),
          ),
        );
        expect(continuedWithLegacyCursor.items).toEqual(nativeOr[1]!.items);
        expect(forwarded).toHaveLength(cursorForwardedStart + 1);
        expect(forwarded.at(-1)).toMatchObject({
          operation,
          audience: "api-v1",
          qualificationAudience: "api-v1",
          hasQualification: true,
          hasAdvancedMatches: false,
        });
        expect(startSqlCount(cursorSqlStart)).toBe(1);
        expect(nativeOr.map((page) => page.items)).toEqual(
          legacyOr.map((page) => page.items),
        );
        expect(nativeNot.map((page) => page.items)).toEqual(
          legacyNot.map((page) => page.items),
        );

        const idField = operation === "visitors" ? "visitorId" : "sessionId";
        const ids = (pages: readonly SearchPage[]) =>
          pages.flatMap((page) => page.items.map((item) => item[idField]));
        expect(ids(nativeOr)).toEqual(
          operation === "visitors"
            ? ["visitor-both", "visitor-count", "visitor-native"]
            : [
                "session-both",
                "session-count-a",
                "session-count-b",
                "session-native-a",
                "session-native-b",
              ],
        );
        expect(ids(nativeNot)).toEqual(
          operation === "visitors"
            ? [
                "visitor-both",
                "visitor-count",
                "visitor-native",
                "visitor-neither",
              ]
            : [
                "session-both",
                "session-count-a",
                "session-count-b",
                "session-native-a",
                "session-native-b",
                "session-neither",
              ],
        );

        if (operation === "visitors") {
          const countOnly = nativeOr
            .flatMap((page) => page.items)
            .find((item) => item.visitorId === "visitor-count");
          expect(countOnly).toMatchObject({ views: 2, sessions: 1 });
          expect(ids(nativeNot)).not.toContain("visitor-blocked");
          expect(ids(nativeNot)).not.toContain("visitor-count-reject");

          const privateStart = trace.preparedSql.length;
          const privateQuery = prepareScopedQuery("visitors", {
            context: siteQueryContext(SITE_ID, "private-dashboard"),
            time: createQueryTime(BASE, END, "UTC", END),
            filters: parseFilterDsl(MIXED_OR_FILTER, analyticsFilterRegistry),
            scopePreference: "visitor",
            page: { limit: 20, cursor: null },
            sort: { key: "lastSeenAt", direction: "desc" },
          } as never) as CanonicalQuery<"visitors">;
          const privateResult = await executor.execute(
            "visitors",
            privateQuery,
          );
          expect(privateResult.ok, JSON.stringify(privateResult)).toBe(true);
          if (!privateResult.ok)
            throw new Error("private_mixed_boolean_list_failed");
          expect(
            privateResult.data.items.map((item) => item.visitorId),
          ).toEqual(["visitor-both", "visitor-count", "visitor-native"]);
          expect(forwarded.at(-1)).toMatchObject({
            operation: "visitors",
            audience: "private-dashboard",
            qualificationAudience: "private-dashboard",
            hasQualification: true,
            hasAdvancedMatches: false,
          });
          expect(startSqlCount(privateStart)).toBe(1);
        }
      } finally {
        parserSpy.mockRestore();
        database.close();
      }
    });
  },
);

describe("private journey lists with complete mixed Boolean qualification", () => {
  it("continues to reject analysis contexts for visitor-sessions targets", () => {
    const query = privateListQuery({
      operation: "visitor-sessions",
      filter: MIXED_OR_FILTER,
      countScope: "visitor",
      context: { type: "goal", goalId: "goal-mixed-list" },
      visitorId: "visitor-count",
      cursor: null,
    });
    expect(deferredSessionListQualificationFromQuery(query)).toBeUndefined();
  });

  it(
    "qualifies Visitors Goal rows with a session-scoped Count tree",
    async () =>
      assertPrivateListScenario({
        name: "visitors-goal",
        operation: "visitors",
        filter: MIXED_OR_FILTER,
        countScope: "session",
        cases: [
          {
            context: {
              type: "goal",
              goalId: "goal-mixed-list-visitors",
            },
            expectedIds: ["97cz-goal-v-count", "97cz-goal-v-native"],
          },
        ],
      }),
    30_000,
  );

  it(
    "qualifies Sessions Goal rows from a visitor-scoped Count hit in another session",
    async () =>
      assertPrivateListScenario({
        name: "sessions-goal",
        operation: "sessions",
        filter: MIXED_OR_FILTER,
        countScope: "visitor",
        cases: [
          {
            context: {
              type: "goal",
              goalId: "goal-mixed-list-sessions",
            },
            expectedIds: ["97cz-gscb", "97cz-gsn"],
          },
        ],
      }),
    30_000,
  );

  it(
    "qualifies Visitors Funnel converted and dropoff after session Count membership",
    async () =>
      assertPrivateListScenario({
        name: "visitors-funnel",
        operation: "visitors",
        filter: MIXED_OR_FILTER,
        countScope: "session",
        cases: [
          {
            context: {
              type: "funnel",
              funnelId: "funnel-visitor-mixed-list",
              stepId: "finish",
              outcome: "converted",
            },
            expectedIds: ["97cz-funnel-v-converted"],
          },
          {
            context: {
              type: "funnel",
              funnelId: "funnel-visitor-mixed-list",
              stepId: "finish",
              outcome: "dropoff",
            },
            expectedIds: ["97cz-funnel-v-dropoff", "97cz-funnel-v-unqualified"],
          },
        ],
      }),
    30_000,
  );

  it(
    "qualifies Sessions Funnel converted and dropoff with visitor Count scope",
    async () =>
      assertPrivateListScenario({
        name: "sessions-funnel",
        operation: "sessions",
        filter: MIXED_OR_FILTER,
        countScope: "visitor",
        cases: [
          {
            context: {
              type: "funnel",
              funnelId: "funnel-session-mixed-list",
              stepId: "finish",
              outcome: "converted",
            },
            expectedIds: ["97cz-fscb"],
          },
          {
            context: {
              type: "funnel",
              funnelId: "funnel-session-mixed-list",
              stepId: "finish",
              outcome: "dropoff",
            },
            expectedIds: ["97cz-fsdb"],
          },
        ],
      }),
    30_000,
  );

  it(
    "applies visitor-sessions target after visitor-scoped OR qualification",
    async () =>
      assertPrivateListScenario({
        name: "visitor-sessions-count-visitor-target",
        operation: "visitor-sessions",
        filter: MIXED_OR_FILTER,
        countScope: "visitor",
        visitorId: "visitor-count",
        cases: [{ expectedIds: ["session-count-a", "session-count-b"] }],
      }),
    30_000,
  );

  it(
    "keeps only the target visitor's NOT-qualified session",
    async () =>
      assertPrivateListScenario({
        name: "visitor-sessions-count-session-target",
        operation: "visitor-sessions",
        filter: MIXED_NOT_FILTER,
        countScope: "session",
        visitorId: "97cz-target-not",
        cases: [{ expectedIds: ["97cz-tnc"] }],
      }),
    30_000,
  );
});

describe("API v1 search request boundaries", () => {
  it("keeps default/max page limits and site authorization in the existing handler", async () => {
    const timeRange = bodyFor("visitors").timeRange;
    expect(
      SiteVisitorsSearchQueryDtoSchema.parse({ timeRange }).page.limit,
    ).toBe(80);
    expect(
      SiteSessionsSearchQueryDtoSchema.parse({ timeRange }).page.limit,
    ).toBe(80);
    expect(
      SiteVisitorsSearchQueryDtoSchema.parse({
        timeRange,
        page: { limit: 200 },
      }).page.limit,
    ).toBe(200);
    expect(
      SiteSessionsSearchQueryDtoSchema.parse({
        timeRange,
        page: { limit: 200 },
      }).page.limit,
    ).toBe(200);
    expect(
      SiteVisitorsSearchQueryDtoSchema.parse({
        timeRange,
        search: "x".repeat(160),
      }).search,
    ).toHaveLength(160);
    expect(
      SiteSessionsSearchQueryDtoSchema.parse({
        timeRange,
        search: "x".repeat(160),
      }).search,
    ).toHaveLength(160);
    expect(() =>
      SiteVisitorsSearchQueryDtoSchema.parse({
        timeRange,
        page: { limit: 201 },
      }),
    ).toThrow();
    expect(() =>
      SiteSessionsSearchQueryDtoSchema.parse({
        timeRange,
        page: { limit: 201 },
      }),
    ).toThrow();
    expect(() =>
      SiteVisitorsSearchQueryDtoSchema.parse({
        timeRange,
        search: "x".repeat(161),
      }),
    ).toThrow();
    expect(() =>
      SiteSessionsSearchQueryDtoSchema.parse({
        timeRange,
        search: "x".repeat(161),
      }),
    ).toThrow();

    const execute = vi.fn();
    const executor = { execute } as unknown as AnalyticsQueryExecutor;
    const validBody = bodyFor("visitors", { limit: 201 });
    await expectApiError(
      await postSearch("visitors", executor, validBody),
      "validation_failed",
    );
    await expectApiError(
      await postSearch("sessions", executor, {
        ...bodyFor("sessions"),
        search: "x".repeat(161),
      }),
      "validation_failed",
    );
    await expectApiError(
      await postSearch("visitors", executor, bodyFor("visitors"), {
        requestPrincipal: { ...principal, siteIds: [OTHER_SITE_ID] },
      }),
      "resource_not_found",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("API v1 numeric Count compatibility fallback", () => {
  it("keeps TEXT numeric storage on the legacy-compatible result path", async () => {
    const harness = createHarness();
    const { database, diagnostics, executor, forwarded, trace } = harness;
    try {
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run(10, "visit-b");
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "visit-a");

      const body = bodyFor("sessions", {
        filter:
          'page.path eq "/match" and count(page { page.durationMs gt 5 }) eq 1',
      });
      const native = await readSuccess(
        await postSearch("sessions", executor, body),
      );
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });

      const legacySpy = vi
        .spyOn(
          sessionQualificationRequest,
          "sessionListQualificationConfigurationFromQuery",
        )
        .mockReturnValue(undefined);
      let legacy: SearchPage;
      try {
        legacy = await readSuccess(
          await postSearch("sessions", executor, body),
        );
      } finally {
        legacySpy.mockRestore();
      }
      expect(native.items).toEqual(legacy.items);
      expect(native.items).toHaveLength(1);
      expect(native.pagination.limit).toBe(legacy.pagination.limit);
      expect(forwarded.at(-1)).toMatchObject({
        audience: "api-v1",
        hasQualification: false,
        hasAdvancedMatches: true,
      });
    } finally {
      database.close();
    }
  });
});
