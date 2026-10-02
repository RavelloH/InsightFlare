import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  lowerLogicalPlan,
} from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";

const SITE_ID = "keyed-scalar-lowering-site";
const STRING = { kind: "scalar", scalar: "string" } as const;

const databases = new Set<DatabaseSync>();

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  return database;
}

function seedFixture(database: DatabaseSync): void {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const site = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  const insert = database.prepare(`
    INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, duration_ms, pathname, hostname, user_id, site_pk
    ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, 'keyed.test', ?, ?)
  `);
  const rows = [
    ["a-left", "visitor-a", "session-a", 10, "/left", "user-a", 3],
    ["a-left-2", "visitor-a", "session-a", 13, "/left", "user-a", 2],
    ["a-right-1", "visitor-a", "session-a", 11, "/right", "user-a", 0],
    ["a-right-2", "visitor-a", "session-a", 12, "/right", "user-a", null],
    ["b-left", "visitor-b", "session-b", 20, "/left", "user-b", 4],
    ["b-decoy", "visitor-b", "session-b2", 21, "/right", "user-b2", 5],
    ["c-left", "visitor-c", "session-c", 30, "/left", null, 6],
    ["c-null-key", "visitor-c", "session-c2", 31, "/right", null, 7],
    ["d-left", "visitor-d", "session-d", 40, "/left", "user-d", 8],
    ["d-null-measure", "visitor-d", "session-d2", 41, "/right", "user-d", null],
  ] as const;
  for (const [
    id,
    visitor,
    session,
    startedAt,
    pathname,
    userId,
    duration,
  ] of rows)
    insert.run(
      id,
      SITE_ID,
      visitor,
      session,
      startedAt,
      startedAt,
      duration,
      pathname,
      userId,
      site.site_pk,
    );
}

function createPlan() {
  const builder = new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID as never],
    }),
    time: createSemanticTemporalDomains({
      candidate: {
        startMs: 0 as never,
        endExclusiveMs: 1 as never,
      },
      read: { kind: "retained-history" },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 0 as never,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
  const leftPages = builder.source("page", {
    temporalDomain: "read",
    attributes: [
      "page.report.localId",
      "page.report.visitorId",
      "page.report.userId",
      "page.report.pathname",
      "page.report.durationMs",
      "page.report.status",
    ],
  });
  const leftInput = builder.filter(
    leftPages,
    builder.compare(
      "eq",
      builder.slot(leftPages, "attribute:page.report.pathname"),
      builder.literal("/left", STRING),
    ),
  );
  const caseFoldedPages = builder.filter(
    leftPages,
    builder.compare(
      "eq",
      builder.slot(leftPages, "attribute:page.report.status"),
      builder.literal("OPEN", STRING),
      "ascii-case-fold",
    ),
  );
  const caseFoldedRows = builder.project(caseFoldedPages, {
    localId: builder.slot(caseFoldedPages, "attribute:page.report.localId"),
  });
  const left = builder.aggregate(
    leftInput,
    {
      visitorId: builder.slot(leftInput, "attribute:page.report.visitorId"),
      userId: builder.slot(leftInput, "attribute:page.report.userId"),
    },
    [{ name: "leftCount", kind: "count-rows" }],
  );

  const rightPages = builder.source("page", {
    temporalDomain: "read",
    attributes: [
      "page.report.visitorId",
      "page.report.userId",
      "page.report.pathname",
      "page.report.durationMs",
    ],
  });
  const rightInput = builder.filter(
    rightPages,
    builder.compare(
      "eq",
      builder.slot(rightPages, "attribute:page.report.pathname"),
      builder.literal("/right", STRING),
    ),
  );
  const right = builder.aggregate(
    rightInput,
    {
      visitorId: builder.slot(rightInput, "attribute:page.report.visitorId"),
      userId: builder.slot(rightInput, "attribute:page.report.userId"),
    },
    [
      { name: "rightCount", kind: "count-rows" },
      {
        name: "rightDuration",
        kind: "sum",
        expression: builder.slot(
          rightInput,
          "attribute:page.report.durationMs",
        ),
      },
    ],
  );
  const keys = [
    { left: "visitorId", right: "visitorId" },
    { left: "userId", right: "userId" },
  ] as const;
  const leftJoin = builder.join(left, right, keys, "left");
  const innerJoin = builder.join(left, right, keys, "inner");
  const leftRows = builder.sort(leftJoin, [
    { slot: "visitorId", direction: "asc", nulls: "first" },
    { slot: "userId", direction: "asc", nulls: "first" },
  ]);
  const allRows = builder.project(leftRows, {
    visitorId: builder.slot(leftRows, "visitorId"),
    userId: builder.slot(leftRows, "userId"),
    leftCount: builder.slot(leftRows, "leftCount"),
    rightCount: builder.slot(leftRows, "right.rightCount"),
    rightDuration: builder.slot(leftRows, "right.rightDuration"),
  });
  const leftOnly = builder.project(leftRows, {
    leftCount: builder.slot(leftRows, "leftCount"),
  });
  const rightOnly = builder.project(leftRows, {
    rightCount: builder.slot(leftRows, "right.rightCount"),
  });
  const constantOnly = builder.project(leftRows, {
    constant: builder.literal("kept", STRING),
  });
  const matched = builder.sort(innerJoin, [
    { slot: "visitorId", direction: "asc", nulls: "first" },
    { slot: "userId", direction: "asc", nulls: "first" },
  ]);
  const innerRows = builder.project(matched, {
    visitorId: builder.slot(matched, "visitorId"),
    userId: builder.slot(matched, "userId"),
    rightCount: builder.slot(matched, "right.rightCount"),
  });

  builder.output("left-all", allRows, [
    { name: "visitorId", slot: "visitorId" },
    { name: "userId", slot: "userId" },
    { name: "leftCount", slot: "leftCount" },
    { name: "rightCount", slot: "rightCount" },
    { name: "rightDuration", slot: "rightDuration" },
  ]);
  builder.output("ascii-case-fold", caseFoldedRows, [
    { name: "localId", slot: "localId" },
  ]);
  builder.output("left-a", leftOnly, [
    { name: "leftCount", slot: "leftCount" },
  ]);
  builder.output("right-only", rightOnly, [
    { name: "rightCount", slot: "rightCount" },
  ]);
  builder.output("constant-only", constantOnly, [
    { name: "constant", slot: "constant" },
  ]);
  builder.output("inner", innerRows, [
    { name: "visitorId", slot: "visitorId" },
    { name: "userId", slot: "userId" },
    { name: "rightCount", slot: "rightCount" },
  ]);
  builder.output("left-a-again", leftOnly, [
    { name: "leftCount", slot: "leftCount" },
  ]);
  return builder.finish();
}

function createLowerer(plan: ReturnType<typeof createPlan>) {
  return new AnalyticsLogicalToDbLowerer(plan, {
    siteId: SITE_ID,
    time: plan.context.time,
  });
}

async function readOutput(
  database: DatabaseSync,
  lowerer: AnalyticsLogicalToDbLowerer,
  output: LogicalOutput,
): Promise<object[]> {
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const query = compileD1Query(lowerLogicalPlan(relation));
  const result = await createD1DatabaseClient(
    createSqliteD1Database(database),
  ).all(query);
  return result.results;
}

afterAll(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("keyed scalar join D1 lowering", () => {
  it("preserves complete-key NULL semantics, left rows, value slots, and per-output demand", async () => {
    const database = createFixture();
    seedFixture(database);
    const plan = createPlan();
    const lowerer = createLowerer(plan);
    const output = (id: string) => plan.outputs.find((item) => item.id === id)!;

    const firstA = await readOutput(database, lowerer, output("left-a"));
    const rightOnly = await readOutput(database, lowerer, output("right-only"));
    const secondA = await readOutput(database, lowerer, output("left-a-again"));
    expect(firstA).toEqual([
      { leftCount: 2 },
      { leftCount: 1 },
      { leftCount: 1 },
      { leftCount: 1 },
    ]);
    expect(secondA).toEqual(firstA);
    expect(rightOnly).toEqual([
      { rightCount: 2 },
      { rightCount: null },
      { rightCount: null },
      { rightCount: 1 },
    ]);

    const allRows = await readOutput(database, lowerer, output("left-all"));
    expect(allRows).toEqual([
      {
        visitorId: "visitor-a",
        userId: "user-a",
        leftCount: 2,
        rightCount: 2,
        rightDuration: 0,
      },
      {
        visitorId: "visitor-b",
        userId: "user-b",
        leftCount: 1,
        rightCount: null,
        rightDuration: null,
      },
      {
        visitorId: "visitor-c",
        userId: null,
        leftCount: 1,
        rightCount: null,
        rightDuration: null,
      },
      {
        visitorId: "visitor-d",
        userId: "user-d",
        leftCount: 1,
        rightCount: 1,
        rightDuration: null,
      },
    ]);
    expect(
      await readOutput(database, lowerer, output("constant-only")),
    ).toEqual([
      { constant: "kept" },
      { constant: "kept" },
      { constant: "kept" },
      { constant: "kept" },
    ]);
    expect(await readOutput(database, lowerer, output("inner"))).toEqual([
      { visitorId: "visitor-a", userId: "user-a", rightCount: 2 },
      { visitorId: "visitor-d", userId: "user-d", rightCount: 1 },
    ]);
  });

  it("folds ASCII case in literal and stored string values", async () => {
    const database = createFixture();
    seedFixture(database);
    database
      .prepare("UPDATE visits SET status = 'Open' WHERE visit_id = ?")
      .run("a-left");
    const plan = createPlan();
    const output = plan.outputs.find((item) => item.id === "ascii-case-fold")!;

    expect(await readOutput(database, createLowerer(plan), output)).toEqual([
      { localId: "a-left" },
    ]);
  });
});
