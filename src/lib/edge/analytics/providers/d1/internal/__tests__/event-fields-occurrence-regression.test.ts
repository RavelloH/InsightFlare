import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import { buildEventFieldsPlan } from "@/lib/edge/analytics/engine/event-fields-plan";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  buildEventFilteredSourceCte,
  type EventFieldRow,
  type EventFieldValueRow,
  type FilterDocument,
  type QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
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
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
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

function traceFor(
  options: Pick<SqliteD1Trace, "readBigIntsAsNumbers"> = {},
): SqliteD1Trace {
  return { preparedSql: [], bindings: [], ...options };
}

afterAll(() => {
  for (const database of DATABASES) database.close();
  DATABASES.clear();
});

describe("Event field occurrence report migration", () => {
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
});
