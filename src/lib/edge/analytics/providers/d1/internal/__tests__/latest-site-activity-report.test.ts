import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { PreparedMembership } from "@/lib/edge/analytics/contract/prepared-membership";
import type { QueryWindow } from "@/lib/edge/analytics/contract/types";
import { buildLatestSiteActivityPlan } from "@/lib/edge/analytics/engine/latest-site-activity-report-plan";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import {
  scopedDatasetFor,
  scopedDatasetForUnpreparedReader,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-scoped-oracle";
import { buildVisitFilterSql } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-filters";
import {
  buildVisitSourceCte,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import {
  type PreparedMembershipFixture,
  preparedMembershipFromIds,
  preparedMembershipIdentities,
  toPreparedMembership,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryLatestSiteActivity } from "@/lib/edge/analytics/providers/d1/internal/overview";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type FilterDocument as RawFilterDocument,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";
import type { FilterScopePreference } from "@/lib/filter-contract/scope-preference";

const SITE_ID = "wave61-latest-activity-a";
const OTHER_SITE_ID = "wave61-latest-activity-b";
const WINDOW: QueryWindow = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 180,
  timeZone: "UTC",
};
const PREVIOUS_WINDOW: QueryWindow = {
  startMs: 0,
  endExclusiveMs: WINDOW.startMs,
  nowMs: WINDOW.nowMs,
  timeZone: WINDOW.timeZone,
};

interface SiteIdentity {
  readonly siteId: string;
  readonly sitePk: number;
}

interface PageInput {
  readonly visitId: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly pathname: string;
  readonly siteId?: string;
}

function createDatabase(): {
  readonly database: DatabaseSync;
  readonly sites: ReadonlyMap<string, SiteIdentity>;
} {
  const database = createMigratedDatabase();
  const sites = new Map<string, SiteIdentity>();
  for (const siteId of [SITE_ID, OTHER_SITE_ID]) {
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
      .run(siteId);
    const row = database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(siteId) as { readonly site_pk: number };
    sites.set(siteId, { siteId, sitePk: row.site_pk });
  }
  return { database, sites };
}

function insertPage(
  database: DatabaseSync,
  sites: ReadonlyMap<string, SiteIdentity>,
  input: PageInput,
): void {
  const site = sites.get(input.siteId ?? SITE_ID);
  if (!site) throw new Error("wave61_test_site_missing");
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'latest-activity.test')`,
    )
    .run(
      input.visitId,
      site.siteId,
      site.sitePk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.lastActivityAt,
      input.pathname,
    );
}

function createEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, trace) } as unknown as Env;
}

function filterDocument(root: RawFilterDocument["root"]): FilterDocument {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function fieldFilter(field: string, value: string | number, operator = "eq") {
  return filterDocument({
    kind: "condition",
    target: { kind: "field", field },
    operator,
    value,
  } as never);
}

function payloadExistsFilter(count: number): FilterDocument {
  return filterDocument({
    kind: "and",
    children: Array.from({ length: count }, (_unused, index) => ({
      kind: "condition" as const,
      target: {
        kind: "event-payload" as const,
        path: `/wave61/payload-${index}`,
      },
      operator: "exists" as const,
    })),
  } as never);
}

function queryTime(window: QueryWindow): QueryTime {
  return createQueryTime(
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    window.nowMs,
  );
}

function preparedFilter(input: {
  readonly filters: FilterDocument;
  readonly scopePreference: FilterScopePreference;
  readonly preparationWindow?: QueryWindow;
  readonly preparedMembership: PreparedMembershipFixture | PreparedMembership;
}): FilterDocument {
  const time = queryTime(input.preparationWindow ?? WINDOW);
  const prepared = prepareScopedQuery("overview", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time,
    filters: input.filters,
    scopePreference: input.scopePreference,
  } as QueryInput & {
    readonly time: QueryTime;
    readonly filters: FilterDocument;
    readonly scopePreference: FilterScopePreference;
  }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: NonNullable<
      ReturnType<typeof scopedFilterMetadata>
    >["plan"];
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("wave61_prepared_filter_missing");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("wave61_prepared_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: {
      ...prepared.scopePlan,
      preparedMembership: toPreparedMembership(input.preparedMembership),
    },
  });
}

function payloadExistsMatches(
  database: DatabaseSync,
  sites: ReadonlyMap<string, SiteIdentity>,
  ownerVisitId: string,
  paths: readonly string[],
): void {
  const site = sites.get(SITE_ID);
  if (!site) throw new Error("wave61_payload_site_missing");
  database
    .prepare(
      "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, 'wave61-payload', ?, ?)",
    )
    .run(SITE_ID, WINDOW.startMs + 1, site.sitePk);
  const eventName = database
    .prepare(
      "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'wave61-payload'",
    )
    .get(site.sitePk) as { readonly id: number };
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES ('wave61-payload-event', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      SITE_ID,
      site.sitePk,
      ownerVisitId,
      eventName.id,
      WINDOW.startMs + 2,
      WINDOW.startMs + 2,
      paths.length,
      paths.length,
    );
  const event = database
    .prepare(
      "SELECT event_pk FROM custom_events WHERE event_id = 'wave61-payload-event'",
    )
    .get() as { readonly event_pk: number };
  const insertPath = database.prepare(
    "INSERT INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at) VALUES (?, ?, ?, ?)",
  );
  const insertNode = database.prepare(
    "INSERT INTO custom_event_json_nodes (event_pk, node_id, path_id, value_type, depth) VALUES (?, ?, ?, 1, 1)",
  );
  const insertValue = database.prepare(
    `INSERT INTO custom_event_json_values (
      event_pk, node_id, site_id, site_pk, event_name_id, path_id,
      occurred_at, value_type, string_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'present')`,
  );
  for (const [index, path] of paths.entries()) {
    insertPath.run(SITE_ID, site.sitePk, path, WINDOW.startMs + 2);
    const pathRow = database
      .prepare(
        "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
      )
      .get(site.sitePk, path) as { readonly id: number };
    const nodeId = index + 1;
    insertNode.run(event.event_pk, nodeId, pathRow.id);
    insertValue.run(
      event.event_pk,
      nodeId,
      SITE_ID,
      site.sitePk,
      eventName.id,
      pathRow.id,
      WINDOW.startMs + 2,
    );
  }
}

interface CapturedQuery {
  readonly sql: string;
  readonly bindings: Array<string | number | null>;
}

function createCaptureEnv(): {
  readonly env: Env;
  readonly calls: CapturedQuery[];
} {
  const calls: CapturedQuery[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...bindings: Array<string | number | null>) {
            calls.push({ sql, bindings });
            return {
              async all() {
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, calls };
}

async function compileObserved(
  name: string,
  window: QueryWindow,
  filters: FilterDocument,
): Promise<{
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly observation: Record<string, unknown>;
  readonly statementCount: number;
}> {
  const { env, calls } = createCaptureEnv();
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  const operation = `wave61.latest-site-activity.${name}`;
  await runWithInvocationLogger(logger, () =>
    runWithD1Operation(operation, () =>
      queryLatestSiteActivity(
        instrumentEnv(env, logger),
        SITE_ID,
        window,
        filters,
      ),
    ),
  );
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  let emitted;
  try {
    emitted = await logger.emitWhenComplete();
  } finally {
    consoleLog.mockRestore();
  }
  const call = calls[0];
  const observation = emitted.logs.find(
    (entry) =>
      entry.message === "db.query.v1.all.success" &&
      entry.data?.tag === operation,
  )?.data;
  if (!call || !observation)
    throw new Error("wave61_latest_activity_observation_missing");
  return {
    sql: call.sql,
    bindings: call.bindings,
    observation,
    statementCount: calls.length,
  };
}

/** Frozen pre-Wave61 LatestSiteActivity SQL, Source routing, and DTO mapping. */
function parentLatestSiteActivitySql(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): { readonly sql: string; readonly bindings: Array<string | number | null> } {
  const scopedDataset =
    scopedDatasetFor(siteId, window, filters) ??
    scopedDatasetForUnpreparedReader(
      "overview",
      siteId,
      window,
      filters,
      "session",
    );
  const filter = scopedDataset
    ? { clause: "", bindings: [] as Array<string | number> }
    : buildVisitFilterSql(filters, "visit_source", { window });
  const visitSource = buildVisitSourceCte().replace(
    "visit_source AS (",
    "visit_source AS MATERIALIZED (",
  );
  const metricSource = scopedDataset
    ? scopedDataset.visitRelation
    : "filtered_visits";
  const sourceSql = scopedDataset
    ? `${scopedDataset.ctes},`
    : `${visitSource},
filtered_visits AS MATERIALIZED (
  SELECT *
  FROM visit_source
  ${filter.clause}
),`;
  const sql = `
WITH
${sourceSql}
SELECT MAX(last_activity_at) AS lastActivityAt
FROM ${metricSource}
`;
  const bindings = scopedDataset
    ? scopedDataset.bindings.map(({ value }) => value)
    : [...visitSourceBindings(siteId, window), ...filter.bindings];
  return { sql, bindings };
}

async function parentLatestSiteActivity(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): Promise<number | null> {
  const parent = parentLatestSiteActivitySql(siteId, window, filters);
  // The retired reader left a trailing comma immediately before SELECT. Strip
  // only that invalid delimiter so SQLite can exercise its frozen Source,
  // filter, aggregate, and mapper behavior.
  const executableSql = parent.sql.replace(/,\s*SELECT MAX/u, "\nSELECT MAX");
  const result = await env.DB.prepare(executableSql)
    .bind(...parent.bindings)
    .all<{
      readonly lastActivityAt?: unknown;
    }>();
  const raw = result.results?.[0]?.lastActivityAt;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

async function parentCapture(
  window: QueryWindow,
  filters: FilterDocument,
): Promise<{
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly statementCount: number;
}> {
  const { env, calls } = createCaptureEnv();
  const parent = parentLatestSiteActivitySql(SITE_ID, window, filters);
  await env.DB.prepare(parent.sql)
    .bind(...parent.bindings)
    .all();
  const call = calls[0];
  if (!call) throw new Error("wave61_parent_sql_capture_missing");
  return {
    sql: call.sql,
    bindings: call.bindings,
    statementCount: calls.length,
  };
}

function planSource(plan: ReturnType<typeof buildLatestSiteActivityPlan>) {
  const source = plan.nodes.find((node) => node.kind === "source");
  if (!source || source.entity !== "page")
    throw new Error("wave61_latest_activity_page_source_missing");
  return source;
}

function explain(database: DatabaseSync, trace: SqliteD1Trace): string[] {
  const sql = trace.preparedSql[0];
  const bindings = trace.bindings[0];
  if (!sql || !bindings) throw new Error("wave61_eqp_query_missing");
  return (
    database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{
      readonly detail: string;
    }>
  ).map(({ detail }) => detail);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Latest site activity Logical report", () => {
  it("keeps the unfiltered Page bag and half-open site/window scope", async () => {
    const { database, sites } = createDatabase();
    const newTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const oldTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    try {
      const pages: PageInput[] = [
        {
          visitId: "plain-window",
          visitorId: "v-plain",
          sessionId: "s-plain",
          startedAt: 120,
          lastActivityAt: 980,
          pathname: "/plain",
        },
        {
          visitId: "plain-start",
          visitorId: "v-start",
          sessionId: "",
          startedAt: 100,
          lastActivityAt: 0,
          pathname: "/zero",
        },
        {
          visitId: "plain-before",
          visitorId: "v-before",
          sessionId: "s-before",
          startedAt: 99,
          lastActivityAt: 5000,
          pathname: "/before",
        },
        {
          visitId: "plain-end",
          visitorId: "v-end",
          sessionId: "s-end",
          startedAt: 200,
          lastActivityAt: 6000,
          pathname: "/end",
        },
        {
          visitId: "plain-other-site",
          visitorId: "v-other",
          sessionId: "s-other",
          startedAt: 150,
          lastActivityAt: 7000,
          pathname: "/other",
          siteId: OTHER_SITE_ID,
        },
        {
          visitId: "event-owner-outside",
          visitorId: "v-event",
          sessionId: "s-event",
          startedAt: 99,
          lastActivityAt: 20,
          pathname: "/event-outside",
        },
      ];
      for (const page of pages) insertPage(database, sites, page);
      const eventSite = sites.get(SITE_ID)!;
      database
        .prepare(
          "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, 'wave61-event-only', ?, ?)",
        )
        .run(SITE_ID, 150, eventSite.sitePk);
      const eventName = database
        .prepare(
          "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'wave61-event-only'",
        )
        .get(eventSite.sitePk) as { readonly id: number };
      database
        .prepare(
          "INSERT INTO custom_events (event_id, site_id, site_pk, visit_id, event_name_id, occurred_at, received_at, sequence, node_count, value_count) VALUES ('wave61-event-only', ?, ?, 'event-owner-outside', ?, 150, 150, 1, 0, 0)",
        )
        .run(SITE_ID, eventSite.sitePk, eventName.id);

      const expected = await parentLatestSiteActivity(
        { DB: createSqliteD1Database(database, oldTrace) } as unknown as Env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
      );
      const actual = await queryLatestSiteActivity(
        createEnv(database, newTrace),
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
      );
      expect(expected).toBe(980);
      expect(actual).toBe(expected);
      expect(newTrace.preparedSql).toHaveLength(1);

      const oldPlan = explain(database, oldTrace);
      const newPlan = explain(database, newTrace);
      expect(oldPlan.join("\n")).toContain("idx_visits_site_pk_started_at");
      expect(newPlan.join("\n")).toContain("idx_visits_site_pk_started_at");
      console.info(
        "wave61_latest_activity_eqp",
        JSON.stringify({ plain: { parent: oldPlan, logical: newPlan } }),
      );
    } finally {
      database.close();
    }
  });

  it("differentially preserves nonempty MAX for 40 and 39 independent payload predicates", async () => {
    const { database, sites } = createDatabase();
    const paths = Array.from(
      { length: 40 },
      (_unused, index) => `/wave61/payload-${index}`,
    );
    try {
      insertPage(database, sites, {
        visitId: "payload-filter-owner",
        visitorId: "v-payload",
        sessionId: "s-payload",
        startedAt: 120,
        lastActivityAt: 340,
        pathname: "/payload-owner",
      });
      insertPage(database, sites, {
        visitId: "payload-filter-sibling",
        visitorId: "v-payload",
        sessionId: "s-payload",
        startedAt: 150,
        lastActivityAt: 740,
        pathname: "/payload-sibling",
      });
      payloadExistsMatches(database, sites, "payload-filter-owner", paths);
      for (const count of [40, 39]) {
        const filters = payloadExistsFilter(count);
        const old = await parentLatestSiteActivity(
          createEnv(database, { preparedSql: [], bindings: [] }),
          SITE_ID,
          WINDOW,
          filters,
        );
        const actual = await queryLatestSiteActivity(
          createEnv(database, { preparedSql: [], bindings: [] }),
          SITE_ID,
          WINDOW,
          filters,
        );
        expect(old).toBe(740);
        expect(actual).toBe(old);
      }
    } finally {
      database.close();
    }
  });

  it("uses all blank-session Pages for a root-null filter and preserves zero", async () => {
    const { database, sites } = createDatabase();
    try {
      insertPage(database, sites, {
        visitId: "only-blank-session",
        visitorId: "v-blank",
        sessionId: "",
        startedAt: WINDOW.startMs,
        lastActivityAt: 0,
        pathname: "/blank",
      });
      insertPage(database, sites, {
        visitId: "blank-site-other",
        visitorId: "v-other-site",
        sessionId: "s-other-site",
        startedAt: WINDOW.startMs,
        lastActivityAt: 1000,
        pathname: "/other-site",
        siteId: OTHER_SITE_ID,
      });
      const actual = await queryLatestSiteActivity(
        createEnv(database, { preparedSql: [], bindings: [] }),
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
      );
      expect(actual).toBe(0);
    } finally {
      database.close();
    }
  });

  it("expands unprepared field, empty-AND, and count filters to matching Sessions", async () => {
    const { database, sites } = createDatabase();
    try {
      const rows: PageInput[] = [
        {
          visitId: "field-match",
          visitorId: "v-field",
          sessionId: "s-field",
          startedAt: 120,
          lastActivityAt: 300,
          pathname: "/field-match",
        },
        {
          visitId: "field-sibling",
          visitorId: "v-field",
          sessionId: "s-field",
          startedAt: 140,
          lastActivityAt: 700,
          pathname: "/field-sibling",
        },
        {
          visitId: "fact-match",
          visitorId: "v-fact",
          sessionId: "s-fact",
          startedAt: 130,
          lastActivityAt: 320,
          pathname: "/fact-match",
        },
        {
          visitId: "fact-sibling",
          visitorId: "v-fact",
          sessionId: "s-fact",
          startedAt: 150,
          lastActivityAt: 850,
          pathname: "/fact-sibling",
        },
      ];
      for (const page of rows) insertPage(database, sites, page);

      const field = fieldFilter("page.path", "/field-match");
      const nonNullAllSessionCount = fieldFilter("session.views", 0, "gte");
      const emptyAnd = {
        version: 1,
        root: { kind: "and", children: [] },
      } as unknown as FilterDocument;
      const countAndField = filterDocument({
        kind: "and",
        children: [
          {
            kind: "condition",
            target: { kind: "field", field: "session.views" },
            operator: "gte",
            value: 2,
          },
          {
            kind: "condition",
            target: { kind: "field", field: "page.path" },
            operator: "eq",
            value: "/fact-match",
          },
        ],
      } as never);
      const countSource = planSource(
        buildLatestSiteActivityPlan({
          siteId: SITE_ID,
          queryTime: queryTime(WINDOW),
          filters: nonNullAllSessionCount,
        }),
      );
      expect(countSource.selection?.profile).toBe(
        "direct-page-session-compat-v1",
      );
      const emptyAndSource = planSource(
        buildLatestSiteActivityPlan({
          siteId: SITE_ID,
          queryTime: queryTime(WINDOW),
          filters: emptyAnd,
        }),
      );
      expect(emptyAndSource.selection?.profile).toBe(
        "direct-page-session-compat-v1",
      );
      const cases = [
        { filters: field, expected: 700 },
        { filters: countAndField, expected: 850 },
        { filters: nonNullAllSessionCount, expected: 850 },
        { filters: emptyAnd, expected: 850 },
      ];
      for (const item of cases) {
        const oldTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const newTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const old = await parentLatestSiteActivity(
          createEnv(database, oldTrace),
          SITE_ID,
          WINDOW,
          item.filters,
        );
        const actual = await queryLatestSiteActivity(
          createEnv(database, newTrace),
          SITE_ID,
          WINDOW,
          item.filters,
        );
        expect(actual).toBe(old);
        expect(actual).toBe(item.expected);
        expect(newTrace.preparedSql).toHaveLength(1);
      }
      const sessionTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const oldSessionTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      await parentLatestSiteActivity(
        createEnv(database, oldSessionTrace),
        SITE_ID,
        WINDOW,
        field,
      );
      await queryLatestSiteActivity(
        createEnv(database, sessionTrace),
        SITE_ID,
        WINDOW,
        field,
      );
      const oldPlan = explain(database, oldSessionTrace);
      const newPlan = explain(database, sessionTrace);
      expect(oldPlan.join("\n")).toContain("idx_visits_site_pk_started_at");
      expect(newPlan.join("\n")).toContain("idx_visits_site_pk_started_at");
      console.info(
        "wave61_latest_activity_eqp",
        JSON.stringify({
          directSession: { parent: oldPlan, logical: newPlan },
        }),
      );
    } finally {
      database.close();
    }
  });

  it("preserves prepared Observation, Session, Visitor, and reader-window semantics", async () => {
    const { database, sites } = createDatabase();
    try {
      const rows: PageInput[] = [
        {
          visitId: "observation-match",
          visitorId: "v-observation",
          sessionId: "s-observation",
          startedAt: 120,
          lastActivityAt: 310,
          pathname: "/prepared-observation",
        },
        {
          visitId: "observation-sibling",
          visitorId: "v-observation",
          sessionId: "s-observation",
          startedAt: 130,
          lastActivityAt: 990,
          pathname: "/not-prepared",
        },
        {
          visitId: "session-match",
          visitorId: "v-session",
          sessionId: "s-prepared-session",
          startedAt: 120,
          lastActivityAt: 330,
          pathname: "/prepared-session",
        },
        {
          visitId: "session-sibling",
          visitorId: "v-session",
          sessionId: "s-prepared-session",
          startedAt: 130,
          lastActivityAt: 730,
          pathname: "/not-prepared",
        },
        {
          visitId: "visitor-match",
          visitorId: "v-prepared-visitor",
          sessionId: "s-visitor-one",
          startedAt: 125,
          lastActivityAt: 350,
          pathname: "/prepared-visitor",
        },
        {
          visitId: "visitor-sibling",
          visitorId: "v-prepared-visitor",
          sessionId: "s-visitor-two",
          startedAt: 135,
          lastActivityAt: 830,
          pathname: "/not-prepared",
        },
        {
          visitId: "prepared-previous-match",
          visitorId: "v-previous",
          sessionId: "s-previous",
          startedAt: 50,
          lastActivityAt: 430,
          pathname: "/prepared-previous",
        },
        {
          visitId: "prepared-previous-sibling",
          visitorId: "v-previous",
          sessionId: "s-previous",
          startedAt: 70,
          lastActivityAt: 690,
          pathname: "/not-prepared",
        },
        {
          visitId: "outside-previous-window",
          visitorId: "v-outside",
          sessionId: "s-outside",
          startedAt: 100,
          lastActivityAt: 4000,
          pathname: "/prepared-previous",
        },
      ];
      for (const page of rows) insertPage(database, sites, page);
      const cases = [
        {
          scopePreference: "event" as const,
          matches: { visitIds: [{ siteId: SITE_ID, id: "observation-match" }] },
          filter: fieldFilter("page.path", "/prepared-observation"),
          window: WINDOW,
          expected: 310,
        },
        {
          scopePreference: "session" as const,
          matches: {
            entityIds: [{ siteId: SITE_ID, id: "s-prepared-session" }],
          },
          filter: fieldFilter("page.path", "/prepared-session"),
          window: WINDOW,
          expected: 730,
        },
        {
          scopePreference: "visitor" as const,
          matches: {
            entityIds: [{ siteId: SITE_ID, id: "v-prepared-visitor" }],
          },
          filter: fieldFilter("page.path", "/prepared-visitor"),
          window: WINDOW,
          expected: 830,
        },
        {
          scopePreference: "event" as const,
          matches: {
            visitIds: [
              { siteId: SITE_ID, id: "prepared-previous-match" },
              ...Array.from({ length: 127 }, (_unused, index) => ({
                siteId: SITE_ID,
                id: `prepared-unused-${index}`,
              })),
            ],
          },
          filter: fieldFilter("page.path", "/prepared-previous"),
          window: PREVIOUS_WINDOW,
          expected: 430,
          preparationWindow: WINDOW,
        },
      ];
      for (const item of cases) {
        const filters = preparedFilter({
          filters: item.filter,
          scopePreference: item.scopePreference,
          preparationWindow: item.preparationWindow ?? WINDOW,
          preparedMembership: item.matches,
        });
        const plan = buildLatestSiteActivityPlan({
          siteId: SITE_ID,
          queryTime: queryTime(item.window),
          filters,
        });
        const source = planSource(plan);
        expect(source.selection?.profile).toBe(
          "prepared-page-reader-window-v1",
        );
        expect(source.selection?.time.candidate).toMatchObject({
          startMs: item.window.startMs,
          endExclusiveMs: item.window.endExclusiveMs,
        });
        expect(source.selection?.preparationTime?.candidate).toMatchObject({
          startMs: (item.preparationWindow ?? WINDOW).startMs,
          endExclusiveMs: (item.preparationWindow ?? WINDOW).endExclusiveMs,
        });
        const old = await parentLatestSiteActivity(
          createEnv(database, { preparedSql: [], bindings: [] }),
          SITE_ID,
          item.window,
          filters,
        );
        const diagnostics = createD1ReadDiagnostics();
        const actual = await queryLatestSiteActivity(
          createEnv(database, { preparedSql: [], bindings: [] }),
          SITE_ID,
          item.window,
          filters,
          diagnostics,
        );
        expect(old).toBe(item.expected);
        expect(actual).toBe(old);
        expect(diagnostics.requestedScope).toBeDefined();
        expect(diagnostics.resolvedScope).toBeDefined();
        expect(diagnostics.requiredSources).toBeDefined();
        expect(diagnostics.rowsReadAvailable).toBe(false);
      }

      const emptyPrepared = preparedFilter({
        filters: fieldFilter("page.path", "/prepared-previous"),
        scopePreference: "event",
        preparationWindow: WINDOW,
        preparedMembership: preparedMembershipFromIds({ visitIds: [] }),
      });
      expect(
        await queryLatestSiteActivity(
          createEnv(database, { preparedSql: [], bindings: [] }),
          SITE_ID,
          PREVIOUS_WINDOW,
          emptyPrepared,
        ),
      ).toBeNull();
    } finally {
      database.close();
    }
  });

  it("rejects Advanced filters that arrive without prepared metadata", () => {
    const advanced = filterDocument({
      kind: "condition",
      target: {
        kind: "selector",
        collection: { kind: "entity-root", entity: "page" },
        predicate: {
          kind: "condition",
          target: { kind: "field", field: "page.path" },
          operator: "eq",
          value: "/advanced",
        },
      },
      operator: "exists",
    } as never);
    expect(() =>
      buildLatestSiteActivityPlan({
        siteId: SITE_ID,
        queryTime: queryTime(WINDOW),
        filters: advanced,
      }),
    ).toThrow("invalid_semantic_scoped_source_selection");
  });

  it("returns null for empty Page bags and retains the SafeInteger mapper", async () => {
    const { database, sites } = createDatabase();
    try {
      insertPage(database, sites, {
        visitId: "empty-window-outside-page",
        visitorId: "v-empty",
        sessionId: "s-empty",
        startedAt: WINDOW.startMs - 1,
        lastActivityAt: 10_000,
        pathname: "/outside",
      });
      expect(
        await queryLatestSiteActivity(
          createEnv(database, { preparedSql: [], bindings: [] }),
          SITE_ID,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
        ),
      ).toBeNull();
    } finally {
      database.close();
    }

    const rawValues: unknown[] = [
      0,
      -1,
      null,
      undefined,
      "",
      "123",
      "Infinity",
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
      1.5,
    ];
    const expected = [0, -1, null, null, null, 123, null, null, null, null];
    for (const [index, raw] of rawValues.entries()) {
      const env = {
        DB: {
          prepare() {
            return {
              bind() {
                return {
                  async all() {
                    return {
                      success: true,
                      results: [{ lastActivityAt: raw }],
                    };
                  },
                };
              },
            };
          },
        },
      } as unknown as Env;
      await expect(
        queryLatestSiteActivity(env, SITE_ID, WINDOW, EMPTY_FILTER_DOCUMENT),
      ).resolves.toBe(expected[index]);
    }
  });

  it("records public-reader SQL, bind, statement, hash, and tag budgets", async () => {
    const direct40 = payloadExistsFilter(40);
    const currentPrepared = preparedFilter({
      filters: fieldFilter("page.path", "/prepared-budget"),
      scopePreference: "event",
      preparationWindow: WINDOW,
      preparedMembership: preparedMembershipFromIds({
        visitIds: Array.from({ length: 128 }, (_unused, index) => ({
          siteId: SITE_ID,
          id: `wave61-prepared-current-${index}`,
        })),
      }),
    });
    const previousPrepared = preparedFilter({
      filters: fieldFilter("page.path", "/prepared-budget"),
      scopePreference: "event",
      preparationWindow: WINDOW,
      preparedMembership: preparedMembershipFromIds({
        visitIds: Array.from({ length: 128 }, (_unused, index) => ({
          siteId: SITE_ID,
          id: `wave61-prepared-previous-${index}`,
        })),
      }),
    });
    const profiles = [
      { name: "plain", window: WINDOW, filters: EMPTY_FILTER_DOCUMENT },
      {
        name: "unprepared-payload-exists-40",
        window: WINDOW,
        filters: direct40,
      },
      {
        name: "prepared-page-128-current",
        window: WINDOW,
        filters: currentPrepared,
      },
      {
        name: "prepared-current-to-actual-previous",
        window: PREVIOUS_WINDOW,
        filters: previousPrepared,
      },
    ] as const;
    const evidence = [];
    for (const profile of profiles) {
      const [legacy, logical] = await Promise.all([
        parentCapture(profile.window, profile.filters),
        compileObserved(profile.name, profile.window, profile.filters),
      ]);
      const sqlBytes = new TextEncoder().encode(logical.sql).byteLength;
      const hash = createHash("sha256")
        .update(logical.sql)
        .digest("hex")
        .slice(0, 16);
      expect(legacy.statementCount, `${profile.name} parent`).toBe(1);
      expect(logical.statementCount, profile.name).toBe(1);
      expect(sqlBytes, profile.name).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(logical.bindings.length, profile.name).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(logical.observation.physicalPlanHash, profile.name).toMatch(
        /^v\d+:/u,
      );
      expect(logical.observation.tag, profile.name).toBe(
        `wave61.latest-site-activity.${profile.name}`,
      );
      evidence.push({
        name: profile.name,
        parent: {
          sqlBytes: new TextEncoder().encode(legacy.sql).byteLength,
          bindings: legacy.bindings.length,
          statements: legacy.statementCount,
          sqlHash: createHash("sha256")
            .update(legacy.sql)
            .digest("hex")
            .slice(0, 16),
        },
        logical: {
          sqlBytes,
          bindings: logical.bindings.length,
          statements: logical.statementCount,
          sqlHash: hash,
          physicalPlanHash: logical.observation.physicalPlanHash,
          tag: logical.observation.tag,
        },
      });
    }
    console.info("wave61_latest_activity_budget", JSON.stringify(evidence));
    expect(evidence).toHaveLength(profiles.length);
  });
});
