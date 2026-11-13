// @vitest-environment node
/**
 * Real Cloudflare D1 cost baseline for the Referrers summary.
 *
 * Runs only through `pnpm run test:cost` with these environment variables:
 *   CLOUDFLARE_API_TOKEN, C01_ACCOUNT_ID, C01_D1_DATABASE_ID
 * and, optionally, C01_VISITS (default 5000) and C01_REPORT_PATH.
 * The database must be a disposable benchmark database (name prefix
 * `if-c01-bench-`); anything else is refused.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  type QueryInput,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

import {
  assertDisposableDatabase,
  createRemoteD1Database,
  execRemote,
  type RemoteD1Options,
  type RemoteStatementMeta,
} from "./remote-d1-database";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "./seed";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const ACCOUNT = process.env.C01_ACCOUNT_ID ?? "";
const DATABASE = process.env.C01_D1_DATABASE_ID ?? "";
const VISITS = Number(process.env.C01_VISITS ?? "5000");
const enabled = TOKEN !== "" && ACCOUNT !== "" && DATABASE !== "";

const TIME = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const BASE_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';

interface Scenario {
  readonly name: string;
  readonly scope: "session" | "visitor" | "event";
  readonly filterDsl?: string;
}

const SCENARIOS: readonly Scenario[] = [
  { name: "summary / no filter", scope: "session" },
  {
    name: "summary / session + count filter",
    scope: "session",
    filterDsl: BASE_FILTER,
  },
  {
    name: "summary / visitor + count filter",
    scope: "visitor",
    filterDsl: BASE_FILTER,
  },
  {
    name: "summary / session + count filter + time leaf",
    scope: "session",
    filterDsl: `${BASE_FILTER} and time gte @range.start+1d`,
  },
  {
    name: "summary / event scope + count filter",
    scope: "event",
    filterDsl: BASE_FILTER,
  },
];

function queryFor(scenario: Scenario) {
  const filters = scenario.filterDsl
    ? parseFilterDsl(scenario.filterDsl, analyticsFilterRegistry)
    : EMPTY_FILTER_DOCUMENT;
  const prepared = prepareScopedQuery("referrers", {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: TIME,
    filters,
    scopePreference: scenario.scope,
  } as QueryInput & { readonly time: typeof TIME });
  return {
    ...prepared,
    time: TIME,
    variant: "summary",
    topN: 10,
  };
}

async function execute(env: Env, scenario: Scenario) {
  const diagnostics = createD1ReadDiagnostics();
  const provider = createD1SiteProviderRegistry({
    env,
    siteId: SEED_SITE_ID,
    diagnostics,
  }).resolve("referrers");
  if (!provider) throw new Error("referrers_provider_missing");
  const result = await provider.execute(queryFor(scenario) as never);
  return { value: result.value, diagnostics };
}

function summarize(metas: readonly RemoteStatementMeta[]) {
  return {
    statements: metas.length,
    rowsRead: metas.reduce((sum, meta) => sum + meta.rowsRead, 0),
    rowsWritten: metas.reduce((sum, meta) => sum + meta.rowsWritten, 0),
    sqlDurationMs: Number(
      metas.reduce((sum, meta) => sum + meta.sqlDurationMs, 0).toFixed(3),
    ),
    maxParameters: Math.max(0, ...metas.map((meta) => meta.parameterCount)),
    maxSqlBytes: Math.max(
      0,
      ...metas.map((meta) => Buffer.byteLength(meta.sql)),
    ),
  };
}

describe.skipIf(!enabled)("Referrers summary on a real Cloudflare D1", () => {
  const options: RemoteD1Options = {
    accountId: ACCOUNT,
    databaseId: DATABASE,
    token: TOKEN,
  };
  let local: DatabaseSync;
  const report: Record<string, unknown>[] = [];

  beforeAll(async () => {
    await assertDisposableDatabase(options);
    // Local database with identical rows, used to check the remote answers.
    local = createMigratedDatabase();
    for (const statement of [
      ...buildSiteStatements(),
      ...buildDataStatements({ visits: VISITS }),
    ])
      local.exec(statement);

    // Remote: keep an already seeded database, otherwise rebuild it.
    let seeded = false;
    try {
      const probe = createRemoteD1Database(options);
      const row = await probe
        .prepare("SELECT count(*) AS n FROM visits")
        .first<{ n: number }>();
      seeded = row?.n === VISITS;
    } catch {
      seeded = false;
    }
    if (!seeded) {
      const tables = (await (async () => {
        const database = createRemoteD1Database(options);
        const result = await database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
          )
          .all<{ name: string }>();
        return result.results.map((row) => row.name);
      })()) as string[];
      // The database is disposable (checked above); start from a clean slate.
      // Tables that others reference can only go once their dependants are
      // gone, so keep sweeping until nothing is left.
      let remaining = [...tables];
      for (let pass = 0; remaining.length > 0 && pass < 10; pass += 1) {
        const failed: string[] = [];
        for (const name of remaining) {
          try {
            await execRemote(options, `DROP TABLE IF EXISTS "${name}"`);
          } catch {
            failed.push(name);
          }
        }
        remaining = failed;
      }
      if (remaining.length > 0)
        throw new Error(`c01_cannot_clear_database:${remaining.join(",")}`);
      const schemaPath = resolve(process.cwd(), "docs/schema.sql");
      const schema = readFileSync(schemaPath, "utf8")
        .replace(/^--.*$/gmu, "")
        .split(/;\s*\n/u)
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of schema) await execRemote(options, statement);
      for (const statement of [
        ...buildSiteStatements(),
        ...buildDataStatements({ visits: VISITS }),
      ])
        await execRemote(options, statement);
    }
  }, 900_000);

  it.each(SCENARIOS)(
    "$name",
    async (scenario) => {
      const localExecution = await execute(
        {
          DB: createSqliteD1Database(local),
          MAIN_SECRET: "c01-secret",
        } as unknown as Env,
        scenario,
      );
      const metas: RemoteStatementMeta[] = [];
      const remoteExecution = await execute(
        {
          DB: createRemoteD1Database({
            ...options,
            onStatement: (meta) => metas.push(meta),
          }),
          MAIN_SECRET: "c01-secret",
        } as unknown as Env,
        scenario,
      );
      // The real D1 must answer exactly like the local SQLite replica.
      expect(remoteExecution.value).toEqual(localExecution.value);
      // Explain every statement that reads a lot, so a hot spot is explained
      // by the plan D1 chose and not only by the row count.
      const plans: { sqlBytes: number; plan: string[] }[] = [];
      for (const meta of metas.filter((entry) => entry.rowsRead > 100_000)) {
        const explained = await createRemoteD1Database(options)
          .prepare(`EXPLAIN QUERY PLAN ${meta.sql}`)
          .bind(...meta.params)
          .all<{ id: number; parent: number; detail: string }>();
        plans.push({
          sqlBytes: Buffer.byteLength(meta.sql),
          plan: explained.results.map(
            (row) => `${row.id}<-${row.parent} ${row.detail}`,
          ),
        });
      }
      report.push({
        scenario: scenario.name,
        visits: VISITS,
        fallbackReason:
          remoteExecution.diagnostics.advancedCountSqlFallbackReason ?? null,
        ...summarize(metas),
        heavyPlans: plans,
        statementDetail: metas.map((meta) => ({
          rowsRead: meta.rowsRead,
          rowsWritten: meta.rowsWritten,
          sqlDurationMs: meta.sqlDurationMs,
          parameters: meta.parameterCount,
          sqlBytes: Buffer.byteLength(meta.sql),
          resultRows: meta.resultRows,
        })),
      });
    },
    300_000,
  );

  it("writes the baseline report", () => {
    const path = resolve(
      process.env.C01_REPORT_PATH ?? ".tmp/c01-baseline-referrers.json",
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2));
    expect(report.length).toBe(SCENARIOS.length);
  });
});
