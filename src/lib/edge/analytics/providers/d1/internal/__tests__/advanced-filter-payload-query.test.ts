import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  eq,
  filter,
  lowerLogicalPlan,
  param,
  project,
  scan,
  schema,
  union,
} from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type {
  EpochMs,
  SiteId,
  TeamId,
} from "@/lib/edge/analytics/contract/types";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  createSemanticPostObservationFilter,
  createSemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { queryAdvancedFilterPayloadNodes } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-payload-query";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  type AnalyticsDbRelation,
  buildEventPayloadPropertyRoleRows,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import {
  selectEventPayloadNodeFacts,
  selectEventPayloadNodeRows,
} from "@/lib/edge/analytics/providers/d1/internal/event-payload-node-selection";
import type { EventPayloadAdmissionPacket } from "@/lib/edge/analytics/providers/d1/internal/lowering/payload-count";
import { EVENT_PAYLOAD_NODE_FIELDS } from "@/lib/edge/analytics/providers/d1/internal/lowering/payload-layout";
import { expandCustomEventDataJson } from "@/lib/edge/ingest/custom-event-json";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const SITE_CHUNK_SIZE = 90;
const PAYLOAD_NODE_LIMIT = 50_000;
const SQLITE_PAYLOAD_NODE_LIMIT = PAYLOAD_NODE_LIMIT + 1;

const RANGE = { startMs: 100, endExclusiveMs: 200 } as const;
const payloadAdmissionMaximumByPlan = new WeakMap<object, number>();
const QUOTED_UNICODE_PATH = `$["雪'quoted"]`;
const NUL_PATH = "$.nul\u0000tail";

interface FixtureSite {
  readonly id: string;
  readonly pk: number;
}

interface PayloadRange {
  readonly startMs: number;
  readonly endExclusiveMs: number;
}

interface LegacyPayloadNode extends Record<string, unknown> {
  readonly event_id: string;
  readonly node_id: number;
  readonly parent_node_id: number | null;
  readonly key_name: string | null;
  readonly array_index: number | null;
  readonly value_type: number;
  readonly string_value: string | null;
  readonly number_value: number | null;
  readonly boolean_value: number | null;
}

interface QueryMetric {
  readonly tag?: string | null;
  readonly sqlBytes?: number | null;
  readonly bindings?: number | null;
  readonly physicalPlanHash?: string | null;
}

interface ObservedQuery<Row> {
  readonly rows: readonly Row[];
  readonly trace: SqliteD1Trace;
  readonly metrics: readonly QueryMetric[];
}

const databases = new Set<DatabaseSync>();
const baselinePaths = ["/bool", "/count", "/nested", "/nil", "/text"] as const;
const malformedPayloadScenarios = [
  "duplicate-child",
  "duplicate-root",
  "blob-string",
  "foreign-value-owner",
  "foreign-key-owner",
  "foreign-key-owner-key-only-path-mismatch",
  "foreign-path-owner",
  "missing-key-dictionary-row",
  "blob-key-dictionary-value",
  "blob-path-dictionary-value",
  "selected-owner-direct-child",
  "selected-other-role",
  "missing-root-selected-nonempty",
  "mixed-valid-invalid-roots",
  "invalid-boolean",
  "infinite-number",
] as const;
const malformedPayloadVariants: Array<Record<string, unknown>> = [];

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  // Match the production fixture behavior used by the activity differential:
  // migrations define foreign keys but the SQLite connection has them disabled.
  if (
    (database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
      .foreign_keys !== 0
  ) {
    database.exec("PRAGMA foreign_keys = OFF");
  }
  return database;
}

function addSite(database: DatabaseSync, id: string): FixtureSite {
  database.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return { id, pk: row.site_pk };
}

function addVisit(
  database: DatabaseSync,
  site: FixtureSite,
  visitId: string,
  startedAt: number,
): void {
  database
    .prepare(
      `INSERT INTO visits (visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname, site_pk)
       VALUES (?, ?, ?, ?, 'closed', ?, ?, '/', 'payload.fixture', ?)`,
    )
    .run(
      visitId,
      site.id,
      `visitor:${visitId}`,
      `session:${visitId}`,
      startedAt,
      startedAt,
      site.pk,
    );
}

function addEventName(
  database: DatabaseSync,
  site: FixtureSite,
  id: number,
): void {
  database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, 1, ?)",
    )
    .run(id, site.id, `event-name:${id}`, site.pk);
}

function addEvent(
  database: DatabaseSync,
  site: FixtureSite,
  input: {
    readonly id: string;
    readonly visitId: string;
    readonly eventNameId: number;
    readonly occurredAt: number;
    readonly sitePk?: number;
    readonly rawSiteId?: string;
  },
): number {
  database
    .prepare(
      "INSERT INTO custom_events (event_id, site_id, visit_id, event_name_id, occurred_at, received_at, node_count, value_count, site_pk) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)",
    )
    .run(
      input.id,
      input.rawSiteId ?? site.id,
      input.visitId,
      input.eventNameId,
      input.occurredAt,
      input.occurredAt,
      input.sitePk ?? site.pk,
    );
  return (
    database
      .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
      .get(input.id) as { readonly event_pk: number }
  ).event_pk;
}

function addPath(
  database: DatabaseSync,
  site: FixtureSite,
  path: string,
): number {
  const existing = database
    .prepare(
      "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
    )
    .get(site.pk, path) as { readonly id: number } | undefined;
  if (existing) return existing.id;
  database
    .prepare(
      "INSERT INTO custom_event_json_paths (site_id, path, last_seen_at, site_pk) VALUES (?, ?, 1, ?)",
    )
    .run(site.id, path, site.pk);
  return (
    database
      .prepare(
        "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
      )
      .get(site.pk, path) as { readonly id: number }
  ).id;
}

function addKey(
  database: DatabaseSync,
  site: FixtureSite,
  key: string,
): number {
  const existing = database
    .prepare(
      'SELECT id FROM custom_event_json_keys WHERE site_pk = ? AND "key" = ?',
    )
    .get(site.pk, key) as { readonly id: number } | undefined;
  if (existing) return existing.id;
  database
    .prepare(
      'INSERT INTO custom_event_json_keys (site_id, "key", last_seen_at, site_pk) VALUES (?, ?, 1, ?)',
    )
    .run(site.id, key, site.pk);
  return (
    database
      .prepare(
        'SELECT id FROM custom_event_json_keys WHERE site_pk = ? AND "key" = ?',
      )
      .get(site.pk, key) as { readonly id: number }
  ).id;
}

function addNode(
  database: DatabaseSync,
  input: {
    readonly eventPk: number;
    readonly nodeId: number;
    readonly parentNodeId: number | null;
    readonly pathId: number;
    readonly valueType: number;
    readonly depth: number;
    readonly keyId?: number | null;
    readonly arrayIndex?: number | null;
    readonly memberOrder?: number | null;
  },
): void {
  database
    .prepare(
      "INSERT INTO custom_event_json_nodes (event_pk, node_id, parent_node_id, key_id, path_id, value_type, member_order, array_index, depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.eventPk,
      input.nodeId,
      input.parentNodeId,
      input.keyId ?? null,
      input.pathId,
      input.valueType,
      input.memberOrder ?? null,
      input.arrayIndex ?? null,
      input.depth,
    );
}

function addValue(
  database: DatabaseSync,
  input: {
    readonly eventPk: number;
    readonly nodeId: number;
    readonly site: FixtureSite;
    readonly eventNameId: number;
    readonly pathId: number;
    readonly occurredAt: number;
    readonly valueType: number;
    readonly stringValue?: string | null;
    readonly numberValue?: number | null;
    readonly booleanValue?: number | null;
    readonly sitePk?: number;
  },
): void {
  database
    .prepare(
      "INSERT INTO custom_event_json_values (event_pk, node_id, site_id, event_name_id, path_id, occurred_at, value_type, string_value, number_value, boolean_value, site_pk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.eventPk,
      input.nodeId,
      input.site.id,
      input.eventNameId,
      input.pathId,
      input.occurredAt,
      input.valueType,
      input.stringValue ?? null,
      input.numberValue ?? null,
      input.booleanValue ?? null,
      input.sitePk ?? input.site.pk,
    );
}

function addStructuredEvent(
  database: DatabaseSync,
  input: {
    readonly site: FixtureSite;
    readonly id: string;
    readonly visitId: string;
    readonly eventNameId: number;
    readonly occurredAt: number;
    readonly foreignSite?: FixtureSite;
  },
): number {
  const eventPk = addEvent(database, input.site, input);
  const rootPath = addPath(database, input.site, "");
  const userPath = addPath(database, input.site, "$.user");
  const namePath = addPath(database, input.site, "$.user.name");
  const agePath = addPath(database, input.site, "$.user.age");
  const itemsPath = addPath(database, input.site, "$.items");
  const itemZeroPath = addPath(database, input.site, "$.items[0]");
  const itemTwoPath = addPath(database, input.site, "$.items[2]");
  const quotedPath = addPath(database, input.site, QUOTED_UNICODE_PATH);
  const nulPath = addPath(database, input.site, NUL_PATH);
  const missingValuePath = addPath(database, input.site, "$.missingValue");
  const keyRoot = null;
  const keyUser = addKey(database, input.site, "user");
  const keyName = addKey(database, input.site, "name");
  const keyAge = addKey(database, input.site, "age");
  const keyItems = addKey(database, input.site, "items");
  const keyQuoted = addKey(database, input.site, "雪'quoted");
  const keyNul = addKey(database, input.site, "nul\u0000tail");

  addNode(database, {
    eventPk,
    nodeId: 1,
    parentNodeId: null,
    pathId: rootPath,
    valueType: 4,
    depth: 0,
    keyId: keyRoot,
  });
  addNode(database, {
    eventPk,
    nodeId: 2,
    parentNodeId: 1,
    pathId: userPath,
    valueType: 4,
    depth: 1,
    keyId: keyUser,
    memberOrder: 0,
  });
  addNode(database, {
    eventPk,
    nodeId: 3,
    parentNodeId: 2,
    pathId: namePath,
    valueType: 1,
    depth: 2,
    keyId: keyName,
    memberOrder: 0,
  });
  addValue(database, {
    eventPk,
    nodeId: 3,
    site: input.site,
    eventNameId: input.eventNameId,
    pathId: namePath,
    occurredAt: input.occurredAt,
    valueType: 1,
    stringValue: "雪' OR \u0000 x",
  });
  addNode(database, {
    eventPk,
    nodeId: 4,
    parentNodeId: 2,
    pathId: agePath,
    valueType: 2,
    depth: 2,
    keyId: keyAge,
    memberOrder: 1,
  });
  addValue(database, {
    eventPk,
    nodeId: 4,
    site: input.site,
    eventNameId: input.eventNameId,
    pathId: agePath,
    occurredAt: input.occurredAt,
    valueType: 2,
    numberValue: 12.5,
  });
  addNode(database, {
    eventPk,
    nodeId: 5,
    parentNodeId: 1,
    pathId: itemsPath,
    valueType: 5,
    depth: 1,
    keyId: keyItems,
    memberOrder: 1,
  });
  addNode(database, {
    eventPk,
    nodeId: 6,
    parentNodeId: 5,
    pathId: itemZeroPath,
    valueType: 1,
    depth: 2,
    arrayIndex: 0,
    memberOrder: 0,
  });
  addValue(database, {
    eventPk,
    nodeId: 6,
    site: input.site,
    eventNameId: input.eventNameId,
    pathId: itemZeroPath,
    occurredAt: input.occurredAt,
    valueType: 1,
    stringValue: "first",
  });
  addNode(database, {
    eventPk,
    nodeId: 7,
    parentNodeId: 5,
    pathId: itemTwoPath,
    valueType: 0,
    depth: 2,
    arrayIndex: 2,
    memberOrder: 2,
  });
  addNode(database, {
    eventPk,
    nodeId: 8,
    parentNodeId: 1,
    pathId: quotedPath,
    valueType: 1,
    depth: 1,
    keyId: keyQuoted,
    memberOrder: 2,
  });
  addValue(database, {
    eventPk,
    nodeId: 8,
    site: input.site,
    eventNameId: input.eventNameId,
    pathId: quotedPath,
    occurredAt: input.occurredAt,
    valueType: 1,
    stringValue: "quoted path value",
  });
  addNode(database, {
    eventPk,
    nodeId: 9,
    parentNodeId: 1,
    pathId: nulPath,
    valueType: 3,
    depth: 1,
    keyId: keyNul,
    memberOrder: 3,
  });
  addValue(database, {
    eventPk,
    nodeId: 9,
    site: input.site,
    eventNameId: input.eventNameId,
    pathId: nulPath,
    occurredAt: input.occurredAt,
    valueType: 3,
    booleanValue: 1,
  });
  // Missing value records are represented by the actual left-join NULL row.
  addNode(database, {
    eventPk,
    nodeId: 10,
    parentNodeId: 1,
    pathId: missingValuePath,
    valueType: 2,
    depth: 1,
    keyId: 987_654,
    memberOrder: 4,
  });
  if (input.foreignSite) {
    const foreignPath = addPath(
      database,
      input.foreignSite,
      "$.foreignSitePath",
    );
    const foreignKey = addKey(database, input.foreignSite, "foreign-key");
    const localPathWithForeignKey = addPath(
      database,
      input.site,
      "$.foreignKey",
    );
    const orphanChildPath = addPath(
      database,
      input.site,
      "$.childOfMissingPath",
    );
    addNode(database, {
      eventPk,
      nodeId: 11,
      parentNodeId: 1,
      pathId: foreignPath,
      valueType: 1,
      depth: 1,
      keyId: foreignKey,
      memberOrder: 5,
    });
    addNode(database, {
      eventPk,
      nodeId: 12,
      parentNodeId: 1,
      pathId: localPathWithForeignKey,
      valueType: 1,
      depth: 1,
      keyId: foreignKey,
      memberOrder: 6,
    });
    addValue(database, {
      eventPk,
      nodeId: 12,
      site: input.foreignSite,
      eventNameId: input.eventNameId,
      pathId: localPathWithForeignKey,
      occurredAt: input.occurredAt,
      valueType: 1,
      stringValue: "foreign-site-value-is-still-joined",
      sitePk: input.foreignSite.pk,
    });
    // With foreign keys disabled, historical node rows can refer to missing
    // path/key/value records. The missing-path parent is in closure through a
    // valid child, then disappears at the final required same-site path join.
    addNode(database, {
      eventPk,
      nodeId: 13,
      parentNodeId: 1,
      pathId: 987_654,
      valueType: 4,
      depth: 1,
      memberOrder: 7,
    });
    addNode(database, {
      eventPk,
      nodeId: 14,
      parentNodeId: 13,
      pathId: orphanChildPath,
      valueType: 1,
      depth: 2,
      keyId: null,
      memberOrder: 0,
    });
    addValue(database, {
      eventPk,
      nodeId: 14,
      site: input.site,
      eventNameId: input.eventNameId,
      pathId: orphanChildPath,
      occurredAt: input.occurredAt,
      valueType: 1,
      stringValue: "child-of-missing-path",
    });
  }
  return eventPk;
}

function subjectFor(siteIds: readonly string[]): SemanticSubjectDomain {
  return createSemanticSubjectDomain({
    origin: "team",
    teamId: "wave27-payload-team" as TeamId,
    siteIds: siteIds.map((siteId) => siteId as SiteId),
  });
}

function frozenLegacyPayloadSql(
  siteCount: number,
  paths: readonly string[],
  wholePayload: boolean,
): string {
  const siteList = Array.from({ length: siteCount }, () => "?").join(", ");
  const selectedNodes =
    !wholePayload && paths.length > 0
      ? `WITH RECURSIVE selected_payload_nodes(event_pk, node_id, parent_node_id) AS (
  SELECT n.event_pk, n.node_id, n.parent_node_id
  FROM custom_event_json_nodes n
  INNER JOIN custom_event_json_paths p ON p.id = n.path_id
  INNER JOIN custom_events seed_event ON seed_event.event_pk = n.event_pk
  WHERE seed_event.site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${siteList}))
    AND seed_event.occurred_at >= ? AND seed_event.occurred_at < ?
    AND p.path IN (${paths.map(() => "?").join(", ")})
  UNION
  SELECT parent.event_pk, parent.node_id, parent.parent_node_id
  FROM custom_event_json_nodes parent
  INNER JOIN selected_payload_nodes child
    ON child.event_pk = parent.event_pk AND child.parent_node_id = parent.node_id
)`
      : "";
  const nodeSource = selectedNodes
    ? "(SELECT n.* FROM selected_payload_nodes selected INNER JOIN custom_event_json_nodes n ON n.event_pk = selected.event_pk AND n.node_id = selected.node_id) n"
    : "custom_event_json_nodes n";
  return `${selectedNodes}
SELECT
  ce.event_id,
  n.node_id,
  n.parent_node_id,
  k.key AS key_name,
  n.array_index,
  n.value_type,
  jv.string_value,
  jv.number_value,
  jv.boolean_value
FROM custom_events ce
INNER JOIN ${nodeSource} ON n.event_pk = ce.event_pk
INNER JOIN custom_event_json_paths p ON p.id = n.path_id AND p.site_pk = ce.site_pk
LEFT JOIN custom_event_json_keys k ON k.id = n.key_id AND k.site_pk = ce.site_pk
LEFT JOIN custom_event_json_values jv ON jv.event_pk = n.event_pk AND jv.node_id = n.node_id
INNER JOIN visits v ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
WHERE ce.site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${siteList}))
  AND ce.occurred_at >= ? AND ce.occurred_at < ?
ORDER BY ce.event_id, n.node_id
LIMIT ?`;
}

function legacyPayloadQuery(
  database: DatabaseSync,
  siteIds: readonly string[],
  range: PayloadRange,
  paths: readonly string[],
  wholePayload: boolean,
  limit = SQLITE_PAYLOAD_NODE_LIMIT,
): LegacyPayloadNode[] {
  const bindings: SQLInputValue[] = [
    ...(!wholePayload && paths.length > 0
      ? [...siteIds, range.startMs, range.endExclusiveMs, ...paths]
      : []),
    ...siteIds,
    range.startMs,
    range.endExclusiveMs,
    limit,
  ];
  return database
    .prepare(frozenLegacyPayloadSql(siteIds.length, paths, wholePayload))
    .all(...bindings) as LegacyPayloadNode[];
}

function legacyLoadPayloadNodes(
  database: DatabaseSync,
  siteIds: readonly string[],
  ranges: readonly PayloadRange[],
  paths: readonly string[],
  wholePayload: boolean,
): LegacyPayloadNode[] {
  const nodes: LegacyPayloadNode[] = [];
  for (let offset = 0; offset < siteIds.length; offset += SITE_CHUNK_SIZE) {
    const chunk = siteIds.slice(offset, offset + SITE_CHUNK_SIZE);
    for (const range of ranges) {
      nodes.push(
        ...legacyPayloadQuery(database, chunk, range, paths, wholePayload),
      );
    }
  }
  return nodes;
}

function addWriterJsonEvent(
  database: DatabaseSync,
  site: FixtureSite,
  eventPk: number,
  eventNameId: number,
  occurredAt: number,
  input: unknown,
): void {
  const expanded = expandCustomEventDataJson(JSON.stringify(input));
  if (!expanded.ok)
    throw new Error(`invalid_writer_json_fixture:${expanded.error}`);
  const pathIds = new Map(
    expanded.data.paths.map((path) => [path, addPath(database, site, path)]),
  );
  const keyIds = new Map(
    expanded.data.keys.map((key) => [key, addKey(database, site, key)]),
  );
  for (const node of expanded.data.nodes)
    addNode(database, {
      eventPk,
      nodeId: node.nodeId,
      parentNodeId: node.parentNodeId,
      pathId: pathIds.get(node.path)!,
      valueType: node.valueType,
      depth: node.depth,
      keyId: node.key === null ? null : keyIds.get(node.key)!,
      arrayIndex: node.arrayIndex,
      memberOrder: node.memberOrder,
    });
  for (const value of expanded.data.values)
    addValue(database, {
      eventPk,
      nodeId: value.nodeId,
      site,
      eventNameId,
      pathId: pathIds.get(value.path)!,
      occurredAt,
      valueType: value.valueType,
      stringValue: value.stringValue,
      numberValue: value.numberValue,
      booleanValue: value.booleanValue,
    });
}

const WRITER_PATHS = [
  "/nil",
  "/missing",
  "/text",
  "/count",
  "/active",
  "/nested",
  "/items",
  "/snow~1quoted",
] as const;

function buildPayloadLogicalPlan(
  siteId: string,
  paths: readonly string[] = WRITER_PATHS,
  _includeProperties = true,
  includePropertyEventPk = false,
  resourceBudgetMaximum?: number,
  _includeNodes = true,
  _includeEventKey = false,
  selection?: ReturnType<typeof createSemanticScopedSourceSelection>,
  includeInternalPk = false,
) {
  const range = {
    startMs: 100 as EpochMs,
    endExclusiveMs: 200 as EpochMs,
  } as const;
  const builder = new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [siteId as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate: range,
      read: { kind: "bounded", range },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 200 as never,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
  const events = builder.source("event", {
    temporalDomain: selection ? "candidate" : "read",
    attributes: [
      "event.report.localId",
      "event.report.ownerPresent",
      ...(includeInternalPk ? ["event.report.internalPk"] : []),
    ],
    ...(selection ? { selection } : {}),
  });
  const ownerPresent = builder.filter(
    events,
    builder.compare(
      "eq",
      builder.slot(events, "attribute:event.report.ownerPresent"),
      builder.literal(true, { kind: "scalar", scalar: "boolean" }),
    ),
  );
  const properties = builder.eventPayloadProperties(ownerPresent, paths);
  const propertyFields = [
    "present",
    "valueType",
    "stringValue",
    "numberValue",
    "booleanValue",
    "structureCompatible",
    "valueCompatible",
  ] as const;
  builder.output("payload-properties", properties, [
    ...(includePropertyEventPk
      ? [{ name: "eventId", slot: "attribute:event.report.localId" }]
      : []),
    ...(includeInternalPk
      ? [{ name: "eventPk", slot: "attribute:event.report.internalPk" }]
      : []),
    ...[...paths]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap((_, propertyIndex) =>
        propertyFields.map((field) => ({
          name: `property-${propertyIndex}-${field}`,
          slot: `payloadProperty:${propertyIndex}:${field}`,
        })),
      ),
  ]);
  const plan = builder.finish();
  if (resourceBudgetMaximum !== undefined)
    payloadAdmissionMaximumByPlan.set(plan, resourceBudgetMaximum);
  return plan;
}

function compileLogicalPayloadOutput(
  siteId: string,
  plan: ReturnType<typeof buildPayloadLogicalPlan>,
  outputId: string,
) {
  const output = plan.outputs.find(({ id }) => id === "payload-properties");
  if (!output) throw new Error("payload_output_missing:payload-properties");
  const properties = plan.nodes.find(
    (node) => node.kind === "event-payload-properties",
  );
  if (properties?.kind !== "event-payload-properties")
    throw new Error("payload_properties_node_missing");
  const configuredMaximum = payloadAdmissionMaximumByPlan.get(plan);
  const requiresAdmission =
    outputId === "payload-nodes" ||
    outputId === "payload-budget" ||
    configuredMaximum !== undefined;
  const maximumNodes = configuredMaximum ?? PAYLOAD_NODE_LIMIT;
  const lowerer = new AnalyticsLogicalToDbLowerer(
    plan,
    {
      siteId,
      time: plan.context.time,
    },
    requiresAdmission
      ? {
          eventPayloadAdmissionPolicy: {
            propertiesRelation: properties.id,
            maximumNodes,
          },
        }
      : {},
  );
  const [lowered] = lowerer.lowerMany([output]);
  if (!lowered) throw new Error("payload_provider_admission_packet_missing");
  const packet = requiresAdmission
    ? lowerer.eventPayloadAdmissionPacket(properties.id)
    : undefined;
  if (requiresAdmission && !packet)
    throw new Error("payload_provider_admission_packet_missing");
  let relation: AnalyticsDbRelation;
  if (outputId === "payload-nodes") relation = packet!.selectedNodes;
  else if (outputId === "payload-budget") relation = packet!.counter;
  else if (outputId === "payload-properties")
    relation = lowerer.projectOutput(
      lowered,
      output.fields.map(({ name, slot }) => ({ name, slot })),
    );
  else throw new Error(`payload_output_missing:${outputId}`);
  return compileD1Query(lowerLogicalPlan(relation));
}

function payloadAdmissionPacketForPlan(
  siteId: string,
  plan: ReturnType<typeof buildPayloadLogicalPlan>,
  maximumNodes = payloadAdmissionMaximumByPlan.get(plan) ?? PAYLOAD_NODE_LIMIT,
): EventPayloadAdmissionPacket {
  const output = plan.outputs.find(({ id }) => id === "payload-properties");
  const properties = plan.nodes.find(
    (node) => node.kind === "event-payload-properties",
  );
  if (!output || properties?.kind !== "event-payload-properties")
    throw new Error("payload_admission_logical_properties_missing");
  const lowerer = new AnalyticsLogicalToDbLowerer(
    plan,
    { siteId, time: plan.context.time },
    {
      eventPayloadAdmissionPolicy: {
        propertiesRelation: properties.id,
        maximumNodes,
      },
    },
  );
  lowerer.lowerMany([output]);
  const packet = lowerer.eventPayloadAdmissionPacket(properties.id);
  if (!packet) throw new Error("payload_admission_packet_missing");
  return packet;
}

async function observeLogicalPayloadOutput(
  database: DatabaseSync,
  siteId: string,
  plan: ReturnType<typeof buildPayloadLogicalPlan>,
  outputId: string,
): Promise<ObservedQuery<Record<string, unknown>>> {
  const query = compileLogicalPayloadOutput(siteId, plan, outputId);
  return observeQuery(database, async (env) => {
    const result = await createD1DatabaseClient(env.DB).all(query);
    return result.results as Record<string, unknown>[];
  });
}

async function readLogicalPayloadOutput(
  database: DatabaseSync,
  siteId: string,
  plan: ReturnType<typeof buildPayloadLogicalPlan>,
  outputId: string,
): Promise<Record<string, unknown>[]> {
  const query = compileLogicalPayloadOutput(siteId, plan, outputId);
  const result = await createD1DatabaseClient(
    createSqliteD1Database(database),
  ).all(query);
  return result.results as Record<string, unknown>[];
}

function sqliteEnv(database: DatabaseSync, trace?: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, trace) } as unknown as Env;
}

async function observeQuery<Row>(
  database: DatabaseSync,
  invoke: (env: Env) => Promise<readonly Row[]>,
): Promise<ObservedQuery<Row>> {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  const env = instrumentEnv(sqliteEnv(database, trace), logger);
  const rows = await runWithInvocationLogger(logger, () =>
    runWithD1Operation("advanced_filter.payload", () => invoke(env)),
  );
  const invocation = await logger.emitWhenComplete();
  const metrics = invocation.logs
    .filter((entry) => entry.message.startsWith("db.query.v1.all.success"))
    .map((entry) => entry.data as QueryMetric);
  return { rows, trace, metrics };
}

async function actualPayloadQuery(
  env: Env,
  subject: SemanticSubjectDomain,
  siteIds: readonly string[],
  range: PayloadRange,
  paths: readonly string[],
  wholePayload: boolean,
): Promise<readonly LegacyPayloadNode[]> {
  return queryAdvancedFilterPayloadNodes({
    env,
    subject,
    siteIds,
    range,
    paths,
    wholePayload,
  }) as Promise<readonly LegacyPayloadNode[]>;
}

function legacyPropertyOracle(
  database: DatabaseSync,
  eventPk: number,
  eventId: string,
  paths: readonly string[],
  selectedNodes: readonly LegacyPayloadNode[],
): Record<string, unknown> {
  const event = database
    .prepare(
      "SELECT event_pk, site_id, site_pk, event_name_id, occurred_at FROM custom_events WHERE event_pk = ?",
    )
    .get(eventPk) as {
    readonly event_pk: number;
    readonly site_id: string;
    readonly site_pk: number;
    readonly event_name_id: number;
    readonly occurred_at: number;
  };
  const rawNodes = database
    .prepare(
      `SELECT n.event_pk, n.node_id, n.parent_node_id, n.value_type AS node_type,
              n.array_index, n.key_id, k.key AS key_name,
              k.site_id AS key_site_id, k.site_pk AS key_site_pk,
              n.path_id, p.path, p.site_id AS path_site_id, p.site_pk AS path_site_pk
       FROM custom_event_json_nodes n
       LEFT JOIN custom_event_json_keys k ON k.id = n.key_id
       LEFT JOIN custom_event_json_paths p ON p.id = n.path_id
       WHERE n.event_pk = ?`,
    )
    .all(eventPk) as Array<Record<string, unknown>>;
  const rawValues = database
    .prepare(
      `SELECT event_pk, node_id, value_type, site_id, site_pk, event_name_id,
              path_id, occurred_at, string_value, number_value, boolean_value,
              typeof(string_value) AS string_storage,
              typeof(number_value) AS number_storage,
              typeof(boolean_value) AS boolean_storage
       FROM custom_event_json_values WHERE event_pk = ?`,
    )
    .all(eventPk) as Array<Record<string, unknown>>;
  const valueByNode = new Map(
    rawValues.map((value) => [Number(value.node_id), value]),
  );
  const roots = rawNodes.filter((node) => node.parent_node_id === null);
  const validRoot = (node: Record<string, unknown>) =>
    node.node_type === 4 &&
    node.path === "/" &&
    node.path_site_id === event.site_id &&
    node.path_site_pk === event.site_pk &&
    node.key_id === null &&
    node.array_index === null;
  const rootIds = new Set(roots.map((node) => Number(node.node_id)));
  const rootValidById = new Map(
    roots.map((node) => [Number(node.node_id), validRoot(node)]),
  );
  const selectedOccurrences = selectedNodes
    .filter((node) => node.event_id === eventId)
    .map((legacyRow) => {
      const node = rawNodes.find(
        (candidate) => Number(candidate.node_id) === Number(legacyRow.node_id),
      );
      const ownerQualifiedPath =
        node?.path_site_id === event.site_id &&
        node.path_site_pk === event.site_pk
          ? node.path
          : null;
      return {
        nodeId: Number(legacyRow.node_id),
        keyName: legacyRow.key_name,
        path: ownerQualifiedPath,
      };
    });
  const candidateRows = rawNodes
    .filter(
      (node) =>
        node.parent_node_id !== null &&
        rootIds.has(Number(node.parent_node_id)),
    )
    .map((node) => ({
      node,
      rootValid: rootValidById.get(Number(node.parent_node_id)) ?? false,
    }));
  const rootCount = roots.length;
  const rootValidCount = roots.filter(validRoot).length;
  const rootOkay = rootCount === 1 && rootValidCount === 1;
  const selectedNodeCount = selectedOccurrences.length;
  const emptyTree = rootCount === 0 && selectedNodeCount === 0;
  const result: Record<string, unknown> = { eventPk };
  const sortedPaths = [...paths].sort();
  sortedPaths.forEach((path, propertyIndex) => {
    const key = path
      .split("/")
      .at(-1)!
      .replace(/~1/gu, "/")
      .replace(/~0/gu, "~");
    const selectedMatches = selectedOccurrences.filter(
      (legacyRow) => legacyRow.keyName === key || legacyRow.path === path,
    );
    const selectedCount = selectedNodeCount === 0 ? 0 : selectedMatches.length;
    const selectedId =
      selectedNodeCount === 0
        ? null
        : selectedMatches.reduce<number | null>(
            (min, row) =>
              min === null ? row.nodeId : Math.min(min, row.nodeId),
            null,
          );
    const relevant = candidateRows.filter(
      ({ node, rootValid }) =>
        rootValid && (node.key_name === key || node.path === path),
    );
    const candidateCount =
      rootOkay && relevant.length > 0 ? relevant.length : 0;
    const candidateValid = relevant.filter(
      ({ node }) =>
        node.key_name === key &&
        node.path === path &&
        node.key_site_id === event.site_id &&
        node.key_site_pk === event.site_pk &&
        node.path_site_id === event.site_id &&
        node.path_site_pk === event.site_pk &&
        node.array_index === null &&
        typeof node.node_type === "number" &&
        node.node_type >= 0 &&
        node.node_type <= 5,
    );
    const candidateValidCount = rootOkay ? candidateValid.length : 0;
    const candidateId =
      candidateCount === 0
        ? null
        : relevant.reduce<number | null>(
            (min, { node }) =>
              min === null
                ? Number(node.node_id)
                : Math.min(min, Number(node.node_id)),
            null,
          );
    const candidateType =
      candidateCount === 0
        ? null
        : relevant.reduce<number | null>(
            (min, { node }) =>
              min === null
                ? Number(node.node_type)
                : Math.min(min, Number(node.node_type)),
            null,
          );
    const valueRows = relevant.flatMap(({ node }) => {
      const value = valueByNode.get(Number(node.node_id));
      return value ? [{ node, value }] : [];
    });
    const valueCount = rootOkay ? valueRows.length : 0;
    const validValue = (
      node: Record<string, unknown>,
      value: Record<string, unknown>,
    ) => {
      const rawShapeValid =
        (value.value_type === 0 &&
          value.string_storage === "null" &&
          value.number_storage === "null" &&
          value.boolean_storage === "null") ||
        (value.value_type === 1 &&
          value.string_storage === "text" &&
          value.number_storage === "null" &&
          value.boolean_storage === "null") ||
        (value.value_type === 2 &&
          ["integer", "real"].includes(String(value.number_storage)) &&
          Number.isFinite(Number(value.number_value)) &&
          value.string_storage === "null" &&
          value.boolean_storage === "null") ||
        (value.value_type === 3 &&
          value.boolean_storage === "integer" &&
          [0, 1].includes(Number(value.boolean_value)) &&
          value.string_storage === "null" &&
          value.number_storage === "null");
      return (
        value.value_type === node.node_type &&
        value.site_id === event.site_id &&
        value.site_pk === event.site_pk &&
        value.event_name_id === event.event_name_id &&
        value.path_id === node.path_id &&
        value.occurred_at === event.occurred_at &&
        rawShapeValid
      );
    };
    const validValueRows = valueRows.filter(
      ({ node, value }) =>
        candidateValid.some(
          (candidate) => candidate.node.node_id === node.node_id,
        ) && validValue(node, value),
    );
    const valueValidCount = rootOkay ? validValueRows.length : 0;
    const safeString =
      validValueRows.length === 1
        ? validValueRows[0]!.value.string_value
        : null;
    const safeNumber =
      validValueRows.length === 1
        ? validValueRows[0]!.value.number_value
        : null;
    const safeBoolean =
      validValueRows.length === 1
        ? validValueRows[0]!.value.boolean_value
        : null;
    const selectedCandidate =
      candidateCount === 1 &&
      candidateValidCount === 1 &&
      selectedCount === 1 &&
      candidateId !== null &&
      candidateId === selectedId;
    const structureOkay =
      emptyTree || (rootOkay && (candidateCount === 0 || selectedCandidate));
    const containerCompatible =
      (candidateType === 4 || candidateType === 5) && valueCount === 0;
    const scalarCompatible =
      candidateType !== null &&
      [0, 1, 2, 3].includes(candidateType) &&
      valueCount === 1 &&
      valueValidCount === 1;
    const valueOkay =
      emptyTree ||
      (structureOkay &&
        (candidateCount === 0 ||
          (selectedCandidate && (containerCompatible || scalarCompatible))));
    const present = structureOkay && candidateCount === 1;
    const safeValue = present && valueOkay;
    const prefix = `property-${propertyIndex}-`;
    result[prefix + "present"] = Number(present);
    result[prefix + "valueType"] = present ? candidateType : null;
    result[prefix + "stringValue"] = safeValue ? safeString : null;
    result[prefix + "numberValue"] = safeValue ? safeNumber : null;
    result[prefix + "booleanValue"] = safeValue ? safeBoolean : null;
    result[prefix + "structureCompatible"] = Number(structureOkay);
    result[prefix + "valueCompatible"] = Number(valueOkay);
  });
  return result;
}
async function actualLoadPayloadNodes(
  env: Env,
  subject: SemanticSubjectDomain,
  siteIds: readonly string[],
  ranges: readonly PayloadRange[],
  paths: readonly string[],
  wholePayload: boolean,
): Promise<LegacyPayloadNode[]> {
  const nodes: LegacyPayloadNode[] = [];
  for (let offset = 0; offset < siteIds.length; offset += SITE_CHUNK_SIZE) {
    const chunk = siteIds.slice(offset, offset + SITE_CHUNK_SIZE);
    for (const range of ranges) {
      nodes.push(
        ...(await actualPayloadQuery(
          env,
          subject,
          chunk,
          range,
          paths,
          wholePayload,
        )),
      );
    }
  }
  return nodes;
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

afterAll(() => {
  const evidenceDirectory = process.env.WAVE96W_ARTIFACT_DIR;
  if (!evidenceDirectory) return;
  mkdirSync(evidenceDirectory, { recursive: true });
  const evidencePath = join(evidenceDirectory, "malformed-payload-oracle.json");
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        phase: "Wave96W malformed payload property full-field differential",
        d1Executed: false,
        baselinePropertyPaths: baselinePaths,
        comparedFieldCount: malformedPayloadVariants.reduce(
          (total, variant) => total + Number(variant.comparedFieldCount ?? 0),
          0,
        ),
        scenarios: malformedPayloadVariants,
        failedScenarios: malformedPayloadVariants
          .filter(({ equal }) => equal !== true)
          .map(({ scenario }) => scenario),
        coverageReferences: [
          "advanced filter payload node query differential: cycle and depth-boundary cases",
          "advanced filter payload node query differential: empty and orphan tree cases",
        ],
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  process.stdout.write(`malformed_property_oracle_evidence=${evidencePath}\n`);
});

describe("advanced filter payload node query differential", () => {
  it("keeps fact-carrying recursion bag-equivalent to the legacy keyed closure", () => {
    const database = createFixture();
    const site = addSite(database, "payload-node-facts-site");
    const foreignSite = addSite(database, "payload-node-facts-foreign-site");
    addVisit(database, site, "payload-node-facts-a-visit", 120);
    addVisit(database, site, "payload-node-facts-b-visit", 120);
    addVisit(database, site, "payload-node-facts-unselected-visit", 120);
    addEventName(database, site, 60_001);
    const eventA = addEvent(database, site, {
      id: "payload-node-facts-a",
      visitId: "payload-node-facts-a-visit",
      eventNameId: 60_001,
      occurredAt: 150,
    });
    const eventB = addEvent(database, site, {
      id: "payload-node-facts-b",
      visitId: "payload-node-facts-b-visit",
      eventNameId: 60_001,
      occurredAt: 150,
    });
    const unselectedEvent = addEvent(database, site, {
      id: "payload-node-facts-unselected",
      visitId: "payload-node-facts-unselected-visit",
      eventNameId: 60_001,
      occurredAt: 150,
    });

    const rootPath = addPath(database, site, "/");
    const branchPath = addPath(database, site, "/branch");
    const leafPath = addPath(database, site, "/branch/leaf");
    const siblingPath = addPath(database, site, "/branch/sibling");
    const selfCyclePath = addPath(database, site, "/cycle/self");
    const cycleAPath = addPath(database, site, "/cycle/a");
    const cycleBPath = addPath(database, site, "/cycle/b");
    const orphanPath = addPath(database, site, "/orphan/leaf");
    const unusualPath = addPath(database, site, "/branch/unusual");
    const missingChildPath = addPath(database, site, "/branch/missing-child");
    const foreignPath = addPath(database, foreignSite, "/foreign");
    const branchKey = addKey(database, site, "branch");
    const leafKey = addKey(database, site, "leaf");
    const siblingKey = addKey(database, site, "sibling");

    addNode(database, {
      eventPk: eventA,
      nodeId: 1,
      parentNodeId: null,
      pathId: rootPath,
      valueType: 4,
      depth: 0,
    });
    addNode(database, {
      eventPk: eventA,
      nodeId: 2,
      parentNodeId: 1,
      pathId: branchPath,
      valueType: 4,
      depth: 1,
      keyId: branchKey,
    });
    addNode(database, {
      eventPk: eventA,
      nodeId: 3,
      parentNodeId: 2,
      pathId: leafPath,
      valueType: 1,
      depth: 2,
      keyId: leafKey,
    });
    addNode(database, {
      eventPk: eventA,
      nodeId: 4,
      parentNodeId: 2,
      pathId: siblingPath,
      valueType: 1,
      depth: 2,
      keyId: siblingKey,
    });
    addNode(database, {
      eventPk: eventA,
      nodeId: 5,
      parentNodeId: 5,
      pathId: selfCyclePath,
      valueType: 4,
      depth: 1,
    });
    addNode(database, {
      eventPk: eventA,
      nodeId: 6,
      parentNodeId: 7,
      pathId: cycleAPath,
      valueType: 4,
      depth: 1,
    });
    addNode(database, {
      eventPk: eventA,
      nodeId: 7,
      parentNodeId: 6,
      pathId: cycleBPath,
      valueType: 4,
      depth: 2,
    });
    addNode(database, {
      eventPk: eventA,
      nodeId: 8,
      parentNodeId: 999_999,
      pathId: orphanPath,
      valueType: 1,
      depth: 1,
    });
    addNode(database, {
      eventPk: eventA,
      nodeId: 9,
      parentNodeId: 2,
      pathId: foreignPath,
      valueType: 1,
      depth: 2,
    });
    database
      .prepare(
        "INSERT INTO custom_event_json_nodes (event_pk, node_id, parent_node_id, key_id, path_id, value_type, array_index, depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        eventA,
        10,
        2,
        "not-an-integer-key",
        unusualPath,
        1,
        "not-an-integer-index",
        2,
      );
    addNode(database, {
      eventPk: eventA,
      nodeId: 11,
      parentNodeId: 2,
      pathId: 999_999,
      valueType: 4,
      depth: 2,
    });
    addNode(database, {
      eventPk: eventA,
      nodeId: 12,
      parentNodeId: 11,
      pathId: missingChildPath,
      valueType: 1,
      depth: 3,
    });
    addNode(database, {
      eventPk: eventB,
      nodeId: 2,
      parentNodeId: null,
      pathId: rootPath,
      valueType: 4,
      depth: 0,
    });
    addNode(database, {
      eventPk: eventB,
      nodeId: 3,
      parentNodeId: 2,
      pathId: leafPath,
      valueType: 1,
      depth: 1,
      keyId: leafKey,
    });
    addNode(database, {
      eventPk: unselectedEvent,
      nodeId: 2,
      parentNodeId: null,
      pathId: rootPath,
      valueType: 4,
      depth: 0,
    });
    addNode(database, {
      eventPk: unselectedEvent,
      nodeId: 3,
      parentNodeId: 2,
      pathId: leafPath,
      valueType: 1,
      depth: 1,
      keyId: leafKey,
    });

    const events = scan(schema.custom_events);
    const eventAOnly = filter(
      events,
      eq(events.columns.event_pk, param(eventA)),
    );
    const eventBOnly = filter(
      events,
      eq(events.columns.event_pk, param(eventB)),
    );
    const eventAKeys = project(eventAOnly, {
      event_pk: eventAOnly.columns.event_pk,
    });
    const eventBKeys = project(eventBOnly, {
      event_pk: eventBOnly.columns.event_pk,
    });
    const selectedEventKeys = union(
      union(eventAKeys, eventAKeys, true),
      eventBKeys,
      true,
    );
    const requestedPaths = [
      "/branch/leaf",
      "/branch/sibling",
      "/cycle/self",
      "/cycle/a",
      "/orphan/leaf",
      "/foreign",
      "/branch/unusual",
      "/branch/missing-child",
      "/branch/leaf",
    ];
    const legacyRowsRelation = selectEventPayloadNodeRows(
      selectedEventKeys,
      requestedPaths,
    );
    const factRowsRelation = selectEventPayloadNodeFacts(
      selectedEventKeys,
      requestedPaths,
    );
    expect(factRowsRelation.node.kind).toBe("recursive-closure");
    expect(factRowsRelation.fields.map(({ name }) => name)).toEqual([
      "event_pk",
      "node_id",
      "parent_node_id",
      "key_id",
      "path_id",
      "value_type",
      "array_index",
    ]);

    const legacyQuery = compileD1Query(lowerLogicalPlan(legacyRowsRelation));
    const factQuery = compileD1Query(lowerLogicalPlan(factRowsRelation));
    const legacyRows = database
      .prepare(legacyQuery.sql)
      .all(...((legacyQuery.bindings ?? []) as SQLInputValue[])) as Array<
      Record<string, unknown>
    >;
    const factRows = database
      .prepare(factQuery.sql)
      .all(...((factQuery.bindings ?? []) as SQLInputValue[])) as Array<
      Record<string, unknown>
    >;
    const fields = [
      "event_pk",
      "node_id",
      "parent_node_id",
      "key_id",
      "path_id",
      "value_type",
      "array_index",
    ] as const;
    const asBag = (rows: readonly Record<string, unknown>[]) =>
      rows
        .map((row) => fields.map((field) => row[field]))
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        );

    const legacyEmptyRelation = selectEventPayloadNodeRows(
      selectedEventKeys,
      [],
    );
    const factEmptyRelation = selectEventPayloadNodeFacts(
      selectedEventKeys,
      [],
    );
    const legacyWholeRelation = selectEventPayloadNodeRows(
      selectedEventKeys,
      requestedPaths,
      true,
    );
    const factWholeRelation = selectEventPayloadNodeFacts(
      selectedEventKeys,
      requestedPaths,
      true,
    );
    const legacyEmptyQuery = compileD1Query(
      lowerLogicalPlan(legacyEmptyRelation),
    );
    const factEmptyQuery = compileD1Query(lowerLogicalPlan(factEmptyRelation));
    const legacyWholeQuery = compileD1Query(
      lowerLogicalPlan(legacyWholeRelation),
    );
    const factWholeQuery = compileD1Query(lowerLogicalPlan(factWholeRelation));
    expect(factEmptyRelation.node.kind).toBe("project");
    expect(factWholeRelation.node.kind).toBe("project");
    expect(factEmptyQuery.sql).not.toMatch(/WITH\s+RECURSIVE/iu);
    expect(legacyWholeQuery.sql).toBe(legacyEmptyQuery.sql);
    expect(factWholeQuery.sql).toBe(factEmptyQuery.sql);
    const legacyAllRows = database
      .prepare(legacyEmptyQuery.sql)
      .all(...((legacyEmptyQuery.bindings ?? []) as SQLInputValue[])) as Array<
      Record<string, unknown>
    >;
    const factAllRows = database
      .prepare(factEmptyQuery.sql)
      .all(...((factEmptyQuery.bindings ?? []) as SQLInputValue[])) as Array<
      Record<string, unknown>
    >;

    expect(asBag(factRows)).toEqual(asBag(legacyRows));
    expect(asBag(factAllRows)).toEqual(asBag(legacyAllRows));
    expect(factAllRows).toHaveLength(16);
    expect(factRows).toHaveLength(14);
    expect(
      new Set(factRows.map((row) => `${row.event_pk}:${row.node_id}`)).size,
    ).toBe(factRows.length);
    expect(factRows).toContainEqual({
      event_pk: eventA,
      node_id: 10,
      parent_node_id: 2,
      key_id: "not-an-integer-key",
      path_id: unusualPath,
      value_type: 1,
      array_index: "not-an-integer-index",
    });
    expect(factRows).toContainEqual({
      event_pk: eventA,
      node_id: 11,
      parent_node_id: 2,
      key_id: null,
      path_id: 999_999,
      value_type: 4,
      array_index: null,
    });
    expect(
      factRows.some((row) => row.event_pk === eventA && row.node_id === 9),
    ).toBe(true);
    expect(
      factRows.some((row) => row.event_pk === eventA && row.node_id === 5),
    ).toBe(true);
    expect(
      factRows.some((row) => row.event_pk === eventA && row.node_id === 6),
    ).toBe(true);
    expect(
      factRows.some((row) => row.event_pk === eventA && row.node_id === 7),
    ).toBe(true);
    expect(
      factRows.some((row) => row.event_pk === eventB && row.node_id === 3),
    ).toBe(true);
    expect(
      factRows.some(
        (row) => row.event_pk === unselectedEvent && row.node_id === 3,
      ),
    ).toBe(false);
  });

  it.each(malformedPayloadScenarios)(
    "matches every malformed property output field against the legacy reader oracle: %s",
    async (scenario) => {
      const paths =
        scenario === "foreign-key-owner-key-only-path-mismatch"
          ? (["/other", "/text"] as const)
          : baselinePaths;
      const database = createFixture();
      const site = addSite(database, `payload-full-field-oracle-${scenario}`);
      const foreignSite = addSite(
        database,
        `payload-full-field-oracle-foreign-${scenario}`,
      );
      addVisit(database, site, `payload-full-field-owner-${scenario}`, 120);
      const eventNameId = 50_080;
      addEventName(database, site, eventNameId);
      const eventId = `payload-full-field-event-${scenario}`;
      const eventPk = addEvent(database, site, {
        id: eventId,
        visitId: `payload-full-field-owner-${scenario}`,
        eventNameId,
        occurredAt: 150,
      });
      addWriterJsonEvent(database, site, eventPk, eventNameId, 150, {
        bool: true,
        count: 42,
        nested: { child: "not-selected" },
        nil: null,
        text: "writer-text",
      });
      const nodeFor = (path: string) =>
        database
          .prepare(
            `SELECT n.node_id, n.parent_node_id, n.key_id, n.path_id,
                  n.value_type, n.depth, n.member_order
           FROM custom_event_json_nodes n
           JOIN custom_event_json_paths p ON p.id = n.path_id
           WHERE n.event_pk = ? AND p.path = ?`,
          )
          .get(eventPk, path) as {
          readonly node_id: number;
          readonly parent_node_id: number | null;
          readonly key_id: number | null;
          readonly path_id: number;
          readonly value_type: number;
          readonly depth: number;
          readonly member_order: number | null;
        };
      if (scenario === "duplicate-child") {
        const target = nodeFor("/text");
        const nextNodeId = (
          database
            .prepare(
              "SELECT COALESCE(MAX(node_id), 0) + 1 AS next_id FROM custom_event_json_nodes WHERE event_pk = ?",
            )
            .get(eventPk) as { readonly next_id: number }
        ).next_id;
        addNode(database, {
          eventPk,
          nodeId: nextNodeId,
          parentNodeId: target.parent_node_id,
          pathId: target.path_id,
          valueType: target.value_type,
          depth: target.depth,
          keyId: target.key_id,
          memberOrder: target.member_order,
        });
        addValue(database, {
          eventPk,
          nodeId: nextNodeId,
          site,
          eventNameId,
          pathId: target.path_id,
          occurredAt: 150,
          valueType: target.value_type,
          stringValue: "writer-text",
        });
      } else if (scenario === "duplicate-root") {
        const root = nodeFor("/");
        const nextNodeId = (
          database
            .prepare(
              "SELECT COALESCE(MAX(node_id), 0) + 1 AS next_id FROM custom_event_json_nodes WHERE event_pk = ?",
            )
            .get(eventPk) as { readonly next_id: number }
        ).next_id;
        addNode(database, {
          eventPk,
          nodeId: nextNodeId,
          parentNodeId: null,
          pathId: root.path_id,
          valueType: 4,
          depth: 0,
        });
      } else if (scenario === "blob-string") {
        database
          .prepare(
            "UPDATE custom_event_json_values SET string_value = CAST(X'FF' AS BLOB) WHERE event_pk = ? AND node_id = ?",
          )
          .run(eventPk, nodeFor("/text").node_id);
      } else if (scenario === "foreign-value-owner") {
        database
          .prepare(
            "UPDATE custom_event_json_values SET site_pk = ? WHERE event_pk = ? AND node_id = ?",
          )
          .run(foreignSite.pk, eventPk, nodeFor("/text").node_id);
      } else if (scenario === "foreign-key-owner") {
        database
          .prepare("UPDATE custom_event_json_keys SET site_pk = ? WHERE id = ?")
          .run(foreignSite.pk, nodeFor("/text").key_id);
      } else if (scenario === "foreign-key-owner-key-only-path-mismatch") {
        const target = nodeFor("/text");
        const otherPathId = addPath(database, site, "/other");
        database
          .prepare(
            "UPDATE custom_event_json_nodes SET path_id = ? WHERE event_pk = ? AND node_id = ?",
          )
          .run(otherPathId, eventPk, target.node_id);
        database
          .prepare(
            "UPDATE custom_event_json_values SET path_id = ? WHERE event_pk = ? AND node_id = ?",
          )
          .run(otherPathId, eventPk, target.node_id);
        database
          .prepare("UPDATE custom_event_json_keys SET site_pk = ? WHERE id = ?")
          .run(foreignSite.pk, target.key_id);
      } else if (scenario === "foreign-path-owner") {
        database
          .prepare(
            "UPDATE custom_event_json_paths SET site_pk = ? WHERE id = ?",
          )
          .run(foreignSite.pk, nodeFor("/text").path_id);
      } else if (scenario === "missing-key-dictionary-row") {
        database
          .prepare(
            "UPDATE custom_event_json_nodes SET key_id = ? WHERE event_pk = ? AND node_id = ?",
          )
          .run(999_999, eventPk, nodeFor("/text").node_id);
      } else if (scenario === "blob-key-dictionary-value") {
        database
          .prepare(
            "UPDATE custom_event_json_keys SET key = CAST(X'FF' AS BLOB) WHERE id = ?",
          )
          .run(nodeFor("/text").key_id);
      } else if (scenario === "blob-path-dictionary-value") {
        database
          .prepare(
            "UPDATE custom_event_json_paths SET path = CAST(X'2F74657874' AS BLOB) WHERE id = ?",
          )
          .run(nodeFor("/text").path_id);
      } else if (scenario === "selected-owner-direct-child") {
        // Keep writer rows unchanged to exercise a selected owned role-1 node.
      } else if (scenario === "selected-other-role") {
        database
          .prepare(
            "UPDATE custom_event_json_nodes SET parent_node_id = ? WHERE event_pk = ? AND node_id = ?",
          )
          .run(999_999, eventPk, nodeFor("/text").node_id);
      } else if (scenario === "missing-root-selected-nonempty") {
        database
          .prepare(
            "DELETE FROM custom_event_json_nodes WHERE event_pk = ? AND parent_node_id IS NULL",
          )
          .run(eventPk);
      } else if (scenario === "mixed-valid-invalid-roots") {
        const nextNodeId = (
          database
            .prepare(
              "SELECT COALESCE(MAX(node_id), 0) + 1 AS next_id FROM custom_event_json_nodes WHERE event_pk = ?",
            )
            .get(eventPk) as { readonly next_id: number }
        ).next_id;
        const invalidRootPathId = addPath(database, foreignSite, "/");
        addNode(database, {
          eventPk,
          nodeId: nextNodeId,
          parentNodeId: null,
          pathId: invalidRootPathId,
          valueType: 4,
          depth: 0,
        });
      } else if (scenario === "invalid-boolean") {
        database
          .prepare(
            "UPDATE custom_event_json_values SET boolean_value = 2 WHERE event_pk = ? AND node_id = ?",
          )
          .run(eventPk, nodeFor("/bool").node_id);
      } else if (scenario === "infinite-number") {
        database
          .prepare(
            "UPDATE custom_event_json_values SET number_value = 1e999 WHERE event_pk = ? AND node_id = ?",
          )
          .run(eventPk, nodeFor("/count").node_id);
      } else {
        throw new Error(`unknown malformed property scenario: ${scenario}`);
      }
      const plan = buildPayloadLogicalPlan(site.id, paths, true, true);
      const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const legacyRows = await actualPayloadQuery(
        sqliteEnv(database, legacyTrace),
        subjectFor([site.id]),
        [site.id],
        RANGE,
        paths,
        false,
      );
      const query = compileLogicalPayloadOutput(
        site.id,
        plan,
        "payload-properties",
      );
      const actualRows = await readLogicalPayloadOutput(
        database,
        site.id,
        plan,
        "payload-properties",
      );
      const expected = legacyPropertyOracle(
        database,
        eventPk,
        eventId,
        paths,
        legacyRows,
      );
      const actual = actualRows[0] ?? null;
      const propertyFields = paths.flatMap((_, index) => [
        `property-${index}-present`,
        `property-${index}-valueType`,
        `property-${index}-stringValue`,
        `property-${index}-numberValue`,
        `property-${index}-booleanValue`,
        `property-${index}-structureCompatible`,
        `property-${index}-valueCompatible`,
      ]);
      const fieldDiffs = propertyFields.flatMap((field) =>
        actual?.[field] === expected[field]
          ? []
          : [
              {
                field,
                expected: expected[field],
                actual: actual?.[field] ?? null,
              },
            ],
      );
      const legacySelectedRowBag = legacyRows
        .filter((row) => row.event_id === eventId)
        .map((row) => {
          const pathRow = database
            .prepare(
              `SELECT p.path, p.site_id, p.site_pk
             FROM custom_event_json_nodes n
             JOIN custom_event_json_paths p ON p.id = n.path_id
             WHERE n.event_pk = ? AND n.node_id = ?`,
            )
            .get(eventPk, row.node_id) as
            | {
                readonly path: string;
                readonly site_id: string;
                readonly site_pk: number;
              }
            | undefined;
          return {
            nodeId: row.node_id,
            legacyKeyName: row.key_name,
            ownerQualifiedPath:
              pathRow?.site_id === site.id && pathRow.site_pk === site.pk
                ? pathRow.path
                : null,
          };
        });
      malformedPayloadVariants.push({
        scenario,
        propertyPaths: paths,
        oracle:
          "legacy selected-node result bag with legacy key_name and owner-qualified path mapping, plus independent root/direct-child stats",
        legacySelectedNodeRows: legacySelectedRowBag.length,
        legacySelectedRowBag,
        legacySqlSha256: createHash("sha256")
          .update(legacyTrace.preparedSql[0] ?? "", "utf8")
          .digest("hex"),
        legacyBindings: legacyTrace.bindings[0] ?? [],
        productionSqlSha256: createHash("sha256")
          .update(query.sql, "utf8")
          .digest("hex"),
        productionSqlUtf8Bytes: Buffer.byteLength(query.sql, "utf8"),
        productionBindings: query.bindings ?? [],
        comparedFieldCount: propertyFields.length,
        expected,
        actual,
        fieldDiffs,
        equal: fieldDiffs.length === 0,
      });
      expect(actualRows).toHaveLength(1);
      expect(fieldDiffs, `legacy property oracle diff: ${scenario}`).toEqual(
        [],
      );
    },
  );
  it("returns a saturated count and no partial property facts after overflow", async () => {
    const database = createFixture();
    const site = addSite(database, "payload-budget-admission-site");
    addVisit(database, site, "payload-budget-admission-owner", 120);
    addEventName(database, site, 50_031);
    const eventPk = addEvent(database, site, {
      id: "payload-budget-admission-event",
      visitId: "payload-budget-admission-owner",
      eventNameId: 50_031,
      occurredAt: 150,
    });
    addWriterJsonEvent(database, site, eventPk, 50_031, 150, {
      items: ["array-child"],
    });

    const overflowPlan = buildPayloadLogicalPlan(
      site.id,
      ["/items"],
      true,
      false,
      1,
    );
    const [selectedRows, counterRows, propertyRows] = await Promise.all([
      readLogicalPayloadOutput(
        database,
        site.id,
        overflowPlan,
        "payload-nodes",
      ),
      readLogicalPayloadOutput(
        database,
        site.id,
        overflowPlan,
        "payload-budget",
      ),
      readLogicalPayloadOutput(
        database,
        site.id,
        overflowPlan,
        "payload-properties",
      ),
    ]);
    expect(selectedRows.length).toBeGreaterThan(1);
    expect(counterRows).toEqual([{ payloadNodeCount: 2 }]);
    expect(propertyRows).toEqual([]);

    const atCapacityPlan = buildPayloadLogicalPlan(
      site.id,
      ["/items"],
      true,
      false,
      2,
    );
    const [atCapacityCount, atCapacityProperties] = await Promise.all([
      readLogicalPayloadOutput(
        database,
        site.id,
        atCapacityPlan,
        "payload-budget",
      ),
      readLogicalPayloadOutput(
        database,
        site.id,
        atCapacityPlan,
        "payload-properties",
      ),
    ]);
    expect(atCapacityCount).toEqual([{ payloadNodeCount: 2 }]);
    expect(atCapacityProperties).toHaveLength(1);
    expect(atCapacityProperties[0]).toMatchObject({
      "property-0-present": 1,
      "property-0-stringValue": null,
    });

    const overflowBudgetQuery = compileLogicalPayloadOutput(
      site.id,
      overflowPlan,
      "payload-budget",
    );
    const overflowPropertiesQuery = compileLogicalPayloadOutput(
      site.id,
      overflowPlan,
      "payload-properties",
    );
    const atCapacityPropertiesQuery = compileLogicalPayloadOutput(
      site.id,
      atCapacityPlan,
      "payload-properties",
    );
    const explain = (query: ReturnType<typeof compileLogicalPayloadOutput>) => {
      const bindings = (query.bindings ?? []).map((value) =>
        typeof value === "boolean" ? Number(value) : value,
      ) as SQLInputValue[];
      return database
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .all(...bindings) as Array<{
        readonly id: number;
        readonly parent: number;
        readonly detail: string;
      }>;
    };
    const evidenceDirectory = process.env.WAVE96W_ARTIFACT_DIR;
    if (!evidenceDirectory) return;
    mkdirSync(evidenceDirectory, { recursive: true });
    const evidencePath = join(
      evidenceDirectory,
      "overflow-actual-gate-evidence.json",
    );
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          phase:
            "91C SQLite output-contract evidence for bounded payload admission",
          d1Executed: false,
          claimBoundary: {
            proves:
              "the saturated counter and property output contract for overflow and at-capacity cases",
            doesNotProve:
              "that SQLite skipped recursive lookup, grouping, or value-side work before returning the gated output",
            explainIsStaticPlanOnly: true,
            operatorExecutionWasInstrumented: false,
            overflowPropertyExplainRows: 191,
            overflowRecursiveExplainDetailRows: 14,
            overflowCustomPayloadTableExplainDetailRows: 12,
            runtimeReadsOrOpcodeCounts:
              "unavailable from this Node SQLite test adapter",
          },
          overflow: {
            configuredMaximum: 1,
            saturatedNodeCounterRows: counterRows,
            selectedRawNodeRowsReturned: selectedRows.length,
            propertyFactRows: propertyRows,
            outputContractGateResult:
              Number(counterRows[0]?.payloadNodeCount ?? 0) <= 1,
            emittedPartialPropertyFacts: propertyRows.length > 0,
            budgetSqlSha256: createHash("sha256")
              .update(overflowBudgetQuery.sql, "utf8")
              .digest("hex"),
            budgetBindings: overflowBudgetQuery.bindings ?? [],
            propertySqlSha256: createHash("sha256")
              .update(overflowPropertiesQuery.sql, "utf8")
              .digest("hex"),
            propertySqlUtf8Bytes: Buffer.byteLength(
              overflowPropertiesQuery.sql,
              "utf8",
            ),
            propertyBindings: overflowPropertiesQuery.bindings ?? [],
            propertyExplain: explain(overflowPropertiesQuery),
          },
          atCapacity: {
            configuredMaximum: 2,
            saturatedNodeCounterRows: atCapacityCount,
            propertyFactRows: atCapacityProperties,
            outputContractGateResult:
              Number(atCapacityCount[0]?.payloadNodeCount ?? 0) <= 2,
            propertySqlSha256: createHash("sha256")
              .update(atCapacityPropertiesQuery.sql, "utf8")
              .digest("hex"),
            propertySqlUtf8Bytes: Buffer.byteLength(
              atCapacityPropertiesQuery.sql,
              "utf8",
            ),
            propertyBindings: atCapacityPropertiesQuery.bindings ?? [],
            propertyExplain: explain(atCapacityPropertiesQuery),
          },
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    process.stdout.write(`overflow_gate_evidence=${evidencePath}\n`);
  });

  it("remaps Properties metadata onto selected Event rows with Logical PK coexistence", async () => {
    const database = createFixture();
    const site = addSite(database, "payload-selected-source-metadata-site");
    const otherSite = addSite(
      database,
      "payload-selected-source-metadata-other-site",
    );
    addVisit(database, site, "selected-source-owner-present", 120);
    addVisit(database, site, "selected-source-owner-missing", 121);
    addVisit(database, site, "selected-source-owner-wrong-name", 122);
    addVisit(database, site, "selected-source-owner-old-time", 250);
    addVisit(database, otherSite, "selected-source-owner-other-site", 120);

    const selectedNameId = 52_001;
    const otherNameId = 52_002;
    const foreignNameId = 52_003;
    addEventName(database, site, selectedNameId);
    addEventName(database, site, otherNameId);
    addEventName(database, otherSite, foreignNameId);
    database
      .prepare("UPDATE custom_event_names SET name = ? WHERE id = ?")
      .run(`event-name:${selectedNameId}`, foreignNameId);

    const selectedEventPk = addEvent(database, site, {
      id: "selected-source-payload-present",
      visitId: "selected-source-owner-present",
      eventNameId: selectedNameId,
      occurredAt: 150,
    });
    const missingEventPk = addEvent(database, site, {
      id: "selected-source-payload-missing",
      visitId: "selected-source-owner-missing",
      eventNameId: selectedNameId,
      occurredAt: 151,
    });
    const wrongNamePk = addEvent(database, site, {
      id: "selected-source-payload-wrong-name",
      visitId: "selected-source-owner-wrong-name",
      eventNameId: otherNameId,
      occurredAt: 152,
    });
    const oldTimePk = addEvent(database, site, {
      id: "selected-source-payload-old-time",
      visitId: "selected-source-owner-old-time",
      eventNameId: selectedNameId,
      occurredAt: 250,
    });
    const otherSitePk = addEvent(database, otherSite, {
      id: "selected-source-payload-other-site",
      visitId: "selected-source-owner-other-site",
      eventNameId: foreignNameId,
      occurredAt: 153,
    });
    addWriterJsonEvent(database, site, selectedEventPk, selectedNameId, 150, {
      value: "selected-source-value",
    });
    addWriterJsonEvent(database, site, missingEventPk, selectedNameId, 151, {});
    addWriterJsonEvent(database, site, wrongNamePk, otherNameId, 152, {
      value: "wrong-name-value",
    });
    addWriterJsonEvent(database, site, oldTimePk, selectedNameId, 250, {
      value: "old-time-value",
    });
    addWriterJsonEvent(database, otherSite, otherSitePk, foreignNameId, 153, {
      value: "other-site-value",
    });

    const eventNameFilter = {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "event.name" },
        operator: "eq",
        value: `event-name:${selectedNameId}`,
      },
    } as FilterDocument;
    const selection = createSemanticScopedSourceSelection({
      profile: "direct-event-analytics-v1",
      filters: eventNameFilter,
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: [site.id as SiteId],
      }),
      time: createSemanticTemporalDomains({
        candidate: RANGE as never,
        read: { kind: "bounded", range: RANGE as never },
        reportingTimeZone: "UTC" as never,
        capturedAtMs: 200 as never,
      }),
    });
    const plan = buildPayloadLogicalPlan(
      site.id,
      ["/value"],
      true,
      true,
      undefined,
      false,
      false,
      selection,
      true,
    );
    const rows = await readLogicalPayloadOutput(
      database,
      site.id,
      plan,
      "payload-properties",
    );

    expect(rows).toHaveLength(2);
    const byEventId = new Map<string, Record<string, unknown>>(
      rows.map((row) => [String(row.eventId), row]),
    );
    expect([...byEventId.keys()].sort()).toEqual([
      "selected-source-payload-missing",
      "selected-source-payload-present",
    ]);
    expect(byEventId.get("selected-source-payload-present")).toMatchObject({
      eventPk: selectedEventPk,
      "property-0-present": 1,
      "property-0-valueType": 1,
      "property-0-stringValue": "selected-source-value",
      "property-0-structureCompatible": 1,
      "property-0-valueCompatible": 1,
    });
    expect(byEventId.get("selected-source-payload-missing")).toMatchObject({
      eventPk: missingEventPk,
      "property-0-present": 0,
      "property-0-valueType": null,
      "property-0-stringValue": null,
      "property-0-structureCompatible": 1,
      "property-0-valueCompatible": 1,
    });
    const sqliteEventOracle = database
      .prepare(
        `SELECT events.event_id AS eventId, events.event_pk AS eventPk
         FROM custom_events AS events
         INNER JOIN visits AS owner
           ON owner.visit_id = events.visit_id
          AND owner.site_pk = events.site_pk
         WHERE events.site_pk = ?
           AND events.occurred_at >= ?
           AND events.occurred_at < ?
           AND events.event_name_id = ?
         ORDER BY events.event_id`,
      )
      .all(site.pk, RANGE.startMs, RANGE.endExclusiveMs, selectedNameId) as {
      readonly eventId: string;
      readonly eventPk: number;
    }[];
    const actualIdentities = [...byEventId]
      .map(([eventId, row]) => ({
        eventId,
        eventPk: Number(row.eventPk),
      }))
      .sort((left, right) => left.eventId.localeCompare(right.eventId));
    expect(actualIdentities).toEqual(sqliteEventOracle);

    const postObservationSelection = createSemanticScopedSourceSelection({
      profile: "direct-event-analytics-v1",
      filters: { version: 1, root: null },
      subject: selection.subject,
      time: selection.time,
      postObservationFilter: createSemanticPostObservationFilter({
        filter: eventNameFilter,
      }),
    });
    const postObservationPlan = buildPayloadLogicalPlan(
      site.id,
      ["/value"],
      true,
      true,
      undefined,
      false,
      false,
      postObservationSelection,
      true,
    );
    const postObservationOutput = postObservationPlan.outputs.find(
      ({ id }) => id === "payload-properties",
    );
    if (!postObservationOutput)
      throw new Error("selected_source_post_observation_output_missing");
    const postObservationLowerer = new AnalyticsLogicalToDbLowerer(
      postObservationPlan,
      { siteId: site.id, time: postObservationPlan.context.time },
    );
    expect(() =>
      postObservationLowerer.lowerMany([postObservationOutput]),
    ).not.toThrow();
  });

  it("keeps Provider admission carriers narrow and Properties on the same node bag", async () => {
    const database = createFixture();
    const site = addSite(database, "payload-runtime-column-liveness-site");
    addVisit(database, site, "payload-runtime-column-liveness-owner", 120);
    addEventName(database, site, 50_041);
    const eventPk = addEvent(database, site, {
      id: "payload-runtime-column-liveness-event",
      visitId: "payload-runtime-column-liveness-owner",
      eventNameId: 50_041,
      occurredAt: 150,
    });
    addWriterJsonEvent(database, site, eventPk, 50_041, 150, {
      value: "runtime-live-value",
    });

    const budgetOnlyPlan = buildPayloadLogicalPlan(
      site.id,
      ["/value"],
      false,
      false,
      50_000,
      false,
    );
    const propertyBudgetPlan = buildPayloadLogicalPlan(
      site.id,
      ["/value"],
      true,
      false,
      50_000,
      false,
    );
    const fullPlan = buildPayloadLogicalPlan(
      site.id,
      ["/value"],
      true,
      false,
      50_000,
      true,
      true,
    );
    const livenessQueries = [
      [
        "budget-only",
        compileLogicalPayloadOutput(site.id, budgetOnlyPlan, "payload-budget"),
      ],
      [
        "properties-budget",
        compileLogicalPayloadOutput(
          site.id,
          propertyBudgetPlan,
          "payload-properties",
        ),
      ],
      [
        "fullnodes-properties-budget",
        compileLogicalPayloadOutput(site.id, fullPlan, "payload-nodes"),
      ],
    ] as const;
    const packet = payloadAdmissionPacketForPlan(site.id, fullPlan);
    const properties = fullPlan.nodes.find(
      (node) => node.kind === "event-payload-properties",
    );
    if (properties?.kind !== "event-payload-properties")
      throw new Error("payload_runtime_properties_missing");
    expect(packet.propertiesRelation).toBe(properties.id);
    expect(packet.maximumNodes).toBe(50_000);
    expect(packet.boundedNodes.node).toMatchObject({
      kind: "limit",
      count: { kind: "parameter", value: 50_001 },
    });
    expect(
      packet.boundedNodes.node.kind === "limit" &&
        packet.boundedNodes.node.input.node,
    ).toBe(packet.selectedNodes.node);
    expect(packet.counter.node).toMatchObject({
      kind: "aggregate",
      groups: [],
      aggregates: [
        {
          name: "payloadNodeCount",
          expression: { kind: "aggregate", name: "COUNT" },
        },
      ],
    });
    expect(packet.propertyReadNodeRelation).toBe(packet.admittedNodes);
    expect(packet.propertyReadRelation).toBeTruthy();
    expect(
      properties.properties
        .flatMap(({ fields }) =>
          fields.map(
            ({ slot }) =>
              fullPlan.slots.find((candidate) => candidate.id === slot)
                ?.lineage,
          ),
        )
        .every(
          (lineage) =>
            lineage?.kind === "derived" &&
            lineage.operation.startsWith("event-payload-property:") &&
            lineage.inputs.length === 1 &&
            lineage.inputs[0] === properties.eventKey,
        ),
    ).toBe(true);
    expect(
      fullPlan.slots.some(
        (slot) =>
          slot.lineage.kind === "derived" &&
          slot.lineage.operation.includes("event-payload-node-budget"),
      ),
    ).toBe(false);

    const budgetOnlyCount = await readLogicalPayloadOutput(
      database,
      site.id,
      budgetOnlyPlan,
      "payload-budget",
    );
    const propertyBudgetCount = await readLogicalPayloadOutput(
      database,
      site.id,
      propertyBudgetPlan,
      "payload-budget",
    );
    const propertyRows = await readLogicalPayloadOutput(
      database,
      site.id,
      propertyBudgetPlan,
      "payload-properties",
    );
    const fullNodeRows = await readLogicalPayloadOutput(
      database,
      site.id,
      fullPlan,
      "payload-nodes",
    );
    const fullBudgetCount = await readLogicalPayloadOutput(
      database,
      site.id,
      fullPlan,
      "payload-budget",
    );
    const fullPropertyRows = await readLogicalPayloadOutput(
      database,
      site.id,
      fullPlan,
      "payload-properties",
    );

    expect(budgetOnlyCount).toEqual([{ payloadNodeCount: 2 }]);
    expect(propertyBudgetCount).toEqual(budgetOnlyCount);
    expect(fullBudgetCount).toEqual(budgetOnlyCount);
    expect(propertyRows).toEqual(fullPropertyRows);
    expect(propertyRows).toEqual([
      expect.objectContaining({
        "property-0-present": 1,
        "property-0-structureCompatible": 1,
        "property-0-valueCompatible": 1,
        "property-0-valueType": 1,
        "property-0-stringValue": "runtime-live-value",
      }),
    ]);
    expect(fullNodeRows).toHaveLength(2);
    expect(
      fullNodeRows.some((row) => row.key === "value" && row.path === "/value"),
    ).toBe(true);

    const variants = livenessQueries.map(([name, query]) => {
      const bindings = (query.bindings ?? []).map((value) =>
        typeof value === "boolean" ? Number(value) : value,
      ) as SQLInputValue[];
      const explainRows = database
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .all(...bindings) as { readonly detail: string }[];
      const explainDetails = explainRows.map(({ detail }) => detail);
      const bytecodeRows = database
        .prepare(`EXPLAIN ${query.sql}`)
        .all(...bindings) as {
        readonly opcode: string;
        readonly p4: unknown;
      }[];
      const bytecodeTypeChecks = bytecodeRows.filter(
        ({ opcode, p4 }) =>
          /function/iu.test(opcode) && /typeof/iu.test(String(p4 ?? "")),
      );
      return {
        name,
        sql: query.sql,
        bindings,
        sqlSha256: createHash("sha256").update(query.sql, "utf8").digest("hex"),
        sqlUtf8Bytes: Buffer.byteLength(query.sql, "utf8"),
        valueTableSources: (
          query.sql.match(/\bFROM "custom_event_json_values"/giu) ?? []
        ).length,
        valueTypeChecks: (query.sql.match(/\btypeof\s*\(/giu) ?? []).length,
        explainRows,
        explainValueTableRows: explainDetails.filter((detail) =>
          /custom_event_json_values/iu.test(detail),
        ),
        bytecodeTypeChecks,
      };
    });
    const budgetVariant = variants.find(({ name }) => name === "budget-only");
    const propertyVariant = variants.find(
      ({ name }) => name === "properties-budget",
    );
    const fullNodeVariant = variants.find(
      ({ name }) => name === "fullnodes-properties-budget",
    );
    expect(budgetVariant?.explainValueTableRows).toEqual([]);
    expect(budgetVariant?.bytecodeTypeChecks).toEqual([]);
    expect(propertyVariant?.explainValueTableRows).toHaveLength(1);
    expect(propertyVariant?.bytecodeTypeChecks.length).toBeGreaterThan(0);
    expect(fullNodeVariant?.explainValueTableRows).toEqual([]);
    expect(fullNodeVariant?.bytecodeTypeChecks).toEqual([]);
    const evidenceDirectory = process.env.WAVE96W_ARTIFACT_DIR;
    if (!evidenceDirectory) return;
    mkdirSync(evidenceDirectory, { recursive: true });
    const evidencePath = join(
      evidenceDirectory,
      "payload-runtime-liveness.json",
    );
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          phase:
            "93F Provider payload admission and business Properties liveness",
          d1Executed: false,
          selectedNodeProviderColumns: packet.selectedNodes.fields.map(
            ({ name, affinity, nullable }) => ({ name, affinity, nullable }),
          ),
          admissionMaximum: packet.maximumNodes,
          boundedNodeLimit: packet.boundedNodes.node,
          counterShape: packet.counter.node,
          variants,
          sqliteOutputs: {
            budgetOnlyCount,
            propertyBudgetCount,
            properties: propertyRows,
            fullNodes: fullNodeRows,
            fullBudgetCount,
            fullProperties: fullPropertyRows,
          },
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    process.stdout.write(`payload_liveness_evidence=${evidencePath}\n`);
  });

  it("proves typed payload roles are disjoint and cover roots, root children, and selected other nodes", () => {
    const database = createFixture();
    const site = addSite(database, "payload-role-proof-site");
    const eventDefinitions = [
      {
        id: "payload-role-proof-writer-event",
        visitId: "payload-role-proof-writer-owner",
        eventNameId: 51_001,
        occurredAt: 150,
      },
      {
        id: "payload-role-proof-empty-event",
        visitId: "payload-role-proof-empty-owner",
        eventNameId: 51_002,
        occurredAt: 151,
      },
      {
        id: "payload-role-proof-orphan-event",
        visitId: "payload-role-proof-orphan-owner",
        eventNameId: 51_003,
        occurredAt: 152,
      },
      {
        id: "payload-role-proof-multiple-roots-event",
        visitId: "payload-role-proof-multiple-roots-owner",
        eventNameId: 51_004,
        occurredAt: 153,
      },
    ] as const;
    for (const event of eventDefinitions) {
      addVisit(database, site, event.visitId, event.occurredAt);
      addEventName(database, site, event.eventNameId);
    }
    const eventPks = new Map(
      eventDefinitions.map((event) => [
        event.id,
        addEvent(database, site, event),
      ]),
    );
    const writerEventPk = eventPks.get(eventDefinitions[0].id)!;
    const deepUnrelated = Object.fromEntries(
      Array.from({ length: 48 }, (_, index) => [
        `unrelated-${index}`,
        `value-${index}`,
      ]),
    );
    addWriterJsonEvent(
      database,
      site,
      writerEventPk,
      eventDefinitions[0].eventNameId,
      eventDefinitions[0].occurredAt,
      { selected: { leaf: "chosen" }, unrelated: deepUnrelated },
    );

    const orphanEventPk = eventPks.get(eventDefinitions[2].id)!;
    addNode(database, {
      eventPk: orphanEventPk,
      nodeId: 1,
      parentNodeId: 999,
      pathId: addPath(database, site, "/orphan"),
      valueType: 1,
      depth: 2,
      keyId: addKey(database, site, "orphan"),
    });

    const multipleRootsEventPk = eventPks.get(eventDefinitions[3].id)!;
    const validRootPathId = addPath(database, site, "/");
    const invalidRootPathId = addPath(database, site, "/invalid-root");
    addNode(database, {
      eventPk: multipleRootsEventPk,
      nodeId: 1,
      parentNodeId: null,
      pathId: validRootPathId,
      valueType: 4,
      depth: 0,
    });
    addNode(database, {
      eventPk: multipleRootsEventPk,
      nodeId: 2,
      parentNodeId: null,
      pathId: invalidRootPathId,
      valueType: 4,
      depth: 0,
    });
    addNode(database, {
      eventPk: multipleRootsEventPk,
      nodeId: 3,
      parentNodeId: 1,
      pathId: addPath(database, site, "/target"),
      valueType: 1,
      depth: 1,
      keyId: addKey(database, site, "target"),
    });
    addNode(database, {
      eventPk: multipleRootsEventPk,
      nodeId: 4,
      parentNodeId: 2,
      pathId: addPath(database, site, "/other"),
      valueType: 1,
      depth: 1,
      keyId: addKey(database, site, "other"),
    });

    const eventTable = scan(schema.custom_events);
    const eventMetadata = project(eventTable, {
      event_pk: eventTable.columns.event_pk,
      site_id: eventTable.columns.site_id,
      site_pk: eventTable.columns.site_pk,
      event_name_id: eventTable.columns.event_name_id,
      occurred_at: eventTable.columns.occurred_at,
    });
    const selectedEvents = project(eventTable, {
      event_pk: eventTable.columns.event_pk,
    });
    const selectedNodes = selectEventPayloadNodeRows(selectedEvents, [
      "/selected/leaf",
      "/orphan",
      "/target",
    ]);
    const selectedQuery = compileD1Query(lowerLogicalPlan(selectedNodes));
    const selectedRows = database
      .prepare(selectedQuery.sql)
      .all(...((selectedQuery.bindings ?? []) as SQLInputValue[])) as Array<{
      readonly event_pk: number;
      readonly node_id: number;
    }>;
    const selectedIdentities = selectedRows.map(
      ({ event_pk, node_id }) => `${event_pk}:${node_id}`,
    );
    expect(new Set(selectedIdentities).size).toBe(selectedIdentities.length);

    const selectedNodeKeys = project(selectedNodes, {
      event_pk: selectedNodes.columns.event_pk,
      node_id: selectedNodes.columns.node_id,
      parent_node_id: selectedNodes.columns.parent_node_id,
    });
    const roleRows = buildEventPayloadPropertyRoleRows(
      eventMetadata,
      selectedNodeKeys,
    );
    const roleRowsNode = roleRows.node;
    if (roleRowsNode.kind !== "union")
      throw new Error("payload_role_rows_expected_outer_union");
    const rootAndChildRowsNode = roleRowsNode.left.node;
    if (rootAndChildRowsNode.kind !== "union")
      throw new Error("payload_role_rows_expected_root_child_union");
    const assertUnionSchema = (node: typeof roleRowsNode) => {
      if (node.kind !== "union")
        throw new Error("payload_role_rows_expected_union_schema");
      const shape = (fields: typeof node.fields) =>
        fields.map(({ name, affinity }) => ({ name, affinity }));
      expect(shape(node.fields)).toEqual(shape(node.left.fields));
      expect(shape(node.fields)).toEqual(shape(node.right.fields));
      expect(node.fields.map(({ nullable }) => nullable)).toEqual(
        node.left.fields.map(
          ({ nullable }, index) =>
            nullable || node.right.fields[index]!.nullable,
        ),
      );
    };
    assertUnionSchema(roleRowsNode);
    assertUnionSchema(rootAndChildRowsNode);
    const integerNullColumns = [
      "node_type",
      "array_index",
      "key_id",
      "path_id",
    ];
    for (const source of [rootAndChildRowsNode.left, roleRowsNode.right]) {
      for (const name of integerNullColumns) {
        const field = source.fields.find(
          (candidate) => candidate.name === name,
        );
        expect(field).toMatchObject({ affinity: "integer", nullable: true });
      }
    }
    for (const [name, affinity] of [
      ["event_site_id", "text"],
      ["event_site_pk", "integer"],
      ["event_name_id", "integer"],
      ["occurred_at", "integer"],
    ] as const) {
      const field = roleRowsNode.right.fields.find(
        (candidate) => candidate.name === name,
      );
      expect(field).toMatchObject({ affinity, nullable: true });
    }
    const roleQuery = compileD1Query(
      lowerLogicalPlan(
        project(roleRows, {
          event_pk: roleRows.columns.event_pk,
          role_code: roleRows.columns.role_code,
          node_id: roleRows.columns.node_id,
          parent_node_id: roleRows.columns.parent_node_id,
          root_valid: roleRows.columns.root_valid,
        }),
      ),
    );
    const actual = database
      .prepare(roleQuery.sql)
      .all(...((roleQuery.bindings ?? []) as SQLInputValue[])) as Array<{
      readonly event_pk: number;
      readonly role_code: number;
      readonly node_id: number | null;
      readonly parent_node_id: number | null;
      readonly root_valid: number;
    }>;
    const rawNodes = database
      .prepare(
        `SELECT n.event_pk, n.node_id, n.parent_node_id, n.key_id,
                n.path_id, n.value_type, n.array_index,
                p.path, p.site_id AS path_site_id, p.site_pk AS path_site_pk
         FROM custom_event_json_nodes n
         LEFT JOIN custom_event_json_paths p ON p.id = n.path_id`,
      )
      .all() as Array<{
      readonly event_pk: number;
      readonly node_id: number;
      readonly parent_node_id: number | null;
      readonly key_id: number | null;
      readonly path_id: number | null;
      readonly value_type: number;
      readonly array_index: number | null;
      readonly path: string | null;
      readonly path_site_id: string | null;
      readonly path_site_pk: number | null;
    }>;
    const eventOwners = new Map(
      database
        .prepare("SELECT event_pk, site_id, site_pk FROM custom_events")
        .all()
        .map((row) => {
          const value = row as {
            readonly event_pk: number;
            readonly site_id: string;
            readonly site_pk: number;
          };
          return [value.event_pk, value] as const;
        }),
    );
    const selectedSet = new Set(selectedIdentities);
    const expected: typeof actual = [];
    for (const eventPk of eventPks.values()) {
      const nodes = rawNodes.filter((node) => node.event_pk === eventPk);
      const roots = nodes.filter((node) => node.parent_node_id === null);
      const rootIds = new Set(roots.map((node) => node.node_id));
      const owner = eventOwners.get(eventPk);
      if (!owner) throw new Error("payload_role_event_owner_missing");
      const validRoot = (node: (typeof roots)[number]) =>
        node.value_type === 4 &&
        node.path === "/" &&
        node.path_site_id === owner.site_id &&
        node.path_site_pk === owner.site_pk &&
        node.key_id === null &&
        node.array_index === null;
      if (roots.length === 0)
        expected.push({
          event_pk: eventPk,
          role_code: 0,
          node_id: null,
          parent_node_id: null,
          root_valid: 0,
        });
      for (const root of roots)
        expected.push({
          event_pk: eventPk,
          role_code: 0,
          node_id: root.node_id,
          parent_node_id: root.parent_node_id,
          root_valid: Number(validRoot(root)),
        });
      for (const node of nodes) {
        const parentIsRoot =
          node.parent_node_id !== null && rootIds.has(node.parent_node_id);
        if (parentIsRoot) {
          const parent = roots.find(
            (root) => root.node_id === node.parent_node_id,
          )!;
          expected.push({
            event_pk: eventPk,
            role_code: 1,
            node_id: node.node_id,
            parent_node_id: node.parent_node_id,
            root_valid: Number(validRoot(parent)),
          });
        } else if (
          node.parent_node_id !== null &&
          selectedSet.has(`${eventPk}:${node.node_id}`)
        ) {
          expected.push({
            event_pk: eventPk,
            role_code: 2,
            node_id: node.node_id,
            parent_node_id: node.parent_node_id,
            root_valid: 0,
          });
        }
      }
    }
    const sortRoles = (rows: typeof actual) =>
      [...rows].sort(
        (left, right) =>
          left.event_pk - right.event_pk ||
          left.role_code - right.role_code ||
          (left.node_id ?? -1) - (right.node_id ?? -1),
      );
    expect(sortRoles(actual)).toEqual(sortRoles(expected));
    const actualNodeIdentities = actual
      .filter(({ node_id }) => node_id !== null)
      .map(({ event_pk, node_id }) => `${event_pk}:${node_id}`);
    expect(new Set(actualNodeIdentities).size).toBe(
      actualNodeIdentities.length,
    );
    expect(
      actual.some(
        ({ event_pk, role_code, node_id }) =>
          event_pk === writerEventPk && role_code === 2 && node_id === null,
      ),
    ).toBe(false);
    const unrelatedDescendants = rawNodes
      .filter(
        (node) =>
          node.event_pk === writerEventPk &&
          node.path?.startsWith("/unrelated/") === true,
      )
      .map(({ node_id }) => `${writerEventPk}:${node_id}`);
    expect(
      unrelatedDescendants.some((identity) =>
        actualNodeIdentities.includes(identity),
      ),
    ).toBe(false);
    expect(
      actual.some(
        ({ event_pk, role_code, node_id }) =>
          event_pk === orphanEventPk && role_code === 2 && node_id === 1,
      ),
    ).toBe(true);
    expect(
      actual
        .filter(
          ({ event_pk, role_code }) =>
            event_pk === multipleRootsEventPk && role_code === 0,
        )
        .map(({ root_valid }) => root_valid)
        .sort(),
    ).toEqual([0, 1]);
  });

  it("lowers the shared Event payload nodes and typed top-level properties against writer rows", async () => {
    const database = createFixture();
    const site = addSite(database, "payload-logical-writer-site");
    addVisit(database, site, "payload-logical-owner", 120);
    addEventName(database, site, 50_001);
    const eventPk = addEvent(database, site, {
      id: "payload-logical-writer-event",
      visitId: "payload-logical-owner",
      eventNameId: 50_001,
      occurredAt: 150,
    });
    addWriterJsonEvent(database, site, eventPk, 50_001, 150, {
      nil: null,
      text: "writer-text",
      count: 42,
      active: true,
      nested: { child: "not-selected" },
      items: ["array-child"],
      "snow/quoted": "unicode-🚀",
    });
    const plan = buildPayloadLogicalPlan(site.id, WRITER_PATHS, false);
    const nodesObserved = await observeLogicalPayloadOutput(
      database,
      site.id,
      plan,
      "payload-nodes",
    );
    const logicalNodes = nodesObserved.rows;
    expect(nodesObserved.trace.preparedSql).toHaveLength(1);
    expect(nodesObserved.metrics[0]?.sqlBytes).toBeGreaterThan(0);
    expect(nodesObserved.metrics[0]?.bindings).toBeGreaterThan(0);
    expect(nodesObserved.metrics[0]?.sqlBytes).toBeLessThanOrEqual(
      D1_MAX_SQL_UTF8_BYTES,
    );
    expect(nodesObserved.metrics[0]?.bindings).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    const expected = await actualPayloadQuery(
      sqliteEnv(database),
      subjectFor([site.id]),
      [site.id],
      RANGE,
      WRITER_PATHS,
      false,
    );
    const eventPaths = new Map(
      database
        .prepare(
          "SELECT n.node_id, p.path FROM custom_event_json_nodes n JOIN custom_event_json_paths p ON p.id = n.path_id WHERE n.event_pk = ?",
        )
        .all(eventPk)
        .map((row) => [Number(row.node_id), String(row.path)]),
    );
    const expectedTuples = expected
      .map((row) => [
        eventPk,
        row.node_id,
        row.parent_node_id,
        row.key_name,
        eventPaths.get(row.node_id),
      ])
      .sort((left, right) => Number(left[1]) - Number(right[1]));
    const actualTuples = logicalNodes
      .map((row) => [
        row.eventPk,
        row.nodeId,
        row.parentNodeId,
        row.key,
        row.path,
      ])
      .sort((left, right) => Number(left[1]) - Number(right[1]));
    expect(actualTuples).toEqual(expectedTuples);
    expect(
      logicalNodes.some(
        (row) => row.key === "snow/quoted" && row.path === "/snow~1quoted",
      ),
    ).toBe(true);
    expect(
      logicalNodes.some(
        (row) => row.key === "child" && row.path === "/nested/child",
      ),
    ).toBe(false);
    expect(logicalNodes.some((row) => row.path === "/items")).toBe(true);
    expect(logicalNodes[0]).not.toHaveProperty("valueType");

    const propertiesPlan = buildPayloadLogicalPlan(site.id, [
      "/missing",
      "/nil",
    ]);
    const propertiesObserved = await observeLogicalPayloadOutput(
      database,
      site.id,
      propertiesPlan,
      "payload-properties",
    );
    const properties = propertiesObserved.rows;
    expect(properties).toHaveLength(1);
    expect(properties[0]).toMatchObject({
      "property-0-present": 0,
      "property-0-valueType": null,
      "property-0-structureCompatible": 1,
      "property-0-valueCompatible": 1,
      "property-1-present": 1,
      "property-1-valueType": 0,
      "property-1-structureCompatible": 1,
      "property-1-valueCompatible": 1,
    });
    expect(propertiesObserved.trace.preparedSql).toHaveLength(1);
    expect(propertiesObserved.metrics).toHaveLength(1);
    // Properties also consume the selected node's parent for role classification.
    expect(propertiesObserved.metrics[0]?.physicalPlanHash).toMatch(/^v\d+:/u);
    expect(propertiesObserved.metrics[0]?.sqlBytes).toBeLessThanOrEqual(
      D1_MAX_SQL_UTF8_BYTES,
    );
    expect(propertiesObserved.metrics[0]?.bindings).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );

    const widePropertyQuery = compileLogicalPayloadOutput(
      site.id,
      buildPayloadLogicalPlan(site.id, WRITER_PATHS),
      "payload-properties",
    );
    expect(
      Buffer.byteLength(widePropertyQuery.sql, "utf8"),
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    const widePropertyBindings = widePropertyQuery.bindings ?? [];
    expect(widePropertyBindings.length).toBeGreaterThan(0);
    expect(widePropertyBindings.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    const widePropertiesObserved = await observeLogicalPayloadOutput(
      database,
      site.id,
      buildPayloadLogicalPlan(site.id, WRITER_PATHS),
      "payload-properties",
    );
    expect(widePropertiesObserved.rows).toHaveLength(1);
    expect(widePropertiesObserved.metrics).toHaveLength(1);
    expect(widePropertiesObserved.metrics[0]?.sqlBytes).toBeLessThanOrEqual(
      D1_MAX_SQL_UTF8_BYTES,
    );
    expect(widePropertiesObserved.metrics[0]?.bindings).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    const onePropertyObserved = await observeLogicalPayloadOutput(
      database,
      site.id,
      buildPayloadLogicalPlan(site.id, ["/text"]),
      "payload-properties",
    );
    expect(onePropertyObserved.rows).toHaveLength(1);
    expect(onePropertyObserved.rows[0]).toMatchObject({
      "property-0-present": 1,
      "property-0-valueType": 1,
      "property-0-stringValue": "writer-text",
    });
    expect(onePropertyObserved.metrics[0]?.sqlBytes).toBeLessThanOrEqual(
      D1_MAX_SQL_UTF8_BYTES,
    );
    expect(onePropertyObserved.metrics[0]?.bindings).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    expect(widePropertiesObserved.metrics[0]?.sqlBytes).toBe(
      Buffer.byteLength(widePropertyQuery.sql, "utf8"),
    );
    expect(widePropertiesObserved.metrics[0]?.bindings).toBe(
      widePropertyBindings.length,
    );

    const typedProperties = [
      [
        "/text",
        {
          "property-0-present": 1,
          "property-0-valueType": 1,
          "property-0-stringValue": "writer-text",
        },
      ],
      [
        "/count",
        {
          "property-0-present": 1,
          "property-0-valueType": 2,
          "property-0-numberValue": 42,
        },
      ],
      [
        "/active",
        {
          "property-0-present": 1,
          "property-0-valueType": 3,
          "property-0-booleanValue": 1,
        },
      ],
      [
        "/nested",
        {
          "property-0-present": 1,
          "property-0-valueType": 4,
          "property-0-valueCompatible": 1,
        },
      ],
      [
        "/items",
        {
          "property-0-present": 1,
          "property-0-valueType": 5,
          "property-0-valueCompatible": 1,
        },
      ],
    ] as const;
    for (const [path, expectedProperty] of typedProperties) {
      const propertyPlan = buildPayloadLogicalPlan(site.id, [path]);
      const typedRows = await readLogicalPayloadOutput(
        database,
        site.id,
        propertyPlan,
        "payload-properties",
      );
      expect(typedRows).toHaveLength(1);
      expect(typedRows[0]).toMatchObject({
        ...expectedProperty,
        "property-0-structureCompatible": 1,
        "property-0-valueCompatible": 1,
      });
    }
  });
  it("accepts an empty payload tree but rejects selected nodes without a root", async () => {
    const database = createFixture();
    const site = addSite(database, "payload-logical-empty-tree-site");
    addVisit(database, site, "payload-logical-empty-tree-owner", 120);
    const eventNameId = 50_007;
    addEventName(database, site, eventNameId);
    const eventPk = addEvent(database, site, {
      id: "payload-logical-empty-tree-event",
      visitId: "payload-logical-empty-tree-owner",
      eventNameId,
      occurredAt: 150,
    });
    const plan = buildPayloadLogicalPlan(site.id, ["/orphan"]);
    const emptyTree = await readLogicalPayloadOutput(
      database,
      site.id,
      plan,
      "payload-properties",
    );
    expect(emptyTree).toMatchObject([
      {
        "property-0-present": 0,
        "property-0-valueType": null,
        "property-0-structureCompatible": 1,
        "property-0-valueCompatible": 1,
      },
    ]);

    const orphanPathId = addPath(database, site, "/orphan");
    const orphanKeyId = addKey(database, site, "orphan");
    addNode(database, {
      eventPk,
      nodeId: 1,
      parentNodeId: 999,
      pathId: orphanPathId,
      valueType: 1,
      depth: 2,
      keyId: orphanKeyId,
    });
    const orphanTree = await readLogicalPayloadOutput(
      database,
      site.id,
      plan,
      "payload-properties",
    );
    expect(orphanTree).toMatchObject([
      {
        "property-0-present": 0,
        "property-0-valueType": null,
        "property-0-structureCompatible": 0,
        "property-0-valueCompatible": 0,
      },
    ]);
  });

  it("keeps duplicate tree rows in the selected-node bag and rejects their property proof", async () => {
    const database = createFixture();
    const site = addSite(database, "payload-logical-corrupt-tree-site");
    addVisit(database, site, "payload-logical-corrupt-owner", 120);
    const eventNameId = 50_002;
    addEventName(database, site, eventNameId);
    const eventPk = addEvent(database, site, {
      id: "payload-logical-corrupt-tree-event",
      visitId: "payload-logical-corrupt-owner",
      eventNameId,
      occurredAt: 150,
    });
    addWriterJsonEvent(database, site, eventPk, eventNameId, 150, {
      nil: null,
    });
    const target = database
      .prepare(
        "SELECT n.node_id, n.parent_node_id, n.key_id, n.path_id, n.value_type, n.depth, n.member_order FROM custom_event_json_nodes n JOIN custom_event_json_paths p ON p.id = n.path_id JOIN custom_event_json_keys k ON k.id = n.key_id WHERE n.event_pk = ? AND p.path = '/nil' AND k.key = 'nil'",
      )
      .get(eventPk) as {
      readonly node_id: number;
      readonly parent_node_id: number | null;
      readonly key_id: number | null;
      readonly path_id: number;
      readonly value_type: number;
      readonly depth: number;
      readonly member_order: number | null;
    };
    const nextNodeId = (
      database
        .prepare(
          "SELECT COALESCE(MAX(node_id), 0) + 1 AS next_id FROM custom_event_json_nodes WHERE event_pk = ?",
        )
        .get(eventPk) as { readonly next_id: number }
    ).next_id;
    addNode(database, {
      eventPk,
      nodeId: nextNodeId,
      parentNodeId: target.parent_node_id,
      pathId: target.path_id,
      valueType: target.value_type,
      depth: target.depth,
      keyId: target.key_id,
      memberOrder: target.member_order,
    });
    addValue(database, {
      eventPk,
      nodeId: nextNodeId,
      site,
      eventNameId,
      pathId: target.path_id,
      occurredAt: 150,
      valueType: target.value_type,
    });

    const plan = buildPayloadLogicalPlan(site.id, ["/nil"], false);
    const actual = await readLogicalPayloadOutput(
      database,
      site.id,
      plan,
      "payload-nodes",
    );
    const expected = await actualPayloadQuery(
      sqliteEnv(database),
      subjectFor([site.id]),
      [site.id],
      RANGE,
      ["/nil"],
      false,
    );
    const pathsByNode = new Map(
      database
        .prepare(
          "SELECT n.node_id, p.path FROM custom_event_json_nodes n JOIN custom_event_json_paths p ON p.id = n.path_id WHERE n.event_pk = ?",
        )
        .all(eventPk)
        .map((row) => [Number(row.node_id), String(row.path)]),
    );
    const actualTuples = actual
      .map((row) => [
        row.eventPk,
        row.nodeId,
        row.parentNodeId,
        row.key,
        row.path,
      ])
      .sort((left, right) => Number(left[1]) - Number(right[1]));
    const expectedTuples = expected
      .map((row) => [
        eventPk,
        row.node_id,
        row.parent_node_id,
        row.key_name,
        pathsByNode.get(row.node_id),
      ])
      .sort((left, right) => Number(left[1]) - Number(right[1]));
    expect(actualTuples).toEqual(expectedTuples);
    expect(actualTuples.filter((row) => row[4] === "/nil")).toHaveLength(2);

    const propertiesPlan = buildPayloadLogicalPlan(site.id, ["/nil"]);
    const duplicateChildProperties = await readLogicalPayloadOutput(
      database,
      site.id,
      propertiesPlan,
      "payload-properties",
    );
    expect(duplicateChildProperties).toMatchObject([
      {
        "property-0-present": 0,
        "property-0-valueType": null,
        "property-0-structureCompatible": 0,
        "property-0-valueCompatible": 0,
      },
    ]);

    database
      .prepare(
        "DELETE FROM custom_event_json_values WHERE event_pk = ? AND node_id = ?",
      )
      .run(eventPk, nextNodeId);
    database
      .prepare(
        "DELETE FROM custom_event_json_nodes WHERE event_pk = ? AND node_id = ?",
      )
      .run(eventPk, nextNodeId);
    const root = database
      .prepare(
        "SELECT path_id FROM custom_event_json_nodes WHERE event_pk = ? AND parent_node_id IS NULL",
      )
      .get(eventPk) as { readonly path_id: number };
    const duplicateRootId = (
      database
        .prepare(
          "SELECT COALESCE(MAX(node_id), 0) + 1 AS next_id FROM custom_event_json_nodes WHERE event_pk = ?",
        )
        .get(eventPk) as { readonly next_id: number }
    ).next_id;
    addNode(database, {
      eventPk,
      nodeId: duplicateRootId,
      parentNodeId: null,
      pathId: root.path_id,
      valueType: 4,
      depth: 0,
    });
    const duplicateRootProperties = await readLogicalPayloadOutput(
      database,
      site.id,
      propertiesPlan,
      "payload-properties",
    );
    expect(duplicateRootProperties).toMatchObject([
      {
        "property-0-present": 0,
        "property-0-valueType": null,
        "property-0-structureCompatible": 0,
        "property-0-valueCompatible": 0,
      },
    ]);
  });

  it("rejects corrupt value storage and foreign path, key, or value ownership", async () => {
    const database = createFixture();
    const site = addSite(database, "payload-logical-corrupt-value-site");
    const foreignSite = addSite(
      database,
      "payload-logical-corrupt-value-foreign",
    );
    addVisit(database, site, "payload-logical-corrupt-value-owner", 120);
    const eventNameId = 50_003;
    addEventName(database, site, eventNameId);
    const eventPk = addEvent(database, site, {
      id: "payload-logical-corrupt-value-event",
      visitId: "payload-logical-corrupt-value-owner",
      eventNameId,
      occurredAt: 150,
    });
    addWriterJsonEvent(database, site, eventPk, eventNameId, 150, {
      text: "writer-text",
    });
    const target = database
      .prepare(
        "SELECT n.node_id FROM custom_event_json_nodes n JOIN custom_event_json_paths p ON p.id = n.path_id WHERE n.event_pk = ? AND p.path = '/text'",
      )
      .get(eventPk) as { readonly node_id: number };
    const plan = buildPayloadLogicalPlan(site.id, ["/text"]);
    database
      .prepare(
        "UPDATE custom_event_json_values SET string_value = CAST(X'FF' AS BLOB) WHERE event_pk = ? AND node_id = ?",
      )
      .run(eventPk, target.node_id);
    const blobValue = await readLogicalPayloadOutput(
      database,
      site.id,
      plan,
      "payload-properties",
    );
    expect(blobValue).toMatchObject([
      {
        "property-0-present": 1,
        "property-0-valueType": 1,
        "property-0-structureCompatible": 1,
        "property-0-valueCompatible": 0,
        "property-0-stringValue": null,
      },
    ]);
    expect(
      database
        .prepare(
          "SELECT typeof(string_value) AS storage_class FROM custom_event_json_values WHERE event_pk = ? AND node_id = ?",
        )
        .get(eventPk, target.node_id),
    ).toEqual({ storage_class: "blob" });

    database
      .prepare(
        "UPDATE custom_event_json_values SET string_value = 'writer-text', site_pk = ? WHERE event_pk = ? AND node_id = ?",
      )
      .run(foreignSite.pk, eventPk, target.node_id);
    const foreignValueOwner = await readLogicalPayloadOutput(
      database,
      site.id,
      plan,
      "payload-properties",
    );
    expect(foreignValueOwner).toMatchObject([
      {
        "property-0-present": 1,
        "property-0-structureCompatible": 1,
        "property-0-valueCompatible": 0,
      },
    ]);
    database
      .prepare(
        "UPDATE custom_event_json_values SET site_pk = ? WHERE event_pk = ? AND node_id = ?",
      )
      .run(site.pk, eventPk, target.node_id);
    const targetOwnership = database
      .prepare(
        "SELECT key_id, path_id FROM custom_event_json_nodes WHERE event_pk = ? AND node_id = ?",
      )
      .get(eventPk, target.node_id) as {
      readonly key_id: number;
      readonly path_id: number;
    };
    const expectStructureRejected = async () => {
      const rows = await readLogicalPayloadOutput(
        database,
        site.id,
        plan,
        "payload-properties",
      );
      expect(rows).toMatchObject([
        {
          "property-0-present": 0,
          "property-0-structureCompatible": 0,
          "property-0-valueCompatible": 0,
        },
      ]);
    };
    database
      .prepare("UPDATE custom_event_json_keys SET site_pk = ? WHERE id = ?")
      .run(foreignSite.pk, targetOwnership.key_id);
    await expectStructureRejected();
    database
      .prepare("UPDATE custom_event_json_keys SET site_pk = ? WHERE id = ?")
      .run(site.pk, targetOwnership.key_id);
    database
      .prepare("UPDATE custom_event_json_paths SET site_pk = ? WHERE id = ?")
      .run(foreignSite.pk, targetOwnership.path_id);
    await expectStructureRejected();
    database
      .prepare("UPDATE custom_event_json_paths SET site_pk = ? WHERE id = ?")
      .run(site.pk, targetOwnership.path_id);
    const rootPathId = (
      database
        .prepare(
          "SELECT path_id FROM custom_event_json_nodes WHERE event_pk = ? AND parent_node_id IS NULL",
        )
        .get(eventPk) as { readonly path_id: number }
    ).path_id;
    database
      .prepare("UPDATE custom_event_json_paths SET site_pk = ? WHERE id = ?")
      .run(foreignSite.pk, rootPathId);
    await expectStructureRejected();
  });

  it("rejects invalid boolean and non-finite numeric values but keeps finite unsafe integers", async () => {
    const database = createFixture();
    const site = addSite(database, "payload-logical-invalid-typed-value-site");
    addVisit(database, site, "payload-logical-invalid-typed-value-owner", 120);
    const eventNameId = 50_007;
    addEventName(database, site, eventNameId);
    const eventPk = addEvent(database, site, {
      id: "payload-logical-invalid-typed-value-event",
      visitId: "payload-logical-invalid-typed-value-owner",
      eventNameId,
      occurredAt: 150,
    });
    const wideFiniteNumber = Number.MAX_SAFE_INTEGER + 4096;
    addWriterJsonEvent(database, site, eventPk, eventNameId, 150, {
      positiveBoolean: true,
      negativeBoolean: false,
      positiveInfinity: 1,
      negativeInfinity: -1,
      wideFiniteNumber: 1,
    });
    const targets = database
      .prepare(
        "SELECT n.node_id, p.path FROM custom_event_json_nodes n JOIN custom_event_json_paths p ON p.id = n.path_id WHERE n.event_pk = ?",
      )
      .all(eventPk) as Array<{
      readonly node_id: number;
      readonly path: string;
    }>;
    const nodeFor = (path: string) => {
      const target = targets.find((candidate) => candidate.path === path);
      if (!target) throw new Error(`payload_test_path_missing:${path}`);
      return target.node_id;
    };
    database
      .prepare(
        "UPDATE custom_event_json_values SET boolean_value = 2 WHERE event_pk = ? AND node_id = ?",
      )
      .run(eventPk, nodeFor("/positiveBoolean"));
    database
      .prepare(
        "UPDATE custom_event_json_values SET boolean_value = -1 WHERE event_pk = ? AND node_id = ?",
      )
      .run(eventPk, nodeFor("/negativeBoolean"));
    database
      .prepare(
        "UPDATE custom_event_json_values SET number_value = 1e999 WHERE event_pk = ? AND node_id = ?",
      )
      .run(eventPk, nodeFor("/positiveInfinity"));
    database
      .prepare(
        "UPDATE custom_event_json_values SET number_value = -1e999 WHERE event_pk = ? AND node_id = ?",
      )
      .run(eventPk, nodeFor("/negativeInfinity"));
    database
      .prepare(
        "UPDATE custom_event_json_values SET number_value = ? WHERE event_pk = ? AND node_id = ?",
      )
      .run(wideFiniteNumber, eventPk, nodeFor("/wideFiniteNumber"));

    const invalidValues = [
      ["/positiveBoolean", "property-0-booleanValue"],
      ["/negativeBoolean", "property-0-booleanValue"],
      ["/positiveInfinity", "property-0-numberValue"],
      ["/negativeInfinity", "property-0-numberValue"],
    ] as const;
    for (const [path, valueField] of invalidValues) {
      const plan = buildPayloadLogicalPlan(site.id, [path]);
      const propertyRows = await readLogicalPayloadOutput(
        database,
        site.id,
        plan,
        "payload-properties",
      );
      expect(propertyRows).toHaveLength(1);
      expect(propertyRows[0]).toMatchObject({
        "property-0-present": 1,
        "property-0-structureCompatible": 1,
        "property-0-valueCompatible": 0,
        [valueField]: null,
      });
    }

    const widePlan = buildPayloadLogicalPlan(site.id, ["/wideFiniteNumber"]);
    const widePropertyRows = await readLogicalPayloadOutput(
      database,
      site.id,
      widePlan,
      "payload-properties",
    );
    expect(widePropertyRows).toMatchObject([
      {
        "property-0-present": 1,
        "property-0-valueType": 2,
        "property-0-numberValue": wideFiniteNumber,
        "property-0-valueCompatible": 1,
      },
    ]);
    const wideStorage = database
      .prepare(
        "SELECT typeof(number_value) AS storage_class, number_value FROM custom_event_json_values WHERE event_pk = ? AND node_id = ?",
      )
      .get(eventPk, nodeFor("/wideFiniteNumber")) as {
      readonly storage_class: string;
      readonly number_value: number;
    };
    expect(wideStorage).toEqual({
      storage_class: "real",
      number_value: wideFiniteNumber,
    });
  });

  it("keeps payload rows scoped to each owner-qualified Event without name filtering", async () => {
    const database = createFixture();
    const site = addSite(database, "payload-logical-event-identity-site");
    const firstOwner = "payload-logical-event-identity-owner-a";
    const secondOwner = "payload-logical-event-identity-owner-b";
    addVisit(database, site, firstOwner, 120);
    addVisit(database, site, secondOwner, 130);
    const firstNameId = 50_004;
    const secondNameId = 50_005;
    const unownedNameId = 50_006;
    addEventName(database, site, firstNameId);
    addEventName(database, site, secondNameId);
    addEventName(database, site, unownedNameId);
    const events = [
      {
        eventId: "payload-logical-identity-event-a",
        eventNameId: firstNameId,
        visitId: firstOwner,
        occurredAt: 150,
        payloadValue: "first-event",
      },
      {
        eventId: "payload-logical-identity-event-b",
        eventNameId: secondNameId,
        visitId: secondOwner,
        occurredAt: 160,
        payloadValue: "second-event",
      },
      {
        eventId: "payload-logical-identity-event-unowned",
        eventNameId: unownedNameId,
        visitId: "payload-logical-missing-owner",
        occurredAt: 170,
        payloadValue: "must-not-leak",
      },
    ] as const;
    const eventPks = new Map<string, number>();
    for (const event of events) {
      const eventPk = addEvent(database, site, {
        id: event.eventId,
        visitId: event.visitId,
        eventNameId: event.eventNameId,
        occurredAt: event.occurredAt,
      });
      eventPks.set(event.eventId, eventPk);
      addWriterJsonEvent(
        database,
        site,
        eventPk,
        event.eventNameId,
        event.occurredAt,
        {
          value: event.payloadValue,
        },
      );
    }

    const paths = ["/value"] as const;
    const nodesPlan = buildPayloadLogicalPlan(site.id, paths, false);
    const actualNodes = await readLogicalPayloadOutput(
      database,
      site.id,
      nodesPlan,
      "payload-nodes",
    );
    const expectedNodes = await actualPayloadQuery(
      sqliteEnv(database),
      subjectFor([site.id]),
      [site.id],
      RANGE,
      paths,
      false,
    );
    const eventPathByNode = new Map(
      database
        .prepare(
          "SELECT n.event_pk, n.node_id, p.path FROM custom_event_json_nodes n JOIN custom_event_json_paths p ON p.id = n.path_id",
        )
        .all()
        .map((row) => [
          `${Number(row.event_pk)}:${Number(row.node_id)}`,
          String(row.path),
        ]),
    );
    const actualTuples = actualNodes
      .map((row) => [
        row.eventPk,
        row.nodeId,
        row.parentNodeId,
        row.key,
        row.path,
      ])
      .sort(
        (left, right) =>
          Number(left[0]) - Number(right[0]) ||
          Number(left[1]) - Number(right[1]),
      );
    const expectedTuples = expectedNodes
      .map((row) => {
        const eventPk = eventPks.get(row.event_id);
        if (eventPk === undefined)
          throw new Error("payload_event_identity_missing_from_fixture");
        return [
          eventPk,
          row.node_id,
          row.parent_node_id,
          row.key_name,
          eventPathByNode.get(`${eventPk}:${row.node_id}`),
        ];
      })
      .sort(
        (left, right) =>
          Number(left[0]) - Number(right[0]) ||
          Number(left[1]) - Number(right[1]),
      );
    expect(actualTuples).toEqual(expectedTuples);
    expect(new Set(actualNodes.map((row) => row.eventPk))).toEqual(
      new Set([
        eventPks.get(events[0].eventId),
        eventPks.get(events[1].eventId),
      ]),
    );

    const propertiesPlan = buildPayloadLogicalPlan(site.id, paths, true, true);
    const properties = await readLogicalPayloadOutput(
      database,
      site.id,
      propertiesPlan,
      "payload-properties",
    );
    expect(properties).toHaveLength(2);
    expect(
      new Map(
        properties.map((row) => [row.eventId, row["property-0-stringValue"]]),
      ),
    ).toEqual(
      new Map([
        [events[0].eventId, "first-event"],
        [events[1].eventId, "second-event"],
      ]),
    );
    const emptySite = addSite(database, "payload-logical-empty-source-site");
    const emptyProperties = await readLogicalPayloadOutput(
      database,
      emptySite.id,
      buildPayloadLogicalPlan(emptySite.id, paths),
      "payload-properties",
    );
    expect(emptyProperties).toEqual([]);
  });

  it("matches frozen whole-payload and empty-path SQL with migrated SQLite rows", async () => {
    const database = createFixture();
    const siteA = addSite(database, "payload-site-a");
    const siteB = addSite(database, "payload-site-b");
    const outside = addSite(database, "payload-not-authorized");
    addVisit(database, siteA, "owner-a-outside-window", 50);
    addVisit(database, siteB, "owner-b", 50);
    addVisit(database, outside, "owner-outside", 50);
    addEventName(database, siteA, 10_001);
    addEventName(database, siteB, 10_002);
    addEventName(database, outside, 10_003);

    addStructuredEvent(database, {
      site: siteA,
      id: "a-event-at-start",
      visitId: "owner-a-outside-window",
      eventNameId: 10_001,
      occurredAt: 100,
      foreignSite: siteB,
    });
    addStructuredEvent(database, {
      site: siteA,
      id: "a-event-before-end",
      visitId: "owner-a-outside-window",
      eventNameId: 10_001,
      occurredAt: 199,
    });
    addStructuredEvent(database, {
      site: siteA,
      id: "a-event-at-end",
      visitId: "owner-a-outside-window",
      eventNameId: 10_001,
      occurredAt: 200,
    });
    addStructuredEvent(database, {
      site: siteB,
      id: "b-event-same-node-ids",
      visitId: "owner-b",
      eventNameId: 10_002,
      occurredAt: 150,
    });
    addStructuredEvent(database, {
      site: siteA,
      id: "a-event-no-name-dictionary",
      visitId: "owner-a-outside-window",
      eventNameId: 987_650,
      occurredAt: 155,
    });
    addStructuredEvent(database, {
      site: outside,
      id: "outside-event",
      visitId: "owner-outside",
      eventNameId: 10_003,
      occurredAt: 150,
    });

    // An A event with a B owner and another with no owner cannot pass the final
    // site-scoped owner join. These historical anomalies are reachable because
    // the migrated test connection's foreign-key enforcement is disabled.
    addEvent(database, siteA, {
      id: "a-event-cross-site-owner",
      visitId: "owner-b",
      eventNameId: 10_001,
      occurredAt: 150,
    });
    addEvent(database, siteA, {
      id: "a-event-missing-owner",
      visitId: "missing-owner",
      eventNameId: 10_001,
      occurredAt: 150,
    });

    const authorized = [siteA.id, siteB.id];
    const subject = subjectFor(authorized);
    const partialPaths = [
      "$.user.name",
      "$.user.age",
      "$.user.name",
      QUOTED_UNICODE_PATH,
      NUL_PATH,
      "$.missingValue",
      "$.foreignSitePath",
      "$.foreignKey",
      "$.childOfMissingPath",
    ];
    const variants = [
      { label: "whole payload", paths: ["ignored path"], wholePayload: true },
      { label: "empty paths", paths: [], wholePayload: false },
      { label: "partial closure", paths: partialPaths, wholePayload: false },
    ] as const;

    for (const variant of variants) {
      const expected = legacyLoadPayloadNodes(
        database,
        authorized,
        [RANGE],
        variant.paths,
        variant.wholePayload,
      );
      const actual = await observeQuery(database, (env) =>
        actualLoadPayloadNodes(
          env,
          subject,
          authorized,
          [RANGE],
          variant.paths,
          variant.wholePayload,
        ),
      );
      expect(actual.rows, variant.label).toEqual(expected);
      expect(
        actual.rows.every((row) => row.event_id !== "a-event-at-end"),
      ).toBe(true);
      expect(actual.rows.every((row) => row.event_id !== "outside-event")).toBe(
        true,
      );
      expect(
        actual.rows.some((row) => row.event_id === "a-event-cross-site-owner"),
      ).toBe(false);
      expect(
        actual.rows.some((row) => row.event_id === "a-event-missing-owner"),
      ).toBe(false);
      expect(
        actual.rows.some((row) => row.event_id === "b-event-same-node-ids"),
      ).toBe(true);
      expect(
        actual.rows.some(
          (row) => row.event_id === "a-event-no-name-dictionary",
        ),
      ).toBe(true);
      if (variant.wholePayload) {
        expect(
          actual.rows.some(
            (row) => row.event_id === "a-event-at-start" && row.node_id === 1,
          ),
        ).toBe(true);
        expect(
          actual.rows.some(
            (row) =>
              row.event_id === "a-event-at-start" &&
              row.node_id === 7 &&
              row.array_index === 2 &&
              row.value_type === 0,
          ),
        ).toBe(true);
        expect(
          actual.rows.some(
            (row) =>
              row.event_id === "a-event-at-start" &&
              row.node_id === 10 &&
              row.key_name === null &&
              row.string_value === null &&
              row.number_value === null &&
              row.boolean_value === null,
          ),
        ).toBe(true);
      } else if (variant.paths.length === 0) {
        expect(
          actual.trace.preparedSql.every(
            (sql) => !/WITH\s+RECURSIVE/iu.test(sql),
          ),
        ).toBe(true);
        expect(
          actual.rows.some(
            (row) => row.event_id === "a-event-at-start" && row.node_id === 1,
          ),
        ).toBe(true);
      } else {
        const mainNodes = actual.rows
          .filter((row) => row.event_id === "a-event-at-start")
          .map((row) => row.node_id);
        expect(mainNodes).toEqual([1, 2, 3, 4, 8, 9, 10, 12, 14]);
        expect(
          actual.rows.filter(
            (row) => row.event_id === "a-event-at-start" && row.node_id === 1,
          ),
        ).toHaveLength(1);
        expect(
          actual.rows.some(
            (row) => row.event_id === "a-event-at-start" && row.node_id === 11,
          ),
        ).toBe(false);
        expect(
          actual.rows.some(
            (row) => row.event_id === "a-event-at-start" && row.node_id === 13,
          ),
        ).toBe(false);
        expect(
          actual.rows.find(
            (row) => row.event_id === "a-event-at-start" && row.node_id === 12,
          ),
        ).toMatchObject({
          key_name: null,
          string_value: "foreign-site-value-is-still-joined",
        });
        expect(
          actual.trace.preparedSql.every((sql) =>
            /WITH\s+RECURSIVE/iu.test(sql),
          ),
        ).toBe(true);
      }
    }
  });

  it("preserves 90/91 site chunking and per-range order under D1 budget with many paths", async () => {
    const database = createFixture();
    const sites: FixtureSite[] = [];
    const ranges = [
      { startMs: 100, endExclusiveMs: 150 },
      { startMs: 150, endExclusiveMs: 200 },
    ] as const;
    for (let index = 0; index < 91; index += 1) {
      const site = addSite(
        database,
        `payload-chunk-${String(index).padStart(3, "0")}`,
      );
      sites.push(site);
      const visitId = `payload-chunk-visit-${index}`;
      addVisit(database, site, visitId, 40);
      const eventNameId = 20_000 + index;
      addEventName(database, site, eventNameId);
      const eventPk = addEvent(database, site, {
        id: `payload-chunk-event-${String(index).padStart(3, "0")}`,
        visitId,
        eventNameId,
        occurredAt: index % 2 === 0 ? 100 : 150,
      });
      const rootPath = addPath(database, site, "");
      const leafPath = addPath(database, site, "$.leaf");
      const leafKey = addKey(database, site, "leaf");
      addNode(database, {
        eventPk,
        nodeId: 1,
        parentNodeId: null,
        pathId: rootPath,
        valueType: 4,
        depth: 0,
      });
      addNode(database, {
        eventPk,
        nodeId: 2,
        parentNodeId: 1,
        pathId: leafPath,
        valueType: 1,
        depth: 1,
        keyId: leafKey,
      });
      addValue(database, {
        eventPk,
        nodeId: 2,
        site,
        eventNameId,
        pathId: leafPath,
        occurredAt: index % 2 === 0 ? 100 : 150,
        valueType: 1,
        stringValue: `value-${index}`,
      });
    }

    const siteIds = sites.map((site) => site.id);
    const subject = subjectFor(siteIds);
    const paths = [
      "$.leaf",
      ...Array.from({ length: 1_199 }, (_, index) => `$.unused.${index}`),
    ];
    const expected = legacyLoadPayloadNodes(
      database,
      siteIds,
      ranges,
      paths,
      false,
    );
    const actual = await observeQuery(database, (env) =>
      actualLoadPayloadNodes(env, subject, siteIds, ranges, paths, false),
    );

    expect(actual.rows).toEqual(expected);
    expect(actual.rows).toHaveLength(182);
    expect(actual.trace.preparedSql).toHaveLength(4);
    expect(actual.trace.bindings).toHaveLength(4);
    expect(actual.metrics).toHaveLength(4);
    expect(
      actual.metrics.every(
        (metric) =>
          typeof metric.physicalPlanHash === "string" &&
          metric.physicalPlanHash.length > 3,
      ),
    ).toBe(true);
    expect(actual.metrics[0]?.physicalPlanHash).toBe(
      actual.metrics[1]?.physicalPlanHash,
    );
    expect(actual.metrics[2]?.physicalPlanHash).toBe(
      actual.metrics[3]?.physicalPlanHash,
    );
    for (const [index, sql] of actual.trace.preparedSql.entries()) {
      const bytes = new TextEncoder().encode(sql).byteLength;
      expect(bytes, `statement ${index} SQL bytes`).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(
        actual.trace.bindings[index]!.length,
        `statement ${index} bindings`,
      ).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    }
    expect(actual.trace.bindings[0]!.length).toBeLessThanOrEqual(100);
    expect(actual.trace.bindings[2]!.length).toBeLessThanOrEqual(100);

    const expectedChunkOrder = legacyLoadPayloadNodes(
      database,
      siteIds,
      ranges,
      paths,
      false,
    );
    expect(actual.rows.map((row) => `${row.event_id}:${row.node_id}`)).toEqual(
      expectedChunkOrder.map((row) => `${row.event_id}:${row.node_id}`),
    );

    const plans = actual.trace.preparedSql.map((sql, index) =>
      explainQueryPlan(database, {
        sql,
        bindings: actual.trace.bindings[index],
      }),
    );
    expect(plans[0]!.join("\n")).toMatch(
      /custom_event_nodes_event_parent|custom_event_json_nodes_1/iu,
    );
    expect(plans[0]!.join("\n")).toMatch(/idx_custom_events_site_pk_time/iu);
    expect(plans[0]!.join("\n")).toMatch(/sqlite_autoindex_visits_1/iu);
    expect(plans[0]!.join("\n")).toMatch(
      /sqlite_autoindex_custom_event_json_values_1/iu,
    );
    expect(
      plans[0]!.filter((entry) => /USING INTEGER PRIMARY KEY/iu.test(entry))
        .length,
    ).toBeGreaterThanOrEqual(2);

    // Also execute and measure the other branch against this same 90-site
    // source chunk; empty paths must not create a recursive closure.
    const whole = await observeQuery(database, (env) =>
      actualPayloadQuery(
        env,
        subject,
        siteIds.slice(0, 90),
        ranges[0],
        [],
        true,
      ),
    );
    expect(whole.rows).toEqual(
      legacyPayloadQuery(database, siteIds.slice(0, 90), ranges[0], [], true),
    );
    expect(whole.trace.preparedSql).toHaveLength(1);
    expect(whole.trace.preparedSql[0]).not.toMatch(/WITH\s+RECURSIVE/iu);
    expect(whole.metrics).toHaveLength(1);
    expect(whole.metrics[0]?.physicalPlanHash).toEqual(expect.any(String));
    expect(
      new TextEncoder().encode(whole.trace.preparedSql[0]!).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(whole.trace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    const wholePlan = explainQueryPlan(database, {
      sql: whole.trace.preparedSql[0]!,
      bindings: whole.trace.bindings[0],
    });
    expect(wholePlan.join("\n")).toMatch(
      /custom_event_json_nodes|idx_custom_event_nodes_event_parent/iu,
    );
  });
});
