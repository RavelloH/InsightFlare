import { createHash } from "node:crypto";

import { durationFingerprint } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/duration-contract";

export const ANALYSIS_FALLBACK_BASELINE_ARCHIVE_SHA256 =
  "cea70eb3a92dd4588d64adff8bf2cc5147ffadf388d12b86403694cd56cfec61";
export const ANALYSIS_FALLBACK_BASELINE_DATABASE_FINGERPRINT =
  "17b4ba34f401c1238115fe302a0ec293f1c386c1e392a118c97a92393ca0c1e7";
const seedFingerprint =
  "444ff2ed062dbcbb6e6f42ba171287e77e9f7e6fd709432b85e27dc4fa59cd59";
const baseFixtureFingerprint =
  "aab0e7b3d1fef7d252d461c9188b322d4d01972ab7c81e5b5bf1284d43ff0059";
const target = Object.freeze({
  accountId: "442fe5198bff93bdf60d4223d9618033",
  databaseId: "40c82ca3-8755-4d0d-b644-9d39b56df9f9",
  databaseName: "if-c01-bench-20261113",
});
const scenarios = ["visitors", "sessions"].flatMap((operation) =>
  ["session", "visitor"].flatMap((scope) =>
    ["goal", "funnel"].map((analysis) => `${operation}/${scope}/${analysis}`),
  ),
);
type JsonObject = Record<string, unknown>;
export interface AnalysisFallbackBaselineStatement {
  readonly sql: string;
  readonly sqlRef: string;
  readonly statementOrdinal: number;
  readonly parameterCount: number;
  readonly params: readonly unknown[];
  readonly inputParams: readonly unknown[];
  readonly rowsRead: number;
  readonly rowsWritten: 0;
  readonly sqlDurationMs: number;
  readonly sqlDurationSource: "timings.sql_duration_ms";
  readonly durationRaw: Readonly<JsonObject>;
  readonly httpAttempts: readonly Readonly<JsonObject>[];
  readonly resultRows: number;
  readonly raw: Readonly<JsonObject>;
}
export interface FrozenAnalysisFallbackSample {
  readonly scenario: string;
  readonly cursor: string | null;
  readonly request: unknown;
  readonly requestFingerprint: string;
  readonly requestCanonicalFingerprint: string;
  readonly value: unknown;
  readonly historicalCompletedSqlReadReference: number;
  readonly historicalCompletedStatements: 6;
  readonly historicalTotalCostKnown: boolean;
  readonly oldCleanZeroRetryProviderSample: boolean;
  readonly failedAttemptCost: "unknown" | "none-observed";
  readonly statements: readonly AnalysisFallbackBaselineStatement[];
  readonly httpAttempts: readonly Readonly<JsonObject>[];
}
export interface FrozenAnalysisFallbackCase extends FrozenAnalysisFallbackSample {
  readonly cursorSample?: FrozenAnalysisFallbackSample;
}
export interface AnalysisFallbackBaselineContent {
  readonly target: typeof target;
  readonly fixture: {
    readonly visits: 2000;
    readonly seedFingerprint: string;
    readonly baseFixtureFingerprint: string;
    readonly databaseFingerprint: string;
  };
  readonly sourceManifest: Readonly<Record<string, string>>;
  readonly sourceManifestFingerprint: string;
  readonly cases: readonly FrozenAnalysisFallbackCase[];
}

function fail(): never {
  throw new Error("c01_analysis_baseline_evidence_invalid");
}
function check(value: unknown): asserts value {
  if (!value) fail();
}
function object(value: unknown): JsonObject {
  check(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}
function list(value: unknown): unknown[] {
  check(Array.isArray(value));
  return value;
}
function safeCount(value: unknown): number {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value;
}
function finite(value: unknown): number {
  check(typeof value === "number" && Number.isFinite(value) && value >= 0);
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  return durationFingerprint(a) === durationFingerprint(b);
}
function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function copy<T>(value: T): T {
  return frozen(JSON.parse(JSON.stringify(value)) as T);
}

/** Structural validation for offline artifact derivation and mutation tests.
 * Only the byte-pinned reader below establishes archive provenance. */
export function validateAnalysisFallbackArchiveContent(
  input: unknown,
): AnalysisFallbackBaselineContent {
  const archive = object(input),
    evidence = object(archive.evidence);
  check(archive.status === "failed" && evidence.status === "failed");
  const archivedTarget = object(archive.target);
  check(
    archivedTarget.accountId === target.accountId &&
      archivedTarget.uuid === target.databaseId &&
      archivedTarget.name === target.databaseName,
  );
  const fixture = object(evidence.fixture);
  check(
    fixture.visits === 2000 &&
      fixture.seedFingerprint === seedFingerprint &&
      fixture.baseFixtureFingerprint === baseFixtureFingerprint,
  );
  check(
    fixture.expectedDatabaseFingerprint ===
      ANALYSIS_FALLBACK_BASELINE_DATABASE_FINGERPRINT &&
      fixture.verifiedDatabaseFingerprint ===
        fixture.expectedDatabaseFingerprint &&
      evidence.finalDatabaseFingerprint ===
        fixture.expectedDatabaseFingerprint &&
      archive.schemaSeedFingerprintVerified === true,
  );
  const window = object(evidence.sourceWindow),
    sources = object(window.before);
  check(Object.keys(sources).length === 460 && equal(sources, window.after));
  for (const [path, hash] of Object.entries(sources))
    check(
      path.startsWith("src/") &&
        typeof hash === "string" &&
        /^[a-f0-9]{64}$/.test(hash),
    );
  const catalog = object(archive.sqlCatalog);
  check(Object.keys(catalog).length === 231);
  for (const [hash, raw] of Object.entries(catalog)) {
    const entry = object(raw);
    check(
      typeof entry.sql === "string" &&
        sha(entry.sql) === hash &&
        Buffer.byteLength(entry.sql) === entry.bytes,
    );
  }
  check(typeof archive.schemaSql === "string");
  const seed = list(fixture.seedStatementReferences).map((ref) => {
    check(typeof ref === "string" && Object.hasOwn(catalog, ref));
    return object(catalog[ref]).sql;
  });
  check(sha(JSON.stringify([archive.schemaSql, seed])) === seedFingerprint);

  const validateAttempt = (raw: unknown) => {
    const attempt = object(raw);
    check(
      safeCount(attempt.attempt) > 0 &&
        typeof attempt.retry === "boolean" &&
        typeof attempt.outcome === "string",
    );
    safeCount(attempt.status);
    finite(attempt.elapsedMs);
    finite(attempt.backoffMs);
    return attempt;
  };
  const readRemote = (raw: unknown) => {
    const route = object(raw);
    const details = list(route.remoteStatementDetail);
    check(details.length === 6 && route.statements === 6);
    const statements = details.map(
      (raw, index): AnalysisFallbackBaselineStatement => {
        const detail = object(raw),
          reference = detail.sqlRef;
        check(
          typeof reference === "string" && Object.hasOwn(catalog, reference),
        );
        const sql = object(catalog[reference]).sql;
        check(typeof sql === "string" && Buffer.byteLength(sql) <= 100000);
        check(
          detail.statementOrdinal === index + 1 &&
            detail.parameterCount === list(detail.params).length &&
            detail.parameterCount === list(detail.inputParams).length &&
            safeCount(detail.parameterCount) <= 100,
        );
        check(
          equal(
            detail.params,
            list(detail.inputParams).map((p) =>
              typeof p === "boolean" ? Number(p) : p,
            ),
          ),
        );
        safeCount(detail.rowsRead);
        check(detail.rowsWritten === 0);
        safeCount(detail.resultRows);
        finite(detail.sqlDurationMs);
        const durationRaw = object(detail.durationRaw);
        check(
          detail.sqlDurationSource === "timings.sql_duration_ms" &&
            durationRaw.timingsSqlDurationMs === detail.sqlDurationMs,
        );
        const attempts = list(detail.httpAttempts).map(validateAttempt);
        check(
          attempts.length > 0 && attempts.every((a, i) => a.attempt === i + 1),
        );
        const last = attempts.at(-1)!;
        check(
          last.status === 200 &&
            last.retry === false &&
            last.outcome === "response",
        );
        return {
          ...detail,
          sql,
          raw: detail,
        } as unknown as AnalysisFallbackBaselineStatement;
      },
    );
    const httpAttempts = list(route.httpAttempts).map(validateAttempt);
    check(
      equal(
        httpAttempts,
        statements.flatMap((s) => s.httpAttempts),
      ),
    );
    const reads = statements.reduce((sum, s) => sum + s.rowsRead, 0);
    check(
      Number.isSafeInteger(reads) &&
        reads === route.rowsRead &&
        route.rowsWritten === 0,
    );
    const attempts = list(route.statementAttempts);
    check(
      attempts.length === 6 &&
        attempts.every((raw, index) => {
          const attempt = object(raw),
            statement = statements[index]!;
          return (
            attempt.status === "completed" &&
            attempt.sqlRef === statement.sqlRef &&
            equal(attempt.params, statement.inputParams)
          );
        }),
    );
    const clean =
      httpAttempts.length === 6 &&
      httpAttempts.every(
        (a) =>
          a.attempt === 1 &&
          a.status === 200 &&
          a.retry === false &&
          a.backoffMs === 0 &&
          a.outcome === "response",
      );
    return { statements, httpAttempts, reads, clean };
  };
  const sample = (
    row: JsonObject,
    scenario: string,
    isCursor: boolean,
  ): FrozenAnalysisFallbackSample => {
    const native = object(row[isCursor ? "nativeCursor" : "nativeOld"]);
    const old = object(row[isCursor ? "old-bridge-cursor" : "old-bridge"]);
    const relation = object(
      row[isCursor ? "request-relation-cursor" : "request-relation"],
    );
    const records = isCursor
      ? [native, old, relation]
      : [native, object(row.nativeRelation), old, relation];
    const cursor = native.cursor;
    check(
      isCursor
        ? typeof cursor === "string" && cursor.length > 0
        : cursor === null,
    );
    check(native.status === "passed" && object(native.result).ok === true);
    for (const record of records) {
      check(
        record.scenario === scenario &&
          record.cursor === cursor &&
          equal(record.request, native.request) &&
          equal(record.result, native.result),
      );
      check(record.requestFingerprint === sha(JSON.stringify(record.request)));
      check(
        record.route === "old-bridge" || record.route === "request-relation",
      );
      check(
        record.bridgeCalls === (record.route === "old-bridge" ? 1 : 0) &&
          safeCount(record.coreCalls) > 0,
      );
    }
    const oldCost = readRemote(old),
      newCost = readRemote(relation);
    check(
      equal(
        oldCost.statements.map((s) => [s.sqlRef, s.params, s.inputParams]),
        newCost.statements.map((s) => [s.sqlRef, s.params, s.inputParams]),
      ),
    );
    return {
      scenario,
      cursor: cursor as string | null,
      request: native.request,
      requestFingerprint: native.requestFingerprint as string,
      requestCanonicalFingerprint: durationFingerprint(native.request),
      value: native.result,
      historicalCompletedSqlReadReference: oldCost.reads,
      historicalCompletedStatements: 6,
      historicalTotalCostKnown: oldCost.clean,
      oldCleanZeroRetryProviderSample: oldCost.clean,
      failedAttemptCost: oldCost.clean ? "none-observed" : "unknown",
      statements: oldCost.statements,
      httpAttempts: oldCost.httpAttempts,
    };
  };
  const rows = list(evidence.cases);
  check(rows.length === scenarios.length);
  const cases = rows.map((raw, index): FrozenAnalysisFallbackCase => {
    const row = object(raw),
      scenario = scenarios[index]!;
    check(row.scenario === scenario && row.visits === 2000);
    const primary = sample(row, scenario, false);
    const hasCursor = Object.hasOwn(row, "nativeCursor");
    check(hasCursor === (index === 0));
    if (!hasCursor) return primary;
    const cursorSample = sample(row, scenario, true);
    const pagination = object(object(object(primary.value).data).pagination);
    check(cursorSample.cursor === pagination.nextCursor);
    return { ...primary, cursorSample };
  });
  return copy({
    target,
    fixture: {
      visits: 2000 as const,
      seedFingerprint,
      baseFixtureFingerprint,
      databaseFingerprint: ANALYSIS_FALLBACK_BASELINE_DATABASE_FINGERPRINT,
    },
    sourceManifest: sources as Record<string, string>,
    sourceManifestFingerprint: durationFingerprint(sources),
    cases,
  });
}

function parsed(bytes: string | Uint8Array): unknown {
  return JSON.parse(
    typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"),
  ) as unknown;
}

export function createAnalysisFallbackBaselineCompanion(
  archiveBytes: string | Uint8Array,
) {
  check(sha(archiveBytes) === ANALYSIS_FALLBACK_BASELINE_ARCHIVE_SHA256);
  const content = validateAnalysisFallbackArchiveContent(parsed(archiveBytes));
  return frozen({
    artifactVersion: 1,
    archiveSha256: ANALYSIS_FALLBACK_BASELINE_ARCHIVE_SHA256,
    archiveStatus: "failed",
    interpretation:
      "historical completed-SQL reference; not an accepted budget or failed-route total-cost upper bound; no clean matrix timing baseline",
    ...content,
  });
}

/** Verifies both actual byte streams and re-derives the entire immutable
 * companion. Historical failures/unknown costs never become zero or pass. */
export function readAnalysisFallbackBaselineEvidence(input: {
  readonly archiveBytes: string | Uint8Array;
  readonly companionBytes: string | Uint8Array;
  readonly expectedCompanionSha256: string;
}) {
  check(
    /^[a-f0-9]{64}$/.test(input.expectedCompanionSha256) &&
      sha(input.companionBytes) === input.expectedCompanionSha256,
  );
  const content = createAnalysisFallbackBaselineCompanion(input.archiveBytes);
  check(equal(parsed(input.companionBytes), content));
  return {
    ...content,
    cases: new Map(content.cases.map((sample) => [sample.scenario, sample])),
  };
}
