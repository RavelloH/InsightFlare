import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { VisitBindingRow } from "@/lib/edge/ingest-sql";
import {
  CREATE_BUFFERED_CUSTOM_EVENTS_SQL,
  INSERT_VISIT_SQL,
  UPSERT_ACTIVE_VISIT_SQL,
  UPSERT_FINALIZED_VISIT_SQL,
  VISIT_D1_COLUMNS,
  visitBindings,
  visitUpsertSql,
} from "@/lib/edge/ingest-sql";

function visitRow(overrides: Partial<VisitBindingRow> = {}): VisitBindingRow {
  return {
    visitId: "visit-1",
    siteId: "site-1",
    visitorId: "visitor-1",
    sessionId: "session-1",
    status: "closed",
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
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

describe("ingest visit SQL bindings", () => {
  it("keeps visit binding order aligned with D1 columns", () => {
    const row = visitRow();
    const bindings = visitBindings(row);

    expect(bindings).toHaveLength(VISIT_D1_COLUMNS.length);
    expect(
      Object.fromEntries(
        VISIT_D1_COLUMNS.map((column, index) => [column, bindings[index]]),
      ),
    ).toMatchObject({
      visit_id: "visit-1",
      site_id: "site-1",
      status: "closed",
      started_at: 1,
      duration_source: "client",
      exit_reason: "leave",
      pathname: "/docs",
      query_string: "ref=home",
      perf_ttfb_ms: 12.3,
      perf_fcp_ms: 45.6,
      perf_lcp_ms: 78.9,
      perf_cls: 0.123,
      perf_inp_ms: 111,
      ae_synced_at: null,
      created_at: 10,
      updated_at: 20,
    });
  });

  it("stores blank optional strings as null for D1 visit rows", () => {
    const values = Object.fromEntries(
      VISIT_D1_COLUMNS.map((column, index) => [
        column,
        visitBindings(
          visitRow({
            durationSource: "",
            exitReason: "",
            userId: "",
            userName: "",
          }),
        )[index],
      ]),
    );

    expect(values.duration_source).toBeNull();
    expect(values.exit_reason).toBeNull();
    expect(values.user_id).toBeNull();
    expect(values.user_name).toBeNull();
  });

  it("keeps visit SQL columns and split upsert assignments in sync", () => {
    expect(INSERT_VISIT_SQL).toContain("INSERT OR IGNORE INTO visits");
    for (const column of VISIT_D1_COLUMNS) {
      expect(INSERT_VISIT_SQL).toContain(column);
    }
    expect(UPSERT_ACTIVE_VISIT_SQL).toContain(
      "ON CONFLICT(visit_id) DO UPDATE SET",
    );
    expect(UPSERT_ACTIVE_VISIT_SQL).toContain(
      "visits.status IN ('open', 'hidden_pending')",
    );
    expect(UPSERT_ACTIVE_VISIT_SQL).not.toContain(
      "ended_at = excluded.ended_at",
    );
    expect(UPSERT_FINALIZED_VISIT_SQL).toContain(
      "ended_at = excluded.ended_at",
    );
    expect(UPSERT_FINALIZED_VISIT_SQL).toContain(
      "duration_ms = excluded.duration_ms",
    );
    expect(UPSERT_FINALIZED_VISIT_SQL).toContain(
      "perf_ttfb_ms = excluded.perf_ttfb_ms",
    );
    expect(UPSERT_FINALIZED_VISIT_SQL).toContain(
      "perf_fcp_ms = excluded.perf_fcp_ms",
    );
    expect(UPSERT_FINALIZED_VISIT_SQL).toContain(
      "perf_lcp_ms = excluded.perf_lcp_ms",
    );
    expect(UPSERT_FINALIZED_VISIT_SQL).toContain(
      "perf_cls = excluded.perf_cls",
    );
    expect(UPSERT_FINALIZED_VISIT_SQL).toContain(
      "perf_inp_ms = excluded.perf_inp_ms",
    );
    expect(UPSERT_FINALIZED_VISIT_SQL).not.toContain(
      "site_id = excluded.site_id",
    );
    expect(UPSERT_FINALIZED_VISIT_SQL).not.toContain(
      "ae_synced_at = excluded.ae_synced_at",
    );
    expect(UPSERT_FINALIZED_VISIT_SQL).toContain("WHERE");
    expect(UPSERT_FINALIZED_VISIT_SQL).toContain(
      "visits.perf_lcp_ms IS NOT excluded.perf_lcp_ms",
    );
    expect(visitUpsertSql("open")).toBe(UPSERT_ACTIVE_VISIT_SQL);
    expect(visitUpsertSql("hidden_pending")).toBe(UPSERT_ACTIVE_VISIT_SQL);
    expect(visitUpsertSql("complete")).toBe(UPSERT_FINALIZED_VISIT_SQL);
    expect(visitUpsertSql("timeout")).toBe(UPSERT_FINALIZED_VISIT_SQL);
  });

  it("updates only lifecycle fields while retaining immutable and archive state", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE visits (
        ${VISIT_D1_COLUMNS.map((column) =>
          column === "visit_id"
            ? "visit_id TEXT PRIMARY KEY"
            : `${column} BLOB`,
        ).join(",\n")}
      )
    `);
    const activeStatement = db.prepare(UPSERT_ACTIVE_VISIT_SQL);
    const finalizedStatement = db.prepare(UPSERT_FINALIZED_VISIT_SQL);

    try {
      const initial = visitRow({
        status: "open",
        endedAt: null,
        finalizedAt: null,
        durationMs: null,
        durationSource: "",
        exitReason: "",
        perfLcpMs: null,
        updatedAt: 20,
      });
      expect(activeStatement.run(...visitBindings(initial)).changes).toBe(1);

      db.prepare("UPDATE visits SET ae_synced_at = ? WHERE visit_id = ?").run(
        123,
        initial.visitId,
      );
      expect(
        activeStatement.run(
          ...visitBindings({ ...initial, updatedAt: initial.updatedAt + 1 }),
        ).changes,
      ).toBe(0);

      expect(
        activeStatement.run(
          ...visitBindings({
            ...initial,
            siteId: "site-should-not-change",
            pathname: "/should-not-change",
            lastActivityAt: initial.lastActivityAt + 1,
            perfLcpMs: 2500,
            updatedAt: initial.updatedAt + 2,
          }),
        ).changes,
      ).toBe(1);
      expect(
        finalizedStatement.run(
          ...visitBindings({
            ...initial,
            status: "complete",
            lastActivityAt: 3,
            endedAt: 3,
            finalizedAt: 4,
            durationMs: 2,
            durationSource: "server",
            exitReason: "pagehide",
            perfLcpMs: 2500,
            userId: "user-late",
            userName: "Ada",
            updatedAt: initial.updatedAt + 3,
          }),
        ).changes,
      ).toBe(1);
      expect(
        db
          .prepare(
            "SELECT site_id AS siteId, pathname, status, ended_at AS endedAt, duration_ms AS durationMs, perf_lcp_ms AS perfLcpMs, user_id AS userId, user_name AS userName, ae_synced_at AS aeSyncedAt FROM visits WHERE visit_id = ?",
          )
          .get(initial.visitId),
      ).toEqual({
        siteId: "site-1",
        pathname: "/docs",
        status: "complete",
        endedAt: 3,
        durationMs: 2,
        perfLcpMs: 2500,
        userId: "user-late",
        userName: "Ada",
        aeSyncedAt: 123,
      });

      expect(
        activeStatement.run(
          ...visitBindings({
            ...initial,
            lastActivityAt: 10,
            updatedAt: initial.updatedAt + 4,
          }),
        ).changes,
      ).toBe(0);
      expect(
        finalizedStatement.run(
          ...visitBindings({
            ...initial,
            status: "complete",
            lastActivityAt: 3,
            endedAt: 3,
            finalizedAt: 4,
            durationMs: 2,
            durationSource: "server",
            exitReason: "pagehide",
            perfLcpMs: 2500,
            userId: "user-late",
            userName: "Ada",
            updatedAt: initial.updatedAt + 5,
          }),
        ).changes,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("defines buffered custom event schema fields used by flush bookkeeping", () => {
    expect(CREATE_BUFFERED_CUSTOM_EVENTS_SQL).toContain("user_id TEXT");
    expect(CREATE_BUFFERED_CUSTOM_EVENTS_SQL).toContain("dirty INTEGER");
    expect(CREATE_BUFFERED_CUSTOM_EVENTS_SQL).toContain(
      "flush_attempts INTEGER",
    );
    expect(CREATE_BUFFERED_CUSTOM_EVENTS_SQL).toContain(
      "last_flush_error TEXT",
    );
  });
});
