import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Mutation, insert, schema } from "@/lib/db";
import { VISIT_D1_COLUMNS, visitBindings } from "@/lib/edge/ingest/sql";
import type { BufferedVisitRow } from "@/lib/edge/ingest/types";
import { prepareVisitMutations } from "@/lib/edge/ingest/visit-write-mutations";

function bufferedVisit(
  overrides: Partial<BufferedVisitRow> = {},
): BufferedVisitRow {
  return {
    visitId: "visit-1",
    siteId: "site-1",
    visitorId: "visitor-1",
    sessionId: "session-1",
    status: "complete",
    startedAt: 1,
    lastActivityAt: 2,
    endedAt: 3,
    finalizedAt: 4,
    durationMs: 5,
    durationSource: "client",
    exitReason: "leave",
    pathname: "/docs",
    queryString: "ref=home",
    hashFragment: "#intro",
    hostname: "example.com",
    title: "Docs",
    referrerUrl: "https://ref.example/start",
    referrerHost: "ref.example",
    utmSource: "newsletter",
    utmMedium: "email",
    utmCampaign: "launch",
    utmTerm: "term",
    utmContent: "hero",
    isEU: 0,
    country: "US",
    region: "California",
    regionCode: "CA",
    city: "San Francisco",
    continent: "NA",
    latitude: 37.7,
    longitude: -122.4,
    postalCode: "94105",
    metroCode: "807",
    timezone: "America/Los_Angeles",
    asOrganization: "Example ISP",
    uaRaw: "Mozilla/5.0",
    browser: "Chrome",
    browserVersion: "120",
    os: "macOS",
    osVersion: "14",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    language: "en-US",
    userId: "user-1",
    userName: "Ada",
    perfTtfbMs: 12.3,
    perfFcpMs: 45.6,
    perfLcpMs: 78.9,
    perfCls: 0.123,
    perfInpMs: 111,
    dirty: 1,
    flushAttempts: 0,
    lastFlushError: null,
    nextDueAt: 100,
    flushDueAt: 100,
    bufferRevision: 1,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function execute(
  db: DatabaseSync,
  statement: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(statement.sql)
    .run(...((statement.bindings ?? []) as SQLInputValue[]));
}

function legacyStateSql(row: BufferedVisitRow): string {
  const active = row.status === "open" || row.status === "hidden_pending";
  const columns = active
    ? ["status", "last_activity_at"]
    : [
        "status",
        "last_activity_at",
        "ended_at",
        "finalized_at",
        "duration_ms",
        "duration_source",
        "exit_reason",
      ];
  const assignments = columns.map((column) => `${column} = excluded.${column}`);
  assignments.push("updated_at = excluded.updated_at");
  const differences = columns
    .map((column) => `visits.${column} IS NOT excluded.${column}`)
    .join(" OR ");
  const activeGuard = active
    ? "visits.status IN ('open', 'hidden_pending') AND "
    : "";
  return `INSERT INTO visits (${VISIT_D1_COLUMNS.join(", ")}) VALUES (${VISIT_D1_COLUMNS.map(() => "?").join(", ")}) ON CONFLICT(visit_id) DO UPDATE SET ${assignments.join(", ")} WHERE ${activeGuard}(${differences})`;
}

function legacyDetailStatement(row: BufferedVisitRow) {
  const fields = [
    "user_id",
    "user_name",
    "perf_ttfb_ms",
    "perf_fcp_ms",
    "perf_lcp_ms",
    "perf_cls",
    "perf_inp_ms",
  ] as const;
  const values = [
    row.userId || null,
    row.userName || null,
    row.perfTtfbMs,
    row.perfFcpMs,
    row.perfLcpMs,
    row.perfCls,
    row.perfInpMs,
  ];
  const differences = fields
    .map((field) => `visits.${field} IS NOT ?`)
    .join(" OR ");
  const activeGuard =
    row.status === "open" || row.status === "hidden_pending"
      ? " AND status IN ('open', 'hidden_pending')"
      : "";
  return {
    sql: `UPDATE visits SET ${fields.map((field) => `${field} = ?`).join(", ")}, updated_at = ? WHERE visit_id = ?${activeGuard} AND (${differences})`,
    bindings: [...values, row.updatedAt, row.visitId, ...values],
  };
}

function seedDatabase(
  db: DatabaseSync,
  row: BufferedVisitRow,
  legacy: boolean,
): number {
  execute(
    db,
    compileD1Mutation(insert(schema.site_identities, { site_id: "site-1" })),
  );
  const sitePk = Number(
    (
      db
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get("site-1") as {
        site_pk: number;
      }
    ).site_pk,
  );
  if (legacy) {
    db.prepare(
      `INSERT OR IGNORE INTO visits (${VISIT_D1_COLUMNS.join(", ")}) VALUES (${VISIT_D1_COLUMNS.map(() => "?").join(", ")})`,
    ).run(...(visitBindings(row, sitePk) as SQLInputValue[]));
  } else {
    for (const mutation of prepareVisitMutations(row, sitePk))
      execute(db, mutation);
  }
  db.prepare("UPDATE visits SET ae_synced_at = 88 WHERE visit_id = ?").run(
    row.visitId,
  );
  return sitePk;
}

function applyLegacyGroup(
  db: DatabaseSync,
  row: BufferedVisitRow,
  sitePk: number,
): number[] {
  const state = db
    .prepare(legacyStateSql(row))
    .run(...(visitBindings(row, sitePk) as SQLInputValue[]));
  const detail = legacyDetailStatement(row);
  const details = db
    .prepare(detail.sql)
    .run(...(detail.bindings as SQLInputValue[]));
  return [Number(state.changes), Number(details.changes)];
}

const DIFFERENTIAL_CASES: Array<{
  name: string;
  initial: BufferedVisitRow;
  next: BufferedVisitRow;
  expectedChanges: [number, number];
  expectedUpdatedAt: number;
  expectedSiteId?: string;
}> = [
  {
    name: "active lifecycle and details update independently",
    initial: bufferedVisit({
      status: "open",
      endedAt: null,
      finalizedAt: null,
      durationMs: null,
      durationSource: "",
      exitReason: "",
      userId: "",
      userName: "",
      perfLcpMs: null,
    }),
    next: bufferedVisit({
      status: "hidden_pending",
      lastActivityAt: 9,
      userId: "late-user",
      perfLcpMs: 999,
      updatedAt: 21,
    }),
    expectedChanges: [1, 1],
    expectedUpdatedAt: 21,
  },
  {
    name: "active input cannot reopen a finalized target",
    initial: bufferedVisit({ status: "complete", updatedAt: 20 }),
    next: bufferedVisit({
      status: "open",
      lastActivityAt: 99,
      userId: "late-user",
      updatedAt: 30,
    }),
    expectedChanges: [0, 0],
    expectedUpdatedAt: 20,
  },
  {
    name: "null lifecycle and detail values transition to values",
    initial: bufferedVisit({
      status: "complete",
      endedAt: null,
      finalizedAt: null,
      durationMs: null,
      durationSource: "",
      exitReason: "",
      perfLcpMs: null,
    }),
    next: bufferedVisit({
      status: "complete",
      endedAt: 33,
      finalizedAt: 34,
      durationMs: 32,
      durationSource: "server",
      exitReason: "timeout",
      perfLcpMs: 450,
      updatedAt: 25,
    }),
    expectedChanges: [1, 1],
    expectedUpdatedAt: 25,
  },
  {
    name: "null detail values replace existing values",
    initial: bufferedVisit({
      status: "timeout",
      perfFcpMs: 45,
      userId: "user-1",
    }),
    next: bufferedVisit({
      status: "timeout",
      perfFcpMs: null,
      userId: "",
      updatedAt: 25,
    }),
    expectedChanges: [0, 1],
    expectedUpdatedAt: 25,
  },
  {
    name: "a timestamp-only input is a two-statement no-op",
    initial: bufferedVisit({ status: "complete", updatedAt: 20 }),
    next: bufferedVisit({ status: "complete", updatedAt: 200 }),
    expectedChanges: [0, 0],
    expectedUpdatedAt: 20,
  },
  {
    name: "site and archive columns remain immutable on conflict",
    initial: bufferedVisit({ status: "complete", updatedAt: 20 }),
    next: bufferedVisit({
      siteId: "site-other",
      pathname: "/ignored",
      status: "complete",
      lastActivityAt: 8,
      updatedAt: 21,
    }),
    expectedChanges: [1, 0],
    expectedUpdatedAt: 21,
    expectedSiteId: "site-1",
  },
];

describe("typed visit write mutations", () => {
  it.each(DIFFERENTIAL_CASES)(
    "matches split legacy writes: $name",
    ({ initial, next, expectedChanges, expectedUpdatedAt, expectedSiteId }) => {
      const typedDb = createMigratedDatabase();
      const legacyDb = createMigratedDatabase();
      try {
        const typedSitePk = seedDatabase(typedDb, initial, false);
        const legacySitePk = seedDatabase(legacyDb, initial, true);
        expect(typedSitePk).toBe(legacySitePk);
        expect(
          typedDb
            .prepare("SELECT * FROM visits WHERE visit_id = ?")
            .get(initial.visitId),
        ).toEqual(
          legacyDb
            .prepare("SELECT * FROM visits WHERE visit_id = ?")
            .get(initial.visitId),
        );

        const typedChanges = prepareVisitMutations(next, typedSitePk).map(
          (mutation) => Number(execute(typedDb, mutation).changes),
        );
        const legacyChanges = applyLegacyGroup(legacyDb, next, legacySitePk);
        expect(typedChanges).toEqual(legacyChanges);
        expect(typedChanges).toEqual(expectedChanges);

        const typedRow = typedDb
          .prepare("SELECT * FROM visits WHERE visit_id = ?")
          .get(next.visitId);
        const legacyRow = legacyDb
          .prepare("SELECT * FROM visits WHERE visit_id = ?")
          .get(next.visitId);
        expect(typedRow).toEqual(legacyRow);
        expect(typedRow).toMatchObject({
          updated_at: expectedUpdatedAt,
          ae_synced_at: 88,
          ...(expectedSiteId === undefined ? {} : { site_id: expectedSiteId }),
        });
      } finally {
        typedDb.close();
        legacyDb.close();
      }
    },
  );
});
