// @vitest-environment node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";

import { c01FixtureRequestFingerprint } from "./analytics-fixture-cost-budgets";
import { errorEvidence } from "./cost-guards";
import {
  assertDurationCandidateReadBudget,
  type DurationBaselineArchive,
  type DurationCalibration,
  readDurationBaselineEvidence,
} from "./duration-baseline-evidence";
import {
  calibrateDuration,
  DURATION_PROTOCOL,
  durationFingerprint,
  validateDuration,
  validateDurationContext,
} from "./duration-contract";
import { databaseFingerprint } from "./fingerprint";
import { assertJourneyEventFieldsCostBudget } from "./journey-event-fields-cost-budgets";
import { buildJourneyEventFieldsCostFixture } from "./journey-event-fields-cost-fixture";
import {
  assertPositiveJourneyEventFieldsDto,
  executeJourneyEventFieldsCostScenario,
  JOURNEY_EVENT_FIELDS_COST_SCENARIOS,
} from "./journey-event-fields-cost-scenarios";
import { COST_TIME } from "./referrers-cost-harness";
import { C01_ACCOUNT_ID } from "./remote-cost-fixture";
import {
  assertDisposableDatabase,
  createRemoteD1Database,
  createRemoteRequestPacing,
  type RemoteHttpAttempt,
  type RemoteStatementMeta,
} from "./remote-d1-database";

const enabled = process.env.C01_DURATION_REMOTE === "1";
const phase = process.env.C01_DURATION_PHASE ?? "calibrate";
const visits = Number(process.env.C01_VISITS ?? "10000");
const scenarios = JOURNEY_EVENT_FIELDS_COST_SCENARIOS;
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function sourceSnapshot() {
  const paths = ["src/lib/db/query", "src/lib/edge/analytics"].flatMap((root) =>
    readdirSync(root, { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".ts") && !path.includes("__tests__"))
      .map((path) => `${root}/${path.replaceAll("\\", "/")}`),
  );
  paths.push(
    "src/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture.ts",
    "src/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-scenarios.ts",
    "src/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/remote-d1-database.ts",
    "src/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/duration-contract.ts",
    "src/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/duration-baseline-evidence.ts",
    "src/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-duration-remote.test.ts",
    "src/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-budgets.ts",
  );
  return Object.fromEntries(
    paths.sort().map((path) => [path, digest(readFileSync(path))]),
  );
}
interface Cell {
  identity: string;
  baselineIdentity?: string;
  windows: number[][];
  budget?: ReturnType<typeof calibrateDuration>;
}
it.skipIf(!enabled)(
  "C01 independent nine-case real D1 duration contract (explicit read-only opt-in)",
  async () => {
    if (visits !== 2000 && visits !== 10000)
      throw new Error("c01_duration_scale_unsupported");
    if (phase !== "calibrate" && phase !== "validate" && phase !== "candidate")
      throw new Error("c01_duration_phase_unsupported");
    const artifactPath = resolve(
      process.env.C01_DURATION_CALIBRATION_PATH ??
        `.tmp/c01-duration-calibration-${visits}.json`,
    );
    const reportPath = resolve(
      process.env.C01_DURATION_REPORT_PATH ??
        `.tmp/c01-duration-${phase}-${visits}.json`,
    );
    if (phase === "calibrate" && existsSync(artifactPath))
      throw new Error("c01_duration_refuses_overwrite_frozen_calibration");
    const frozenBytes =
      phase !== "calibrate" ? readFileSync(artifactPath, "utf8") : undefined;
    const frozen = frozenBytes
      ? (JSON.parse(frozenBytes) as DurationCalibration)
      : undefined;
    if (
      frozenBytes &&
      digest(frozenBytes) !== process.env.C01_DURATION_CALIBRATION_SHA256
    )
      throw new Error("c01_duration_frozen_sha_required_or_mismatched");
    if (
      frozen &&
      durationFingerprint(frozen.protocol) !==
        durationFingerprint(DURATION_PROTOCOL)
    )
      throw new Error("c01_duration_protocol_changed");
    if (
      frozen &&
      durationFingerprint(Object.keys(frozen.cells).sort()) !==
        durationFingerprint(scenarios.map((scenario) => scenario.name).sort())
    )
      throw new Error("c01_duration_frozen_cell_set_changed");
    let baselineEvidenceSha256: string | undefined;
    let baselineEvidence:
      ReturnType<typeof readDurationBaselineEvidence> | undefined;
    if (phase === "candidate") {
      const evidencePath = process.env.C01_DURATION_BASELINE_EVIDENCE_PATH;
      if (!evidencePath)
        throw new Error("c01_duration_candidate_baseline_evidence_required");
      const evidenceBytes = readFileSync(resolve(evidencePath), "utf8");
      baselineEvidenceSha256 = digest(evidenceBytes);
      if (
        baselineEvidenceSha256 !==
        process.env.C01_DURATION_BASELINE_EVIDENCE_SHA256
      )
        throw new Error(
          "c01_duration_candidate_baseline_evidence_sha_mismatch",
        );
      baselineEvidence = readDurationBaselineEvidence({
        frozen: frozen!,
        frozenSha256: digest(frozenBytes!),
        archive: JSON.parse(evidenceBytes) as DurationBaselineArchive,
      });
    }
    const requestPacing =
      phase === "candidate" ? createRemoteRequestPacing(1000) : undefined;
    const fixture = buildJourneyEventFieldsCostFixture(visits);
    const sources = sourceSnapshot();
    const setupMetas: RemoteStatementMeta[] = [];
    const setupHttpAttempts: RemoteHttpAttempt[] = [];
    const samples: Record<string, unknown>[] = [];
    const sqlCatalog: Record<string, string> = {};
    const cells: Record<string, Cell> = {};
    const report: Record<string, unknown> = {
      status: "running",
      phase,
      visits,
      protocol: DURATION_PROTOCOL,
      samples,
      setupStatementDetail: setupMetas,
      setupHttpAttempts,
      sqlCatalog,
      sourceWindow: { before: sources },
      calibrationSha256: frozenBytes ? digest(frozenBytes) : null,
      baselineEvidenceSha256: baselineEvidenceSha256 ?? null,
      transportPacing: {
        kind: requestPacing ? "fixed-shared-request-start-spacing" : "none",
        requestStartIntervalMs: requestPacing?.startIntervalMs ?? 0,
        scope: "preflight, fingerprint, provider SQL and every HTTP attempt",
        providerElapsedIncludesPacing: true,
        serverSqlDurationIncludesPacing: false,
        changesFrozenDurationBudget: false,
      },
      timing: {
        primary: "sum of actual provider statement SQL durations",
        fallback:
          "source retained per statement; duration fallback remains explicitly distinct",
        elapsed:
          "provider elapsed measured separately; HTTP/backoff metadata recorded independently",
        percentileClaim: false,
      },
      windows: [],
    };
    const save = () => {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    };
    const local = createMigratedDatabase();
    let currentPhase = "setup";
    try {
      save();
      if (process.env.C01_ACCOUNT_ID !== C01_ACCOUNT_ID)
        throw new Error("c01_refuses_unapproved_account_id");
      const token = process.env.CLOUDFLARE_API_TOKEN;
      if (!token) throw new Error("c01_remote_token_missing");
      const options = {
        accountId: C01_ACCOUNT_ID,
        databaseId: process.env.C01_D1_DATABASE_ID ?? "",
        token,
        ...(requestPacing ? { requestPacing } : {}),
        onHttpAttempt: (attempt: RemoteHttpAttempt) =>
          setupHttpAttempts.push(attempt),
      };
      await assertDisposableDatabase(options);
      for (const sql of fixture.seed) local.exec(sql);
      local.exec("PRAGMA query_only=ON");
      const native = createSqliteD1Database(local);
      const expectedFingerprint = await databaseFingerprint(
        native,
        visits,
        fixture.seed,
      );
      const context = {
        visits,
        fixtureSeedFingerprint: fixture.fingerprint,
        databaseFingerprint: expectedFingerprint,
        sources,
        requests: Object.fromEntries(
          scenarios.map((scenario) => [
            scenario.name,
            c01FixtureRequestFingerprint(scenario, COST_TIME),
          ]),
        ),
      };
      const contextFingerprint = durationFingerprint(context);
      Object.assign(report, { context, contextFingerprint });
      if (frozen) {
        if (durationFingerprint(frozen.context) !== frozen.contextFingerprint)
          throw new Error("c01_duration_frozen_context_fingerprint_invalid");
        report.contextValidation = validateDurationContext({
          phase: phase as "validate" | "candidate",
          baseline: frozen.context,
          candidate: context,
          ...(process.env.C01_DURATION_CANDIDATE_SOURCE_SHA256
            ? {
                expectedCandidateSourceSha256:
                  process.env.C01_DURATION_CANDIDATE_SOURCE_SHA256,
              }
            : {}),
        });
      }
      const references = new Map<
        string,
        Awaited<ReturnType<typeof executeJourneyEventFieldsCostScenario>>
      >();
      for (const scenario of scenarios)
        references.set(
          scenario.name,
          await executeJourneyEventFieldsCostScenario(
            { DB: native, MAIN_SECRET: "c01-secret" } as Env,
            scenario,
          ),
        );
      const verify = async () => {
        expect(sourceSnapshot()).toEqual(sources);
        const actual = await databaseFingerprint(
          createRemoteD1Database({
            ...options,
            onStatement: (meta) => setupMetas.push(meta),
          }),
          visits,
          fixture.seed,
        );
        if (actual !== expectedFingerprint)
          throw new Error("c01_duration_strict_database_fingerprint_mismatch");
        if (setupMetas.some((meta) => meta.rowsWritten !== 0))
          throw new Error("c01_duration_setup_write");
      };
      const execute = async (
        scenario: (typeof scenarios)[number],
        window: number,
        repetition: number,
        kind: "warmup" | "measured",
      ) => {
        const metas: RemoteStatementMeta[] = [];
        const attempts: RemoteHttpAttempt[] = [];
        const sample: Record<string, unknown> = {
          status: "running",
          scenario: scenario.name,
          window,
          repetition,
          kind,
          startedAt: new Date().toISOString(),
          httpAttempts: attempts,
        };
        samples.push(sample);
        const captureStatement = ({ sql, ...meta }: RemoteStatementMeta) => {
          metas.push({ sql, ...meta });
          const sqlRef = digest(sql);
          sqlCatalog[sqlRef] = sql;
          const details = (sample.statementDetail ??= []) as Record<
            string,
            unknown
          >[];
          details.push({ ...meta, sqlRef });
          sample.completedStatementCost = {
            statements: metas.length,
            rowsRead: metas.reduce((sum, item) => sum + item.rowsRead, 0),
            rowsWritten: metas.reduce((sum, item) => sum + item.rowsWritten, 0),
            sqlDurationMs: metas.reduce(
              (sum, item) => sum + item.sqlDurationMs,
              0,
            ),
          };
          save();
        };
        try {
          const result = await executeJourneyEventFieldsCostScenario(
            {
              DB: createRemoteD1Database({
                ...options,
                onStatement: captureStatement,
                onHttpAttempt: (attempt) => {
                  attempts.push(attempt);
                  save();
                },
              }),
              MAIN_SECRET: "c01-secret",
            } as Env,
            scenario,
          );
          if (
            !metas.length ||
            metas.some(
              (meta, index) =>
                meta.statementOrdinal !== index + 1 ||
                !meta.sqlDurationSource ||
                !meta.durationRaw ||
                !Number.isFinite(meta.sqlDurationMs) ||
                meta.sqlDurationMs < 0 ||
                !Number.isSafeInteger(meta.rowsRead) ||
                meta.rowsRead < 0 ||
                meta.rowsWritten !== 0,
            )
          )
            throw new Error("c01_duration_statement_metadata_invalid");
          if (
            attempts.some(
              (attempt) =>
                attempt.retry ||
                attempt.status !== 200 ||
                attempt.outcome !== "response",
            )
          )
            throw new Error("c01_duration_retry_obscured_or_failed_sample");
          const reference = references.get(scenario.name)!;
          expect(result.value).toEqual(reference.value);
          if (baselineEvidence) {
            const baseline = baselineEvidence.get(scenario.name)!;
            expect(result.value).toEqual(baseline.value);
            if (
              metas.some((meta) => meta.sqlDurationSource !== baseline.source)
            )
              throw new Error("c01_duration_candidate_timing_metric_changed");
          }
          expect(result.actualStrategies).toEqual(reference.actualStrategies);
          assertPositiveJourneyEventFieldsDto(scenario, result.value);
          const cost = {
            rowsRead: metas.reduce((sum, meta) => sum + meta.rowsRead, 0),
            rowsWritten: 0,
            statements: metas.length,
          };
          const absoluteBudget = assertJourneyEventFieldsCostBudget({
            engine: "remote-cloudflare-d1",
            visits,
            seedFingerprint: fixture.fingerprint,
            scenario,
            time: COST_TIME,
            cost,
          });
          if (baselineEvidence)
            assertDurationCandidateReadBudget({
              baseline: baselineEvidence.get(scenario.name)!.absoluteBudget,
              currentBudget: absoluteBudget,
              cost,
            });
          expect(
            Math.max(...metas.map((meta) => meta.parameterCount)),
          ).toBeLessThanOrEqual(100);
          expect(
            Math.max(...metas.map((meta) => Buffer.byteLength(meta.sql))),
          ).toBeLessThanOrEqual(100000);
          const identity = durationFingerprint({
            request: c01FixtureRequestFingerprint(scenario, COST_TIME),
            strategies: result.actualStrategies,
            statements: metas.map((meta) => ({
              sql: meta.sql,
              params: meta.params,
              durationSource: meta.sqlDurationSource,
            })),
          });
          const cell = (cells[scenario.name] ??= {
            identity:
              phase === "validate"
                ? frozen!.cells[scenario.name]!.identity
                : identity,
            ...(frozen
              ? { baselineIdentity: frozen.cells[scenario.name]!.identity }
              : {}),
            windows: Array.from(
              { length: phase === "calibrate" ? 3 : 1 },
              () => [],
            ),
          });
          if (identity !== cell.identity)
            throw new Error(
              "c01_duration_sql_params_strategy_or_timing_source_changed",
            );
          const sqlDurationMs = metas.reduce(
            (sum, meta) => sum + meta.sqlDurationMs,
            0,
          );
          if (!Number.isFinite(sqlDurationMs) || sqlDurationMs < 0)
            throw new Error("c01_duration_statement_sum_invalid");
          if (kind === "measured") cell.windows[window]!.push(sqlDurationMs);
          Object.assign(sample, {
            status: "passed",
            ...cost,
            sqlDurationMs,
            elapsedMs: result.elapsedMs,
            identity,
            ...(frozen
              ? { baselineIdentity: frozen.cells[scenario.name]!.identity }
              : {}),
            value: result.value,
            actualStrategies: result.actualStrategies,
            completeNativeDtoEqual: true,
            ...(baselineEvidence ? { completeBaselineDtoEqual: true } : {}),
            absoluteBudget,
          });
        } catch (error) {
          sample.status = "failed";
          sample.error = errorEvidence(error);
          throw error;
        } finally {
          save();
        }
      };
      const windowCount = phase === "calibrate" ? DURATION_PROTOCOL.windows : 1;
      for (let window = 0; window < windowCount; window += 1) {
        if (window > 0)
          await new Promise((resolve) =>
            setTimeout(resolve, DURATION_PROTOCOL.windowGapMs),
          );
        currentPhase = `window-${window + 1}`;
        const windowRecord: Record<string, unknown> = {
          index: window,
          startedAt: new Date().toISOString(),
        };
        (report.windows as Record<string, unknown>[]).push(windowRecord);
        await verify();
        if (phase === "calibrate")
          for (const scenario of scenarios)
            await execute(scenario, window, -1, "warmup");
        const repetitions =
          phase === "calibrate"
            ? DURATION_PROTOCOL.repetitionsPerWindow
            : DURATION_PROTOCOL.validationRepetitions;
        for (let repetition = 0; repetition < repetitions; repetition += 1)
          for (let index = 0; index < scenarios.length; index += 1)
            await execute(
              scenarios[(index + repetition + window) % scenarios.length]!,
              window,
              repetition,
              "measured",
            );
        windowRecord.endedAt = new Date().toISOString();
        save();
      }
      currentPhase = "final-proof";
      await verify();
      if (phase === "calibrate") {
        for (const cell of Object.values(cells))
          cell.budget = calibrateDuration(cell.windows);
        const calibration: DurationCalibration = {
          protocol: DURATION_PROTOCOL,
          context,
          contextFingerprint,
          cells,
        };
        mkdirSync(dirname(artifactPath), { recursive: true });
        writeFileSync(artifactPath, JSON.stringify(calibration, null, 2), {
          flag: "wx",
        });
        report.frozenCalibrationSha256 = digest(readFileSync(artifactPath));
      } else {
        report.validation = Object.fromEntries(
          scenarios.map((scenario) => {
            const budget = frozen?.cells[scenario.name]?.budget;
            if (!budget) throw new Error("c01_duration_frozen_cell_missing");
            return [
              scenario.name,
              validateDuration(budget, cells[scenario.name]!.windows[0]!),
            ];
          }),
        );
        if (digest(readFileSync(artifactPath)) !== digest(frozenBytes!))
          throw new Error("c01_duration_frozen_calibration_modified");
      }
      report.status = "passed";
    } catch (error) {
      report.status = "failed";
      report.failedPhase = currentPhase;
      report.error = errorEvidence(error);
      throw error;
    } finally {
      local.close();
      (report.sourceWindow as Record<string, unknown>).after = sourceSnapshot();
      report.cells = cells;
      save();
    }
  },
  1800000,
);
