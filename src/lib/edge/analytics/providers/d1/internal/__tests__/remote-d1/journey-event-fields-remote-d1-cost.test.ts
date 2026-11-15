// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";

import type { C01FixtureMeasurement } from "./analytics-fixture-cost-budgets";
import {
  errorEvidence,
  type ExplainRow,
  observeStatementAttempts,
} from "./cost-guards";
import { databaseFingerprint } from "./fingerprint";
import {
  assertJourneyEventFieldsCostBudget,
  assertJourneyEventFieldsCostGrowth,
} from "./journey-event-fields-cost-budgets";
import { buildJourneyEventFieldsCostFixture } from "./journey-event-fields-cost-fixture";
import {
  assertPositiveJourneyEventFieldsDto,
  executeJourneyEventFieldsCostScenario,
  JOURNEY_EVENT_FIELDS_COST_SCENARIOS,
} from "./journey-event-fields-cost-scenarios";
import {
  COST_TIME,
  observeCostDatabase,
  summarizeCost,
} from "./referrers-cost-harness";
import { C01_ACCOUNT_ID, resetRemoteCostFixture } from "./remote-cost-fixture";
import {
  assertDisposableDatabase,
  createRemoteD1Database,
  type RemoteD1Options,
  type RemoteStatementMeta,
} from "./remote-d1-database";
import { inspectRetentionCohortPlan } from "./retention-cost-guard";

const enabled = process.env.C01_NEXT_REMOTE === "1";
const visits = enabled ? Number(process.env.C01_VISITS ?? "2000") : 2000;
if (visits !== 2000 && visits !== 10000)
  throw new Error("c01_next_remote_scale_unsupported");
const fixture = buildJourneyEventFieldsCostFixture(visits);
function sourceSnapshot() {
  const files = [
    "src/lib/db/query/physical-plan.ts",
    "src/lib/db/query/physical/consumer-order-stability.ts",
    "src/lib/db/query/physical/shared-singleton-lookup-reuse.ts",
    "src/lib/edge/analytics/engine/journey-retention-report-plan.ts",
    "src/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture.ts",
    "src/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-scenarios.ts",
  ];
  return Object.fromEntries(
    files.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(resolve(path)))
        .digest("hex"),
    ]),
  );
}

describe.skipIf(!enabled)(
  `Independent journey/fields real D1 fixture${enabled ? "" : " (SKIPPED: C01_NEXT_REMOTE=1 required)"}`,
  () => {
    let local: DatabaseSync | undefined;
    let options: RemoteD1Options;
    let verifiedDatabaseFingerprint = "";
    const setupMetas: RemoteStatementMeta[] = [];
    const cases: Record<string, unknown>[] = [];
    const smaller = new Map<string, C01FixtureMeasurement>();
    const setup: Record<string, unknown> = {
      status: "not-started",
      explicitReset: process.env.C01_NEXT_RESEED === "1",
      statements: setupMetas,
    };
    const sourceBefore = sourceSnapshot();

    beforeAll(async () => {
      const started = performance.now();
      try {
        if (process.env.C01_ACCOUNT_ID !== C01_ACCOUNT_ID)
          throw new Error("c01_refuses_unapproved_account_id");
        const token = process.env.CLOUDFLARE_API_TOKEN;
        if (!token) throw new Error("c01_remote_token_missing");
        options = {
          accountId: C01_ACCOUNT_ID,
          databaseId: process.env.C01_D1_DATABASE_ID ?? "",
          token,
        };
        await assertDisposableDatabase(options);
        local = createMigratedDatabase();
        for (const sql of fixture.seed) local.exec(sql);
        local.exec("PRAGMA query_only=ON");
        const expected = await databaseFingerprint(
          createSqliteD1Database(local),
          visits,
          fixture.seed,
        );
        const setupOptions = {
          ...options,
          onStatement: (meta: RemoteStatementMeta) => setupMetas.push(meta),
        };
        setup.status = "running";
        // Only this explicit flag selects reset. No caught probe error can do so.
        if (process.env.C01_NEXT_RESEED === "1")
          await resetRemoteCostFixture(
            setupOptions,
            unstable_splitSqlQuery(fixture.schemaSql),
            fixture.seed,
          );
        verifiedDatabaseFingerprint = await databaseFingerprint(
          createRemoteD1Database(setupOptions),
          visits,
          fixture.seed,
        );
        if (verifiedDatabaseFingerprint !== expected)
          throw new Error(
            "c01_next_seed_mismatch:explicit_C01_NEXT_RESEED_required",
          );
        if (visits === 10000) {
          const path = process.env.C01_NEXT_SMALLER_REPORT_PATH;
          if (!path) throw new Error("c01_next_growth_report_required");
          const previous = JSON.parse(readFileSync(resolve(path), "utf8")) as {
            fixture?: { visits?: unknown; seedFingerprint?: unknown };
            cases?: Record<string, unknown>[];
          };
          if (
            previous.fixture?.visits !== 2000 ||
            previous.fixture.seedFingerprint !==
              buildJourneyEventFieldsCostFixture(2000).fingerprint ||
            !Array.isArray(previous.cases) ||
            previous.cases.length !== 9
          )
            throw new Error("c01_next_growth_fixture_incompatible");
          for (const scenario of JOURNEY_EVENT_FIELDS_COST_SCENARIOS) {
            const matches = previous.cases.filter(
              (row) => row.scenario === scenario.name,
            );
            const row = matches[0];
            if (
              matches.length !== 1 ||
              !row ||
              row.status !== "passed" ||
              row.engine !== "remote-cloudflare-d1" ||
              row.operation !== scenario.operation ||
              row.family !== scenario.family ||
              row.scope !== scenario.scope ||
              row.filterDsl !== (scenario.filterDsl ?? null) ||
              !isDeepStrictEqual(row.parameters, scenario.parameters) ||
              !isDeepStrictEqual(row.time, COST_TIME) ||
              typeof row.verifiedDatabaseFingerprint !== "string" ||
              !row.verifiedDatabaseFingerprint
            )
              throw new Error(
                `c01_next_growth_request_incompatible:${scenario.name}`,
              );
            const measurement: C01FixtureMeasurement = {
              engine: "remote-cloudflare-d1",
              visits: 2000,
              seedFingerprint: previous.fixture.seedFingerprint as string,
              scenario,
              time: COST_TIME,
              cost: {
                rowsRead: row.rowsRead,
                rowsWritten: row.rowsWritten,
                statements: row.statements,
              },
            };
            assertJourneyEventFieldsCostBudget(measurement);
            smaller.set(scenario.name, measurement);
          }
        }
        setup.status = "passed";
      } catch (error) {
        setup.status = "failed";
        setup.error = errorEvidence(error);
        throw error;
      } finally {
        setup.elapsedMs = Number((performance.now() - started).toFixed(3));
      }
    }, 900000);

    afterAll(() => {
      local?.close();
      for (const row of cases)
        if (row.status === "running") row.status = "incomplete";
      const report = {
        suite: "C01 independent journey/fields",
        baseline: {
          remoteBefore: null,
          reason: "New independent fixture; before costs exist only locally",
          absoluteBudgetSource: "same-fixture local Miniflare after +20%+100",
        },
        fixture: {
          visits,
          seedFingerprint: fixture.fingerprint,
          verifiedDatabaseFingerprint,
        },
        sourceWindow: { before: sourceBefore, after: sourceSnapshot() },
        sqlEngineVersion: {
          status: "unknown",
          reason: "D1 sqlite_version authorizer support is not assumed",
        },
        nodeVersion: process.version,
        setup,
        cases,
      };
      const path = resolve(
        process.env.C01_NEXT_REMOTE_REPORT_PATH ??
          `.tmp/c01-remote-journey-event-fields-${visits}.json`,
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(report, null, 2));
    });

    it.each(JOURNEY_EVENT_FIELDS_COST_SCENARIOS)(
      "$name complete native DTO, genuine D1 costs and EQP",
      async (scenario) => {
        const metas: RemoteStatementMeta[] = [];
        const observed = observeStatementAttempts(
          createRemoteD1Database({
            ...options,
            onStatement: (meta) => metas.push(meta),
          }),
        );
        const row: Record<string, unknown> = {
          status: "running",
          engine: "remote-cloudflare-d1",
          visits,
          seedFingerprint: fixture.fingerprint,
          verifiedDatabaseFingerprint,
          time: COST_TIME,
          scenario: scenario.name,
          family: scenario.family,
          operation: scenario.operation,
          parameters: scenario.parameters,
          scope: scenario.scope,
          filterDsl: scenario.filterDsl ?? null,
          statementDetail: metas,
          statementAttempts: observed.attempts,
        };
        cases.push(row);
        let phase = "native-reference";
        try {
          if (!local) throw new Error("c01_next_local_reference_missing");
          const native = observeCostDatabase(createSqliteD1Database(local));
          const reference = await executeJourneyEventFieldsCostScenario(
            { DB: native.database, MAIN_SECRET: "c01-secret" } as Env,
            scenario,
          );
          row.reference = {
            ...reference,
            ...summarizeCost(native.observations),
            sqliteVersion: process.versions.sqlite,
          };
          phase = "remote-execution";
          const actual = await executeJourneyEventFieldsCostScenario(
            { DB: observed.database, MAIN_SECRET: "c01-secret" } as Env,
            scenario,
          );
          if (!metas.length) throw new Error("c01_remote_statements_missing");
          for (const meta of metas)
            if (
              !Number.isSafeInteger(meta.rowsRead) ||
              meta.rowsRead < 0 ||
              !Number.isSafeInteger(meta.rowsWritten) ||
              meta.rowsWritten !== 0 ||
              !Number.isFinite(meta.sqlDurationMs) ||
              meta.sqlDurationMs < 0
            )
              throw new Error("c01_next_remote_invalid_statement_metadata");
          const cost = {
            statements: metas.length,
            rowsRead: metas.reduce((sum, meta) => sum + meta.rowsRead, 0),
            rowsWritten: metas.reduce((sum, meta) => sum + meta.rowsWritten, 0),
            sqlDurationMs: metas.reduce(
              (sum, meta) => sum + meta.sqlDurationMs,
              0,
            ),
            maxParameters: Math.max(
              ...metas.map((meta) => meta.parameterCount),
            ),
            maxSqlBytes: Math.max(
              ...metas.map((meta) => Buffer.byteLength(meta.sql)),
            ),
          };
          Object.assign(row, actual, cost, { metadataStatus: "complete" });
          phase = "dto-and-budget";
          expect(actual.value).toEqual(reference.value);
          expect(actual.actualStrategies).toEqual(reference.actualStrategies);
          assertPositiveJourneyEventFieldsDto(scenario, actual.value);
          const measurement: C01FixtureMeasurement = {
            engine: "remote-cloudflare-d1",
            visits,
            seedFingerprint: fixture.fingerprint,
            scenario,
            time: COST_TIME,
            cost,
          };
          row.absoluteBudget = assertJourneyEventFieldsCostBudget(measurement);
          if (visits === 10000)
            row.growthBudget = assertJourneyEventFieldsCostGrowth(
              smaller.get(scenario.name)!,
              measurement,
            );
          expect(cost.maxParameters).toBeLessThanOrEqual(100);
          expect(cost.maxSqlBytes).toBeLessThanOrEqual(100000);
          phase = "remote-explain";
          const explainMetas: RemoteStatementMeta[] = [];
          const explainDatabase = createRemoteD1Database({
            ...options,
            onStatement: (meta) => explainMetas.push(meta),
          });
          const plans: Record<string, unknown>[] = [];
          row.explain = plans;
          row.explainStatementDetail = explainMetas;
          for (const meta of metas) {
            const result = await explainDatabase
              .prepare(`EXPLAIN QUERY PLAN ${meta.sql}`)
              .bind(...meta.params)
              .all<ExplainRow>();
            plans.push({
              sql: meta.sql,
              params: meta.params,
              plan: result.results,
              ...(scenario.operation === "retention"
                ? {
                    cohortInspection: inspectRetentionCohortPlan(
                      meta.sql,
                      result.results,
                    ),
                  }
                : {}),
            });
          }
          expect(explainMetas.every((meta) => meta.rowsWritten === 0)).toBe(
            true,
          );
          row.status = "passed";
        } catch (error) {
          row.status = "failed";
          row.phase = phase;
          row.error = errorEvidence(error);
          row.completedStatementCost = {
            statements: metas.length,
            rowsRead: metas.reduce((sum, meta) => sum + meta.rowsRead, 0),
            rowsWritten: metas.reduce((sum, meta) => sum + meta.rowsWritten, 0),
            sqlDurationMs: metas.reduce(
              (sum, meta) => sum + meta.sqlDurationMs,
              0,
            ),
          };
          throw error;
        }
      },
      300000,
    );

    it("records all nine scenarios as successful", () => {
      expect(cases).toHaveLength(9);
      expect(cases.every((row) => row.status === "passed")).toBe(true);
    });
  },
);
