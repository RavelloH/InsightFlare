import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { MAX_SITE_IDS_PER_D1_QUERY } from "@/lib/edge/admin/observability/request-observation-model";
import { siteLookupByIds } from "@/lib/edge/admin/observability/request-observation-query";
import type { FunnelConfigV2 } from "@/lib/edge/analytics/contract/funnel-config";
import {
  readCustomEventDetail,
  readCustomEventsForVisit,
  readCustomEventVisitId,
} from "@/lib/edge/analytics/providers/d1/internal/custom-event-read";
import {
  archiveFunnelDefinition,
  createFunnelDefinition,
  queryFunnelDefinition,
  queryFunnelDefinitionsPage,
  updateFunnelDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/funnels";
import {
  archiveGoalDefinition,
  createGoalDefinition,
  queryGoalDefinition,
  queryGoalDefinitionsPage,
  updateGoalDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/goals";
import { sweepIngestAlarms } from "@/lib/edge/ingest/alarm-sweep";
import {
  type IngestFlushContext,
  resolveSitePk,
} from "@/lib/edge/ingest/flush-types";
import type { InvocationLogger } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const databases = new Set<DatabaseSync>();
const goalConfig = {
  filterDslVersion: 1,
  filterDsl: 'event.name eq "purchase"',
} as const;
const funnelConfig: FunnelConfigV2 = {
  filterDslVersion: 1,
  progressionScope: "session",
  conversionWindowMs: null,
  steps: [
    { id: "start", filterDsl: 'page.path eq "/"' },
    { id: "purchase", filterDsl: 'event.name eq "purchase"' },
  ],
};

function createFixture() {
  const database = createMigratedDatabase();
  databases.add(database);
  database.function("unixepoch", () => 1_800_000_000);
  database.exec("PRAGMA foreign_keys = ON");
  database
    .prepare(
      "INSERT INTO users (id, email, name, username) VALUES (?, ?, ?, ?)",
    )
    .run("owner-1", "owner@example.test", "Owner", "owner");
  database
    .prepare(
      "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
    )
    .run("team-1", "Team", "team", "owner-1");
  const insertSite = database.prepare(
    "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertSite.run("site-1", "team-1", "Site One", "one.example.test", 10);
  insertSite.run("site-2", "team-1", "Site Two", "two.example.test", 20);
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)")
    .run("site-1", "site-2");
  const siteOnePk = Number(
    database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get("site-1")?.site_pk,
  );
  const siteTwoPk = Number(
    database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get("site-2")?.site_pk,
  );
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    MAIN_SECRET: "wave12-differential-secret-with-enough-entropy",
    DB: createSqliteD1Database(database, trace),
  } as Env;
  return { database, env, trace, siteOnePk, siteTwoPk };
}

function insertDefinition(
  database: DatabaseSync,
  row: {
    id: string;
    siteId?: string;
    kind: "goal" | "funnel";
    name: string;
    configJson: string;
    configVersion: number;
    createdAt: number;
    archivedAt?: number | null;
  },
) {
  database
    .prepare(
      `INSERT INTO analysis_definitions (
        id, site_id, kind, name, config_json, config_version,
        created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.siteId ?? "site-1",
      row.kind,
      row.name,
      row.configJson,
      row.configVersion,
      row.createdAt,
      row.createdAt,
      row.archivedAt ?? null,
    );
}

function insertCustomEvent(
  database: DatabaseSync,
  input: { siteId: string; sitePk: number; visitId: string; eventId: string },
) {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, site_pk
      ) VALUES (?, ?, ?, ?, 'complete', 100, 100, '/', 'example.test', ?)`,
    )
    .run(
      input.visitId,
      input.siteId,
      `visitor-${input.visitId}`,
      `session-${input.visitId}`,
      input.sitePk,
    );
  const eventNameId = Number(
    database
      .prepare(
        `INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk)
         VALUES (?, 'signup', 100, ?) RETURNING id`,
      )
      .get(input.siteId, input.sitePk)?.id,
  );
  const rootPathId = Number(
    database
      .prepare(
        `INSERT INTO custom_event_json_paths (site_id, path, last_seen_at, site_pk)
         VALUES (?, '$', 100, ?) RETURNING id`,
      )
      .get(input.siteId, input.sitePk)?.id,
  );
  const valuePathId = Number(
    database
      .prepare(
        `INSERT INTO custom_event_json_paths (site_id, path, last_seen_at, site_pk)
         VALUES (?, '$.action', 100, ?) RETURNING id`,
      )
      .get(input.siteId, input.sitePk)?.id,
  );
  const keyId = Number(
    database
      .prepare(
        `INSERT INTO custom_event_json_keys (site_id, key, last_seen_at, site_pk)
         VALUES (?, 'action', 100, ?) RETURNING id`,
      )
      .get(input.siteId, input.sitePk)?.id,
  );
  const eventPk = Number(
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count, site_pk
        ) VALUES (?, ?, ?, ?, 120, 125, 2, 2, 1, ?) RETURNING event_pk`,
      )
      .get(
        input.eventId,
        input.siteId,
        input.visitId,
        eventNameId,
        input.sitePk,
      )?.event_pk,
  );
  database
    .prepare(
      `INSERT INTO custom_event_json_nodes (
        event_pk, node_id, parent_node_id, key_id, path_id, value_type,
        member_order, array_index, depth
      ) VALUES (?, 1, NULL, NULL, ?, 4, NULL, NULL, 0), (?, 2, 1, ?, ?, 1, 0, NULL, 1)`,
    )
    .run(eventPk, rootPathId, eventPk, keyId, valuePathId);
  database
    .prepare(
      `INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
        value_type, string_value, site_pk
      ) VALUES (?, 2, ?, ?, ?, 120, 1, 'joined', ?)`,
    )
    .run(eventPk, input.siteId, eventNameId, valuePathId, input.sitePk);
  return { eventPk, eventNameId };
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("Wave 12 typed-query migration differential", () => {
  it("keeps Goal and Funnel definition CRUD equivalent to their D1 SQL contract", async () => {
    const { database, env, trace } = createFixture();
    const goalJson = JSON.stringify(goalConfig);
    const funnelJson = JSON.stringify(funnelConfig);
    insertDefinition(database, {
      id: "goal-old",
      kind: "goal",
      name: "Old",
      configJson: goalJson,
      configVersion: 1,
      createdAt: 50,
    });
    insertDefinition(database, {
      id: "goal-a",
      kind: "goal",
      name: "A",
      configJson: goalJson,
      configVersion: 1,
      createdAt: 100,
    });
    insertDefinition(database, {
      id: "goal-b",
      kind: "goal",
      name: "B",
      configJson: goalJson,
      configVersion: 1,
      createdAt: 100,
    });
    insertDefinition(database, {
      id: "goal-archived",
      kind: "goal",
      name: "Archived",
      configJson: goalJson,
      configVersion: 1,
      createdAt: 200,
      archivedAt: 300,
    });
    insertDefinition(database, {
      id: "goal-other-site",
      siteId: "site-2",
      kind: "goal",
      name: "Other site",
      configJson: goalJson,
      configVersion: 1,
      createdAt: 400,
    });
    insertDefinition(database, {
      id: "funnel-a",
      kind: "funnel",
      name: "Funnel A",
      configJson: funnelJson,
      configVersion: 2,
      createdAt: 110,
    });
    insertDefinition(database, {
      id: "funnel-b",
      kind: "funnel",
      name: "Funnel B",
      configJson: funnelJson,
      configVersion: 2,
      createdAt: 100,
    });

    const page = await queryGoalDefinitionsPage(env, "site-1", 2);
    const legacyPage = database
      .prepare(
        `SELECT id, site_id, name, config_json, config_version, created_at, updated_at
         FROM analysis_definitions
         WHERE site_id = ? AND kind = ? AND archived_at IS NULL
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all("site-1", "goal", 3) as Array<{ id: string }>;
    expect(page.items.map((item) => item.id)).toEqual(
      legacyPage.slice(0, 2).map((item) => item.id),
    );
    expect(page.pagination).toMatchObject({
      limit: 2,
      returned: 2,
      hasMore: true,
      nextCursor: expect.any(String),
    });
    const cursorPage = await queryGoalDefinitionsPage(env, "site-1", 10, {
      createdAt: 100,
      id: "goal-b",
    });
    expect(cursorPage.items.map((item) => item.id)).toEqual(
      database
        .prepare(
          `SELECT id FROM analysis_definitions
           WHERE site_id = ? AND kind = ? AND archived_at IS NULL
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all("site-1", "goal", 100, 100, "goal-b", 11)
        .map((row) => String(row.id)),
    );
    await expect(queryGoalDefinition(env, "site-2", "goal-a")).resolves.toBe(
      null,
    );
    await expect(
      queryGoalDefinition(env, "site-1", "goal-a"),
    ).resolves.toMatchObject({
      id: "goal-a",
      name: "A",
    });

    const createdGoal = await createGoalDefinition(
      env,
      "site-1",
      "Created Goal",
      goalConfig,
    );
    expect(createdGoal).toMatchObject({ name: "Created Goal" });
    await updateGoalDefinition(
      env,
      "site-1",
      createdGoal.id,
      "Renamed Goal",
      goalConfig,
    );
    await expect(
      queryGoalDefinition(env, "site-1", createdGoal.id),
    ).resolves.toMatchObject({
      name: "Renamed Goal",
    });
    await archiveGoalDefinition(env, "site-1", createdGoal.id);
    await expect(
      queryGoalDefinition(env, "site-1", createdGoal.id),
    ).resolves.toBe(null);

    const funnelPage = await queryFunnelDefinitionsPage(env, "site-1", 10);
    expect(funnelPage.items.map((item) => item.id)).toEqual([
      "funnel-a",
      "funnel-b",
    ]);
    const createdFunnel = await createFunnelDefinition(
      env,
      "site-1",
      "Created Funnel",
      funnelConfig,
    );
    expect(createdFunnel.steps).toEqual(funnelConfig.steps);
    await updateFunnelDefinition(
      env,
      "site-1",
      createdFunnel.id,
      "Renamed Funnel",
      funnelConfig,
    );
    await expect(
      queryFunnelDefinition(env, "site-1", createdFunnel.id),
    ).resolves.toMatchObject({
      name: "Renamed Funnel",
    });
    await archiveFunnelDefinition(env, "site-1", createdFunnel.id);
    await expect(
      queryFunnelDefinition(env, "site-1", createdFunnel.id),
    ).resolves.toBe(null);

    expect(trace.preparedSql).toHaveLength(19);
    expect(
      trace.preparedSql.every((sql) => sql.includes("analysis_definitions")),
    ).toBe(true);
  });

  it("preserves custom-event identity scope, ordering, and nullable JSON joins", async () => {
    const { database, env, trace, siteOnePk, siteTwoPk } = createFixture();
    const seededEvent = insertCustomEvent(database, {
      siteId: "site-1",
      sitePk: siteOnePk,
      visitId: "visit-1",
      eventId: "event-1",
    });
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count, site_pk
        ) VALUES ('event-earlier', 'site-1', 'visit-1', ?, 110, 115, 1, 0, 0, ?)`,
      )
      .run(seededEvent.eventNameId, siteOnePk);
    insertCustomEvent(database, {
      siteId: "site-2",
      sitePk: siteTwoPk,
      visitId: "visit-2",
      eventId: "event-other",
    });

    const list = await readCustomEventsForVisit(env, "site-1", "visit-1", 50);
    const legacyList = database
      .prepare(
        `SELECT ce.event_id AS eventId, ce.visit_id AS visitId, cen.name AS eventName,
                ce.occurred_at AS occurredAt, ce.received_at AS receivedAt,
                ce.sequence, ce.node_count AS nodeCount, ce.value_count AS valueCount
         FROM custom_events ce INNER JOIN custom_event_names cen
           ON cen.id = ce.event_name_id
         WHERE ce.site_pk = (SELECT site_pk FROM site_identities WHERE site_id = ?)
           AND ce.visit_id = ?
         ORDER BY ce.occurred_at ASC, ce.sequence ASC, ce.event_pk ASC LIMIT ?`,
      )
      .all("site-1", "visit-1", 50);
    expect(list).toEqual(
      legacyList.map((row) => ({
        eventId: String(row.eventId ?? ""),
        visitId: String(row.visitId ?? ""),
        eventName: String(row.eventName ?? ""),
        occurredAt: Number(row.occurredAt ?? 0),
        receivedAt: Number(row.receivedAt ?? 0),
        sequence: Number(row.sequence ?? 0),
        nodeCount: Number(row.nodeCount ?? 0),
        valueCount: Number(row.valueCount ?? 0),
      })),
    );
    expect(await readCustomEventVisitId(env, "site-1", "event-1")).toBe(
      database
        .prepare(
          `SELECT visit_id AS visitId FROM custom_events
           WHERE site_pk = (SELECT site_pk FROM site_identities WHERE site_id = ?)
             AND event_id = ? LIMIT 1`,
        )
        .get("site-1", "event-1")?.visitId,
    );
    await expect(
      readCustomEventVisitId(env, "site-1", "event-other"),
    ).resolves.toBeNull();
    const detailTraceIndex = trace.preparedSql.length;
    await expect(
      readCustomEventDetail(env, "site-1", "event-1"),
    ).resolves.toMatchObject({
      siteId: "site-1",
      visitId: "visit-1",
      eventName: "signup",
      eventData: { action: "joined" },
    });
    const nodeQuery = database.prepare(
      trace.preparedSql[detailTraceIndex + 1]!,
    );
    const typedNodeRows = nodeQuery.all(
      ...(trace.bindings[detailTraceIndex + 1] ?? []),
    );
    const legacyNodeRows = database
      .prepare(
        `SELECT n.node_id AS nodeId, n.parent_node_id AS parentNodeId,
                k.key AS key, n.value_type AS valueType,
                n.member_order AS memberOrder, n.array_index AS arrayIndex,
                v.string_value AS stringValue, v.number_value AS numberValue,
                v.boolean_value AS booleanValue
         FROM custom_event_json_nodes n
         LEFT JOIN custom_event_json_keys k ON k.id = n.key_id
         LEFT JOIN custom_event_json_values v
           ON v.event_pk = n.event_pk AND v.node_id = n.node_id
         WHERE n.event_pk = ?
         ORDER BY n.depth ASC, n.parent_node_id ASC,
                  n.member_order ASC, n.array_index ASC`,
      )
      .all(seededEvent.eventPk);
    expect(typedNodeRows).toEqual(legacyNodeRows);
    await expect(
      readCustomEventDetail(env, "site-1", "event-other"),
    ).resolves.toBeNull();

    const listSql = trace.preparedSql[0];
    const listBindings = trace.bindings[0];
    const explain = database
      .prepare(`EXPLAIN QUERY PLAN ${listSql}`)
      .all(...(listBindings ?? []))
      .map((row) => String(row.detail ?? ""))
      .join("\n");
    expect(explain).toContain("sqlite_autoindex_site_identities_1");
    expect(explain).toContain("idx_custom_events_site_pk_visit_time");
  });

  it("retains site-key cache/read-insert-readback and site-lookup chunking", async () => {
    const { database, env, trace } = createFixture();
    const context = {
      env: { DB: env.DB },
      sitePks: new Map<string, number>(),
    } as unknown as IngestFlushContext;
    const beforeResolve = trace.preparedSql.length;
    const sitePk = await resolveSitePk(context, "site-created-during-flush");
    expect(sitePk).toBeGreaterThan(0);
    expect(
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get("site-created-during-flush")?.site_pk,
    ).toBe(sitePk);
    expect(trace.preparedSql.length - beforeResolve).toBe(3);
    await resolveSitePk(context, "site-created-during-flush");
    expect(trace.preparedSql.length - beforeResolve).toBe(3);

    const existingContext = {
      env: { DB: env.DB },
      sitePks: new Map<string, number>(),
    } as unknown as IngestFlushContext;
    const beforeExisting = trace.preparedSql.length;
    expect(await resolveSitePk(existingContext, "site-1")).toBeGreaterThan(0);
    expect(trace.preparedSql.length - beforeExisting).toBe(1);

    const raceContexts = Array.from(
      { length: 2 },
      () =>
        ({
          env: { DB: env.DB },
          sitePks: new Map<string, number>(),
        }) as unknown as IngestFlushContext,
    );
    const beforeRace = trace.preparedSql.length;
    const racePks = await Promise.all(
      raceContexts.map((raceContext) =>
        resolveSitePk(raceContext, "site-race"),
      ),
    );
    expect(racePks[0]).toBe(racePks[1]);
    expect(trace.preparedSql.length - beforeRace).toBe(6);

    const ids = Array.from(
      { length: MAX_SITE_IDS_PER_D1_QUERY + 1 },
      (_, index) => `lookup-${index}`,
    );
    const insertLookupSite = database.prepare(
      `INSERT INTO sites (id, team_id, name, domain) VALUES (?, 'team-1', ?, ?)`,
    );
    for (const [index, id] of ids.entries())
      insertLookupSite.run(id, `Site ${index}`, `${id}.example.test`);
    const beforeLookup = trace.preparedSql.length;
    const sites = await siteLookupByIds(env, ids);
    expect(sites.size).toBe(ids.length);
    const finalIndex = ids.length - 1;
    expect(sites.get(ids[finalIndex]!)).toEqual({
      name: `Site ${finalIndex}`,
      domain: `${ids[finalIndex]}.example.test`,
    });
    expect(trace.preparedSql.length - beforeLookup).toBe(2);
    expect(await siteLookupByIds(env, [])).toEqual(new Map());

    const alarmLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const reconciled: string[] = [];
    const alarmEnv = {
      DB: env.DB,
      INGEST_DO: {
        idFromName: (id: string) => id,
        get: (id: string) => ({
          fetch: async () => {
            reconciled.push(id);
            return new Response(null, { status: 200 });
          },
        }),
      },
    } as unknown as Env;
    const beforeSweep = trace.preparedSql.length;
    await sweepIngestAlarms(
      alarmEnv,
      alarmLogger as unknown as InvocationLogger,
    );
    expect(new Set(reconciled)).toEqual(new Set(["site-1", "site-2", ...ids]));
    expect(trace.preparedSql).toHaveLength(beforeSweep + 1);
    expect(trace.preparedSql.at(-1)).toContain("ORDER BY");
    expect(alarmLogger.info).toHaveBeenCalledWith(
      "scheduled.ingest_alarm_sweep_completed",
      expect.objectContaining({
        siteCount: ids.length + 2,
        reconciled: ids.length + 2,
      }),
    );
  });
});
