// @vitest-environment node
/** Read-only extension: first seed the approved database with the Referrers suite. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";

import {
  ANALYTICS_COST_SCENARIOS,
  executeAnalyticsCostScenario,
} from "./analytics-cost-scenarios";
import {
  assertC01AnalyticsFixtureBudget,
  assertC01AnalyticsFixtureGrowth,
  type C01FixtureMeasurement,
} from "./analytics-fixture-cost-budgets";
import { errorEvidence, observeStatementAttempts } from "./cost-guards";
import { databaseFingerprint } from "./fingerprint";
import {
  COST_TIME,
  observeCostDatabase,
  seedFingerprint,
  summarizeCost,
} from "./referrers-cost-harness";
import {
  assertDisposableDatabase,
  createRemoteD1Database,
  type RemoteD1Options,
  type RemoteStatementMeta,
} from "./remote-d1-database";
import { buildDataStatements, buildSiteStatements } from "./seed";

// A token is read only by the explicitly configured remote suite's beforeAll.
const account = process.env.C01_ACCOUNT_ID ?? "";
const database = process.env.C01_D1_DATABASE_ID ?? "";
const enabled = account !== "" && database !== "";
if ((account !== "") !== (database !== ""))
  throw new Error("c01_remote_configuration_incomplete");
const visits = Number(process.env.C01_VISITS ?? "5000");
if (!Number.isSafeInteger(visits) || visits < 1 || visits > 10000)
  throw new Error("c01_family_visits_out_of_range:1..10000");

describe.skipIf(!enabled)(
  `Pages, Overview and Events on real remote D1${enabled ? "" : " (SKIPPED: no C01 target configured)"}`,
  () => {
    let local: DatabaseSync;
    let options: RemoteD1Options;
    let verifiedDatabaseFingerprint: string;
    const baselinePath = process.env.C01_FAMILIES_BASELINE_PATH;
    const smallerReportPath = process.env.C01_FAMILIES_SMALLER_REPORT_PATH;
    const smallerMeasurements = new Map<string, C01FixtureMeasurement>();
    const baselineByScenario = new Map<
      string,
      { rowsRead: number; value: unknown }
    >();
    const report: Record<string, unknown>[] = [];
    beforeAll(async () => {
      try {
        const token = process.env.CLOUDFLARE_API_TOKEN;
        if (!token) throw new Error("c01_remote_token_missing");
        options = { accountId: account, databaseId: database, token };
        await assertDisposableDatabase(options);
        local = createMigratedDatabase();
        for (const sql of [
          ...buildSiteStatements(),
          ...buildDataStatements({ visits }),
        ])
          local.exec(sql);
        const expected = await databaseFingerprint(
          createSqliteD1Database(local),
          visits,
        );
        verifiedDatabaseFingerprint = await databaseFingerprint(
          createRemoteD1Database(options),
          visits,
        );
        if (verifiedDatabaseFingerprint !== expected)
          throw new Error(
            "c01_family_seed_mismatch:run_referrers_remote_suite_at_same_C01_VISITS_first",
          );
        if (visits === 10000) {
          if (!smallerReportPath)
            throw new Error(
              "c01_family_growth_report_required:C01_FAMILIES_SMALLER_REPORT_PATH",
            );
          const smaller: unknown = JSON.parse(
            readFileSync(resolve(smallerReportPath), "utf8"),
          );
          if (!Array.isArray(smaller))
            throw new Error("c01_family_growth_report_not_array");
          for (const scenario of ANALYTICS_COST_SCENARIOS) {
            const matches = smaller.filter(
              (row: unknown): row is Record<string, unknown> =>
                row !== null &&
                typeof row === "object" &&
                (row as Record<string, unknown>).scenario === scenario.name,
            );
            const previous = matches[0];
            if (
              matches.length !== 1 ||
              !previous ||
              previous.engine !== "remote-cloudflare-d1" ||
              previous.status !== "passed" ||
              previous.visits !== 2000 ||
              previous.seedFingerprint !== seedFingerprint(2000) ||
              typeof previous.verifiedDatabaseFingerprint !== "string" ||
              previous.verifiedDatabaseFingerprint === "" ||
              previous.family !== scenario.family ||
              previous.operation !== scenario.operation ||
              previous.scope !== scenario.scope ||
              previous.filterDsl !== (scenario.filterDsl ?? null) ||
              !isDeepStrictEqual(previous.parameters, scenario.parameters) ||
              !isDeepStrictEqual(previous.time, COST_TIME)
            )
              throw new Error(
                "c01_family_growth_report_incompatible:" + scenario.name,
              );
            const measurement: C01FixtureMeasurement = {
              engine: "remote-cloudflare-d1",
              visits: 2000,
              seedFingerprint: seedFingerprint(2000),
              scenario,
              time: COST_TIME,
              cost: {
                rowsRead: previous.rowsRead,
                rowsWritten: previous.rowsWritten,
                statements: previous.statements,
              },
            };
            assertC01AnalyticsFixtureBudget(measurement);
            smallerMeasurements.set(scenario.name, measurement);
          }
        }
        if (baselinePath) {
          const baseline = JSON.parse(
            readFileSync(resolve(baselinePath), "utf8"),
          ) as Record<string, unknown>[];
          for (const scenario of ANALYTICS_COST_SCENARIOS) {
            const matches = baseline.filter(
              (row) => row.scenario === scenario.name,
            );
            const previous = matches[0];
            if (
              matches.length !== 1 ||
              previous?.engine !== "remote-cloudflare-d1" ||
              previous.visits !== visits ||
              previous.seedFingerprint !== seedFingerprint(visits) ||
              previous.verifiedDatabaseFingerprint !==
                verifiedDatabaseFingerprint ||
              previous.family !== scenario.family ||
              previous.operation !== scenario.operation ||
              previous.scope !== scenario.scope ||
              previous.filterDsl !== (scenario.filterDsl ?? null) ||
              JSON.stringify(previous.parameters) !==
                JSON.stringify(scenario.parameters) ||
              typeof previous.rowsRead !== "number" ||
              !Number.isSafeInteger(previous.rowsRead) ||
              previous.rowsRead <= 0 ||
              previous.rowsWritten !== 0 ||
              !("value" in previous) ||
              (previous.status !== undefined && previous.status !== "passed")
            )
              throw new Error(
                `c01_family_baseline_incompatible:${scenario.name}`,
              );
            baselineByScenario.set(scenario.name, {
              rowsRead: previous.rowsRead,
              value: previous.value,
            });
          }
        }
      } catch (error) {
        report.push({
          engine: "remote-cloudflare-d1",
          scenario: "setup / safety and fixture fingerprint",
          status: "failed",
          phase: "preflight",
          visits,
          error: errorEvidence(error),
          statementDetail: [],
          metadataStatus: "not-measured",
        });
        throw error;
      }
    }, 900000);
    afterAll(() => {
      local?.close();
      for (const row of report) {
        if (row.status === "running") {
          row.status = "incomplete";
          row.reason =
            "Suite ended before execution returned; completed statement metadata is partial";
        }
      }
      const path = resolve(
        process.env.C01_FAMILIES_REPORT_PATH ??
          ".tmp/c01-remote-analytics-families.json",
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(report, null, 2));
    });
    it.each(ANALYTICS_COST_SCENARIOS)(
      "$name matches the full local DTO and records genuine D1 metadata",
      async (scenario) => {
        const metas: RemoteStatementMeta[] = [];
        const observed = observeStatementAttempts(
          createRemoteD1Database({
            ...options,
            onStatement: (meta) => metas.push(meta),
          }),
        );
        const row: Record<string, unknown> = {
          engine: "remote-cloudflare-d1",
          status: "running",
          scenario: scenario.name,
          family: scenario.family,
          operation: scenario.operation,
          scope: scenario.scope,
          filterDsl: scenario.filterDsl ?? null,
          parameters: scenario.parameters,
          time: COST_TIME,
          sqlEngineVersion: {
            status: "not-probed",
            reason:
              "Engine version unknown; sqlite_version authorizer support is not assumed",
          },
          nodeVersion: process.version,
          seedFingerprint: seedFingerprint(visits),
          verifiedDatabaseFingerprint,
          visits,
          baselineBudget: baselinePath
            ? {
                status: "requested",
                source: baselinePath,
                maxRowsRead: baselineByScenario.get(scenario.name)?.rowsRead,
              }
            : {
                status: "not-requested",
                reason:
                  "No same-scale remote baseline supplied; no before-cost comparison is claimed",
              },
          statementDetail: metas,
          statementAttempts: observed.attempts,
        };
        report.push(row);
        let phase = "local-reference";
        const started = performance.now();
        try {
          const referenceDatabase = observeCostDatabase(
            createSqliteD1Database(local),
          );
          const reference = await executeAnalyticsCostScenario(
            {
              DB: referenceDatabase.database,
              MAIN_SECRET: "c01-secret",
            } as Env,
            scenario,
          );
          row.reference = {
            engine: "local-node-sqlite",
            sqliteVersion: process.versions.sqlite,
            ...reference,
            ...summarizeCost(referenceDatabase.observations),
          };
          phase = "remote-execution";
          const execution = await executeAnalyticsCostScenario(
            { DB: observed.database, MAIN_SECRET: "c01-secret" } as Env,
            scenario,
          );
          if (metas.length === 0)
            throw new Error("c01_remote_statements_missing");
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
          Object.assign(row, execution, cost);
          phase = "dto-and-cost-validation";
          expect(execution.value).toEqual(reference.value);
          expect(execution.actualStrategies).toEqual(
            reference.actualStrategies,
          );
          const measurement: C01FixtureMeasurement = {
            engine: "remote-cloudflare-d1",
            visits,
            seedFingerprint: seedFingerprint(visits),
            scenario,
            time: COST_TIME,
            cost,
          };
          row.absoluteBudget = assertC01AnalyticsFixtureBudget(measurement);
          row.growthBudget =
            visits === 10000
              ? {
                  ...assertC01AnalyticsFixtureGrowth(
                    smallerMeasurements.get(scenario.name)!,
                    measurement,
                  ),
                  smallerReportPath,
                }
              : {
                  status: "baseline",
                  smallerVisits: 2000,
                  largerVisits: 10000,
                  maxGrowth: 7,
                };
          expect(cost.rowsRead).toBeGreaterThan(0);
          expect(cost.rowsWritten).toBe(0);
          if (baselinePath) {
            const baseline = baselineByScenario.get(scenario.name)!;
            expect(
              execution.value,
              `${scenario.name}: original remote DTO`,
            ).toEqual(baseline.value);
            expect(
              cost.rowsRead,
              `${scenario.name}: remote same-scale before budget`,
            ).toBeLessThanOrEqual(baseline.rowsRead);
          }
          expect(cost.maxParameters).toBeLessThanOrEqual(100);
          expect(cost.maxSqlBytes).toBeLessThanOrEqual(100000);
          row.status = "passed";
        } catch (error) {
          Object.assign(row, {
            status: "failed",
            phase,
            error: errorEvidence(error),
            observedElapsedMs: Number((performance.now() - started).toFixed(3)),
            completedStatementCost: metas.length
              ? {
                  statements: metas.length,
                  rowsRead: metas.reduce((sum, meta) => sum + meta.rowsRead, 0),
                  rowsWritten: metas.reduce(
                    (sum, meta) => sum + meta.rowsWritten,
                    0,
                  ),
                  sqlDurationMs: metas.reduce(
                    (sum, meta) => sum + meta.sqlDurationMs,
                    0,
                  ),
                }
              : null,
            failedStatementCost: observed.attempts.some(
              (attempt) => attempt.status === "failed",
            )
              ? {
                  status: "unavailable",
                  reason:
                    "D1 did not return complete metadata for the failed execution",
                  rowsRead: null,
                  rowsWritten: null,
                  sqlDurationMs: null,
                }
              : null,
          });
          throw error;
        }
      },
      300000,
    );
    it("records every requested scenario as successful", () => {
      expect(report).toHaveLength(ANALYTICS_COST_SCENARIOS.length);
      expect(report.every((row) => row.status === "passed")).toBe(true);
    });
  },
);
