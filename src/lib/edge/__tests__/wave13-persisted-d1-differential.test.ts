import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  D1_MAX_BOUND_PARAMETERS,
  type DatabaseOperation,
  type DatabaseQueryObservation,
  registerDatabaseQueryObserver,
} from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  listTeamSites,
  queryTeamSitesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/team";
import {
  findRecentVisitorSession,
  readPersistedVisitRow,
} from "@/lib/edge/ingest/buffer-store";
import { customEventDictionaryIdQuery } from "@/lib/edge/ingest/custom-event-dictionary-queries";
import { flushCustomEventRowIndividually } from "@/lib/edge/ingest/custom-event-flush";
import type { IngestFlushContext } from "@/lib/edge/ingest/flush-types";
import { resolveSitePk } from "@/lib/edge/ingest/flush-types";
import type {
  BufferedCustomEventRow,
  RecentVisitorSession,
} from "@/lib/edge/ingest/types";
import { runDatabaseMaintenance } from "@/lib/edge/scheduled-tasks/database-maintenance";
import type { Env } from "@/lib/edge/types";

const NOW_MS = Date.UTC(2026, 9, 1, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const databases = new Set<DatabaseSync>();

interface QueryObservationFixture {
  readonly operation: DatabaseOperation;
  readonly statementCount: number;
}

function createFixture() {
  const database = createMigratedDatabase();
  databases.add(database);
  database.function("unixepoch", () => NOW_SECONDS);
  database.exec("PRAGMA foreign_keys = ON");
  database
    .prepare(
      "INSERT INTO users (id, email, name, username) VALUES (?, ?, ?, ?)",
    )
    .run("owner-1", "owner@example.test", "Owner", "owner");
  const insertTeam = database.prepare(
    "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
  );
  insertTeam.run("team-1", "Team One", "team-one", "owner-1");
  insertTeam.run("team-2", "Team Two", "team-two", "owner-1");
  const insertSite = database.prepare(
    "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertSite.run("site-1", "team-1", "One", "one.example.test", 20);
  insertSite.run("site-z", "team-1", "Zed", "z.example.test", 20);
  insertSite.run("site-old", "team-1", "Old", "old.example.test", 10);
  insertSite.run("site-other-team", "team-2", "Other", "other.test", 30);
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)")
    .run("site-1", "site-z");
  const siteOnePk = Number(
    database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get("site-1")?.site_pk,
  );
  const siteZPk = Number(
    database
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get("site-z")?.site_pk,
  );
  const trace: SqliteD1Trace = {
    preparedSql: [],
    bindings: [],
    batchStatements: [],
  };
  const databaseBinding = createSqliteD1Database(database, trace);
  const observations: DatabaseQueryObservation[] = [];
  const operations: QueryObservationFixture[] = [];
  registerDatabaseQueryObserver(databaseBinding, {
    begin({ operation, statementCount }) {
      operations.push({ operation, statementCount });
      return {
        statementIndexes: Array.from(
          { length: Math.min(statementCount, 32) },
          (_unused, index) => index,
        ),
        includeBatchSummary: operation === "batch",
        record(event) {
          observations.push(event);
        },
        release() {},
      };
    },
  });
  const env = {
    MAIN_SECRET: "wave13-persisted-query-fixture-secret",
    DB: databaseBinding,
  } as Env;
  return {
    database,
    env,
    trace,
    observations,
    operations,
    siteOnePk,
    siteZPk,
  };
}

function insertVisit(
  database: DatabaseSync,
  input: {
    visitId: string;
    siteId?: string;
    sitePk?: number;
    visitorId?: string;
    sessionId?: string;
    status?: string;
    startedAt?: number;
    lastActivityAt?: number;
    hostname?: string;
    pathname?: string;
    queryString?: string;
    hashFragment?: string;
    userId?: string | null;
    userName?: string | null;
  },
) {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, hostname, pathname, query_string,
        hash_fragment, user_id, user_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.visitId,
      input.siteId ?? "site-1",
      input.sitePk ?? 1,
      input.visitorId ?? "visitor-1",
      input.sessionId ?? `session-${input.visitId}`,
      input.status ?? "open",
      input.startedAt ?? 100,
      input.lastActivityAt ?? 100,
      input.hostname ?? "example.test",
      input.pathname ?? "/",
      input.queryString ?? "",
      input.hashFragment ?? "",
      input.userId ?? null,
      input.userName ?? null,
    );
}

function bufferContext(
  env: Env,
  sqlOne: (
    query: string,
    ...bindings: Array<string | number | null>
  ) => unknown = () => null,
) {
  return {
    env: { DB: env.DB },
    sqlAll: vi.fn(() => []),
    sqlOne: vi.fn(sqlOne),
    sqlRun: vi.fn(() => 1),
  } as unknown as Parameters<typeof findRecentVisitorSession>[0];
}

function explain(
  database: DatabaseSync,
  sql: string,
  bindings: SQLInputValue[],
) {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...bindings)
    .map((row) => String(row.detail ?? ""))
    .join("\n");
}

function legacyRecentSession(
  database: DatabaseSync,
  input: {
    readonly siteId: string;
    readonly visitorId: string;
    readonly visitId: string;
    readonly cutoff: number;
    readonly routeMatchEnabled: number;
    readonly routePreviousHostname: string;
    readonly routePreviousPathname: string;
    readonly routePreviousQueryString: string;
    readonly routePreviousHashFragment: string;
  },
) {
  return database
    .prepare(
      `SELECT
        session_id AS sessionId,
        visit_id AS visitId,
        status,
        CASE
          WHEN ? = 1 AND status IN ('open', 'hidden_pending')
            AND hostname = ? AND pathname = ?
            AND query_string = ? AND hash_fragment = ? THEN 2
          WHEN ? = 1 AND status IN ('open', 'hidden_pending')
            AND hostname = ? AND pathname = ?
            AND (query_string = ? OR query_string = '' OR ? = '')
            AND (hash_fragment = ? OR hash_fragment = '' OR ? = '') THEN 1
          ELSE 0
        END AS routeMatch,
        started_at AS startedAt,
        last_activity_at AS lastActivityAt
      FROM visits
      WHERE site_pk = (SELECT site_pk FROM site_identities WHERE site_id = ? LIMIT 1)
        AND visitor_id = ? AND visit_id != ? AND session_id != ''
        AND last_activity_at >= ?
      ORDER BY routeMatch DESC,
        CASE WHEN status IN ('open', 'hidden_pending') THEN 0 ELSE 1 END,
        last_activity_at DESC, started_at DESC
      LIMIT 1`,
    )
    .get(
      input.routeMatchEnabled,
      input.routePreviousHostname,
      input.routePreviousPathname,
      input.routePreviousQueryString,
      input.routePreviousHashFragment,
      input.routeMatchEnabled,
      input.routePreviousHostname,
      input.routePreviousPathname,
      input.routePreviousQueryString,
      input.routePreviousQueryString,
      input.routePreviousHashFragment,
      input.routePreviousHashFragment,
      input.siteId,
      input.visitorId,
      input.visitId,
      input.cutoff,
    );
}

function observationCount(
  observations: DatabaseQueryObservation[],
  tag: string,
): number {
  return observations.filter((event) => event.tag === tag).length;
}

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases) database.close();
  databases.clear();
});

describe("Wave 13 persisted D1 typed-query differential", () => {
  it("preserves team-site empty scope, cross-team filtering, tie cursors, and long membership budgets", async () => {
    const { database, env, trace, observations, operations } = createFixture();
    const diagnostics = createD1ReadDiagnostics();
    const beforeEmpty = trace.preparedSql.length;
    await expect(
      queryTeamSitesPageFromD1(env, "team-1", 2, null, [], diagnostics),
    ).resolves.toEqual({ rows: [], nextCursor: null });
    expect(trace.preparedSql).toHaveLength(beforeEmpty);

    const listed = await listTeamSites(env, "team-1", diagnostics);
    expect(listed.map((site) => site.id)).toEqual(
      database
        .prepare(
          "SELECT id FROM sites WHERE team_id = ? ORDER BY created_at DESC",
        )
        .all("team-1")
        .map((row) => String(row.id)),
    );
    const first = await queryTeamSitesPageFromD1(
      env,
      "team-1",
      1,
      null,
      undefined,
      diagnostics,
    );
    const allowList = [
      "site-1",
      "site-z",
      "site-old",
      "site-other-team",
      ...Array.from(
        { length: D1_MAX_BOUND_PARAMETERS + 12 },
        (_unused, index) => `not-present-${index}`,
      ),
      "untrusted-'site-value",
    ];
    const second = await queryTeamSitesPageFromD1(
      env,
      "team-1",
      2,
      first.nextCursor,
      allowList,
      diagnostics,
    );
    await vi.waitFor(() => expect(observations).toHaveLength(3));
    const expectedSecond = database
      .prepare(
        `SELECT id, team_id AS teamId, name, domain,
                public_enabled AS publicEnabled, public_slug AS publicSlug,
                created_at AS createdAt, updated_at AS updatedAt
         FROM sites WHERE team_id = ? AND id IN (${allowList.map(() => "?").join(",")})
           AND (created_at < ? OR (created_at = ? AND id > ?))
         ORDER BY created_at DESC, id ASC LIMIT ?`,
      )
      .all(
        "team-1",
        ...allowList,
        first.nextCursor!.createdAt,
        first.nextCursor!.createdAt,
        first.nextCursor!.id,
        2,
      );
    expect(second.rows).toEqual(expectedSecond.slice(0, 2));
    expect(second.rows.map((site) => site.id)).toEqual(["site-z", "site-old"]);
    expect(second.nextCursor).toBeNull();
    expect(trace.preparedSql.at(-1)).toContain("json_each(");
    expect(trace.bindings.at(-1)).toHaveLength(6);
    expect(trace.preparedSql.at(-1)).not.toContain("untrusted-'site-value");
    expect(operations.map(({ operation }) => operation)).toEqual([
      "all",
      "all",
      "all",
    ]);
    expect(diagnostics.rowsReadAvailable).toBe(false);
    expect(diagnostics.rowsRead).toBe(0);
    expect(
      observations.filter(({ operation }) => operation === "all"),
    ).toHaveLength(3);

    const teamPlan = explain(
      database,
      trace.preparedSql.at(-1)!,
      trace.bindings.at(-1) ?? [],
    );
    expect(teamPlan).toContain("idx_sites_team");
  });

  it("matches legacy persisted-session route ranks and preserves the local-first and failure fallbacks", async () => {
    const { database, env, trace, operations, siteZPk } = createFixture();
    insertVisit(database, {
      visitId: "session-current",
      lastActivityAt: 2_000,
    });
    insertVisit(database, {
      visitId: "route-exact",
      sessionId: "session-exact",
      startedAt: 700,
      lastActivityAt: 1_000,
      queryString: "q=1",
      hashFragment: "#one",
    });
    insertVisit(database, {
      visitId: "route-compatible",
      sessionId: "session-compatible",
      startedAt: 900,
      lastActivityAt: 1_500,
      queryString: "",
      hashFragment: "#one",
    });
    insertVisit(database, {
      visitId: "route-other",
      sessionId: "session-other",
      startedAt: 1_500,
      lastActivityAt: 1_800,
      pathname: "/other",
    });
    insertVisit(database, {
      visitId: "empty-session",
      sessionId: "",
      lastActivityAt: 2_100,
    });
    insertVisit(database, {
      visitId: "wrong-site",
      siteId: "site-z",
      sitePk: siteZPk,
      visitorId: "visitor-1",
      sessionId: "wrong-site-session",
      lastActivityAt: 2_200,
    });
    insertVisit(database, {
      visitId: "old-session",
      sessionId: "old-session-id",
      lastActivityAt: 100,
    });
    const input = {
      siteId: "site-1",
      visitorId: "visitor-1",
      visitId: "session-current",
      startedAt: 2_000,
      sessionWindowMs: 1_000,
      routePreviousHostname: "example.test",
      routePreviousPathname: "/",
      routePreviousQueryString: "q=1",
      routePreviousHashFragment: "#one",
    };
    const directInput = {
      siteId: input.siteId,
      visitorId: input.visitorId,
      visitId: input.visitId,
      cutoff: input.startedAt - input.sessionWindowMs,
      routeMatchEnabled: 1,
      routePreviousHostname: input.routePreviousHostname,
      routePreviousPathname: input.routePreviousPathname,
      routePreviousQueryString: input.routePreviousQueryString,
      routePreviousHashFragment: input.routePreviousHashFragment,
    };
    const legacy = legacyRecentSession(database, directInput);
    const beforeFallback = trace.preparedSql.length;
    const persisted = await findRecentVisitorSession(bufferContext(env), input);
    expect(persisted).toEqual(legacy);
    expect(persisted).toMatchObject({ visitId: "route-exact", routeMatch: 2 });
    expect(trace.preparedSql).toHaveLength(beforeFallback + 1);
    const recentPlan = explain(
      database,
      trace.preparedSql.at(-1)!,
      trace.bindings.at(-1) ?? [],
    );
    expect(recentPlan).toContain("idx_visits_site_pk_visitor_last_activity");

    const routeDisabled = {
      ...directInput,
      routeMatchEnabled: 0,
      routePreviousHostname: "",
      routePreviousPathname: "",
      routePreviousQueryString: "",
      routePreviousHashFragment: "",
    };
    const disabledInput = {
      ...input,
      routePreviousHostname: "",
      routePreviousPathname: "",
      routePreviousQueryString: "",
      routePreviousHashFragment: "",
    };
    await expect(
      findRecentVisitorSession(bufferContext(env), disabledInput),
    ).resolves.toEqual(legacyRecentSession(database, routeDisabled));

    const bufferedSession: RecentVisitorSession = {
      sessionId: "buffer-session",
      visitId: "buffer-visit",
      status: "open",
      routeMatch: 2,
      startedAt: 1_999,
      lastActivityAt: 1_999,
    };
    const beforeBuffered = trace.preparedSql.length;
    const bufferedContext = bufferContext(env, () => bufferedSession);
    await expect(
      findRecentVisitorSession(bufferedContext, input),
    ).resolves.toBe(bufferedSession);
    expect(trace.preparedSql).toHaveLength(beforeBuffered);

    const brokenContext = bufferContext({
      ...env,
      DB: {
        prepare: () => {
          throw new Error("D1 unavailable");
        },
      } as unknown as D1Database,
    });
    await expect(
      findRecentVisitorSession(brokenContext, input),
    ).resolves.toBeNull();
    expect(
      operations.filter(({ operation }) => operation === "first"),
    ).toHaveLength(2);
  });

  it("returns the complete persisted-visit projection with nullable values and buffer defaults", async () => {
    const { database, env, trace, operations, siteOnePk } = createFixture();
    insertVisit(database, {
      visitId: "visit-snapshot",
      sitePk: siteOnePk,
      userId: null,
      userName: null,
    });
    const expected = database
      .prepare(
        `SELECT
          visit_id AS visitId, status, site_id AS siteId,
          visitor_id AS visitorId, session_id AS sessionId,
          started_at AS startedAt, last_activity_at AS lastActivityAt,
          ended_at AS endedAt, finalized_at AS finalizedAt,
          duration_ms AS durationMs,
          COALESCE(duration_source, '') AS durationSource,
          COALESCE(exit_reason, '') AS exitReason,
          pathname, query_string AS queryString, hash_fragment AS hashFragment,
          hostname, title, referrer_url AS referrerUrl,
          referrer_host AS referrerHost, utm_source AS utmSource,
          utm_medium AS utmMedium, utm_campaign AS utmCampaign,
          utm_term AS utmTerm, utm_content AS utmContent,
          is_eu AS isEU, country, region, region_code AS regionCode,
          city, continent, latitude, longitude, postal_code AS postalCode,
          metro_code AS metroCode, timezone,
          as_organization AS asOrganization, ua_raw AS uaRaw,
          browser, browser_version AS browserVersion, os,
          os_version AS osVersion, device_type AS deviceType,
          screen_width AS screenWidth, screen_height AS screenHeight,
          language, COALESCE(user_id, '') AS userId,
          COALESCE(user_name, '') AS userName,
          perf_ttfb_ms AS perfTtfbMs, perf_fcp_ms AS perfFcpMs,
          perf_lcp_ms AS perfLcpMs, perf_cls AS perfCls,
          perf_inp_ms AS perfInpMs, created_at AS createdAt,
          updated_at AS updatedAt
        FROM visits
        WHERE site_pk = (
          SELECT site_pk FROM site_identities WHERE site_id = ? LIMIT 1
        ) AND visit_id = ? LIMIT 1`,
      )
      .get("site-1", "visit-snapshot");
    const row = await readPersistedVisitRow(
      { env: { DB: env.DB } } as Parameters<typeof readPersistedVisitRow>[0],
      "site-1",
      "visit-snapshot",
    );
    expect(row).toEqual({
      ...expected,
      dirty: 0,
      flushAttempts: 0,
      hiddenAt: null,
      lastFlushError: null,
      flushDueAt: null,
      nextDueAt: null,
      bufferRevision: 1,
    });
    expect(row?.durationMs).toBeNull();
    expect(row?.latitude).toBeNull();
    expect(row?.perfTtfbMs).toBeNull();
    expect(row?.durationSource).toBe("");
    expect(row?.exitReason).toBe("");
    expect(row?.userId).toBe("");
    expect(trace.preparedSql).toHaveLength(1);
    expect(operations).toMatchObject([
      { operation: "first", statementCount: 1 },
    ]);
  });

  it("upserts typed event dictionaries, preserves overwrite and cache semantics, and uses dictionary indexes", async () => {
    const { database, env, trace, observations, operations, siteOnePk } =
      createFixture();
    insertVisit(database, { visitId: "event-visit", sitePk: siteOnePk });
    database
      .prepare(
        `INSERT INTO custom_event_names (site_id, site_pk, name, created_at, last_seen_at)
         VALUES ('site-1', ?, 'Signup', 1, 999)`,
      )
      .run(siteOnePk);
    database
      .prepare(
        `INSERT INTO custom_event_json_keys (site_id, site_pk, "key", created_at, last_seen_at)
         VALUES ('site-1', ?, 'action', 1, 999)`,
      )
      .run(siteOnePk);
    for (const path of ["$", "$.action"]) {
      database
        .prepare(
          `INSERT INTO custom_event_json_paths (site_id, site_pk, path, created_at, last_seen_at)
         VALUES ('site-1', ?, ?, 1, 999)`,
        )
        .run(siteOnePk, path === "$" ? "/" : "/action");
    }
    const context = {
      env: { DB: env.DB },
      dictionaryIds: new Map<string, number>(),
      sitePks: new Map([["site-1", siteOnePk]]),
      sqlAll: vi.fn(() => []),
      sqlOne: vi.fn(() => null),
      sqlRun: vi.fn(() => 1),
      readPersistedVisitRow: vi.fn(async () => null),
      insertBufferedVisitRow: vi.fn(),
      hasOpenVisitsForVisitor: vi.fn(() => false),
      pushRealtimeRecord: vi.fn(async () => undefined),
      observability: {
        increment: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as IngestFlushContext;
    const row: BufferedCustomEventRow = {
      eventId: "wave13-event-1",
      siteId: "site-1",
      visitId: "event-visit",
      occurredAt: NOW_MS - 1_000,
      receivedAt: NOW_MS,
      sequence: 1,
      eventName: "Signup",
      eventDataJson: '{"action":"signup"}',
      userId: "",
      dirty: 1,
      flushAttempts: 0,
      nextDueAt: NOW_MS,
      flushDueAt: NOW_MS,
      bufferRevision: 1,
      createdAt: 100,
    };
    await expect(flushCustomEventRowIndividually(context, row)).resolves.toBe(
      true,
    );
    await vi.waitFor(() =>
      expect(
        observationCount(
          observations,
          "ingest.custom_events.confirm_persisted",
        ),
      ).toBe(1),
    );
    const dictionaryObservationCount = observations.filter(({ tag }) =>
      tag?.startsWith("ingest.dictionary."),
    ).length;
    expect(
      observationCount(observations, "ingest.dictionary.name.upsert"),
    ).toBe(1);
    expect(observationCount(observations, "ingest.dictionary.key.upsert")).toBe(
      1,
    );
    expect(
      observationCount(observations, "ingest.dictionary.path.upsert"),
    ).toBe(2);
    expect(observationCount(observations, "ingest.dictionary.name.first")).toBe(
      1,
    );
    expect(observationCount(observations, "ingest.dictionary.key.first")).toBe(
      1,
    );
    expect(observationCount(observations, "ingest.dictionary.path.first")).toBe(
      2,
    );
    expect(
      database
        .prepare(
          "SELECT last_seen_at FROM custom_event_names WHERE site_pk = ? AND name = ?",
        )
        .get(siteOnePk, "Signup")?.last_seen_at,
    ).toBe(100);
    expect(
      database
        .prepare(
          'SELECT last_seen_at FROM custom_event_json_keys WHERE site_pk = ? AND "key" = ?',
        )
        .get(siteOnePk, "action")?.last_seen_at,
    ).toBe(100);
    expect(
      database
        .prepare(
          "SELECT last_seen_at FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
        )
        .get(siteOnePk, "/action")?.last_seen_at,
    ).toBe(100);
    expect(
      database
        .prepare(
          "SELECT last_seen_at FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
        )
        .get(siteOnePk, "/")?.last_seen_at,
    ).toBe(100);
    const preparedCount = trace.preparedSql.length;
    const operationsBeforeCacheHit = operations.length;
    await expect(
      flushCustomEventRowIndividually(context, {
        ...row,
        eventId: "wave13-event-2",
        createdAt: 50,
      }),
    ).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(
        observationCount(
          observations,
          "ingest.custom_events.confirm_persisted",
        ),
      ).toBe(2),
    );
    expect(trace.preparedSql.length - preparedCount).toBe(6);
    expect(
      operations
        .slice(operationsBeforeCacheHit)
        .map(({ operation }) => operation),
    ).toEqual(["first", "batch", "first"]);
    expect(
      observations.filter(({ tag }) => tag?.startsWith("ingest.dictionary.")),
    ).toHaveLength(dictionaryObservationCount);

    const nameQuery = customEventDictionaryIdQuery("name", siteOnePk, "Signup");
    const typedDictionaryPlan = explain(database, nameQuery.sql, [
      ...(nameQuery.bindings ?? []),
    ] as SQLInputValue[]);
    const legacyDictionaryPlan = explain(
      database,
      `SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ? LIMIT 1`,
      [siteOnePk, "Signup"],
    );
    expect(typedDictionaryPlan).toContain(
      "idx_custom_event_names_site_pk_name",
    );
    expect(legacyDictionaryPlan).toContain(
      "idx_custom_event_names_site_pk_name",
    );
    expect(trace.batchStatements?.[0]).toHaveLength(4);
    expect(
      operations.filter(({ operation }) => operation === "batch"),
    ).toHaveLength(2);
    expect(trace.preparedSql.every((sql) => !sql.includes("Signup"))).toBe(
      true,
    );
  });

  it.each([0, 100, 101])(
    "keeps retention delete bounds, strict expiry boundary, stale errors, operation counts, and expiry index for %s expired rows",
    async (count) => {
      vi.useFakeTimers({ now: NOW_MS });
      const { database, env, trace, observations, operations } =
        createFixture();
      const insertLog = database.prepare(
        `INSERT INTO scheduled_task_run_logs (
          id, run_id, task_key, sequence, level, event, message,
          created_at_ms, expires_at
        ) VALUES (?, 'run-1', 'task-1', ?, 'info', 'event', 'message', ?, ?)`,
      );
      for (let index = 0; index < count; index += 1) {
        insertLog.run(`expired-${index}`, index, NOW_MS, NOW_SECONDS - 1);
      }
      insertLog.run("boundary", count, NOW_MS, NOW_SECONDS);
      insertLog.run("future", count + 1, NOW_MS, NOW_SECONDS + 1);
      const insertRun = database.prepare(
        `INSERT INTO scheduled_task_runs (
          id, invocation_id, task_key, task_name, trigger_type,
          status, started_at_ms, expires_at, error_name, error_message
        ) VALUES (?, 'invocation', 'task-1', 'Task', 'schedule', ?, ?, ?, ?, ?)`,
      );
      insertRun.run(
        "stale-existing-error",
        "running",
        NOW_MS - 7 * 60 * 60 * 1000,
        NOW_SECONDS + 100,
        "ExistingError",
        "keep this message",
      );
      insertRun.run(
        "stale-empty-error",
        "running",
        NOW_MS - 7 * 60 * 60 * 1000,
        NOW_SECONDS + 100,
        null,
        null,
      );
      insertRun.run(
        "threshold-run",
        "running",
        NOW_MS - 6 * 60 * 60 * 1000,
        NOW_SECONDS + 100,
        null,
        null,
      );
      const insertNotification = database.prepare(
        `INSERT INTO notification_messages (
          id, team_id, user_id, type, title, expires_at
        ) VALUES (?, 'team-1', 'owner-1', 'system', 'Notification', ?)`,
      );
      for (let index = 0; index < count; index += 1) {
        insertNotification.run(
          `expired-notification-${index}`,
          NOW_SECONDS - 1,
        );
      }
      insertNotification.run("boundary-notification", NOW_SECONDS);
      insertNotification.run("future-notification", NOW_SECONDS + 1);
      insertNotification.run("null-notification", null);

      const result = await runDatabaseMaintenance({
        env: { DB: env.DB },
        logger: {
          info: vi.fn(async () => undefined),
          debug: vi.fn(async () => undefined),
          warn: vi.fn(async () => undefined),
          error: vi.fn(async () => undefined),
        },
      } as never);
      await vi.waitFor(() =>
        expect(
          observationCount(
            observations,
            "scheduled_tasks.maintenance.optimize",
          ),
        ).toBe(1),
      );
      expect(result).toMatchObject({
        status: "success",
        summary: {
          logsDeleted: count,
          runsDeleted: 0,
          notificationsDeleted: count,
          staleRunsMarkedFailed: 2,
        },
      });
      const expectedDeleteCalls = count === 0 ? 1 : 2;
      const expectedTotalDeleteCalls = expectedDeleteCalls * 2 + 1;
      expect(
        observationCount(
          observations,
          "scheduled_tasks.maintenance.delete_expired_batch",
        ),
      ).toBe(expectedTotalDeleteCalls);
      expect(
        observationCount(
          observations,
          "scheduled_tasks.maintenance.fail_stale_runs",
        ),
      ).toBe(1);
      expect(
        observationCount(observations, "scheduled_tasks.maintenance.optimize"),
      ).toBe(1);
      expect(
        operations.filter(({ operation }) => operation === "run"),
      ).toHaveLength(expectedTotalDeleteCalls + 2);
      expect(
        database
          .prepare("SELECT id FROM scheduled_task_run_logs ORDER BY id")
          .all()
          .map((row) => row.id),
      ).toEqual(["boundary", "future"]);
      expect(
        database
          .prepare("SELECT id FROM notification_messages ORDER BY id")
          .all()
          .map((row) => row.id),
      ).toEqual([
        "boundary-notification",
        "future-notification",
        "null-notification",
      ]);
      expect(
        database
          .prepare(
            "SELECT status, finished_at_ms AS finishedAt, duration_ms AS duration, error_name AS errorName, error_message AS errorMessage FROM scheduled_task_runs WHERE id = ?",
          )
          .get("stale-existing-error"),
      ).toEqual({
        status: "failed",
        finishedAt: NOW_MS,
        duration: NOW_MS - (NOW_MS - 7 * 60 * 60 * 1000),
        errorName: "ExistingError",
        errorMessage: "keep this message",
      });
      expect(
        database
          .prepare("SELECT status FROM scheduled_task_runs WHERE id = ?")
          .get("threshold-run")?.status,
      ).toBe("running");
      expect(trace.preparedSql.at(-1)).toBe("PRAGMA optimize");
      const deleteSqlIndex = trace.preparedSql.findIndex((sql) =>
        sql.includes('DELETE FROM "scheduled_task_run_logs"'),
      );
      expect(deleteSqlIndex).toBeGreaterThanOrEqual(0);
      const typedExpiryPlan = explain(
        database,
        trace.preparedSql[deleteSqlIndex]!,
        trace.bindings[deleteSqlIndex] ?? [],
      );
      const legacyExpiryPlan = explain(
        database,
        `DELETE FROM scheduled_task_run_logs WHERE id IN (
          SELECT id FROM scheduled_task_run_logs
          WHERE expires_at < unixepoch() ORDER BY expires_at ASC LIMIT ?
        )`,
        [100],
      );
      expect(typedExpiryPlan).toContain(
        "idx_scheduled_task_run_logs_expires_at",
      );
      expect(legacyExpiryPlan).toContain(
        "idx_scheduled_task_run_logs_expires_at",
      );
    },
  );
});
