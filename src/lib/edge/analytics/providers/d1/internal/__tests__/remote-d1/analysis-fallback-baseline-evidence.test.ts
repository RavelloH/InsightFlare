// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FALLBACK_BASELINE_ARCHIVE_SHA256,
  createAnalysisFallbackBaselineCompanion,
  readAnalysisFallbackBaselineEvidence,
  validateAnalysisFallbackArchiveContent,
} from "./analysis-fallback-baseline-evidence";

const archiveBytes = readFileSync(
  "docs/unified-query/c01-analysis-fallback-v3-paced-failed-20261114.json",
);
const companionBytes = readFileSync(
  "docs/unified-query/c01-analysis-fallback-frozen-baseline-20261114.json",
);
const companionSha =
  "2735fe8b3f425712ab4dc3c4dc8c72f6be8f4e0888a32da948a34e389a1283c7";
const archived = JSON.parse(new TextDecoder().decode(archiveBytes)) as unknown;
const sha = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
type JsonObject = Record<string, unknown>;
function node(root: unknown, ...path: (string | number)[]): JsonObject {
  let value = root;
  for (const key of path) value = (value as JsonObject)[key];
  return value as JsonObject;
}

it("recovers all complete old results, actual SQL, bindings and the cross-route cursor", () => {
  expect(sha(archiveBytes)).toBe(ANALYSIS_FALLBACK_BASELINE_ARCHIVE_SHA256);
  expect(sha(companionBytes)).toBe(companionSha);
  const baseline = readAnalysisFallbackBaselineEvidence({
    archiveBytes,
    companionBytes,
    expectedCompanionSha256: companionSha,
  });
  expect(baseline.cases.size).toBe(8);
  expect(baseline.sourceManifestFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(baseline.sourceManifest)).toHaveLength(460);
  expect(
    [...baseline.cases.values()].filter(
      (sample) => sample.oldCleanZeroRetryProviderSample,
    ),
  ).toHaveLength(6);
  expect(
    [...baseline.cases.values()].filter((sample) => sample.cursorSample),
  ).toHaveLength(1);
  const first = baseline.cases.get("visitors/session/goal")!;
  expect(first.cursorSample!.cursor).toBe(
    node(first.value, "data", "pagination").nextCursor,
  );
  for (const sample of [...baseline.cases.values(), first.cursorSample!]) {
    expect(sample.statements).toHaveLength(6);
    expect(
      sample.statements.reduce((sum, statement) => sum + statement.rowsRead, 0),
    ).toBe(sample.historicalCompletedSqlReadReference);
    for (const statement of sample.statements) {
      expect(sha(statement.sql)).toBe(statement.sqlRef);
      expect(statement.params).toHaveLength(statement.parameterCount);
      expect(statement.rowsWritten).toBe(0);
    }
  }
});

it("preserves failed archive status and unknown old retry costs without inflating a budget", () => {
  const baseline = createAnalysisFallbackBaselineCompanion(archiveBytes);
  expect(baseline.archiveStatus).toBe("failed");
  expect(baseline.interpretation).toContain("not an accepted budget");
  const retried = baseline.cases.filter(
    (sample) => !sample.oldCleanZeroRetryProviderSample,
  );
  expect(retried.map((sample) => sample.scenario)).toEqual([
    "visitors/visitor/goal",
    "sessions/session/goal",
  ]);
  for (const sample of retried) {
    expect(sample.historicalTotalCostKnown).toBe(false);
    expect(sample.failedAttemptCost).toBe("unknown");
    expect(sample.httpAttempts.some((attempt) => attempt.status === 429)).toBe(
      true,
    );
  }
  expect(
    baseline.cases.find(
      (sample) => sample.scenario === "visitors/session/funnel",
    )!.historicalCompletedSqlReadReference,
  ).toBe(197956109);
});

it("rejects modified actual archive bytes and stale companion pins", () => {
  expect(() =>
    createAnalysisFallbackBaselineCompanion(
      Buffer.concat([archiveBytes, Buffer.from("\n")]),
    ),
  ).toThrow("evidence_invalid");
  expect(() =>
    readAnalysisFallbackBaselineEvidence({
      archiveBytes,
      companionBytes,
      expectedCompanionSha256: "0".repeat(64),
    }),
  ).toThrow("evidence_invalid");
  const forged = JSON.parse(
    new TextDecoder().decode(companionBytes),
  ) as JsonObject;
  node(forged, "cases", 0).historicalCompletedSqlReadReference = 999999999;
  const forgedBytes = JSON.stringify(forged);
  expect(() =>
    readAnalysisFallbackBaselineEvidence({
      archiveBytes,
      companionBytes: forgedBytes,
      expectedCompanionSha256: sha(forgedBytes),
    }),
  ).toThrow("evidence_invalid");
});

it("returns an independent frozen snapshot of every archived DTO and statement", () => {
  const input = structuredClone(archived);
  const result = validateAnalysisFallbackArchiveContent(input);
  node(input, "evidence", "cases", 0, "nativeOld", "result").ok = false;
  expect(node(result.cases[0]!.value).ok).toBe(true);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.cases[0]!.value)).toBe(true);
  expect(() => {
    (result.cases[0]!.statements[0]!.params as unknown[]).push("changed");
  }).toThrow(TypeError);
});

const mutations: readonly [string, (input: unknown) => void][] = [
  [
    "archive failure promoted to pass",
    (a) => {
      node(a).status = "passed";
    },
  ],
  [
    "target database changed",
    (a) => {
      node(a, "target").uuid = "other";
    },
  ],
  [
    "fixture changed",
    (a) => {
      node(a, "evidence", "fixture").visits = 10000;
    },
  ],
  [
    "database fingerprint drift",
    (a) => {
      node(a, "evidence").finalDatabaseFingerprint = "0".repeat(64);
    },
  ],
  [
    "source changed during the historical run",
    (a) => {
      node(a, "evidence", "sourceWindow", "after")[
        Object.keys(node(a, "evidence", "sourceWindow", "after"))[0]!
      ] = "0".repeat(64);
    },
  ],
  [
    "SQL catalog body changed",
    (a) => {
      node(a, "sqlCatalog", Object.keys(node(a, "sqlCatalog"))[0]!).sql =
        "SELECT 0";
    },
  ],
  [
    "scenario omitted",
    (a) => {
      (node(a, "evidence").cases as unknown[]).pop();
    },
  ],
  [
    "full historical DTO disagrees across routes",
    (a) => {
      node(a, "evidence", "cases", 0, "request-relation", "result").ok = false;
    },
  ],
  [
    "request binding context changed",
    (a) => {
      node(a, "evidence", "cases", 0, "old-bridge", "request").siteId = "other";
    },
  ],
  [
    "cross-route cursor omitted",
    (a) => {
      Reflect.deleteProperty(node(a, "evidence", "cases", 0), "nativeCursor");
    },
  ],
  [
    "successful statement omitted",
    (a) => {
      (
        node(a, "evidence", "cases", 0, "old-bridge")
          .remoteStatementDetail as unknown[]
      ).pop();
    },
  ],
  [
    "statement order changed",
    (a) => {
      node(
        a,
        "evidence",
        "cases",
        0,
        "old-bridge",
        "remoteStatementDetail",
        0,
      ).statementOrdinal = 2;
    },
  ],
  [
    "executed binding changed",
    (a) => {
      (
        node(
          a,
          "evidence",
          "cases",
          0,
          "old-bridge",
          "remoteStatementDetail",
          0,
        ).params as unknown[]
      )[0] = "other";
    },
  ],
  [
    "missing read metadata",
    (a) => {
      Reflect.deleteProperty(
        node(
          a,
          "evidence",
          "cases",
          0,
          "old-bridge",
          "remoteStatementDetail",
          0,
        ),
        "rowsRead",
      );
    },
  ],
  [
    "negative read metadata",
    (a) => {
      node(
        a,
        "evidence",
        "cases",
        0,
        "old-bridge",
        "remoteStatementDetail",
        0,
      ).rowsRead = -1;
    },
  ],
  [
    "fractional read metadata",
    (a) => {
      node(
        a,
        "evidence",
        "cases",
        0,
        "old-bridge",
        "remoteStatementDetail",
        0,
      ).rowsRead = 1.5;
    },
  ],
  [
    "write metadata",
    (a) => {
      node(
        a,
        "evidence",
        "cases",
        0,
        "old-bridge",
        "remoteStatementDetail",
        0,
      ).rowsWritten = 1;
    },
  ],
  [
    "nonfinite timing",
    (a) => {
      node(
        a,
        "evidence",
        "cases",
        0,
        "old-bridge",
        "remoteStatementDetail",
        0,
      ).sqlDurationMs = Infinity;
    },
  ],
  [
    "timing field changed",
    (a) => {
      node(
        a,
        "evidence",
        "cases",
        0,
        "old-bridge",
        "remoteStatementDetail",
        0,
      ).sqlDurationSource = "duration";
    },
  ],
  [
    "raw timing disagrees",
    (a) => {
      node(
        a,
        "evidence",
        "cases",
        0,
        "old-bridge",
        "remoteStatementDetail",
        0,
        "durationRaw",
      ).timingsSqlDurationMs = 999999;
    },
  ],
  [
    "attempt disappeared from aggregate",
    (a) => {
      (
        node(a, "evidence", "cases", 0, "old-bridge").httpAttempts as unknown[]
      ).pop();
    },
  ],
  [
    "failed final attempt presented as completed",
    (a) => {
      node(
        a,
        "evidence",
        "cases",
        0,
        "old-bridge",
        "remoteStatementDetail",
        0,
        "httpAttempts",
        0,
      ).status = 429;
    },
  ],
];
describe("rejects incomplete or mixed historical evidence", () => {
  it.each(mutations)("%s", (_name, mutate) => {
    const input = structuredClone(archived);
    mutate(input);
    expect(() => validateAnalysisFallbackArchiveContent(input)).toThrow(
      "evidence_invalid",
    );
  });
});
