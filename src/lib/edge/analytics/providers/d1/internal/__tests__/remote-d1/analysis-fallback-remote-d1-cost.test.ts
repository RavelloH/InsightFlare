// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";

import {
  ANALYSIS_FALLBACK_BASELINE_ARCHIVE_SHA256,
  readAnalysisFallbackBaselineEvidence,
} from "./analysis-fallback-baseline-evidence";
import {
  ANALYSIS_FALLBACK_SCENARIOS,
  type AnalysisFallbackRoute,
  buildAnalysisFallbackCostFixture,
  executeAnalysisFallbackCost,
} from "./analysis-fallback-cost-harness";
import { errorEvidence, type ExplainRow } from "./cost-guards";
import { durationFingerprint } from "./duration-contract";
import { databaseFingerprint } from "./fingerprint";
import { buildJourneyEventFieldsCostFixture } from "./journey-event-fields-cost-fixture";
import { C01_ACCOUNT_ID, resetRemoteCostFixture } from "./remote-cost-fixture";
import {
  assertDisposableDatabase,
  C01_DATABASE_ID,
  C01_DATABASE_NAME,
  createRemoteD1Database,
  createRemoteRequestPacing,
  type RemoteD1Options,
  type RemoteHttpAttempt,
  type RemoteStatementMeta,
} from "./remote-d1-database";

const enabled = process.env.C01_ANALYSIS_REMOTE === "1";
const visits = 2000;
const mode = process.env.C01_ANALYSIS_REMOTE_MODE ?? "paired";
const candidateOnly = mode === "candidate";
const previousFingerprint =
  "c63077b9ffb53739beb7cd6308fcb60140d5c3242903f5e8c5c349c2b43d6a46";
const fingerprint = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function sourceSnapshot() {
  const files = ["src/lib/db/query", "src/lib/edge/analytics"].flatMap((root) =>
    readdirSync(root, { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".ts") && !path.includes("__tests__"))
      .map((path) => `${root}/${path.replaceAll("\\", "/")}`),
  );
  files.push(
    ...[
      "analysis-fallback-cost-harness.ts",
      "analysis-fallback-remote-d1-cost.test.ts",
      "journey-event-fields-cost-fixture.ts",
      "seed.ts",
      "remote-d1-database.ts",
      "remote-cost-fixture.ts",
      "fingerprint.ts",
      ...(candidateOnly
        ? ["analysis-fallback-baseline-evidence.ts", "duration-contract.ts"]
        : []),
    ].map(
      (file) =>
        `src/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/${file}`,
    ),
  );
  return Object.fromEntries(
    files.sort().map((file) => [file, fingerprint(readFileSync(file))]),
  );
}

describe.skipIf(!enabled)(
  "C01 Goal/Funnel actual runtime fallback real D1 observational cost (explicit opt-in)",
  () => {
    const fixture = buildAnalysisFallbackCostFixture(visits);
    const path = resolve(
      process.env.C01_ANALYSIS_REMOTE_REPORT_PATH ??
        ".tmp/c01-remote-analysis-fallback-2000.json",
    );
    const cases: Record<string, unknown>[] = [];
    let baseline:
      ReturnType<typeof readAnalysisFallbackBaselineEvidence> | undefined;
    const setupMetas: RemoteStatementMeta[] = [];
    const setupAttempts: RemoteHttpAttempt[] = [];
    const sourceBefore = sourceSnapshot();
    const setup: Record<string, unknown> = {
      status: "not-started",
      explicitReset: process.env.C01_ANALYSIS_RESEED === "1",
      statements: setupMetas,
      httpAttempts: setupAttempts,
    };
    const report: Record<string, unknown> = {
      suite: "C01 actual Goal/Funnel analysisContext numeric Core fallback",
      scope: "2k only; old 10k Funnel is prohibited",
      fixture: {
        visits,
        seedFingerprint: fixture.fingerprint,
        baseFixtureFingerprint: fixture.baseFixtureFingerprint,
        seedStatements: fixture.seed,
      },
      mode,
      ...(candidateOnly
        ? {
            target: {
              accountId: C01_ACCOUNT_ID,
              databaseId: C01_DATABASE_ID,
              databaseName: C01_DATABASE_NAME,
            },
          }
        : {}),
      ...(candidateOnly
        ? {
            historicalReference: {
              archiveSha256: ANALYSIS_FALLBACK_BASELINE_ARCHIVE_SHA256,
              archiveStatus: "failed",
              acceptance:
                "completed successful SQL non-regression only; not historical failed-route total-cost upper bounds or accepted hotspot budgets",
              timingBaseline:
                "unavailable; no old/new duration acceptance claimed",
              remoteOldRouteExecutions: 0,
              providerExecutions: "8 primary cells + 1 existing cursor subcase",
            },
          }
        : {}),
      budgetStatus: {
        rowsRead: "observational-only; no absolute read ceiling established",
        knownFunnelHotspot: candidateOnly
          ? "The historical paired fixture exposed approximately 185–198M 2k reads; the successful-SQL reference is not an accepted hotspot budget and candidate improvement needs a separately reviewed target"
          : "Old and new routes share an unfixed repeated-inline-owner UNION hotspot; approximately 185–198M local 2k reads are not an accepted budget",
        duration:
          "observational-only; independent nine-case duration budget does not apply",
        hardGuards: [
          "complete DTO and canonical metadata parity",
          "positive real Core execution",
          "old bridge=1 / request relation bridge=0",
          "zero provider writes",
          "genuine complete cost metadata",
          "SQL <=100kB and parameters <=100",
          "source and database fingerprints unchanged",
        ],
      },
      nodeVersion: process.version,
      nativeSqliteVersion: process.versions.sqlite,
      remoteSqlEngineVersion: {
        status: "unknown",
        reason: "D1 sqlite_version authorizer support is not assumed",
      },
      transportProtocol: {
        requestStartIntervalMs: 1000,
        serialHttpCompletion: true,
        adaptsAfterFailure: false,
        ...(candidateOnly ? { retryPolicy: "none" } : {}),
        pacingExcludedFromHttpElapsedAndServerSqlDuration: true,
      },
      sourceWindow: { before: sourceBefore },
      setup,
      cases,
    };
    let saveEnabled = false;
    const save = () => {
      if (saveEnabled) writeFileSync(path, JSON.stringify(report, null, 2));
    };
    let local: DatabaseSync | undefined;
    let options: RemoteD1Options | undefined;
    let expectedFingerprint: string | undefined;

    beforeAll(async () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(report, null, 2), { flag: "wx" });
      saveEnabled = true;
      setup.status = "running";
      let phase = "target-preflight";
      try {
        if (mode !== "paired" && mode !== "candidate")
          throw new Error("c01_analysis_unknown_remote_mode");
        if (candidateOnly) {
          phase = "candidate-baseline-and-source-preflight";
          if (process.env.C01_ANALYSIS_RESEED === "1")
            throw new Error("c01_analysis_candidate_refuses_reset");
          const companionPath =
            process.env.C01_ANALYSIS_BASELINE_COMPANION_PATH;
          const companionSha =
            process.env.C01_ANALYSIS_BASELINE_COMPANION_SHA256;
          const candidateSourceSha =
            process.env.C01_ANALYSIS_CANDIDATE_SOURCE_FINGERPRINT;
          if (!companionPath || !companionSha || !candidateSourceSha)
            throw new Error(
              "c01_analysis_candidate_requires_pinned_evidence_and_source",
            );
          baseline = readAnalysisFallbackBaselineEvidence({
            archiveBytes: readFileSync(
              resolve(
                "docs/unified-query/c01-analysis-fallback-v3-paced-failed-20261114.json",
              ),
            ),
            companionBytes: readFileSync(resolve(companionPath)),
            expectedCompanionSha256: companionSha,
          });
          expect(durationFingerprint(sourceBefore)).toBe(candidateSourceSha);
          expect(baseline.fixture.visits).toBe(visits);
          expect(baseline.fixture.seedFingerprint).toBe(fixture.fingerprint);
          expect(baseline.fixture.baseFixtureFingerprint).toBe(
            fixture.baseFixtureFingerprint,
          );
          Object.assign(report.historicalReference as object, {
            companionPath,
            companionSha256: companionSha,
            baselineSourceManifest: baseline.sourceManifest,
            baselineSourceManifestFingerprint:
              baseline.sourceManifestFingerprint,
            candidateSourceManifestFingerprint: candidateSourceSha,
          });
        }
        if (
          process.env.C01_ACCOUNT_ID !== C01_ACCOUNT_ID ||
          (process.env.C01_VISITS && process.env.C01_VISITS !== "2000")
        )
          throw new Error("c01_analysis_refuses_account_or_scale");
        const token = process.env.CLOUDFLARE_API_TOKEN;
        if (!token) throw new Error("c01_remote_token_missing");
        options = {
          accountId: C01_ACCOUNT_ID,
          databaseId: process.env.C01_D1_DATABASE_ID ?? "",
          token,
          ...(candidateOnly ? { retryPolicy: "none" as const } : {}),
          requestPacing: createRemoteRequestPacing(1000),
          onStatement(meta) {
            setupMetas.push(meta);
            save();
          },
          onHttpAttempt(attempt) {
            setupAttempts.push(attempt);
            save();
          },
        };
        if (baseline) {
          expect(baseline.target.accountId).toBe(options.accountId);
          expect(baseline.target.databaseId).toBe(options.databaseId);
          expect(baseline.target.databaseName).toBe(C01_DATABASE_NAME);
        }
        await assertDisposableDatabase(options);
        local = createMigratedDatabase();
        for (const sql of fixture.seed) local.exec(sql);
        local.exec("PRAGMA query_only=ON");
        expectedFingerprint = await databaseFingerprint(
          createSqliteD1Database(local),
          visits,
          fixture.seed,
        );
        if (baseline)
          expect(expectedFingerprint).toBe(
            baseline.fixture.databaseFingerprint,
          );
        Object.assign(report.fixture as object, {
          expectedDatabaseFingerprint: expectedFingerprint,
        });
        if (process.env.C01_ANALYSIS_RESEED === "1") {
          phase = "strict-previous-10k-fingerprint";
          const frozenSha = fingerprint(
            readFileSync(
              resolve(
                ".tmp/c01-duration-calibration-journey-fields-10000-v2.json",
              ),
            ),
          );
          expect(frozenSha).toBe(
            "284ac8bbe3d3d6829aaf42360cbe84c4ed6c1438df14d276727c84461603326e",
          );
          const durationArchiveSha = fingerprint(
            readFileSync(
              resolve("docs/unified-query/c01-duration-after-20261114.json"),
            ),
          );
          expect(durationArchiveSha).toBe(
            "2f94f410acc68e65148a81724f7a459f006c73ec80c6bfd2a6d18f7c09047259",
          );
          const previous = buildJourneyEventFieldsCostFixture(10000);
          const actual = await databaseFingerprint(
            createRemoteD1Database(options),
            10000,
            previous.seed,
          );
          if (actual !== previousFingerprint)
            throw new Error(
              "c01_analysis_previous_10k_fingerprint_mismatch_no_reset",
            );
          const proof = {
            status: "passed",
            verifiedAt: new Date().toISOString(),
            visits: 10000,
            seedFingerprint: previous.fingerprint,
            databaseFingerprint: actual,
            durationFrozenArtifactSha256: frozenSha,
            durationArchiveSha256: durationArchiveSha,
            statements: [...setupMetas],
            httpAttempts: [...setupAttempts],
          };
          expect(setupMetas.every((meta) => meta.rowsWritten === 0)).toBe(true);
          const proofPath = resolve(
            process.env.C01_ANALYSIS_PREVIOUS_PROOF_PATH ??
              ".tmp/c01-analysis-fallback-pre-reset-10000.json",
          );
          mkdirSync(dirname(proofPath), { recursive: true });
          writeFileSync(proofPath, JSON.stringify(proof, null, 2), {
            flag: "wx",
          });
          report.previousFixtureProof = {
            path: proofPath,
            sha256: fingerprint(readFileSync(proofPath)),
            ...proof,
          };
          save();
          phase = "explicit-planned-reset";
          expect(sourceSnapshot()).toEqual(sourceBefore);
          // This branch is selected only by the explicit flag, never a caught error.
          await resetRemoteCostFixture(
            options,
            unstable_splitSqlQuery(fixture.schemaSql),
            fixture.seed,
          );
        }
        phase = "strict-new-2k-fingerprint";
        const verificationStart = setupMetas.length;
        const actual = await databaseFingerprint(
          createRemoteD1Database(options),
          visits,
          fixture.seed,
        );
        if (actual !== expectedFingerprint)
          throw new Error(
            "c01_analysis_new_fixture_mismatch_no_automatic_reset",
          );
        expect(
          setupMetas
            .slice(verificationStart)
            .every((meta) => meta.rowsWritten === 0),
        ).toBe(true);
        expect(sourceSnapshot()).toEqual(sourceBefore);
        Object.assign(report.fixture as object, {
          verifiedDatabaseFingerprint: actual,
        });
        setup.status = "passed";
      } catch (error) {
        Object.assign(setup, {
          status: "failed",
          phase,
          error: errorEvidence(error),
        });
        throw error;
      } finally {
        save();
      }
    }, 900000);

    afterAll(async () => {
      if (candidateOnly) {
        const errors: unknown[] = [];
        try {
          if (setup.status === "passed" && options) {
            report.finalDatabaseFingerprint = await databaseFingerprint(
              createRemoteD1Database(options),
              visits,
              fixture.seed,
            );
            expect(report.finalDatabaseFingerprint).toBe(expectedFingerprint);
          }
        } catch (error) {
          report.finalDatabaseProofError = errorEvidence(error);
          errors.push(error);
        }
        try {
          (report.sourceWindow as Record<string, unknown>).after =
            sourceSnapshot();
          expect(
            (report.sourceWindow as Record<string, unknown>).after,
          ).toEqual(sourceBefore);
        } catch (error) {
          report.finalSourceProofError = errorEvidence(error);
          errors.push(error);
        }
        try {
          expect(
            setupMetas.every(
              (meta) =>
                Number.isSafeInteger(meta.rowsRead) &&
                meta.rowsRead >= 0 &&
                meta.rowsWritten === 0 &&
                Number.isFinite(meta.sqlDurationMs) &&
                meta.sqlDurationMs >= 0 &&
                !!meta.sqlDurationSource &&
                !!meta.durationRaw,
            ),
          ).toBe(true);
          expect(
            setupAttempts.every(
              (attempt) =>
                attempt.attempt === 1 &&
                attempt.status === 200 &&
                !attempt.retry &&
                attempt.backoffMs === 0 &&
                attempt.outcome === "response",
            ),
          ).toBe(true);
        } catch (error) {
          report.finalSetupCostProofError = errorEvidence(error);
          errors.push(error);
        } finally {
          local?.close();
          report.status =
            setup.status === "passed" &&
            cases.length === 8 &&
            cases.every((row) => row.status === "passed") &&
            !errors.length
              ? "candidate-dto-metadata-verified-historical-completed-sql-nonregression"
              : "failed";
          save();
        }
        if (errors.length)
          throw new AggregateError(
            errors,
            "c01_analysis_candidate_final_proof_failed",
          );
        return;
      }
      try {
        if (setup.status === "passed" && options) {
          const verificationStart = setupMetas.length;
          report.finalDatabaseFingerprint = await databaseFingerprint(
            createRemoteD1Database(options),
            visits,
            fixture.seed,
          );
          expect(report.finalDatabaseFingerprint).toBe(expectedFingerprint);
          expect(
            setupMetas
              .slice(verificationStart)
              .every((meta) => meta.rowsWritten === 0),
          ).toBe(true);
        }
        (report.sourceWindow as Record<string, unknown>).after =
          sourceSnapshot();
        expect((report.sourceWindow as Record<string, unknown>).after).toEqual(
          sourceBefore,
        );
      } catch (error) {
        report.finalProofError = errorEvidence(error);
        throw error;
      } finally {
        local?.close();
        report.status =
          setup.status === "passed" &&
          cases.length === 8 &&
          cases.every((row) => row.status === "passed") &&
          !report.finalProofError
            ? "dto-metadata-verified-read-cost-observational"
            : "failed";
        save();
      }
    }, 300000);

    it.each(ANALYSIS_FALLBACK_SCENARIOS)(
      "$name full native DTO/meta, genuine fallback paths and all D1 I/O",
      async (scenario) => {
        if (!local || !options || setup.status !== "passed")
          throw new Error("c01_analysis_setup_incomplete");
        expect(sourceSnapshot()).toEqual(sourceBefore);
        const row: Record<string, unknown> = {
          scenario: scenario.name,
          status: "running",
          visits,
        };
        cases.push(row);
        const native = createSqliteD1Database(local);
        const frozenCase = baseline?.cases.get(scenario.name);
        if (candidateOnly && !frozenCase)
          throw new Error("c01_analysis_candidate_frozen_case_missing");
        const pendingExplains: (() => Promise<void>)[] = [];
        const runRemote = async (
          route: AnalysisFallbackRoute,
          cursor: string | null = null,
        ) => {
          if (candidateOnly && route !== "request-relation")
            throw new Error("c01_analysis_candidate_refuses_remote_old_route");
          const metas: RemoteStatementMeta[] = [];
          const attempts: RemoteHttpAttempt[] = [];
          const record: Record<string, unknown> = {
            status: "running",
            remoteStatementDetail: metas,
            httpAttempts: attempts,
          };
          const label = `${route}${cursor ? "-cursor" : ""}`;
          row[label] = record;
          const sum = () => ({
            statements: metas.length,
            rowsRead: metas.reduce((total, meta) => total + meta.rowsRead, 0),
            rowsWritten: metas.reduce(
              (total, meta) => total + meta.rowsWritten,
              0,
            ),
            sqlDurationMs: metas.reduce(
              (total, meta) => total + meta.sqlDurationMs,
              0,
            ),
          });
          try {
            const result = await executeAnalysisFallbackCost(
              createRemoteD1Database({
                ...options!,
                onStatement(meta) {
                  metas.push(meta);
                  record.completedStatementCost = sum();
                  save();
                },
                onHttpAttempt(attempt) {
                  attempts.push(attempt);
                  save();
                },
              }),
              scenario,
              route,
              cursor,
              record,
            );
            if (candidateOnly) {
              const reference = cursor ? frozenCase?.cursorSample : frozenCase;
              if (!reference)
                throw new Error(
                  "c01_analysis_candidate_frozen_request_missing",
                );
              expect(
                durationFingerprint(JSON.parse(JSON.stringify(record.request))),
              ).toBe(reference.requestCanonicalFingerprint);
              expect(record.requestFingerprint).toBe(
                reference.requestFingerprint,
              );
              expect(result).toEqual(reference.value);
              const cost = sum();
              expect(Number.isSafeInteger(cost.rowsRead)).toBe(true);
              expect(cost.rowsRead).toBeLessThanOrEqual(
                reference.historicalCompletedSqlReadReference,
              );
              expect(cost.statements).toBeLessThanOrEqual(
                reference.historicalCompletedStatements,
              );
              Object.assign(record, {
                historicalCompletedSqlReadReference:
                  reference.historicalCompletedSqlReadReference,
                historicalCompletedStatements:
                  reference.historicalCompletedStatements,
                historicalTotalCostKnown: reference.historicalTotalCostKnown,
                historicalReferenceKind:
                  "successful completed SQL only; not a failed-route total upper bound or accepted hotspot budget",
              });
            }
            if (
              !metas.length ||
              metas.some(
                (meta, index) =>
                  !Number.isSafeInteger(meta.rowsRead) ||
                  meta.rowsRead < 0 ||
                  meta.rowsWritten !== 0 ||
                  !Number.isFinite(meta.sqlDurationMs) ||
                  meta.sqlDurationMs < 0 ||
                  !meta.sqlDurationSource ||
                  !meta.durationRaw ||
                  meta.statementOrdinal !== index + 1 ||
                  meta.parameterCount > 100 ||
                  Buffer.byteLength(meta.sql) > 100000,
              )
            )
              throw new Error("c01_analysis_missing_or_invalid_real_metadata");
            if (
              attempts.some(
                (attempt) =>
                  attempt.retry ||
                  (candidateOnly && attempt.attempt !== 1) ||
                  attempt.status !== 200 ||
                  attempt.outcome !== "response",
              )
            )
              throw new Error("c01_analysis_transport_sample_obscured");
            if (
              candidateOnly &&
              metas.some(
                (meta) =>
                  !Number.isSafeInteger(meta.parameterCount) ||
                  meta.parameterCount < 0 ||
                  !Number.isSafeInteger(meta.resultRows) ||
                  meta.resultRows < 0 ||
                  meta.parameterCount !== meta.params.length ||
                  meta.inputParams?.length !== meta.params.length ||
                  (meta.sqlDurationSource === "timings.sql_duration_ms"
                    ? meta.durationRaw?.timingsSqlDurationMs !==
                      meta.sqlDurationMs
                    : meta.sqlDurationSource !== "duration" ||
                      meta.durationRaw?.duration !== meta.sqlDurationMs),
              )
            )
              throw new Error(
                "c01_analysis_candidate_invalid_binding_or_duration_identity",
              );
            if (candidateOnly && attempts.length !== metas.length)
              throw new Error(
                "c01_analysis_candidate_unaccounted_http_attempt",
              );
            Object.assign(record, sum(), {
              metadataStatus: "complete",
              totalProviderCostKnown: true,
            });
            // Complete both real provider routes before diagnostic requests.
            // An EQP transport error remains a test failure, with its own
            // evidence, without suppressing the second provider execution.
            pendingExplains.push(async () => {
              const explain: unknown[] = [];
              const explainMetas: RemoteStatementMeta[] = [];
              const explainAttempts: RemoteHttpAttempt[] = [];
              record.explain = explain;
              record.explainStatementDetail = explainMetas;
              record.explainHttpAttempts = explainAttempts;
              for (const meta of metas) {
                const plan = await createRemoteD1Database({
                  ...options!,
                  onStatement(meta) {
                    explainMetas.push(meta);
                    save();
                  },
                  onHttpAttempt(attempt) {
                    explainAttempts.push(attempt);
                    save();
                  },
                })
                  .prepare(`EXPLAIN QUERY PLAN ${meta.sql}`)
                  .bind(...meta.params)
                  .all<ExplainRow>();
                explain.push({
                  sql: meta.sql,
                  params: meta.params,
                  plan: plan.results,
                });
                save();
              }
              expect(explainMetas.every((meta) => meta.rowsWritten === 0)).toBe(
                true,
              );
              if (candidateOnly) {
                expect(explainAttempts.length).toBe(explainMetas.length);
                expect(
                  explainAttempts.every(
                    (attempt) =>
                      attempt.attempt === 1 &&
                      attempt.status === 200 &&
                      !attempt.retry &&
                      attempt.backoffMs === 0 &&
                      attempt.outcome === "response",
                  ),
                ).toBe(true);
                expect(
                  explainMetas.every(
                    (meta) =>
                      Number.isSafeInteger(meta.rowsRead) &&
                      meta.rowsRead >= 0 &&
                      Number.isFinite(meta.sqlDurationMs) &&
                      meta.sqlDurationMs >= 0 &&
                      !!meta.sqlDurationSource &&
                      !!meta.durationRaw,
                  ),
                ).toBe(true);
              }
            });
            return result;
          } catch (error) {
            Object.assign(record, {
              status: "failed",
              error: errorEvidence(error),
              completedStatementCost: sum(),
              totalProviderCostKnown: false,
              failedAttemptCost:
                "unknown; completed successful metadata is not the failed provider execution total",
            });
            throw error;
          } finally {
            save();
          }
        };
        try {
          if (candidateOnly) {
            const nativeRelation: Record<string, unknown> = {};
            row.nativeRelation = nativeRelation;
            const reference = await executeAnalysisFallbackCost(
              native,
              scenario,
              "request-relation",
              null,
              nativeRelation,
            );
            expect(
              durationFingerprint(
                JSON.parse(JSON.stringify(nativeRelation.request)),
              ),
            ).toBe(frozenCase!.requestCanonicalFingerprint);
            expect(nativeRelation.requestFingerprint).toBe(
              frozenCase!.requestFingerprint,
            );
            expect(reference).toEqual(frozenCase!.value);
            expect(await runRemote("request-relation")).toEqual(reference);
            row.completeNativeDtoAndCanonicalMetaEqual = true;
            row.frozenHistoricalOldDtoEqual = true;
            if (scenario.name === "visitors/session/goal") {
              const frozenCursor = frozenCase!.cursorSample;
              if (!frozenCursor || !reference.ok)
                throw new Error("c01_analysis_candidate_frozen_cursor_missing");
              const cursor = reference.data.pagination.nextCursor;
              expect(cursor).toBe(frozenCursor.cursor);
              const nativeNext: Record<string, unknown> = {};
              row.nativeCursor = nativeNext;
              const next = await executeAnalysisFallbackCost(
                native,
                scenario,
                "request-relation",
                cursor,
                nativeNext,
              );
              expect(
                durationFingerprint(
                  JSON.parse(JSON.stringify(nativeNext.request)),
                ),
              ).toBe(frozenCursor.requestCanonicalFingerprint);
              expect(nativeNext.requestFingerprint).toBe(
                frozenCursor.requestFingerprint,
              );
              expect(next).toEqual(frozenCursor.value);
              expect(await runRemote("request-relation", cursor)).toEqual(next);
              row.frozenHistoricalCursorEqual = true;
            }
            for (const explain of pendingExplains) await explain();
            row.status = "passed";
            return;
          }
          const nativeOld: Record<string, unknown> = {};
          const nativeRelation: Record<string, unknown> = {};
          row.nativeOld = nativeOld;
          row.nativeRelation = nativeRelation;
          const reference = await executeAnalysisFallbackCost(
            native,
            scenario,
            "old-bridge",
            null,
            nativeOld,
          );
          expect(
            await executeAnalysisFallbackCost(
              native,
              scenario,
              "request-relation",
              null,
              nativeRelation,
            ),
          ).toEqual(reference);
          const providerResults: Awaited<ReturnType<typeof runRemote>>[] = [];
          const providerErrors: unknown[] = [];
          for (const route of ["old-bridge", "request-relation"] as const) {
            try {
              providerResults.push(await runRemote(route));
            } catch (error) {
              providerErrors.push(error);
            }
          }
          if (providerErrors.length)
            throw new AggregateError(
              providerErrors,
              "c01_analysis_provider_pair_failed_see_route_evidence",
            );
          const [old, relation] = providerResults;
          expect(old).toEqual(reference);
          expect(relation).toEqual(reference);
          row.completeNativeDtoAndCanonicalMetaEqual = true;
          const oldCost = row["old-bridge"] as Record<string, number>;
          const newCost = row["request-relation"] as Record<string, number>;
          row.readsNonRegression = newCost.rowsRead <= oldCost.rowsRead;
          row.statementsNonRegression =
            newCost.statements <= oldCost.statements;
          // Pair deltas are observations; a shared quadratic hotspot is not a budget.
          if (scenario.name === "visitors/session/goal") {
            if (!reference.ok)
              throw new Error("c01_analysis_native_cursor_missing");
            const cursor = reference.data.pagination.nextCursor;
            expect(cursor).toBeTypeOf("string");
            const nativeNext: Record<string, unknown> = {};
            row.nativeCursor = nativeNext;
            const next = await executeAnalysisFallbackCost(
              native,
              scenario,
              "old-bridge",
              cursor,
              nativeNext,
            );
            expect(
              await executeAnalysisFallbackCost(
                native,
                scenario,
                "request-relation",
                cursor,
              ),
            ).toEqual(next);
            expect(await runRemote("old-bridge", cursor)).toEqual(next);
            expect(await runRemote("request-relation", cursor)).toEqual(next);
            row.crossRouteCursorEqual = true;
          }
          for (const explain of pendingExplains) await explain();
          row.status = "passed";
        } catch (error) {
          Object.assign(row, { status: "failed", error: errorEvidence(error) });
          throw error;
        } finally {
          save();
        }
      },
      300000,
    );
  },
);
