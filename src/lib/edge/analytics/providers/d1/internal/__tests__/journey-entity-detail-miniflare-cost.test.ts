import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";

import {
  querySessionsForDetailFromD1,
  queryVisitorForDetailFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-detail-queries";
import type { Env } from "@/lib/edge/types";

const SITE_ID = "journey-miniflare-cost-site";
const TARGET_VISITOR = "journey-miniflare-target-visitor";
const TARGET_SESSION = "journey-miniflare-target-session";
const UNRELATED_ROWS = 1_024;

interface ReadObservation {
  readonly sql: string;
  readonly rowsRead: number | null;
}

interface MeasuredDetails {
  readonly visitor: unknown;
  readonly visitorRowsRead: number;
  readonly sessionsForVisitor: unknown;
  readonly sessionsForVisitorRowsRead: number;
  readonly session: unknown;
  readonly sessionRowsRead: number;
}

function observeD1(database: D1Database) {
  const observations: ReadObservation[] = [];
  const wrapStatement = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "bind")
          return (...values: Parameters<D1PreparedStatement["bind"]>) =>
            wrapStatement(target.bind(...values), sql);
        if (property === "all")
          return async (...args: unknown[]) => {
            const result = (await Reflect.apply(
              Reflect.get(target, property, receiver) as (
                ...input: unknown[]
              ) => unknown,
              target,
              args,
            )) as { readonly meta?: { readonly rows_read?: unknown } };
            const rawRowsRead = result.meta?.rows_read;
            observations.push({
              sql,
              rowsRead:
                typeof rawRowsRead === "number" && Number.isFinite(rawRowsRead)
                  ? Math.max(0, Math.trunc(rawRowsRead))
                  : null,
            });
            return result;
          };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const traced = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare")
        return (sql: string) => wrapStatement(target.prepare(sql), sql);
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: traced as D1Database, observations };
}

async function applySchema(database: D1Database): Promise<void> {
  const sql = readFileSync(resolve(process.cwd(), "docs/schema.sql"), "utf8");
  const statements = unstable_splitSqlQuery(sql).map((statement) =>
    database.prepare(statement),
  );
  const batchLimit = 50;
  for (let index = 0; index < statements.length; index += batchLimit)
    await database.batch(statements.slice(index, index + batchLimit));
}

async function seedVisit(
  database: D1Database,
  input: {
    readonly sitePk: number;
    readonly visitId: string;
    readonly visitorId: string;
    readonly sessionId: string;
    readonly startedAt: number;
    readonly siteId?: string;
  },
): Promise<void> {
  const columns = [
    "visit_id",
    "site_id",
    "visitor_id",
    "session_id",
    "status",
    "started_at",
    "last_activity_at",
    "ended_at",
    "duration_ms",
    "pathname",
    "hostname",
    "user_id",
    "user_name",
    "country",
    "region",
    "region_code",
    "city",
    "referrer_host",
    "referrer_url",
    "browser",
    "browser_version",
    "os",
    "os_version",
    "device_type",
    "screen_width",
    "screen_height",
    "latitude",
    "longitude",
    "site_pk",
  ];
  const values = [
    input.visitId,
    input.siteId ?? SITE_ID,
    input.visitorId,
    input.sessionId,
    "closed",
    input.startedAt,
    input.startedAt,
    null,
    null,
    `/${input.visitId}`,
    "journey-miniflare.fixture",
    null,
    null,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    null,
    null,
    null,
    null,
    input.sitePk,
  ];
  const placeholders = columns.map(() => "?").join(", ");
  await database
    .prepare(
      `INSERT INTO visits (${columns.join(", ")}) VALUES (${placeholders})`,
    )
    .bind(...values)
    .run();
}

async function insertUnrelatedRows(
  database: D1Database,
  sitePk: number,
  offset: number,
): Promise<void> {
  const visitColumns = [
    "visit_id",
    "site_id",
    "visitor_id",
    "session_id",
    "status",
    "started_at",
    "last_activity_at",
    "ended_at",
    "duration_ms",
    "pathname",
    "hostname",
    "user_id",
    "user_name",
    "country",
    "region",
    "region_code",
    "city",
    "referrer_host",
    "referrer_url",
    "browser",
    "browser_version",
    "os",
    "os_version",
    "device_type",
    "screen_width",
    "screen_height",
    "latitude",
    "longitude",
    "site_pk",
  ];
  const visitRows: unknown[][] = [];
  const eventRows: unknown[][] = [];
  for (let index = 0; index < UNRELATED_ROWS; index += 1) {
    const row = offset + index;
    const visitId = `journey-unrelated-visit-${row}`;
    const visitorId = `journey-unrelated-visitor-${row}`;
    const sessionId = `journey-unrelated-session-${row}`;
    const startedAt = 10_000 + row;
    visitRows.push([
      visitId,
      SITE_ID,
      visitorId,
      sessionId,
      "closed",
      startedAt,
      startedAt,
      null,
      null,
      `/${visitId}`,
      "journey-miniflare.fixture",
      null,
      null,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      null,
      null,
      null,
      null,
      sitePk,
    ]);
    eventRows.push([
      `journey-unrelated-event-${row}`,
      SITE_ID,
      visitId,
      1,
      startedAt,
      startedAt,
      sitePk,
    ]);
  }
  const visitExtracts = visitColumns.map(
    (_column, index) => `json_extract(value, '$[${index}]')`,
  );
  await database
    .prepare(
      `INSERT INTO visits (${visitColumns.join(", ")}) SELECT ${visitExtracts.join(", ")} FROM json_each(?)`,
    )
    .bind(JSON.stringify(visitRows))
    .run();
  await database
    .prepare(
      "INSERT INTO custom_events (event_id, site_id, visit_id, event_name_id, occurred_at, received_at, node_count, value_count, site_pk) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'), 0, 0, json_extract(value, '$[6]') FROM json_each(?)",
    )
    .bind(JSON.stringify(eventRows))
    .run();
}

async function seedDatabase(database: D1Database) {
  await database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .bind(SITE_ID)
    .run();
  const site = await database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .bind(SITE_ID)
    .first<{ readonly site_pk: number }>();
  if (!site) throw new Error("miniflare_test_site_missing");

  await database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(1, SITE_ID, "click", 20, site.site_pk)
    .run();
  await seedVisit(database, {
    sitePk: site.site_pk,
    visitId: "journey-target-visit-1",
    visitorId: TARGET_VISITOR,
    sessionId: TARGET_SESSION,
    startedAt: 10,
  });
  await seedVisit(database, {
    sitePk: site.site_pk,
    visitId: "journey-target-visit-2",
    visitorId: TARGET_VISITOR,
    sessionId: "journey-target-session-2",
    startedAt: 20,
  });
  for (const [visitId, eventId, timestamp] of [
    ["journey-target-visit-1", "journey-target-event-1", 10],
    ["journey-target-visit-2", "journey-target-event-2", 20],
  ] as const)
    await database
      .prepare(
        "INSERT INTO custom_events (event_id, site_id, visit_id, event_name_id, occurred_at, received_at, node_count, value_count, site_pk) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)",
      )
      .bind(eventId, SITE_ID, visitId, 1, timestamp, timestamp, site.site_pk)
      .run();
  return site.site_pk;
}

async function readCountFor(
  observations: ReadObservation[],
  run: () => Promise<unknown>,
): Promise<{ readonly value: unknown; readonly rowsRead: number }> {
  observations.length = 0;
  const value = await run();
  expect(observations).toHaveLength(1);
  const rowsRead = observations[0]?.rowsRead;
  if (rowsRead === null || rowsRead === undefined)
    throw new Error("miniflare_rows_read_unavailable");
  return { value, rowsRead };
}

async function measureDetails(database: D1Database): Promise<MeasuredDetails> {
  const traced = observeD1(database);
  const env = { DB: traced.database } as Env;
  const visitor = await readCountFor(traced.observations, () =>
    queryVisitorForDetailFromD1(env, SITE_ID, TARGET_VISITOR),
  );
  const sessionsForVisitor = await readCountFor(traced.observations, () =>
    querySessionsForDetailFromD1(env, SITE_ID, {
      type: "visitor",
      value: TARGET_VISITOR,
    }),
  );
  const session = await readCountFor(traced.observations, () =>
    querySessionsForDetailFromD1(env, SITE_ID, {
      type: "session",
      value: TARGET_SESSION,
    }),
  );
  return {
    visitor: visitor.value,
    visitorRowsRead: visitor.rowsRead,
    sessionsForVisitor: sessionsForVisitor.value,
    sessionsForVisitorRowsRead: sessionsForVisitor.rowsRead,
    session: session.value,
    sessionRowsRead: session.rowsRead,
  };
}

describe("Journey entity detail D1 cost in Miniflare", () => {
  it("keeps all three production readers stable after 1,024 unrelated page and event rows", async () => {
    const configDirectory = mkdtempSync(
      join(tmpdir(), "journey-detail-miniflare-"),
    );
    const configPath = join(configDirectory, "wrangler.toml");
    writeFileSync(
      configPath,
      [
        'name = "journey-detail-cost-test"',
        'compatibility_date = "2026-03-01"',
        "[[d1_databases]]",
        'binding = "DB"',
        'database_name = "journey_detail_cost_test"',
        'database_id = "local-test"',
        "",
      ].join("\n"),
    );
    let disposePlatform: (() => Promise<void>) | undefined;
    try {
      const platform = await getPlatformProxy<Env>({
        configPath,
        envFiles: [],
        persist: false,
        remoteBindings: false,
      });
      disposePlatform = platform.dispose;
      await applySchema(platform.env.DB);
      const sitePk = await seedDatabase(platform.env.DB);
      const baseline = await measureDetails(platform.env.DB);
      expect(baseline.visitor).toMatchObject({
        visitorId: TARGET_VISITOR,
        views: 2,
        sessions: 2,
        events: 2,
      });
      expect(baseline.sessionsForVisitor).toHaveLength(2);
      expect(baseline.session).toHaveLength(1);

      await insertUnrelatedRows(platform.env.DB, sitePk, 0);
      const grown = await measureDetails(platform.env.DB);
      expect(grown.visitor).toEqual(baseline.visitor);
      expect(grown.sessionsForVisitor).toEqual(baseline.sessionsForVisitor);
      expect(grown.session).toEqual(baseline.session);
      expect(
        grown.visitorRowsRead - baseline.visitorRowsRead,
      ).toBeLessThanOrEqual(2);
      expect(
        grown.sessionsForVisitorRowsRead - baseline.sessionsForVisitorRowsRead,
      ).toBeLessThanOrEqual(2);
      expect(
        grown.sessionRowsRead - baseline.sessionRowsRead,
      ).toBeLessThanOrEqual(2);
      expect(baseline.visitorRowsRead).toBeLessThan(100);
      expect(baseline.sessionsForVisitorRowsRead).toBeLessThan(125);
      expect(baseline.sessionRowsRead).toBeLessThan(60);
    } finally {
      await disposePlatform?.();
      unlinkSync(configPath);
      rmdirSync(configDirectory);
    }
  }, 120_000);
});
