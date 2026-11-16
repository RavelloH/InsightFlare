import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { EVENT_SUMMARY_CARD_OUTPUTS } from "@/lib/edge/analytics/engine/event-summary-cards-plan";
import { EVENT_TREND_OUTPUTS } from "@/lib/edge/analytics/engine/event-trend-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredEventSummaryQualificationFromQuery,
  deferredEventTrendQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  executeEventSummaryQualificationProgram,
  executeEventTrendQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import {
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE_ID = "event-summary-program-guards";
const START = Date.UTC(2026, 0, 1, 8);
const END = Date.UTC(2026, 0, 4, 8);
const NOW = Date.UTC(2026, 0, 5, 8);
const DEFAULT_DSL = 'count(page { page.path eq "/scoped" }) eq 1';
const NUMERIC_DSL = "count(page { page.durationMs gt 5 }) eq 1";
const PREFIX = "analytics_event_summary_qualification_";

type Row = Record<string, unknown>;

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'guards-team', 'Event summary guards', 'summary.test', 0)`,
    )
    .run(SITE_ID);
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'purchase', ?, ?)`,
    )
    .run(SITE_ID, END - 1, sitePk);
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, title, duration_ms
      ) VALUES ('visit-scoped', ?, ?, 'visitor-a', 'session-a', 'closed',
        ?, ?, '/scoped', 'summary.test', 'Scoped', 10)`,
    )
    .run(SITE_ID, sitePk, START + 1, START + 1);
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES ('event-a', ?, ?, 'visit-scoped', 1, ?, ?, 1, 0, 0)`,
    )
    .run(SITE_ID, sitePk, START + 1_000, START + 1_000);
  return database;
}

type Rewrite = (results: Row[]) => Row[];

async function execute(
  rewrite: Rewrite,
  options: {
    readonly dsl?: string;
    readonly scope?: "session" | "visitor";
    readonly operation?: "event-summary" | "event-trend";
  } = {},
) {
  const database = createFixture();
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const base = createSqliteD1Database(database, trace);
  const env = {
    MAIN_SECRET: "event-summary-program-guards-secret",
    DB: {
      prepare(sql: string) {
        const statement = base.prepare(sql);
        const envelope =
          sql.includes('"rowKind"') && sql.includes('"outputId"');
        const prepared = {
          bind(...values: Parameters<typeof statement.bind>) {
            statement.bind(...values);
            return prepared;
          },
          first<R>() {
            return statement.first<R>();
          },
          async all<R>() {
            const result = await statement.all<R>();
            if (!envelope) return result;
            return {
              ...result,
              results: rewrite(result.results as Row[]) as R[],
            };
          },
          run() {
            return statement.run();
          },
        };
        return prepared;
      },
      batch(statements: Parameters<typeof base.batch>[0]) {
        return base.batch(statements);
      },
    },
  } as unknown as Env;
  const time: QueryTime = createQueryTime(START, END, "UTC", NOW);
  const operation = options.operation ?? "event-summary";
  const prepared = prepareScopedQuery(operation, {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time,
    filters: parseFilterDsl(
      options.dsl ?? DEFAULT_DSL,
      analyticsFilterRegistry,
    ),
    scopePreference: options.scope ?? "session",
  } as QueryInput & { readonly time: QueryTime });
  if (operation === "event-trend") {
    const query = { ...prepared, limit: 5, interval: "day" };
    const forwarded = await d1AdvancedFilterMiddleware(env)(
      operation,
      query as never,
      async (value) => value,
    );
    const deferred = deferredEventTrendQualificationFromQuery(forwarded);
    if (!deferred) throw new Error("event_trend_guard_deferred_missing");
    return executeEventTrendQualificationProgram({
      env,
      deferred,
      query: {
        interval: "day",
        limit: 5,
        otherToken: SHARE_TREND_OTHER_TOKEN,
        otherLabel: SHARE_TREND_OTHER_LABEL,
      },
    });
  }
  const forwarded = await d1AdvancedFilterMiddleware(env)(
    operation,
    prepared,
    async (value) => value,
  );
  const deferred = deferredEventSummaryQualificationFromQuery(forwarded);
  if (!deferred) throw new Error("event_summary_guard_deferred_missing");
  return executeEventSummaryQualificationProgram({ env, deferred });
}

const identity: Rewrite = (results) => results;
const mapRows =
  (transform: (row: Row) => Row): Rewrite =>
  (results) =>
    results.map(transform);
const withControl = (patch: Row) =>
  mapRows((row) => (row.rowKind === "control" ? { ...row, ...patch } : row));
const onlyControl =
  (patch: Row): Rewrite =>
  (results) =>
    results
      .filter((row) => row.rowKind === "control")
      .map((row) => ({ ...row, ...patch }));

describe("event summary qualification program decoding", () => {
  it("executes the untouched envelope and keeps the report rows", async () => {
    const result = await execute(identity);
    expect(result.kind).toBe("executed");
    if (result.kind === "executed") {
      const outputs = result.rows.map((row) => row.outputId);
      expect(outputs).toContain(EVENT_SUMMARY_CARD_OUTPUTS.summary);
      expect(result.rows.every((row) => row.rowKind === "report")).toBe(true);
    }
  });

  it("rejects rows that are neither control nor report rows", async () => {
    await expect(
      execute((results) => [...results, { ...results[0]!, rowKind: "other" }]),
    ).rejects.toThrow(PREFIX + "envelope_kind_invalid");
  });

  it("requires one control row with the exact envelope columns", async () => {
    await expect(
      execute((results) => results.filter((row) => row.rowKind !== "control")),
    ).rejects.toThrow(PREFIX + "control_row_invalid");
    await expect(execute(withControl({ extra: 1 }))).rejects.toThrow(
      PREFIX + "control_row_invalid",
    );
    await expect(
      execute(withControl({ outputId: "elsewhere" })),
    ).rejects.toThrow(PREFIX + "control_row_invalid");
  });

  it("rejects a control row of another entity scope", async () => {
    await expect(
      execute(withControl({ entityKind: "visitor" })),
    ).rejects.toThrow(PREFIX + "control_kind_mismatch");
  });

  it("rejects non-integer control counters", async () => {
    await expect(execute(withControl({ rawCount: "2" }))).rejects.toThrow(
      PREFIX + "control_invalid:rawCount",
    );
  });

  it("rejects report rows with a foreign output, card type or extra column", async () => {
    const report = (patch: Row) =>
      mapRows((row) => (row.rowKind === "report" ? { ...row, ...patch } : row));
    await expect(execute(report({ outputId: "foreign" }))).rejects.toThrow(
      PREFIX + "report_row_invalid",
    );
    await expect(execute(report({ cardType: "bogus" }))).rejects.toThrow(
      PREFIX + "report_row_invalid",
    );
    await expect(execute(report({ rawCount: 3 }))).rejects.toThrow(
      PREFIX + "report_row_invalid",
    );
  });

  it("rejects a repeated summary card", async () => {
    await expect(
      execute((results) => {
        const summary = results.find(
          (row) => row.outputId === EVENT_SUMMARY_CARD_OUTPUTS.summary,
        )!;
        return [...results, { ...summary }];
      }),
    ).rejects.toThrow(PREFIX + "summary_duplicated");
  });

  it("raises a gate violation when a fallback control still returns reports", async () => {
    await expect(
      execute(withControl({ nullActivityIdCount: 1 })),
    ).rejects.toThrow(PREFIX + "gate_violation");
  });

  it("returns the legacy fallback when the control demands it and no reports leak", async () => {
    expect(
      await execute(onlyControl({ siteIdentityMismatchCount: 1 })),
    ).toEqual({
      kind: "legacy",
      fallbackReason: { kind: "site-identity-mismatch" },
    });
    expect(await execute(onlyControl({ nullActivityIdCount: 3 }))).toEqual({
      kind: "legacy",
      fallbackReason: { kind: "null-activity-id" },
    });
  });

  it("throws the combined identity errors for bad identities", async () => {
    await expect(
      execute(withControl({ invalidIdentityCount: 1 })),
    ).rejects.toThrow("advanced_filter_count_combined_identity_invalid");
    await expect(
      execute(withControl({ duplicateIdentityCount: 1 })),
    ).rejects.toThrow("advanced_filter_count_combined_identity_repeated");
  });

  it("decodes numeric compatibility counters and falls back for bad numeric data", async () => {
    const baseline = await execute(identity, { dsl: NUMERIC_DSL });
    expect(baseline.kind).toBe("executed");
    const result = await execute(
      onlyControl({ invalidContextPageDurationMsCount: 1 }),
      { dsl: NUMERIC_DSL },
    );
    expect(result).toEqual({
      kind: "legacy",
      fallbackReason: {
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      },
    });
    await expect(
      execute(withControl({ invalidContextPageDurationMsCount: "x" }), {
        dsl: NUMERIC_DSL,
      }),
    ).rejects.toThrow(
      PREFIX + "control_invalid:invalidContextPageDurationMsCount",
    );
  });
});

describe("event trend qualification program decoding", () => {
  const trend = { operation: "event-trend" } as const;

  it("executes the untouched trend envelope with its Other row", async () => {
    const result = await execute(identity, trend);
    expect(result.kind).toBe("executed");
    if (result.kind === "executed")
      expect(
        result.rows.filter((row) => row.outputId === EVENT_TREND_OUTPUTS.other),
      ).toHaveLength(1);
  });

  it("requires exactly one Other row", async () => {
    await expect(
      execute(
        (results) =>
          results.filter((row) => row.outputId !== EVENT_TREND_OUTPUTS.other),
        trend,
      ),
    ).rejects.toThrow("analytics_event_trend_qualification_other_cardinality");
    await expect(
      execute((results) => {
        const other = results.find(
          (row) => row.outputId === EVENT_TREND_OUTPUTS.other,
        )!;
        return [...results, { ...other }];
      }, trend),
    ).rejects.toThrow("analytics_event_trend_qualification_other_cardinality");
  });

  it("rejects trend rows that carry summary-card columns", async () => {
    await expect(
      execute(
        mapRows((row) =>
          row.rowKind === "report" ? { ...row, value: 1 } : row,
        ),
        trend,
      ),
    ).rejects.toThrow(PREFIX + "report_row_invalid");
  });
});
