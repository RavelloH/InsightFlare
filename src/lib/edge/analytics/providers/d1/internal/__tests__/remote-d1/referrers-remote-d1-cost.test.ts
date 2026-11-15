// @vitest-environment node
/**
 * Real Cloudflare D1 cost baseline for the Referrers summary.
 *
 * Runs only through `pnpm run test:cost` with these environment variables:
 *   CLOUDFLARE_API_TOKEN, C01_ACCOUNT_ID, C01_D1_DATABASE_ID
 * and, optionally, C01_VISITS (default 5000) and C01_REPORT_PATH.
 * The database must exactly match the approved benchmark name and UUID.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

import { referrersCostBudget } from "./cost-guards";
import { databaseFingerprint } from "./fingerprint";
import {
  COST_STRATEGIES,
  executeCostStrategy,
  seedFingerprint,
} from "./referrers-cost-harness";
import { resetRemoteCostFixture } from "./remote-cost-fixture";
import {
  assertDisposableDatabase,
  createRemoteD1Database,
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
const configured = [TOKEN, ACCOUNT, DATABASE].filter(Boolean).length;
if ((ACCOUNT !== "" || DATABASE !== "") && configured < 3)
  throw new Error("c01_remote_configuration_incomplete");
if (!Number.isSafeInteger(VISITS) || VISITS < 1 || VISITS > 30000)
  throw new Error("c01_visits_out_of_range:1..30000");
const enabled = configured === 3;

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
    variant: "summary",
    topN: 10,
  };
}

async function execute(env: Env, scenario: Scenario) {
  const started = performance.now();
  const diagnostics = createD1ReadDiagnostics();
  const provider = createD1SiteProviderRegistry({
    env,
    siteId: SEED_SITE_ID,
    diagnostics,
  }).resolve("referrers");
  if (!provider) throw new Error("referrers_provider_missing");
  const result = await provider.execute(queryFor(scenario) as never);
  return {
    value: result.value,
    diagnostics,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  };
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

describe.skipIf(!enabled)(
  `Referrers summary on a real Cloudflare D1${enabled ? "" : " (SKIPPED: no C01 target configured)"}`,
  () => {
    const options: RemoteD1Options = {
      accountId: ACCOUNT,
      databaseId: DATABASE,
      token: TOKEN,
    };
    let local: DatabaseSync;
    let remoteSqliteVersion: unknown;
    let verifiedDatabaseFingerprint: string;
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
      const expectedFingerprint = await databaseFingerprint(
        createSqliteD1Database(local),
        VISITS,
      );
      let seeded = false;
      try {
        const probe = createRemoteD1Database(options);
        seeded =
          (await databaseFingerprint(probe, VISITS)) === expectedFingerprint;
      } catch (error) {
        // An empty/older schema can be reseeded; transport/metadata failures must
        // never be interpreted as permission to reset even this test database.
        if (
          !(error instanceof Error) ||
          !/no such (table|column)/iu.test(error.message)
        )
          throw error;
        seeded = false;
      }
      if (!seeded) {
        const schemaPath = resolve(process.cwd(), "docs/schema.sql");
        const schema = readFileSync(schemaPath, "utf8")
          .replace(/^--.*$/gmu, "")
          .split(/;\s*\n/u)
          .map((statement) => statement.trim())
          .filter(Boolean);
        await resetRemoteCostFixture(options, schema, [
          ...buildSiteStatements(),
          ...buildDataStatements({ visits: VISITS }),
        ]);
      }
      verifiedDatabaseFingerprint = await databaseFingerprint(
        createRemoteD1Database(options),
        VISITS,
      );
      expect(verifiedDatabaseFingerprint).toBe(expectedFingerprint);
      try {
        remoteSqliteVersion = {
          status: "available",
          value: await createRemoteD1Database(options)
            .prepare("SELECT sqlite_version() AS version")
            .first(),
        };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes(
            "not authorized to use function: sqlite_version",
          )
        )
          throw error;
        remoteSqliteVersion = {
          status: "unavailable",
          reason: "D1 denies sqlite_version()",
        };
      }
    }, 900_000);

    afterAll(() => {
      local?.close();
      const path = resolve(
        process.env.C01_REPORT_PATH ?? ".tmp/c01-baseline-referrers.json",
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(report, null, 2));
    });

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
        const plans: { sqlBytes: number; sql: string; plan: string[] }[] = [];
        for (const meta of metas.filter((entry) => entry.rowsRead > 100_000)) {
          const explained = await createRemoteD1Database(options)
            .prepare(`EXPLAIN QUERY PLAN ${meta.sql}`)
            .bind(...meta.params)
            .all<{ id: number; parent: number; detail: string }>();
          plans.push({
            sqlBytes: Buffer.byteLength(meta.sql),
            sql: meta.sql,
            plan: explained.results.map(
              (row) => `${row.id}<-${row.parent} ${row.detail}`,
            ),
          });
        }
        report.push({
          engine: "remote-cloudflare-d1",
          remoteSqliteVersion,
          verifiedDatabaseFingerprint,
          strategy: "automatic",
          elapsedMs: remoteExecution.elapsedMs,
          seedFingerprint: seedFingerprint(VISITS),
          nodeVersion: process.version,
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

    it.each(["session", "visitor"] as const)(
      "same-query forced strategies / %s",
      async (scope) => {
        let oracle: unknown;
        for (const strategy of COST_STRATEGIES) {
          const metas: RemoteStatementMeta[] = [];
          const localExecution = await executeCostStrategy(
            {
              DB: createSqliteD1Database(local),
              MAIN_SECRET: "c01-secret",
            } as Env,
            scope,
            strategy,
          );
          const execution = await executeCostStrategy(
            {
              DB: createRemoteD1Database({
                ...options,
                onStatement: (meta) => metas.push(meta),
              }),
              MAIN_SECRET: "c01-secret",
            } as Env,
            scope,
            strategy,
          );
          expect(execution.value).toEqual(localExecution.value);
          if (oracle !== undefined) expect(execution.value).toEqual(oracle);
          oracle = execution.value;
          const cost = summarize(metas);
          const budget = referrersCostBudget(VISITS, strategy);
          report.push({
            engine: "remote-cloudflare-d1",
            remoteSqliteVersion,
            verifiedDatabaseFingerprint,
            nodeVersion: process.version,
            seedFingerprint: seedFingerprint(VISITS),
            visits: VISITS,
            ...execution,
            ...cost,
            budget,
            statementDetail: metas,
          });
          if (budget.status === "applicable") {
            const detail = `${scope}/${strategy}/${VISITS}: ${JSON.stringify({ cost, budget })}`;
            expect(cost.rowsRead, detail).toBeLessThanOrEqual(
              budget.maxRowsRead,
            );
            expect(cost.statements, detail).toBeLessThanOrEqual(
              budget.maxStatements,
            );
            expect(cost.rowsWritten, detail).toBe(budget.maxRowsWritten);
          }
        }
      },
      600000,
    );

    it("writes the baseline report", () => {
      expect(report.length).toBe(SCENARIOS.length + 2 * COST_STRATEGIES.length);
    });
  },
);
