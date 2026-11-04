import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  type DatabaseQueryObservation,
  type DatabaseQueryObserver,
} from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  LogicalPlanBuilder,
  lowerFilterDocumentToScope,
} from "@/lib/edge/analytics/engine";
import type { SlotId } from "@/lib/edge/analytics/engine/logical/ids";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";
import {
  type FilterDocument,
  type FilterOperator,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

const SITE_A = "wave31-identity-a";
const SITE_B = "wave31-identity-b";
const TEAM_ID = "wave31-authorized-team";
const CANDIDATE_RANGE = { startMs: 100, endExclusiveMs: 200 } as const;
const FILTER_RANGE = { startMs: 200, endExclusiveMs: 300 } as const;
const READ_RANGE = { startMs: 0, endExclusiveMs: 100 } as const;

type Scope = "observation" | "session" | "visitor";
type Domain = "candidate" | "filter" | "read";
type FilterExtent = Readonly<{
  startMs?: number;
  endExclusiveMs?: number;
}>;

const RANGE_BY_DOMAIN: Readonly<
  Record<Domain, Readonly<{ startMs: number; endExclusiveMs: number }>>
> = {
  candidate: CANDIDATE_RANGE,
  filter: FILTER_RANGE,
  read: READ_RANGE,
};

type ObservationKey = readonly [
  sitePk: number,
  kind: "page" | "event",
  id: string,
];
type PairKey = readonly [sitePk: number, id: string];

function filterCondition(
  field: string,
  operator: FilterOperator,
  value?: string | readonly string[],
) {
  return {
    kind: "condition",
    target: { kind: "field", field },
    operator,
    ...(value === undefined ? {} : { value }),
  } as const;
}

function filterDocument(root: unknown): FilterDocument {
  return { version: 1, root } as unknown as FilterDocument;
}

function selectorCondition(
  collection: "page" | "event",
  operator: "exists" | "notExists",
  predicate: unknown,
) {
  return {
    kind: "condition",
    target: {
      kind: "selector",
      collection: { kind: "entity-root", entity: collection },
      predicate,
    },
    operator,
  } as const;
}

type ReadExtent =
  | { readonly kind: "bounded"; readonly range: typeof READ_RANGE }
  | { readonly kind: "retained-history" };

function planContext(
  targetScope: Scope,
  siteIds: readonly string[],
  options: {
    readonly filter?: FilterExtent | null;
    readonly read?: ReadExtent;
    readonly subjectOrigin?: "site" | "team";
  } = {},
) {
  return {
    subject: createSemanticSubjectDomain({
      origin: options.subjectOrigin ?? "site",
      siteIds: siteIds as never,
      ...(options.subjectOrigin === "team" ? { teamId: TEAM_ID as never } : {}),
    }),
    time: createSemanticTemporalDomains({
      candidate: CANDIDATE_RANGE as never,
      ...(options.filter === null
        ? {}
        : { filter: (options.filter ?? FILTER_RANGE) as never }),
      read: (options.read ?? {
        kind: "bounded",
        range: READ_RANGE as never,
      }) as never,
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 300 as never,
    }),
    scope:
      targetScope === "observation"
        ? resolveAnalyticsScope("auto")
        : resolveAnalyticsScope(targetScope),
  };
}

function outputIdentityColumns(scope: Scope) {
  if (scope === "observation") {
    return [
      { name: "site_pk", component: 0 },
      { name: "observation_kind", component: 1 },
      { name: "entity_id", component: 2 },
    ] as const;
  }
  return [
    { name: "site_pk", component: 0 },
    { name: "entity_id", component: 1 },
  ] as const;
}

function lowerFilter(
  input: unknown,
  scope: Scope,
  options: {
    readonly domain?: Domain;
    readonly siteIds?: readonly string[];
    readonly storageSiteIds?: readonly string[];
    readonly filter?: FilterExtent | null;
    readonly read?: ReadExtent;
    readonly subjectOrigin?: "site" | "team";
  } = {},
) {
  const siteIds = options.siteIds ?? [SITE_A];
  const domain = options.domain ?? "read";
  const normalized = normalizeFilterDocument(input, analyticsFilterRegistry);
  const context = planContext(scope, siteIds, {
    ...options,
    subjectOrigin:
      options.subjectOrigin ?? (siteIds.length > 1 ? "team" : "site"),
  });
  const builder = new LogicalPlanBuilder(context);
  const lowered = lowerFilterDocumentToScope(
    builder,
    analyzeFilterDocument(normalized, analyticsFilterRegistry),
    {
      targetScope: scope,
      resolveTemporalDomain: () => domain,
    },
  );
  if (lowered.kind !== "supported")
    return { kind: "unsupported" as const, lowered };

  builder.output("selected-identities", lowered.selection.relation, [
    { name: "entity", slot: "entity" },
  ]);
  const plan = builder.finish();
  const queryLowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteIds: options.storageSiteIds ?? siteIds,
    time: plan.context.time,
  });
  const output = plan.outputs[0]!;
  const loweredOutput = queryLowerer.lower(output);
  const query = compileD1Query(
    queryLowerer.projectOutput(
      loweredOutput,
      outputIdentityColumns(scope).map(({ name, component }) => ({
        name,
        slot: output.fields[0]!.slot,
        component,
      })),
    ),
  );
  return { kind: "supported" as const, plan, query, lowered, queryLowerer };
}

function filterIsRejected(
  input: unknown,
  options: Parameters<typeof lowerFilter>[2] = {},
): boolean {
  try {
    return (
      lowerFilter(input, "visitor", { domain: "candidate", ...options })
        .kind !== "supported"
    );
  } catch {
    return true;
  }
}

async function executeFilter(
  db: DatabaseSync,
  input: unknown,
  scope: Scope,
  options: Parameters<typeof lowerFilter>[2] = {},
): Promise<Array<Readonly<Record<string, number | string>>>> {
  const lowered = lowerFilter(input, scope, options);
  if (lowered.kind !== "supported") {
    throw new Error(`Expected supported ${scope} filter, got unsupported.`);
  }
  const result = await createD1DatabaseClient(createSqliteD1Database(db)).all(
    lowered.query,
  );
  return result.results as Array<Readonly<Record<string, number | string>>>;
}

function lowerReportObservationCarrier(siteIds: readonly string[] = [SITE_A]) {
  const builder = new LogicalPlanBuilder(
    planContext("observation", siteIds, {
      read: { kind: "bounded", range: READ_RANGE },
    }),
  );
  const observations = builder.source("observation", {
    temporalDomain: "read",
    attributes: ["observation.kind"],
    relationships: ["observation.visitor"],
    includeOccurrenceTime: true,
  });
  builder.output("report-observations", observations, [
    { name: "identity", slot: "entity" },
    { name: "kind", slot: "attribute:observation.kind" },
    { name: "visitor", slot: "relationship:observation.visitor" },
    { name: "time", slot: "time" },
  ]);
  const plan = builder.finish();
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteIds,
    time: plan.context.time,
  });
  const output = plan.outputs[0]!;
  const loweredOutput = lowerer.lower(output);
  const identitySlot = observations.slots.entity!;
  const kindSlot = observations.slots["attribute:observation.kind"]!;
  const visitorSlot = observations.slots["relationship:observation.visitor"]!;
  const query = compileD1Query(
    lowerer.projectOutput(loweredOutput, [
      { name: "site_pk", slot: identitySlot, component: 0 },
      { name: "observation_kind", slot: kindSlot },
      { name: "observation_id", slot: identitySlot, component: 2 },
      { name: "visitor_site_pk", slot: visitorSlot, component: 0 },
      { name: "visitor_id", slot: visitorSlot, component: 1 },
    ]),
  );
  return { plan, query };
}

async function expectFilterToMatchRawSql(
  db: DatabaseSync,
  sitePk: number,
  scope: Scope,
  root: unknown,
  domain: Domain,
): Promise<Set<string>> {
  const actual = await executeFilter(db, filterDocument(root), scope, {
    domain,
  });
  const expected = legacyDocumentSet(db, sitePk, scope, root, domain);
  expect(outputIdentitySet(actual, scope)).toEqual(expected);
  return expected;
}

function recordingObserver(events: DatabaseQueryObservation[]): {
  readonly observer: DatabaseQueryObserver;
  waitForCount(count: number): Promise<void>;
} {
  const waiters: Array<{ readonly count: number; resolve(): void }> = [];
  return {
    observer: {
      begin: () => ({
        statementIndexes: [0],
        includeBatchSummary: false,
        record: (event) => {
          events.push(event);
          for (let index = waiters.length - 1; index >= 0; index -= 1) {
            const waiter = waiters[index]!;
            if (events.length >= waiter.count) {
              waiters.splice(index, 1);
              waiter.resolve();
            }
          }
        },
        release: () => {},
      }),
    },
    waitForCount: (count) =>
      events.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ count, resolve })),
  };
}

/** Seed rows intentionally use ordinary migrated tables and raw identifiers. */
function insertSite(db: DatabaseSync, siteId: string): number {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(siteId);
  return (
    db
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(siteId) as { readonly site_pk: number }
  ).site_pk;
}

function insertPage(
  db: DatabaseSync,
  input: {
    readonly siteId: string;
    readonly sitePk: number;
    readonly id: string;
    readonly sessionId: string | null;
    readonly visitorId: string;
    readonly startedAt: number;
    readonly path: string;
    readonly hostname?: string | null;
    readonly userId?: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO visits (" +
      "visit_id, site_id, visitor_id, session_id, status, started_at, " +
      "last_activity_at, pathname, hostname, user_id, site_pk" +
      ") VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, ?, ?, ?)",
  ).run(
    input.id,
    input.siteId,
    input.visitorId,
    input.sessionId,
    input.startedAt,
    input.startedAt,
    input.path,
    input.hostname === undefined ? "identity.example" : input.hostname,
    input.userId ?? null,
    input.sitePk,
  );
}

function insertEventName(
  db: DatabaseSync,
  siteId: string,
  sitePk: number,
  name: string,
): number {
  db.prepare(
    "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) " +
      "VALUES (?, ?, 1, ?)",
  ).run(siteId, name, sitePk);
  return (
    db
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
      )
      .get(sitePk, name) as { readonly id: number }
  ).id;
}

function insertEvent(
  db: DatabaseSync,
  input: {
    readonly siteId: string;
    readonly sitePk: number;
    readonly id: string;
    readonly ownerVisitId: string;
    readonly eventNameId: number;
    readonly occurredAt: number;
  },
): void {
  db.prepare(
    "INSERT INTO custom_events (" +
      "event_id, site_id, site_pk, visit_id, event_name_id, occurred_at, " +
      "received_at, node_count, value_count" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)",
  ).run(
    input.id,
    input.siteId,
    input.sitePk,
    input.ownerVisitId,
    input.eventNameId,
    input.occurredAt,
    input.occurredAt,
  );
}

function rawObservationActivityRows(
  db: DatabaseSync,
  sitePk: number,
  range: Readonly<{ startMs: number; endExclusiveMs: number }>,
  owner: "required" | "optional",
): ObservationKey[] {
  const ownerJoin =
    owner === "required"
      ? "JOIN visits AS owner ON owner.site_pk = event.site_pk " +
        "AND owner.visit_id = event.visit_id "
      : "LEFT JOIN visits AS owner ON owner.site_pk = event.site_pk " +
        "AND owner.visit_id = event.visit_id ";
  return db
    .prepare(
      "SELECT site_pk, 'page' AS observation_kind, visit_id AS observation_id " +
        "FROM visits WHERE site_pk = ? " +
        "AND started_at >= ? AND started_at < ? " +
        "UNION ALL " +
        "SELECT event.site_pk, 'event' AS observation_kind, " +
        "event.event_id AS observation_id FROM custom_events AS event " +
        ownerJoin +
        "WHERE event.site_pk = ? " +
        "AND event.occurred_at >= ? AND event.occurred_at < ? " +
        "ORDER BY observation_kind, observation_id",
    )
    .all(
      sitePk,
      range.startMs,
      range.endExclusiveMs,
      sitePk,
      range.startMs,
      range.endExclusiveMs,
    )
    .map((row) => {
      const value = row as {
        readonly site_pk: number;
        readonly observation_kind: "page" | "event";
        readonly observation_id: string;
      };
      return [
        value.site_pk,
        value.observation_kind,
        value.observation_id,
      ] as const;
    });
}

/** Raw activity bag that an explicitly optional Visitor source preserves. */
function rawCandidateObservationUniverse(
  db: DatabaseSync,
  sitePk: number,
): ObservationKey[] {
  return rawObservationActivityRows(db, sitePk, CANDIDATE_RANGE, "optional");
}

/** Frozen pre-Wave31 candidate Observation Source row domain. */
function legacyCandidateObservationUniverse(
  db: DatabaseSync,
  sitePk: number,
): ObservationKey[] {
  return rawObservationActivityRows(db, sitePk, CANDIDATE_RANGE, "required");
}

function rawActivityVisitorRows(
  db: DatabaseSync,
  sitePk: number,
  range: Readonly<{ startMs: number; endExclusiveMs: number }>,
  owner: "required" | "optional",
): Array<readonly [sitePk: number, visitorId: string | null]> {
  const ownerJoin =
    owner === "required"
      ? "JOIN visits AS owner ON owner.site_pk = event.site_pk " +
        "AND owner.visit_id = event.visit_id "
      : "LEFT JOIN visits AS owner ON owner.site_pk = event.site_pk " +
        "AND owner.visit_id = event.visit_id ";
  return db
    .prepare(
      "SELECT site_pk, visitor_id FROM visits WHERE site_pk = ? " +
        "AND started_at >= ? AND started_at < ? " +
        "UNION ALL " +
        "SELECT event.site_pk, owner.visitor_id FROM custom_events AS event " +
        ownerJoin +
        "WHERE event.site_pk = ? AND event.occurred_at >= ? AND event.occurred_at < ? " +
        "ORDER BY 1, 2",
    )
    .all(
      sitePk,
      range.startMs,
      range.endExclusiveMs,
      sitePk,
      range.startMs,
      range.endExclusiveMs,
    )
    .map((row) => {
      const value = row as {
        readonly site_pk: number;
        readonly visitor_id: string | null;
      };
      return [value.site_pk, value.visitor_id] as const;
    });
}

async function executeOutputProjection(
  db: DatabaseSync,
  lowerer: AnalyticsLogicalToDbLowerer,
  output: Parameters<AnalyticsLogicalToDbLowerer["lower"]>[0],
  columns: Parameters<AnalyticsLogicalToDbLowerer["projectOutput"]>[1],
): Promise<Array<Readonly<Record<string, unknown>>>> {
  const lowered = lowerer.lower(output);
  const query = compileD1Query(lowerer.projectOutput(lowered, columns));
  const result = await createD1DatabaseClient(createSqliteD1Database(db)).all(
    query,
  );
  return result.results as Array<Readonly<Record<string, unknown>>>;
}

function observationIdentityBag(
  rows: readonly Readonly<Record<string, unknown>>[],
): string[] {
  return rows
    .map((row) =>
      encodeIdentity([
        row.site_pk as number,
        row.observation_kind as "page" | "event",
        row.entity_id as string,
      ]),
    )
    .sort();
}

function observationRawIdentityBag(rows: readonly ObservationKey[]): string[] {
  return rows.map(encodeIdentity).sort();
}

function visitorIdentityBag(
  rows: readonly Readonly<Record<string, unknown>>[],
  siteColumn: string,
  idColumn: string,
): string[] {
  return rows
    .map((row) =>
      JSON.stringify([
        row[siteColumn] as number,
        row[idColumn] as string | null,
      ]),
    )
    .sort();
}

function legacyReportObservationRows(
  db: DatabaseSync,
  sitePk: number,
): Array<{
  readonly site_pk: number;
  readonly observation_kind: "page" | "event";
  readonly observation_id: string;
  readonly visitor_site_pk: number | null;
  readonly visitor_id: string | null;
}> {
  return db
    .prepare(
      "SELECT page.site_pk, 'page' AS observation_kind, " +
        "page.visit_id AS observation_id, " +
        "page.site_pk AS visitor_site_pk, " +
        "CASE WHEN page.visitor_id IS NOT NULL AND page.visitor_id != '' " +
        "THEN page.visitor_id ELSE NULL END AS visitor_id " +
        "FROM visits AS page WHERE page.site_pk = ? AND page.status = 'complete' " +
        "AND page.started_at >= ? AND page.started_at < ? " +
        "UNION ALL " +
        "SELECT e.site_pk, 'event' AS observation_kind, e.event_id AS observation_id, " +
        "e.site_pk AS visitor_site_pk, " +
        "CASE WHEN owner.visitor_id IS NOT NULL AND owner.visitor_id != '' " +
        "THEN owner.visitor_id ELSE NULL END AS visitor_id " +
        "FROM custom_events AS e LEFT JOIN visits AS owner " +
        "ON owner.site_pk = e.site_pk AND owner.visit_id = e.visit_id " +
        "WHERE e.site_pk = ? AND e.occurred_at >= ? AND e.occurred_at < ? " +
        "ORDER BY observation_kind, observation_id",
    )
    .all(
      sitePk,
      READ_RANGE.startMs,
      READ_RANGE.endExclusiveMs,
      sitePk,
      READ_RANGE.startMs,
      READ_RANGE.endExclusiveMs,
    ) as Array<{
    readonly site_pk: number;
    readonly observation_kind: "page" | "event";
    readonly observation_id: string;
    readonly visitor_site_pk: number | null;
    readonly visitor_id: string | null;
  }>;
}

/**
 * Frozen candidate Session universe: candidate Pages plus candidate Events
 * whose same-site owner Page supplies the Session key.
 */
function legacySessionUniverse(db: DatabaseSync, sitePk: number): PairKey[] {
  return db
    .prepare(
      "SELECT site_pk, session_id AS entity_id FROM visits " +
        "WHERE site_pk = ? AND status = 'complete' " +
        "AND started_at >= ? AND started_at < ? " +
        "AND session_id IS NOT NULL AND session_id != '' " +
        "UNION " +
        "SELECT e.site_pk, owner.session_id AS entity_id " +
        "FROM custom_events AS e JOIN visits AS owner " +
        "ON owner.site_pk = e.site_pk AND owner.visit_id = e.visit_id " +
        "WHERE e.site_pk = ? AND e.occurred_at >= ? AND e.occurred_at < ? " +
        "AND owner.status = 'complete' " +
        "AND owner.session_id IS NOT NULL AND owner.session_id != '' " +
        "ORDER BY entity_id",
    )
    .all(
      sitePk,
      CANDIDATE_RANGE.startMs,
      CANDIDATE_RANGE.endExclusiveMs,
      sitePk,
      CANDIDATE_RANGE.startMs,
      CANDIDATE_RANGE.endExclusiveMs,
    )
    .map((row) => {
      const value = row as {
        readonly site_pk: number;
        readonly entity_id: string;
      };
      return [value.site_pk, value.entity_id] as const;
    });
}

/** Raw visitor identity rule: exclude only NULL and exact empty string. */
function legacyVisitorUniverse(db: DatabaseSync, sitePk: number): PairKey[] {
  return db
    .prepare(
      "SELECT site_pk, visitor_id AS entity_id FROM visits " +
        "WHERE site_pk = ? AND status = 'complete' " +
        "AND started_at >= ? AND started_at < ? " +
        "AND visitor_id IS NOT NULL AND visitor_id != '' " +
        "UNION " +
        "SELECT e.site_pk, owner.visitor_id AS entity_id " +
        "FROM custom_events AS e JOIN visits AS owner " +
        "ON owner.site_pk = e.site_pk AND owner.visit_id = e.visit_id " +
        "WHERE e.site_pk = ? AND e.occurred_at >= ? AND e.occurred_at < ? " +
        "AND owner.status = 'complete' " +
        "AND owner.visitor_id IS NOT NULL AND owner.visitor_id != '' " +
        "ORDER BY entity_id",
    )
    .all(
      sitePk,
      CANDIDATE_RANGE.startMs,
      CANDIDATE_RANGE.endExclusiveMs,
      sitePk,
      CANDIDATE_RANGE.startMs,
      CANDIDATE_RANGE.endExclusiveMs,
    )
    .map((row) => {
      const value = row as {
        readonly site_pk: number;
        readonly entity_id: string;
      };
      return [value.site_pk, value.entity_id] as const;
    });
}

const RAW_FIELD_ORACLE = {
  "page.path": { kind: "page", column: "pathname" },
  "page.hostname": { kind: "page", column: "hostname" },
  "user.id": { kind: "page", column: "user_id" },
  "event.name": { kind: "event", column: "name" },
} as const;

type RawField = keyof typeof RAW_FIELD_ORACLE;
type RawPresenceOperator = "exists" | "notExists" | "isEmpty" | "notEmpty";

function rawOperatorSql(operator: string, column: string): string {
  switch (operator) {
    case "eq":
      return `${column} = ?`;
    case "in":
      return `${column} IN (SELECT value FROM json_each(?))`;
    case "exists":
      return `${column} IS NOT NULL`;
    case "notExists":
      return `${column} IS NULL`;
    case "isEmpty":
      return `${column} IS NOT NULL AND ${column} = ''`;
    case "notEmpty":
      return `${column} IS NOT NULL AND ${column} != ''`;
    default:
      throw new Error(`No frozen raw SQL formula for ${operator}.`);
  }
}

function rawTimePredicate(alias: string, domain: Domain): string {
  const range = RANGE_BY_DOMAIN[domain];
  return `${alias} >= ${range.startMs} AND ${alias} < ${range.endExclusiveMs}`;
}

function decodeRawIdentity(
  row: Record<string, number | string>,
  scope: Scope,
): readonly (number | string)[] {
  return scope === "observation"
    ? [row.site_pk!, row.observation_kind!, row.entity_id!]
    : [row.site_pk!, row.entity_id!];
}

function encodeIdentity(key: readonly (number | string | null)[]): string {
  return JSON.stringify(key);
}

function outputIdentitySet(
  rows: readonly Readonly<Record<string, number | string>>[],
  scope: Scope,
): Set<string> {
  return new Set(
    rows.map((row) =>
      encodeIdentity(
        scope === "observation"
          ? [row.site_pk!, row.observation_kind!, row.entity_id!]
          : [row.site_pk!, row.entity_id!],
      ),
    ),
  );
}

function readRawIdentityRows(
  db: DatabaseSync,
  sql: string,
  bindings: readonly (number | string)[],
): Array<Record<string, number | string>> {
  return db.prepare(sql).all(...bindings) as Array<
    Record<string, number | string>
  >;
}

function legacyCandidateSet(
  db: DatabaseSync,
  sitePk: number,
  scope: Scope,
): Set<string> {
  const rows =
    scope === "observation"
      ? legacyCandidateObservationUniverse(db, sitePk).map(
          ([keySite, kind, id]) => ({
            site_pk: keySite,
            observation_kind: kind,
            entity_id: id,
          }),
        )
      : scope === "session"
        ? legacySessionUniverse(db, sitePk).map(([keySite, id]) => ({
            site_pk: keySite,
            entity_id: id,
          }))
        : legacyVisitorUniverse(db, sitePk).map(([keySite, id]) => ({
            site_pk: keySite,
            entity_id: id,
          }));
  return new Set(
    rows.map((row) => encodeIdentity(decodeRawIdentity(row, scope))),
  );
}

function legacyFieldMatches(
  db: DatabaseSync,
  input: {
    readonly sitePk: number;
    readonly scope: Scope;
    readonly field: RawField;
    readonly operator: string;
    readonly value?: string | readonly string[];
    readonly domain: Domain;
  },
): Set<string> {
  const field = RAW_FIELD_ORACLE[input.field];
  const timeColumn =
    field.kind === "page" ? "evidence.started_at" : "evidence.occurred_at";
  const where = rawOperatorSql(
    input.operator,
    field.kind === "event" ? "native_name.name" : `evidence.${field.column}`,
  );
  const bindings: (number | string)[] = [input.sitePk];
  let select: string;
  let from: string;
  let identityGuards = "";
  if (field.kind === "page") {
    select =
      input.scope === "observation"
        ? "SELECT DISTINCT evidence.site_pk, 'page' AS observation_kind, evidence.visit_id AS entity_id "
        : `SELECT DISTINCT evidence.site_pk, evidence.${input.scope === "session" ? "session_id" : "visitor_id"} AS entity_id `;
    from = "FROM visits AS evidence";
    identityGuards =
      input.scope === "observation"
        ? ""
        : `AND evidence.${input.scope === "session" ? "session_id" : "visitor_id"} IS NOT NULL ` +
          `AND evidence.${input.scope === "session" ? "session_id" : "visitor_id"} != '' `;
  } else {
    const eventKind = input.scope === "observation";
    select = eventKind
      ? "SELECT DISTINCT evidence.site_pk, 'event' AS observation_kind, evidence.event_id AS entity_id "
      : `SELECT DISTINCT owner.site_pk, owner.${input.scope === "session" ? "session_id" : "visitor_id"} AS entity_id `;
    from =
      "FROM custom_events AS evidence " +
      "JOIN custom_event_names AS native_name " +
      "ON native_name.site_pk = evidence.site_pk " +
      "AND native_name.id = evidence.event_name_id " +
      (eventKind
        ? ""
        : "JOIN visits AS owner ON owner.site_pk = evidence.site_pk " +
          "AND owner.visit_id = evidence.visit_id ");
    identityGuards = eventKind
      ? ""
      : `AND owner.status = 'complete' ` +
        `AND owner.${input.scope === "session" ? "session_id" : "visitor_id"} IS NOT NULL ` +
        `AND owner.${input.scope === "session" ? "session_id" : "visitor_id"} != '' `;
  }
  const rawSql =
    `${select}${from} ` +
    `WHERE evidence.site_pk = ? AND ${rawTimePredicate(timeColumn, input.domain)} ` +
    (field.kind === "page" ? "AND evidence.status = 'complete' " : "") +
    `AND ${where} ${identityGuards}ORDER BY entity_id`;
  if (input.operator === "eq") {
    if (typeof input.value !== "string")
      throw new Error("eq needs a raw string value.");
    bindings.push(input.value);
  } else if (input.operator === "in") {
    if (!Array.isArray(input.value)) throw new Error("in needs raw values.");
    bindings.push(JSON.stringify(input.value));
  }
  const matches = readRawIdentityRows(db, rawSql, bindings).map((row) =>
    encodeIdentity(decodeRawIdentity(row, input.scope)),
  );
  const candidate = legacyCandidateSet(db, input.sitePk, input.scope);
  return new Set(matches.filter((identity) => candidate.has(identity)));
}

type RawSetOperation = "union" | "intersect" | "difference";

/**
 * Execute a frozen set formula in SQLite over independently queried raw
 * evidence keys. SQLite spells duplicate-eliminating UNION simply `UNION`.
 */
function legacySqlSetOperation(
  db: DatabaseSync,
  scope: Scope,
  operation: RawSetOperation,
  leftIdentities: readonly string[],
  rightIdentities: readonly string[],
): Set<string> {
  const columns =
    scope === "observation"
      ? ["site_pk", "observation_kind", "entity_id"]
      : ["site_pk", "entity_id"];
  const tupleSelect = (
    identities: readonly string[],
  ): { readonly sql: string; readonly bindings: (number | string)[] } => {
    if (identities.length === 0) {
      return {
        sql:
          "SELECT " +
          columns
            .map(
              (column, index) =>
                `CAST(NULL AS ${index === 0 ? "INTEGER" : "TEXT"}) AS ${column}`,
            )
            .join(", ") +
          " WHERE 0",
        bindings: [],
      };
    }
    const keys = identities.map(
      (identity) => JSON.parse(identity) as (number | string)[],
    );
    return {
      sql: keys
        .map(
          (key) =>
            "SELECT " +
            columns.map((column, index) => `? AS ${column}`).join(", "),
        )
        .join(" UNION ALL "),
      bindings: keys.flatMap((key) => key),
    };
  };
  const left = tupleSelect(leftIdentities);
  const right = tupleSelect(rightIdentities);
  const setOperator =
    operation === "union"
      ? "UNION"
      : operation === "intersect"
        ? "INTERSECT"
        : "EXCEPT";
  const sql =
    `WITH left_set(${columns.join(", ")}) AS (${left.sql}), ` +
    `right_set(${columns.join(", ")}) AS (${right.sql}) ` +
    `SELECT ${columns.join(", ")} FROM left_set ${setOperator} ` +
    `SELECT ${columns.join(", ")} FROM right_set ` +
    `ORDER BY ${columns.join(", ")}`;
  const rows = readRawIdentityRows(db, sql, [
    ...left.bindings,
    ...right.bindings,
  ]);
  return new Set(
    rows.map((row) => encodeIdentity(decodeRawIdentity(row, scope))),
  );
}

function legacyPageSelectorMatches(
  db: DatabaseSync,
  input: {
    readonly sitePk: number;
    readonly scope: Scope;
    readonly predicate: unknown;
    readonly domain: Domain;
  },
): Set<string> {
  const compilePredicate = (predicate: unknown): string => {
    if (!predicate || typeof predicate !== "object") {
      throw new Error("Expected a page selector predicate.");
    }
    const expression = predicate as Record<string, unknown>;
    if (expression.kind === "and" || expression.kind === "or") {
      const children = expression.children as unknown[];
      const separator = expression.kind === "and" ? " AND " : " OR ";
      return `(${children.map(compilePredicate).join(separator)})`;
    }
    if (expression.kind === "not") {
      return `(NOT ${compilePredicate(expression.child)})`;
    }
    const condition = expression as {
      readonly target?: { readonly kind?: string; readonly field?: string };
      readonly operator?: string;
      readonly value?: string | readonly string[];
    };
    const field = condition.target?.field;
    if (
      condition.target?.kind !== "field" ||
      (field !== "page.path" &&
        field !== "page.hostname" &&
        field !== "user.id")
    ) {
      throw new Error(
        "The raw page selector oracle accepts only native Page fields.",
      );
    }
    const physical = RAW_FIELD_ORACLE[field].column;
    const predicateSql = rawOperatorSql(
      condition.operator ?? "",
      `evidence.${physical}`,
    );
    if (condition.operator === "eq") {
      if (typeof condition.value !== "string")
        throw new Error("eq needs a raw string value.");
      bindings.push(condition.value);
    }
    return predicateSql;
  };
  const bindings: (number | string)[] = [input.sitePk];
  const localPredicate = compilePredicate(input.predicate);
  const entityField =
    input.scope === "observation"
      ? "evidence.visit_id AS entity_id"
      : `evidence.${input.scope === "session" ? "session_id" : "visitor_id"} AS entity_id`;
  const observationKind =
    input.scope === "observation" ? "'page' AS observation_kind, " : "";
  const scopeKey = input.scope === "observation" ? "entity_id" : "entity_id";
  const identityGuard =
    input.scope === "observation"
      ? ""
      : `AND evidence.${input.scope === "session" ? "session_id" : "visitor_id"} IS NOT NULL ` +
        `AND evidence.${input.scope === "session" ? "session_id" : "visitor_id"} != '' `;
  const sql =
    `SELECT DISTINCT evidence.site_pk, ${observationKind}${entityField} ` +
    "FROM visits AS evidence WHERE evidence.site_pk = ? " +
    `AND evidence.status = 'complete' AND ${rawTimePredicate("evidence.started_at", input.domain)} ` +
    `AND ${localPredicate} ${identityGuard}ORDER BY ${scopeKey}`;
  const matches = readRawIdentityRows(db, sql, bindings).map((row) =>
    encodeIdentity(decodeRawIdentity(row, input.scope)),
  );
  const candidate = legacyCandidateSet(db, input.sitePk, input.scope);
  return new Set(matches.filter((identity) => candidate.has(identity)));
}

function legacyDocumentSet(
  db: DatabaseSync,
  sitePk: number,
  scope: Scope,
  root: unknown,
  domain: Domain,
): Set<string> {
  const candidate = legacyCandidateSet(db, sitePk, scope);
  const evaluate = (expression: unknown): Set<string> => {
    if (!expression || typeof expression !== "object") {
      throw new Error("Expected a FilterDocument expression.");
    }
    const node = expression as Record<string, unknown>;
    if (node.kind === "not") {
      const child = evaluate(node.child);
      return new Set([...candidate].filter((identity) => !child.has(identity)));
    }
    if (node.kind === "and" || node.kind === "or") {
      const children = node.children as unknown[];
      const sets = children.map(evaluate);
      if (node.kind === "or") return new Set(sets.flatMap((set) => [...set]));
      return sets
        .slice(1)
        .reduce(
          (accumulated, next) =>
            new Set([...accumulated].filter((identity) => next.has(identity))),
          sets[0] ?? new Set<string>(),
        );
    }
    const condition = node as {
      readonly target?: {
        readonly kind?: string;
        readonly field?: string;
        readonly collection?: {
          readonly kind?: string;
          readonly entity?: string;
        };
        readonly predicate?: unknown;
      };
      readonly operator?: string;
      readonly value?: string | readonly string[];
    };
    let matches: Set<string>;
    const selector = condition.target?.kind === "selector";
    if (selector) {
      if (condition.target.collection?.entity !== "page") {
        throw new Error(
          "This raw selector oracle is limited to Page selectors.",
        );
      }
      matches = legacyPageSelectorMatches(db, {
        sitePk,
        scope,
        predicate: condition.target.predicate,
        domain,
      });
    } else {
      const field = condition.target?.field as RawField | undefined;
      if (!field) throw new Error("Expected a native raw field condition.");
      matches = legacyFieldMatches(db, {
        sitePk,
        scope,
        field,
        operator: condition.operator ?? "",
        value: condition.value,
        domain,
      });
    }
    if (selector && condition.operator === "notExists") {
      return new Set(
        [...candidate].filter((identity) => !matches.has(identity)),
      );
    }
    return matches;
  };
  return evaluate(root);
}

function seedIdentityFixture(db: DatabaseSync) {
  const siteAPk = insertSite(db, SITE_A);
  const siteBPk = insertSite(db, SITE_B);
  const purchaseId = insertEventName(db, SITE_A, siteAPk, "purchase");
  const foreignNameId = insertEventName(db, SITE_B, siteBPk, "purchase");

  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-candidate-one",
    sessionId: "shared-session",
    visitorId: "shared-visitor",
    startedAt: 150,
    path: "/entry",
    hostname: "CASE.Example",
    userId: "user-a",
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-same-session-other-page",
    sessionId: "shared-session",
    visitorId: "shared-visitor",
    startedAt: 151,
    path: "/other",
    hostname: "case.example",
    userId: "user-b",
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-candidate-two",
    sessionId: "next-session",
    visitorId: "shared-visitor",
    startedAt: 199,
    path: "/pricing",
    hostname: "raw-host",
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-event-owner-outside-candidate",
    sessionId: "event-session",
    visitorId: "event-visitor",
    startedAt: 50,
    path: "/history",
  });
  insertEvent(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-candidate-one",
    ownerVisitId: "a-event-owner-outside-candidate",
    eventNameId: purchaseId,
    occurredAt: 175,
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-foreign-dictionary-owner",
    sessionId: "foreign-dictionary-session",
    visitorId: "foreign-dictionary-visitor",
    startedAt: 60,
    path: "/dictionary-owner",
  });
  insertPage(db, {
    siteId: SITE_B,
    sitePk: siteBPk,
    id: "b-cross-owner-only",
    sessionId: "foreign-owner-session",
    visitorId: "foreign-owner-only",
    startedAt: 150,
    path: "/foreign-owner",
  });
  insertEvent(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-foreign-dictionary-event",
    ownerVisitId: "a-foreign-dictionary-owner",
    eventNameId: foreignNameId,
    occurredAt: 177,
  });
  insertEvent(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-cross-site-owner-event",
    ownerVisitId: "b-cross-owner-only",
    eventNameId: purchaseId,
    occurredAt: 178,
  });
  insertEvent(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-read-same-site-owner-event",
    ownerVisitId: "a-event-owner-outside-candidate",
    eventNameId: purchaseId,
    occurredAt: 70,
  });
  insertEvent(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-read-cross-site-owner-event",
    ownerVisitId: "b-cross-owner-only",
    eventNameId: purchaseId,
    occurredAt: 80,
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-empty-visitor",
    sessionId: "empty-visitor-session",
    visitorId: "",
    startedAt: 152,
    path: "/empty",
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-space-visitor",
    sessionId: "space-session",
    visitorId: " \t\u00a0",
    startedAt: 153,
    path: "/space",
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-unicode-visitor",
    sessionId: "unicode-session",
    visitorId: "café 東京 🐈",
    startedAt: 154,
    path: "/unicode",
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-case-visitor-upper",
    sessionId: "case-upper-session",
    visitorId: "CaseID",
    startedAt: 155,
    path: "/case-upper",
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-case-visitor-lower",
    sessionId: "case-lower-session",
    visitorId: "caseid",
    startedAt: 156,
    path: "/case-lower",
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-null-native-fields",
    sessionId: "null-fields-session",
    visitorId: "null-fields-visitor",
    startedAt: 157,
    path: "/raw-null",
    userId: null,
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-empty-native-fields",
    sessionId: "empty-fields-session",
    visitorId: "empty-fields-visitor",
    startedAt: 158,
    path: "/raw-empty",
    hostname: "",
    userId: "",
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-space-native-fields",
    sessionId: "space-fields-session",
    visitorId: "space-fields-visitor",
    startedAt: 159,
    path: "/raw-space",
    hostname: " \t\u00a0",
    userId: " \t\u00a0",
  });
  insertPage(db, {
    siteId: SITE_A,
    sitePk: siteAPk,
    id: "a-historical-only",
    sessionId: "historical-only-session",
    visitorId: "historical-only-visitor",
    startedAt: 50,
    path: "/old-match",
  });
  insertPage(db, {
    siteId: SITE_B,
    sitePk: siteBPk,
    id: "b-same-raw-identities",
    sessionId: "shared-session",
    visitorId: "shared-visitor",
    startedAt: 150,
    path: "/foreign",
  });
  return { siteAPk, siteBPk };
}

function seedBoundaryFixture(db: DatabaseSync): number {
  const sitePk = insertSite(db, SITE_A);
  insertPage(db, {
    siteId: SITE_A,
    sitePk,
    id: "boundary-anchor",
    sessionId: "boundary-session",
    visitorId: "boundary-visitor",
    startedAt: 150,
    path: "/anchor",
  });
  const pages = [
    ["candidate-start", 100],
    ["candidate-end", 200],
    ["filter-start", 200],
    ["filter-before-end", 299],
    ["filter-end", 300],
    ["read-start", 0],
    ["read-before-end", 99],
    ["read-end", 100],
  ] as const;
  for (const [name, startedAt] of pages) {
    insertPage(db, {
      siteId: SITE_A,
      sitePk,
      id: `page-${name}`,
      sessionId:
        name === "candidate-start" ? "s-candidate-start" : "boundary-session",
      visitorId:
        name === "candidate-start" ? "v-candidate-start" : "boundary-visitor",
      startedAt,
      path: `/${name}`,
    });
  }
  for (const [name, occurredAt] of pages) {
    const nameId = insertEventName(db, SITE_A, sitePk, name);
    insertEvent(db, {
      siteId: SITE_A,
      sitePk,
      id: `event-${name}`,
      ownerVisitId: "boundary-anchor",
      eventNameId: nameId,
      occurredAt,
    });
  }
  return sitePk;
}

describe("Wave31 scoped identity raw-SQL oracle", () => {
  it("separates the legacy candidate owner domain from optional Visitor activity", () => {
    const db = createMigratedDatabase();
    try {
      const { siteAPk } = seedIdentityFixture(db);

      expect(legacyCandidateObservationUniverse(db, siteAPk)).toEqual([
        [siteAPk, "event", "a-candidate-one"],
        [siteAPk, "event", "a-foreign-dictionary-event"],
        [siteAPk, "page", "a-candidate-one"],
        [siteAPk, "page", "a-candidate-two"],
        [siteAPk, "page", "a-case-visitor-lower"],
        [siteAPk, "page", "a-case-visitor-upper"],
        [siteAPk, "page", "a-empty-native-fields"],
        [siteAPk, "page", "a-empty-visitor"],
        [siteAPk, "page", "a-null-native-fields"],
        [siteAPk, "page", "a-same-session-other-page"],
        [siteAPk, "page", "a-space-native-fields"],
        [siteAPk, "page", "a-space-visitor"],
        [siteAPk, "page", "a-unicode-visitor"],
      ]);
      expect(rawCandidateObservationUniverse(db, siteAPk)).toEqual([
        [siteAPk, "event", "a-candidate-one"],
        [siteAPk, "event", "a-cross-site-owner-event"],
        [siteAPk, "event", "a-foreign-dictionary-event"],
        [siteAPk, "page", "a-candidate-one"],
        [siteAPk, "page", "a-candidate-two"],
        [siteAPk, "page", "a-case-visitor-lower"],
        [siteAPk, "page", "a-case-visitor-upper"],
        [siteAPk, "page", "a-empty-native-fields"],
        [siteAPk, "page", "a-empty-visitor"],
        [siteAPk, "page", "a-null-native-fields"],
        [siteAPk, "page", "a-same-session-other-page"],
        [siteAPk, "page", "a-space-native-fields"],
        [siteAPk, "page", "a-space-visitor"],
        [siteAPk, "page", "a-unicode-visitor"],
      ]);
      expect(legacySessionUniverse(db, siteAPk)).toEqual([
        [siteAPk, "case-lower-session"],
        [siteAPk, "case-upper-session"],
        [siteAPk, "empty-fields-session"],
        [siteAPk, "empty-visitor-session"],
        [siteAPk, "event-session"],
        [siteAPk, "foreign-dictionary-session"],
        [siteAPk, "next-session"],
        [siteAPk, "null-fields-session"],
        [siteAPk, "shared-session"],
        [siteAPk, "space-fields-session"],
        [siteAPk, "space-session"],
        [siteAPk, "unicode-session"],
      ]);
      expect(legacyVisitorUniverse(db, siteAPk)).toEqual(
        expect.arrayContaining([
          [siteAPk, " \t\u00a0"],
          [siteAPk, "CaseID"],
          [siteAPk, "caseid"],
          [siteAPk, "café 東京 🐈"],
          [siteAPk, "empty-fields-visitor"],
          [siteAPk, "event-visitor"],
          [siteAPk, "foreign-dictionary-visitor"],
          [siteAPk, "null-fields-visitor"],
          [siteAPk, "space-fields-visitor"],
          [siteAPk, "shared-visitor"],
        ]),
      );
      expect(legacyVisitorUniverse(db, siteAPk)).toHaveLength(10);
    } finally {
      db.close();
    }
  });

  it("executes independent Observation, Session, and Visitor set formulas", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteAPk } = seedIdentityFixture(db);
      const pageEntry = filterCondition("page.path", "eq", "/entry");
      const pageOther = filterCondition("page.path", "eq", "/other");
      const pagePricing = filterCondition("page.path", "eq", "/pricing");
      const userB = filterCondition("user.id", "eq", "user-b");
      const eventPurchase = filterCondition("event.name", "eq", "purchase");
      const separateRowsAnd = { kind: "and", children: [pageEntry, userB] };
      const acrossSessionsAnd = {
        kind: "and",
        children: [pageEntry, pagePricing],
      };
      const mixedAndOrNot = {
        kind: "and",
        children: [
          { kind: "or", children: [pageEntry, eventPurchase] },
          { kind: "not", child: pageOther },
        ],
      };
      const rootNot = { kind: "not", child: pageEntry };
      const localPageAnd = selectorCondition("page", "exists", {
        kind: "and",
        children: [pageEntry, userB],
      });
      const historicalOnly = filterCondition("page.path", "eq", "/old-match");

      for (const scope of ["observation", "session", "visitor"] as const) {
        const entrySet = await expectFilterToMatchRawSql(
          db,
          siteAPk,
          scope,
          pageEntry,
          "candidate",
        );
        await expectFilterToMatchRawSql(
          db,
          siteAPk,
          scope,
          eventPurchase,
          "candidate",
        );
        await expectFilterToMatchRawSql(
          db,
          siteAPk,
          scope,
          separateRowsAnd,
          "candidate",
        );
        await expectFilterToMatchRawSql(
          db,
          siteAPk,
          scope,
          acrossSessionsAnd,
          "candidate",
        );
        await expectFilterToMatchRawSql(
          db,
          siteAPk,
          scope,
          mixedAndOrNot,
          "candidate",
        );
        const negativeSet = await expectFilterToMatchRawSql(
          db,
          siteAPk,
          scope,
          rootNot,
          "candidate",
        );
        expect(negativeSet).not.toEqual(entrySet);
        await expectFilterToMatchRawSql(
          db,
          siteAPk,
          scope,
          historicalOnly,
          "read",
        );
        if (scope !== "observation") {
          await expectFilterToMatchRawSql(
            db,
            siteAPk,
            scope,
            localPageAnd,
            "candidate",
          );
        }
      }

      const separateSessionRows = await executeFilter(
        db,
        filterDocument(separateRowsAnd),
        "session",
        { domain: "candidate" },
      );
      expect(outputIdentitySet(separateSessionRows, "session")).toEqual(
        new Set([encodeIdentity([siteAPk, "shared-session"])]),
      );
      const sameActivityRows = await executeFilter(
        db,
        filterDocument(localPageAnd),
        "session",
        { domain: "candidate" },
      );
      expect(outputIdentitySet(sameActivityRows, "session")).toEqual(new Set());
      const acrossSessionVisitors = await executeFilter(
        db,
        filterDocument(acrossSessionsAnd),
        "visitor",
        { domain: "candidate" },
      );
      expect(outputIdentitySet(acrossSessionVisitors, "visitor")).toEqual(
        new Set([encodeIdentity([siteAPk, "shared-visitor"])]),
      );
      const acrossSessionSessions = await executeFilter(
        db,
        filterDocument(acrossSessionsAnd),
        "session",
        { domain: "candidate" },
      );
      expect(outputIdentitySet(acrossSessionSessions, "session")).toEqual(
        new Set(),
      );

      const pageEvidence = await executeFilter(
        db,
        filterDocument(pageEntry),
        "observation",
        { domain: "candidate" },
      );
      const eventEvidence = await executeFilter(
        db,
        filterDocument(eventPurchase),
        "observation",
        { domain: "candidate" },
      );
      expect(outputIdentitySet(pageEvidence, "observation")).toContain(
        encodeIdentity([siteAPk, "page", "a-candidate-one"]),
      );
      expect(outputIdentitySet(eventEvidence, "observation")).toContain(
        encodeIdentity([siteAPk, "event", "a-candidate-one"]),
      );
      expect(outputIdentitySet(eventEvidence, "observation")).not.toContain(
        encodeIdentity([siteAPk, "event", "a-foreign-dictionary-event"]),
      );
      const eventVisitorEvidence = await executeFilter(
        db,
        filterDocument(eventPurchase),
        "visitor",
        { domain: "candidate" },
      );
      expect(outputIdentitySet(eventVisitorEvidence, "visitor")).not.toContain(
        encodeIdentity([siteAPk, "foreign-dictionary-visitor"]),
      );
      expect(outputIdentitySet(eventVisitorEvidence, "visitor")).not.toContain(
        encodeIdentity([siteAPk, "foreign-owner-only"]),
      );
    } finally {
      db.close();
    }
  });

  it("keeps candidate, filter, and read evidence half-open for Page and Event", async () => {
    const db = createMigratedDatabase();
    try {
      const sitePk = seedBoundaryFixture(db);
      for (const scope of ["observation", "session", "visitor"] as const) {
        for (const [domain, start, beforeEnd, end] of [
          ["candidate", "candidate-start", null, "candidate-end"],
          ["filter", "filter-start", "filter-before-end", "filter-end"],
          ["read", "read-start", "read-before-end", "read-end"],
        ] as const) {
          for (const [field, prefix] of [
            ["page.path", "page"],
            ["event.name", "event"],
          ] as const) {
            const atStart = await expectFilterToMatchRawSql(
              db,
              sitePk,
              scope,
              filterCondition(
                field,
                "eq",
                field === "page.path" ? `/${start}` : start,
              ),
              domain,
            );
            if (domain === "candidate" || scope !== "observation") {
              expect(atStart.size).toBeGreaterThan(0);
            }
            if (beforeEnd) {
              const beforeExclusiveEnd = await expectFilterToMatchRawSql(
                db,
                sitePk,
                scope,
                filterCondition(
                  field,
                  "eq",
                  field === "page.path" ? `/${beforeEnd}` : beforeEnd,
                ),
                domain,
              );
              if (scope !== "observation") {
                expect(beforeExclusiveEnd.size).toBeGreaterThan(0);
              }
            }
            const atEnd = await expectFilterToMatchRawSql(
              db,
              sitePk,
              scope,
              filterCondition(
                field,
                "eq",
                field === "page.path" ? `/${end}` : end,
              ),
              domain,
            );
            expect(atEnd).toEqual(new Set());
            if (domain === "candidate" && start === "candidate-start") {
              const expectedIdentity =
                scope === "observation"
                  ? [sitePk, prefix as "page" | "event", `${prefix}-${start}`]
                  : [
                      sitePk,
                      prefix === "page"
                        ? scope === "session"
                          ? "s-candidate-start"
                          : "v-candidate-start"
                        : scope === "session"
                          ? "boundary-session"
                          : "boundary-visitor",
                    ];
              expect(atStart).toEqual(
                new Set([encodeIdentity(expectedIdentity)]),
              );
            }
          }
        }
      }
    } finally {
      db.close();
    }
  });

  it("uses raw NULL and exact-empty presence rules for nullable user IDs", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteAPk } = seedIdentityFixture(db);
      for (const scope of ["observation", "session", "visitor"] as const) {
        for (const operator of [
          "exists",
          "notExists",
          "isEmpty",
          "notEmpty",
        ] as const) {
          await expectFilterToMatchRawSql(
            db,
            siteAPk,
            scope,
            filterCondition("user.id", operator),
            "candidate",
          );
        }
      }
      for (const operator of [
        "exists",
        "notExists",
        "isEmpty",
        "notEmpty",
      ] as const) {
        await expectFilterToMatchRawSql(
          db,
          siteAPk,
          "visitor",
          filterCondition("page.hostname", operator),
          "candidate",
        );
      }

      const nullUserObservation = await executeFilter(
        db,
        filterDocument(filterCondition("user.id", "notExists")),
        "observation",
        { domain: "candidate" },
      );
      const nullUserObservations = outputIdentitySet(
        nullUserObservation,
        "observation",
      );
      expect(nullUserObservations).toContain(
        encodeIdentity([siteAPk, "page", "a-null-native-fields"]),
      );
      expect(nullUserObservations).not.toContain(
        encodeIdentity([siteAPk, "page", "a-empty-native-fields"]),
      );
      expect(nullUserObservations).not.toContain(
        encodeIdentity([siteAPk, "page", "a-space-native-fields"]),
      );
      const emptyUserVisitor = await executeFilter(
        db,
        filterDocument(filterCondition("user.id", "isEmpty")),
        "visitor",
        { domain: "candidate" },
      );
      expect(outputIdentitySet(emptyUserVisitor, "visitor")).toEqual(
        new Set([encodeIdentity([siteAPk, "empty-fields-visitor"])]),
      );
      const whitespaceVisitor = await executeFilter(
        db,
        filterDocument(filterCondition("page.path", "eq", "/space")),
        "visitor",
        { domain: "candidate" },
      );
      expect(outputIdentitySet(whitespaceVisitor, "visitor")).toContain(
        encodeIdentity([siteAPk, " \t\u00a0"]),
      );
      const caseUpperVisitor = await executeFilter(
        db,
        filterDocument(filterCondition("page.path", "eq", "/case-upper")),
        "visitor",
        { domain: "candidate" },
      );
      const caseLowerVisitor = await executeFilter(
        db,
        filterDocument(filterCondition("page.path", "eq", "/case-lower")),
        "visitor",
        { domain: "candidate" },
      );
      expect(outputIdentitySet(caseUpperVisitor, "visitor")).toContain(
        encodeIdentity([siteAPk, "CaseID"]),
      );
      expect(outputIdentitySet(caseLowerVisitor, "visitor")).toContain(
        encodeIdentity([siteAPk, "caseid"]),
      );
      // `visits.visitor_id` and `visits.hostname` are NOT NULL in the actual
      // migration; the visitor nullable-association case is covered by the
      // cross-site Event owner below, while empty visitor ID remains raw data.
      expect(legacyVisitorUniverse(db, siteAPk)).not.toContainEqual([
        siteAPk,
        "",
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps unsupported derived, payload, folded-text and visitor relationship filters out", () => {
    const cases = [
      filterCondition("page.hostname", "eq", "CASE.Example"),
      filterCondition("page.hostname", "in", ["CASE.Example"]),
      filterCondition("traffic.channel", "eq", "direct"),
      filterCondition("event.payload", "eq", "value"),
      filterCondition("session.visitor", "eq", "visitor"),
    ];
    for (const condition of cases) {
      expect(filterIsRejected(filterDocument(condition))).toBe(true);
    }

    const boundedField = filterDocument(
      filterCondition("page.path", "eq", "/entry"),
    );
    expect(
      filterIsRejected(boundedField, {
        domain: "read",
        read: { kind: "retained-history" },
      }),
    ).toBe(true);
    expect(
      filterIsRejected(boundedField, {
        domain: "filter",
        filter: null,
      }),
    ).toBe(true);
    expect(
      filterIsRejected(boundedField, {
        domain: "filter",
        filter: { startMs: 200 },
      }),
    ).toBe(true);

    for (const [entity, relationship] of [
      ["page", "page.visitor"],
      ["event", "event.visitor"],
    ] as const) {
      const builder = new LogicalPlanBuilder(planContext("visitor", [SITE_A]));
      const source = builder.source(entity, {
        temporalDomain: "candidate",
        relationships: [relationship],
      });
      builder.output("direct-visitor", source, [
        { name: "entity", slot: "entity" },
        { name: "visitor", slot: `relationship:${relationship}` },
      ]);
      const plan = builder.finish();
      expect(() =>
        new AnalyticsLogicalToDbLowerer(plan, {
          siteIds: [SITE_A],
          time: plan.context.time,
        }).lower(plan.outputs[0]!),
      ).toThrow();
    }
  });

  it("checks duplicate union, intersection, difference, and empty keys in SQLite", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteAPk } = seedIdentityFixture(db);
      const pageEntry = filterCondition("page.path", "eq", "/entry");
      const userB = filterCondition("user.id", "eq", "user-b");
      const pageOther = filterCondition("page.path", "eq", "/other");
      const rawEntryByScope = new Map<Scope, Set<string>>();

      for (const scope of ["observation", "session", "visitor"] as const) {
        const entry = legacyFieldMatches(db, {
          sitePk: siteAPk,
          scope,
          field: "page.path",
          operator: "eq",
          value: "/entry",
          domain: "candidate",
        });
        const second = legacyFieldMatches(db, {
          sitePk: siteAPk,
          scope,
          field: "user.id",
          operator: "eq",
          value: "user-b",
          domain: "candidate",
        });
        const differentPage = legacyFieldMatches(db, {
          sitePk: siteAPk,
          scope,
          field: "page.path",
          operator: "eq",
          value: "/other",
          domain: "candidate",
        });
        rawEntryByScope.set(scope, entry);

        const duplicateUnion = legacySqlSetOperation(
          db,
          scope,
          "union",
          [...entry, ...entry],
          [...second],
        );
        const intersection = legacySqlSetOperation(
          db,
          scope,
          "intersect",
          [...entry],
          [...second],
        );
        const emptyIntersection = legacySqlSetOperation(
          db,
          scope,
          "intersect",
          [...entry],
          [...differentPage],
        );
        const difference = legacySqlSetOperation(
          db,
          scope,
          "difference",
          [...legacyCandidateSet(db, siteAPk, scope)],
          [...entry],
        );

        const actualUnion = await executeFilter(
          db,
          filterDocument({ kind: "or", children: [pageEntry, userB] }),
          scope,
          { domain: "candidate" },
        );
        const actualIntersection = await executeFilter(
          db,
          filterDocument({ kind: "and", children: [pageEntry, userB] }),
          scope,
          { domain: "candidate" },
        );
        const actualEmpty = await executeFilter(
          db,
          filterDocument({ kind: "and", children: [pageEntry, pageOther] }),
          scope,
          { domain: "candidate" },
        );
        const actualDifference = await executeFilter(
          db,
          filterDocument({ kind: "not", child: pageEntry }),
          scope,
          { domain: "candidate" },
        );
        expect(outputIdentitySet(actualUnion, scope)).toEqual(duplicateUnion);
        expect(outputIdentitySet(actualIntersection, scope)).toEqual(
          intersection,
        );
        expect(outputIdentitySet(actualEmpty, scope)).toEqual(
          emptyIntersection,
        );
        expect(outputIdentitySet(actualDifference, scope)).toEqual(difference);
        if (scope === "observation") expect(intersection.size).toBe(0);
        else expect(intersection.size).toBe(1);
      }
      expect(rawEntryByScope.get("observation")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("lowers the native report Observation carrier with an optional same-site owner", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteAPk } = seedIdentityFixture(db);
      const lowered = lowerReportObservationCarrier();
      const result = await createD1DatabaseClient(
        createSqliteD1Database(db),
      ).all(lowered.query);
      const actual = result.results as Array<{
        readonly site_pk: number;
        readonly observation_kind: "page" | "event";
        readonly observation_id: string;
        readonly visitor_site_pk: number | null;
        readonly visitor_id: string | null;
      }>;
      const actualShape = actual
        .map((row) => ({
          site_pk: row.site_pk,
          observation_kind: row.observation_kind,
          observation_id: row.observation_id,
          visitor_site_pk: row.visitor_site_pk,
          visitor_id: row.visitor_id,
        }))
        .sort((a, b) =>
          `${a.observation_kind}:${a.observation_id}`.localeCompare(
            `${b.observation_kind}:${b.observation_id}`,
          ),
        );
      const expected = legacyReportObservationRows(db, siteAPk);
      expect(actualShape).toEqual(expected);
      expect(
        actualShape.find(
          (row) => row.observation_id === "a-read-same-site-owner-event",
        ),
      ).toMatchObject({
        observation_kind: "event",
        visitor_site_pk: siteAPk,
        visitor_id: "event-visitor",
      });
      expect(
        actualShape.find(
          (row) => row.observation_id === "a-read-cross-site-owner-event",
        ),
      ).toMatchObject({
        site_pk: siteAPk,
        observation_kind: "event",
        visitor_site_pk: siteAPk,
        visitor_id: null,
      });
      expect(actualShape.map((row) => row.observation_id)).toContain(
        "a-read-cross-site-owner-event",
      );
      expect(lowered.query.sql).toContain("LEFT JOIN");
    } finally {
      db.close();
    }
  });

  it("validates scoped set provenance and forwards an unused relationship slot", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteAPk } = seedIdentityFixture(db);
      const context = planContext("observation", [SITE_A]);
      const builder = new LogicalPlanBuilder(context);
      const left = builder.source("observation", {
        temporalDomain: "candidate",
      });
      const right = builder.source("observation", {
        temporalDomain: "candidate",
      });
      const union = builder.setOperation("union", [left, right]);
      builder.output("observation-union", union, [
        { name: "entity", slot: "entity" },
      ]);
      const validPlan = builder.finish();
      const validLowerer = new AnalyticsLogicalToDbLowerer(validPlan, {
        siteIds: [SITE_A],
        time: validPlan.context.time,
      });
      const validOutput = validPlan.outputs[0]!;
      const loweredOutput = validLowerer.lower(validOutput);
      expect(() =>
        validLowerer.projectOutput(loweredOutput, [
          {
            name: "invalid_fourth_component",
            slot: validOutput.fields[0]!.slot,
            component: 3,
          },
        ]),
      ).toThrow();

      const malformedMixed = structuredClone(validPlan) as unknown as {
        readonly context: typeof validPlan.context;
        readonly outputs: typeof validPlan.outputs;
        readonly nodes: Array<Record<string, unknown>>;
      };
      const sourceNodes = malformedMixed.nodes.filter(
        (node) => node.kind === "source",
      );
      const mixedSource = sourceNodes[1]!;
      mixedSource.entity = "visitor";
      (mixedSource.grain as Record<string, unknown>).entity = "visitor";
      expect(() =>
        new AnalyticsLogicalToDbLowerer(malformedMixed as never, {
          siteIds: [SITE_A],
          time: validPlan.context.time,
        }).lower(malformedMixed.outputs[0]!),
      ).toThrow();

      const malformedOrigin = structuredClone(validPlan) as unknown as {
        readonly context: typeof validPlan.context;
        readonly outputs: typeof validPlan.outputs;
        readonly nodes: Array<Record<string, unknown>>;
      };
      const forgedSource = malformedOrigin.nodes.find(
        (node) => node.kind === "source",
      )!;
      forgedSource.entity = "page";
      (forgedSource.grain as Record<string, unknown>).entity = "page";
      expect(() =>
        new AnalyticsLogicalToDbLowerer(malformedOrigin as never, {
          siteIds: [SITE_A],
          time: validPlan.context.time,
        }).lower(malformedOrigin.outputs[0]!),
      ).toThrow();

      const nullableBuilder = new LogicalPlanBuilder(
        planContext("visitor", [SITE_A]),
      );
      const pageWithOptionalVisitor = nullableBuilder.source("page", {
        temporalDomain: "candidate",
        relationships: ["page.visitor"],
      });
      const nullableLeft = nullableBuilder.distinct(pageWithOptionalVisitor, [
        { input: "relationship:page.visitor" },
      ]);
      const nullableRight = nullableBuilder.distinct(pageWithOptionalVisitor, [
        { input: "relationship:page.visitor" },
      ]);
      const nullableUnion = nullableBuilder.setOperation("union", [
        nullableLeft,
        nullableRight,
      ]);
      nullableBuilder.output("nullable-union", nullableUnion, [
        { name: "visitor", slot: "relationship:page.visitor" },
      ]);
      const nullablePlan = nullableBuilder.finish();
      expect(() =>
        new AnalyticsLogicalToDbLowerer(nullablePlan, {
          siteIds: [SITE_A],
          time: nullablePlan.context.time,
        }).lower(nullablePlan.outputs[0]!),
      ).toThrow();

      const lookupBuilder = new LogicalPlanBuilder(context);
      const candidateObservations = lookupBuilder.source("observation", {
        temporalDomain: "candidate",
      });
      const unusedVisitor = lookupBuilder.relationshipLookup(
        candidateObservations,
        "observation.visitor",
      );
      lookupBuilder.output("unused-visitor", unusedVisitor, [
        { name: "entity", slot: "entity" },
      ]);
      const lookupPlan = lookupBuilder.finish();
      const lookupLowerer = new AnalyticsLogicalToDbLowerer(lookupPlan, {
        siteIds: [SITE_A],
        time: lookupPlan.context.time,
      });
      const lookupOutput = lookupPlan.outputs[0]!;
      const lookupDbOutput = lookupLowerer.lower(lookupOutput);
      const query = compileD1Query(
        lookupLowerer.projectOutput(lookupDbOutput, [
          { name: "site_pk", slot: lookupOutput.fields[0]!.slot, component: 0 },
          {
            name: "observation_kind",
            slot: lookupOutput.fields[0]!.slot,
            component: 1,
          },
          {
            name: "entity_id",
            slot: lookupOutput.fields[0]!.slot,
            component: 2,
          },
        ]),
      );
      expect(query.sql).not.toContain("LEFT JOIN");
      const rows = await createD1DatabaseClient(createSqliteD1Database(db)).all(
        query,
      );
      expect(
        outputIdentitySet(
          rows.results as Array<Readonly<Record<string, number | string>>>,
          "observation",
        ),
      ).toEqual(legacyCandidateSet(db, siteAPk, "observation"));

      const readSetBuilder = new LogicalPlanBuilder(context);
      const readSetLeft = readSetBuilder.source("observation", {
        temporalDomain: "read",
      });
      const readSetRight = readSetBuilder.source("observation", {
        temporalDomain: "read",
      });
      const readSetUnion = readSetBuilder.setOperation("union", [
        readSetLeft,
        readSetRight,
      ]);
      readSetBuilder.output("read-observation-union", readSetUnion, [
        { name: "entity", slot: "entity" },
      ]);
      const readSetPlan = readSetBuilder.finish();
      expect(() =>
        new AnalyticsLogicalToDbLowerer(readSetPlan, {
          siteIds: [SITE_A],
          time: readSetPlan.context.time,
        }).lower(readSetPlan.outputs[0]!),
      ).toThrow(
        "An unqualified Observation source is supported only for the candidate Page/Event union.",
      );

      const candidateSetBuilder = new LogicalPlanBuilder(context);
      const candidateSetLeft = candidateSetBuilder.source("observation", {
        temporalDomain: "candidate",
      });
      const candidateSetRight = candidateSetBuilder.source("observation", {
        temporalDomain: "candidate",
      });
      const candidateSetUnion = candidateSetBuilder.setOperation("union", [
        candidateSetLeft,
        candidateSetRight,
      ]);
      candidateSetBuilder.output(
        "candidate-observation-union",
        candidateSetUnion,
        [{ name: "entity", slot: "entity" }],
      );
      const candidateSetPlan = candidateSetBuilder.finish();
      const candidateSetLowerer = new AnalyticsLogicalToDbLowerer(
        candidateSetPlan,
        {
          siteIds: [SITE_A],
          time: candidateSetPlan.context.time,
        },
      );
      const candidateSetOutput = candidateSetPlan.outputs[0]!;
      const candidateSetDbOutput =
        candidateSetLowerer.lower(candidateSetOutput);
      const candidateSetQuery = compileD1Query(
        candidateSetLowerer.projectOutput(candidateSetDbOutput, [
          {
            name: "site_pk",
            slot: candidateSetOutput.fields[0]!.slot,
            component: 0,
          },
          {
            name: "observation_kind",
            slot: candidateSetOutput.fields[0]!.slot,
            component: 1,
          },
          {
            name: "entity_id",
            slot: candidateSetOutput.fields[0]!.slot,
            component: 2,
          },
        ]),
      );
      const candidateSetRows = await createD1DatabaseClient(
        createSqliteD1Database(db),
      ).all(candidateSetQuery);
      expect(
        outputIdentitySet(
          candidateSetRows.results as Array<
            Readonly<Record<string, number | string>>
          >,
          "observation",
        ),
      ).toEqual(legacyCandidateSet(db, siteAPk, "observation"));
    } finally {
      db.close();
    }
  });

  it("keeps candidate and report Observation bags stable across output demand", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteAPk } = seedIdentityFixture(db);
      db.exec("PRAGMA foreign_keys = OFF");
      const candidateNameId = insertEventName(
        db,
        SITE_A,
        siteAPk,
        "wave31-candidate-without-owner",
      );
      insertEvent(db, {
        siteId: SITE_A,
        sitePk: siteAPk,
        id: "z-candidate-without-owner",
        ownerVisitId: "missing-candidate-owner",
        eventNameId: candidateNameId,
        occurredAt: 180,
      });
      const readNameId = insertEventName(
        db,
        SITE_A,
        siteAPk,
        "wave31-read-without-owner",
      );
      insertEvent(db, {
        siteId: SITE_A,
        sitePk: siteAPk,
        id: "z-read-without-owner",
        ownerVisitId: "missing-read-owner",
        eventNameId: readNameId,
        occurredAt: 90,
      });

      const identityColumns = (slot: SlotId) =>
        [
          { name: "site_pk", slot, component: 0 },
          { name: "observation_kind", slot, component: 1 },
          { name: "entity_id", slot, component: 2 },
        ] as const;
      const visitorColumns = (slot: SlotId) =>
        [
          { name: "visitor_site_pk", slot, component: 0 },
          { name: "visitor_id", slot, component: 1 },
        ] as const;

      const candidateBuilder = new LogicalPlanBuilder(
        planContext("observation", [SITE_A]),
      );
      const candidateSource = candidateBuilder.source("observation", {
        temporalDomain: "candidate",
        relationships: ["observation.visitor"],
      });
      const candidateIdentity = candidateSource.slots.entity!;
      const candidateVisitor =
        candidateSource.slots["relationship:observation.visitor"]!;
      candidateBuilder.output("identity-only", candidateSource, [
        { name: "identity", slot: "entity" },
      ]);
      candidateBuilder.output("identity-and-visitor", candidateSource, [
        { name: "identity", slot: "entity" },
        { name: "visitor", slot: "relationship:observation.visitor" },
      ]);
      candidateBuilder.output("visitor-only", candidateSource, [
        { name: "visitor", slot: "relationship:observation.visitor" },
      ]);
      const candidateCount = candidateBuilder.aggregate(candidateSource, {}, [
        { name: "activityCount", kind: "count-rows" },
      ]);
      candidateBuilder.output("hidden-count", candidateCount, [
        { name: "count", slot: "activityCount" },
      ]);
      candidateBuilder.output("identity-after-count", candidateSource, [
        { name: "identity", slot: "entity" },
      ]);
      const candidatePlan = candidateBuilder.finish();
      const candidateLowerer = new AnalyticsLogicalToDbLowerer(candidatePlan, {
        siteIds: [SITE_A],
        time: candidatePlan.context.time,
      });
      const candidateIdentityOnly = await executeOutputProjection(
        db,
        candidateLowerer,
        candidatePlan.outputs[0]!,
        identityColumns(candidateIdentity),
      );
      const candidateIdentityAndVisitor = await executeOutputProjection(
        db,
        candidateLowerer,
        candidatePlan.outputs[1]!,
        [
          ...identityColumns(candidateIdentity),
          ...visitorColumns(candidateVisitor),
        ],
      );
      const candidateVisitorOnly = await executeOutputProjection(
        db,
        candidateLowerer,
        candidatePlan.outputs[2]!,
        visitorColumns(candidateVisitor),
      );
      const candidateCountRows = await executeOutputProjection(
        db,
        candidateLowerer,
        candidatePlan.outputs[3]!,
        [
          {
            name: "activity_count",
            slot: candidatePlan.outputs[3]!.fields[0]!.slot,
          },
        ],
      );
      const candidateIdentityAgain = await executeOutputProjection(
        db,
        candidateLowerer,
        candidatePlan.outputs[4]!,
        identityColumns(candidateIdentity),
      );
      const optionalCandidateRows = rawCandidateObservationUniverse(
        db,
        siteAPk,
      );
      const optionalCandidateBag = observationRawIdentityBag(
        optionalCandidateRows,
      );
      expect(observationIdentityBag(candidateIdentityOnly)).toEqual(
        optionalCandidateBag,
      );
      expect(observationIdentityBag(candidateIdentityAndVisitor)).toEqual(
        optionalCandidateBag,
      );
      expect(observationIdentityBag(candidateIdentityAgain)).toEqual(
        optionalCandidateBag,
      );
      expect(
        visitorIdentityBag(
          candidateVisitorOnly,
          "visitor_site_pk",
          "visitor_id",
        ),
      ).toEqual(
        rawActivityVisitorRows(db, siteAPk, CANDIDATE_RANGE, "optional")
          .map(encodeIdentity)
          .sort(),
      );
      expect(Number(candidateCountRows[0]?.activity_count)).toBe(
        optionalCandidateRows.length,
      );
      for (const eventId of [
        "a-cross-site-owner-event",
        "z-candidate-without-owner",
      ]) {
        expect(
          candidateIdentityAndVisitor.find((row) => row.entity_id === eventId),
        ).toMatchObject({
          visitor_site_pk: siteAPk,
          visitor_id: null,
        });
      }

      const legacyCandidateBuilder = new LogicalPlanBuilder(
        planContext("observation", [SITE_A]),
      );
      const legacyCandidateSource = legacyCandidateBuilder.source(
        "observation",
        { temporalDomain: "candidate" },
      );
      const legacyCandidateIdentity = legacyCandidateSource.slots.entity!;
      legacyCandidateBuilder.output("legacy-identity", legacyCandidateSource, [
        { name: "identity", slot: "entity" },
      ]);
      const legacyCount = legacyCandidateBuilder.aggregate(
        legacyCandidateSource,
        {},
        [{ name: "activityCount", kind: "count-rows" }],
      );
      legacyCandidateBuilder.output("legacy-hidden-count", legacyCount, [
        { name: "count", slot: "activityCount" },
      ]);
      const legacyCandidatePlan = legacyCandidateBuilder.finish();
      const legacyCandidateLowerer = new AnalyticsLogicalToDbLowerer(
        legacyCandidatePlan,
        { siteIds: [SITE_A], time: legacyCandidatePlan.context.time },
      );
      const legacyIdentityRows = await executeOutputProjection(
        db,
        legacyCandidateLowerer,
        legacyCandidatePlan.outputs[0]!,
        identityColumns(legacyCandidateIdentity),
      );
      const legacyCountRows = await executeOutputProjection(
        db,
        legacyCandidateLowerer,
        legacyCandidatePlan.outputs[1]!,
        [
          {
            name: "activity_count",
            slot: legacyCandidatePlan.outputs[1]!.fields[0]!.slot,
          },
        ],
      );
      const legacyCandidateRows = legacyCandidateObservationUniverse(
        db,
        siteAPk,
      );
      expect(observationIdentityBag(legacyIdentityRows)).toEqual(
        observationRawIdentityBag(legacyCandidateRows),
      );
      expect(Number(legacyCountRows[0]?.activity_count)).toBe(
        legacyCandidateRows.length,
      );
      expect(legacyIdentityRows).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ entity_id: "a-cross-site-owner-event" }),
          expect.objectContaining({ entity_id: "z-candidate-without-owner" }),
        ]),
      );

      const sessionBuilder = new LogicalPlanBuilder(
        planContext("observation", [SITE_A]),
      );
      const sessionSource = sessionBuilder.source("observation", {
        temporalDomain: "candidate",
        relationships: ["observation.session", "observation.visitor"],
      });
      const sessionIdentity = sessionSource.slots.entity!;
      const sessionVisitor =
        sessionSource.slots["relationship:observation.visitor"]!;
      sessionBuilder.output("session-identity-only", sessionSource, [
        { name: "identity", slot: "entity" },
      ]);
      sessionBuilder.output("session-identity-and-visitor", sessionSource, [
        { name: "identity", slot: "entity" },
        { name: "visitor", slot: "relationship:observation.visitor" },
      ]);
      const sessionSourceCount = sessionBuilder.aggregate(sessionSource, {}, [
        { name: "activityCount", kind: "count-rows" },
      ]);
      sessionBuilder.output("session-source-hidden-count", sessionSourceCount, [
        { name: "count", slot: "activityCount" },
      ]);
      const sessionPlan = sessionBuilder.finish();
      const sessionLowerer = new AnalyticsLogicalToDbLowerer(sessionPlan, {
        siteIds: [SITE_A],
        time: sessionPlan.context.time,
      });
      const sessionIdentityOnly = await executeOutputProjection(
        db,
        sessionLowerer,
        sessionPlan.outputs[0]!,
        identityColumns(sessionIdentity),
      );
      const sessionIdentityAndVisitor = await executeOutputProjection(
        db,
        sessionLowerer,
        sessionPlan.outputs[1]!,
        [
          ...identityColumns(sessionIdentity),
          ...visitorColumns(sessionVisitor),
        ],
      );
      const sessionSourceCountRows = await executeOutputProjection(
        db,
        sessionLowerer,
        sessionPlan.outputs[2]!,
        [
          {
            name: "activity_count",
            slot: sessionPlan.outputs[2]!.fields[0]!.slot,
          },
        ],
      );
      const sessionRequiredRows = legacyCandidateObservationUniverse(
        db,
        siteAPk,
      );
      const sessionRequiredBag = observationRawIdentityBag(sessionRequiredRows);
      expect(observationIdentityBag(sessionIdentityOnly)).toEqual(
        sessionRequiredBag,
      );
      expect(observationIdentityBag(sessionIdentityAndVisitor)).toEqual(
        sessionRequiredBag,
      );
      expect(Number(sessionSourceCountRows[0]?.activity_count)).toBe(
        sessionRequiredRows.length,
      );

      const readBuilder = new LogicalPlanBuilder(
        planContext("observation", [SITE_A], {
          read: { kind: "bounded", range: READ_RANGE },
        }),
      );
      const readSource = readBuilder.source("observation", {
        temporalDomain: "read",
        attributes: ["observation.kind", "observation.eventName"],
        relationships: ["observation.visitor"],
        includeOccurrenceTime: true,
      });
      const readIdentity = readSource.slots.entity!;
      const readVisitor = readSource.slots["relationship:observation.visitor"]!;
      const eventName = readSource.slots["attribute:observation.eventName"]!;
      readBuilder.output("read-identity-only", readSource, [
        { name: "identity", slot: "entity" },
      ]);
      readBuilder.output("read-identity-and-visitor", readSource, [
        { name: "identity", slot: "entity" },
        { name: "visitor", slot: "relationship:observation.visitor" },
      ]);
      readBuilder.output("read-visitor-only", readSource, [
        { name: "visitor", slot: "relationship:observation.visitor" },
      ]);
      readBuilder.output("read-event-name-only", readSource, [
        { name: "eventName", slot: "attribute:observation.eventName" },
      ]);
      const readCount = readBuilder.aggregate(readSource, {}, [
        { name: "activityCount", kind: "count-rows" },
      ]);
      readBuilder.output("read-hidden-count", readCount, [
        { name: "count", slot: "activityCount" },
      ]);
      readBuilder.output("read-identity-after-count", readSource, [
        { name: "identity", slot: "entity" },
      ]);
      const readPlan = readBuilder.finish();
      const readLowerer = new AnalyticsLogicalToDbLowerer(readPlan, {
        siteIds: [SITE_A],
        time: readPlan.context.time,
      });
      const readIdentityOnly = await executeOutputProjection(
        db,
        readLowerer,
        readPlan.outputs[0]!,
        identityColumns(readIdentity),
      );
      const readIdentityAndVisitor = await executeOutputProjection(
        db,
        readLowerer,
        readPlan.outputs[1]!,
        [...identityColumns(readIdentity), ...visitorColumns(readVisitor)],
      );
      const readVisitorOnly = await executeOutputProjection(
        db,
        readLowerer,
        readPlan.outputs[2]!,
        visitorColumns(readVisitor),
      );
      const readEventNameOnly = await executeOutputProjection(
        db,
        readLowerer,
        readPlan.outputs[3]!,
        [{ name: "event_name", slot: eventName }],
      );
      const readCountRows = await executeOutputProjection(
        db,
        readLowerer,
        readPlan.outputs[4]!,
        [
          {
            name: "activity_count",
            slot: readPlan.outputs[4]!.fields[0]!.slot,
          },
        ],
      );
      const readIdentityAgain = await executeOutputProjection(
        db,
        readLowerer,
        readPlan.outputs[5]!,
        identityColumns(readIdentity),
      );
      const optionalReadRows = rawObservationActivityRows(
        db,
        siteAPk,
        READ_RANGE,
        "optional",
      );
      const optionalReadBag = observationRawIdentityBag(optionalReadRows);
      expect(observationIdentityBag(readIdentityOnly)).toEqual(optionalReadBag);
      expect(observationIdentityBag(readIdentityAndVisitor)).toEqual(
        optionalReadBag,
      );
      expect(observationIdentityBag(readIdentityAgain)).toEqual(
        optionalReadBag,
      );
      expect(readEventNameOnly).toHaveLength(optionalReadRows.length);
      expect(
        readEventNameOnly.find(
          (row) => row.event_name === "wave31-read-without-owner",
        ),
      ).toBeDefined();
      expect(
        visitorIdentityBag(readVisitorOnly, "visitor_site_pk", "visitor_id"),
      ).toEqual(
        rawActivityVisitorRows(db, siteAPk, READ_RANGE, "optional")
          .map(encodeIdentity)
          .sort(),
      );
      expect(Number(readCountRows[0]?.activity_count)).toBe(
        optionalReadRows.length,
      );
      expect(
        readIdentityAndVisitor.find(
          (row) => row.entity_id === "z-read-without-owner",
        ),
      ).toMatchObject({
        visitor_site_pk: siteAPk,
        visitor_id: null,
      });

      const contextBuilder = new LogicalPlanBuilder(
        planContext("observation", [SITE_A], {
          read: { kind: "bounded", range: READ_RANGE },
        }),
      );
      const contextSource = contextBuilder.source("observation", {
        temporalDomain: "read",
        attributes: ["observation.kind", "observation.contextPageTitle"],
        relationships: ["observation.visitor"],
        includeOccurrenceTime: true,
      });
      const contextIdentity = contextSource.slots.entity!;
      const contextVisitor =
        contextSource.slots["relationship:observation.visitor"]!;
      const contextTitle =
        contextSource.slots["attribute:observation.contextPageTitle"]!;
      contextBuilder.output("context-identity-only", contextSource, [
        { name: "identity", slot: "entity" },
      ]);
      contextBuilder.output("context-identity-and-visitor", contextSource, [
        { name: "identity", slot: "entity" },
        { name: "visitor", slot: "relationship:observation.visitor" },
      ]);
      contextBuilder.output("context-visitor-only", contextSource, [
        { name: "visitor", slot: "relationship:observation.visitor" },
      ]);
      contextBuilder.output("context-title-only", contextSource, [
        { name: "title", slot: "attribute:observation.contextPageTitle" },
      ]);
      const contextCount = contextBuilder.aggregate(contextSource, {}, [
        { name: "activityCount", kind: "count-rows" },
      ]);
      contextBuilder.output("context-hidden-count", contextCount, [
        { name: "count", slot: "activityCount" },
      ]);
      const contextPlan = contextBuilder.finish();
      const contextLowerer = new AnalyticsLogicalToDbLowerer(contextPlan, {
        siteIds: [SITE_A],
        time: contextPlan.context.time,
      });
      const contextIdentityOnly = await executeOutputProjection(
        db,
        contextLowerer,
        contextPlan.outputs[0]!,
        identityColumns(contextIdentity),
      );
      const contextIdentityAndVisitor = await executeOutputProjection(
        db,
        contextLowerer,
        contextPlan.outputs[1]!,
        [
          ...identityColumns(contextIdentity),
          ...visitorColumns(contextVisitor),
        ],
      );
      const contextVisitorOnly = await executeOutputProjection(
        db,
        contextLowerer,
        contextPlan.outputs[2]!,
        visitorColumns(contextVisitor),
      );
      const contextTitleOnly = await executeOutputProjection(
        db,
        contextLowerer,
        contextPlan.outputs[3]!,
        [{ name: "context_title", slot: contextTitle }],
      );
      const contextCountRows = await executeOutputProjection(
        db,
        contextLowerer,
        contextPlan.outputs[4]!,
        [
          {
            name: "activity_count",
            slot: contextPlan.outputs[4]!.fields[0]!.slot,
          },
        ],
      );
      const ownerContextRows = rawObservationActivityRows(
        db,
        siteAPk,
        READ_RANGE,
        "required",
      );
      const ownerContextBag = observationRawIdentityBag(ownerContextRows);
      expect(observationIdentityBag(contextIdentityOnly)).toEqual(
        ownerContextBag,
      );
      expect(observationIdentityBag(contextIdentityAndVisitor)).toEqual(
        ownerContextBag,
      );
      expect(contextVisitorOnly).toHaveLength(ownerContextRows.length);
      expect(contextTitleOnly).toHaveLength(ownerContextRows.length);
      expect(Number(contextCountRows[0]?.activity_count)).toBe(
        ownerContextRows.length,
      );
      expect(
        contextIdentityAndVisitor.some(
          (row) =>
            row.entity_id === "a-read-cross-site-owner-event" ||
            row.entity_id === "z-read-without-owner",
        ),
      ).toBe(false);
      expect(
        visitorIdentityBag(contextVisitorOnly, "visitor_site_pk", "visitor_id"),
      ).toEqual(
        rawActivityVisitorRows(db, siteAPk, READ_RANGE, "required")
          .map(encodeIdentity)
          .sort(),
      );
    } finally {
      db.close();
    }
  });

  it("keeps authorized site keys distinct and records A/B/A D1 statement shape", async () => {
    const db = createMigratedDatabase();
    try {
      const { siteAPk, siteBPk } = seedIdentityFixture(db);
      const foreignPage = filterDocument(
        filterCondition("page.path", "eq", "/foreign"),
      );
      const twoSite = lowerFilter(foreignPage, "visitor", {
        domain: "candidate",
        siteIds: [SITE_A, SITE_B],
      });
      expect(twoSite.kind).toBe("supported");
      if (twoSite.kind !== "supported")
        throw new Error("Expected authorized two-site lowering.");
      const twoSiteRows = await createD1DatabaseClient(
        createSqliteD1Database(db),
      ).all(twoSite.query);
      expect(
        outputIdentitySet(
          twoSiteRows.results as Array<
            Readonly<Record<string, number | string>>
          >,
          "visitor",
        ),
      ).toEqual(
        new Set([
          ...legacyDocumentSet(
            db,
            siteAPk,
            "visitor",
            foreignPage.root,
            "candidate",
          ),
          ...legacyDocumentSet(
            db,
            siteBPk,
            "visitor",
            foreignPage.root,
            "candidate",
          ),
        ]),
      );
      expect(
        outputIdentitySet(
          twoSiteRows.results as Array<
            Readonly<Record<string, number | string>>
          >,
          "visitor",
        ),
      ).toEqual(new Set([encodeIdentity([siteBPk, "shared-visitor"])]));
      expect(() =>
        lowerFilter(foreignPage, "visitor", {
          domain: "candidate",
          siteIds: [SITE_A],
          storageSiteIds: [SITE_B],
        }),
      ).toThrow();

      const entry = filterDocument(
        filterCondition("page.path", "eq", "/entry"),
      );
      const planA = lowerFilter(entry, "visitor", {
        domain: "candidate",
        siteIds: [SITE_A],
      });
      const planB = lowerFilter(entry, "visitor", {
        domain: "candidate",
        siteIds: [SITE_B],
      });
      const planAAgain = lowerFilter(entry, "visitor", {
        domain: "candidate",
        siteIds: [SITE_A],
      });
      if (
        planA.kind !== "supported" ||
        planB.kind !== "supported" ||
        planAAgain.kind !== "supported"
      ) {
        throw new Error("Expected supported A/B/A visitor statements.");
      }
      expect(planA.query.sql).toBe(planAAgain.query.sql);
      expect(planA.query.bindings).not.toEqual(planB.query.bindings);
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const observations: DatabaseQueryObservation[] = [];
      const recorder = recordingObserver(observations);
      const client = createD1DatabaseClient(createSqliteD1Database(db, trace), {
        observer: recorder.observer,
      });
      const resultA = await client.all(planA.query);
      await recorder.waitForCount(1);
      const resultB = await client.all(planB.query);
      await recorder.waitForCount(2);
      const resultAAgain = await client.all(planAAgain.query);
      await recorder.waitForCount(3);
      expect(resultA.results).toEqual(resultAAgain.results);
      expect(resultA.results).not.toEqual(resultB.results);
      expect(trace.preparedSql).toEqual([
        planA.query.sql,
        planB.query.sql,
        planAAgain.query.sql,
      ]);
      expect(trace.bindings).toEqual([
        planA.query.bindings,
        planB.query.bindings,
        planAAgain.query.bindings,
      ]);
      const sqlBytes = new TextEncoder().encode(planA.query.sql).byteLength;
      expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(planA.query.bindings?.length ?? 0).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(observations).toHaveLength(3);
      expect(observations.map((event) => event.physicalPlanHash)).toEqual([
        observations[0]!.physicalPlanHash,
        observations[0]!.physicalPlanHash,
        observations[0]!.physicalPlanHash,
      ]);
      expect(observations[0]!.physicalPlanHash).toMatch(/^v8:/u);
      expect(observations[0]).toMatchObject({
        status: "success",
        sqlBytes,
        bindings: planA.query.bindings?.length ?? 0,
        rowsRead: null,
        rowsWritten: null,
        dbDurationMs: null,
      });
      // SQLite's adapter supplies no D1 row-cost metadata; only SQL shape and
      // local statement execution are measured here.
      const membershipValues = [
        "/entry",
        ...Array.from({ length: 1_199 }, (_, index) => `/unused-${index}`),
      ];
      const membershipBuilder = new LogicalPlanBuilder(
        planContext("session", [SITE_A]),
      );
      const membershipPages = membershipBuilder.source("page", {
        temporalDomain: "candidate",
        attributes: ["page.path"],
      });
      const membershipPredicate = membershipBuilder.in(
        membershipBuilder.slot(membershipPages, "attribute:page.path"),
        membershipValues.map((value) =>
          membershipBuilder.literal(value, {
            kind: "scalar",
            scalar: "string",
          }),
        ),
      );
      const matchingPages = membershipBuilder.filter(
        membershipPages,
        membershipPredicate,
      );
      membershipBuilder.output("large-membership", matchingPages, [
        { name: "entity", slot: "entity" },
      ]);
      const membershipPlan = membershipBuilder.finish();
      const membershipLowerer = new AnalyticsLogicalToDbLowerer(
        membershipPlan,
        { siteIds: [SITE_A], time: membershipPlan.context.time },
      );
      const membershipOutput = membershipPlan.outputs[0]!;
      const loweredMembership = membershipLowerer.lower(membershipOutput);
      const membershipEntitySlot = membershipOutput.fields[0]!.slot;
      const membershipEntityLayout =
        loweredMembership.slots.get(membershipEntitySlot);
      if (membershipEntityLayout?.kind !== "entity") {
        throw new Error("Expected the lowered Page entity key layout.");
      }
      const membershipQuery = compileD1Query(
        membershipLowerer.projectOutput(
          loweredMembership,
          membershipEntityLayout.keyColumns.map((_column, component) => ({
            name: `key_${component}`,
            slot: membershipEntitySlot,
            component,
          })),
        ),
      );
      expect(membershipQuery.sql).toContain("json_each(?)");
      expect(membershipQuery.bindings?.length ?? 0).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(
        new TextEncoder().encode(membershipQuery.sql).byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      const rawMembershipRows = db
        .prepare(
          "SELECT visit_id FROM visits WHERE site_pk = ? " +
            "AND status = 'complete' AND started_at >= ? AND started_at < ? " +
            "AND pathname IN (SELECT value FROM json_each(?)) ORDER BY visit_id",
        )
        .all(
          siteAPk,
          CANDIDATE_RANGE.startMs,
          CANDIDATE_RANGE.endExclusiveMs,
          JSON.stringify(membershipValues),
        );
      const actualMembershipRows = await createD1DatabaseClient(
        createSqliteD1Database(db),
      ).all(membershipQuery);
      expect(actualMembershipRows.results).toHaveLength(
        rawMembershipRows.length,
      );
      expect(rawMembershipRows).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
