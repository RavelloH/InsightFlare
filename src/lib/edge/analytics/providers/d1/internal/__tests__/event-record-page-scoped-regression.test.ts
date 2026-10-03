import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import { buildEventRecordPagePlan } from "@/lib/edge/analytics/engine/event-record-page-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import {
  createSemanticSubjectDomain,
  semanticSubjectFromQuerySubject,
} from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { queryEventRecordPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-records";
import { compileScopedDatasetSql } from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type FilterDocument,
  type FilterExpression,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

const SITE_A = "wave37a-site-a";
const SITE_B = "wave37a-site-b";
const SITE_C = "wave37a-site-c";
const TEAM_ID = "wave37a-team";
const EVENT_RANGE = { startMs: 120, endExclusiveMs: 130 } as const;
const QUERY_TIME = createQueryTime(120, 130, "UTC", 500);
const WINDOW = {
  startMs: EVENT_RANGE.startMs,
  endExclusiveMs: EVENT_RANGE.endExclusiveMs,
  nowMs: 500,
  timeZone: "UTC",
} as const;
const SOURCE_ATTRIBUTES = [
  "event.report.internalPk",
  "event.report.localId",
  "event.report.eventName",
  "event.report.occurredAt",
  "event.report.receivedAt",
  "event.report.sequence",
  "event.report.ownerVisitId",
  "event.report.ownerSessionId",
  "event.report.ownerVisitorId",
  "event.report.ownerPathname",
  "event.report.ownerTitle",
  "event.report.ownerHostname",
  "event.report.ownerReferrerHost",
  "event.report.ownerCountry",
  "event.report.ownerRegion",
  "event.report.ownerCity",
  "event.report.ownerBrowser",
  "event.report.ownerBrowserVersion",
  "event.report.ownerOs",
  "event.report.ownerOsVersion",
  "event.report.ownerDeviceType",
  "event.report.nodeCount",
  "event.report.valueCount",
] as const satisfies readonly SemanticAttributeId[];

// Copied from the frozen event-record page projection: its fixed columns plus
// the explicit filter-only additions. This set is the oracle for the direct
// profile matrix; it intentionally does not consult the new Source planner.
const FROZEN_DIRECT_AVAILABLE_FIELDS = new Set([
  "page.path",
  "page.title",
  "page.hostname",
  "page.query",
  "page.hash",
  "referrer.domain",
  "referrer.url",
  "traffic.channel",
  "utm.source",
  "utm.medium",
  "utm.campaign",
  "utm.term",
  "utm.content",
  "client.browser",
  "client.browserVersion",
  "client.browserEngine",
  "client.os",
  "client.osVersion",
  "client.deviceType",
  "client.language",
  "client.screenSize",
  "geo.country",
  "geo.region",
  "geo.city",
  "geo.continent",
  "geo.timeZone",
  "geo.organization",
  "event.name",
]);

interface Site {
  readonly id: string;
  readonly pk: number;
}

interface Fixture {
  readonly db: DatabaseSync;
  readonly sites: Readonly<Record<"a" | "b" | "c", Site>>;
  readonly names: Readonly<Record<"a" | "b" | "c", number>>;
}

interface PreparedSelection {
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly queryTime: QueryTime;
  readonly subject: ReturnType<typeof createSemanticSubjectDomain>;
  readonly selection: ReturnType<typeof createSemanticScopedSourceSelection>;
}

function fieldCondition(
  field: string,
  operator: "eq" | "gte",
  value: string | number | boolean,
): FilterExpression {
  return {
    kind: "condition",
    target: { kind: "field", field: field as never },
    operator,
    value,
  };
}

function filtersFor(root: FilterExpression | null): FilterDocument {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function addSite(database: DatabaseSync, id: string): Site {
  database.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return { id, pk: Number(row.site_pk) };
}

function addName(database: DatabaseSync, site: Site, id: number, name: string) {
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(id, site.id, name, site.pk);
}

function addVisit(
  database: DatabaseSync,
  site: Site,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly startedAt?: number;
    readonly pathname?: string;
    readonly title?: string;
  },
): void {
  const startedAt = input.startedAt ?? 125;
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, title, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, 'events.test')`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      `visitor-${site.id}`,
      input.sessionId,
      startedAt,
      startedAt,
      input.pathname ?? "/landing",
      input.title ?? "Wave37A title",
    );
}

function addEvent(
  database: DatabaseSync,
  site: Site,
  input: {
    readonly id: string;
    readonly visitId: string;
    readonly nameId: number;
    readonly occurredAt?: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, 777, 1, 1, 1)`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.visitId,
      input.nameId,
      input.occurredAt ?? 125,
    );
}

function createBaseFixture(): Fixture {
  const db = createMigratedDatabase();
  db.exec("PRAGMA foreign_keys = OFF");
  const a = addSite(db, SITE_A);
  const b = addSite(db, SITE_B);
  const c = addSite(db, SITE_C);
  const names = { a: 11, b: 12, c: 13 } as const;
  addName(db, a, names.a, "target_event");
  addName(db, a, 14, "other_event");
  addName(db, b, names.b, "target_event");
  addName(db, c, names.c, "target_event");

  addVisit(db, a, {
    id: "visit-a-one",
    sessionId: "session-collision",
    pathname: "/landing",
    title: "Meteor guide",
  });
  addVisit(db, a, {
    id: "visit-a-two",
    sessionId: "session-collision",
    startedAt: 126,
    pathname: "/landing",
    title: "Meteor guide",
  });
  addVisit(db, b, {
    id: "visit-b-one",
    sessionId: "session-collision",
    pathname: "/landing",
    title: "Meteor guide",
  });
  addVisit(db, c, {
    id: "visit-c-one",
    sessionId: "session-collision",
    pathname: "/landing",
    title: "Meteor guide",
  });
  addEvent(db, a, {
    id: "event-a-target",
    visitId: "visit-a-one",
    nameId: names.a,
  });
  addEvent(db, a, {
    id: "event-a-other",
    visitId: "visit-a-two",
    nameId: 14,
  });
  addEvent(db, b, {
    id: "event-b-target",
    visitId: "visit-b-one",
    nameId: names.b,
  });
  addEvent(db, c, {
    id: "event-c-target",
    visitId: "visit-c-one",
    nameId: names.c,
  });
  for (const [site, nameId, visitId, slug] of [
    [a, names.a, "visit-a-one", "cache-a"],
    [a, names.a, "visit-a-one", "cache-a-second"],
    [b, names.b, "visit-b-one", "cache-b"],
  ] as const) {
    addVisit(db, site, {
      id: `visit-${slug}`,
      sessionId: `session-${slug}`,
      pathname: `/${slug}`,
    });
    addEvent(db, site, {
      id: `event-${slug}`,
      visitId: `visit-${slug}`,
      nameId,
    });
  }
  addVisit(db, a, {
    id: "visit-cache-b-a",
    sessionId: "session-cache-b-a",
    pathname: "/cache-b",
  });
  addEvent(db, a, {
    id: "event-cache-b-a",
    visitId: "visit-cache-b-a",
    nameId: names.a,
  });
  return { db, sites: { a, b, c }, names };
}

function makePreparedSelection(input: {
  readonly authorizationSites: readonly Site[];
  readonly subjectSites?: readonly Site[];
  readonly filters: FilterDocument;
  readonly scopePreference: "event" | "session" | "visitor";
  readonly eventName?: string;
  readonly advancedMatches?: ScopedFilterPlan["advancedMatches"];
}): PreparedSelection & { readonly mutablePlan: ScopedFilterPlan } {
  const authorizationSites = input.authorizationSites.map((site) => site.id);
  const context =
    authorizationSites.length === 1
      ? siteQueryContext(authorizationSites[0]!, "private-dashboard")
      : teamQueryContext(TEAM_ID, "private-dashboard", authorizationSites);
  const prepared = prepareScopedQuery("event-records", {
    context,
    time: QUERY_TIME,
    filters: input.filters,
    scopePreference: input.scopePreference,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
    readonly time?: QueryTime;
  };
  if (!prepared.filters || !prepared.scopePlan || !prepared.time)
    throw new Error("wave37a_prepared_selection_incomplete");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("wave37a_prepared_metadata_missing");
  const mutablePlan = {
    ...prepared.scopePlan,
    ...(input.advancedMatches === undefined
      ? {}
      : { advancedMatches: input.advancedMatches }),
  } satisfies ScopedFilterPlan;
  const filters = attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: mutablePlan,
  });
  const subjectSites = (input.subjectSites ?? input.authorizationSites).map(
    (site) => site.id,
  );
  const subject =
    subjectSites.length === authorizationSites.length &&
    context.subject.kind === "site"
      ? semanticSubjectFromQuerySubject(context.subject)
      : createSemanticSubjectDomain({
          origin: "team",
          teamId: TEAM_ID as never,
          siteIds: subjectSites as never,
        });
  const queryTime = prepared.time;
  const selection = createSemanticScopedSourceSelection({
    profile: "prepared-scoped-v1",
    filters,
    subject,
    time: semanticTemporalDomainsFromQueryTime(queryTime),
    expectedPlan: mutablePlan,
    ...(input.eventName === undefined ? {} : { eventName: input.eventName }),
  });
  return {
    filters,
    scopePlan: mutablePlan,
    queryTime,
    subject,
    selection,
    mutablePlan,
  };
}

function createDomainContext(selection: PreparedSelection) {
  return {
    subject: selection.subject,
    time: semanticTemporalDomainsFromQueryTime(selection.queryTime),
    scope: resolveAnalyticsScope(selection.scopePlan.scope),
    originOperation: "event-records" as const,
  };
}

type ProbeMode = "full" | "count" | "localId" | "count+page";

function buildSourceDomainProbe(
  selection: PreparedSelection,
  mode: ProbeMode,
  limit = 20,
): ValidatedLogicalPlan {
  const builder = new LogicalPlanBuilder(createDomainContext(selection));
  const attributes: readonly SemanticAttributeId[] =
    mode === "count"
      ? []
      : mode === "localId"
        ? ["event.report.localId"]
        : SOURCE_ATTRIBUTES;
  const events = builder.source("event", {
    temporalDomain: "candidate",
    attributes,
    selection: selection.selection,
  });
  const addCount = () => {
    const counted = builder.aggregate(events, {}, [
      { name: "count", kind: "count-rows" },
    ]);
    builder.output("count", counted, [{ name: "count", slot: "count" }]);
  };
  const addPage = (outputName: string) => {
    const sorted = builder.sort(events, [
      {
        slot: "attribute:event.report.occurredAt",
        direction: "desc",
        nulls: "last",
      },
      {
        slot: "attribute:event.report.localId",
        direction: "desc",
        nulls: "last",
      },
      {
        slot: "attribute:event.report.internalPk",
        direction: "desc",
        nulls: "last",
      },
    ]);
    const limited = builder.limit(sorted, limit + 1);
    builder.output(outputName, limited, [
      { name: "eventPk", slot: "attribute:event.report.internalPk" },
      { name: "eventId", slot: "attribute:event.report.localId" },
      { name: "eventName", slot: "attribute:event.report.eventName" },
      { name: "pathname", slot: "attribute:event.report.ownerPathname" },
    ]);
  };

  if (mode === "full") {
    builder.output(
      "full",
      events,
      SOURCE_ATTRIBUTES.map((attribute) => ({
        name: attribute,
        slot: `attribute:${attribute}`,
      })),
    );
  } else if (mode === "localId") {
    builder.output("localId", events, [
      {
        name: "eventId",
        slot: "attribute:event.report.localId",
      },
    ]);
  } else if (mode === "count") {
    addCount();
  } else {
    addCount();
    addPage("page");
  }
  return builder.finish();
}

function compileOutput(
  plan: ValidatedLogicalPlan,
  outputId: string,
  lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteIds: plan.context.subject.siteIds,
    time: plan.context.time,
  }),
) {
  const output = plan.outputs.find((candidate) => candidate.id === outputId);
  if (!output) throw new Error(`wave37a_output_missing:${outputId}`);
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  return compileD1Query(lowerLogicalPlan(relation), {
    tag: `test.wave37a.${outputId}`,
  });
}

async function executeOutput(
  database: DatabaseSync,
  plan: ValidatedLogicalPlan,
  outputId: string,
  lowerer?: AnalyticsLogicalToDbLowerer,
  trace?: SqliteD1Trace,
): Promise<Record<string, unknown>[]> {
  const query = compileOutput(plan, outputId, lowerer);
  return executeCompiledOutput(database, query, trace);
}

async function executeCompiledOutput(
  database: DatabaseSync,
  query: ReturnType<typeof compileD1Query>,
  trace?: SqliteD1Trace,
): Promise<Record<string, unknown>[]> {
  const result = await createD1DatabaseClient(
    createSqliteD1Database(database, trace),
  ).all(query);
  return result.results.map((row) => Object.fromEntries(Object.entries(row)));
}

function sitePrimaryKey(database: DatabaseSync, siteId: string): number {
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(siteId) as { readonly site_pk: number };
  return Number(row.site_pk);
}

function sqliteBindings(values: readonly unknown[]): SQLInputValue[] {
  return values.map((value) =>
    typeof value === "boolean" ? (value ? 1 : 0) : (value as SQLInputValue),
  );
}

function explainQueryPlan(
  database: DatabaseSync,
  sql: string,
  bindings: readonly unknown[] = [],
) {
  const rows = database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...sqliteBindings(bindings)) as {
    readonly id: number;
    readonly parent: number;
    readonly notused: number;
    readonly detail: string;
  }[];
  const details = rows.map((row) => row.detail);
  return {
    operationCount: details.length,
    indexedSearches: details.filter((detail) =>
      /\bSEARCH\b.*\bUSING (?:COVERING )?INDEX\b/u.test(detail),
    ),
    scans: details.filter((detail) => /\bSCAN\b/u.test(detail)),
    details,
    rowsRead: null,
    rowsReadNote:
      "SQLite EXPLAIN QUERY PLAN exposes access strategy, not Cloudflare D1 rows_read statistics.",
  } as const;
}

type FrozenPageSortKey = "occurredAt" | "eventName" | "pathname";
type FrozenPageSortDirection = "asc" | "desc";

interface FrozenPageSortRow {
  readonly eventPk: number;
  readonly eventId: string;
  readonly eventName: string;
  readonly occurredAt: number;
  readonly pathname: string;
}

interface Wave37AFixtureRecord {
  readonly eventId: string;
  readonly visitId: string;
  readonly sessionId: string;
  readonly nameId: number;
  readonly occurredAt: number;
  readonly pathname: string;
  readonly visitorId?: string;
  readonly title?: string;
  readonly hostname?: string;
  readonly browser?: string;
  readonly utmSource?: string;
  readonly utmMedium?: string;
}

interface Wave37AFilterFixtureRecord extends Wave37AFixtureRecord {
  readonly visitorId: string;
  readonly title: string;
  readonly browser: string;
}

/** Fixed SQL copied from the old event-record source/order contract. */
function frozenLegacyPageRows(
  database: DatabaseSync,
  siteId: string,
  sortKey: FrozenPageSortKey,
  direction: FrozenPageSortDirection,
  search?: string,
  predicate?: {
    readonly sql: string;
    readonly bindings: readonly unknown[];
  },
  limit?: number,
): FrozenPageSortRow[] {
  const query = buildFrozenLegacyPageQuery(
    database,
    siteId,
    sortKey,
    direction,
    search,
    predicate,
    limit,
  );
  return database
    .prepare(query.sql)
    .all(...query.bindings) as unknown as FrozenPageSortRow[];
}

function buildFrozenLegacyPageQuery(
  database: DatabaseSync,
  siteId: string,
  sortKey: FrozenPageSortKey,
  direction: FrozenPageSortDirection,
  search?: string,
  predicate?: {
    readonly sql: string;
    readonly bindings: readonly unknown[];
  },
  limit?: number,
): { readonly sql: string; readonly bindings: SQLInputValue[] } {
  const primarySort =
    sortKey === "eventName"
      ? `cen.name ${direction.toUpperCase()}`
      : sortKey === "pathname"
        ? `v.pathname ${direction.toUpperCase()}`
        : `ce.occurred_at ${direction.toUpperCase()},
           ce.event_id ${direction.toUpperCase()},
           ce.event_pk ${direction.toUpperCase()}`;
  const orderBy =
    sortKey === "occurredAt"
      ? primarySort
      : `${primarySort}, ce.occurred_at DESC, ce.event_id DESC, ce.event_pk DESC`;
  const searchClause = search
    ? ` AND (
         LOWER(TRIM(COALESCE(cen.name, ''))) LIKE ? ESCAPE '\\'
         OR LOWER(TRIM(COALESCE(ce.event_id, ''))) LIKE ? ESCAPE '\\'
         OR LOWER(TRIM(COALESCE(ce.visit_id, ''))) LIKE ? ESCAPE '\\'
         OR LOWER(TRIM(COALESCE(v.session_id, ''))) LIKE ? ESCAPE '\\'
         OR LOWER(TRIM(COALESCE(v.visitor_id, ''))) LIKE ? ESCAPE '\\'
         OR LOWER(TRIM(COALESCE(v.pathname, ''))) LIKE ? ESCAPE '\\'
         OR LOWER(TRIM(COALESCE(v.title, ''))) LIKE ? ESCAPE '\\'
         OR LOWER(TRIM(COALESCE(v.hostname, ''))) LIKE ? ESCAPE '\\'
       )`
    : "";
  const predicateClause = predicate ? ` AND (${predicate.sql})` : "";
  const bindings: SQLInputValue[] = [
    sitePrimaryKey(database, siteId),
    EVENT_RANGE.startMs,
    EVENT_RANGE.endExclusiveMs,
  ];
  if (search) {
    const escaped = search
      .toLowerCase()
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    const token = `%${escaped}%`;
    bindings.push(token, token, token, token, token, token, token, token);
  }
  if (predicate) bindings.push(...sqliteBindings(predicate.bindings));
  const limitClause = limit === undefined ? "" : " LIMIT ?";
  if (limit !== undefined) bindings.push(limit);
  const sql = `SELECT
         ce.event_pk AS eventPk,
         ce.event_id AS eventId,
         cen.name AS eventName,
         ce.occurred_at AS occurredAt,
         v.pathname AS pathname
       FROM custom_events ce
       INNER JOIN custom_event_names cen ON cen.id = ce.event_name_id
       INNER JOIN visits v
         ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
       WHERE ce.site_pk = ?
         AND ce.occurred_at >= ? AND ce.occurred_at < ?${searchClause}${predicateClause}
       ORDER BY ${orderBy}${limitClause}`;
  return { sql, bindings };
}

function addJsonScalarFact(
  database: DatabaseSync,
  site: Site,
  eventId: string,
  path: string,
  value: string | number | boolean | null,
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO custom_event_json_paths
       (site_id, path, last_seen_at, site_pk) VALUES (?, ?, 1, ?)`,
    )
    .run(site.id, path, site.pk);
  const pathRow = database
    .prepare(
      "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
    )
    .get(site.pk, path) as { readonly id: number };
  const event = database
    .prepare(
      `SELECT event_pk, event_name_id, occurred_at
       FROM custom_events WHERE event_id = ?`,
    )
    .get(eventId) as {
    readonly event_pk: number;
    readonly event_name_id: number;
    readonly occurred_at: number;
  };
  const nodeRow = database
    .prepare(
      "SELECT COALESCE(MAX(node_id), 0) + 1 AS node_id FROM custom_event_json_nodes WHERE event_pk = ?",
    )
    .get(event.event_pk) as { readonly node_id: number };
  const valueType =
    value === null
      ? 0
      : typeof value === "string"
        ? 1
        : typeof value === "number"
          ? 2
          : 3;
  const nodeId = Number(nodeRow.node_id);
  database
    .prepare(
      `INSERT INTO custom_event_json_nodes
       (event_pk, node_id, path_id, value_type, depth)
       VALUES (?, ?, ?, ?, 1)`,
    )
    .run(event.event_pk, nodeId, pathRow.id, valueType);
  database
    .prepare(
      `INSERT INTO custom_event_json_values (
         event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
         value_type, string_value, number_value, boolean_value, site_pk
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.event_pk,
      nodeId,
      site.id,
      event.event_name_id,
      pathRow.id,
      event.occurred_at,
      valueType,
      typeof value === "string" ? value : null,
      typeof value === "number" ? value : null,
      typeof value === "boolean" ? Number(value) : null,
      site.pk,
    );
}

function frozenPayloadPredicate(
  path: string,
  operator: "eq" | "gte" | "contains" | "isNull" | "isEmpty" | "exists",
  value?: string | number | boolean,
): { readonly sql: string; readonly bindings: readonly unknown[] } {
  const base = `EXISTS (
    SELECT 1
    FROM custom_event_json_values frozen_value
    INNER JOIN custom_event_json_paths frozen_path
      ON frozen_path.id = frozen_value.path_id
    WHERE frozen_value.event_pk = ce.event_pk
      AND frozen_value.site_pk = ce.site_pk
      AND frozen_path.site_pk = ce.site_pk
      AND frozen_path.path = ?`;
  if (operator === "exists") {
    return { sql: `${base})`, bindings: [path] };
  }
  if (operator === "isNull") {
    return {
      sql: `${base} AND frozen_value.value_type = 0)`,
      bindings: [path],
    };
  }
  if (operator === "isEmpty") {
    return {
      sql: `${base} AND frozen_value.value_type = 1 AND frozen_value.string_value = '')`,
      bindings: [path],
    };
  }
  if (operator === "gte") {
    return {
      sql: `${base} AND frozen_value.value_type = 2 AND frozen_value.number_value >= ?)`,
      bindings: [path, value],
    };
  }
  if (operator === "contains") {
    return {
      sql: `${base} AND frozen_value.value_type = 1 AND LOWER(frozen_value.string_value) LIKE ? ESCAPE '\\')`,
      bindings: [path, `%${String(value).toLowerCase()}%`],
    };
  }
  const valueType =
    typeof value === "string" ? 1 : typeof value === "boolean" ? 3 : 2;
  const valueColumn =
    typeof value === "string"
      ? "frozen_value.string_value"
      : typeof value === "boolean"
        ? "frozen_value.boolean_value"
        : "frozen_value.number_value";
  return {
    sql: `${base} AND frozen_value.value_type = ${valueType} AND ${valueColumn} = ?)`,
    bindings: [path, typeof value === "boolean" ? Number(value) : value],
  };
}

function frozenSessionBoundaryPredicate(
  kind: "entry" | "exit",
  path: string,
): { readonly sql: string; readonly bindings: readonly unknown[] } {
  const rank = kind === "entry" ? "entry_rank" : "exit_rank";
  const order = kind === "entry" ? "ASC" : "DESC";
  const boundary = kind === "entry" ? "entry_path" : "exit_path";
  return {
    sql: `(ce.site_pk, v.session_id) IN (
      SELECT site_pk, session_id FROM (
        SELECT site_pk, session_id,
          MAX(CASE WHEN ${rank} = 1 THEN pathname END) AS ${boundary}
        FROM (
          SELECT edge.site_pk, edge.session_id, edge.pathname,
            ROW_NUMBER() OVER (
              PARTITION BY edge.site_pk, edge.session_id
              ORDER BY edge.started_at ${order}, edge.visit_id ${order}
            ) AS ${rank}
          FROM visits edge
          WHERE TRIM(COALESCE(edge.site_pk, '')) != ''
            AND TRIM(COALESCE(edge.session_id, '')) != ''
        ) session_edges
        GROUP BY site_pk, session_id
      ) session_boundaries
      WHERE ${boundary} = ?
    )`,
    bindings: [path],
  };
}

function frozenVisitorSessionsPredicate(minimum: number): {
  readonly sql: string;
  readonly bindings: readonly unknown[];
} {
  return {
    sql: `EXISTS (
      SELECT 1 FROM visits fact_visit
      WHERE fact_visit.site_pk = v.site_pk
        AND fact_visit.visitor_id = v.visitor_id
        AND fact_visit.started_at >= ? AND fact_visit.started_at < ?
      GROUP BY fact_visit.site_pk, fact_visit.visitor_id
      HAVING COUNT(DISTINCT fact_visit.session_id) >= ?
    )`,
    bindings: [EVENT_RANGE.startMs, EVENT_RANGE.endExclusiveMs, minimum],
  };
}

function frozenAggregateFactPredicate(
  field: string,
  operator: "eq" | "gte",
  value: number | boolean,
): { readonly sql: string; readonly bindings: readonly unknown[] } {
  const facts: Record<
    string,
    { readonly sql: string; readonly bindings: readonly unknown[] }
  > = {
    "session.durationMs": {
      sql: `(SELECT COALESCE(SUM(COALESCE(fact_visit.duration_ms, 0)), 0)
            FROM visits fact_visit
            WHERE fact_visit.site_pk = v.site_pk
              AND fact_visit.session_id = v.session_id
              AND fact_visit.started_at >= ? AND fact_visit.started_at < ?)`,
      bindings: [EVENT_RANGE.startMs, EVENT_RANGE.endExclusiveMs],
    },
    "session.views": {
      sql: `(SELECT COUNT(*) FROM visits fact_visit
            WHERE fact_visit.site_pk = v.site_pk
              AND fact_visit.session_id = v.session_id
              AND fact_visit.started_at >= ? AND fact_visit.started_at < ?)`,
      bindings: [EVENT_RANGE.startMs, EVENT_RANGE.endExclusiveMs],
    },
    "session.events": {
      sql: `(SELECT COUNT(*) FROM custom_events fact_event
            INNER JOIN visits fact_owner
              ON fact_owner.site_pk = fact_event.site_pk
             AND fact_owner.visit_id = fact_event.visit_id
            WHERE fact_owner.site_pk = v.site_pk
              AND fact_owner.session_id = v.session_id
              AND fact_event.occurred_at >= ? AND fact_event.occurred_at < ?)`,
      bindings: [EVENT_RANGE.startMs, EVENT_RANGE.endExclusiveMs],
    },
    "session.bounce": {
      sql: `(CASE WHEN (SELECT COUNT(*) FROM visits fact_visit
            WHERE fact_visit.site_pk = v.site_pk
              AND fact_visit.session_id = v.session_id
              AND fact_visit.started_at >= ? AND fact_visit.started_at < ?) = 1
            THEN 1 ELSE 0 END)`,
      bindings: [EVENT_RANGE.startMs, EVENT_RANGE.endExclusiveMs],
    },
    "visitor.sessions": {
      sql: `(SELECT COUNT(DISTINCT fact_sessions.session_id)
            FROM (
              SELECT fact_visit.session_id FROM visits fact_visit
              WHERE fact_visit.site_pk = v.site_pk
                AND fact_visit.visitor_id = v.visitor_id
                AND fact_visit.started_at >= ? AND fact_visit.started_at < ?
                AND TRIM(COALESCE(fact_visit.session_id, '')) != ''
              UNION
              SELECT fact_owner.session_id FROM custom_events fact_event
              INNER JOIN visits fact_owner
                ON fact_owner.site_pk = fact_event.site_pk
               AND fact_owner.visit_id = fact_event.visit_id
              WHERE fact_owner.site_pk = v.site_pk
                AND fact_owner.visitor_id = v.visitor_id
                AND fact_event.occurred_at >= ? AND fact_event.occurred_at < ?
                AND TRIM(COALESCE(fact_owner.session_id, '')) != ''
            ) fact_sessions)`,
      bindings: [
        EVENT_RANGE.startMs,
        EVENT_RANGE.endExclusiveMs,
        EVENT_RANGE.startMs,
        EVENT_RANGE.endExclusiveMs,
      ],
    },
    "visitor.views": {
      sql: `(SELECT COUNT(*) FROM visits fact_visit
            WHERE fact_visit.site_pk = v.site_pk
              AND fact_visit.visitor_id = v.visitor_id
              AND fact_visit.started_at >= ? AND fact_visit.started_at < ?)`,
      bindings: [EVENT_RANGE.startMs, EVENT_RANGE.endExclusiveMs],
    },
    "visitor.events": {
      sql: `(SELECT COUNT(*) FROM custom_events fact_event
            INNER JOIN visits fact_owner
              ON fact_owner.site_pk = fact_event.site_pk
             AND fact_owner.visit_id = fact_event.visit_id
            WHERE fact_owner.site_pk = v.site_pk
              AND fact_owner.visitor_id = v.visitor_id
              AND fact_event.occurred_at >= ? AND fact_event.occurred_at < ?)`,
      bindings: [EVENT_RANGE.startMs, EVENT_RANGE.endExclusiveMs],
    },
  };
  const fact = facts[field];
  if (!fact) throw new Error(`Missing frozen fact SQL for ${field}`);
  return {
    sql: `${fact.sql} ${operator === "eq" ? "=" : ">="} ?`,
    bindings: [
      ...fact.bindings,
      typeof value === "boolean" ? Number(value) : value,
    ],
  };
}

function frozenSessionMembershipPredicate(predicate: {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}): { readonly sql: string; readonly bindings: readonly unknown[] } {
  const matchExpression = predicate.sql
    .replaceAll("ce.", "match_event.")
    .replaceAll("cen.", "match_name.")
    .replaceAll("v.", "match_owner.");
  return {
    sql: `(ce.site_pk, v.session_id) IN (
      SELECT match_owner.site_pk, match_owner.session_id
      FROM custom_events match_event
      INNER JOIN custom_event_names match_name
        ON match_name.id = match_event.event_name_id
      INNER JOIN visits match_owner
        ON match_owner.site_pk = match_event.site_pk
       AND match_owner.visit_id = match_event.visit_id
      WHERE match_event.site_pk = ce.site_pk
        AND match_event.occurred_at >= ? AND match_event.occurred_at < ?
        AND (${matchExpression})
    )`,
    bindings: [
      EVENT_RANGE.startMs,
      EVENT_RANGE.endExclusiveMs,
      ...predicate.bindings,
    ],
  };
}

function frozenVisitorMembershipPredicate(predicate: {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}): { readonly sql: string; readonly bindings: readonly unknown[] } {
  const matchExpression = predicate.sql
    .replaceAll("ce.", "match_event.")
    .replaceAll("cen.", "match_name.")
    .replaceAll("v.", "match_owner.");
  return {
    sql: `(ce.site_pk, v.visitor_id) IN (
      SELECT match_owner.site_pk, match_owner.visitor_id
      FROM custom_events match_event
      INNER JOIN custom_event_names match_name
        ON match_name.id = match_event.event_name_id
      INNER JOIN visits match_owner
        ON match_owner.site_pk = match_event.site_pk
       AND match_owner.visit_id = match_event.visit_id
      WHERE match_event.site_pk = ce.site_pk
        AND match_event.occurred_at >= ? AND match_event.occurred_at < ?
        AND TRIM(COALESCE(match_owner.visitor_id, '')) != ''
        AND (${matchExpression})
    )`,
    bindings: [
      EVENT_RANGE.startMs,
      EVENT_RANGE.endExclusiveMs,
      ...predicate.bindings,
    ],
  };
}

function frozenPreparedIdentityPredicate(
  kind: "event" | "visit" | "session" | "visitor",
  identities: readonly { readonly siteId: string; readonly id: string }[],
  database: DatabaseSync,
): { readonly sql: string; readonly bindings: readonly unknown[] } {
  if (identities.length === 0) return { sql: "0", bindings: [] };
  const identityColumn =
    kind === "event"
      ? "ce.event_id"
      : kind === "visit"
        ? "ce.visit_id"
        : kind === "session"
          ? "v.session_id"
          : "v.visitor_id";
  return {
    sql: `(ce.site_pk, ${identityColumn}) IN (VALUES ${identities
      .map(() => "(?, ?)")
      .join(", ")})`,
    bindings: identities.flatMap((identity) => [
      sitePrimaryKey(database, identity.siteId),
      identity.id,
    ]),
  };
}

function frozenCursorForRow(
  row: FrozenPageSortRow,
  sortKey: FrozenPageSortKey,
): {
  readonly sortValue?: string | number;
  readonly occurredAt: number;
  readonly eventId: string;
  readonly eventPk: number;
} {
  return sortKey === "occurredAt"
    ? {
        occurredAt: row.occurredAt,
        eventId: row.eventId,
        eventPk: row.eventPk,
      }
    : {
        sortValue: sortKey === "eventName" ? row.eventName : row.pathname,
        occurredAt: row.occurredAt,
        eventId: row.eventId,
        eventPk: row.eventPk,
      };
}

/** Fixed pre-page-factory SQL oracle; it never calls the new Source factory. */
function legacyPreparedSessionEventOracle(
  database: DatabaseSync,
  siteId: string,
  eventName: string,
  minimumEvents: number,
): string[] {
  const sitePk = sitePrimaryKey(database, siteId);
  const rows = database
    .prepare(
      `SELECT ce.event_id AS eventId
       FROM custom_events ce
       INNER JOIN custom_event_names cen ON cen.id = ce.event_name_id
       INNER JOIN visits owner
         ON owner.site_pk = ce.site_pk AND owner.visit_id = ce.visit_id
       WHERE ce.site_pk = ?
         AND ce.occurred_at >= ? AND ce.occurred_at < ?
         AND TRIM(COALESCE(cen.name, '')) = ?
         AND (
           SELECT COUNT(*)
           FROM custom_events session_event
           INNER JOIN custom_event_names session_name
             ON session_name.id = session_event.event_name_id
           INNER JOIN visits session_owner
             ON session_owner.site_pk = session_event.site_pk
            AND session_owner.visit_id = session_event.visit_id
           WHERE session_owner.site_pk = owner.site_pk
             AND session_owner.session_id = owner.session_id
             AND session_event.occurred_at >= ?
             AND session_event.occurred_at < ?
         ) >= ?
       ORDER BY ce.occurred_at DESC, ce.event_id DESC, ce.event_pk DESC`,
    )
    .all(
      sitePk,
      EVENT_RANGE.startMs,
      EVENT_RANGE.endExclusiveMs,
      eventName.trim(),
      EVENT_RANGE.startMs,
      EVENT_RANGE.endExclusiveMs,
      minimumEvents,
    ) as { readonly eventId: string }[];
  return rows.map((row) => row.eventId);
}

/** Static old projection used to preserve its direct-field failure contract. */
function frozenDirectFieldSql(column: string): string {
  return `
WITH event_source AS (
  SELECT
    ce.event_pk, ce.event_id, cen.name AS event_name,
    ce.occurred_at, ce.received_at, ce.sequence,
    ce.node_count, ce.value_count, v.visitor_id, v.session_id,
    v.pathname, v.title, v.hostname, v.referrer_host,
    v.country, v.region, v.city, v.browser, v.browser_version,
    v.os, v.os_version, v.device_type
  FROM custom_events ce
  INNER JOIN custom_event_names cen ON cen.id = ce.event_name_id
  INNER JOIN visits v
    ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
  WHERE ce.site_pk = ${sitePrimaryKeySql("?")}
    AND ce.occurred_at >= ? AND ce.occurred_at < ?
)
SELECT event_id FROM event_source es WHERE es.${column} = ?`;
}

function sitePrimaryKeySql(siteIdExpression: string): string {
  return `(
    SELECT site_pk FROM site_identities WHERE site_id = ${siteIdExpression}
  )`;
}

/** Frozen legacy source plus JS substring semantics preserve isolated UTF-16 units. */
function legacyGroupedContainsOracle(
  database: DatabaseSync,
  values: readonly string[],
): string[] {
  const rows = database
    .prepare(
      `SELECT ce.event_id AS eventId
       , v.title AS title
       FROM custom_events ce
       INNER JOIN custom_event_names cen ON cen.id = ce.event_name_id
       INNER JOIN visits v
         ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
       WHERE ce.site_pk = ?
         AND ce.occurred_at >= ? AND ce.occurred_at < ?
       ORDER BY ce.occurred_at DESC, ce.event_id DESC, ce.event_pk DESC`,
    )
    .all(
      sitePrimaryKey(database, SITE_A),
      EVENT_RANGE.startMs,
      EVENT_RANGE.endExclusiveMs,
    ) as { readonly eventId: string; readonly title: string | null }[];
  return rows
    .filter((row) =>
      values.some((value) =>
        String(row.title ?? "")
          .toLowerCase()
          .includes(value.toLowerCase()),
      ),
    )
    .map((row) => row.eventId);
}

interface QueryMetrics {
  readonly sqlBytes: number;
  readonly bindings: number;
  readonly physicalPlanHash: string | null;
  readonly nativeRowRelations: number;
  readonly jsonRowRelations: number;
}

interface ScopedPageEvidence {
  readonly label: string;
  readonly frozenCompiledPage: {
    readonly sqlBytes: number;
    readonly bindings: number;
    readonly statementCount: number;
    readonly explain: ExplainIndexEvidence;
  };
  readonly scopedPage: QueryMetrics & {
    readonly statementCount: number;
    readonly explain: ExplainIndexEvidence;
  };
}

interface ExplainIndexEvidence {
  readonly operationCount: number;
  readonly indexedSearches: readonly string[];
  readonly scans: readonly string[];
  readonly rowsRead: null;
  readonly rowsReadNote: string;
}

const scopedPageEvidence: ScopedPageEvidence[] = [];

function compactExplainEvidence(
  explain: ReturnType<typeof explainQueryPlan>,
): ExplainIndexEvidence {
  const indexedByName = new Map<string, string>();
  for (const detail of explain.indexedSearches) {
    const name = detail.match(/\bUSING (?:COVERING )?INDEX ([^ (]+)/u)?.[1];
    if (name && !indexedByName.has(name)) indexedByName.set(name, detail);
  }
  return {
    operationCount: explain.operationCount,
    indexedSearches: [...indexedByName.values()],
    scans: [...new Set(explain.scans)],
    rowsRead: null,
    rowsReadNote: explain.rowsReadNote,
  };
}

function queryMetrics(query: ReturnType<typeof compileD1Query>): QueryMetrics {
  const shape = query.physicalPlanShape;
  const payload = shape
    ? JSON.stringify(
        shape.version === 1
          ? [
              "d1-query-shape-v1",
              query.sql,
              shape.cteCount,
              shape.directScanProjectionCount,
              shape.nativeMembershipCount,
              shape.jsonMembershipCount,
            ]
          : [
              "d1-query-shape-v2",
              query.sql,
              shape.cteCount,
              shape.directScanProjectionCount,
              shape.nativeMembershipCount,
              shape.jsonMembershipCount,
              shape.nativeRowRelationCount,
              shape.jsonRowRelationCount,
            ],
      )
    : undefined;
  return {
    sqlBytes: new TextEncoder().encode(query.sql).byteLength,
    bindings: query.bindings?.length ?? 0,
    physicalPlanHash: payload
      ? `v${shape!.version}:${createHash("sha256").update(payload, "utf8").digest("hex")}`
      : null,
    nativeRowRelations: shape?.version === 2 ? shape.nativeRowRelationCount : 0,
    jsonRowRelations: shape?.version === 2 ? shape.jsonRowRelationCount : 0,
  };
}

function recordScopedPageEvidence(input: {
  readonly label: string;
  readonly database: DatabaseSync;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan?: ScopedFilterPlan;
  readonly search?: string;
  readonly eventName?: string;
  readonly statementCount: number;
}): void {
  const options = {
    limit: 50,
    sort: { key: "occurredAt", direction: "desc" } as const,
    ...(input.search === undefined ? {} : { search: input.search }),
    ...(input.eventName === undefined ? {} : { eventName: input.eventName }),
  };
  const plan = buildEventRecordPagePlan({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    options,
  });
  const scopedQuery = compileOutput(plan, "event-record-page");
  const legacyQuery = buildCompiledLegacyPageQuery({
    database: input.database,
    siteId: input.siteId,
    filters: input.filters,
    queryTime: input.queryTime,
    scopePlan: input.scopePlan,
    eventName: input.eventName,
    limit: options.limit + 1,
  });
  const scopedExplain = explainQueryPlan(
    input.database,
    scopedQuery.sql,
    scopedQuery.bindings ?? [],
  );
  const legacyExplain = explainQueryPlan(
    input.database,
    legacyQuery.sql,
    legacyQuery.bindings,
  );
  expect(input.statementCount, input.label).toBe(1);
  expect(scopedExplain.indexedSearches, input.label).not.toHaveLength(0);
  expect(legacyExplain.indexedSearches, input.label).not.toHaveLength(0);
  scopedPageEvidence.push({
    label: input.label,
    frozenCompiledPage: {
      sqlBytes: new TextEncoder().encode(legacyQuery.sql).byteLength,
      bindings: legacyQuery.bindings.length,
      statementCount: 1,
      explain: compactExplainEvidence(legacyExplain),
    },
    scopedPage: {
      ...queryMetrics(scopedQuery),
      statementCount: input.statementCount,
      explain: compactExplainEvidence(scopedExplain),
    },
  });
}

function buildCompiledLegacyPageQuery(input: {
  readonly database: DatabaseSync;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan?: ScopedFilterPlan;
  readonly eventName?: string;
  readonly limit: number;
}): { readonly sql: string; readonly bindings: SQLInputValue[] } {
  const scopePlan =
    input.scopePlan ?? scopedFilterMetadata(input.filters)?.plan;
  if (!scopePlan) throw new Error("wave37b_legacy_scope_plan_missing");
  const dataset = compileScopedDatasetSql({
    filters: input.filters,
    plan: scopePlan,
    siteIds: [input.siteId],
    window: {
      startMs: input.queryTime.range.startMs,
      endExclusiveMs: input.queryTime.range.endExclusiveMs,
      nowMs: input.queryTime.capturedAtMs,
      timeZone: input.queryTime.reportingTimeZone,
    },
  });
  const eventNameClause = input.eventName?.trim()
    ? "AND TRIM(COALESCE(event_name, '')) = ?"
    : "";
  return {
    sql: `WITH ${dataset.ctes}
       SELECT event_pk AS eventPk, event_id AS eventId,
              event_name AS eventName, occurred_at AS occurredAt,
              pathname AS pathname
       FROM ${dataset.eventRelation}
       WHERE site_pk = ? ${eventNameClause}
       ORDER BY occurred_at DESC, event_id DESC, event_pk DESC
       LIMIT ?`,
    bindings: [
      ...dataset.bindings.map(({ value }) => value),
      sitePrimaryKey(input.database, input.siteId),
      ...(input.eventName?.trim() ? [input.eventName.trim()] : []),
      input.limit,
    ],
  };
}

function compiledLegacyPageRows(input: {
  readonly database: DatabaseSync;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan?: ScopedFilterPlan;
  readonly eventName?: string;
  readonly limit: number;
}): FrozenPageSortRow[] {
  const query = buildCompiledLegacyPageQuery(input);
  return input.database
    .prepare(query.sql)
    .all(...query.bindings) as unknown as FrozenPageSortRow[];
}

let fixture: Fixture;

beforeAll(() => {
  fixture = createBaseFixture();
});

afterAll(() => {
  if (scopedPageEvidence.length > 0) {
    console.info(
      `[wave37a scoped page query evidence] ${JSON.stringify(scopedPageEvidence)}`,
    );
  }
  fixture.db.close();
});

describe("Wave37A event record scoped Source regressions", () => {
  it("reports the complete direct-profile scalar availability matrix from the frozen projection", async () => {
    const fields = [...analyticsFilterRegistry.values()].filter(
      (field) =>
        field.valueKind !== "json-scalar" &&
        field.observationKinds.has("event"),
    );
    const expectedCandidateIds = new Set(fields.map((field) => field.id));
    const expectedAvailable = fields
      .filter((field) => FROZEN_DIRECT_AVAILABLE_FIELDS.has(field.id))
      .map((field) => field.id)
      .sort();
    const expectedUnavailable = fields
      .filter((field) => !FROZEN_DIRECT_AVAILABLE_FIELDS.has(field.id))
      .map((field) => field.id)
      .sort();
    expect(
      [...FROZEN_DIRECT_AVAILABLE_FIELDS].every((id) =>
        expectedCandidateIds.has(id),
      ),
    ).toBe(true);

    const actualAvailable: string[] = [];
    const actualUnavailable: string[] = [];
    const failureDetails: Record<string, string> = {};
    for (const field of fields) {
      const value =
        field.valueKind === "boolean"
          ? false
          : field.valueKind === "number" ||
              field.valueKind === "date" ||
              field.valueKind === "datetime"
            ? 1
            : "wave37a-probe";
      const filters = filtersFor(fieldCondition(field.id, "eq", value));
      try {
        await queryEventRecordPageFromD1(
          { DB: createSqliteD1Database(fixture.db) } as unknown as Env,
          SITE_A,
          WINDOW,
          filters,
          { limit: 2, sort: { key: "occurredAt", direction: "desc" } },
        );
        actualAvailable.push(field.id);
      } catch (error) {
        actualUnavailable.push(field.id);
        failureDetails[field.id] = String(error);
      }
    }
    actualAvailable.sort();
    actualUnavailable.sort();
    console.info(
      `[wave37a direct matrix] ${JSON.stringify({
        candidateCount: fields.length,
        availableCount: expectedAvailable.length,
        available: expectedAvailable,
        unavailableCount: expectedUnavailable.length,
        unavailable: expectedUnavailable,
        observedAvailableCount: actualAvailable.length,
        observedUnavailableCount: actualUnavailable.length,
        failureDetails,
      })}`,
    );
    expect(actualAvailable).toEqual(expectedAvailable);
    expect(actualUnavailable).toEqual(expectedUnavailable);
  });

  it("keeps a prepared name gate out of the Session fact universe", async () => {
    const prepared = makePreparedSelection({
      authorizationSites: [fixture.sites.a],
      filters: filtersFor(fieldCondition("session.events", "gte", 2)),
      scopePreference: "session",
      eventName: " target_event ",
    });
    const expected = legacyPreparedSessionEventOracle(
      fixture.db,
      SITE_A,
      " target_event ",
      2,
    );
    expect(expected).toEqual(["event-a-target"]);
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    await expect(
      queryEventRecordPageFromD1(
        { DB: createSqliteD1Database(fixture.db, trace) } as unknown as Env,
        SITE_A,
        WINDOW,
        prepared.filters,
        {
          limit: 20,
          sort: { key: "occurredAt", direction: "desc" },
          eventName: " target_event ",
          scopePlan: prepared.scopePlan,
          queryTime: prepared.queryTime,
        },
      ),
    ).resolves.toMatchObject({ rows: [{ eventId: expected[0] }] });
    recordScopedPageEvidence({
      label: "prepared-name-gate-after-session-fact",
      database: fixture.db,
      siteId: SITE_A,
      filters: prepared.filters,
      queryTime: prepared.queryTime,
      scopePlan: prepared.scopePlan,
      eventName: " target_event ",
      statementCount: trace.preparedSql.length,
    });
  });

  it.each([
    ["user.id", "user_id", "x"],
    ["geo.isEU", "is_eu", true],
    ["page.durationMs", "duration_ms", 1],
  ] as const)(
    "retains the frozen direct projection failure for %s",
    async (field, oldColumn, value) => {
      const filters = filtersFor(fieldCondition(field, "eq", value));
      expect(() =>
        fixture.db
          .prepare(frozenDirectFieldSql(oldColumn))
          .all(
            sitePrimaryKey(fixture.db, SITE_A),
            120,
            130,
            typeof value === "boolean" ? Number(value) : value,
          ),
      ).toThrow(`no such column: es.${oldColumn}`);
      await expect(
        queryEventRecordPageFromD1(
          { DB: createSqliteD1Database(fixture.db) } as unknown as Env,
          SITE_A,
          WINDOW,
          filters,
          { limit: 20, sort: { key: "occurredAt", direction: "desc" } },
        ),
      ).rejects.toThrow(
        /missing_dependency|not supplied by the current scope/u,
      );
    },
  );

  it("preserves legacy OR-eight contains behavior for an isolated surrogate", async () => {
    fixture.db.prepare("UPDATE visits SET title = ?").run("\uFFFD");
    const values = [
      "\uD800",
      "zzz1",
      "zzz2",
      "zzz3",
      "zzz4",
      "zzz5",
      "zzz6",
      "zzz7",
    ];
    const filters = filtersFor({
      kind: "or",
      children: values.map((value) => ({
        kind: "condition",
        target: { kind: "field", field: "page.title" as never },
        operator: "contains",
        value,
      })),
    });
    expect(legacyGroupedContainsOracle(fixture.db, values)).toEqual([]);
    await expect(
      queryEventRecordPageFromD1(
        { DB: createSqliteD1Database(fixture.db) } as unknown as Env,
        SITE_A,
        WINDOW,
        filters,
        { limit: 20, sort: { key: "occurredAt", direction: "desc" } },
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("preserves OR-eight contains semantics for prepared entity scope", async () => {
    const values = [
      "\uD800",
      "zzz1",
      "zzz2",
      "zzz3",
      "zzz4",
      "zzz5",
      "zzz6",
      "zzz7",
    ];
    const filters = filtersFor({
      kind: "and",
      children: [
        fieldCondition("session.events", "gte", 1),
        {
          kind: "or",
          children: values.map((value) => ({
            kind: "condition",
            target: { kind: "field", field: "page.title" as never },
            operator: "contains",
            value,
          })),
        },
      ],
    });
    const prepared = makePreparedSelection({
      authorizationSites: [fixture.sites.a],
      filters,
      scopePreference: "session",
    });
    expect(prepared.scopePlan.mode).toBe("entity");
    expect(prepared.selection.mode).toBe("entity");
    expect(legacyGroupedContainsOracle(fixture.db, values)).toEqual([]);
    await expect(
      queryEventRecordPageFromD1(
        { DB: createSqliteD1Database(fixture.db) } as unknown as Env,
        SITE_A,
        WINDOW,
        prepared.filters,
        {
          limit: 20,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: prepared.scopePlan,
          queryTime: prepared.queryTime,
        },
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("keeps selected Event Source membership across full, count, localId, and count+page outputs", async () => {
    const identities = [
      { siteId: SITE_A, id: "session-collision" },
      { siteId: SITE_B, id: "session-collision" },
      { siteId: SITE_C, id: "session-collision" },
      { siteId: SITE_A, id: "session-collision" },
    ];
    const selection = makePreparedSelection({
      authorizationSites: [fixture.sites.a, fixture.sites.b, fixture.sites.c],
      subjectSites: [fixture.sites.a, fixture.sites.b],
      filters: filtersFor(fieldCondition("session.events", "gte", 1)),
      scopePreference: "session",
      eventName: "target_event",
      advancedMatches: { entityIds: identities },
    });
    const expected = ["event-a-target", "event-b-target"];
    const modes: readonly ProbeMode[] = [
      "full",
      "count",
      "localId",
      "count+page",
    ];
    const outcomes: Record<string, unknown> = {};
    for (const mode of modes) {
      const plan = buildSourceDomainProbe(selection, mode, 1);
      const outputNames = mode === "count+page" ? ["count", "page"] : [mode];
      for (const outputName of outputNames) {
        try {
          const rows = await executeOutput(fixture.db, plan, outputName);
          outcomes[`${mode}:${outputName}`] =
            outputName === "full"
              ? rows
                  .map((row) => ({
                    eventId: row["event.report.localId"],
                    eventName: row["event.report.eventName"],
                    pathname: row["event.report.ownerPathname"],
                  }))
                  .sort((left, right) =>
                    String(left.eventId).localeCompare(String(right.eventId)),
                  )
              : outputName === "page"
                ? rows
                    .map((row) => row.eventId)
                    .sort((left, right) =>
                      String(left).localeCompare(String(right)),
                    )
                : outputName === "localId"
                  ? rows
                      .map((row) => row.eventId)
                      .sort((left, right) =>
                        String(left).localeCompare(String(right)),
                      )
                  : rows;
        } catch (error) {
          outcomes[`${mode}:${outputName}`] = String(error);
        }
      }
    }
    expect(outcomes).toEqual({
      "full:full": [
        {
          eventId: expected[0],
          eventName: "target_event",
          pathname: "/landing",
        },
        {
          eventId: expected[1],
          eventName: "target_event",
          pathname: "/landing",
        },
      ],
      "count:count": [{ count: 2 }],
      "localId:localId": expected,
      "count+page:count": [{ count: 2 }],
      "count+page:page": expected,
    });
  });

  it("matches prepared identities using SQLite's replacement for isolated UTF-16 surrogates", async () => {
    const identities = [
      {
        id: "wave37a-high-surrogate-\uD800",
        storedSessionId: "wave37a-high-surrogate-\uFFFD",
        eventId: "wave37a-surrogate-high-event",
      },
      {
        id: "wave37a-low-surrogate-\uDC00",
        storedSessionId: "wave37a-low-surrogate-\uFFFD",
        eventId: "wave37a-surrogate-low-event",
      },
      {
        id: "wave37a-valid-pair-😀",
        storedSessionId: "wave37a-valid-pair-😀",
        eventId: "wave37a-surrogate-pair-event",
      },
    ] as const;
    for (const [index, identity] of identities.entries()) {
      const visitId = `wave37a-surrogate-visit-${index}`;
      addVisit(fixture.db, fixture.sites.a, {
        id: visitId,
        sessionId: identity.storedSessionId,
      });
      addEvent(fixture.db, fixture.sites.a, {
        id: identity.eventId,
        visitId,
        nameId: fixture.names.a,
      });
    }

    const prepared = makePreparedSelection({
      authorizationSites: [fixture.sites.a],
      filters: filtersFor(fieldCondition("session.events", "gte", 1)),
      scopePreference: "session",
      eventName: "target_event",
      advancedMatches: {
        entityIds: identities.map(({ id }) => ({ siteId: SITE_A, id })),
      },
    });
    expect(
      prepared.selection.preparedMatches?.identities.map(({ id }) => id),
    ).toEqual(identities.map(({ id }) => id));

    const builder = new LogicalPlanBuilder(createDomainContext(prepared));
    const events = builder.source("event", {
      temporalDomain: "candidate",
      selection: prepared.selection,
    });
    builder.output("event-self", events, [{ name: "event", slot: "entity" }]);
    const plan = builder.finish();
    const output = plan.outputs.find(
      (candidate) => candidate.id === "event-self",
    )!;
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteIds: plan.context.subject.siteIds,
      time: plan.context.time,
    });
    const lowered = lowerer.lower(output);
    const relation = lowerer.projectOutput(lowered, [
      { name: "sitePk", slot: output.fields[0]!.slot, component: 0 },
      { name: "eventId", slot: output.fields[0]!.slot, component: 1 },
    ]);
    const rows = await executeCompiledOutput(
      fixture.db,
      compileD1Query(lowerLogicalPlan(relation)),
    );
    expect(rows.map((row) => row.eventId).sort()).toEqual(
      identities.map(({ eventId }) => eventId).sort(),
    );
    expect(rows.every((row) => row.sitePk === fixture.sites.a.pk)).toBe(true);
  });

  it("keeps CORE count unpaged and isolates A/B/A selections from mutable inputs", async () => {
    const mutableRootA: {
      kind: string;
      target: { kind: string; field: string };
      operator: string;
      value: string;
    } = {
      kind: "condition",
      target: { kind: "field", field: "page.path" },
      operator: "eq",
      value: "/cache-a",
    };
    const filterA = filtersFor(mutableRootA as FilterExpression);
    const selectionA = makePreparedSelection({
      authorizationSites: [fixture.sites.a],
      filters: filterA,
      scopePreference: "event",
      advancedMatches: {
        eventIds: [{ siteId: SITE_A, id: "event-cache-a" }],
      },
    });
    const selectionB = makePreparedSelection({
      authorizationSites: [fixture.sites.a],
      filters: filtersFor(fieldCondition("page.path", "eq", "/cache-b")),
      scopePreference: "event",
    });
    const builder = new LogicalPlanBuilder(createDomainContext(selectionA));
    const sourceA = builder.source("event", {
      temporalDomain: "candidate",
      attributes: ["event.report.localId"],
      selection: selectionA.selection,
    });
    const sourceB = builder.source("event", {
      temporalDomain: "candidate",
      attributes: ["event.report.localId"],
      selection: selectionB.selection,
    });
    builder.output("a", sourceA, [
      {
        name: "eventId",
        slot: "attribute:event.report.localId",
      },
    ]);
    builder.output("b", sourceB, [
      {
        name: "eventId",
        slot: "attribute:event.report.localId",
      },
    ]);
    const count = builder.aggregate(sourceA, {}, [
      { name: "rows", kind: "count-rows" },
    ]);
    builder.output("core-count", count, [{ name: "rows", slot: "rows" }]);

    // Mutate both caller-owned inputs after the selection has been snapshotted.
    mutableRootA.value = "/mutated-after-selection";
    const externalFilter = selectionA.filters as {
      root: {
        kind: string;
        target: { kind: string; field: string };
        operator: string;
        value: string;
      };
    };
    externalFilter.root.value = "/mutated-after-selection";
    const callerMatches = selectionA.mutablePlan.advancedMatches as {
      eventIds: Array<{ siteId: string; id: string }>;
    };
    callerMatches.eventIds[0]!.id = "event-cache-b";

    const plan = builder.finish();
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE_A,
      time: plan.context.time,
    });
    const runOutput = async (outputId: string) => {
      const query = compileOutput(plan, outputId, lowerer);
      const rows = await executeCompiledOutput(fixture.db, query);
      return rows;
    };
    const a1 = await runOutput("a");
    const b = await runOutput("b");
    const a2 = await runOutput("a");
    const countQuery = compileOutput(plan, "core-count", lowerer);
    expect(countQuery.sql).not.toMatch(/\bLIMIT\b/u);
    const countRows = await executeCompiledOutput(fixture.db, countQuery);
    expect(a1).toEqual([{ eventId: "event-cache-a" }]);
    expect(b).toEqual([{ eventId: "event-cache-b-a" }]);
    expect(a2).toEqual(a1);
    expect(countRows).toEqual([{ rows: 1 }]);
  });

  it("matches frozen legacy order, complete cursors, and all eight search fields", async () => {
    const site = addSite(fixture.db, "wave37a-cursor-search-site");
    const targetNameId = 7101;
    const otherNameId = 7102;
    const searchNameId = 7103;
    addName(fixture.db, site, targetNameId, "Tie Event");
    addName(fixture.db, site, otherNameId, "Other Event");
    addName(fixture.db, site, searchNameId, "needle-name");

    const records: readonly [Wave37AFixtureRecord, ...Wave37AFixtureRecord[]] =
      [
        {
          eventId: "wave37a-tie-a",
          visitId: "wave37a-tie-visit-a",
          sessionId: "wave37a-tie-session-a",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/tie",
        },
        {
          eventId: "wave37a-tie-b",
          visitId: "wave37a-tie-visit-b",
          sessionId: "wave37a-tie-session-b",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/tie",
        },
        {
          eventId: "wave37a-tie-c",
          visitId: "wave37a-tie-visit-c",
          sessionId: "wave37a-tie-session-c",
          nameId: otherNameId,
          occurredAt: 125,
          pathname: "/alpha",
        },
        {
          eventId: "wave37a-tie-d",
          visitId: "wave37a-tie-visit-d",
          sessionId: "wave37a-tie-session-d",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/tie",
        },
        {
          eventId: "wave37a-tie-e",
          visitId: "wave37a-tie-visit-e",
          sessionId: "wave37a-tie-session-e",
          nameId: targetNameId,
          occurredAt: 126,
          pathname: "/tie",
        },
        {
          eventId: "wave37a-tie-f",
          visitId: "wave37a-tie-visit-f",
          sessionId: "wave37a-tie-session-f",
          nameId: targetNameId,
          occurredAt: 124,
          pathname: "/tie",
        },
        {
          eventId: "needle-event-id",
          visitId: "wave37a-search-visit-id",
          sessionId: "wave37a-search-session-id",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/search-id",
        },
        {
          eventId: "wave37a-search-event-visit",
          visitId: "needle-visit-id",
          sessionId: "wave37a-search-session-visit",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/search-visit",
        },
        {
          eventId: "wave37a-search-event-session",
          visitId: "wave37a-search-visit-session",
          sessionId: "needle-session-id",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/search-session",
        },
        {
          eventId: "wave37a-search-event-visitor",
          visitId: "wave37a-search-visit-visitor",
          sessionId: "wave37a-search-session-visitor",
          visitorId: "needle-visitor-id",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/search-visitor",
        },
        {
          eventId: "wave37a-search-event-path",
          visitId: "wave37a-search-visit-path",
          sessionId: "wave37a-search-session-path",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/needle-path",
        },
        {
          eventId: "wave37a-search-event-title",
          visitId: "wave37a-search-visit-title",
          sessionId: "wave37a-search-session-title",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/search-title",
          title: "needle-title",
        },
        {
          eventId: "wave37a-search-event-hostname",
          visitId: "wave37a-search-visit-hostname",
          sessionId: "wave37a-search-session-hostname",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/search-hostname",
          hostname: "needle-hostname.test",
        },
        {
          eventId: "wave37a-search-event-percent",
          visitId: "wave37a-search-visit-percent",
          sessionId: "wave37a-search-session-percent",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/search-percent",
          title: "literal %_ marker",
        },
        {
          eventId: "wave37a-search-event-backslash",
          visitId: "wave37a-search-visit-backslash",
          sessionId: "wave37a-search-session-backslash",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/search-backslash",
          title: "slash\\marker",
        },
        {
          eventId: "wave37a-search-event-unicode",
          visitId: "wave37a-search-visit-unicode",
          sessionId: "wave37a-search-session-unicode",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/search-unicode",
          title: "東京 café",
        },
        {
          eventId: "wave37a-search-event-nul",
          visitId: "wave37a-search-visit-nul",
          sessionId: "wave37a-search-session-nul",
          nameId: targetNameId,
          occurredAt: 125,
          pathname: "/search-nul",
          title: "before\u0000after",
        },
        {
          eventId: "wave37a-search-event-name",
          visitId: "wave37a-search-visit-name",
          sessionId: "wave37a-search-session-name",
          nameId: searchNameId,
          occurredAt: 125,
          pathname: "/search-name",
        },
      ];

    const updateVisit = fixture.db.prepare(
      `UPDATE visits
       SET visitor_id = ?, pathname = ?, title = ?, hostname = ?
       WHERE visit_id = ?`,
    );
    for (const [index, row] of records.entries()) {
      addVisit(fixture.db, site, {
        id: row.visitId,
        sessionId: row.sessionId,
        startedAt: row.occurredAt,
        pathname: row.pathname,
        title: row.title ?? `Wave37A cursor title ${index}`,
      });
      updateVisit.run(
        row.visitorId ?? `wave37a-search-visitor-${index}`,
        row.pathname,
        row.title ?? `Wave37A cursor title ${index}`,
        row.hostname ?? `wave37a-search-host-${index}.test`,
        row.visitId,
      );
      addEvent(fixture.db, site, {
        id: row.eventId,
        visitId: row.visitId,
        nameId: row.nameId,
        occurredAt: row.occurredAt,
      });
    }

    const filters = filtersFor(null);
    const pageLimit = 4;
    const cursorRows = [] as string[];
    for (const sortKey of ["occurredAt", "eventName", "pathname"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        const expectedRows = frozenLegacyPageRows(
          fixture.db,
          site.id,
          sortKey,
          direction,
        );
        expect(expectedRows).toHaveLength(records.length);
        let cursor: ReturnType<typeof frozenCursorForRow> | null | undefined;
        let offset = 0;
        const actualEventIds: string[] = [];
        while (offset < expectedRows.length) {
          const page = await queryEventRecordPageFromD1(
            { DB: createSqliteD1Database(fixture.db) } as unknown as Env,
            site.id,
            WINDOW,
            filters,
            {
              limit: pageLimit,
              sort: { key: sortKey, direction },
              cursor,
            },
          );
          const expectedPage = expectedRows.slice(offset, offset + pageLimit);
          const expectedEventIds = expectedPage.map((row) => row.eventId);
          expect(page.rows.map((row) => row.eventId)).toEqual(expectedEventIds);
          actualEventIds.push(...page.rows.map((row) => row.eventId));
          const expectedNextCursor =
            offset + pageLimit < expectedRows.length
              ? frozenCursorForRow(
                  expectedRows[offset + pageLimit - 1]!,
                  sortKey,
                )
              : null;
          expect(page.nextCursor).toEqual(expectedNextCursor);
          cursor = page.nextCursor;
          offset += expectedPage.length;
        }
        expect(actualEventIds).toEqual(expectedRows.map((row) => row.eventId));
        cursorRows.push(`${sortKey}:${direction}:${actualEventIds.length}`);
      }
    }

    const searchCases = [
      ["needle-name", "wave37a-search-event-name"],
      ["needle-event-id", "needle-event-id"],
      ["needle-visit-id", "wave37a-search-event-visit"],
      ["needle-session-id", "wave37a-search-event-session"],
      ["needle-visitor-id", "wave37a-search-event-visitor"],
      ["needle-path", "wave37a-search-event-path"],
      ["needle-title", "wave37a-search-event-title"],
      ["needle-hostname", "wave37a-search-event-hostname"],
      ["%_", "wave37a-search-event-percent"],
      ["slash\\marker", "wave37a-search-event-backslash"],
      ["東京", "wave37a-search-event-unicode"],
      ["\u0000", "wave37a-search-event-nul"],
    ] as const;
    for (const [search, expectedEventId] of searchCases) {
      const expectedRows = frozenLegacyPageRows(
        fixture.db,
        site.id,
        "occurredAt",
        "desc",
        search,
      );
      const page = await queryEventRecordPageFromD1(
        { DB: createSqliteD1Database(fixture.db) } as unknown as Env,
        site.id,
        WINDOW,
        filters,
        {
          limit: 25,
          sort: { key: "occurredAt", direction: "desc" },
          search,
        },
      );
      const expectedIds = expectedRows.map((row) => row.eventId);
      expect(page.rows.map((row) => row.eventId)).toEqual(expectedIds);
      expect(expectedIds).toContain(expectedEventId);
      expect(page.nextCursor).toBeNull();
    }
    for (const search of ["", " "]) {
      const expectedRows = frozenLegacyPageRows(
        fixture.db,
        site.id,
        "occurredAt",
        "desc",
        search,
      );
      const page = await queryEventRecordPageFromD1(
        { DB: createSqliteD1Database(fixture.db) } as unknown as Env,
        site.id,
        WINDOW,
        filters,
        {
          limit: 25,
          sort: { key: "occurredAt", direction: "desc" },
          search,
        },
      );
      expect(page.rows.map((row) => row.eventId)).toEqual(
        expectedRows.map((row) => row.eventId),
      );
      expect(page.nextCursor).toBeNull();
    }
    console.info(
      `[wave37a frozen page matrix] ${JSON.stringify({
        sortCursorCases: cursorRows,
        searchFieldsAndSpecialCases: [
          ...searchCases.map(([search]) => search),
          "<empty>",
          "<whitespace>",
        ],
      })}`,
    );
  });

  it("matches the frozen page source across scalar, boundary, visitor, and seven payload facts", async () => {
    const site = addSite(fixture.db, "wave37a-filter-matrix-site");
    const targetNameId = 7211;
    const otherNameId = 7212;
    addName(fixture.db, site, targetNameId, "target_event");
    addName(fixture.db, site, otherNameId, "other_event");
    const records: readonly [
      Wave37AFilterFixtureRecord,
      ...Wave37AFilterFixtureRecord[],
    ] = [
      {
        eventId: "wave37a-filter-alpha",
        visitId: "wave37a-filter-alpha-current",
        sessionId: "wave37a-filter-session-shared-a",
        visitorId: "wave37a-filter-visitor-shared",
        nameId: targetNameId,
        occurredAt: 125,
        pathname: "/pricing",
        title: "Upgrade guide",
        browser: "Chrome",
        utmSource: "sponsored",
        utmMedium: "cpc",
      },
      {
        eventId: "wave37a-filter-beta",
        visitId: "wave37a-filter-beta-current",
        sessionId: "wave37a-filter-session-shared-b",
        visitorId: "wave37a-filter-visitor-shared",
        nameId: otherNameId,
        occurredAt: 125,
        pathname: "/checkout",
        title: "Checkout",
        browser: "Firefox",
        utmSource: "sponsored",
        utmMedium: "custom",
      },
      {
        eventId: "wave37a-filter-gamma",
        visitId: "wave37a-filter-gamma-current",
        sessionId: "wave37a-filter-session-gamma",
        visitorId: "wave37a-filter-visitor-gamma",
        nameId: targetNameId,
        occurredAt: 126,
        pathname: "/pricing",
        title: "Reference",
        browser: "Safari",
      },
    ];
    const updateVisit = fixture.db.prepare(
      `UPDATE visits SET visitor_id = ?, pathname = ?, title = ?,
         hostname = ?, browser = ?, utm_source = ?, utm_medium = ?
       WHERE visit_id = ?`,
    );
    for (const row of records) {
      addVisit(fixture.db, site, {
        id: row.visitId,
        sessionId: row.sessionId,
        startedAt: row.occurredAt,
        pathname: row.pathname,
        title: row.title,
      });
      updateVisit.run(
        row.visitorId,
        row.pathname,
        row.title,
        "matrix.example.test",
        row.browser,
        row.utmSource ?? "",
        row.utmMedium ?? "",
        row.visitId,
      );
      addEvent(fixture.db, site, {
        id: row.eventId,
        visitId: row.visitId,
        nameId: row.nameId,
        occurredAt: row.occurredAt,
      });
    }
    addVisit(fixture.db, site, {
      id: "wave37a-filter-alpha-entry",
      sessionId: records[0].sessionId,
      startedAt: 121,
      pathname: "/entry",
    });
    addVisit(fixture.db, site, {
      id: "wave37a-filter-alpha-exit",
      sessionId: records[0].sessionId,
      startedAt: 128,
      pathname: "/exit",
    });
    fixture.db
      .prepare("UPDATE visits SET visitor_id = ? WHERE visit_id IN (?, ?)")
      .run(
        records[0].visitorId,
        "wave37a-filter-alpha-entry",
        "wave37a-filter-alpha-exit",
      );
    fixture.db
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(20, "wave37a-filter-alpha-entry");
    fixture.db
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(100, records[0].visitId);
    fixture.db
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(60, "wave37a-filter-alpha-exit");
    addEvent(fixture.db, site, {
      id: "wave37a-filter-alpha-second",
      visitId: records[0].visitId,
      nameId: targetNameId,
      occurredAt: 126,
    });

    const alpha = records[0].eventId;
    const alphaSecond = "wave37a-filter-alpha-second";
    for (const [path, value] of [
      ["/plan", "pro"],
      ["/amount", 20],
      ["/enabled", true],
      ["/nullable", null],
      ["/empty", ""],
      ["/count", 2],
      ["/region", "west"],
    ] as const) {
      addJsonScalarFact(fixture.db, site, alpha, path, value);
      // The old session-scoped reader selects both events from a session when
      // either event matches. Keep the payload predicate true on both Events
      // so the fixed old SQL oracle and production page compare the same
      // two-row session result.
      addJsonScalarFact(fixture.db, site, alphaSecond, path, value);
    }
    addJsonScalarFact(fixture.db, site, records[1].eventId, "/plan", "free");
    addJsonScalarFact(fixture.db, site, records[1].eventId, "/amount", 10);

    const payload = (
      path: string,
      operator: string,
      value?: string | number | boolean,
    ): FilterExpression => ({
      kind: "condition",
      target: { kind: "event-payload", path: path as never },
      operator: operator as never,
      ...(value === undefined ? {} : { value }),
    });
    const combine = (
      kind: "and" | "or",
      predicates: readonly {
        readonly sql: string;
        readonly bindings: readonly unknown[];
      }[],
    ) => ({
      sql: predicates
        .map((predicate) => `(${predicate.sql})`)
        .join(` ${kind.toUpperCase()} `),
      bindings: predicates.flatMap((predicate) => predicate.bindings),
    });
    const runCase = async (
      name: string,
      expression: FilterExpression,
      oldPredicate: {
        readonly sql: string;
        readonly bindings: readonly unknown[];
      },
      scopePreference: "event" | "session" | "visitor" = "event",
      evidenceLabel?: string,
    ) => {
      const prepared = makePreparedSelection({
        authorizationSites: [site],
        filters: filtersFor(expression),
        scopePreference,
      });
      const expected = frozenLegacyPageRows(
        fixture.db,
        site.id,
        "occurredAt",
        "desc",
        undefined,
        oldPredicate,
        51,
      ).map((row) => row.eventId);
      expect(expected, name).not.toHaveLength(0);
      let actual: Awaited<ReturnType<typeof queryEventRecordPageFromD1>>;
      const trace: SqliteD1Trace | undefined = evidenceLabel
        ? { preparedSql: [], bindings: [] }
        : undefined;
      try {
        actual = await queryEventRecordPageFromD1(
          {
            DB: createSqliteD1Database(fixture.db, trace),
          } as unknown as Env,
          site.id,
          WINDOW,
          prepared.filters,
          {
            limit: 50,
            sort: { key: "occurredAt", direction: "desc" },
            scopePlan: prepared.scopePlan,
            queryTime: prepared.queryTime,
          },
        );
      } catch (error) {
        throw new Error(`${name}: public page query failed`, { cause: error });
      }
      expect(
        actual.rows.map((row) => row.eventId),
        name,
      ).toEqual(expected);
      expect(actual.nextCursor, name).toBeNull();
      if (evidenceLabel) {
        recordScopedPageEvidence({
          label: evidenceLabel,
          database: fixture.db,
          siteId: site.id,
          filters: prepared.filters,
          queryTime: prepared.queryTime,
          scopePlan: prepared.scopePlan,
          statementCount: trace?.preparedSql.length ?? 0,
        });
      }
      return expected;
    };

    await runCase(
      "ordinary pathname scalar",
      fieldCondition("page.path", "eq", "/pricing"),
      { sql: "v.pathname = ?", bindings: ["/pricing"] },
    );
    await runCase(
      "ordinary browser scalar",
      fieldCondition("client.browser", "eq", "Chrome"),
      { sql: "v.browser = ?", bindings: ["Chrome"] },
    );
    await runCase(
      "derived paid-search channel",
      fieldCondition("traffic.channel", "eq", "paid_search"),
      {
        sql: "LOWER(TRIM(COALESCE(v.utm_medium, ''))) IN ('cpc', 'ppc', 'paidsearch', 'paid-search')",
        bindings: [],
      },
    );
    const sevenFactExpressions = [
      payload("/plan", "eq", "pro"),
      payload("/amount", "gte", 15),
      payload("/enabled", "eq", true),
      payload("/nullable", "isNull"),
      payload("/empty", "isEmpty"),
      payload("/count", "gte", 2),
      payload("/region", "contains", "west"),
    ];
    const sevenFactOracle = combine("and", [
      frozenPayloadPredicate("/plan", "eq", "pro"),
      frozenPayloadPredicate("/amount", "gte", 15),
      frozenPayloadPredicate("/enabled", "eq", true),
      frozenPayloadPredicate("/nullable", "isNull"),
      frozenPayloadPredicate("/empty", "isEmpty"),
      frozenPayloadPredicate("/count", "gte", 2),
      frozenPayloadPredicate("/region", "contains", "west"),
    ]);

    const aggregateFactCases = [
      ["session.durationMs", "gte", 180, "session"],
      ["session.views", "gte", 3, "session"],
      ["session.events", "gte", 2, "session"],
      ["session.bounce", "eq", false, "session"],
      ["visitor.sessions", "gte", 2, "visitor"],
      ["visitor.views", "gte", 4, "visitor"],
      ["visitor.events", "gte", 3, "visitor"],
    ] as const;
    for (const [
      field,
      operator,
      value,
      scopePreference,
    ] of aggregateFactCases) {
      const expected = await runCase(
        `registered aggregate fact ${field}`,
        fieldCondition(field, operator, value),
        frozenAggregateFactPredicate(field, operator, value),
        scopePreference,
        field === "session.events" ? "fact-session.events" : undefined,
      );
      expect(expected).not.toHaveLength(0);
      expect(expected).toEqual(
        field.startsWith("session.")
          ? ["wave37a-filter-alpha-second", "wave37a-filter-alpha"]
          : [
              "wave37a-filter-alpha-second",
              "wave37a-filter-beta",
              "wave37a-filter-alpha",
            ],
      );
    }

    await runCase(
      "seven typed payload facts",
      { kind: "and", children: sevenFactExpressions },
      frozenSessionMembershipPredicate(sevenFactOracle),
      "session",
      "payload-seven-facts",
    );

    const planPro = frozenPayloadPredicate("/plan", "eq", "pro");
    const pathPricing = { sql: "v.pathname = ?", bindings: ["/pricing"] };
    await runCase(
      "AND across page scalar and payload fact",
      {
        kind: "and",
        children: [
          fieldCondition("page.path", "eq", "/pricing"),
          payload("/plan", "eq", "pro"),
        ],
      },
      frozenSessionMembershipPredicate(combine("and", [pathPricing, planPro])),
      "session",
    );
    await runCase(
      "OR across payload fact and Event scalar",
      {
        kind: "or",
        children: [
          payload("/plan", "eq", "pro"),
          fieldCondition("event.name", "eq", "other_event"),
        ],
      },
      frozenSessionMembershipPredicate(
        combine("or", [
          planPro,
          {
            sql: "TRIM(COALESCE(cen.name, '')) = ?",
            bindings: ["other_event"],
          },
        ]),
      ),
      "session",
    );
    await runCase(
      "NOT ordinary scalar",
      {
        kind: "not",
        child: fieldCondition("page.path", "eq", "/checkout"),
      },
      { sql: "NOT (v.pathname = ?)", bindings: ["/checkout"] },
    );

    const entryPath = frozenSessionBoundaryPredicate("entry", "/entry");
    await runCase(
      "Session entry boundary",
      fieldCondition("session.entryPath", "eq", "/entry"),
      entryPath,
      "session",
      "boundary-session.entryPath",
    );
    const exitPath = frozenSessionBoundaryPredicate("exit", "/exit");
    await runCase(
      "Session exit boundary",
      fieldCondition("session.exitPath", "eq", "/exit"),
      exitPath,
      "session",
    );

    await runCase(
      "visitor session fact to Session Event output",
      {
        kind: "and",
        children: [
          fieldCondition("visitor.sessions", "gte", 2),
          fieldCondition("event.name", "eq", "other_event"),
        ],
      },
      frozenVisitorMembershipPredicate(
        combine("and", [
          frozenVisitorSessionsPredicate(2),
          {
            sql: "TRIM(COALESCE(cen.name, '')) = ?",
            bindings: ["other_event"],
          },
        ]),
      ),
      "visitor",
    );

    const normalizerPaths = [
      "/pricing",
      "/checkout",
      "/absent-3",
      "/absent-4",
      "/absent-5",
      "/absent-6",
      "/absent-7",
      "/absent-8",
    ] as const;
    for (const memberCount of [7, 8] as const) {
      const values = normalizerPaths.slice(0, memberCount);
      await runCase(
        `real normalizer OR-${memberCount}`,
        {
          kind: "or",
          children: values.map((path) =>
            fieldCondition("page.path", "eq", path),
          ),
        },
        {
          sql: `v.pathname IN (${values.map(() => "?").join(", ")})`,
          bindings: values,
        },
      );
    }
  });

  it("keeps 48 payload predicates within budget and preserves cross-event Session membership", async () => {
    const site = addSite(fixture.db, "wave37b-payload-budget-site");
    const nameId = 7380;
    const sessionId = "wave37b-payload-budget-session";
    const eventIds = {
      complete: "wave37b-payload-budget-complete-event",
      missing: "wave37b-payload-budget-missing-event",
    } as const;
    addName(fixture.db, site, nameId, "target_event");
    for (const [suffix, eventId] of Object.entries(eventIds)) {
      const visitId = `wave37b-payload-budget-${suffix}-visit`;
      addVisit(fixture.db, site, { id: visitId, sessionId });
      addEvent(fixture.db, site, { id: eventId, visitId, nameId });
    }

    const paths = Array.from(
      { length: 48 },
      (_unused, index) => `/wave37b-budget-${index}`,
    );
    for (const [index, path] of paths.entries()) {
      addJsonScalarFact(fixture.db, site, eventIds.complete, path, true);
      if (index < paths.length - 1)
        addJsonScalarFact(fixture.db, site, eventIds.missing, path, true);
    }
    addJsonScalarFact(fixture.db, site, eventIds.complete, "/split-a", true);
    addJsonScalarFact(fixture.db, site, eventIds.missing, "/split-b", true);

    const payloadExists = (path: string): FilterExpression => ({
      kind: "condition",
      target: { kind: "event-payload", path: path as never },
      operator: "exists",
    });
    const wideFilters = filtersFor({
      kind: "and",
      children: paths.map(payloadExists),
    });
    const wideSelection = makePreparedSelection({
      authorizationSites: [site],
      filters: wideFilters,
      scopePreference: "event",
    });
    const wideLegacyRows = compiledLegacyPageRows({
      database: fixture.db,
      siteId: site.id,
      filters: wideSelection.filters,
      queryTime: wideSelection.queryTime,
      scopePlan: wideSelection.scopePlan,
      limit: 51,
    });
    expect(wideLegacyRows.map((row) => row.eventId)).toEqual([
      eventIds.complete,
    ]);
    const widePlan = buildEventRecordPagePlan({
      siteId: site.id,
      queryTime: wideSelection.queryTime,
      filters: wideSelection.filters,
      scopePlan: wideSelection.scopePlan,
      options: {
        limit: 50,
        sort: { key: "occurredAt", direction: "desc" },
      },
    });
    const wideOutput = widePlan.outputs.find(
      (output) => output.id === "event-record-page",
    );
    if (!wideOutput) throw new Error("wave37b_wide_page_output_missing");
    const wideTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const widePage = await queryEventRecordPageFromD1(
      {
        DB: createSqliteD1Database(fixture.db, wideTrace),
      } as unknown as Env,
      site.id,
      WINDOW,
      wideSelection.filters,
      {
        limit: 50,
        sort: { key: "occurredAt", direction: "desc" },
        scopePlan: wideSelection.scopePlan,
        queryTime: wideSelection.queryTime,
      },
    );
    expect(widePage.rows.map((row) => row.eventId)).toEqual(
      wideLegacyRows.map((row) => row.eventId),
    );
    expect(wideTrace.preparedSql).toHaveLength(1);
    const wideQuery = compileOutput(widePlan, "event-record-page");
    const wideMetrics = queryMetrics(wideQuery);
    expect(wideMetrics.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(wideMetrics.bindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    recordScopedPageEvidence({
      label: "payload-exists-48",
      database: fixture.db,
      siteId: site.id,
      filters: wideSelection.filters,
      queryTime: wideSelection.queryTime,
      scopePlan: wideSelection.scopePlan,
      statementCount: wideTrace.preparedSql.length,
    });

    const splitFilters = filtersFor({
      kind: "and",
      children: [payloadExists("/split-a"), payloadExists("/split-b")],
    });
    const splitSelection = makePreparedSelection({
      authorizationSites: [site],
      filters: splitFilters,
      scopePreference: "session",
    });
    const splitLegacyRows = compiledLegacyPageRows({
      database: fixture.db,
      siteId: site.id,
      filters: splitSelection.filters,
      queryTime: splitSelection.queryTime,
      scopePlan: splitSelection.scopePlan,
      limit: 51,
    });
    expect(splitLegacyRows.map((row) => row.eventId)).toEqual([
      eventIds.missing,
      eventIds.complete,
    ]);
    const splitTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const splitPage = await queryEventRecordPageFromD1(
      {
        DB: createSqliteD1Database(fixture.db, splitTrace),
      } as unknown as Env,
      site.id,
      WINDOW,
      splitSelection.filters,
      {
        limit: 50,
        sort: { key: "occurredAt", direction: "desc" },
        scopePlan: splitSelection.scopePlan,
        queryTime: splitSelection.queryTime,
      },
    );
    expect(splitPage.rows.map((row) => row.eventId)).toEqual(
      splitLegacyRows.map((row) => row.eventId),
    );
    expect(splitTrace.preparedSql).toHaveLength(1);
    recordScopedPageEvidence({
      label: "payload-cross-event-session-membership",
      database: fixture.db,
      siteId: site.id,
      filters: splitSelection.filters,
      queryTime: splitSelection.queryTime,
      scopePlan: splitSelection.scopePlan,
      statementCount: splitTrace.preparedSql.length,
    });
  });

  it("matches old prepared Event, Session, and Visitor identity filtering including weak owners", async () => {
    const a = addSite(fixture.db, "wave37a-prepared-identity-a");
    const b = addSite(fixture.db, "wave37a-prepared-identity-b");
    const c = addSite(fixture.db, "wave37a-prepared-identity-c");
    const names = { a: 7381, b: 7382, c: 7383, other: 7384 } as const;
    addName(fixture.db, a, names.a, "target_event");
    addName(fixture.db, b, names.b, "target_event");
    addName(fixture.db, c, names.c, "target_event");
    addName(fixture.db, a, names.other, "other_event");

    const localSessionId = "wave37a-prepared-session-collision";
    const sharedVisitorId = "wave37a-prepared-visitor-collision";
    const visitIds = {
      a: ["wave37a-prepared-a-valid", "wave37a-prepared-a-second"],
      b: ["wave37a-prepared-b-valid", "wave37a-prepared-b-second"],
      c: ["wave37a-prepared-c-valid"],
    } as const;
    for (const [site, ids] of [
      [a, visitIds.a],
      [b, visitIds.b],
      [c, visitIds.c],
    ] as const) {
      for (const visitId of ids) {
        addVisit(fixture.db, site, {
          id: visitId,
          sessionId: localSessionId,
          pathname: "/prepared-identity",
        });
        fixture.db
          .prepare("UPDATE visits SET visitor_id = ? WHERE visit_id = ?")
          .run(sharedVisitorId, visitId);
      }
    }

    const eventIds = {
      a: ["wave37a-prepared-a-event", "wave37a-prepared-a-second-event"],
      b: ["wave37a-prepared-b-event", "wave37a-prepared-b-second-event"],
      c: ["wave37a-prepared-c-event"],
    } as const;
    for (const { site, nameId, ids, visits } of [
      { site: a, nameId: names.a, ids: eventIds.a, visits: visitIds.a },
      { site: b, nameId: names.b, ids: eventIds.b, visits: visitIds.b },
      { site: c, nameId: names.c, ids: eventIds.c, visits: visitIds.c },
    ]) {
      ids.forEach((eventId, index) => {
        const visitId = visits[index];
        if (!visitId)
          throw new Error("Missing prepared identity fixture visit");
        addEvent(fixture.db, site, {
          id: eventId,
          visitId,
          nameId,
          occurredAt: 125 + index,
        });
      });
    }

    addVisit(fixture.db, a, {
      id: "wave37a-prepared-a-other-name-owner",
      sessionId: localSessionId,
    });
    fixture.db
      .prepare("UPDATE visits SET visitor_id = ? WHERE visit_id = ?")
      .run(sharedVisitorId, "wave37a-prepared-a-other-name-owner");
    addEvent(fixture.db, a, {
      id: "wave37a-prepared-a-other-name-event",
      visitId: "wave37a-prepared-a-other-name-owner",
      nameId: names.other,
    });
    addVisit(fixture.db, a, {
      id: "wave37a-prepared-a-time-low-owner",
      sessionId: localSessionId,
    });
    fixture.db
      .prepare("UPDATE visits SET visitor_id = ? WHERE visit_id = ?")
      .run(sharedVisitorId, "wave37a-prepared-a-time-low-owner");
    addEvent(fixture.db, a, {
      id: "wave37a-prepared-a-time-low-event",
      visitId: "wave37a-prepared-a-time-low-owner",
      nameId: names.a,
      occurredAt: EVENT_RANGE.startMs - 1,
    });
    addVisit(fixture.db, a, {
      id: "wave37a-prepared-a-time-high-owner",
      sessionId: localSessionId,
    });
    fixture.db
      .prepare("UPDATE visits SET visitor_id = ? WHERE visit_id = ?")
      .run(sharedVisitorId, "wave37a-prepared-a-time-high-owner");
    addEvent(fixture.db, a, {
      id: "wave37a-prepared-a-time-high-event",
      visitId: "wave37a-prepared-a-time-high-owner",
      nameId: names.a,
      occurredAt: EVENT_RANGE.endExclusiveMs,
    });

    const insertWeakEvent = fixture.db.prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, 125, 777, 1, 1, 1)`,
    );
    for (const [eventId, visitId] of [
      ["wave37a-prepared-a-orphan-event", "wave37a-prepared-no-owner"],
      ["wave37a-prepared-a-blank-owner-event", ""],
      // Foreign keys are disabled in this fixture: this row deliberately
      // points at a real visit whose site_pk belongs to B, not A.
      ["wave37a-prepared-a-cross-site-owner-event", visitIds.b[0]],
    ] as const) {
      insertWeakEvent.run(eventId, a.id, a.pk, visitId, names.a);
    }
    insertWeakEvent.run(
      "wave37a-prepared-a-raw-site-mismatch-event",
      b.id,
      a.pk,
      visitIds.a[0],
      names.a,
    );
    insertWeakEvent.run(
      "wave37a-prepared-a-missing-name-event",
      a.id,
      a.pk,
      visitIds.a[0],
      79999,
    );
    expect(
      fixture.db
        .prepare(
          "SELECT site_id, site_pk FROM custom_events WHERE event_id = ?",
        )
        .get("wave37a-prepared-a-raw-site-mismatch-event"),
    ).toEqual({ site_id: b.id, site_pk: a.pk });
    expect(
      fixture.db
        .prepare(
          "SELECT COUNT(*) AS count FROM custom_event_names WHERE id = ?",
        )
        .get(79999),
    ).toEqual({ count: 0 });

    const identitySites = [a, b, c] as const;
    const authorizationSites = [...identitySites];
    const subjectSites = [a, b] as const;
    const makeSelection = (
      scopePreference: "event" | "session" | "visitor",
      advancedMatches: NonNullable<ScopedFilterPlan["advancedMatches"]>,
    ) =>
      makePreparedSelection({
        authorizationSites,
        subjectSites,
        filters: filtersFor(null),
        scopePreference,
        advancedMatches,
      });
    const allEventIdentities = [
      ...eventIds.a.map((id) => ({ siteId: a.id, id })),
      ...eventIds.b.map((id) => ({ siteId: b.id, id })),
      ...eventIds.c.map((id) => ({ siteId: c.id, id })),
      { siteId: a.id, id: eventIds.a[0] },
      { siteId: a.id, id: "wave37a-prepared-a-other-name-event" },
      { siteId: a.id, id: "wave37a-prepared-a-time-low-event" },
      { siteId: a.id, id: "wave37a-prepared-a-time-high-event" },
      { siteId: a.id, id: "wave37a-prepared-a-orphan-event" },
      { siteId: a.id, id: "wave37a-prepared-a-blank-owner-event" },
      { siteId: a.id, id: "wave37a-prepared-a-cross-site-owner-event" },
      { siteId: a.id, id: "wave37a-prepared-a-raw-site-mismatch-event" },
      { siteId: a.id, id: "wave37a-prepared-a-missing-name-event" },
    ];
    const allSessionIdentities = identitySites.map((site) => ({
      siteId: site.id,
      id: localSessionId,
    }));
    const allVisitorIdentities = identitySites.map((site) => ({
      siteId: site.id,
      id: sharedVisitorId,
    }));
    const allVisitIdentities = [
      ...visitIds.a.map((id) => ({ siteId: a.id, id })),
      ...visitIds.b.map((id) => ({ siteId: b.id, id })),
      ...visitIds.c.map((id) => ({ siteId: c.id, id })),
      { siteId: a.id, id: visitIds.a[0] },
      { siteId: b.id, id: visitIds.a[0] },
      { siteId: a.id, id: "wave37a-prepared-a-other-name-owner" },
      { siteId: a.id, id: "wave37a-prepared-a-time-low-owner" },
      { siteId: a.id, id: "wave37a-prepared-a-time-high-owner" },
    ];

    const runPublicPage = async (
      kind: "event" | "visit" | "session" | "visitor",
      scopePreference: "event" | "session" | "visitor",
      identities: readonly { readonly siteId: string; readonly id: string }[],
      site: Site,
      empty = false,
      eventObservationIds: readonly {
        readonly siteId: string;
        readonly id: string;
      }[] = [],
      evidenceLabel?: string,
    ) => {
      const oracleKind = kind === "visit" ? "event" : kind;
      const oracleIdentities =
        kind === "visit" ? eventObservationIds : identities;
      const identityPredicate = frozenPreparedIdentityPredicate(
        oracleKind,
        oracleIdentities,
        fixture.db,
      );
      const expected = frozenLegacyPageRows(
        fixture.db,
        site.id,
        "occurredAt",
        "desc",
        undefined,
        empty ? { sql: "0", bindings: [] } : identityPredicate,
        51,
      ).map((row) => row.eventId);
      const advancedMatches =
        kind === "event"
          ? { eventIds: identities }
          : kind === "visit"
            ? { visitIds: identities, eventIds: eventObservationIds }
            : { entityIds: identities };
      const selection = makeSelection(scopePreference, advancedMatches);
      const trace: SqliteD1Trace | undefined = evidenceLabel
        ? { preparedSql: [], bindings: [] }
        : undefined;
      const page = await queryEventRecordPageFromD1(
        {
          DB: createSqliteD1Database(fixture.db, trace),
        } as unknown as Env,
        site.id,
        WINDOW,
        selection.filters,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: selection.scopePlan,
          queryTime: selection.queryTime,
        },
      );
      expect(page.rows.map((row) => row.eventId)).toEqual(expected);
      expect(page.nextCursor).toBeNull();
      if (evidenceLabel) {
        if (evidenceLabel === "prepared-session-small-row-identities") {
          expect(trace?.preparedSql[0]).not.toMatch(/json_each/u);
          const productionPlan = buildEventRecordPagePlan({
            siteId: site.id,
            queryTime: selection.queryTime,
            filters: selection.filters,
            scopePlan: selection.scopePlan,
            options: {
              limit: 50,
              sort: { key: "occurredAt", direction: "desc" },
            },
          });
          const compiled = compileOutput(productionPlan, "event-record-page");
          expect(compiled.physicalPlanShape).toMatchObject({
            version: 2,
            jsonRowRelationCount: 0,
          });
          expect(compiled.physicalPlanShape?.version).toBe(2);
          if (compiled.physicalPlanShape?.version === 2)
            expect(
              compiled.physicalPlanShape.nativeRowRelationCount,
            ).toBeGreaterThan(0);
        }
        recordScopedPageEvidence({
          label: evidenceLabel,
          database: fixture.db,
          siteId: site.id,
          filters: selection.filters,
          queryTime: selection.queryTime,
          scopePlan: selection.scopePlan,
          statementCount: trace?.preparedSql.length ?? 0,
        });
      }
      return expected;
    };

    const expectedA = [
      "wave37a-prepared-a-second-event",
      "wave37a-prepared-a-raw-site-mismatch-event",
      "wave37a-prepared-a-other-name-event",
      "wave37a-prepared-a-event",
    ];
    const expectedB = [
      "wave37a-prepared-b-second-event",
      "wave37a-prepared-b-event",
    ];
    const eventObservationIdsForVisits = [
      ...eventIds.a.map((id) => ({ siteId: a.id, id })),
      ...eventIds.b.map((id) => ({ siteId: b.id, id })),
      ...eventIds.c.map((id) => ({ siteId: c.id, id })),
    ];
    const expectedPreparedVisitsA = [eventIds.a[1], eventIds.a[0]];
    const expectedPreparedVisitsB = [eventIds.b[1], eventIds.b[0]];
    for (const kind of ["event", "visit", "session", "visitor"] as const) {
      const scopePreference = kind === "visit" ? "event" : kind;
      const identities =
        kind === "event"
          ? allEventIdentities
          : kind === "visit"
            ? allVisitIdentities
            : kind === "session"
              ? [...allSessionIdentities, allSessionIdentities[0]!]
              : [...allVisitorIdentities, allVisitorIdentities[0]!];
      expect(
        await runPublicPage(
          kind,
          scopePreference,
          identities,
          a,
          false,
          kind === "visit" ? eventObservationIdsForVisits : [],
          kind === "event"
            ? "advanced-prepared-event-identities"
            : kind === "session"
              ? "prepared-session-small-row-identities"
              : undefined,
        ),
      ).toEqual(kind === "visit" ? expectedPreparedVisitsA : expectedA);
      expect(
        await runPublicPage(
          kind,
          scopePreference,
          identities,
          b,
          false,
          kind === "visit" ? eventObservationIdsForVisits : [],
        ),
      ).toEqual(kind === "visit" ? expectedPreparedVisitsB : expectedB);
      expect(
        await runPublicPage(
          kind,
          scopePreference,
          [],
          a,
          true,
          [],
          kind === "session" ? "empty-prepared-session-identities" : undefined,
        ),
      ).toEqual([]);
    }

    const replacementSessionVisit = "wave37a-unpaired-session-owner";
    const replacementSessionEvent = "wave37a-unpaired-session-event";
    addVisit(fixture.db, a, {
      id: replacementSessionVisit,
      sessionId: "\ufffd",
    });
    addEvent(fixture.db, a, {
      id: replacementSessionEvent,
      visitId: replacementSessionVisit,
      nameId: names.a,
    });
    expect(
      await runPublicPage(
        "session",
        "session",
        [{ siteId: a.id, id: "\ud800" }],
        a,
      ),
    ).toEqual([replacementSessionEvent]);

    // The same visit local ID under B's site identity must not match A's
    // actual visit, even when both IDs appear in the prepared identity list.
    expect(
      await runPublicPage(
        "visit",
        "event",
        [{ siteId: b.id, id: visitIds.a[0] }],
        a,
        false,
        [],
      ),
    ).toEqual([]);

    // The production schema forbids NULL visit IDs, but a legacy/weak storage
    // row can still be represented in an isolated TEMP shadow with the same
    // source columns. Both the frozen INNER-owner reader and public page must
    // exclude an Event whose owner ID is NULL.
    fixture.db.exec(
      "CREATE TEMP TABLE visits AS SELECT * FROM main.visits WHERE 0; CREATE TEMP TABLE custom_events AS SELECT * FROM main.custom_events WHERE 0;",
    );
    try {
      const controlVisitId = "wave37a-null-owner-control-visit";
      const controlEventId = "wave37a-null-owner-control-event";
      fixture.db
        .prepare(
          `INSERT INTO temp.visits (
            visit_id, site_id, site_pk, visitor_id, session_id, status,
            started_at, last_activity_at, pathname, title, hostname
          ) VALUES (?, ?, ?, 'wave37a-null-control-visitor',
                    'wave37a-null-control-session', 'closed', 125, 125,
                    '/null-control', 'Null control', 'events.test')`,
        )
        .run(controlVisitId, a.id, a.pk);
      fixture.db
        .prepare(
          `INSERT INTO temp.custom_events (
            event_pk, event_id, site_id, site_pk, visit_id, event_name_id,
            occurred_at, received_at, sequence, node_count, value_count
          ) VALUES (900000001, ?, ?, ?, ?, ?, 125, 777, 1, 1, 1)`,
        )
        .run(controlEventId, a.id, a.pk, controlVisitId, names.a);
      fixture.db
        .prepare(
          `INSERT INTO temp.visits (
            visit_id, site_id, site_pk, visitor_id, session_id, status,
            started_at, last_activity_at, pathname, title, hostname
          ) VALUES (NULL, ?, ?, 'wave37a-null-visitor', 'wave37a-null-session',
                    'closed', 125, 125, '/null-owner', 'Null owner', 'events.test')`,
        )
        .run(a.id, a.pk);
      fixture.db
        .prepare(
          `INSERT INTO temp.custom_events (
            event_pk, event_id, site_id, site_pk, visit_id, event_name_id,
            occurred_at, received_at, sequence, node_count, value_count
          ) VALUES (900000002, ?, ?, ?, NULL, ?, 125, 777, 1, 1, 1)`,
        )
        .run("wave37a-prepared-null-visit-event", a.id, a.pk, names.a);
      expect(
        fixture.db
          .prepare(
            "SELECT COUNT(*) AS count FROM temp.visits WHERE visit_id IS NULL",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        await runPublicPage(
          "event",
          "event",
          [
            { siteId: a.id, id: controlEventId },
            { siteId: a.id, id: "wave37a-prepared-null-visit-event" },
          ],
          a,
        ),
      ).toEqual([controlEventId]);
      expect(
        await runPublicPage(
          "event",
          "event",
          [{ siteId: a.id, id: "wave37a-prepared-null-visit-event" }],
          a,
        ),
      ).toEqual([]);
    } finally {
      fixture.db.exec(
        "DROP TABLE IF EXISTS temp.custom_events; DROP TABLE IF EXISTS temp.visits;",
      );
    }

    const visitIdColumn = (
      fixture.db.prepare("PRAGMA table_info(custom_events)").all() as {
        readonly name: string;
        readonly notnull: number;
      }[]
    ).find((column) => column.name === "visit_id");
    expect(visitIdColumn?.notnull).toBe(1);
  });

  it("compares 20K site-qualified Session identities with a temp-table oracle and a one-statement page", async () => {
    const stressDb = fixture.db;
    const a = fixture.sites.a;
    const b = fixture.sites.b;
    const c = fixture.sites.c;
    try {
      const stressPrefixA = "wave37a-stress-a";
      const stressPrefixB = "wave37a-stress-b";
      const stressPrefixC = "wave37a-stress-c";

      const expectedPairs: Array<{ siteId: string; id: string }> = [];
      const insertVisits = stressDb.prepare(
        `WITH RECURSIVE sequence(n) AS (
           SELECT 0 UNION ALL SELECT n + 1 FROM sequence WHERE n < 9999
         )
         INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, title, hostname
         )
         SELECT
           ? || '-visit-' || n, ?, ?, ? || '-visitor-' || n,
           CASE WHEN n = 0 THEN ? ELSE ? || '-session-' || n END,
           'closed', 125, 125, '/stress', 'Stress', 'events.test'
         FROM sequence`,
      );
      const insertEvents = stressDb.prepare(
        `WITH RECURSIVE sequence(n) AS (
           SELECT 0 UNION ALL SELECT n + 1 FROM sequence WHERE n < 9999
         )
         INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id,
          occurred_at, received_at, sequence, node_count, value_count
         )
         SELECT
           ? || '-event-' || n, ?, ?, ? || '-visit-' || n, ?,
           125, 777, 1, 1, 1
         FROM sequence`,
      );
      const insertForeignVisit = stressDb.prepare(
        `INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, title, hostname
        ) VALUES (?, ?, ?, ?, ?, 'closed', 125, 125, '/stress', 'Stress', 'events.test')`,
      );
      const insertForeignEvent = stressDb.prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id,
          occurred_at, received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, ?, 125, 777, 1, 1, 1)`,
      );
      const stressIndexes = stressDb
        .prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'index'
             AND tbl_name IN ('custom_events', 'visits')
             AND sql IS NOT NULL
           ORDER BY name`,
        )
        .all() as { readonly name: string; readonly sql: string }[];
      for (const { name } of stressIndexes) {
        stressDb.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
      }
      try {
        stressDb.exec("BEGIN");
        for (const [site, nameId, prefix] of [
          [a, fixture.names.a, stressPrefixA],
          [b, fixture.names.b, stressPrefixB],
        ] as const) {
          for (let index = 0; index < 10_000; index += 1) {
            const localSessionId =
              index === 0
                ? "wave37a-stress-session-local-id-collision"
                : `${prefix}-session-${index}`;
            expectedPairs.push({ siteId: site.id, id: localSessionId });
          }
          insertVisits.run(
            prefix,
            site.id,
            site.pk,
            prefix,
            "wave37a-stress-session-local-id-collision",
            prefix,
          );
          insertEvents.run(prefix, site.id, site.pk, prefix, nameId);
        }
        insertForeignVisit.run(
          `${stressPrefixC}-foreign-visit`,
          c.id,
          c.pk,
          `${stressPrefixC}-foreign-visitor`,
          "wave37a-stress-session-local-id-collision",
        );
        insertForeignEvent.run(
          `${stressPrefixC}-foreign-event`,
          c.id,
          c.pk,
          `${stressPrefixC}-foreign-visit`,
          fixture.names.c,
        );
        stressDb.exec("COMMIT");
      } catch (error) {
        stressDb.exec("ROLLBACK");
        throw error;
      } finally {
        for (const { sql } of stressIndexes) stressDb.exec(sql);
      }

      stressDb.exec(`
        CREATE TEMP TABLE expected_session_identity (
          site_pk INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          PRIMARY KEY (site_pk, session_id)
        ) WITHOUT ROWID;
      `);
      const insertExpected = stressDb.prepare(
        `WITH RECURSIVE sequence(n) AS (
           SELECT 0 UNION ALL SELECT n + 1 FROM sequence WHERE n < 9999
         )
         INSERT INTO expected_session_identity (site_pk, session_id)
         SELECT ?, CASE WHEN n = 0 THEN ? ELSE ? || '-session-' || n END
         FROM sequence
         UNION ALL
         SELECT ?, CASE WHEN n = 0 THEN ? ELSE ? || '-session-' || n END
         FROM sequence`,
      );
      try {
        stressDb.exec("BEGIN");
        insertExpected.run(
          a.pk,
          "wave37a-stress-session-local-id-collision",
          stressPrefixA,
          b.pk,
          "wave37a-stress-session-local-id-collision",
          stressPrefixB,
        );
        stressDb.exec("COMMIT");
      } catch (error) {
        stressDb.exec("ROLLBACK");
        throw error;
      }
      // Duplicate and foreign authorized identities must not change the set.
      const matches = {
        entityIds: [
          ...expectedPairs,
          expectedPairs[0]!,
          {
            siteId: c.id,
            id: "wave37a-stress-session-local-id-collision",
          },
        ],
      };
      const selection = makePreparedSelection({
        authorizationSites: [a, b, c],
        subjectSites: [a, b],
        filters: filtersFor(fieldCondition("session.events", "gte", 1)),
        scopePreference: "session",
        eventName: "target_event",
        advancedMatches: matches,
      });
      expect(matches.entityIds).toHaveLength(20_002);
      const countIdentitySnapshot =
        selection.selection.preparedMatches?.identities ?? [];
      expect(countIdentitySnapshot).toHaveLength(20_000);
      const countPlan = buildSourceDomainProbe(selection, "count");
      let countQuery: ReturnType<typeof compileOutput> | undefined;
      let countCompileFailure: string | undefined;
      try {
        countQuery = compileOutput(countPlan, "count");
      } catch (error) {
        countCompileFailure = String(error);
      }
      const coreCountExplain = countQuery
        ? explainQueryPlan(stressDb, countQuery.sql, countQuery.bindings ?? [])
        : undefined;
      const countTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      let countRows: Record<string, unknown>[] | undefined;
      let countExecutionFailure: string | undefined;
      const countExecutionStartedAt = performance.now();
      let countExecutionMs: number | undefined;
      try {
        countRows = await queryAnalyticsReportOutputRowsFromD1(
          {
            DB: createSqliteD1Database(stressDb, countTrace),
          } as unknown as Env,
          countPlan,
          "count",
        );
        countExecutionMs = Math.round(
          performance.now() - countExecutionStartedAt,
        );
      } catch (error) {
        countExecutionFailure = String(error);
        countExecutionMs = Math.round(
          performance.now() - countExecutionStartedAt,
        );
      }
      const expectedCountRow = stressDb
        .prepare(
          `SELECT COUNT(*) AS count
           FROM expected_session_identity identity
           INNER JOIN visits owner
             ON owner.site_pk = identity.site_pk
            AND owner.session_id = identity.session_id
           INNER JOIN custom_events ce
             ON ce.site_pk = owner.site_pk AND ce.visit_id = owner.visit_id
           INNER JOIN custom_event_names cen
             ON cen.site_pk = ce.site_pk AND cen.id = ce.event_name_id
           WHERE ce.occurred_at >= ? AND ce.occurred_at < ?
             AND TRIM(COALESCE(cen.name, '')) = 'target_event'`,
        )
        .get(120, 130) as { readonly count: number };
      expect(Number(expectedCountRow.count)).toBe(20_000);

      const emptySelection = makePreparedSelection({
        authorizationSites: [a, b, c],
        subjectSites: [a, b],
        filters: filtersFor(fieldCondition("session.events", "gte", 1)),
        scopePreference: "session",
        eventName: "target_event",
        advancedMatches: { entityIds: [] },
      });
      const emptyCountPlan = buildSourceDomainProbe(emptySelection, "count");
      const emptyCountQuery = compileOutput(emptyCountPlan, "count");
      let emptyCount: Record<string, unknown>[] | undefined;
      let emptyCountFailure: string | undefined;
      try {
        emptyCount = await queryAnalyticsReportOutputRowsFromD1(
          { DB: createSqliteD1Database(fixture.db) } as unknown as Env,
          emptyCountPlan,
          "count",
        );
      } catch (error) {
        emptyCountFailure = String(error);
      }

      const tempIdentityOracleSql = `SELECT ce.event_id AS eventId, ce.event_pk AS eventPk, ce.occurred_at AS occurredAt
           FROM expected_session_identity identity
           INNER JOIN visits owner
             ON owner.site_pk = identity.site_pk
            AND owner.session_id = identity.session_id
           INNER JOIN custom_events ce
             ON ce.site_pk = owner.site_pk AND ce.visit_id = owner.visit_id
           INNER JOIN custom_event_names cen
             ON cen.site_pk = ce.site_pk AND cen.id = ce.event_name_id
           WHERE identity.site_pk = ?
             AND ce.occurred_at >= ? AND ce.occurred_at < ?
             AND TRIM(COALESCE(cen.name, '')) = 'target_event'
           ORDER BY ce.occurred_at DESC, ce.event_id DESC, ce.event_pk DESC
           LIMIT ?`;
      const tempIdentityOracleBindings = [a.pk, 120, 130, 8];
      const tempIdentityOracleExplain = explainQueryPlan(
        stressDb,
        tempIdentityOracleSql,
        tempIdentityOracleBindings,
      );
      const expectedPage = stressDb
        .prepare(tempIdentityOracleSql)
        .all(...tempIdentityOracleBindings) as {
        readonly eventId: string;
        readonly eventPk: number;
        readonly occurredAt: number;
      }[];
      const pageTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const productionPlan = buildEventRecordPagePlan({
        siteId: a.id,
        queryTime: selection.queryTime,
        filters: selection.filters,
        scopePlan: selection.scopePlan,
        options: {
          limit: 7,
          sort: { key: "occurredAt", direction: "desc" },
        },
      });
      const pageSelectionSnapshot = createSemanticScopedSourceSelection({
        profile: "prepared-scoped-v1",
        filters: selection.filters,
        subject: createSemanticSubjectDomain({
          origin: "site",
          siteIds: [a.id as never],
        }),
        time: semanticTemporalDomainsFromQueryTime(selection.queryTime),
        expectedPlan: selection.scopePlan,
      });
      const pageIdentitySnapshot =
        pageSelectionSnapshot.preparedMatches?.identities ?? [];
      expect(pageIdentitySnapshot).toHaveLength(10_000);
      expect(
        pageIdentitySnapshot.every((identity) => identity.siteId === a.id),
      ).toBe(true);
      let pageQuery: ReturnType<typeof compileOutput> | undefined;
      let pageMetrics: QueryMetrics | undefined;
      let pageCompileFailure: string | undefined;
      const pageCompileStartedAt = performance.now();
      let pageCompileMs: number | undefined;
      try {
        pageQuery = compileOutput(productionPlan, "event-record-page");
        pageMetrics = queryMetrics(pageQuery);
        pageCompileMs = Math.round(performance.now() - pageCompileStartedAt);
      } catch (error) {
        pageCompileFailure = String(error);
        pageCompileMs = Math.round(performance.now() - pageCompileStartedAt);
      }
      let productionPageExplain:
        ReturnType<typeof explainQueryPlan> | undefined;
      let productionPageExplainMs: number | undefined;
      if (pageQuery) {
        const explainStartedAt = performance.now();
        productionPageExplain = explainQueryPlan(
          stressDb,
          pageQuery.sql,
          pageQuery.bindings ?? [],
        );
        productionPageExplainMs = Math.round(
          performance.now() - explainStartedAt,
        );
      }
      let pageResult:
        Awaited<ReturnType<typeof queryEventRecordPageFromD1>> | undefined;
      let pageExecutionFailure: string | undefined;
      const pageExecutionStartedAt = performance.now();
      let pageExecutionMs: number | undefined;
      try {
        pageResult = await queryEventRecordPageFromD1(
          { DB: createSqliteD1Database(stressDb, pageTrace) } as unknown as Env,
          a.id,
          WINDOW,
          selection.filters,
          {
            limit: 7,
            sort: { key: "occurredAt", direction: "desc" },
            scopePlan: selection.scopePlan,
            queryTime: selection.queryTime,
          },
        );
        pageExecutionMs = Math.round(
          performance.now() - pageExecutionStartedAt,
        );
      } catch (error) {
        pageExecutionFailure = String(error);
        pageExecutionMs = Math.round(
          performance.now() - pageExecutionStartedAt,
        );
      }
      const actualPageEventIds = pageResult?.rows.map((row) => row.eventId);
      const oracleFirstSevenEventIds = expectedPage
        .slice(0, 7)
        .map((row) => row.eventId);
      const countMetrics = countQuery ? queryMetrics(countQuery) : undefined;
      expect(countMetrics?.jsonRowRelations).toBeGreaterThan(0);
      expect(pageMetrics?.jsonRowRelations).toBeGreaterThan(0);
      const packedRowSegments = (pageQuery?.bindings ?? []).filter(
        (binding): binding is string =>
          typeof binding === "string" && binding.startsWith("[["),
      );
      const decodePackedIdentityRows = (
        query: ReturnType<typeof compileOutput> | undefined,
      ): unknown[][] => {
        const segments = (query?.bindings ?? []).filter(
          (binding): binding is string =>
            typeof binding === "string" && binding.startsWith("[["),
        );
        expect(segments.length).toBeGreaterThan(0);
        return segments.flatMap((segment) => {
          expect(
            new TextEncoder().encode(segment).byteLength,
          ).toBeLessThanOrEqual(1_000_000);
          return JSON.parse(segment) as unknown[][];
        });
      };
      const countPackedIdentityRows = decodePackedIdentityRows(countQuery);
      const pagePackedIdentityRows = decodePackedIdentityRows(pageQuery);
      const packedRowsFor = (
        identities: readonly {
          readonly siteId: string;
          readonly kind: string;
          readonly id: string;
        }[],
      ) => identities.map(({ siteId, kind, id }) => [siteId, kind, id]);
      expect(countPackedIdentityRows).toHaveLength(20_000);
      expect(pagePackedIdentityRows).toHaveLength(10_000);
      expect(countPackedIdentityRows).toEqual(
        packedRowsFor(countIdentitySnapshot),
      );
      expect(pagePackedIdentityRows).toEqual(
        packedRowsFor(pageIdentitySnapshot),
      );
      expect(
        [...countPackedIdentityRows, ...pagePackedIdentityRows].every(
          (tuple) => tuple.length === 3 && tuple[1] === "session",
        ),
      ).toBe(true);
      expect(pagePackedIdentityRows.every((tuple) => tuple[0] === a.id)).toBe(
        true,
      );
      console.info(
        `[wave37a 20K] ${JSON.stringify({
          coreCount: countMetrics
            ? {
                ...countMetrics,
                statementCount: countTrace.preparedSql.length,
                shape: countQuery!.physicalPlanShape,
                count: countRows?.[0]?.count,
                executionMs: countExecutionMs,
                explain: coreCountExplain,
              }
            : {
                compileFailure: countCompileFailure,
                executionFailure: countExecutionFailure,
                statementCount: countTrace.preparedSql.length,
              },
          emptyCoreCount: {
            rows: emptyCount,
            failure: emptyCountFailure,
          },
          tempIdentityOracle: {
            description: "temporary-table semantic oracle; not old page SQL",
            rows: expectedPage.length,
            explain: tempIdentityOracleExplain,
          },
          productionPage: pageMetrics
            ? {
                ...pageMetrics,
                statementCount: pageTrace.preparedSql.length,
                shape: pageQuery!.physicalPlanShape,
                compileMs: pageCompileMs,
                explainMs: productionPageExplainMs,
                explain: productionPageExplain,
                executionMs: pageExecutionMs,
                rowCount: pageResult?.rows.length,
                eventIds: actualPageEventIds,
                hasMore: pageResult ? pageResult.nextCursor !== null : null,
                nextCursor: pageResult?.nextCursor,
                oracleFirstSevenEventIds,
                oracleFirstSevenMatches:
                  JSON.stringify(actualPageEventIds) ===
                  JSON.stringify(oracleFirstSevenEventIds),
              }
            : {
                compileFailure: pageCompileFailure,
                executionFailure: pageExecutionFailure,
                statementCount: pageTrace.preparedSql.length,
              },
        })}`,
      );
      expect(emptyCount).toEqual([{ count: 0 }]);
      expect(countCompileFailure).toBeUndefined();
      expect(countExecutionFailure).toBeUndefined();
      expect(countRows?.[0]?.count).toBe(Number(expectedCountRow.count));
      expect(countTrace.preparedSql).toHaveLength(1);
      expect(countTrace.bindings[0]?.length).toBe(countMetrics?.bindings);
      expect(countQuery?.sql).not.toMatch(/\bLIMIT\b/u);
      expect(pageCompileFailure).toBeUndefined();
      expect(pageExecutionFailure).toBeUndefined();
      expect(pageResult?.rows.map((row) => row.eventId)).toEqual(
        expectedPage.slice(0, 7).map((row) => row.eventId),
      );
      expect(pageResult?.nextCursor).toEqual(
        expectedPage.length > 7
          ? {
              occurredAt: expectedPage[6]!.occurredAt,
              eventId: expectedPage[6]!.eventId,
              eventPk: expectedPage[6]!.eventPk,
            }
          : null,
      );
      expect(pageTrace.preparedSql).toHaveLength(1);
      expect(pageTrace.preparedSql[0]).toBe(pageQuery?.sql);
      expect(pageTrace.bindings[0]?.length).toBe(pageMetrics?.bindings);
      expect(pageMetrics?.physicalPlanHash).toMatch(/^v[12]:[a-f0-9]{64}$/u);
      expect(tempIdentityOracleExplain.operationCount).toBeGreaterThan(0);
      expect(tempIdentityOracleExplain.indexedSearches.length).toBeGreaterThan(
        0,
      );
      expect(productionPageExplain?.operationCount).toBeGreaterThan(0);
      expect(productionPageExplain?.indexedSearches.length).toBeGreaterThan(0);
      expect(pageMetrics?.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(pageMetrics?.bindings).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(countMetrics?.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(countMetrics?.bindings).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    } finally {
      stressDb.exec("DROP TABLE IF EXISTS temp.expected_session_identity");
      stressDb
        .prepare(
          `DELETE FROM custom_events
           WHERE event_id LIKE ? OR event_id LIKE ? OR event_id = ?`,
        )
        .run(
          "wave37a-stress-a-event-%",
          "wave37a-stress-b-event-%",
          "wave37a-stress-c-foreign-event",
        );
      stressDb
        .prepare(
          `DELETE FROM visits
           WHERE visit_id LIKE ? OR visit_id LIKE ? OR visit_id = ?`,
        )
        .run(
          "wave37a-stress-a-visit-%",
          "wave37a-stress-b-visit-%",
          "wave37a-stress-c-foreign-visit",
        );
    }
  }, 90_000);
});
