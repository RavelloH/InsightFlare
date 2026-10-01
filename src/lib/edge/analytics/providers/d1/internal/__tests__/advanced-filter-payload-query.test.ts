import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type { SiteId, TeamId } from "@/lib/edge/analytics/contract/types";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { queryAdvancedFilterPayloadNodes } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-payload-query";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const SITE_CHUNK_SIZE = 90;
const PAYLOAD_NODE_LIMIT = 50_000;
const SQLITE_PAYLOAD_NODE_LIMIT = PAYLOAD_NODE_LIMIT + 1;

const RANGE = { startMs: 100, endExclusiveMs: 200 } as const;
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

afterAll(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("advanced filter payload node query differential", () => {
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
