import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  calculateQueryCost,
  exceedsQueryCost,
} from "@/lib/edge/analytics/application/cost";
import { goalQueryCost } from "@/lib/edge/analytics/application/goal-cost";
import { filterConditionCount } from "@/lib/edge/analytics/contract";
import { queryGoalTimeseriesParentOracle } from "@/lib/edge/analytics/providers/d1/internal/__tests__/goal-timeseries-parent-oracle";
import { buildTimeBuckets } from "@/lib/edge/analytics/providers/d1/internal/core-time";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core-types";
import { queryGoalTimeseriesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/goal-timeseries";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE_ID = "goal-timeseries-budget-site";
const WINDOW_512: QueryWindow = {
  startMs: 0,
  endExclusiveMs: 512 * 60_000,
  nowMs: 512 * 60_000,
  timeZone: "UTC",
};
const EMPTY = { version: 1, root: null } as const;

let database: DatabaseSync;
let sitePk: number;
let purchaseNameId: number;
let browseNameId: number;
let flagPathId: number;
let payloadPathIds: number[];

function registerSite(db: DatabaseSync): number {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(SITE_ID);
  const row = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  return Number(row.site_pk);
}

function addName(db: DatabaseSync, name: string): number {
  db.prepare(
    "INSERT INTO custom_event_names (site_id, site_pk, name, last_seen_at) VALUES (?, ?, ?, 1)",
  ).run(SITE_ID, sitePk, name);
  const row = db
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(sitePk, name) as { readonly id: number };
  return Number(row.id);
}

function addPayloadPath(db: DatabaseSync, id: number, path: string): void {
  db.prepare(
    `INSERT INTO custom_event_json_paths
       (id, site_id, site_pk, path, last_seen_at) VALUES (?, ?, ?, ?, 1)`,
  ).run(id, SITE_ID, sitePk, path);
}

function addPayloadValue(input: {
  readonly eventPk: number;
  readonly nodeId: number;
  readonly pathId: number;
  readonly eventNameId: number;
  readonly occurredAt: number;
  readonly value: string;
}): void {
  database
    .prepare(
      `INSERT INTO custom_event_json_nodes
         (event_pk, node_id, path_id, value_type, depth)
       VALUES (?, ?, ?, 1, 1)`,
    )
    .run(input.eventPk, input.nodeId, input.pathId);
  database
    .prepare(
      `INSERT INTO custom_event_json_values (
         event_pk, node_id, site_id, site_pk, event_name_id, path_id,
         occurred_at, value_type, string_value
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      input.eventPk,
      input.nodeId,
      SITE_ID,
      sitePk,
      input.eventNameId,
      input.pathId,
      input.occurredAt,
      input.value,
    );
}

function seedCalendarFixture(db: DatabaseSync): void {
  sitePk = registerSite(db);
  purchaseNameId = addName(db, "purchase");
  browseNameId = addName(db, "browse");
  flagPathId = 90_000;
  addPayloadPath(db, flagPathId, "/calendar/flag");
  payloadPathIds = Array.from(
    { length: 40 },
    (_unused, index) => 91_000 + index,
  );
  for (let index = 0; index < 40; index += 1)
    addPayloadPath(db, payloadPathIds[index]!, `/calendar/payload-${index}`);

  const insertPage = db.prepare(
    `INSERT INTO visits (
       visit_id, site_id, site_pk, visitor_id, session_id, status,
       started_at, last_activity_at, pathname, hostname
     ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'calendar.test')`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO custom_events (
       event_pk, event_id, site_id, site_pk, visit_id, event_name_id,
       occurred_at, received_at, sequence, node_count, value_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
  );

  for (let bucket = 0; bucket < 512; bucket += 1) {
    const pageId = `calendar-page-${bucket}`;
    const eventPk = 20_000 + bucket;
    const pageTime = bucket * 60_000 + 1_000;
    const eventTime = bucket * 60_000 + 30_000;
    const eventNameId = bucket % 2 === 0 ? purchaseNameId : browseNameId;
    insertPage.run(
      pageId,
      SITE_ID,
      sitePk,
      `calendar-visitor-${bucket}`,
      `calendar-session-${bucket}`,
      pageTime,
      eventTime,
      bucket % 3 === 0 ? "/calendar/special" : "/calendar/normal",
    );
    insertEvent.run(
      eventPk,
      `calendar-event-${bucket}`,
      SITE_ID,
      sitePk,
      pageId,
      eventNameId,
      eventTime,
      eventTime,
    );

    if (bucket % 4 === 0) {
      addPayloadValue({
        eventPk,
        nodeId: 100,
        pathId: flagPathId,
        eventNameId,
        occurredAt: eventTime,
        value: "yes",
      });
    }
    if (bucket === 0 || bucket === 8) {
      for (let index = 0; index < 40; index += 1) {
        addPayloadValue({
          eventPk,
          nodeId: index + 1,
          pathId: payloadPathIds[index]!,
          eventNameId,
          occurredAt: eventTime,
          value: `value-${index}`,
        });
      }
    } else if (bucket === 4) {
      for (let index = 0; index < 39; index += 1) {
        addPayloadValue({
          eventPk,
          nodeId: index + 1,
          pathId: payloadPathIds[index]!,
          eventNameId,
          occurredAt: eventTime,
          value: `value-${index}`,
        });
      }
    }
  }
}

function filter(source: string) {
  return parseFilterDsl(source, analyticsFilterRegistry);
}

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function envWithTrace(statementTrace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, statementTrace),
  } as unknown as Env;
}

function queryEvidence(statementTrace: SqliteD1Trace) {
  const sql = statementTrace.preparedSql.at(-1)!;
  const bindings = statementTrace.bindings.at(-1)!;
  const explain = database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(
      ...bindings.map((value) =>
        typeof value === "boolean" ? (value ? 1 : 0) : value,
      ),
    ) as Array<{ readonly detail: string }>;
  return {
    sqlBytes: Buffer.byteLength(sql, "utf8"),
    bindingCount: bindings.length,
    sha256: createHash("sha256").update(sql).digest("hex"),
    explainSteps: explain.length,
    explainSha256: createHash("sha256")
      .update(explain.map((row) => row.detail).join("\n"))
      .digest("hex"),
    indexes: [
      ...new Set(
        explain.flatMap((row) => {
          const match = row.detail.match(
            /USING (?:COVERING )?INDEX ([^\s(]+)/u,
          );
          return match ? [match[1]!] : [];
        }),
      ),
    ],
  };
}

function expectedRows(
  bucketCount: number,
  isConverted: (bucket: number) => boolean,
) {
  return buildTimeBuckets(
    {
      ...WINDOW_512,
      endExclusiveMs: bucketCount * 60_000,
      nowMs: bucketCount * 60_000,
    },
    "minute",
  ).map((bucket) => {
    const converted = Number(isConverted(bucket.index));
    return {
      bucket: bucket.index,
      totalSessions: 1,
      convertedSessions: converted,
      totalVisitors: 1,
      convertedVisitors: converted,
    };
  });
}

function assertBudgetAndPlan(statementTrace: SqliteD1Trace) {
  expect(statementTrace.preparedSql).toHaveLength(1);
  const evidence = queryEvidence(statementTrace);
  expect(evidence.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
  expect(evidence.bindingCount).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  expect(evidence.explainSteps).toBeGreaterThan(0);
  expect(evidence.indexes).toContain("idx_visits_site_pk_started_at");
  expect(evidence.indexes).toContain("idx_custom_events_site_pk_time");
  return evidence;
}

beforeAll(() => {
  database = createMigratedDatabase();
  seedCalendarFixture(database);
});

afterAll(() => database.close());

describe("Goal public timeseries calendar budget on migrated SQLite", () => {
  it.each([1, 100, 500, 512])(
    "executes simple and complex Goal reports across %i minute buckets",
    async (bucketCount) => {
      const window: QueryWindow = {
        startMs: 0,
        endExclusiveMs: bucketCount * 60_000,
        nowMs: bucketCount * 60_000,
        timeZone: "UTC",
      };
      const cases = [
        {
          label: "simple-name",
          goal: filter('event.name eq "purchase"'),
          expected: expectedRows(bucketCount, (bucket) => bucket % 2 === 0),
        },
        {
          label: "complex-name-and-payload",
          goal: filter(
            'event.name eq "purchase" AND event.payload("/calendar/flag") exists',
          ),
          expected: expectedRows(bucketCount, (bucket) => bucket % 4 === 0),
        },
      ] as const;

      for (const testCase of cases) {
        const actualTrace = trace();
        const parentTrace = trace();
        const actual = await queryGoalTimeseriesFromD1(
          envWithTrace(actualTrace),
          SITE_ID,
          window,
          "minute",
          EMPTY,
          testCase.goal,
        );
        const parent = await queryGoalTimeseriesParentOracle(
          envWithTrace(parentTrace),
          SITE_ID,
          window,
          "minute",
          EMPTY,
          testCase.goal,
        );
        expect(actual, `${bucketCount}:${testCase.label}`).toEqual(parent);
        expect(actual, `${bucketCount}:${testCase.label}`).toEqual(
          testCase.expected,
        );
        const actualEvidence = assertBudgetAndPlan(actualTrace);
        const parentEvidence = assertBudgetAndPlan(parentTrace);
        console.info(
          "Goal public calendar budget evidence",
          JSON.stringify({
            bucketCount,
            mode: testCase.label,
            actual: actualEvidence,
            parent: parentEvidence,
            first: actual[0],
            last: actual.at(-1),
          }),
        );
      }
    },
  );

  it("runs a real forty-condition Goal at the full 512-bucket boundary", async () => {
    const goal = filter(
      [
        'event.name eq "purchase"',
        ...Array.from(
          { length: 40 },
          (_unused, index) =>
            `event.payload("/calendar/payload-${index}") exists`,
        ),
      ].join(" AND "),
    );
    const cost = goalQueryCost({
      filters: EMPTY,
      startMs: WINDOW_512.startMs,
      endExclusiveMs: WINDOW_512.endExclusiveMs,
      timeZone: WINDOW_512.timeZone,
      interval: "minute",
      goalFilterComplexity: filterConditionCount(goal),
    });
    expect(filterConditionCount(goal)).toBe(41);
    expect(exceedsQueryCost(cost)).toBe(false);
    expect(calculateQueryCost(cost)).toBeLessThan(10_000);

    const actualTrace = trace();
    const parentTrace = trace();
    const actual = await queryGoalTimeseriesFromD1(
      envWithTrace(actualTrace),
      SITE_ID,
      WINDOW_512,
      "minute",
      EMPTY,
      goal,
    );
    const parent = await queryGoalTimeseriesParentOracle(
      envWithTrace(parentTrace),
      SITE_ID,
      WINDOW_512,
      "minute",
      EMPTY,
      goal,
    );
    expect(actual).toEqual(parent);
    expect(actual).toEqual(
      expectedRows(512, (bucket) => bucket === 0 || bucket === 8),
    );
    const actualEvidence = assertBudgetAndPlan(actualTrace);
    const parentEvidence = assertBudgetAndPlan(parentTrace);
    console.info(
      "Goal real forty-condition 512-bucket evidence",
      JSON.stringify({
        conditionCount: filterConditionCount(goal),
        estimatedCost: calculateQueryCost(cost),
        actual: actualEvidence,
        parent: parentEvidence,
        convertedBuckets: actual
          .filter((row) => row.convertedSessions > 0)
          .map((row) => row.bucket),
      }),
    );
  });
});
