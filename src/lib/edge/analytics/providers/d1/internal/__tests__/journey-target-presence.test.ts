import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  lowerLogicalPlan,
  project,
  scan,
} from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { schema } from "@/lib/db/schema";
import { buildJourneyTargetPresencePlan } from "@/lib/edge/analytics/engine/journey-target-presence-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { AnalyticsRelationalStorage } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core-sources";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryJourneyTargetExistsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const SITE_A = "journey-presence-a";
const SITE_B = "journey-presence-b";
const WINDOW = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 200,
  timeZone: "UTC",
} as const;

interface FixtureSite {
  readonly siteId: string;
  readonly sitePk: number;
  readonly eventNameId: number;
}

let db: DatabaseSync;
let siteA: FixtureSite;
let siteB: FixtureSite;

function insertSite(database: DatabaseSync, siteId: string): FixtureSite {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  const identity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(siteId) as { readonly site_pk: number };
  database
    .prepare(
      "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
    )
    .run(siteId, "fixture", 1, identity.site_pk);
  const eventName = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ?")
    .get(identity.site_pk) as { readonly id: number };
  return {
    siteId,
    sitePk: Number(identity.site_pk),
    eventNameId: Number(eventName.id),
  };
}

function insertVisit(
  database: DatabaseSync,
  site: FixtureSite,
  input: {
    readonly visitId: string;
    readonly visitorId: string;
    readonly sessionId: string;
    readonly startedAt: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits
        (visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname, site_pk)
       VALUES (?, ?, ?, ?, 'closed', ?, ?, '/', 'journey.test', ?)`,
    )
    .run(
      input.visitId,
      site.siteId,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt,
      site.sitePk,
    );
}

function insertEvent(
  database: DatabaseSync,
  input: {
    readonly eventId: string;
    readonly site: FixtureSite;
    readonly visitId: string;
    readonly eventNameId: number;
    readonly occurredAt: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO custom_events
        (event_id, site_id, visit_id, event_name_id, occurred_at, received_at, node_count, value_count, site_pk)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    )
    .run(
      input.eventId,
      input.site.siteId,
      input.visitId,
      input.eventNameId,
      input.occurredAt,
      input.occurredAt,
      input.site.sitePk,
    );
}

function seedFixture(database: DatabaseSync): void {
  // The migrated schema enforces the production foreign keys by default. Turn
  // them off only in this test database to model orphan Events and missing
  // dictionary rows that can pre-exist in imported/legacy data.
  database.exec("PRAGMA foreign_keys = OFF");
  siteA = insertSite(database, SITE_A);
  siteB = insertSite(database, SITE_B);

  const visits = [
    ["page-start", "PageStart", "SessionStart", 100],
    ["page-before", "PageBefore", "SessionBefore", 99],
    ["page-upper", "PageUpper", "SessionUpper", 200],
    ["event-before-owner", "EventBeforeOwner", "EventBeforeSession", 50],
    ["event-after-owner", "EventAfterOwner", "EventAfterSession", 220],
    ["event-end-owner", "EventEndOnly", "EventEndSession", 120],
    [
      "event-before-lower-owner",
      "EventBeforeLower",
      "EventBeforeLowerSession",
      80,
    ],
    ["duplicate-a", "Duplicate", "DuplicateSession", 110],
    ["duplicate-b", "Duplicate", "DuplicateSession", 120],
    ["empty-id", "", "", 130],
    ["whitespace-id", " \t ", "\t ", 131],
    ["case-id", "CaseSensitive", "CaseSession", 132],
    ["unicode-id", "访客🌍", "会话🚀", 133],
  ] as const;
  for (const [visitId, visitorId, sessionId, startedAt] of visits)
    insertVisit(database, siteA, { visitId, visitorId, sessionId, startedAt });

  insertVisit(database, siteB, {
    visitId: "cross-site-owner",
    visitorId: "CrossSiteOnly",
    sessionId: "CrossSiteSession",
    startedAt: 50,
  });
  insertVisit(database, siteB, {
    visitId: "site-b-only",
    visitorId: "SiteBOnly",
    sessionId: "SiteBSession",
    startedAt: 130,
  });

  insertEvent(database, {
    eventId: "event-inclusive-lower",
    site: siteA,
    visitId: "event-before-owner",
    eventNameId: 90_001,
    occurredAt: 100,
  });
  insertEvent(database, {
    eventId: "event-exclusive-upper",
    site: siteA,
    visitId: "event-end-owner",
    eventNameId: siteA.eventNameId,
    occurredAt: 200,
  });
  insertEvent(database, {
    eventId: "event-before-range",
    site: siteA,
    visitId: "event-before-lower-owner",
    eventNameId: siteA.eventNameId,
    occurredAt: 99,
  });
  insertEvent(database, {
    eventId: "event-exclusive-owner-site",
    site: siteA,
    visitId: "cross-site-owner",
    eventNameId: siteB.eventNameId,
    occurredAt: 150,
  });
  for (const [eventId, occurredAt, eventNameId] of [
    ["duplicate-event-a", 150, siteA.eventNameId],
    ["duplicate-event-b", 151, siteB.eventNameId],
  ] as const)
    insertEvent(database, {
      eventId,
      site: siteA,
      visitId: "duplicate-a",
      eventNameId,
      occurredAt,
    });
  insertEvent(database, {
    eventId: "orphan-event",
    site: siteA,
    visitId: "missing-owner",
    eventNameId: siteA.eventNameId,
    occurredAt: 150,
  });
}

function legacyTargetExists(
  database: DatabaseSync,
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
  window: typeof WINDOW,
): boolean {
  const identityColumn =
    target.type === "visitor" ? "visitor_id" : "session_id";
  const row = database
    .prepare(
      `WITH entity_universe AS (
  SELECT ${identityColumn} AS entity_id
  FROM visits
  WHERE site_pk = (SELECT site_pk FROM site_identities WHERE site_id = ?)
    AND started_at >= ? AND started_at < ?
  UNION
  SELECT v.${identityColumn} AS entity_id
  FROM custom_events ce
  INNER JOIN visits v
    ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
  WHERE ce.site_pk = (SELECT site_pk FROM site_identities WHERE site_id = ?)
    AND ce.occurred_at >= ? AND ce.occurred_at < ?
)
SELECT 1 AS present
FROM entity_universe
WHERE entity_id = ?
LIMIT 1`,
    )
    .get(
      siteId,
      window.startMs,
      window.endExclusiveMs,
      siteId,
      window.startMs,
      window.endExclusiveMs,
      target.value,
    );
  return row !== undefined;
}

function compilePresenceQuery(
  siteId: string,
  target: { readonly type: "visitor" | "session"; readonly value: string },
) {
  const plan = buildJourneyTargetPresencePlan({
    siteId,
    target,
    window: WINDOW,
  });
  const output = plan.outputs[0]!;
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(lowered, [
    { name: "present", slot: output.fields[0]!.slot },
  ]);
  return compileD1Query(lowerLogicalPlan(relation), {
    tag: "journey.target-presence.test",
  });
}

function testEnv(database: D1Database, extra: Partial<Env> = {}): Env {
  return {
    DB: database,
    INGEST_DO: {} as DurableObjectNamespace,
    ...extra,
  } as Env;
}

beforeAll(() => {
  db = createMigratedDatabase();
  seedFixture(db);
});

afterAll(() => db.close());

describe("Journey target presence through typed Analytics lowering", () => {
  it("matches the legacy Page/Event existence oracle for both target kinds", async () => {
    const d1 = createSqliteD1Database(db);
    const cases = [
      ["visitor", "PageStart", SITE_A],
      ["visitor", "PageBefore", SITE_A],
      ["visitor", "PageUpper", SITE_A],
      ["visitor", "EventBeforeOwner", SITE_A],
      ["visitor", "EventAfterOwner", SITE_A],
      ["visitor", "EventEndOnly", SITE_A],
      ["visitor", "EventBeforeLower", SITE_A],
      ["visitor", "Duplicate", SITE_A],
      ["visitor", "", SITE_A],
      ["visitor", " \t ", SITE_A],
      ["visitor", "\t ", SITE_A],
      ["visitor", "CaseSensitive", SITE_A],
      ["visitor", "casesensitive", SITE_A],
      ["visitor", "访客🌍", SITE_A],
      ["visitor", "CrossSiteOnly", SITE_A],
      ["visitor", "SiteBOnly", SITE_A],
      ["visitor", "SiteBOnly", SITE_B],
      ["visitor", "absent", "unknown-site"],
      ["session", "SessionStart", SITE_A],
      ["session", "SessionBefore", SITE_A],
      ["session", "SessionUpper", SITE_A],
      ["session", "EventBeforeSession", SITE_A],
      ["session", "EventAfterSession", SITE_A],
      ["session", "EventEndSession", SITE_A],
      ["session", "EventBeforeLowerSession", SITE_A],
      ["session", "DuplicateSession", SITE_A],
      ["session", "", SITE_A],
      ["session", "\t ", SITE_A],
      ["session", "CaseSession", SITE_A],
      ["session", "casesession", SITE_A],
      ["session", "会话🚀", SITE_A],
      ["session", "CrossSiteSession", SITE_A],
      ["session", "SiteBSession", SITE_A],
      ["session", "absent", "unknown-site"],
    ] as const;

    for (const [type, value, selectedSite] of cases) {
      const target = { type, value } as const;
      const expected = legacyTargetExists(db, selectedSite, target, WINDOW);
      const actual = await queryJourneyTargetExistsFromD1(
        testEnv(d1),
        selectedSite,
        target,
        WINDOW,
      );
      expect(actual, `${type}:${JSON.stringify(value)} @ ${selectedSite}`).toBe(
        expected,
      );
    }
  });

  it("executes one observed typed D1 statement with the active operation tag", async () => {
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = instrumentEnv(
      testEnv(createSqliteD1Database(db, trace)),
      logger,
    );

    await runWithInvocationLogger(logger, () =>
      runWithD1Operation("site_journeys.target_presence", () =>
        queryJourneyTargetExistsFromD1(
          env,
          SITE_A,
          { type: "visitor", value: "EventBeforeOwner" },
          WINDOW,
        ),
      ),
    );
    const record = await logger.emitWhenComplete();
    const observation = record.logs.find((event) =>
      event.message.startsWith("db.query.v1.all.success"),
    );

    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.bindings).toHaveLength(1);
    expect(observation?.data).toMatchObject({
      tag: "site_journeys.target_presence",
      operation: "all",
      status: "success",
      sqlBytes: new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
      bindings: 11,
      physicalPlanHash: expect.stringMatching(/^v1:/u),
    });
    expect(trace.preparedSql[0]).toContain("UNION ALL");
    expect(trace.preparedSql[0]).not.toContain("custom_event_names");
    expect(
      record.performance.operations?.["site_journeys.target_presence"],
    ).toMatchObject({ d1Statements: 1, d1RowsReadAvailable: false });
  });

  it("keeps typed Analytics D1 diagnostics and defensive result handling", async () => {
    const sites = scan(schema.site_identities);
    const query = compileD1Query(
      project(sites, { siteId: sites.columns.site_id }),
      { tag: "analytics.typed-diagnostics" },
    );
    const databaseWithAll = (all: () => Promise<unknown>) =>
      ({
        prepare: () => {
          const statement = {
            bind: () => statement,
            all,
            first: async () => null,
            run: async () => ({ success: true }),
          };
          return statement;
        },
        batch: async () => [],
      }) as unknown as D1Database;
    const diagnostics = createD1ReadDiagnostics();
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const rows = await runWithInvocationLogger(logger, () =>
      runWithD1Operation("journey.target_presence", () =>
        queryD1CompiledAll(
          testEnv(
            databaseWithAll(async () => ({
              success: true,
              results: [{ siteId: SITE_A }],
              meta: { rows_read: 7 },
            })),
          ),
          query,
          diagnostics,
        ),
      ),
    );
    expect(rows).toEqual([{ siteId: SITE_A }]);
    expect(diagnostics).toMatchObject({
      rowsRead: 7,
      rowsReadAvailable: true,
    });
    expect(
      logger.build().performance.operations?.["journey.target_presence"],
    ).toMatchObject({
      d1Statements: 1,
      d1RowsRead: 7,
      d1RowsReadAvailable: true,
    });

    const missingDiagnostics = createD1ReadDiagnostics();
    await expect(
      queryD1CompiledAll(
        testEnv(
          databaseWithAll(async () => ({
            success: true,
            meta: { rows_read: 3 },
          })),
        ),
        query,
        missingDiagnostics,
      ),
    ).resolves.toEqual([]);
    expect(missingDiagnostics).toMatchObject({
      rowsRead: 3,
      rowsReadAvailable: true,
    });

    const databaseError = new Error("typed D1 read failed");
    await expect(
      queryD1CompiledAll(
        testEnv(databaseWithAll(async () => Promise.reject(databaseError))),
        query,
      ),
    ).rejects.toBe(databaseError);
  });

  it("keeps the typed existence plan within D1 budgets and indexed source paths", () => {
    const query = compilePresenceQuery(SITE_A, {
      type: "visitor",
      value: "EventBeforeOwner",
    });
    const sqlBytes = new TextEncoder().encode(query.sql).byteLength;
    const plan = explainQueryPlan(db, query);
    expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(query.bindings?.length ?? 0).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    expect(
      plan.some((detail) =>
        detail.includes("idx_visits_site_pk_visitor_started_at"),
      ),
    ).toBe(true);
    expect(
      plan.some((detail) => detail.includes("idx_custom_events_site_pk_time")),
    ).toBe(true);
    expect(plan.some((detail) => detail.includes("site_identities"))).toBe(
      true,
    );
    expect(
      plan.some((detail) => detail.includes("sqlite_autoindex_visits_1")),
    ).toBe(true);
  });

  it("lowers Logical Limit without reading the full Observation bag in Worker code", async () => {
    const target = { type: "visitor", value: "Duplicate" } as const;
    const buildPlan = (count: number) => {
      const semanticPlan = buildJourneyTargetPresencePlan({
        siteId: SITE_A,
        target,
        window: WINDOW,
      });
      const builder = new LogicalPlanBuilder(semanticPlan.context);
      const observations = builder.source("observation", {
        attributes: ["observation.visitorId"],
      });
      const identity = builder.slot(
        observations,
        "attribute:observation.visitorId",
      );
      const expected = builder.literal(target.value, {
        kind: "scalar",
        scalar: "string",
      });
      const matching = builder.filter(
        observations,
        builder.compare("eq", identity, expected),
      );
      const projected = builder.project(matching, {
        present: builder.literal(1, { kind: "scalar", scalar: "number" }),
      });
      const limited = builder.limit(projected, count);
      builder.output("limited-presence", limited, [
        { name: "present", slot: "present" },
      ]);
      return builder.finish();
    };

    for (const [count, expectedLength] of [
      [0, 0],
      [1, 1],
      [3, 3],
      [20, 4],
    ] as const) {
      const plan = buildPlan(count);
      const output = plan.outputs[0]!;
      const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
        siteId: SITE_A,
        time: plan.context.time,
      });
      const lowered = lowerer.lower(output);
      const relation = lowerer.projectOutput(lowered, [
        { name: "present", slot: output.fields[0]!.slot },
      ]);
      const query = compileD1Query(lowerLogicalPlan(relation));
      const rows = await createD1DatabaseClient(createSqliteD1Database(db)).all(
        query,
      );
      expect(rows.results, `LIMIT ${count}`).toHaveLength(expectedLength);
      expect(
        (rows.results as Array<{ readonly present: unknown }>).every(
          (row) => row.present === 1,
        ),
      ).toBe(true);
    }
  });

  it("declares raw empty identity text separately from nullable Session presence", () => {
    const builder = new LogicalPlanBuilder({
      subject: {
        origin: "site",
        siteIds: [SITE_A as never],
      },
      time: buildJourneyTargetPresencePlan({
        siteId: SITE_A,
        target: { type: "session", value: "" },
        window: WINDOW,
      }).context.time,
      scope: { requested: "auto", contractScope: null, logicalScope: null },
    });
    const observations = builder.source("observation", {
      attributes: ["observation.sessionId"],
      relationships: ["observation.session"],
    });
    builder.output("raw-and-related", observations, [
      { name: "rawSession", slot: "attribute:observation.sessionId" },
      { name: "session", slot: "relationship:observation.session" },
    ]);
    const plan = builder.finish();
    const raw = plan.slots.find(
      (slot) =>
        slot.id === observations.slots["attribute:observation.sessionId"],
    );
    const related = plan.slots.find(
      (slot) =>
        slot.id === observations.slots["relationship:observation.session"],
    );
    expect(raw).toMatchObject({
      type: { kind: "scalar", scalar: "string" },
      nullable: false,
      lineage: { kind: "attribute", attribute: "observation.sessionId" },
    });
    expect(related).toMatchObject({
      type: { kind: "entity", entity: "session" },
      nullable: true,
      lineage: { kind: "relationship", relationship: "observation.session" },
    });
  });

  it("compiles the selected raw identity and self key into separate cache shapes", () => {
    const makePlan = (
      attributes: readonly (
        "observation.sessionId" | "observation.visitorId"
      )[],
    ) => {
      const base = buildJourneyTargetPresencePlan({
        siteId: SITE_A,
        target: { type: "visitor", value: "Duplicate" },
        window: WINDOW,
      });
      const builder = new LogicalPlanBuilder(base.context);
      const observations = builder.source("observation", { attributes });
      builder.output("raw", observations, [
        ...attributes.map((attribute) => ({
          name: attribute,
          slot: `attribute:${attribute}`,
        })),
      ]);
      return { plan: builder.finish(), observations };
    };
    const sessionPlan = makePlan(["observation.sessionId"]);
    const visitorPlan = makePlan(["observation.visitorId"]);
    const bothA = makePlan(["observation.sessionId", "observation.visitorId"]);
    const bothB = makePlan(["observation.visitorId", "observation.sessionId"]);
    const storage = new AnalyticsRelationalStorage({
      siteId: SITE_A,
      time: sessionPlan.plan.context.time,
    });
    const lowerSource = (
      input: ReturnType<typeof makePlan>,
      requiredNames: readonly string[],
    ) => {
      const node = input.plan.nodes.find((item) => item.kind === "source");
      if (node?.kind !== "source") throw new Error("source expected");
      const required = new Set(
        requiredNames.map(
          (name) => input.observations.slots[`attribute:${name}`]!,
        ),
      );
      return storage.lowerSource(node, "test.source", required);
    };
    const session = lowerSource(sessionPlan, ["observation.sessionId"]);
    const visitor = lowerSource(visitorPlan, ["observation.visitorId"]);
    const firstBoth = lowerSource(bothA, [
      "observation.sessionId",
      "observation.visitorId",
    ]);
    const reorderedBoth = lowerSource(bothB, [
      "observation.visitorId",
      "observation.sessionId",
    ]);

    expect(session.relation.fields.map((field) => field.name)).not.toContain(
      "raw_visitor_id",
    );
    expect(visitor.relation.fields.map((field) => field.name)).not.toContain(
      "raw_session_id",
    );
    expect(session.relation.fields.map((field) => field.name)).not.toContain(
      "observation_id",
    );
    expect(firstBoth.relation).toBe(reorderedBoth.relation);
  });
});
