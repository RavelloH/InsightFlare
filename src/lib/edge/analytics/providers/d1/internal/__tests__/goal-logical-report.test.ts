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
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  type FilterDocument,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import {
  GOAL_FILTER_DSL_VERSION,
  parseGoalFilter,
} from "@/lib/edge/analytics/contract/goal-config";
import type { PreparedMembership } from "@/lib/edge/analytics/contract/prepared-membership";
import {
  compileGoalSummaryParentOracleStatement,
  mapGoalSummaryParentOracleRow,
  queryGoalSummaryParentOracle,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/goal-summary-parent-oracle";
import { queryGoalTimeseriesParentOracle } from "@/lib/edge/analytics/providers/d1/internal/__tests__/goal-timeseries-parent-oracle";
import {
  type PreparedMembershipFixture,
  toPreparedMembership,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core-types";
import { queryGoalSummaryFromD1 } from "@/lib/edge/analytics/providers/d1/internal/goal-summary";
import { queryGoalTimeseriesFromD1 } from "@/lib/edge/analytics/providers/d1/internal/goal-timeseries";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE_ID = "goal-logical-report-site";
const OTHER_SITE_ID = "goal-logical-report-other-site";
const EMPTY_SITE_ID = "goal-logical-report-empty-site";
const IDENTITY_SITE_ID = "goal-logical-report-identity-site";
const PAYLOAD_SITE_ID = "goal-logical-report-payload-site";
const BOUNDARY_SITE_ID = "goal-logical-report-boundary-site";
const WINDOW: QueryWindow = {
  startMs: 0,
  endExclusiveMs: 180_000,
  nowMs: 180_000,
  timeZone: "UTC",
};
const PREVIOUS_WINDOW: QueryWindow = {
  startMs: -60_000,
  endExclusiveMs: 0,
  nowMs: 0,
  timeZone: "UTC",
};
const EMPTY: FilterDocument = { version: 1, root: null };

let database: DatabaseSync;
let sitePk: number;
let otherSitePk: number;
let identitySitePk: number;
let payloadSitePk: number;
let boundarySitePk: number;
let purchaseNameId: number;
let upgradeNameId: number;
let identityPurchaseNameId: number;
let payloadPurchaseNameId: number;
let boundaryPurchaseNameId: number;

function registerSite(db: DatabaseSync, id: string): number {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return Number(row.site_pk);
}

function addName(db: DatabaseSync, siteId: string, pk: number, name: string) {
  db.prepare(
    "INSERT INTO custom_event_names (site_id, site_pk, name, last_seen_at) VALUES (?, ?, ?, 1)",
  ).run(siteId, pk, name);
  const row = db
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(pk, name) as { readonly id: number };
  return Number(row.id);
}

function insertPage(input: {
  readonly id: string;
  readonly session: string;
  readonly visitor: string;
  readonly time: number;
  readonly path: string;
  readonly siteId?: string;
  readonly pk?: number;
}): void {
  const siteId = input.siteId ?? SITE_ID;
  const pk = input.pk ?? sitePk;
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'goal.test')`,
    )
    .run(
      input.id,
      siteId,
      pk,
      input.visitor,
      input.session,
      input.time,
      input.time,
      input.path,
    );
}

function insertEvent(input: {
  readonly pk: number;
  readonly id: string;
  readonly visitId: string;
  readonly nameId?: number;
  readonly time: number;
  readonly siteId?: string;
  readonly sitePk?: number;
  readonly sequence?: number;
}): void {
  database
    .prepare(
      `INSERT INTO custom_events (
        event_pk, event_id, site_id, site_pk, visit_id, event_name_id,
        occurred_at, received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    )
    .run(
      input.pk,
      input.id,
      input.siteId ?? SITE_ID,
      input.sitePk ?? sitePk,
      input.visitId,
      input.nameId ?? purchaseNameId,
      input.time,
      input.time,
      input.sequence ?? 1,
    );
}

function addStringPayload(
  eventPk: number,
  pathId: number,
  value: string,
  eventNameId = purchaseNameId,
  options: {
    readonly path?: string;
    readonly siteId?: string;
    readonly sitePk?: number;
    readonly nodeId?: number;
    readonly occurredAt?: number;
  } = {},
): void {
  const payloadSiteId = options.siteId ?? SITE_ID;
  const payloadSitePk = options.sitePk ?? sitePk;
  const nodeId = options.nodeId ?? 1;
  database
    .prepare(
      `INSERT INTO custom_event_json_paths (id, site_id, site_pk, path, last_seen_at)
       VALUES (?, ?, ?, ?, 1) ON CONFLICT(id) DO NOTHING`,
    )
    .run(pathId, payloadSiteId, payloadSitePk, options.path ?? "/plan");
  database
    .prepare(
      `INSERT INTO custom_event_json_nodes (
        event_pk, node_id, path_id, value_type, depth
      ) VALUES (?, ?, ?, 1, 1)`,
    )
    .run(eventPk, nodeId, pathId);
  database
    .prepare(
      `INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, site_pk, event_name_id, path_id,
        occurred_at, value_type, string_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      eventPk,
      nodeId,
      payloadSiteId,
      payloadSitePk,
      eventNameId,
      pathId,
      options.occurredAt ?? 1,
      value,
    );
}

function filter(source: string): FilterDocument {
  return parseFilterDsl(source, analyticsFilterRegistry);
}

function payloadExistsGoal(count: number): FilterDocument {
  return filter(
    Array.from(
      { length: count },
      (_unused, index) => `event.payload("/payload/key-${index}") exists`,
    ).join(" AND "),
  );
}

function prepared(
  operation: "goal-summary" | "goal-timeseries",
  filters: FilterDocument,
  scope: "event" | "session" | "visitor" = "event",
  preparedMembership?: PreparedMembershipFixture | PreparedMembership,
  preparationWindow: QueryWindow = WINDOW,
  preparationSiteId: string = SITE_ID,
): FilterDocument {
  const plan = createScopedFilterPlan(operation, filters, scope)!;
  return attachScopedFilterMetadata(filters, {
    requestedScope: scope,
    resolvedScope: plan.scope,
    plan: preparedMembership
      ? {
          ...plan,
          preparedMembership: toPreparedMembership(preparedMembership),
        }
      : plan,
    time: createQueryTime(
      preparationWindow.startMs,
      preparationWindow.endExclusiveMs,
      preparationWindow.timeZone,
      preparationWindow.nowMs,
    ),
    siteIds: [preparationSiteId],
  });
}

function envWithTrace(trace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, trace) } as unknown as Env;
}

function emptyTrace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function queryEvidence(trace: SqliteD1Trace) {
  const sql = trace.preparedSql.at(-1)!;
  const bindings = trace.bindings.at(-1)!;
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

beforeAll(() => {
  database = createMigratedDatabase();
  sitePk = registerSite(database, SITE_ID);
  otherSitePk = registerSite(database, OTHER_SITE_ID);
  registerSite(database, EMPTY_SITE_ID);
  identitySitePk = registerSite(database, IDENTITY_SITE_ID);
  payloadSitePk = registerSite(database, PAYLOAD_SITE_ID);
  boundarySitePk = registerSite(database, BOUNDARY_SITE_ID);
  purchaseNameId = addName(database, SITE_ID, sitePk, "purchase");
  upgradeNameId = addName(database, SITE_ID, sitePk, "upgrade");
  identityPurchaseNameId = addName(
    database,
    IDENTITY_SITE_ID,
    identitySitePk,
    "purchase",
  );
  const otherPurchaseId = addName(
    database,
    OTHER_SITE_ID,
    otherSitePk,
    "purchase",
  );
  payloadPurchaseNameId = addName(
    database,
    PAYLOAD_SITE_ID,
    payloadSitePk,
    "purchase",
  );
  boundaryPurchaseNameId = addName(
    database,
    BOUNDARY_SITE_ID,
    boundarySitePk,
    "purchase",
  );

  insertPage({
    id: "goal-p1",
    session: "goal-s1",
    visitor: "goal-v1",
    time: 1_000,
    path: "/global",
  });
  insertPage({
    id: "goal-p2",
    session: "goal-s1",
    visitor: "goal-v1",
    time: 2_000,
    path: "/buy",
  });
  insertPage({
    id: "goal-p3",
    session: "goal-s2",
    visitor: "goal-v2",
    time: 61_000,
    path: "/global",
  });
  insertPage({
    id: "goal-p4",
    session: "goal-s3",
    visitor: "goal-v1",
    time: 121_000,
    path: "/outside",
  });
  insertEvent({ pk: 1, id: "goal-e1", visitId: "goal-p1", time: 3_000 });
  insertEvent({ pk: 2, id: "goal-e2", visitId: "goal-p3", time: 63_000 });
  insertEvent({
    pk: 3,
    id: "goal-e3",
    visitId: "goal-p4",
    nameId: upgradeNameId,
    time: 123_000,
  });
  addStringPayload(1, 1, "pro");
  addStringPayload(2, 1, "free");
  addStringPayload(3, 1, "pro", upgradeNameId);

  insertPage({
    id: "other-p1",
    session: "other-s1",
    visitor: "other-v1",
    time: 10_000,
    path: "/global",
    siteId: OTHER_SITE_ID,
    pk: otherSitePk,
  });
  insertEvent({
    pk: 4,
    id: "other-e1",
    visitId: "other-p1",
    nameId: otherPurchaseId,
    time: 11_000,
    siteId: OTHER_SITE_ID,
    sitePk: otherSitePk,
  });

  insertPage({
    id: "identity-p1",
    session: "identity-same",
    visitor: "identity-vsame",
    time: 1_000,
    path: "/repeat",
    siteId: IDENTITY_SITE_ID,
    pk: identitySitePk,
  });
  insertPage({
    id: "identity-p2",
    session: "identity-same",
    visitor: "identity-vsame",
    time: 2_000,
    path: "/repeat",
    siteId: IDENTITY_SITE_ID,
    pk: identitySitePk,
  });
  insertPage({
    id: "identity-p3",
    session: "pad",
    visitor: "pad-v",
    time: 3_000,
    path: "/pad",
    siteId: IDENTITY_SITE_ID,
    pk: identitySitePk,
  });
  insertPage({
    id: "identity-p4",
    session: " pad ",
    visitor: " pad-v ",
    time: 4_000,
    path: "/pad",
    siteId: IDENTITY_SITE_ID,
    pk: identitySitePk,
  });
  insertPage({
    id: "identity-p5",
    session: "",
    visitor: "",
    time: 5_000,
    path: "/empty",
    siteId: IDENTITY_SITE_ID,
    pk: identitySitePk,
  });
  insertEvent({
    pk: 700,
    id: "identity-e1",
    visitId: "identity-p1",
    nameId: identityPurchaseNameId,
    time: 6_000,
    siteId: IDENTITY_SITE_ID,
    sitePk: identitySitePk,
  });
  insertPage({
    id: "identity-owner-outside",
    session: "identity-event-only",
    visitor: "identity-event-only-v",
    time: 200_000,
    path: "/outside",
    siteId: IDENTITY_SITE_ID,
    pk: identitySitePk,
  });
  insertEvent({
    pk: 701,
    id: "identity-e2",
    visitId: "identity-owner-outside",
    nameId: identityPurchaseNameId,
    time: 150_000,
    siteId: IDENTITY_SITE_ID,
    sitePk: identitySitePk,
  });

  insertPage({
    id: "goal-previous-window-page",
    session: "goal-previous-window-session",
    visitor: "goal-previous-window-visitor",
    time: -20_000,
    path: "/previous-window",
  });
  insertEvent({
    pk: 900,
    id: "goal-previous-window-event",
    visitId: "goal-previous-window-page",
    time: -10_000,
  });

  const payloadConditions = (
    eventPk: number,
    time: number,
    indexes: number[],
  ) => {
    for (const index of indexes) {
      addStringPayload(
        eventPk,
        6_000 + index,
        `value-${index}`,
        payloadPurchaseNameId,
        {
          path: `/payload/key-${index}`,
          siteId: PAYLOAD_SITE_ID,
          sitePk: payloadSitePk,
          nodeId: index + 1,
          occurredAt: time,
        },
      );
    }
  };
  const payloadPages = [
    { id: "payload-full-page", path: "/payload-full", time: 1_000 },
    { id: "payload-partial-page", path: "/payload-partial", time: 61_000 },
    { id: "payload-split-page", path: "/payload-split", time: 121_000 },
    {
      id: "payload-unselected-page",
      path: "/payload-unselected",
      time: 151_000,
    },
  ] as const;
  for (const [index, page] of payloadPages.entries()) {
    insertPage({
      id: page.id,
      session: `payload-scope-session-${index}`,
      visitor: `payload-scope-visitor-${index}`,
      time: page.time,
      path: page.path,
      siteId: PAYLOAD_SITE_ID,
      pk: payloadSitePk,
    });
  }
  insertEvent({
    pk: 500,
    id: "payload-full-event",
    visitId: "payload-full-page",
    nameId: payloadPurchaseNameId,
    time: 2_000,
    siteId: PAYLOAD_SITE_ID,
    sitePk: payloadSitePk,
  });
  payloadConditions(
    500,
    2_000,
    Array.from({ length: 40 }, (_unused, i) => i),
  );
  insertEvent({
    pk: 501,
    id: "payload-partial-event",
    visitId: "payload-partial-page",
    nameId: payloadPurchaseNameId,
    time: 62_000,
    siteId: PAYLOAD_SITE_ID,
    sitePk: payloadSitePk,
  });
  payloadConditions(
    501,
    62_000,
    Array.from({ length: 39 }, (_unused, i) => i),
  );
  insertEvent({
    pk: 502,
    id: "payload-split-event-a",
    visitId: "payload-split-page",
    nameId: payloadPurchaseNameId,
    time: 122_000,
    siteId: PAYLOAD_SITE_ID,
    sitePk: payloadSitePk,
  });
  insertEvent({
    pk: 503,
    id: "payload-split-event-b",
    visitId: "payload-split-page",
    nameId: payloadPurchaseNameId,
    time: 123_000,
    siteId: PAYLOAD_SITE_ID,
    sitePk: payloadSitePk,
  });
  payloadConditions(
    502,
    122_000,
    Array.from({ length: 20 }, (_unused, i) => i),
  );
  payloadConditions(
    503,
    123_000,
    Array.from({ length: 20 }, (_unused, i) => i + 20),
  );
  insertEvent({
    pk: 504,
    id: "payload-unselected-event",
    visitId: "payload-unselected-page",
    nameId: payloadPurchaseNameId,
    time: 152_000,
    siteId: PAYLOAD_SITE_ID,
    sitePk: payloadSitePk,
  });
  payloadConditions(
    504,
    152_000,
    Array.from({ length: 40 }, (_unused, i) => i),
  );

  const boundaryPages = [
    { id: "boundary-raw-entry", path: "/raw-entry", time: 1_000 },
    {
      id: "boundary-selected-entry",
      path: "/selected-entry",
      time: 2_000,
    },
    {
      id: "boundary-selected-exit",
      path: "/selected-exit",
      time: 3_000,
    },
    { id: "boundary-raw-exit", path: "/raw-exit", time: 4_000 },
  ] as const;
  for (const page of boundaryPages) {
    insertPage({
      id: page.id,
      session: "boundary-shared-session",
      visitor: "boundary-shared-visitor",
      time: page.time,
      path: page.path,
      siteId: BOUNDARY_SITE_ID,
      pk: boundarySitePk,
    });
  }
  insertEvent({
    pk: 910,
    id: "boundary-selected-entry-event",
    visitId: "boundary-selected-entry",
    nameId: boundaryPurchaseNameId,
    time: 2_500,
    siteId: BOUNDARY_SITE_ID,
    sitePk: boundarySitePk,
  });
  insertEvent({
    pk: 911,
    id: "boundary-selected-exit-event",
    visitId: "boundary-selected-exit",
    nameId: boundaryPurchaseNameId,
    time: 3_500,
    siteId: BOUNDARY_SITE_ID,
    sitePk: boundarySitePk,
  });

  for (let index = 0; index < 40; index += 1) {
    const visitId = `payload-p${index}`;
    const eventPk = 100 + index;
    insertPage({
      id: visitId,
      session: `payload-s${index}`,
      visitor: `payload-v${index}`,
      time: 10_000 + index,
      path: "/payload",
    });
    const eventNameId = index === 39 ? upgradeNameId : purchaseNameId;
    insertEvent({
      pk: eventPk,
      id: `payload-e${index}`,
      visitId,
      nameId: eventNameId,
      time: 20_000 + index,
    });
    addStringPayload(eventPk, 1, index === 38 ? "free" : "pro", eventNameId);
    // index 38 is purchase+free and index 39 is upgrade+pro; neither row
    // satisfies both sides of the Goal AND.
  }

  insertPage({
    id: "goal-dst-page",
    session: "goal-dst-session",
    visitor: "goal-dst-visitor",
    time: Date.UTC(2026, 2, 8, 6, 30),
    path: "/dst",
  });
  insertEvent({
    pk: 800,
    id: "goal-dst-event",
    visitId: "goal-dst-page",
    time: Date.UTC(2026, 2, 9, 6, 30),
  });
});

afterAll(() => database.close());

describe("Goal typed logical reports on migrated SQLite", () => {
  it("matches the frozen parent result for plain, prepared, and payload selections", async () => {
    const cases = [
      {
        label: "plain",
        filters: EMPTY,
        goal: filter('event.name eq "purchase"'),
      },
      {
        label: "prepared",
        filters: prepared("goal-summary", filter('page.path eq "/global"')),
        goal: filter('event.name eq "purchase"'),
      },
      {
        label: "prepared-session",
        filters: prepared(
          "goal-summary",
          filter('page.path eq "/global"'),
          "session",
        ),
        goal: filter('page.path eq "/global"'),
      },
      {
        label: "prepared-visitor",
        filters: prepared(
          "goal-summary",
          filter('page.path eq "/global"'),
          "visitor",
        ),
        goal: filter('event.name eq "purchase"'),
      },
      {
        label: "prepared-previous-window",
        filters: prepared(
          "goal-summary",
          filter('page.path eq "/global"'),
          "event",
          undefined,
          {
            startMs: -60_000,
            endExclusiveMs: 60_000,
            nowMs: 60_000,
            timeZone: "UTC",
          },
        ),
        goal: filter('event.name eq "purchase"'),
      },
      {
        label: "prepared-empty",
        filters: prepared("goal-summary", EMPTY, "event", {
          visitIds: [],
          eventIds: [],
        }),
        goal: filter('event.name eq "purchase"'),
      },
      {
        label: "payload-single-path-among-40-observations",
        filters: EMPTY,
        goal: filter(
          'event.name eq "purchase" AND event.payload("/plan") eq "pro"',
        ),
      },
      {
        label: "mixed-or",
        filters: EMPTY,
        goal: filter('page.path eq "/buy" OR event.name eq "upgrade"'),
      },
      {
        label: "mixed-and",
        filters: EMPTY,
        goal: filter('page.path eq "/buy" AND event.name eq "purchase"'),
      },
      {
        label: "not-page-is-not-an-event-filter",
        filters: EMPTY,
        goal: filter('NOT page.path eq "/buy"'),
      },
    ] as const;

    for (const testCase of cases) {
      console.info("Goal migrated SQLite case", testCase.label);
      const actualTrace = emptyTrace();
      const expectedTrace = emptyTrace();
      const actual = await queryGoalSummaryFromD1(
        envWithTrace(actualTrace),
        SITE_ID,
        WINDOW,
        testCase.filters,
        testCase.goal,
      );
      const expected = await queryGoalSummaryParentOracle(
        envWithTrace(expectedTrace),
        SITE_ID,
        WINDOW,
        testCase.filters,
        testCase.goal,
      );
      expect(actual, testCase.label).toEqual(expected);
      expect(actualTrace.preparedSql).toHaveLength(1);
      const actualEvidence = queryEvidence(actualTrace);
      const parentEvidence = queryEvidence(expectedTrace);
      expect(actualEvidence.sqlBytes).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(actualEvidence.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(actualEvidence.explainSteps).toBeGreaterThan(0);
      console.info(
        "Goal migrated SQLite query evidence",
        JSON.stringify({
          case: testCase.label,
          actual: actualEvidence,
          parent: parentEvidence,
          result: actual,
        }),
      );
    }
  });

  it("evaluates Goal Page filters within the already-selected global Page bag", async () => {
    const global = prepared("goal-summary", filter('page.path eq "/global"'));
    const goal = filter('page.path eq "/buy"');
    const actual = await queryGoalSummaryFromD1(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      SITE_ID,
      WINDOW,
      global,
      goal,
    );
    const expected = await queryGoalSummaryParentOracle(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      SITE_ID,
      WINDOW,
      global,
      goal,
    );
    expect(actual).toEqual(expected);
    expect(actual).toMatchObject({ totalSessions: 2, convertedSessions: 0 });
  });

  it("checks forty distinct payload paths on the same selected Event", async () => {
    const selectedPages = filter(
      'page.path eq "/payload-full" OR page.path eq "/payload-partial" OR page.path eq "/payload-split"',
    );
    const globalSummary = prepared(
      "goal-summary",
      selectedPages,
      "event",
      undefined,
      WINDOW,
      PAYLOAD_SITE_ID,
    );
    const globalTimeseries = prepared(
      "goal-timeseries",
      selectedPages,
      "event",
      undefined,
      WINDOW,
      PAYLOAD_SITE_ID,
    );
    const cases = [
      { count: 40, goal: payloadExistsGoal(40), converted: [1, 0, 0] },
      { count: 39, goal: payloadExistsGoal(39), converted: [1, 1, 0] },
    ] as const;

    for (const testCase of cases) {
      const summaryTrace = emptyTrace();
      const parentSummaryTrace = emptyTrace();
      const summary = await queryGoalSummaryFromD1(
        envWithTrace(summaryTrace),
        PAYLOAD_SITE_ID,
        WINDOW,
        globalSummary,
        testCase.goal,
      );
      const parentSummary = await queryGoalSummaryParentOracle(
        envWithTrace(parentSummaryTrace),
        PAYLOAD_SITE_ID,
        WINDOW,
        globalSummary,
        testCase.goal,
      );
      expect(summary).toEqual(parentSummary);
      expect(summary).toEqual({
        totalSessions: 3,
        convertedSessions: testCase.count === 40 ? 1 : 2,
        totalVisitors: 3,
        convertedVisitors: testCase.count === 40 ? 1 : 2,
      });
      expect(summaryTrace.preparedSql).toHaveLength(1);
      const summaryEvidence = queryEvidence(summaryTrace);
      expect(summaryEvidence.sqlBytes).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(summaryEvidence.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(summaryEvidence.explainSteps).toBeGreaterThan(0);

      const timeseriesTrace = emptyTrace();
      const parentTimeseriesTrace = emptyTrace();
      const timeseries = await queryGoalTimeseriesFromD1(
        envWithTrace(timeseriesTrace),
        PAYLOAD_SITE_ID,
        WINDOW,
        "minute",
        globalTimeseries,
        testCase.goal,
      );
      const parentTimeseries = await queryGoalTimeseriesParentOracle(
        envWithTrace(parentTimeseriesTrace),
        PAYLOAD_SITE_ID,
        WINDOW,
        "minute",
        globalTimeseries,
        testCase.goal,
      );
      expect(timeseries).toEqual(parentTimeseries);
      expect(timeseries).toEqual(
        testCase.converted.map((converted, bucket) => ({
          bucket,
          totalSessions: 1,
          convertedSessions: converted,
          totalVisitors: 1,
          convertedVisitors: converted,
        })),
      );
      expect(timeseriesTrace.preparedSql).toHaveLength(1);
      const timeseriesEvidence = queryEvidence(timeseriesTrace);
      expect(timeseriesEvidence.sqlBytes).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(timeseriesEvidence.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(timeseriesEvidence.explainSteps).toBeGreaterThan(0);
      console.info(
        "Goal true payload-condition evidence",
        JSON.stringify({
          conditionCount: testCase.count,
          summary: {
            actual: summaryEvidence,
            parent: queryEvidence(parentSummaryTrace),
            result: summary,
          },
          timeseries: {
            actual: timeseriesEvidence,
            parent: queryEvidence(parentTimeseriesTrace),
            result: timeseries,
          },
        }),
      );
    }
  });

  it("uses the selected Page bag for legal Goal Session entry and exit fields", async () => {
    const selectedPages = prepared(
      "goal-summary",
      filter('page.path eq "/selected-entry" OR page.path eq "/selected-exit"'),
      "event",
      undefined,
      WINDOW,
      BOUNDARY_SITE_ID,
    );
    for (const [field, path] of [
      ["session.entryPath", "/selected-entry"],
      ["session.exitPath", "/selected-exit"],
    ] as const) {
      const dsl = `${field} eq "${path}"`;
      const goal = parseGoalFilter({
        filterDslVersion: GOAL_FILTER_DSL_VERSION,
        filterDsl: dsl,
      });
      expect(goal).toEqual(filter(dsl));
      const selectedActual = await queryGoalSummaryFromD1(
        { DB: createSqliteD1Database(database) } as unknown as Env,
        BOUNDARY_SITE_ID,
        WINDOW,
        selectedPages,
        goal,
      );
      const selectedParent = await queryGoalSummaryParentOracle(
        { DB: createSqliteD1Database(database) } as unknown as Env,
        BOUNDARY_SITE_ID,
        WINDOW,
        selectedPages,
        goal,
      );
      expect(selectedActual).toEqual(selectedParent);
      expect(selectedActual).toEqual({
        totalSessions: 1,
        convertedSessions: 1,
        totalVisitors: 1,
        convertedVisitors: 1,
      });

      const rawActual = await queryGoalSummaryFromD1(
        { DB: createSqliteD1Database(database) } as unknown as Env,
        BOUNDARY_SITE_ID,
        WINDOW,
        EMPTY,
        goal,
      );
      const rawParent = await queryGoalSummaryParentOracle(
        { DB: createSqliteD1Database(database) } as unknown as Env,
        BOUNDARY_SITE_ID,
        WINDOW,
        EMPTY,
        goal,
      );
      expect(rawActual).toEqual(rawParent);
      expect(rawActual).toMatchObject({
        totalSessions: 1,
        convertedSessions: 0,
      });
    }
  });

  it("returns four zeros for empty summaries and zero conversions for a nonmatching Goal", async () => {
    const trace = emptyTrace();
    const emptyActual = await queryGoalSummaryFromD1(
      envWithTrace(trace),
      EMPTY_SITE_ID,
      WINDOW,
      EMPTY,
      filter('event.name eq "purchase"'),
    );
    expect(emptyActual).toEqual({
      totalSessions: 0,
      convertedSessions: 0,
      totalVisitors: 0,
      convertedVisitors: 0,
    });
    expect(trace.preparedSql).toHaveLength(1);

    const actual = await queryGoalSummaryFromD1(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      SITE_ID,
      WINDOW,
      prepared("goal-summary", EMPTY),
      filter('event.name eq "no-such-goal"'),
    );
    expect(actual).toEqual({
      totalSessions: 43,
      convertedSessions: 0,
      totalVisitors: 42,
      convertedVisitors: 0,
    });
  });

  it("counts event-only owners and keeps raw padded identities distinct", async () => {
    const goal = filter('event.name eq "purchase"');
    const actual = await queryGoalSummaryFromD1(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      IDENTITY_SITE_ID,
      WINDOW,
      EMPTY,
      goal,
    );
    const expected = await queryGoalSummaryParentOracle(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      IDENTITY_SITE_ID,
      WINDOW,
      EMPTY,
      goal,
    );
    expect(actual).toEqual(expected);
    expect(actual).toEqual({
      totalSessions: 4,
      convertedSessions: 2,
      totalVisitors: 4,
      convertedVisitors: 2,
    });
  });

  it("keeps the site subject local", async () => {
    const actual = await queryGoalSummaryFromD1(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      OTHER_SITE_ID,
      WINDOW,
      EMPTY,
      filter('event.name eq "purchase"'),
    );
    expect(actual).toEqual({
      totalSessions: 1,
      convertedSessions: 1,
      totalVisitors: 1,
      convertedVisitors: 1,
    });
  });

  it("preserves mixed Page/Event OR and non-applicable NOT observation semantics", async () => {
    const goal = filter('page.path eq "/buy" OR event.name eq "upgrade"');
    const actual = await queryGoalSummaryFromD1(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      SITE_ID,
      WINDOW,
      EMPTY,
      goal,
    );
    const expected = await queryGoalSummaryParentOracle(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      SITE_ID,
      WINDOW,
      EMPTY,
      goal,
    );
    expect(actual).toEqual(expected);
    expect(actual).toMatchObject({
      convertedSessions: 3,
      convertedVisitors: 2,
    });
  });

  it("matches nonempty prepared128 data and the offline parent in the previous window", async () => {
    const visitIds = [
      "goal-previous-window-page",
      "goal-previous-window-page",
      "goal-p1",
      "goal-p3",
      ...Array.from(
        { length: 60 },
        (_unused, index) => `prepared-missing-page-${index}`,
      ),
    ].map((id) => ({ siteId: SITE_ID, id }));
    const eventIds = [
      "goal-previous-window-event",
      "goal-previous-window-event",
      ...Array.from(
        { length: 62 },
        (_unused, index) => `prepared-missing-event-${index}`,
      ),
    ].map((id) => ({ siteId: SITE_ID, id }));
    expect(visitIds.length + eventIds.length).toBe(128);
    expect(new Set(visitIds.map(({ id }) => id)).size).toBeLessThan(
      visitIds.length,
    );
    expect(new Set(eventIds.map(({ id }) => id)).size).toBeLessThan(
      eventIds.length,
    );
    const filters = prepared(
      "goal-summary",
      EMPTY,
      "event",
      { visitIds, eventIds },
      WINDOW,
    );
    const goal = filter('event.name eq "purchase"');

    const previousTrace = emptyTrace();
    const previousActual = await queryGoalSummaryFromD1(
      envWithTrace(previousTrace),
      SITE_ID,
      PREVIOUS_WINDOW,
      filters,
      goal,
    );
    expect(previousActual).toEqual({
      totalSessions: 1,
      convertedSessions: 1,
      totalVisitors: 1,
      convertedVisitors: 1,
    });
    expect(previousTrace.preparedSql).toHaveLength(1);
    const evidence = queryEvidence(previousTrace);
    expect(evidence.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(evidence.bindingCount).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);

    const parentStatement = compileGoalSummaryParentOracleStatement(
      SITE_ID,
      PREVIOUS_WINDOW,
      filters,
      goal,
    );
    expect(parentStatement.bindings.length).toBeGreaterThan(
      D1_MAX_BOUND_PARAMETERS,
    );
    const offlineParentRow = database
      .prepare(parentStatement.sql)
      .get(...parentStatement.bindings) as Record<string, unknown> | undefined;
    const offlineParent = mapGoalSummaryParentOracleRow(offlineParentRow ?? {});
    expect(offlineParent).toEqual(previousActual);
    expect(offlineParent.convertedSessions).toBeGreaterThan(0);

    const currentTrace = emptyTrace();
    const currentActual = await queryGoalSummaryFromD1(
      envWithTrace(currentTrace),
      SITE_ID,
      WINDOW,
      filters,
      goal,
    );
    const currentParentStatement = compileGoalSummaryParentOracleStatement(
      SITE_ID,
      WINDOW,
      filters,
      goal,
    );
    const currentParentRow = database
      .prepare(currentParentStatement.sql)
      .get(...currentParentStatement.bindings) as
      Record<string, unknown> | undefined;
    expect(currentActual).toEqual(
      mapGoalSummaryParentOracleRow(currentParentRow ?? {}),
    );
    expect(currentActual).toEqual({
      totalSessions: 2,
      convertedSessions: 0,
      totalVisitors: 2,
      convertedVisitors: 0,
    });
    expect(currentActual).not.toEqual(previousActual);

    const offlineParentTrace = emptyTrace();
    await expect(
      queryGoalSummaryParentOracle(
        envWithTrace(offlineParentTrace),
        SITE_ID,
        PREVIOUS_WINDOW,
        filters,
        goal,
      ),
    ).rejects.toMatchObject({
      name: "D1StatementBudgetError",
      code: "d1_statement_budget_exceeded",
      item: "bindings",
      actual: expect.any(Number),
      limit: D1_MAX_BOUND_PARAMETERS,
    });
    expect(offlineParentTrace.preparedSql).toHaveLength(0);
    console.info(
      "Goal nonempty prepared128 previous-window evidence",
      JSON.stringify({
        actual: evidence,
        parentBindings: parentStatement.bindings.length,
        offlineParent,
        currentWindow: currentActual,
      }),
    );
  });

  it("preserves Page/Event occurrence buckets, per-bucket identity sets, and calendar fill", async () => {
    const goal = filter('event.name eq "purchase"');
    const actualTrace = emptyTrace();
    const expectedTrace = emptyTrace();
    const actual = await queryGoalTimeseriesFromD1(
      envWithTrace(actualTrace),
      SITE_ID,
      WINDOW,
      "minute",
      EMPTY,
      goal,
    );
    const expected = await queryGoalTimeseriesParentOracle(
      envWithTrace(expectedTrace),
      SITE_ID,
      WINDOW,
      "minute",
      EMPTY,
      goal,
    );
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(3);
    expect(actual.map((row) => row.bucket)).toEqual([0, 1, 2]);
    expect(actualTrace.preparedSql).toHaveLength(1);
    const actualEvidence = queryEvidence(actualTrace);
    const parentEvidence = queryEvidence(expectedTrace);
    expect(actualEvidence.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(actualEvidence.bindingCount).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    expect(actualEvidence.explainSteps).toBeGreaterThan(0);
    console.info(
      "Goal migrated SQLite timeseries query evidence",
      JSON.stringify({ actual: actualEvidence, parent: parentEvidence }),
    );

    const weekActual = await queryGoalTimeseriesFromD1(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      SITE_ID,
      WINDOW,
      "week",
      EMPTY,
      goal,
    );
    const weekExpected = await queryGoalTimeseriesParentOracle(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      SITE_ID,
      WINDOW,
      "week",
      EMPTY,
      goal,
    );
    expect(weekActual).toEqual(weekExpected);
  });

  it("uses local calendar days across the advancing New York DST day window", async () => {
    const dstWindow: QueryWindow = {
      startMs: Date.UTC(2026, 2, 7, 5),
      endExclusiveMs: Date.UTC(2026, 2, 11, 4),
      nowMs: Date.UTC(2026, 2, 12, 4),
      timeZone: "America/New_York",
    };
    const goal = filter('event.name eq "purchase"');
    const actual = await queryGoalTimeseriesFromD1(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      SITE_ID,
      dstWindow,
      "day",
      EMPTY,
      goal,
    );
    const expected = await queryGoalTimeseriesParentOracle(
      { DB: createSqliteD1Database(database) } as unknown as Env,
      SITE_ID,
      dstWindow,
      "day",
      EMPTY,
      goal,
    );
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(4);
    expect(actual[1]).toMatchObject({ totalSessions: 1, convertedSessions: 0 });
    expect(actual[2]).toMatchObject({ totalSessions: 1, convertedSessions: 1 });
  });
});
