import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  attachScopedFilterMetadata,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  type QueryInput,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import { buildEventFieldValuesQualificationPlan } from "@/lib/edge/analytics/engine/event-field-values-qualification-plan";
import { buildEventFieldsPlan } from "@/lib/edge/analytics/engine/event-fields-plan";
import { buildEventFieldsQualificationPlan } from "@/lib/edge/analytics/engine/event-fields-qualification-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { buildEventFilteredSourceCte } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import {
  d1AdvancedFilterMiddleware,
  deferredEventFieldsQualificationFromQuery,
  deferredEventFieldValuesQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as analyticsQualificationProgram from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import {
  type EventFieldRow,
  type EventFieldValueRow,
  type FilterDocument,
  mapEventField,
  mapEventFieldValue,
  type QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodeEventFieldCursor,
  decodeEventFieldValueCursor,
  type EventFieldCursor,
  type EventFieldValueCursor,
  queryEventFieldsFromD1,
  queryEventFieldsPageFromD1,
  queryEventFieldValuesFromD1,
  queryEventFieldValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import {
  type FilterExpression,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

const SITE = "wave64-event-fields";
const SIBLING_SITE = "wave64-event-fields-sibling";
const TIME = createQueryTime(120, 130, "UTC", 500);
const PREVIOUS_TIME = createQueryTime(110, 120, "UTC", 500);
const WINDOW: QueryWindow = {
  startMs: 120,
  endExclusiveMs: 130,
  nowMs: 500,
  timeZone: "UTC",
};
const PREVIOUS_WINDOW: QueryWindow = {
  startMs: 110,
  endExclusiveMs: 120,
  nowMs: 500,
  timeZone: "UTC",
};
const DATABASES = new Set<DatabaseSync>();
const CURSOR_SECRET = "wave64-event-fields-test-secret";
const ARTIFACT_DIR = resolve(
  process.env.WAVE97EJ_ARTIFACT_DIR ??
    process.env.WAVE95C_ARTIFACT_DIR ??
    "plan/execution-wave95b-event-fields-qualification/run-1/runtime",
);
const runtimeEvidence: unknown[] = [];
const errorEvidence: unknown[] = [];
const compilationEvidence: Array<{
  readonly scope: "session" | "visitor";
  readonly evidence: unknown;
  readonly logicalPlan: unknown;
}> = [];
const valuesCompilationEvidence: Array<{
  readonly scope: "session" | "visitor";
  readonly evidence: unknown;
  readonly logicalPlan: unknown;
}> = [];

interface Site {
  readonly id: string;
  readonly pk: number;
}

interface PayloadInput {
  readonly valueType: number;
  readonly occurredAt: number;
  readonly stringValue?: string | null;
  readonly numberValue?: number | null;
  readonly booleanValue?: number | null;
  readonly missingPath?: boolean;
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
    readonly visitorId: string;
    readonly startedAt?: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, 900, '/landing', 'wave64.test')`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.visitorId,
      input.sessionId,
      input.startedAt ?? 900,
    );
}

function addEvent(
  database: DatabaseSync,
  site: Site,
  input: {
    readonly id: string;
    readonly visitId: string;
    readonly nameId: number;
    readonly occurredAt: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, 901, 1, 1, 1)`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.visitId,
      input.nameId,
      input.occurredAt,
    );
}

function ensurePath(database: DatabaseSync, site: Site, path: string): number {
  database
    .prepare(
      `INSERT OR IGNORE INTO custom_event_json_paths
       (site_id, site_pk, path, last_seen_at) VALUES (?, ?, ?, 900)`,
    )
    .run(site.id, site.pk, path);
  const row = database
    .prepare(
      "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
    )
    .get(site.pk, path) as { readonly id: number };
  return Number(row.id);
}

function addPayload(
  database: DatabaseSync,
  site: Site,
  eventId: string,
  path: string,
  input: PayloadInput,
): void {
  const event = database
    .prepare(
      `SELECT event_pk, event_name_id FROM custom_events WHERE event_id = ?`,
    )
    .get(eventId) as {
    readonly event_pk: number;
    readonly event_name_id: number;
  };
  const next = database
    .prepare(
      `SELECT COALESCE(MAX(node_id), 0) + 1 AS node_id
       FROM custom_event_json_nodes WHERE event_pk = ?`,
    )
    .get(event.event_pk) as { readonly node_id: number };
  const pathId = input.missingPath ? 99_999 : ensurePath(database, site, path);
  database
    .prepare(
      `INSERT INTO custom_event_json_nodes
       (event_pk, node_id, path_id, value_type, depth)
       VALUES (?, ?, ?, ?, 1)`,
    )
    .run(event.event_pk, next.node_id, pathId, input.valueType);
  database
    .prepare(
      `INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
        value_type, string_value, number_value, boolean_value, site_pk
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.event_pk,
      next.node_id,
      site.id,
      event.event_name_id,
      pathId,
      input.occurredAt,
      input.valueType,
      input.stringValue ?? null,
      input.numberValue ?? null,
      input.booleanValue ?? null,
      site.pk,
    );
}

function createDatabase(): {
  readonly database: DatabaseSync;
  readonly site: Site;
  readonly sibling: Site;
} {
  const database = createMigratedDatabase();
  DATABASES.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database, SITE);
  const sibling = addSite(database, SIBLING_SITE);
  addName(database, site, 41, "signup");
  addName(database, site, 42, "other");
  addName(database, sibling, 43, "signup");

  addVisit(database, site, {
    id: "visit-one",
    sessionId: "session-one",
    visitorId: "visitor-one",
  });
  addVisit(database, site, {
    id: "visit-two",
    sessionId: "session-two",
    visitorId: "visitor-two",
  });
  addVisit(database, site, {
    id: "visit-previous",
    sessionId: "session-previous",
    visitorId: "visitor-previous",
  });
  addVisit(database, site, {
    id: "visit-outside",
    sessionId: "session-outside",
    visitorId: "visitor-outside",
  });
  addVisit(database, sibling, {
    id: "sibling-visit",
    sessionId: "sibling-session",
    visitorId: "sibling-visitor",
  });

  addEvent(database, site, {
    id: "event-one",
    visitId: "visit-one",
    nameId: 41,
    occurredAt: 125,
  });
  addEvent(database, site, {
    id: "event-two",
    visitId: "visit-two",
    nameId: 41,
    occurredAt: 126,
  });
  addEvent(database, site, {
    id: "event-qualifier-one",
    visitId: "visit-one",
    nameId: 42,
    occurredAt: 127,
  });
  addEvent(database, site, {
    id: "event-qualifier-two",
    visitId: "visit-one",
    nameId: 42,
    occurredAt: 128,
  });
  addEvent(database, site, {
    id: "event-previous",
    visitId: "visit-previous",
    nameId: 41,
    occurredAt: 115,
  });
  addEvent(database, site, {
    id: "event-outside",
    visitId: "visit-outside",
    nameId: 41,
    occurredAt: 140,
  });
  addEvent(database, sibling, {
    id: "sibling-event",
    visitId: "sibling-visit",
    nameId: 43,
    occurredAt: 125,
  });

  // Same Event/path/type duplicates are kept as separate occurrences.
  addPayload(database, site, "event-one", "/a", {
    valueType: 1,
    occurredAt: 100,
    stringValue: "z",
    numberValue: 20,
    booleanValue: 1,
  });
  addPayload(database, site, "event-one", "/a", {
    valueType: 1,
    occurredAt: 101,
    stringValue: "a",
    numberValue: 3,
    booleanValue: 0,
  });
  addPayload(database, site, "event-two", "/a", {
    valueType: 1,
    occurredAt: 110,
    stringValue: "b",
    numberValue: 12,
    booleanValue: 1,
  });
  addPayload(database, site, "event-one", "/a", {
    valueType: 2,
    occurredAt: 102,
    numberValue: 8,
  });
  addPayload(database, site, "event-two", "/a", {
    valueType: 2,
    occurredAt: 111,
    numberValue: 3,
  });
  addPayload(database, site, "event-one", "/a", {
    valueType: 3,
    occurredAt: 103,
    booleanValue: 1,
  });
  for (const [valueType, occurredAt] of [
    [0, 112],
    [4, 113],
    [5, 114],
  ] as const)
    addPayload(database, site, "event-two", "/a", { valueType, occurredAt });
  addPayload(database, site, "event-two", "/b", {
    valueType: 2,
    occurredAt: 105,
    numberValue: 0,
  });
  addPayload(database, site, "event-two", "/missing-dictionary", {
    valueType: 1,
    occurredAt: 106,
    stringValue: "excluded",
    missingPath: true,
  });
  addPayload(database, site, "event-previous", "/previous", {
    valueType: 1,
    occurredAt: 109,
    stringValue: "previous",
  });
  addPayload(database, site, "event-outside", "/outside", {
    valueType: 1,
    occurredAt: 140,
    stringValue: "outside",
  });
  addPayload(database, sibling, "sibling-event", "/sibling", {
    valueType: 1,
    occurredAt: 125,
    stringValue: "sibling",
  });
  return { database, site, sibling };
}

function filtersFor(root: FilterExpression | null): FilterDocument {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function payloadExists40(): FilterDocument {
  return filtersFor({
    kind: "and",
    children: Array.from({ length: 40 }, (_unused, index) => ({
      kind: "condition" as const,
      target: {
        kind: "event-payload" as const,
        path: `/wave64/payload-${index}`,
      },
      operator: "exists" as const,
    })),
  } as never);
}

function preparedFilters(
  scopePreference: "event" | "session" | "visitor",
  options: {
    readonly entityCount?: number;
    readonly entityIds?: readonly string[];
    readonly eventIds?: readonly string[];
    readonly visitIds?: readonly string[];
  } = {},
): FilterDocument {
  const prepared = prepareScopedQuery("event-records", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: TIME,
    filters: filtersFor({
      kind: "condition",
      target: { kind: "field", field: "page.path" },
      operator: "eq",
      value: "/landing",
    } as never),
    scopePreference,
  } as never) as {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("wave64_event_fields_prepare_failed");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("wave64_event_fields_metadata_missing");
  const identityIds = (
    options.entityIds ??
    Array.from(
      { length: options.entityCount ?? 0 },
      (_unused, index) => `wave64-identity-${index}`,
    )
  ).map((id) => ({ siteId: SITE, id }));
  const eventIds = (
    options.eventIds ??
    Array.from(
      { length: options.entityCount ?? 0 },
      (_unused, index) => `wave64-event-${index}`,
    )
  ).map((id) => ({ siteId: SITE, id }));
  const visitIds = (
    options.visitIds ??
    Array.from(
      { length: options.entityCount ?? 0 },
      (_unused, index) => `wave64-visit-${index}`,
    )
  ).map((id) => ({ siteId: SITE, id }));
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: {
      ...prepared.scopePlan,
      advancedMatches: {
        ...(scopePreference === "event"
          ? {
              eventIds,
              visitIds,
            }
          : { entityIds: identityIds }),
      },
    },
  });
}

type QualifiedEventFieldsTestQuery = QueryInput & {
  readonly filters: FilterDocument;
  readonly time: typeof TIME;
} & Record<string, unknown>;

function qualifiedEventFieldsQuery(
  scopePreference: "event" | "session" | "visitor",
  cursor: string | null = null,
  filterDsl = 'count(page { page.path eq "/landing" }) eq 1',
  eventName: string | null = "signup",
  limit = 1,
  audience: "private-dashboard" | "api-v1" = "private-dashboard",
): QualifiedEventFieldsTestQuery {
  const prepared = prepareScopedQuery("event-fields", {
    context: siteQueryContext(SITE, audience),
    time: TIME,
    filters: parseFilterDsl(filterDsl, analyticsFilterRegistry),
    scopePreference,
  } as QueryInput & { readonly time: typeof TIME }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly time?: typeof TIME;
  };
  if (!prepared.filters || !prepared.time)
    throw new Error("wave95b_event_fields_query_preparation_failed");
  return {
    ...prepared,
    eventName: eventName ?? undefined,
    limit,
    cursor,
  } as QualifiedEventFieldsTestQuery;
}

type QualifiedEventFieldValuesTestQuery = QueryInput & {
  readonly filters: FilterDocument;
  readonly time: typeof TIME;
  readonly eventName?: string;
  readonly fieldPath: string;
  readonly fieldValueType: string;
  readonly search?: string;
  readonly limit: number;
  readonly cursor?: string;
} & Record<string, unknown>;

function qualifiedEventFieldValuesQuery(
  scopePreference: "event" | "session" | "visitor",
  input: {
    readonly fieldPath?: string;
    readonly fieldValueType?: string;
    readonly eventName?: string | null;
    readonly search?: string;
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly filterDsl?: string;
    readonly audience?: "private-dashboard" | "api-v1";
  } = {},
): QualifiedEventFieldValuesTestQuery {
  const prepared = prepareScopedQuery("event-field-values", {
    context: siteQueryContext(SITE, input.audience ?? "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(
      input.filterDsl ??
        `count(page { page.path eq "/landing" }) eq ${scopePreference === "visitor" ? 2 : 1}`,
      analyticsFilterRegistry,
    ),
    scopePreference,
  } as QueryInput & { readonly time: typeof TIME }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly time?: typeof TIME;
  };
  if (!prepared.filters || !prepared.time)
    throw new Error("wave95c_event_field_values_query_preparation_failed");
  return {
    ...prepared,
    eventName:
      input.eventName === null ? undefined : (input.eventName ?? "signup"),
    fieldPath: input.fieldPath ?? "/a",
    fieldValueType: input.fieldValueType ?? "string",
    ...(input.search !== undefined ? { search: input.search } : {}),
    limit: input.limit ?? 1,
    cursor: input.cursor ?? undefined,
  } as QualifiedEventFieldValuesTestQuery;
}

function frozenSql(input: {
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly eventName?: string;
  readonly page?: boolean;
  readonly cursor?: EventFieldCursor | null;
  readonly limit: number;
}): {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
} {
  const source = buildEventFilteredSourceCte(
    SITE,
    input.window,
    input.filters,
    input.eventName,
  );
  if (!input.page)
    return {
      sql: `
${source.cte},
field_rows AS (
  SELECT p.path, v.value_type AS valueType, v.event_pk, v.occurred_at,
    v.string_value AS stringValue, v.number_value AS numberValue,
    v.boolean_value AS booleanValue
  FROM custom_event_json_values v
  INNER JOIN custom_event_json_paths p ON p.id = v.path_id
  INNER JOIN filtered_events fe ON fe.event_pk = v.event_pk
)
SELECT path, valueType, count(DISTINCT event_pk) AS events,
  count(*) AS occurrences, MIN(occurred_at) AS firstSeenAt,
  MAX(occurred_at) AS lastSeenAt, MIN(stringValue) AS stringValue,
  MIN(numberValue) AS numberValue, MIN(booleanValue) AS booleanValue
FROM field_rows
GROUP BY path, valueType
ORDER BY events DESC, occurrences DESC, path ASC
LIMIT ?`,
      bindings: [...source.bindings, input.limit],
    };
  const cursor = input.cursor;
  const cursorClause = cursor
    ? `
WHERE events < ?
   OR (events = ? AND occurrences < ?)
   OR (events = ? AND occurrences = ? AND path > ?)
   OR (events = ? AND occurrences = ? AND path = ? AND valueType > ?)`
    : "";
  const cursorBindings = cursor
    ? [
        cursor.events,
        cursor.events,
        cursor.occurrences,
        cursor.events,
        cursor.occurrences,
        cursor.path,
        cursor.events,
        cursor.occurrences,
        cursor.path,
        cursor.valueType,
      ]
    : [];
  return {
    sql: `
${source.cte},
field_rows AS (
  SELECT p.path, v.value_type AS valueType, v.event_pk, v.occurred_at,
    v.string_value AS stringValue, v.number_value AS numberValue,
    v.boolean_value AS booleanValue
  FROM custom_event_json_values v
  INNER JOIN custom_event_json_paths p ON p.id = v.path_id
  INNER JOIN filtered_events fe ON fe.event_pk = v.event_pk
),
rollup AS (
  SELECT path, valueType, count(DISTINCT event_pk) AS events,
    count(*) AS occurrences, MIN(occurred_at) AS firstSeenAt,
    MAX(occurred_at) AS lastSeenAt, MIN(stringValue) AS stringValue,
    MIN(numberValue) AS numberValue, MIN(booleanValue) AS booleanValue
  FROM field_rows
  GROUP BY path, valueType
)
SELECT path, valueType, events, occurrences, firstSeenAt, lastSeenAt,
  stringValue, numberValue, booleanValue
FROM rollup
${cursorClause}
ORDER BY events DESC, occurrences DESC, path ASC, valueType ASC
LIMIT ?`,
    bindings: [...source.bindings, ...cursorBindings, input.limit + 1],
  };
}

function frozenRows(
  database: DatabaseSync,
  input: Parameters<typeof frozenSql>[0],
): EventFieldRow[] {
  const query = frozenSql(input);
  return database
    .prepare(query.sql)
    .all(...(query.bindings as SQLInputValue[])) as unknown as EventFieldRow[];
}

function stableRows(rows: readonly EventFieldRow[]): EventFieldRow[] {
  return [...rows].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function frozenValueSql(input: {
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly eventName?: string;
  readonly fieldPath: string;
  readonly valueTypeCode: number;
  readonly search?: string;
  readonly page?: boolean;
  readonly cursor?: EventFieldValueCursor | null;
  readonly limit: number;
}): {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
} {
  const source = buildEventFilteredSourceCte(
    SITE,
    input.window,
    input.filters,
    input.eventName,
  );
  const normalizedSearch = input.search?.trim().toLowerCase();
  const display =
    input.valueTypeCode === 1
      ? "v.string_value"
      : input.valueTypeCode === 2
        ? "CAST(v.number_value AS TEXT)"
        : input.valueTypeCode === 3
          ? "CASE v.boolean_value WHEN 1 THEN 'true' ELSE 'false' END"
          : "''";
  const searchPattern = normalizedSearch
    ? `%${normalizedSearch.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
    : undefined;
  const searchClause = searchPattern
    ? `AND LOWER(TRIM(COALESCE(${display}, ''))) LIKE ? ESCAPE '\\'`
    : "";
  const bindings: (string | number | null)[] = [
    ...source.bindings,
    input.fieldPath,
    input.valueTypeCode,
    ...(searchPattern ? [searchPattern] : []),
  ];
  if (!input.page)
    return {
      sql: `
${source.cte},
field_rows AS (
  SELECT v.value_type AS valueType, v.event_pk, v.occurred_at,
    v.string_value AS stringValue, v.number_value AS numberValue,
    v.boolean_value AS booleanValue
  FROM custom_event_json_values v
  INNER JOIN custom_event_json_paths p ON p.id = v.path_id
  INNER JOIN filtered_events fe ON fe.event_pk = v.event_pk
  WHERE p.path = ? AND v.value_type = ?
  ${searchClause}
)
SELECT valueType, count(DISTINCT event_pk) AS events,
  count(*) AS occurrences, MIN(occurred_at) AS firstSeenAt,
  MAX(occurred_at) AS lastSeenAt, MIN(stringValue) AS stringValue,
  MIN(numberValue) AS numberValue, MIN(booleanValue) AS booleanValue
FROM field_rows
GROUP BY valueType, stringValue, numberValue, booleanValue
ORDER BY occurrences DESC, events DESC, stringValue ASC, numberValue ASC, booleanValue ASC
LIMIT ?`,
      bindings: [...bindings, input.limit],
    };
  const cursor = input.cursor;
  const cursorClause = cursor
    ? `
WHERE occurrences < ?
  OR (occurrences = ? AND events < ?)
  OR (occurrences = ? AND events = ? AND valueString > ?)
  OR (occurrences = ? AND events = ? AND valueString = ? AND valueNumber > ?)
  OR (occurrences = ? AND events = ? AND valueString = ? AND valueNumber = ? AND valueBoolean > ?)`
    : "";
  const cursorBindings = cursor
    ? [
        cursor.occurrences,
        cursor.occurrences,
        cursor.events,
        cursor.occurrences,
        cursor.events,
        cursor.stringValue,
        cursor.occurrences,
        cursor.events,
        cursor.stringValue,
        cursor.numberValue,
        cursor.occurrences,
        cursor.events,
        cursor.stringValue,
        cursor.numberValue,
        cursor.booleanValue,
      ]
    : [];
  return {
    sql: `
${source.cte},
field_rows AS (
  SELECT v.value_type AS valueType, v.event_pk, v.occurred_at,
    v.string_value AS stringValue, v.number_value AS numberValue,
    v.boolean_value AS booleanValue
  FROM custom_event_json_values v
  INNER JOIN custom_event_json_paths p ON p.id = v.path_id
  INNER JOIN filtered_events fe ON fe.event_pk = v.event_pk
  WHERE p.path = ? AND v.value_type = ?
  ${searchClause}
),
rollup AS (
  SELECT valueType, count(DISTINCT event_pk) AS events,
    count(*) AS occurrences, MIN(occurred_at) AS firstSeenAt,
    MAX(occurred_at) AS lastSeenAt, MIN(stringValue) AS stringValue,
    MIN(numberValue) AS numberValue, MIN(booleanValue) AS booleanValue
  FROM field_rows
  GROUP BY valueType, stringValue, numberValue, booleanValue
)
SELECT valueType, events, occurrences, firstSeenAt, lastSeenAt,
  stringValue, numberValue, booleanValue,
  COALESCE(stringValue, '') AS valueString,
  COALESCE(numberValue, -9223372036854775808) AS valueNumber,
  COALESCE(booleanValue, -1) AS valueBoolean
FROM rollup
${cursorClause}
ORDER BY occurrences DESC, events DESC, valueString ASC, valueNumber ASC, valueBoolean ASC
LIMIT ?`,
    bindings: [...bindings, ...cursorBindings, input.limit + 1],
  };
}

function frozenValueRows(
  database: DatabaseSync,
  input: Parameters<typeof frozenValueSql>[0],
): EventFieldValueRow[] {
  const query = frozenValueSql(input);
  const statement = database.prepare(query.sql);
  statement.setReadBigInts(true);
  return (
    statement.all(...(query.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[]
  ).map(
    (row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "bigint" ? Number(value) : value,
        ]),
      ) as unknown as EventFieldValueRow,
  );
}

function queryPlanDetails(
  database: DatabaseSync,
  sql: string,
  bindings: readonly SQLInputValue[],
): string[] {
  return (
    database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as {
      readonly detail: string;
    }[]
  ).map(({ detail }) => detail);
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

function testEnvWithQualifiedReadBehavior(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  behavior: "database-failure" | "malformed-controls",
): { readonly env: Env; readonly prepareCount: () => number } {
  const baseDatabase = createSqliteD1Database(database, trace);
  let prepareCount = 0;
  const DB = {
    prepare(sql: string) {
      prepareCount += 1;
      if (behavior === "database-failure" && prepareCount === 2)
        throw new Error("wave95b_database_failure");
      const statement = baseDatabase.prepare(sql);
      if (behavior !== "malformed-controls" || prepareCount !== 2)
        return statement;

      const replacement = Object.create(statement) as D1PreparedStatement;
      Object.defineProperty(replacement, "bind", {
        value: (...values: SQLInputValue[]) => {
          statement.bind(...values);
          return replacement;
        },
      });
      const originalAll = statement.all.bind(statement);
      Object.defineProperty(replacement, "all", {
        value: async () => {
          const result = await originalAll<Record<string, unknown>>();
          return {
            ...result,
            results: result.results.map((row) => ({
              ...row,
              unexpected: "malformed-control-envelope",
            })),
          };
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return {
    env: { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env,
    prepareCount: () => prepareCount,
  };
}

function traceFor(
  options: Pick<SqliteD1Trace, "readBigIntsAsNumbers"> = {},
): SqliteD1Trace {
  return { preparedSql: [], bindings: [], ...options };
}

type EventPayloadProgramEvidence = Extract<
  Awaited<
    ReturnType<
      typeof analyticsQualificationProgram.executeEventFieldsQualificationProgram
    >
  >,
  { readonly kind: "executed" }
>["evidence"];

async function captureEventFieldsExecution<T>(run: () => Promise<T>): Promise<{
  readonly value: T;
  readonly callCount: number;
  readonly evidence: readonly EventPayloadProgramEvidence[];
}> {
  const evidence: EventPayloadProgramEvidence[] = [];
  const execute =
    analyticsQualificationProgram.executeEventFieldsQualificationProgram;
  const spy = vi
    .spyOn(
      analyticsQualificationProgram,
      "executeEventFieldsQualificationProgram",
    )
    .mockImplementation(async (input) => {
      const result = await execute(input);
      if (result.kind === "executed") evidence.push(result.evidence);
      return result;
    });
  try {
    const value = await run();
    return { value, callCount: spy.mock.calls.length, evidence };
  } finally {
    spy.mockRestore();
  }
}

async function captureEventFieldValuesExecution<T>(
  run: () => Promise<T>,
): Promise<{
  readonly value: T;
  readonly callCount: number;
  readonly evidence: readonly EventPayloadProgramEvidence[];
}> {
  const evidence: EventPayloadProgramEvidence[] = [];
  const execute =
    analyticsQualificationProgram.executeEventFieldValuesQualificationProgram;
  const spy = vi
    .spyOn(
      analyticsQualificationProgram,
      "executeEventFieldValuesQualificationProgram",
    )
    .mockImplementation(async (input) => {
      const result = await execute(input);
      if (result.kind === "executed") evidence.push(result.evidence);
      return result;
    });
  try {
    const value = await run();
    return { value, callCount: spy.mock.calls.length, evidence };
  } finally {
    spy.mockRestore();
  }
}

function prepareEventCandidateFixture(
  database: DatabaseSync,
  label: string,
): void {
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave97ej-team', ?, ?, 0)`,
    )
    .run(SITE, label, `${label}.test`);
  database
    .prepare(
      `UPDATE visits
       SET started_at = CASE visit_id
             WHEN 'visit-one' THEN 125
             WHEN 'visit-two' THEN 126
           END,
           last_activity_at = CASE visit_id
             WHEN 'visit-one' THEN 125
             WHEN 'visit-two' THEN 126
           END
       WHERE visit_id IN ('visit-one', 'visit-two')`,
    )
    .run();
}

const EVENT_CANDIDATE_FILTERS = [
  {
    shape: "top-level AND",
    dsl: 'count(event { event.name eq "other" }) eq 2 AND event.name eq "signup"',
  },
  {
    shape: "top-level OR/NOT",
    dsl: 'count(event { event.name eq "other" }) eq 2 OR NOT (event.name eq "signup")',
  },
] as const;

afterAll(() => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  for (const database of DATABASES) database.close();
  DATABASES.clear();
  writeFileSync(
    resolve(ARTIFACT_DIR, "runtime-dto-and-call-counts.json"),
    JSON.stringify(runtimeEvidence, null, 2),
    "utf8",
  );
  writeFileSync(
    resolve(ARTIFACT_DIR, "error-and-call-counts.json"),
    JSON.stringify(errorEvidence, null, 2),
    "utf8",
  );
  for (const { scope, evidence, logicalPlan } of compilationEvidence) {
    const graph = JSON.stringify(logicalPlan, null, 2);
    writeFileSync(
      resolve(ARTIFACT_DIR, `${scope}-default-qualification.json`),
      JSON.stringify(
        {
          scope,
          graphSha256: createHash("sha256").update(graph, "utf8").digest("hex"),
          graph,
          evidence,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  for (const { scope, evidence, logicalPlan } of valuesCompilationEvidence) {
    const graph = JSON.stringify(logicalPlan, null, 2);
    writeFileSync(
      resolve(ARTIFACT_DIR, `values-${scope}-default-qualification.json`),
      JSON.stringify(
        {
          scope,
          graphSha256: createHash("sha256").update(graph, "utf8").digest("hex"),
          graph,
          evidence,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
});

describe("Event field occurrence report migration", () => {
  it("keeps the real 20001 activity cap ahead of numeric fallback and invalid cursors", async () => {
    const { database, site } = createDatabase();
    database
      .prepare(
        `INSERT INTO sites (id, team_id, name, domain, created_at)
         VALUES (?, 'wave95b-team', 'Event fields cap', 'cap.test', 0)`,
      )
      .run(SITE);
    database.prepare("DELETE FROM custom_events WHERE site_id = ?").run(SITE);
    database.prepare("DELETE FROM visits WHERE site_id = ?").run(SITE);
    database
      .prepare(
        `WITH RECURSIVE generated(n) AS (
           SELECT 1
           UNION ALL SELECT n + 1 FROM generated WHERE n < 20001
         )
         INSERT INTO visits (
           visit_id, site_id, site_pk, visitor_id, session_id, status,
           started_at, last_activity_at, pathname, hostname, duration_ms
         )
         SELECT 'wave95b-cap-activity-' || n, ?, ?,
           'wave95b-cap-visitor', 'wave95b-cap-session', 'closed',
           ?, ?, '/cap-page', 'fields.test', 1
         FROM generated`,
      )
      .run(SITE, site.pk, WINDOW.startMs + 5, WINDOW.startMs + 5);
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave95b-cap-activity-1");

    const trace = traceFor();
    const env = testEnv(database, trace);
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
      diagnostics,
    }).resolve("event-fields");
    if (!provider) throw new Error("wave95b_event_fields_provider_missing");
    const filterDsl = "count(page { page.durationMs gt 5 }) eq 1";
    const capQuery = qualifiedEventFieldsQuery("session", null, filterDsl);
    await expect(provider.execute(capQuery)).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(trace.preparedSql).toHaveLength(2);
    const rawRows = database
      .prepare(trace.preparedSql[1]!)
      .all(...trace.bindings[1]!) as Record<string, unknown>[];
    const controls = rawRows.filter((row) => row.rowKind === "control");
    expect(controls).toHaveLength(1);
    expect(Number(controls[0]!.rawCount)).toBe(20_001);
    expect(
      Object.entries(controls[0]!).some(
        ([name, value]) =>
          name.toLowerCase().includes("duration") && Number(value) > 0,
      ),
    ).toBe(true);
    expect(rawRows.filter((row) => row.rowKind === "report")).toHaveLength(0);
    errorEvidence.push({
      kind: "real-activity-cap-before-numeric-fallback",
      error: {
        kind: "invalid-input",
        path: "filters",
        code: "filter_activity_limit_exceeded",
      },
      rawCount: Number(controls[0]!.rawCount),
      numericIncompatibilityCount: Object.entries(controls[0]!).find(([name]) =>
        name.toLowerCase().includes("duration"),
      )?.[1],
      reportRows: 0,
      statementCount: trace.preparedSql.length,
    });

    trace.preparedSql.length = 0;
    trace.bindings.length = 0;
    const invalidCursorQuery = qualifiedEventFieldsQuery(
      "session",
      "invalid-cursor",
      filterDsl,
    );
    await expect(provider.execute(invalidCursorQuery)).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(trace.preparedSql).toHaveLength(2);
    errorEvidence.push({
      kind: "invalid-cursor-after-cap-preflight",
      error: {
        kind: "invalid-input",
        path: "filters",
        code: "filter_activity_limit_exceeded",
      },
      statementCount: trace.preparedSql.length,
    });
  });

  it("falls back once for numeric-domain incompatibility and keeps the legacy DTO", async () => {
    const { database, site } = createDatabase();
    database
      .prepare(
        `INSERT INTO sites (id, team_id, name, domain, created_at)
         VALUES (?, 'wave95b-team', 'Event fields numeric', 'numeric.test', 0)`,
      )
      .run(SITE);
    database
      .prepare(
        "UPDATE visits SET started_at = ?, last_activity_at = ?, duration_ms = ? WHERE visit_id = ?",
      )
      .run(125, 125, 10, "visit-one");
    database
      .prepare(
        "UPDATE visits SET started_at = ?, last_activity_at = ?, duration_ms = ? WHERE visit_id = ?",
      )
      .run(126, 126, "invalid-duration", "visit-two");

    const query = qualifiedEventFieldsQuery(
      "session",
      null,
      "count(page { page.durationMs gt 5 }) eq 1",
    );
    const expectedTrace = traceFor();
    const expectedEnv = testEnv(database, expectedTrace);
    const deferredQuery = await d1AdvancedFilterMiddleware(expectedEnv)(
      "event-fields",
      query,
      async (prepared) => prepared,
    );
    const deferred = deferredEventFieldsQualificationFromQuery(deferredQuery);
    if (!deferred) throw new Error("wave95b_event_fields_deferred_missing");
    const fallbackFilters =
      await prepareDeferredEventQualificationFallback(deferred);
    const expectedPage = await queryEventFieldsPageFromD1(
      expectedEnv,
      SITE,
      WINDOW,
      fallbackFilters,
      "signup",
      1,
      null,
      "private-dashboard",
    );

    const trace = traceFor();
    const env = testEnv(database, trace);
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
      diagnostics,
    }).resolve("event-fields");
    if (!provider) throw new Error("wave95b_event_fields_provider_missing");
    const actual = await provider.execute(query);
    expect(actual.value).toEqual({
      eventName: "signup",
      data: {
        ...expectedPage,
        items: expectedPage.items.map(mapEventField),
      },
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(trace.preparedSql).toEqual([
      expectedTrace.preparedSql[0],
      trace.preparedSql[1],
      ...expectedTrace.preparedSql.slice(1),
    ]);
    runtimeEvidence.push({
      scope: "session",
      case: "numeric-domain-incompatibility",
      actualDto: actual.value,
      legacyDto: {
        eventName: "signup",
        data: {
          ...expectedPage,
          items: expectedPage.items.map(mapEventField),
        },
      },
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      qualifiedStatementCount: trace.preparedSql.length,
      legacyStatementCount: expectedTrace.preparedSql.length,
      fallbackAddsOneStatement:
        trace.preparedSql.length === expectedTrace.preparedSql.length + 1,
    });
  });

  it.each(["session", "visitor"] as const)(
    "matches the legacy public page for %s qualification with one query and signed cursor",
    async (scope) => {
      const { database, site } = createDatabase();
      database
        .prepare(
          `INSERT INTO sites (id, team_id, name, domain, created_at)
           VALUES (?, 'wave95b-team', 'Event fields', 'fields.test', 0)`,
        )
        .run(SITE);
      database
        .prepare("UPDATE custom_event_names SET name = ? WHERE id = 41")
        .run(" signup ");
      database
        .prepare(
          "UPDATE visits SET started_at = ?, last_activity_at = ? WHERE visit_id = ?",
        )
        .run(125, 125, "visit-one");
      database
        .prepare(
          "UPDATE visits SET started_at = ?, last_activity_at = ? WHERE visit_id = ?",
        )
        .run(126, 126, "visit-two");
      addName(database, site, 44, "   ");
      addEvent(database, site, {
        id: "event-empty-name",
        visitId: "visit-one",
        nameId: 44,
        occurredAt: 127,
      });
      addPayload(database, site, "event-empty-name", "/blank", {
        valueType: 1,
        occurredAt: 107,
        stringValue: "blank",
      });
      const trace = traceFor();
      const env = testEnv(database, trace);
      const query = qualifiedEventFieldsQuery(scope);
      const deferredQuery = await d1AdvancedFilterMiddleware(env)(
        "event-fields",
        query,
        async (prepared) => prepared,
      );
      const deferred = deferredEventFieldsQualificationFromQuery(deferredQuery);
      if (!deferred) throw new Error("wave95b_event_fields_deferred_missing");
      const compilation =
        analyticsQualificationProgram.compileEventFieldsQualificationProgram({
          deferred,
          query: {
            env,
            siteId: SITE,
            queryTime: query.time,
            filters: query.filters,
            ...(query.scopePlan ? { scopePlan: query.scopePlan } : {}),
            eventName: "signup",
            limit: 1,
            cursor: null,
            cursorToken: null,
            audience: "private-dashboard",
          },
        });
      if (compilation.kind !== "compiled")
        throw new Error("wave95b_event_fields_default_compile_unavailable");
      const logicalQualification = buildEventFieldsQualificationPlan({
        siteId: SITE,
        queryTime: query.time,
        filters: query.filters,
        scopePlan: query.scopePlan ?? deferred.metadata.plan,
        count: deferred.countInput,
        options: { eventName: "signup", limit: 1, cursor: null },
      });
      compilationEvidence.push({
        scope,
        evidence: compilation.evidence,
        logicalPlan: logicalQualification.plan,
      });
      const fallbackFilters =
        await prepareDeferredEventQualificationFallback(deferred);
      const expectedFirstPage = await queryEventFieldsPageFromD1(
        env,
        SITE,
        WINDOW,
        fallbackFilters,
        "signup",
        1,
        null,
        "private-dashboard",
      );
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;

      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE,
        diagnostics,
      }).resolve("event-fields");
      if (!provider) throw new Error("wave95b_event_fields_provider_missing");
      const actualFirstPage = await provider.execute(query);
      expect(actualFirstPage.value).toEqual({
        eventName: "signup",
        data: {
          ...expectedFirstPage,
          items: expectedFirstPage.items.map(mapEventField),
        },
      });
      expect(trace.preparedSql).toHaveLength(2);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(expectedFirstPage.pagination.hasMore).toBe(true);
      const firstPageEvidence = {
        legacyDto: {
          eventName: "signup",
          data: {
            ...expectedFirstPage,
            items: expectedFirstPage.items.map(mapEventField),
          },
        },
        actualDto: actualFirstPage.value,
        statementCount: trace.preparedSql.length,
      };

      const cursor = actualFirstPage.value.data.pagination.nextCursor;
      if (!cursor) throw new Error("wave95b_event_fields_cursor_missing");
      const cursorQuery = qualifiedEventFieldsQuery(scope, cursor);
      const expectedCursor = await decodeEventFieldCursor(
        env,
        SITE,
        WINDOW,
        fallbackFilters,
        "signup",
        cursor,
        "private-dashboard",
      );
      if (!expectedCursor)
        throw new Error("wave95b_event_fields_cursor_decode_failed");
      const expectedNextPage = await queryEventFieldsPageFromD1(
        env,
        SITE,
        WINDOW,
        fallbackFilters,
        "signup",
        1,
        expectedCursor,
        "private-dashboard",
      );
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const actualNextPage = await provider.execute(cursorQuery);
      expect(actualNextPage.value).toEqual({
        eventName: "signup",
        data: {
          ...expectedNextPage,
          items: expectedNextPage.items.map(mapEventField),
        },
      });
      expect(trace.preparedSql).toHaveLength(2);
      const nextPageEvidence = {
        legacyDto: {
          eventName: "signup",
          data: {
            ...expectedNextPage,
            items: expectedNextPage.items.map(mapEventField),
          },
        },
        actualDto: actualNextPage.value,
        statementCount: trace.preparedSql.length,
      };

      const paddedRequestQuery = qualifiedEventFieldsQuery(
        scope,
        null,
        undefined,
        " signup ",
      );
      const expectedPaddedPage = await queryEventFieldsPageFromD1(
        env,
        SITE,
        WINDOW,
        fallbackFilters,
        " signup ",
        1,
        null,
        "private-dashboard",
      );
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const actualPaddedPage = await provider.execute(paddedRequestQuery);
      expect(actualPaddedPage.value).toEqual({
        eventName: " signup ",
        data: {
          ...expectedPaddedPage,
          items: expectedPaddedPage.items.map(mapEventField),
        },
      });
      expect(actualPaddedPage.value.data.items).toHaveLength(0);
      expect(trace.preparedSql).toHaveLength(2);
      const paddedNameEvidence = {
        requestEventName: " signup ",
        legacyDto: {
          eventName: " signup ",
          data: {
            ...expectedPaddedPage,
            items: expectedPaddedPage.items.map(mapEventField),
          },
        },
        actualDto: actualPaddedPage.value,
        statementCount: trace.preparedSql.length,
      };

      const whitespaceNameQuery = qualifiedEventFieldsQuery(
        scope,
        null,
        undefined,
        "   ",
      );
      const expectedWhitespacePage = await queryEventFieldsPageFromD1(
        env,
        SITE,
        WINDOW,
        fallbackFilters,
        "   ",
        1,
        null,
        "private-dashboard",
      );
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const actualWhitespaceName = await provider.execute(whitespaceNameQuery);
      expect(actualWhitespaceName.value).toEqual({
        eventName: "   ",
        data: {
          ...expectedWhitespacePage,
          items: expectedWhitespacePage.items.map(mapEventField),
        },
      });
      expect(actualWhitespaceName.value.data.items).toHaveLength(0);
      expect(trace.preparedSql).toHaveLength(2);
      const whitespaceNameEvidence = {
        requestEventName: "   ",
        legacyDto: {
          eventName: "   ",
          data: {
            ...expectedWhitespacePage,
            items: expectedWhitespacePage.items.map(mapEventField),
          },
        },
        actualDto: actualWhitespaceName.value,
        statementCount: trace.preparedSql.length,
      };

      const blankNameQuery = qualifiedEventFieldsQuery(
        scope,
        null,
        undefined,
        "",
        100,
      );
      const expectedBlankNamePage = await queryEventFieldsPageFromD1(
        env,
        SITE,
        WINDOW,
        fallbackFilters,
        undefined,
        100,
        null,
        "private-dashboard",
      );
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const actualBlankName = await provider.execute(blankNameQuery);
      expect(actualBlankName.value).toEqual({
        eventName: undefined,
        data: {
          ...expectedBlankNamePage,
          items: expectedBlankNamePage.items.map(mapEventField),
        },
      });
      expect(
        actualBlankName.value.data.items.some((item) => item.path === "/blank"),
      ).toBe(true);
      expect(trace.preparedSql).toHaveLength(2);
      const blankNameEvidence = {
        requestEventName: "",
        legacyDto: {
          eventName: undefined,
          data: {
            ...expectedBlankNamePage,
            items: expectedBlankNamePage.items.map(mapEventField),
          },
        },
        actualDto: actualBlankName.value,
        statementCount: trace.preparedSql.length,
      };

      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      await expect(
        provider.execute(qualifiedEventFieldsQuery(scope, "invalid-cursor")),
      ).rejects.toThrow("invalid-cursor");
      expect(trace.preparedSql).toHaveLength(2);

      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const mismatchedTimeQuery = {
        ...query,
        time: createQueryTime(110, 130, "UTC", 500),
      } as QualifiedEventFieldsTestQuery;
      await expect(provider.execute(mismatchedTimeQuery)).rejects.toThrow();
      expect(trace.preparedSql).toHaveLength(0);

      const mismatchedSiteQuery = {
        ...query,
        context: siteQueryContext(SIBLING_SITE, "private-dashboard"),
      } as unknown as QualifiedEventFieldsTestQuery;
      await expect(provider.execute(mismatchedSiteQuery)).rejects.toThrow();
      expect(trace.preparedSql).toHaveLength(0);

      const invalidLimitQuery = {
        ...query,
        limit: 0,
      } as QualifiedEventFieldsTestQuery;
      await expect(provider.execute(invalidLimitQuery)).rejects.toThrow();
      expect(trace.preparedSql).toHaveLength(0);

      runtimeEvidence.push({
        scope,
        pages: [firstPageEvidence, nextPageEvidence],
        nameSemantics: [
          paddedNameEvidence,
          whitespaceNameEvidence,
          blankNameEvidence,
        ],
        invalidCursor: { rejected: true, statementCount: 2 },
        mismatchedTime: { rejected: true, statementCount: 0 },
        mismatchedSite: { rejected: true, statementCount: 0 },
        invalidLimit: { rejected: true, statementCount: 0 },
      });
    },
  );

  it("does not run fallback after cancellation, D1 failure, or malformed controls", async () => {
    const { database } = createDatabase();
    database
      .prepare(
        `INSERT INTO sites (id, team_id, name, domain, created_at)
         VALUES (?, 'wave95b-team', 'Event fields failures', 'failures.test', 0)`,
      )
      .run(SITE);
    database
      .prepare(
        "UPDATE visits SET started_at = ?, last_activity_at = ? WHERE visit_id = ?",
      )
      .run(125, 125, "visit-one");
    database
      .prepare(
        "UPDATE visits SET started_at = ?, last_activity_at = ? WHERE visit_id = ?",
      )
      .run(126, 126, "visit-two");
    const query = qualifiedEventFieldsQuery("session");

    const abortTrace = traceFor();
    const abortProvider = createD1SiteProviderRegistry({
      env: testEnv(database, abortTrace),
      siteId: SITE,
    }).resolve("event-fields");
    if (!abortProvider)
      throw new Error("wave95b_event_fields_abort_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortProvider.execute(query, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortTrace.preparedSql).toHaveLength(0);
    errorEvidence.push({
      kind: "pre-abort",
      error: { name: "AbortError" },
      statementCount: abortTrace.preparedSql.length,
    });

    const failedTrace = traceFor();
    const failedEnv = testEnvWithQualifiedReadBehavior(
      database,
      failedTrace,
      "database-failure",
    );
    const failedProvider = createD1SiteProviderRegistry({
      env: failedEnv.env,
      siteId: SITE,
    }).resolve("event-fields");
    if (!failedProvider)
      throw new Error("wave95b_event_fields_failure_provider_missing");
    await expect(failedProvider.execute(query)).rejects.toThrow(
      "wave95b_database_failure",
    );
    expect(failedEnv.prepareCount()).toBe(2);
    expect(failedTrace.preparedSql).toHaveLength(1);
    errorEvidence.push({
      kind: "database-failure",
      error: "wave95b_database_failure",
      prepareCount: failedEnv.prepareCount(),
      successfulPreparedStatements: failedTrace.preparedSql.length,
      fallbackRan: false,
    });

    const malformedTrace = traceFor();
    const malformedEnv = testEnvWithQualifiedReadBehavior(
      database,
      malformedTrace,
      "malformed-controls",
    );
    const malformedProvider = createD1SiteProviderRegistry({
      env: malformedEnv.env,
      siteId: SITE,
    }).resolve("event-fields");
    if (!malformedProvider)
      throw new Error("wave95b_event_fields_control_provider_missing");
    await expect(malformedProvider.execute(query)).rejects.toThrow(
      "analytics_event_summary_qualification_control_row_invalid",
    );
    expect(malformedEnv.prepareCount()).toBe(2);
    expect(malformedTrace.preparedSql).toHaveLength(2);
    errorEvidence.push({
      kind: "malformed-control-row",
      error: "analytics_event_summary_qualification_control_row_invalid",
      prepareCount: malformedEnv.prepareCount(),
      statementCount: malformedTrace.preparedSql.length,
      fallbackRan: false,
    });
  });

  it("keeps the selected Event bag when duplicate RHS owners qualify through a semi-join", async () => {
    const { database } = createDatabase();
    const trace = traceFor();
    const builder = new LogicalPlanBuilder({
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: [SITE as never],
      }),
      time: semanticTemporalDomainsFromQueryTime(TIME),
      scope: resolveAnalyticsScope("event"),
    });
    const selectedSource = builder.source("event", {
      temporalDomain: "read",
      attributes: ["event.report.eventName", "event.report.ownerSessionId"],
    });
    const selectedByName = builder.filter(
      selectedSource,
      builder.compare(
        "eq",
        builder.slot(selectedSource, "attribute:event.report.eventName"),
        builder.literal("signup", { kind: "scalar", scalar: "string" }),
      ),
    );
    const qualificationSource = builder.source("event", {
      temporalDomain: "read",
      attributes: ["event.report.eventName", "event.report.ownerSessionId"],
    });
    const qualificationByName = builder.filter(
      qualificationSource,
      builder.compare(
        "eq",
        builder.slot(qualificationSource, "attribute:event.report.eventName"),
        builder.literal("other", { kind: "scalar", scalar: "string" }),
      ),
    );
    const qualifiedEvents = builder.semiJoin(
      selectedByName,
      qualificationByName,
      [
        {
          left: "attribute:event.report.ownerSessionId",
          right: "attribute:event.report.ownerSessionId",
        },
      ],
    );
    const occurrences = builder.eventPayloadOccurrences(qualifiedEvents);
    const grouped = builder.aggregate(
      occurrences,
      {
        path: builder.slot(occurrences, "path"),
        valueType: builder.slot(occurrences, "valueType"),
      },
      [
        {
          name: "events",
          kind: "count-distinct",
          expression: builder.slot(occurrences, "eventIdentity"),
        },
        { name: "occurrences", kind: "count-rows" },
      ],
    );
    builder.output("semi-qualified-event-fields", grouped, [
      { name: "path", slot: "path" },
      { name: "valueType", slot: "valueType" },
      { name: "events", slot: "events" },
      { name: "occurrences", slot: "occurrences" },
    ]);

    const rows = await queryAnalyticsReportOutputRowsFromD1(
      testEnv(database, trace),
      builder.finish(),
      "semi-qualified-event-fields",
    );

    expect(trace.preparedSql).toHaveLength(1);
    expect(rows).toContainEqual(
      expect.objectContaining({
        path: "/a",
        valueType: 1,
        events: 1,
        occurrences: 2,
      }),
    );
    expect(rows.some((row) => row.path === "/b")).toBe(false);
  });

  it("matches frozen parent raw DTOs, occurrence ordering, and page cursor edges", async () => {
    const { database } = createDatabase();
    const envTrace = traceFor();
    const env = testEnv(database, envTrace);
    const plain = EMPTY_FILTER_DOCUMENT;
    const parent = frozenRows(database, {
      window: WINDOW,
      filters: plain,
      limit: 100,
    });
    const actual = await queryEventFieldsFromD1(
      env,
      SITE,
      WINDOW,
      plain,
      undefined,
      100,
    );
    expect(stableRows(actual)).toEqual(stableRows(parent));
    expect(envTrace.preparedSql).toHaveLength(1);
    const plan = buildEventFieldsPlan({
      siteId: SITE,
      queryTime: TIME,
      filters: plain,
      limit: 100,
    });
    const occurrenceNode = plan.nodes.find(
      (node) => node.kind === "event-payload-occurrences",
    );
    const output = plan.outputs.find(
      (candidate) => candidate.id === "event-fields",
    );
    if (!occurrenceNode || !output)
      throw new Error("wave64_event_fields_logical_nodes_missing");
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE,
      time: plan.context.time,
    });
    lowerer.lower(output);
    expect(lowerer.candidateActivity(occurrenceNode.id)).toBeUndefined();
    expect(
      lowerer.isCandidateActivitySessionRestricted(occurrenceNode.id),
    ).toBe(false);
    const parentQuery = frozenSql({
      window: WINDOW,
      filters: plain,
      limit: 100,
    });
    const queryPlans = [
      queryPlanDetails(
        database,
        envTrace.preparedSql[0]!,
        envTrace.bindings[0] as SQLInputValue[],
      ),
      queryPlanDetails(database, parentQuery.sql, parentQuery.bindings),
    ];
    for (const details of queryPlans) {
      expect(
        details.some((detail) =>
          detail.includes("idx_custom_events_site_pk_time"),
        ),
      ).toBe(true);
      expect(
        details.some((detail) =>
          detail.includes("sqlite_autoindex_custom_event_json_values_1"),
        ),
      ).toBe(true);
      expect(
        details.some(
          (detail) =>
            detail.includes("custom_event_json_paths") ||
            detail.includes("INTEGER PRIMARY KEY"),
        ),
      ).toBe(true);
    }
    expect(
      actual.find((row) => row.path === "/a" && row.valueType === 1),
    ).toEqual({
      path: "/a",
      valueType: 1,
      events: 2,
      occurrences: 3,
      firstSeenAt: 100,
      lastSeenAt: 110,
      stringValue: "a",
      numberValue: 3,
      booleanValue: 0,
    });
    expect(actual.some((row) => row.path.includes("missing-dictionary"))).toBe(
      false,
    );
    expect(actual.some((row) => row.path === "/outside")).toBe(false);
    expect(actual.some((row) => row.path === "/sibling")).toBe(false);

    const firstTrace = traceFor();
    const firstPage = await queryEventFieldsPageFromD1(
      testEnv(database, firstTrace),
      SITE,
      WINDOW,
      plain,
      undefined,
      3,
    );
    const frozenFirst = frozenRows(database, {
      window: WINDOW,
      filters: plain,
      page: true,
      limit: 3,
    });
    expect(firstPage.items).toEqual(frozenFirst.slice(0, 3));
    expect(firstPage.pagination.hasMore).toBe(frozenFirst.length > 3);
    expect(firstTrace.preparedSql).toHaveLength(1);
    expect(firstPage.pagination.nextCursor).not.toBeNull();

    const cursor = await decodeEventFieldCursor(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      plain,
      undefined,
      firstPage.pagination.nextCursor,
    );
    expect(cursor).not.toBeNull();
    const nextTrace = traceFor();
    const nextPage = await queryEventFieldsPageFromD1(
      testEnv(database, nextTrace),
      SITE,
      WINDOW,
      plain,
      undefined,
      3,
      cursor,
    );
    const frozenNext = frozenRows(database, {
      window: WINDOW,
      filters: plain,
      page: true,
      cursor,
      limit: 3,
    });
    expect(nextPage.items).toEqual(frozenNext.slice(0, 3));
    expect(nextPage.pagination.hasMore).toBe(frozenNext.length > 3);
    expect(nextPage.items[0]).toMatchObject({ path: "/a", valueType: 3 });
    expect(nextTrace.preparedSql).toHaveLength(1);
    await expect(
      decodeEventFieldCursor(
        testEnv(database, traceFor()),
        SIBLING_SITE,
        WINDOW,
        plain,
        undefined,
        firstPage.pagination.nextCursor,
      ),
    ).rejects.toThrow("invalid-cursor");
    const cursorRejected = (input: {
      readonly siteId?: string;
      readonly window?: QueryWindow;
      readonly filters?: FilterDocument;
      readonly eventName?: string;
      readonly audience?: "private-dashboard" | "public-share" | "api-v1";
    }) =>
      decodeEventFieldCursor(
        testEnv(database, traceFor()),
        input.siteId ?? SITE,
        input.window ?? WINDOW,
        input.filters ?? plain,
        input.eventName,
        firstPage.pagination.nextCursor,
        input.audience ?? "private-dashboard",
      );
    await expect(cursorRejected({ window: PREVIOUS_WINDOW })).rejects.toThrow(
      "invalid-cursor",
    );
    await expect(
      cursorRejected({ filters: payloadExists40() }),
    ).rejects.toThrow("invalid-cursor");
    await expect(cursorRejected({ eventName: "signup" })).rejects.toThrow(
      "invalid-cursor",
    );
    await expect(cursorRejected({ audience: "public-share" })).rejects.toThrow(
      "invalid-cursor",
    );
    await expect(
      cursorRejected({
        filters: preparedFilters("session", {
          entityIds: ["session-previous"],
        }),
      }),
    ).rejects.toThrow("invalid-cursor");
  });

  it("preserves direct name gates and prepared actual-reader windows", async () => {
    const { database, site } = createDatabase();
    for (const eventName of [undefined, "signup", " signup ", " "]) {
      const trace = traceFor();
      const filters = EMPTY_FILTER_DOCUMENT;
      const actual = await queryEventFieldsFromD1(
        testEnv(database, trace),
        SITE,
        WINDOW,
        filters,
        eventName,
        100,
      );
      const parent = frozenRows(database, {
        window: WINDOW,
        filters,
        eventName,
        limit: 100,
      });
      expect(stableRows(actual)).toEqual(stableRows(parent));
      expect(trace.preparedSql).toHaveLength(1);
      const pageTrace = traceFor();
      const actualPage = await queryEventFieldsPageFromD1(
        testEnv(database, pageTrace),
        SITE,
        WINDOW,
        filters,
        eventName,
        100,
      );
      const parentPage = frozenRows(database, {
        window: WINDOW,
        filters,
        eventName,
        page: true,
        limit: 100,
      });
      expect(actualPage.items).toEqual(parentPage.slice(0, 100));
      expect(pageTrace.preparedSql).toHaveLength(1);
    }
    const directEmpty = await queryEventFieldsFromD1(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      "",
      100,
    );
    const noNameGate = await queryEventFieldsFromD1(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      100,
    );
    expect(stableRows(directEmpty)).toEqual(stableRows(noNameGate));
    const directEmptyPage = await queryEventFieldsPageFromD1(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      "",
      100,
    );
    const noNameGatePage = await queryEventFieldsPageFromD1(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      100,
    );
    expect(directEmptyPage.items).toEqual(noNameGatePage.items);
    const directEmptyParent = frozenSql({
      window: WINDOW,
      filters: EMPTY_FILTER_DOCUMENT,
      eventName: "",
      limit: 100,
    });
    expect(() =>
      database
        .prepare(directEmptyParent.sql)
        .all(...(directEmptyParent.bindings as SQLInputValue[])),
    ).toThrow();

    const directFactFilters = filtersFor({
      kind: "condition",
      target: { kind: "field", field: "event.name" },
      operator: "eq",
      value: "signup",
    } as never);
    const directFactRows = await queryEventFieldsFromD1(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      directFactFilters,
      undefined,
      100,
    );
    expect(stableRows(directFactRows)).toEqual(
      stableRows(
        frozenRows(database, {
          window: WINDOW,
          filters: directFactFilters,
          limit: 100,
        }),
      ),
    );
    const directFactPage = await queryEventFieldsPageFromD1(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      directFactFilters,
      undefined,
      100,
    );
    expect(directFactPage.items).toEqual(
      frozenRows(database, {
        window: WINDOW,
        filters: directFactFilters,
        page: true,
        limit: 100,
      }).slice(0, 100),
    );

    addVisit(database, site, {
      id: "visit-boundary",
      sessionId: "session-boundary",
      visitorId: "visitor-boundary",
      startedAt: 125,
    });
    addEvent(database, site, {
      id: "event-boundary",
      visitId: "visit-boundary",
      nameId: 41,
      occurredAt: 125,
    });
    addPayload(database, site, "event-boundary", "/boundary", {
      valueType: 1,
      occurredAt: 125,
      stringValue: "boundary",
    });
    const sessionBoundaryFilters = filtersFor({
      kind: "condition",
      target: { kind: "field", field: "session.entryPath" },
      operator: "eq",
      value: "/landing",
    } as never);
    const boundaryRows = await queryEventFieldsFromD1(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      sessionBoundaryFilters,
      undefined,
      100,
    );
    expect(stableRows(boundaryRows)).toEqual(
      stableRows(
        frozenRows(database, {
          window: WINDOW,
          filters: sessionBoundaryFilters,
          limit: 100,
        }),
      ),
    );
    expect(boundaryRows).toContainEqual(
      expect.objectContaining({
        path: "/boundary",
        events: 1,
        occurrences: 1,
      }),
    );
    const boundaryPage = await queryEventFieldsPageFromD1(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      sessionBoundaryFilters,
      undefined,
      100,
    );
    expect(boundaryPage.items).toEqual(
      frozenRows(database, {
        window: WINDOW,
        filters: sessionBoundaryFilters,
        page: true,
        limit: 100,
      }).slice(0, 100),
    );

    const preparedProfiles = [
      {
        scope: "event" as const,
        filters: preparedFilters("event", {
          eventIds: ["event-previous"],
          visitIds: ["visit-previous"],
        }),
      },
      {
        scope: "session" as const,
        filters: preparedFilters("session", {
          entityIds: ["session-previous"],
        }),
      },
      {
        scope: "visitor" as const,
        filters: preparedFilters("visitor", {
          entityIds: ["visitor-previous"],
        }),
      },
      {
        scope: "event" as const,
        filters: preparedFilters("event"),
      },
    ];
    for (const profile of preparedProfiles) {
      const trace = traceFor();
      const actual = await queryEventFieldsFromD1(
        testEnv(database, trace),
        SITE,
        PREVIOUS_WINDOW,
        profile.filters,
        undefined,
        100,
      );
      const parent = frozenRows(database, {
        window: PREVIOUS_WINDOW,
        filters: profile.filters,
        limit: 100,
      });
      expect(stableRows(actual)).toEqual(stableRows(parent));
      expect(trace.preparedSql).toHaveLength(1);
      const pageTrace = traceFor();
      const actualPage = await queryEventFieldsPageFromD1(
        testEnv(database, pageTrace),
        SITE,
        PREVIOUS_WINDOW,
        profile.filters,
        undefined,
        100,
      );
      const parentPage = frozenRows(database, {
        window: PREVIOUS_WINDOW,
        filters: profile.filters,
        page: true,
        limit: 100,
      });
      expect(actualPage.items).toEqual(parentPage.slice(0, 100));
      expect(pageTrace.preparedSql).toHaveLength(1);
      if (
        profile.scope === "event" &&
        profile.filters === preparedProfiles[0]!.filters
      )
        expect(actual).toEqual([
          expect.objectContaining({
            path: "/previous",
            stringValue: "previous",
          }),
        ]);
    }
    const preparedNameFilters = preparedFilters("event", {
      eventIds: ["event-previous"],
      visitIds: ["visit-previous"],
    });
    for (const eventName of ["signup", " signup ", " ", ""]) {
      const metadata = scopedFilterMetadata(preparedNameFilters);
      if (!metadata) throw new Error("wave64_prepared_name_metadata_missing");
      const logicalPlan = buildEventFieldsPlan({
        siteId: SITE,
        queryTime: PREVIOUS_TIME,
        filters: preparedNameFilters,
        scopePlan: metadata.plan,
        eventName,
        limit: 100,
      });
      const selectedSource = logicalPlan.nodes.find(
        (node) => node.kind === "source",
      );
      if (!selectedSource || selectedSource.kind !== "source")
        throw new Error("wave64_prepared_name_event_source_missing");
      expect(selectedSource.selection?.profile).toBe(
        "prepared-scoped-reader-window-v1",
      );
      expect(selectedSource.selection?.eventNameGate).toBeUndefined();
      expect(logicalPlan.nodes.some((node) => node.kind === "filter")).toBe(
        Boolean(eventName),
      );
      const actual = await queryEventFieldsFromD1(
        testEnv(database, traceFor()),
        SITE,
        PREVIOUS_WINDOW,
        preparedNameFilters,
        eventName,
        100,
      );
      const parent = frozenRows(database, {
        window: PREVIOUS_WINDOW,
        filters: preparedNameFilters,
        eventName,
        limit: 100,
      });
      expect(stableRows(actual)).toEqual(stableRows(parent));
      const actualPage = await queryEventFieldsPageFromD1(
        testEnv(database, traceFor()),
        SITE,
        PREVIOUS_WINDOW,
        preparedNameFilters,
        eventName,
        100,
      );
      const parentPage = frozenRows(database, {
        window: PREVIOUS_WINDOW,
        filters: preparedNameFilters,
        eventName,
        page: true,
        limit: 100,
      });
      expect(actualPage.items).toEqual(parentPage.slice(0, 100));
    }
  });

  it("matches the frozen Event field-value aggregates and legacy search behavior", async () => {
    const { database, site } = createDatabase();
    const searchStrings = [
      "  Alpha  ",
      "A\tBeta",
      "x\u00a0y",
      "café",
      "literal\\%_",
      "",
    ];
    for (const [index, stringValue] of searchStrings.entries())
      addPayload(database, site, "event-one", "/search/string", {
        valueType: 1,
        occurredAt: 100 + index,
        stringValue,
      });
    addPayload(database, site, "event-two", "/search/string", {
      valueType: 1,
      occurredAt: 111,
      stringValue: "  Alpha  ",
    });
    for (const [index, numberValue] of [
      1.0,
      1e20,
      -2.25,
      null,
      -9223372036854775808,
    ].entries())
      addPayload(database, site, "event-one", "/search/number", {
        valueType: 2,
        occurredAt: 120 + index,
        numberValue,
      });
    for (const [index, booleanValue] of [1, 0, null].entries())
      addPayload(database, site, "event-one", "/search/boolean", {
        valueType: 3,
        occurredAt: 125 + index,
        booleanValue,
      });

    for (const [fieldValueType, valueTypeCode] of [
      ["null", 0],
      ["string", 1],
      ["number", 2],
      ["boolean", 3],
      ["object", 4],
      ["array", 5],
    ] as const) {
      const trace = traceFor();
      const actual = await queryEventFieldValuesFromD1(
        testEnv(database, trace),
        SITE,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        undefined,
        "/a",
        fieldValueType,
        100,
      );
      const parent = frozenValueRows(database, {
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        fieldPath: "/a",
        valueTypeCode,
        limit: 100,
      });
      expect(actual).toEqual(parent);
      expect(trace.preparedSql).toHaveLength(1);
      expect(
        new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(trace.bindings[0]!.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    }

    for (const [fieldPath, fieldValueType, valueTypeCode, searches] of [
      [
        "/search/string",
        "string",
        1,
        [" ALPHA ", "alpha", "x", "CAF", "\\%", "_", "\t", "\u00a0x\u00a0"],
      ],
      ["/search/number", "number", 2, ["1.0", "1e+20", "-2.25", "null"]],
      ["/search/boolean", "boolean", 3, ["true", "false"]],
    ] as const) {
      for (const search of searches) {
        const actual = await queryEventFieldValuesFromD1(
          testEnv(database, traceFor()),
          SITE,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
          undefined,
          fieldPath,
          fieldValueType,
          100,
          search,
        );
        expect(actual).toEqual(
          frozenValueRows(database, {
            window: WINDOW,
            filters: EMPTY_FILTER_DOCUMENT,
            fieldPath,
            valueTypeCode,
            search,
            limit: 100,
          }),
        );
      }
    }

    const noSearchTrace = traceFor();
    const noSearchRows = await queryEventFieldValuesFromD1(
      testEnv(database, noSearchTrace),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/search/string",
      "string",
      100,
    );
    const emptySearchTrace = traceFor();
    expect(
      await queryEventFieldValuesFromD1(
        testEnv(database, emptySearchTrace),
        SITE,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        undefined,
        "/search/string",
        "string",
        100,
        "\t",
      ),
    ).toEqual(noSearchRows);
    expect(emptySearchTrace.preparedSql).toEqual(noSearchTrace.preparedSql);
    expect(emptySearchTrace.bindings).toEqual(noSearchTrace.bindings);

    const directFactFilters = filtersFor({
      kind: "condition",
      target: { kind: "field", field: "event.name" },
      operator: "eq",
      value: "signup",
    } as never);
    for (const scenario of [
      { filters: EMPTY_FILTER_DOCUMENT, eventName: "signup" },
      { filters: directFactFilters, eventName: undefined },
    ]) {
      for (const page of [false, true]) {
        const trace = traceFor();
        if (page) {
          const actual = await queryEventFieldValuesPageFromD1(
            testEnv(database, trace),
            SITE,
            WINDOW,
            scenario.filters,
            scenario.eventName,
            "/a",
            "string",
            100,
          );
          expect(actual.items).toEqual(
            frozenValueRows(database, {
              window: WINDOW,
              filters: scenario.filters,
              ...(scenario.eventName !== undefined
                ? { eventName: scenario.eventName }
                : {}),
              fieldPath: "/a",
              valueTypeCode: 1,
              page: true,
              limit: 100,
            }).slice(0, 100),
          );
        } else {
          const actual = await queryEventFieldValuesFromD1(
            testEnv(database, trace),
            SITE,
            WINDOW,
            scenario.filters,
            scenario.eventName,
            "/a",
            "string",
            100,
          );
          expect(actual).toEqual(
            frozenValueRows(database, {
              window: WINDOW,
              filters: scenario.filters,
              ...(scenario.eventName !== undefined
                ? { eventName: scenario.eventName }
                : {}),
              fieldPath: "/a",
              valueTypeCode: 1,
              limit: 100,
            }),
          );
        }
        expect(trace.preparedSql).toHaveLength(1);
        expect(
          new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
        ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(trace.bindings[0]!.length).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
      }
    }
    const falseBooleanRows = await queryEventFieldValuesFromD1(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/search/boolean",
      "boolean",
      100,
      "false",
    );
    expect(falseBooleanRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ booleanValue: null }),
        expect.objectContaining({ booleanValue: 0 }),
      ]),
    );
    const noNameTrace = traceFor();
    const noNameRows = await queryEventFieldValuesFromD1(
      testEnv(database, noNameTrace),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/a",
      "string",
      100,
    );
    expect(noNameRows).toEqual(
      frozenValueRows(database, {
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        fieldPath: "/a",
        valueTypeCode: 1,
        limit: 100,
      }),
    );
    const emptyNameTrace = traceFor();
    expect(
      await queryEventFieldValuesFromD1(
        testEnv(database, emptyNameTrace),
        SITE,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        "",
        "/a",
        "string",
        100,
      ),
    ).toEqual(noNameRows);
    expect(emptyNameTrace.preparedSql).toEqual(noNameTrace.preparedSql);
    expect(emptyNameTrace.bindings).toEqual(noNameTrace.bindings);

    for (const [fieldPath, fieldValueType, valueTypeCode] of [
      ["/a", "null", 0],
      ["/a", "object", 4],
      ["/a", "array", 5],
    ] as const) {
      expect(
        await queryEventFieldValuesFromD1(
          testEnv(database, traceFor()),
          SITE,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
          undefined,
          fieldPath,
          fieldValueType,
          100,
          "search",
        ),
      ).toEqual(
        frozenValueRows(database, {
          window: WINDOW,
          filters: EMPTY_FILTER_DOCUMENT,
          fieldPath,
          valueTypeCode,
          search: "search",
          limit: 100,
        }),
      );
    }

    const invalidTrace = traceFor();
    expect(
      await queryEventFieldValuesFromD1(
        testEnv(database, invalidTrace),
        SITE,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        undefined,
        "/a",
        "String",
        100,
      ),
    ).toEqual([]);
    expect(invalidTrace.preparedSql).toHaveLength(0);
    const invalidPageTrace = traceFor();
    expect(
      await queryEventFieldValuesPageFromD1(
        testEnv(database, invalidPageTrace),
        SITE,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        undefined,
        "/a",
        "unknown",
        10,
      ),
    ).toEqual({
      items: [],
      pagination: { limit: 10, returned: 0, hasMore: false, nextCursor: null },
    });
    expect(invalidPageTrace.preparedSql).toHaveLength(0);
  });

  it("keeps Event field-value page aliases, lexicographic cursors, and HMAC bindings", async () => {
    const { database, site } = createDatabase();
    addPayload(database, site, "event-one", "/search/string", {
      valueType: 1,
      occurredAt: 121,
      stringValue: "Beta",
    });
    addPayload(database, site, "event-one", "/search/string", {
      valueType: 1,
      occurredAt: 122,
      stringValue: "Delta",
    });
    addPayload(database, site, "event-one", "/search/number", {
      valueType: 2,
      occurredAt: 123,
      numberValue: null,
    });
    addPayload(database, site, "event-one", "/search/number", {
      valueType: 2,
      occurredAt: 124,
      numberValue: -9223372036854775808,
    });
    const trace = traceFor({ readBigIntsAsNumbers: true });
    const first = await queryEventFieldValuesPageFromD1(
      testEnv(database, trace),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/a",
      "string",
      1,
    );
    expect(first.items).toEqual(
      frozenValueRows(database, {
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        fieldPath: "/a",
        valueTypeCode: 1,
        page: true,
        limit: 1,
      }).slice(0, 1),
    );
    expect(first.items[0]).toHaveProperty("valueString");
    expect(first.items[0]).toHaveProperty("valueNumber");
    expect(first.items[0]).toHaveProperty("valueBoolean");
    expect(first.pagination.hasMore).toBe(true);
    expect(trace.preparedSql).toHaveLength(1);

    const cursor = await decodeEventFieldValueCursor(
      testEnv(database, traceFor({ readBigIntsAsNumbers: true })),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/a",
      "string",
      undefined,
      first.pagination.nextCursor,
    );
    expect(cursor).not.toBeNull();
    const next = await queryEventFieldValuesPageFromD1(
      testEnv(database, traceFor({ readBigIntsAsNumbers: true })),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/a",
      "string",
      1,
      undefined,
      cursor,
    );
    expect(next.items).toEqual(
      frozenValueRows(database, {
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        fieldPath: "/a",
        valueTypeCode: 1,
        page: true,
        cursor,
        limit: 1,
      }).slice(0, 1),
    );

    const searchedTrace = traceFor({ readBigIntsAsNumbers: true });
    const searchedFirst = await queryEventFieldValuesPageFromD1(
      testEnv(database, searchedTrace),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/search/string",
      "string",
      1,
      "e",
    );
    expect(searchedFirst.items).toEqual(
      frozenValueRows(database, {
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        fieldPath: "/search/string",
        valueTypeCode: 1,
        search: "e",
        page: true,
        limit: 1,
      }).slice(0, 1),
    );
    expect(searchedFirst.pagination.hasMore).toBe(true);
    const searchedCursor = await decodeEventFieldValueCursor(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/search/string",
      "string",
      "e",
      searchedFirst.pagination.nextCursor,
    );
    const searchedNextTrace = traceFor({ readBigIntsAsNumbers: true });
    const searchedNext = await queryEventFieldValuesPageFromD1(
      testEnv(database, searchedNextTrace),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/search/string",
      "string",
      1,
      "e",
      searchedCursor,
    );
    expect(searchedNext.items).toEqual(
      frozenValueRows(database, {
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        fieldPath: "/search/string",
        valueTypeCode: 1,
        search: "e",
        page: true,
        cursor: searchedCursor,
        limit: 1,
      }).slice(0, 1),
    );
    expect(
      new TextEncoder().encode(searchedTrace.preparedSql[0]!).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(searchedTrace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    expect(
      new TextEncoder().encode(searchedNextTrace.preparedSql[0]!).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(searchedNextTrace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );

    const sentinelTrace = traceFor({ readBigIntsAsNumbers: true });
    const sentinelFirst = await queryEventFieldValuesPageFromD1(
      testEnv(database, sentinelTrace),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/search/number",
      "number",
      1,
    );
    expect(sentinelFirst.items).toEqual(
      frozenValueRows(database, {
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        fieldPath: "/search/number",
        valueTypeCode: 2,
        page: true,
        limit: 1,
      }).slice(0, 1),
    );
    expect(sentinelFirst.items[0]).toHaveProperty("valueNumber");
    expect(sentinelTrace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    expect(sentinelFirst.pagination.hasMore).toBe(true);
    const sentinelCursor = await decodeEventFieldValueCursor(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/search/number",
      "number",
      undefined,
      sentinelFirst.pagination.nextCursor,
    );
    expect(sentinelCursor?.numberValue).toBe(-9223372036854775808);
    const sentinelNext = await queryEventFieldValuesPageFromD1(
      testEnv(database, traceFor({ readBigIntsAsNumbers: true })),
      SITE,
      WINDOW,
      EMPTY_FILTER_DOCUMENT,
      undefined,
      "/search/number",
      "number",
      1,
      undefined,
      sentinelCursor,
    );
    expect(sentinelNext.items).toEqual(
      frozenValueRows(database, {
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        fieldPath: "/search/number",
        valueTypeCode: 2,
        page: true,
        cursor: sentinelCursor,
        limit: 1,
      }).slice(0, 1),
    );
    expect(sentinelNext.items).toEqual([]);

    const token = first.pagination.nextCursor;
    if (!token) throw new Error("wave65_expected_value_page_cursor");
    const changedFilters = filtersFor({
      kind: "condition",
      target: { kind: "field", field: "event.name" },
      operator: "eq",
      value: "signup",
    } as never);
    const changedScope = preparedFilters("event");
    const mismatchCases = [
      [
        SITE,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        undefined,
        "/b",
        "string",
        undefined,
        "private-dashboard",
      ],
      [
        SITE,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        undefined,
        "/a",
        "number",
        undefined,
        "private-dashboard",
      ],
      [
        SITE,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        undefined,
        "/a",
        "string",
        "x",
        "private-dashboard",
      ],
      [
        SITE,
        PREVIOUS_WINDOW,
        EMPTY_FILTER_DOCUMENT,
        undefined,
        "/a",
        "string",
        undefined,
        "private-dashboard",
      ],
      [
        SITE,
        WINDOW,
        changedFilters,
        undefined,
        "/a",
        "string",
        undefined,
        "private-dashboard",
      ],
      [
        SITE,
        WINDOW,
        changedScope,
        undefined,
        "/a",
        "string",
        undefined,
        "private-dashboard",
      ],
      [
        SITE,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        "other",
        "/a",
        "string",
        undefined,
        "private-dashboard",
      ],
      [
        SIBLING_SITE,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        undefined,
        "/a",
        "string",
        undefined,
        "private-dashboard",
      ],
      [
        SITE,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        undefined,
        "/a",
        "string",
        undefined,
        "api-v1",
      ],
    ] as const;
    for (const [
      siteId,
      window,
      filters,
      eventName,
      path,
      type,
      search,
      audience,
    ] of mismatchCases)
      await expect(
        decodeEventFieldValueCursor(
          testEnv(database, traceFor()),
          siteId,
          window,
          filters,
          eventName,
          path,
          type,
          search,
          token,
          audience,
        ),
      ).rejects.toThrow("invalid-cursor");

    const limitSource = buildEventFieldsPlan({
      siteId: SITE,
      queryTime: TIME,
      filters: EMPTY_FILTER_DOCUMENT,
      limit: -1,
    });
    expect(limitSource.nodes.some((node) => node.kind === "limit")).toBe(false);
    expect(() =>
      buildEventFieldsPlan({
        siteId: SITE,
        queryTime: TIME,
        filters: EMPTY_FILTER_DOCUMENT,
        limit: -0.5,
      }),
    ).toThrow("logical_builder_invalid_limit");
  });

  it("keeps a non-empty direct-40 payload filter under the D1 statement budgets", async () => {
    const { database, site } = createDatabase();
    addVisit(database, site, {
      id: "visit-forty",
      sessionId: "session-forty",
      visitorId: "visitor-forty",
    });
    addVisit(database, site, {
      id: "visit-thirty-nine",
      sessionId: "session-thirty-nine",
      visitorId: "visitor-thirty-nine",
    });
    addEvent(database, site, {
      id: "event-forty",
      visitId: "visit-forty",
      nameId: 41,
      occurredAt: 125,
    });
    addEvent(database, site, {
      id: "event-thirty-nine",
      visitId: "visit-thirty-nine",
      nameId: 41,
      occurredAt: 125,
    });
    for (let index = 0; index < 40; index += 1) {
      addPayload(database, site, "event-forty", `/wave64/payload-${index}`, {
        valueType: 1,
        occurredAt: 125,
        stringValue: "present",
      });
      if (index < 39)
        addPayload(
          database,
          site,
          "event-thirty-nine",
          `/wave64/payload-${index}`,
          { valueType: 1, occurredAt: 125, stringValue: "present" },
        );
    }
    const filters = payloadExists40();
    const trace = traceFor();
    const actual = await queryEventFieldsFromD1(
      testEnv(database, trace),
      SITE,
      WINDOW,
      filters,
      undefined,
      100,
    );
    const parent = frozenRows(database, {
      window: WINDOW,
      filters,
      limit: 100,
    });
    expect(stableRows(actual)).toEqual(stableRows(parent));
    expect(actual).toHaveLength(40);
    expect(actual).toContainEqual(
      expect.objectContaining({
        path: "/wave64/payload-0",
        events: 1,
        occurrences: 1,
      }),
    );
    expect(actual.every((row) => row.events === 1)).toBe(true);
    expect(trace.preparedSql).toHaveLength(1);
    expect(
      new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(trace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );

    for (const page of [false, true]) {
      const valueTrace = traceFor({ readBigIntsAsNumbers: page });
      if (page) {
        const actualPage = await queryEventFieldValuesPageFromD1(
          testEnv(database, valueTrace),
          SITE,
          WINDOW,
          filters,
          undefined,
          "/wave64/payload-0",
          "string",
          100,
        );
        expect(actualPage.items).toEqual(
          frozenValueRows(database, {
            window: WINDOW,
            filters,
            fieldPath: "/wave64/payload-0",
            valueTypeCode: 1,
            page: true,
            limit: 100,
          }).slice(0, 100),
        );
        expect(actualPage.items).toHaveLength(1);
        expect(actualPage.items[0]).toMatchObject({
          events: 1,
          occurrences: 1,
        });
      } else {
        const actualValues = await queryEventFieldValuesFromD1(
          testEnv(database, valueTrace),
          SITE,
          WINDOW,
          filters,
          undefined,
          "/wave64/payload-0",
          "string",
          100,
        );
        expect(actualValues).toEqual(
          frozenValueRows(database, {
            window: WINDOW,
            filters,
            fieldPath: "/wave64/payload-0",
            valueTypeCode: 1,
            limit: 100,
          }),
        );
        expect(actualValues).toHaveLength(1);
        expect(actualValues[0]).toMatchObject({ events: 1, occurrences: 1 });
      }
      expect(valueTrace.preparedSql).toHaveLength(1);
      expect(
        new TextEncoder().encode(valueTrace.preparedSql[0]!).byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(valueTrace.bindings[0]!.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    }

    const prepared128 = preparedFilters("event", {
      entityCount: 128,
      eventIds: Array.from(
        { length: 128 },
        (_unused, index) => `wave64-event-${index}`,
      ),
      visitIds: Array.from(
        { length: 128 },
        (_unused, index) => `wave64-visit-${index}`,
      ),
    });
    const preparedTrace = traceFor();
    const preparedRows = await queryEventFieldsFromD1(
      testEnv(database, preparedTrace),
      SITE,
      WINDOW,
      prepared128,
      undefined,
      100,
    );
    const preparedParent = frozenRows(database, {
      window: WINDOW,
      filters: prepared128,
      limit: 100,
    });
    expect(stableRows(preparedRows)).toEqual(stableRows(preparedParent));
    expect(preparedTrace.preparedSql).toHaveLength(1);
    expect(
      new TextEncoder().encode(preparedTrace.preparedSql[0]!).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(preparedTrace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );

    const preparedEmpty = preparedFilters("event");
    const preparedValueProfiles = [
      { filters: prepared128, window: WINDOW },
      { filters: preparedEmpty, window: WINDOW },
      { filters: preparedEmpty, window: PREVIOUS_WINDOW },
    ];
    for (const profile of preparedValueProfiles) {
      for (const page of [false, true]) {
        const valueTrace = traceFor();
        const fieldPath =
          profile.window === PREVIOUS_WINDOW ? "/previous" : "/a";
        if (page)
          expect(
            (
              await queryEventFieldValuesPageFromD1(
                testEnv(database, valueTrace),
                SITE,
                profile.window,
                profile.filters,
                "signup",
                fieldPath,
                "string",
                100,
              )
            ).items,
          ).toEqual(
            frozenValueRows(database, {
              window: profile.window,
              filters: profile.filters,
              eventName: "signup",
              fieldPath,
              valueTypeCode: 1,
              page: true,
              limit: 100,
            }).slice(0, 100),
          );
        else
          expect(
            await queryEventFieldValuesFromD1(
              testEnv(database, valueTrace),
              SITE,
              profile.window,
              profile.filters,
              "signup",
              fieldPath,
              "string",
              100,
            ),
          ).toEqual(
            frozenValueRows(database, {
              window: profile.window,
              filters: profile.filters,
              eventName: "signup",
              fieldPath,
              valueTypeCode: 1,
              limit: 100,
            }),
          );
        expect(valueTrace.preparedSql).toHaveLength(1);
        expect(
          new TextEncoder().encode(valueTrace.preparedSql[0]!).byteLength,
        ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(valueTrace.bindings[0]!.length).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
      }
    }
  });

  it.each(["session", "visitor"] as const)(
    "fuses field-value pages for %s and preserves the legacy DTO and cursor",
    async (scope) => {
      const { database, site } = createDatabase();
      database
        .prepare(
          `INSERT INTO sites (id, team_id, name, domain, created_at)
           VALUES (?, 'wave95c-team', 'Event field values', 'values.test', 0)`,
        )
        .run(SITE);
      database
        .prepare("UPDATE custom_event_names SET name = ? WHERE id = 41")
        .run(" signup ");
      database
        .prepare(
          "UPDATE visits SET started_at = ?, last_activity_at = ? WHERE visit_id = ?",
        )
        .run(125, 125, "visit-one");
      database
        .prepare(
          "UPDATE visits SET started_at = ?, last_activity_at = ? WHERE visit_id = ?",
        )
        .run(126, 126, "visit-two");
      addVisit(database, site, {
        id: "visit-one-second-session",
        sessionId: "session-three",
        visitorId: "visitor-one",
      });
      database
        .prepare(
          "UPDATE visits SET started_at = ?, last_activity_at = ? WHERE visit_id = ?",
        )
        .run(127, 127, "visit-one-second-session");
      addEvent(database, site, {
        id: "event-one-second-session",
        visitId: "visit-one-second-session",
        nameId: 41,
        occurredAt: 127,
      });
      addPayload(database, site, "event-one-second-session", "/a", {
        valueType: 1,
        occurredAt: 115,
        stringValue: "a",
        numberValue: 3,
        booleanValue: 0,
      });

      const trace = traceFor();
      const env = testEnv(database, trace);
      const baseQuery = qualifiedEventFieldValuesQuery(scope);
      const deferredQuery = await d1AdvancedFilterMiddleware(env)(
        "event-field-values",
        baseQuery,
        async (prepared) => prepared,
      );
      const deferred =
        deferredEventFieldValuesQualificationFromQuery(deferredQuery);
      if (!deferred)
        throw new Error("wave95c_event_field_values_deferred_missing");
      const fallbackFilters =
        await prepareDeferredEventQualificationFallback(deferred);
      runtimeEvidence.push({
        scope,
        case: "qualified-values-fallback-match-identities",
        advancedMatches:
          scopedFilterMetadata(fallbackFilters)?.plan.advancedMatches,
      });
      const valuesQualification = buildEventFieldValuesQualificationPlan({
        siteId: SITE,
        queryTime: baseQuery.time,
        filters: baseQuery.filters,
        scopePlan: baseQuery.scopePlan ?? deferred.metadata.plan,
        count: deferred.countInput,
        eventName: baseQuery.eventName,
        options: {
          fieldPath: baseQuery.fieldPath,
          valueTypeCode: 1,
          limit: baseQuery.limit,
        },
      });
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE,
      }).resolve("event-field-values");
      if (!provider)
        throw new Error("wave95c_event_field_values_provider_missing");

      const comparePage = async (query: QualifiedEventFieldValuesTestQuery) => {
        const cursor = await decodeEventFieldValueCursor(
          env,
          SITE,
          WINDOW,
          fallbackFilters,
          query.eventName,
          query.fieldPath,
          query.fieldValueType,
          query.search,
          query.cursor,
          "private-dashboard",
        );
        if (query.cursor && !cursor)
          throw new Error("wave95c_legacy_values_cursor_rejected");
        const expectedPage = await queryEventFieldValuesPageFromD1(
          env,
          SITE,
          WINDOW,
          fallbackFilters,
          query.eventName,
          query.fieldPath,
          query.fieldValueType,
          query.limit,
          query.search,
          cursor,
          "private-dashboard",
        );
        const expected = {
          eventName: query.eventName,
          fieldPath: query.fieldPath,
          fieldValueType: query.fieldValueType,
          data: {
            ...expectedPage,
            items: expectedPage.items.map(mapEventFieldValue),
          },
        };
        trace.preparedSql.length = 0;
        trace.bindings.length = 0;
        const actual = await provider.execute(query);
        expect(actual.value).toEqual(expected);
        expect(trace.preparedSql).toHaveLength(2);
        const sqlBytes = trace.preparedSql.map(
          (sql) => new TextEncoder().encode(sql).byteLength,
        );
        const bindingCounts = trace.bindings.map(({ length }) => length);
        expect(sqlBytes[1]).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(bindingCounts[1]).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
        runtimeEvidence.push({
          scope,
          case: `qualified-values-${query.fieldValueType}-${query.fieldPath}-${query.search ?? "no-search"}-${query.cursor ? "cursor" : "first"}`,
          actualDto: actual.value,
          legacyDto: expected,
          statementCount: trace.preparedSql.length,
          sqlBytes,
          bindingCounts,
        });
        return actual.value as unknown as {
          readonly data: {
            readonly items: readonly {
              readonly value: string | number | boolean | null;
              readonly events: number;
            }[];
            readonly pagination: { readonly nextCursor: string | null };
          };
        };
      };

      const firstStringPage = await comparePage(baseQuery);
      valuesCompilationEvidence.push({
        scope,
        evidence: {
          statementCount: trace.preparedSql.length,
          sqlBytes: new TextEncoder().encode(trace.preparedSql[1]!).byteLength,
          bindingCount: trace.bindings[1]!.length,
        },
        logicalPlan: valuesQualification.plan,
      });
      expect(firstStringPage.data.items[0]).toMatchObject({
        value: "a",
        events: 2,
      });
      const nextCursor = firstStringPage.data.pagination.nextCursor;
      expect(nextCursor).toBeTruthy();
      await comparePage(
        qualifiedEventFieldValuesQuery(scope, { cursor: nextCursor }),
      );

      for (const [fieldValueType, fieldPath] of [
        ["null", "/a"],
        ["number", "/a"],
        ["boolean", "/a"],
        ["object", "/a"],
        ["array", "/a"],
        ["number", "/b"],
      ] as const)
        await comparePage(
          qualifiedEventFieldValuesQuery(scope, {
            fieldPath,
            fieldValueType,
            limit: 25,
          }),
        );

      await comparePage(
        qualifiedEventFieldValuesQuery(scope, {
          search: " A ",
          limit: 5,
        }),
      );
      await comparePage(
        qualifiedEventFieldValuesQuery(scope, { fieldPath: " /a " }),
      );
      await comparePage(
        qualifiedEventFieldValuesQuery(scope, { eventName: "signup " }),
      );
    },
  );

  it("prepares Count before an unknown field-value type and keeps cap ahead of an invalid cursor", async () => {
    const { database, site } = createDatabase();
    database
      .prepare(
        `INSERT INTO sites (id, team_id, name, domain, created_at)
         VALUES (?, 'wave95c-team', 'Event field values guards', 'guards.test', 0)`,
      )
      .run(SITE);
    const trace = traceFor();
    const env = testEnv(database, trace);
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
    }).resolve("event-field-values");
    if (!provider)
      throw new Error("wave95c_event_field_values_provider_missing");
    const unknownType = await provider.execute(
      qualifiedEventFieldValuesQuery("session", {
        fieldValueType: "String",
      }),
    );
    expect(unknownType.value).toMatchObject({
      data: {
        items: [],
        pagination: { returned: 0, hasMore: false, nextCursor: null },
      },
    });
    expect(trace.preparedSql.length).toBeGreaterThan(0);
    expect(trace.preparedSql).toHaveLength(trace.bindings.length);
    errorEvidence.push({
      kind: "unknown-event-field-value-type-keeps-count-preparation",
      preparedStatementCount: trace.preparedSql.length,
      returned: 0,
    });

    database.prepare("DELETE FROM custom_events WHERE site_id = ?").run(SITE);
    database.prepare("DELETE FROM visits WHERE site_id = ?").run(SITE);
    database
      .prepare(
        `WITH RECURSIVE generated(n) AS (
           SELECT 1
           UNION ALL SELECT n + 1 FROM generated WHERE n < 20001
         )
         INSERT INTO visits (
           visit_id, site_id, site_pk, visitor_id, session_id, status,
           started_at, last_activity_at, pathname, hostname, duration_ms
         )
         SELECT 'wave95c-values-cap-' || n, ?, ?,
           'wave95c-values-cap-visitor', 'wave95c-values-cap-session', 'closed',
           ?, ?, '/cap-page', 'values.test', 1
         FROM generated`,
      )
      .run(SITE, site.pk, WINDOW.startMs + 5, WINDOW.startMs + 5);
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave95c-values-cap-1");
    trace.preparedSql.length = 0;
    trace.bindings.length = 0;
    const diagnostics = createD1ReadDiagnostics();
    const capProvider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
      diagnostics,
    }).resolve("event-field-values");
    if (!capProvider)
      throw new Error("wave95c_event_field_values_provider_missing");
    await expect(
      capProvider.execute(
        qualifiedEventFieldValuesQuery("session", {
          cursor: "invalid-cursor",
          filterDsl: "count(page { page.durationMs gt 5 }) eq 1",
        }),
      ),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(trace.preparedSql).toHaveLength(2);
    const rawRows = database
      .prepare(trace.preparedSql[1]!)
      .all(...trace.bindings[1]!) as Record<string, unknown>[];
    const controls = rawRows.filter((row) => row.rowKind === "control");
    expect(controls).toHaveLength(1);
    expect(Number(controls[0]!.rawCount)).toBe(20_001);
    const numericMismatch = Object.entries(controls[0]!).find(
      ([name, value]) =>
        name.toLowerCase().includes("duration") && Number(value) > 0,
    );
    expect(numericMismatch).toBeDefined();
    const reportRowCount = rawRows.filter(
      (row) => row.rowKind === "report",
    ).length;
    expect(reportRowCount).toBe(0);
    errorEvidence.push({
      kind: "event-field-values-cap-before-numeric-fallback-and-invalid-cursor",
      preparedStatementCount: trace.preparedSql.length,
      rawCount: Number(controls[0]!.rawCount),
      numericMismatchCount: numericMismatch?.[1],
      reportRowCount,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      error: {
        path: "filters",
        code: "filter_activity_limit_exceeded",
      },
    });
  });

  it("falls back once for field-value numeric incompatibility and keeps the legacy DTO", async () => {
    const { database } = createDatabase();
    database
      .prepare(
        `INSERT INTO sites (id, team_id, name, domain, created_at)
         VALUES (?, 'wave95c-team', 'Event field values numeric', 'values-numeric.test', 0)`,
      )
      .run(SITE);
    database
      .prepare(
        "UPDATE visits SET started_at = ?, last_activity_at = ?, duration_ms = ? WHERE visit_id = ?",
      )
      .run(125, 125, 10, "visit-one");
    database
      .prepare(
        "UPDATE visits SET started_at = ?, last_activity_at = ?, duration_ms = ? WHERE visit_id = ?",
      )
      .run(126, 126, "invalid-duration", "visit-two");

    const query = qualifiedEventFieldValuesQuery("session", {
      filterDsl: "count(page { page.durationMs gt 5 }) eq 1",
      limit: 5,
    });
    const expectedTrace = traceFor();
    const expectedEnv = testEnv(database, expectedTrace);
    const deferredQuery = await d1AdvancedFilterMiddleware(expectedEnv)(
      "event-field-values",
      query,
      async (prepared) => prepared,
    );
    const deferred =
      deferredEventFieldValuesQualificationFromQuery(deferredQuery);
    if (!deferred)
      throw new Error("wave95c_event_field_values_deferred_missing");
    const fallbackFilters =
      await prepareDeferredEventQualificationFallback(deferred);
    const expectedPage = await queryEventFieldValuesPageFromD1(
      expectedEnv,
      SITE,
      WINDOW,
      fallbackFilters,
      query.eventName,
      query.fieldPath,
      query.fieldValueType,
      query.limit,
      query.search,
      null,
      "private-dashboard",
    );

    const trace = traceFor();
    const env = testEnv(database, trace);
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
      diagnostics,
    }).resolve("event-field-values");
    if (!provider)
      throw new Error("wave95c_event_field_values_provider_missing");
    const actual = await provider.execute(query);
    const expected = {
      eventName: query.eventName,
      fieldPath: query.fieldPath,
      fieldValueType: query.fieldValueType,
      data: {
        ...expectedPage,
        items: expectedPage.items.map(mapEventFieldValue),
      },
    };
    expect(actual.value).toEqual(expected);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(trace.preparedSql).toEqual([
      expectedTrace.preparedSql[0],
      trace.preparedSql[1],
      ...expectedTrace.preparedSql.slice(1),
    ]);
    runtimeEvidence.push({
      scope: "session",
      case: "event-field-values-numeric-domain-fallback-once",
      actualDto: actual.value,
      legacyDto: expected,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      statementCount: trace.preparedSql.length,
    });
  });

  it.each(EVENT_CANDIDATE_FILTERS)(
    "qualifies Event field pages through Count with $shape and preserves the signed next page",
    async ({ shape, dsl: filterDsl }) => {
      const { database, site } = createDatabase();
      prepareEventCandidateFixture(database, "Event field candidate");
      if (shape === "top-level OR/NOT") {
        addEvent(database, site, {
          id: "event-or-other",
          visitId: "visit-two",
          nameId: 42,
          occurredAt: 129,
        });
        addPayload(database, site, "event-or-other", "/or-only", {
          valueType: 1,
          occurredAt: 129,
          stringValue: "or-only",
        });
      }
      const reportEventName = shape === "top-level AND" ? "signup" : null;
      const pageLimit = shape === "top-level AND" ? 2 : 3;
      const query = qualifiedEventFieldsQuery(
        "event",
        null,
        filterDsl,
        reportEventName,
        pageLimit,
      );
      const oracleTrace = traceFor();
      const oracleEnv = testEnv(database, oracleTrace);
      const prepared = await d1AdvancedFilterMiddleware(oracleEnv)(
        "event-fields",
        query,
        async (value) => value,
      );
      const deferred = deferredEventFieldsQualificationFromQuery(prepared);
      if (!deferred) throw new Error("wave97ej_event_fields_deferred_missing");
      expect(deferred.countInput.scope).toBe("event");
      expect(deferred.countInput.candidateAnchor?.kind).toBe("event-candidate");

      const fallbackFilters =
        await prepareDeferredEventQualificationFallback(deferred);
      oracleTrace.preparedSql.length = 0;
      oracleTrace.bindings.length = 0;
      const expectedFirstPage = await queryEventFieldsPageFromD1(
        oracleEnv,
        SITE,
        WINDOW,
        fallbackFilters,
        reportEventName ?? undefined,
        pageLimit,
        null,
        "private-dashboard",
      );
      const firstCoreTrace = {
        preparedSql: [...oracleTrace.preparedSql],
        bindings: oracleTrace.bindings.map((bindings) => [...bindings]),
      };
      const trace = traceFor();
      const env = testEnv(database, trace);
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE,
        diagnostics,
      }).resolve("event-fields");
      if (!provider) throw new Error("wave97ej_event_fields_provider_missing");
      const firstExecution = await captureEventFieldsExecution(() =>
        provider.execute(query),
      );
      const actualFirstPage = firstExecution.value;
      expect(firstExecution.callCount).toBe(1);
      expect(firstExecution.evidence).toHaveLength(1);
      expect(
        firstExecution.evidence[0]!.groupedSummaryMaterializations,
      ).toHaveLength(2);
      expect(
        firstExecution.evidence[0]!.groupedSummaryMaterializations?.every(
          ({ materialization }) => materialization === "materialized",
        ),
      ).toBe(true);
      const expectedFirstDto = {
        eventName: reportEventName ?? undefined,
        data: {
          ...expectedFirstPage,
          items: expectedFirstPage.items.map(mapEventField),
        },
      };
      expect(actualFirstPage.value).toEqual(expectedFirstDto);
      expect(trace.preparedSql).toHaveLength(2);
      const firstRows = database
        .prepare(trace.preparedSql[1]!)
        .all(...trace.bindings[1]!) as Record<string, unknown>[];
      expect(firstRows.filter((row) => row.rowKind === "control")).toHaveLength(
        1,
      );
      expect(
        firstRows.filter((row) => row.rowKind === "report").length,
      ).toBeGreaterThan(0);
      expect(
        new TextEncoder().encode(trace.preparedSql[1]!).byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(trace.bindings[1]!.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      const firstNativeTrace = {
        preparedSql: [...trace.preparedSql],
        bindings: trace.bindings.map((bindings) => [...bindings]),
      };

      const firstCursor = (
        actualFirstPage.value as unknown as {
          readonly data: {
            readonly pagination: { readonly nextCursor: string | null };
          };
        }
      ).data.pagination.nextCursor;
      expect(firstCursor).toEqual(expect.any(String));
      const decodedCursor = await decodeEventFieldCursor(
        oracleEnv,
        SITE,
        WINDOW,
        fallbackFilters,
        reportEventName ?? undefined,
        firstCursor,
        "private-dashboard",
      );
      expect(decodedCursor).not.toBeNull();
      oracleTrace.preparedSql.length = 0;
      oracleTrace.bindings.length = 0;
      const expectedNextPage = await queryEventFieldsPageFromD1(
        oracleEnv,
        SITE,
        WINDOW,
        fallbackFilters,
        reportEventName ?? undefined,
        pageLimit,
        decodedCursor,
        "private-dashboard",
      );
      const nextCoreTrace = {
        preparedSql: [...oracleTrace.preparedSql],
        bindings: oracleTrace.bindings.map((bindings) => [...bindings]),
      };
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const nextExecution = await captureEventFieldsExecution(() =>
        provider.execute({ ...query, cursor: firstCursor ?? undefined }),
      );
      const actualNextPage = nextExecution.value;
      expect(nextExecution.callCount).toBe(1);
      expect(nextExecution.evidence).toHaveLength(1);
      expect(
        nextExecution.evidence[0]!.groupedSummaryMaterializations,
      ).toHaveLength(2);
      expect(actualNextPage.value).toEqual({
        eventName: reportEventName ?? undefined,
        data: {
          ...expectedNextPage,
          items: expectedNextPage.items.map(mapEventField),
        },
      });
      expect(expectedNextPage.pagination).toMatchObject({
        hasMore: false,
        nextCursor: null,
      });
      const completeFieldKeys = [
        ...expectedFirstDto.data.items,
        ...expectedNextPage.items.map(mapEventField),
      ].map(({ path, valueType }) => `${path}:${valueType}`);
      expect(completeFieldKeys.sort()).toEqual(
        [
          "/a:boolean",
          "/a:number",
          "/a:string",
          ...(shape === "top-level OR/NOT" ? ["/or-only:string"] : []),
        ].sort(),
      );
      expect(trace.preparedSql).toHaveLength(2);
      const nextRows = database
        .prepare(trace.preparedSql[1]!)
        .all(...trace.bindings[1]!) as Record<string, unknown>[];
      const nextNativeTrace = {
        preparedSql: [...trace.preparedSql],
        bindings: trace.bindings.map((bindings) => [...bindings]),
      };
      runtimeEvidence.push({
        scope: "event",
        case: `event-fields-${shape}-first-and-next-page`,
        actualFirstDto: actualFirstPage.value,
        legacyFirstDto: expectedFirstDto,
        actualNextDto: actualNextPage.value,
        legacyNextDto: {
          eventName: reportEventName ?? undefined,
          data: {
            ...expectedNextPage,
            items: expectedNextPage.items.map(mapEventField),
          },
        },
        firstExecutionEvidence: firstExecution.evidence[0],
        nextExecutionEvidence: nextExecution.evidence[0],
        firstNativeTrace,
        nextNativeTrace,
        firstCoreTrace,
        nextCoreTrace,
        firstControls: firstRows.filter((row) => row.rowKind === "control"),
        firstReportRows: firstRows.filter((row) => row.rowKind === "report"),
        nextControls: nextRows.filter((row) => row.rowKind === "control"),
        nextReportRows: nextRows.filter((row) => row.rowKind === "report"),
        statementCount: firstNativeTrace.preparedSql.length,
      });
    },
  );

  it.each(EVENT_CANDIDATE_FILTERS)(
    "qualifies Event field-value pages through Count with $shape and preserves search and cursor semantics",
    async ({ shape, dsl: filterDsl }) => {
      const { database, site } = createDatabase();
      prepareEventCandidateFixture(database, "Event field-value candidate");
      if (shape === "top-level OR/NOT") {
        addEvent(database, site, {
          id: "event-or-other",
          visitId: "visit-two",
          nameId: 42,
          occurredAt: 129,
        });
        addPayload(database, site, "event-or-other", "/a", {
          valueType: 1,
          occurredAt: 129,
          stringValue: "or-only",
        });
      }
      const reportEventName = shape === "top-level AND" ? "signup" : null;
      const pageLimit = shape === "top-level AND" ? 1 : 2;
      const query = qualifiedEventFieldValuesQuery("event", {
        filterDsl,
        eventName: reportEventName,
        fieldPath: "/a",
        fieldValueType: "string",
        limit: pageLimit,
      });
      const oracleTrace = traceFor();
      const oracleEnv = testEnv(database, oracleTrace);
      const prepared = await d1AdvancedFilterMiddleware(oracleEnv)(
        "event-field-values",
        query,
        async (value) => value,
      );
      const deferred = deferredEventFieldValuesQualificationFromQuery(prepared);
      if (!deferred)
        throw new Error("wave97ej_event_field_values_deferred_missing");
      expect(deferred.countInput.scope).toBe("event");
      expect(deferred.countInput.candidateAnchor?.kind).toBe("event-candidate");

      const fallbackFilters =
        await prepareDeferredEventQualificationFallback(deferred);
      oracleTrace.preparedSql.length = 0;
      oracleTrace.bindings.length = 0;
      const expectedFirstPage = await queryEventFieldValuesPageFromD1(
        oracleEnv,
        SITE,
        WINDOW,
        fallbackFilters,
        reportEventName ?? undefined,
        "/a",
        "string",
        pageLimit,
        undefined,
        null,
        "private-dashboard",
      );
      const firstCoreTrace = {
        preparedSql: [...oracleTrace.preparedSql],
        bindings: oracleTrace.bindings.map((bindings) => [...bindings]),
      };
      const trace = traceFor();
      const env = testEnv(database, trace);
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE,
        diagnostics,
      }).resolve("event-field-values");
      if (!provider)
        throw new Error("wave97ej_event_field_values_provider_missing");
      const firstExecution = await captureEventFieldValuesExecution(() =>
        provider.execute(query),
      );
      const actualFirstPage = firstExecution.value;
      expect(firstExecution.callCount).toBe(1);
      expect(firstExecution.evidence).toHaveLength(1);
      expect(
        firstExecution.evidence[0]!.groupedSummaryMaterializations,
      ).toHaveLength(2);
      expect(
        firstExecution.evidence[0]!.groupedSummaryMaterializations?.every(
          ({ materialization }) => materialization === "materialized",
        ),
      ).toBe(true);
      const expectedFirstDto = {
        eventName: reportEventName ?? undefined,
        fieldPath: "/a",
        fieldValueType: "string",
        data: {
          ...expectedFirstPage,
          items: expectedFirstPage.items.map(mapEventFieldValue),
        },
      };
      expect(actualFirstPage.value).toEqual(expectedFirstDto);
      expect(trace.preparedSql).toHaveLength(2);
      const firstRows = database
        .prepare(trace.preparedSql[1]!)
        .all(...trace.bindings[1]!) as Record<string, unknown>[];
      expect(firstRows.filter((row) => row.rowKind === "control")).toHaveLength(
        1,
      );
      expect(
        firstRows.filter((row) => row.rowKind === "report").length,
      ).toBeGreaterThan(0);
      expect(
        new TextEncoder().encode(trace.preparedSql[1]!).byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(trace.bindings[1]!.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      const firstNativeTrace = {
        preparedSql: [...trace.preparedSql],
        bindings: trace.bindings.map((bindings) => [...bindings]),
      };

      const firstCursor = (
        actualFirstPage.value as unknown as {
          readonly data: {
            readonly pagination: { readonly nextCursor: string | null };
          };
        }
      ).data.pagination.nextCursor;
      expect(firstCursor).toEqual(expect.any(String));
      const decodedCursor = await decodeEventFieldValueCursor(
        oracleEnv,
        SITE,
        WINDOW,
        fallbackFilters,
        reportEventName ?? undefined,
        "/a",
        "string",
        undefined,
        firstCursor,
        "private-dashboard",
      );
      expect(decodedCursor).not.toBeNull();
      oracleTrace.preparedSql.length = 0;
      oracleTrace.bindings.length = 0;
      const expectedNextPage = await queryEventFieldValuesPageFromD1(
        oracleEnv,
        SITE,
        WINDOW,
        fallbackFilters,
        reportEventName ?? undefined,
        "/a",
        "string",
        pageLimit,
        undefined,
        decodedCursor,
        "private-dashboard",
      );
      const nextCoreTrace = {
        preparedSql: [...oracleTrace.preparedSql],
        bindings: oracleTrace.bindings.map((bindings) => [...bindings]),
      };
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const nextExecution = await captureEventFieldValuesExecution(() =>
        provider.execute({ ...query, cursor: firstCursor ?? undefined }),
      );
      const actualNextPage = nextExecution.value;
      expect(nextExecution.callCount).toBe(1);
      expect(nextExecution.evidence).toHaveLength(1);
      expect(
        nextExecution.evidence[0]!.groupedSummaryMaterializations,
      ).toHaveLength(2);
      expect(actualNextPage.value).toEqual({
        eventName: reportEventName ?? undefined,
        fieldPath: "/a",
        fieldValueType: "string",
        data: {
          ...expectedNextPage,
          items: expectedNextPage.items.map(mapEventFieldValue),
        },
      });
      expect(expectedNextPage.pagination).toMatchObject({
        hasMore: false,
        nextCursor: null,
      });
      const completeValues = [
        ...expectedFirstDto.data.items,
        ...expectedNextPage.items.map(mapEventFieldValue),
      ].map(({ value }) => value);
      expect(completeValues.sort()).toEqual(
        ["a", "z", ...(shape === "top-level OR/NOT" ? ["or-only"] : [])].sort(),
      );
      expect(trace.preparedSql).toHaveLength(2);
      const nextRows = database
        .prepare(trace.preparedSql[1]!)
        .all(...trace.bindings[1]!) as Record<string, unknown>[];
      const nextNativeTrace = {
        preparedSql: [...trace.preparedSql],
        bindings: trace.bindings.map((bindings) => [...bindings]),
      };
      let searchExecutionEvidence: EventPayloadProgramEvidence | undefined;
      let searchActualDto: unknown;
      let searchLegacyDto: unknown;
      let searchRows: Record<string, unknown>[] | undefined;
      let searchNativeTrace:
        | {
            readonly preparedSql: readonly string[];
            readonly bindings: readonly (readonly SQLInputValue[])[];
          }
        | undefined;
      let searchCoreTrace:
        | {
            readonly preparedSql: readonly string[];
            readonly bindings: readonly (readonly SQLInputValue[])[];
          }
        | undefined;
      if (shape === "top-level OR/NOT") {
        const firstItems = (
          actualFirstPage.value as unknown as {
            readonly data: {
              readonly items: readonly { readonly value: unknown }[];
            };
          }
        ).data.items;
        const nextItems = (
          actualNextPage.value as unknown as {
            readonly data: {
              readonly items: readonly { readonly value: unknown }[];
            };
          }
        ).data.items;
        expect(
          [...firstItems, ...nextItems].map(({ value }) => value),
        ).toContain("or-only");
      }

      if (shape === "top-level AND") {
        const searchQuery = qualifiedEventFieldValuesQuery("event", {
          filterDsl,
          eventName: "signup",
          fieldPath: "/a",
          fieldValueType: "string",
          search: "a",
          limit: 5,
        });
        oracleTrace.preparedSql.length = 0;
        oracleTrace.bindings.length = 0;
        const expectedSearchPage = await queryEventFieldValuesPageFromD1(
          oracleEnv,
          SITE,
          WINDOW,
          fallbackFilters,
          "signup",
          "/a",
          "string",
          5,
          "a",
          null,
          "private-dashboard",
        );
        searchCoreTrace = {
          preparedSql: [...oracleTrace.preparedSql],
          bindings: oracleTrace.bindings.map((bindings) => [...bindings]),
        };
        trace.preparedSql.length = 0;
        trace.bindings.length = 0;
        const searchExecution = await captureEventFieldValuesExecution(() =>
          provider.execute(searchQuery),
        );
        const actualSearchPage = searchExecution.value;
        searchActualDto = actualSearchPage.value;
        expect(searchExecution.callCount).toBe(1);
        expect(searchExecution.evidence).toHaveLength(1);
        expect(
          searchExecution.evidence[0]!.groupedSummaryMaterializations,
        ).toHaveLength(2);
        searchExecutionEvidence = searchExecution.evidence[0];
        expect(actualSearchPage.value).toEqual({
          eventName: "signup",
          fieldPath: "/a",
          fieldValueType: "string",
          data: {
            ...expectedSearchPage,
            items: expectedSearchPage.items.map(mapEventFieldValue),
          },
        });
        searchLegacyDto = {
          eventName: "signup",
          fieldPath: "/a",
          fieldValueType: "string",
          data: {
            ...expectedSearchPage,
            items: expectedSearchPage.items.map(mapEventFieldValue),
          },
        };
        expect(
          (
            actualSearchPage.value as unknown as {
              readonly data: {
                readonly items: readonly { readonly value: unknown }[];
              };
            }
          ).data.items.map(({ value }) => value),
        ).toEqual(["a"]);
        expect(trace.preparedSql).toHaveLength(2);
        searchNativeTrace = {
          preparedSql: [...trace.preparedSql],
          bindings: trace.bindings.map((bindings) => [...bindings]),
        };
        searchRows = database
          .prepare(trace.preparedSql[1]!)
          .all(...trace.bindings[1]!) as Record<string, unknown>[];
      }

      const coreTrace = {
        preparedSql: [...oracleTrace.preparedSql],
        bindings: oracleTrace.bindings.map((bindings) => [...bindings]),
      };
      runtimeEvidence.push({
        scope: "event",
        case: `event-field-values-${shape}-first-next-and-search`,
        actualFirstDto: actualFirstPage.value,
        legacyFirstDto: expectedFirstDto,
        actualNextDto: actualNextPage.value,
        legacyNextDto: {
          eventName: reportEventName ?? undefined,
          fieldPath: "/a",
          fieldValueType: "string",
          data: {
            ...expectedNextPage,
            items: expectedNextPage.items.map(mapEventFieldValue),
          },
        },
        searchActualDto,
        searchLegacyDto,
        firstExecutionEvidence: firstExecution.evidence[0],
        nextExecutionEvidence: nextExecution.evidence[0],
        searchExecutionEvidence,
        firstNativeTrace,
        nextNativeTrace,
        searchNativeTrace,
        firstCoreTrace,
        nextCoreTrace,
        searchCoreTrace,
        coreTrace,
        firstControls: firstRows.filter((row) => row.rowKind === "control"),
        firstReportRows: firstRows.filter((row) => row.rowKind === "report"),
        nextControls: nextRows.filter((row) => row.rowKind === "control"),
        nextReportRows: nextRows.filter((row) => row.rowKind === "report"),
        searchControls: searchRows?.filter((row) => row.rowKind === "control"),
        searchReportRows: searchRows?.filter((row) => row.rowKind === "report"),
        statementCount: firstNativeTrace.preparedSql.length,
      });
    },
  );

  it("keeps Page-only Count membership out of Event payloads when local IDs collide", async () => {
    const { database, site } = createDatabase();
    prepareEventCandidateFixture(database, "Event payload ID collision");
    addVisit(database, site, {
      id: "event-collision-id",
      sessionId: "collision-page-session",
      visitorId: "collision-page-visitor",
      startedAt: 125,
    });
    addVisit(database, site, {
      id: "collision-event-owner",
      sessionId: "collision-owner-session",
      visitorId: "collision-owner-visitor",
      startedAt: 125,
    });
    database
      .prepare(
        `UPDATE visits SET started_at = 125, last_activity_at = 125,
         pathname = '/page-id-collision' WHERE visit_id = 'event-collision-id'`,
      )
      .run();
    database
      .prepare(
        `UPDATE visits SET started_at = 125, last_activity_at = 125,
         pathname = '/event-owner' WHERE visit_id = 'collision-event-owner'`,
      )
      .run();
    addEvent(database, site, {
      id: "event-collision-id",
      visitId: "collision-event-owner",
      nameId: 41,
      occurredAt: 125,
    });
    addPayload(database, site, "event-collision-id", "/collision", {
      valueType: 1,
      occurredAt: 125,
      stringValue: "must-not-leak-from-page-candidate",
    });

    const filterDsl =
      'count(page) eq 1 AND count(event) eq 0 AND page.path eq "/page-id-collision"';
    const query = qualifiedEventFieldsQuery(
      "event",
      null,
      filterDsl,
      "signup",
      10,
    );
    const oracleTrace = traceFor();
    const oracleEnv = testEnv(database, oracleTrace);
    const prepared = await d1AdvancedFilterMiddleware(oracleEnv)(
      "event-fields",
      query,
      async (value) => value,
    );
    const deferred = deferredEventFieldsQualificationFromQuery(prepared);
    if (!deferred)
      throw new Error("wave97ej_event_payload_collision_deferred_missing");
    const fallbackFilters =
      await prepareDeferredEventQualificationFallback(deferred);
    oracleTrace.preparedSql.length = 0;
    oracleTrace.bindings.length = 0;
    const expectedPage = await queryEventFieldsPageFromD1(
      oracleEnv,
      SITE,
      WINDOW,
      fallbackFilters,
      "signup",
      10,
      null,
      "private-dashboard",
    );
    expect(expectedPage.items).toEqual([]);
    const legacyDto = {
      eventName: "signup",
      data: { ...expectedPage, items: [] },
    };
    const legacyTrace = {
      preparedSql: [...oracleTrace.preparedSql],
      bindings: oracleTrace.bindings.map((bindings) => [...bindings]),
    };

    const trace = traceFor();
    const env = testEnv(database, trace);
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE,
    }).resolve("event-fields");
    if (!provider)
      throw new Error("wave97ej_event_fields_collision_provider_missing");
    const actual = await provider.execute(query);
    const actualDto = {
      eventName: "signup",
      data: { ...expectedPage, items: [] },
    };
    expect(actual.value).toEqual(actualDto);
    expect(trace.preparedSql).toHaveLength(2);
    const candidateRows = database
      .prepare(trace.preparedSql[1]!)
      .all(...trace.bindings[1]!) as Record<string, unknown>[];
    const controls = candidateRows.filter((row) => row.rowKind === "control");
    expect(controls).toHaveLength(1);
    expect(
      candidateRows.filter((row) => row.rowKind === "report"),
    ).toHaveLength(0);
    runtimeEvidence.push({
      scope: "event",
      case: "page-event-local-id-collision-does-not-qualify-payload",
      actualDto: actualDto,
      legacyDto,
      nativeTrace: {
        preparedSql: [...trace.preparedSql],
        bindings: trace.bindings.map((bindings) => [...bindings]),
      },
      legacyTrace,
      controls,
      candidateRows,
      reportRows: candidateRows.filter((row) => row.rowKind === "report"),
      collidingPageId: "event-collision-id",
      collidingEventPayload: "must-not-leak-from-page-candidate",
    });
  });

  it.each(["event-fields", "event-field-values"] as const)(
    "preserves numeric Count controls and falls back for Event candidate %s",
    async (operation) => {
      const { database } = createDatabase();
      prepareEventCandidateFixture(database, `${operation} numeric fallback`);
      database
        .prepare(
          "UPDATE visits SET duration_ms = ? WHERE visit_id = 'visit-one'",
        )
        .run(10);
      database
        .prepare(
          "UPDATE visits SET duration_ms = ? WHERE visit_id = 'visit-two'",
        )
        .run("invalid-duration");
      const filterDsl =
        'count(event { event.name eq "other" }) eq 2 AND count(page { page.durationMs gt 5 }) eq 1 AND event.name eq "signup"';
      const query =
        operation === "event-fields"
          ? qualifiedEventFieldsQuery("event", null, filterDsl, "signup", 10)
          : qualifiedEventFieldValuesQuery("event", {
              filterDsl,
              eventName: "signup",
              limit: 10,
            });
      const expectedTrace = traceFor();
      const oracleEnv = testEnv(database, expectedTrace);
      const prepared = await d1AdvancedFilterMiddleware(oracleEnv)(
        operation,
        query,
        async (value) => value,
      );
      const deferred =
        operation === "event-fields"
          ? deferredEventFieldsQualificationFromQuery(prepared)
          : deferredEventFieldValuesQualificationFromQuery(prepared);
      if (!deferred)
        throw new Error("wave97ej_numeric_event_candidate_deferred_missing");
      expect(deferred.countInput.scope).toBe("event");
      const fallbackFilters =
        await prepareDeferredEventQualificationFallback(deferred);
      const expectedEnv = testEnv(database, expectedTrace);
      const trace = traceFor();
      const env = testEnv(database, trace);
      const diagnostics = createD1ReadDiagnostics();
      const registry = createD1SiteProviderRegistry({
        env,
        siteId: SITE,
        diagnostics,
      });
      let actualDto: unknown;
      let legacyDto: unknown;
      if (operation === "event-fields") {
        const fieldsQuery = query as QualifiedEventFieldsTestQuery;
        const expectedPage = await queryEventFieldsPageFromD1(
          expectedEnv,
          SITE,
          WINDOW,
          fallbackFilters,
          "signup",
          10,
          null,
          "private-dashboard",
        );
        const provider = registry.resolve("event-fields");
        if (!provider)
          throw new Error("wave97ej_numeric_event_fields_provider_missing");
        const actual = await provider.execute(fieldsQuery);
        actualDto = actual.value;
        legacyDto = {
          eventName: "signup",
          data: {
            ...expectedPage,
            items: expectedPage.items.map(mapEventField),
          },
        };
        expect(actualDto).toEqual(legacyDto);
      } else {
        const valuesQuery = query as QualifiedEventFieldValuesTestQuery;
        const expectedPage = await queryEventFieldValuesPageFromD1(
          expectedEnv,
          SITE,
          WINDOW,
          fallbackFilters,
          "signup",
          valuesQuery.fieldPath,
          valuesQuery.fieldValueType,
          valuesQuery.limit,
          valuesQuery.search,
          null,
          "private-dashboard",
        );
        const provider = registry.resolve("event-field-values");
        if (!provider)
          throw new Error(
            "wave97ej_numeric_event_field_values_provider_missing",
          );
        const actual = await provider.execute(valuesQuery);
        actualDto = actual.value;
        legacyDto = {
          eventName: "signup",
          fieldPath: valuesQuery.fieldPath,
          fieldValueType: valuesQuery.fieldValueType,
          data: {
            ...expectedPage,
            items: expectedPage.items.map(mapEventFieldValue),
          },
        };
        expect(actualDto).toEqual(legacyDto);
      }
      expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "numeric-data-domain",
      });
      const controlRows = trace.preparedSql
        .map(
          (sql, index) =>
            database.prepare(sql).all(...trace.bindings[index]!) as Record<
              string,
              unknown
            >[],
        )
        .flat()
        .filter((row) => row.rowKind === "control");
      expect(controlRows).toHaveLength(1);
      const control = controlRows[0]!;
      expect(Number(control.rawCount)).toBeGreaterThan(0);
      const numericMismatch = Object.entries(control).find(
        ([name, value]) =>
          name.toLowerCase().includes("duration") && Number(value) > 0,
      );
      expect(numericMismatch).toBeDefined();
      const reportRows = trace.preparedSql
        .map(
          (sql, index) =>
            database.prepare(sql).all(...trace.bindings[index]!) as Record<
              string,
              unknown
            >[],
        )
        .flat()
        .filter((row) => row.rowKind === "report");
      expect(reportRows).toHaveLength(0);
      const legacyCoreTrace = {
        preparedSql: [...expectedTrace.preparedSql],
        bindings: expectedTrace.bindings.map((bindings) => [...bindings]),
      };
      const actualTrace = {
        preparedSql: [...trace.preparedSql],
        bindings: trace.bindings.map((bindings) => [...bindings]),
      };
      expect(expectedTrace.preparedSql).toHaveLength(3);
      expect(trace.preparedSql).toHaveLength(4);
      runtimeEvidence.push({
        scope: "event",
        case: `${operation}-event-candidate-numeric-domain-fallback`,
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        actualDto,
        legacyDto,
        legacyCoreTrace,
        actualTrace,
        control,
        reportRows,
        reportRowCount: reportRows.length,
        qualifiedStatementCount: trace.preparedSql.length,
        legacyStatementCount: expectedTrace.preparedSql.length,
        fallbackAttemptCount:
          trace.preparedSql.length - expectedTrace.preparedSql.length,
      });
    },
  );

  it.each([
    {
      operation: "event-fields" as const,
      getterField: "eventName",
      ownDataCode: "event_fields_qualification_request_own_data_required",
      contextCode: "event_fields_qualification_request_context_mismatch",
    },
    {
      operation: "event-field-values" as const,
      getterField: "search",
      ownDataCode: "event_field_values_qualification_request_own_data_required",
      contextCode: "event_field_values_qualification_request_context_mismatch",
    },
  ])(
    "rejects Event payload $operation accessors before reading or querying",
    async ({ operation, getterField, ownDataCode, contextCode }) => {
      const { database } = createDatabase();
      const baseQuery =
        operation === "event-fields"
          ? qualifiedEventFieldsQuery(
              "event",
              null,
              EVENT_CANDIDATE_FILTERS[0].dsl,
              "signup",
              1,
            )
          : qualifiedEventFieldValuesQuery("event", {
              filterDsl: EVENT_CANDIDATE_FILTERS[0].dsl,
              eventName: "signup",
              search: "a",
              limit: 1,
            });
      const trace = traceFor();
      const env = testEnv(database, trace);
      const accessorQuery = { ...baseQuery } as Record<string, unknown>;
      let getterReads = 0;
      Object.defineProperty(accessorQuery, getterField, {
        enumerable: true,
        configurable: true,
        get() {
          getterReads += 1;
          return getterField === "eventName" ? "signup" : "a";
        },
      });
      let accessorNextCalls = 0;
      await expect(
        d1AdvancedFilterMiddleware(env, undefined, SITE)(
          operation,
          accessorQuery,
          async () => {
            accessorNextCalls += 1;
            return accessorQuery;
          },
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [{ code: ownDataCode }],
        },
      });
      expect(getterReads).toBe(0);
      expect(accessorNextCalls).toBe(0);
      expect(trace.preparedSql).toHaveLength(0);

      let mismatchedNextCalls = 0;
      await expect(
        d1AdvancedFilterMiddleware(env, undefined, SIBLING_SITE)(
          operation,
          baseQuery,
          async () => {
            mismatchedNextCalls += 1;
            return baseQuery;
          },
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [{ path: "siteId", code: contextCode }],
        },
      });
      expect(mismatchedNextCalls).toBe(0);
      expect(trace.preparedSql).toHaveLength(0);
      errorEvidence.push({
        kind: `${operation}-own-data-and-context-rejection`,
        ownDataCode,
        contextCode,
        getterReads,
        accessorNextCalls,
        mismatchedNextCalls,
        statementCount: trace.preparedSql.length,
      });
    },
  );

  it("keeps API v1 Event fields on the legacy Core path", async () => {
    const { database } = createDatabase();
    prepareEventCandidateFixture(database, "API v1 Event fields");
    const query = qualifiedEventFieldsQuery(
      "event",
      null,
      'count(event { event.name eq "signup" }) gte 0 AND event.name eq "signup"',
      "signup",
      10,
      "api-v1",
    );
    const preparedTrace = traceFor();
    const prepared = await d1AdvancedFilterMiddleware(
      testEnv(database, preparedTrace),
    )("event-fields", query, async (value) => value);
    expect(deferredEventFieldsQualificationFromQuery(prepared)).toBeUndefined();
    const legacyFilters = (prepared as QueryInput).filters;
    if (!legacyFilters)
      throw new Error("wave97ej_api_v1_legacy_filters_missing");

    const expectedTrace = traceFor();
    const expectedPage = await queryEventFieldsPageFromD1(
      testEnv(database, expectedTrace),
      SITE,
      WINDOW,
      legacyFilters,
      "signup",
      10,
      null,
      "api-v1",
    );
    const actualTrace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, actualTrace),
      siteId: SITE,
    }).resolve("event-fields");
    if (!provider)
      throw new Error("wave97ej_api_v1_event_fields_provider_missing");
    const actualExecution = await captureEventFieldsExecution(() =>
      provider.execute(query),
    );
    expect(actualExecution.callCount).toBe(0);
    const actual = actualExecution.value;
    expect(actual.value).toEqual({
      eventName: "signup",
      data: {
        ...expectedPage,
        items: expectedPage.items.map(mapEventField),
      },
    });
    runtimeEvidence.push({
      scope: "event",
      case: "api-v1-event-fields-legacy-core-compatibility",
      candidateExecutionCalls: actualExecution.callCount,
      actualDto: actual.value,
      legacyDto: {
        eventName: "signup",
        data: {
          ...expectedPage,
          items: expectedPage.items.map(mapEventField),
        },
      },
      preparedCoreTrace: {
        preparedSql: [...preparedTrace.preparedSql],
        bindings: preparedTrace.bindings.map((bindings) => [...bindings]),
      },
      legacyCoreTrace: {
        preparedSql: [...expectedTrace.preparedSql],
        bindings: expectedTrace.bindings.map((bindings) => [...bindings]),
      },
      actualTrace: {
        preparedSql: [...actualTrace.preparedSql],
        bindings: actualTrace.bindings.map((bindings) => [...bindings]),
      },
    });
  });
});
