import {
  INVOCATION_METRICS_BLOBS as V1_BLOBS,
  INVOCATION_METRICS_DOUBLES as V1_DOUBLES,
} from "./invocation-schema";

/**
 * Physical v2 layout. The v1 decoder remains immutable: old points are
 * distinguished solely by double20, not by timestamps or guessed columns.
 */
export const INVOCATION_METRICS_SCHEMA_V2 = 2 as const;
export const INVOCATION_V2_BLOBS = [
  "source",
  "trigger",
  "routeGroup",
  "routeKey",
  "method",
  "resultClass",
  "outcome",
  "cache",
  "dataSource",
  "appVersion",
  "primaryErrorCategory",
  "primaryErrorCode",
  "primaryErrorOperation",
  "hotQueryId",
  "hotQueryVariant",
  "hotFilterShape",
  "scanQueryId",
  "dominantPhase",
  "safeDetailsJson",
  "filterFamily",
] as const;
export const INVOCATION_V2_DOUBLES = [
  "invocationWallMs",
  "handlerWallMs",
  "backgroundDrainMs",
  "d1Statements",
  "d1FailedStatements",
  "d1RowsRead",
  "d1RowsWritten",
  "d1SqlEngineMs",
  "d1ApiWallSumMs",
  "d1Retries",
  "doFetchCalls",
  "doFetchWallSumMs",
  "doSqlRowsRead",
  "hotQueryApiWallMs",
  "hotQuerySqlEngineMs",
  "hotQueryRowsRead",
  "scanQueryRowsRead",
  "httpStatus",
  "validityCoverageFlags",
  "schemaVersion",
] as const;

export type InvocationV2Blob = (typeof INVOCATION_V2_BLOBS)[number];
export type InvocationV2Double = (typeof INVOCATION_V2_DOUBLES)[number];
export type V2Coverage = "unavailable" | "partial" | "complete";

export const V2_FLAG = {
  handlerPresent: 0,
  httpStatusPresent: 1,
  backgroundDrainPresent: 2,
  doFetchWallPresent: 3,
  hotQueryPresent: 4,
  scanQueryPresent: 5,
  filterPresent: 6,
  detailsTruncated: 7,
  queryAttributionComplete: 8,
} as const;

export const V2_COVERAGE_SHIFT = {
  d1RowsRead: 10,
  d1RowsWritten: 12,
  d1SqlEngine: 14,
  d1Attempts: 16,
  d1ApiWall: 18,
  doSqlRowsRead: 20,
  hotQueryEngine: 22,
  hotQueryRowsRead: 24,
  scanQueryRowsRead: 26,
  doFetchWall: 28,
} as const;

export function v2BooleanFlag(
  flags: number,
  name: keyof typeof V2_FLAG,
): boolean {
  return (
    Number.isSafeInteger(flags) &&
    flags >= 0 &&
    (flags & (1 << V2_FLAG[name])) !== 0
  );
}
export function setV2BooleanFlag(
  flags: number,
  name: keyof typeof V2_FLAG,
  value: boolean,
): number {
  return value ? flags | (1 << V2_FLAG[name]) : flags & ~(1 << V2_FLAG[name]);
}
export function v2CoverageFlag(
  flags: number,
  name: keyof typeof V2_COVERAGE_SHIFT,
): V2Coverage {
  const code = (flags >>> V2_COVERAGE_SHIFT[name]) & 3;
  return code === 2 ? "complete" : code === 1 ? "partial" : "unavailable";
}
export function setV2CoverageFlag(
  flags: number,
  name: keyof typeof V2_COVERAGE_SHIFT,
  coverage: V2Coverage,
): number {
  const shift = V2_COVERAGE_SHIFT[name];
  const code = coverage === "complete" ? 2 : coverage === "partial" ? 1 : 0;
  return (flags & ~(3 << shift)) | (code << shift);
}

type NamedPoint<K extends readonly string[], V extends readonly string[]> = {
  schemaVersion: 1 | 2;
  blobs: Partial<Record<K[number], string>>;
  doubles: Partial<Record<V[number], number>>;
};

/** Never guess the meaning of rows with missing/unrecognized schemaVersion. */
export function decodeInvocationPhysicalPoint(point: {
  blobs: readonly string[];
  doubles: readonly number[];
}):
  | NamedPoint<typeof V1_BLOBS, typeof V1_DOUBLES>
  | NamedPoint<typeof INVOCATION_V2_BLOBS, typeof INVOCATION_V2_DOUBLES>
  | null {
  if (point.blobs.length !== 20 || point.doubles.length !== 20) return null;
  const version = point.doubles[19];
  if (version !== 1 && version !== 2) return null;
  const names = version === 1 ? V1_BLOBS : INVOCATION_V2_BLOBS;
  const numbers = version === 1 ? V1_DOUBLES : INVOCATION_V2_DOUBLES;
  const blobs: Record<string, string> = {};
  const doubles: Record<string, number> = {};
  names.forEach((name, i) => {
    blobs[name] = point.blobs[i] ?? "";
  });
  numbers.forEach((name, i) => {
    doubles[name] = point.doubles[i] ?? 0;
  });
  return { schemaVersion: version, blobs, doubles };
}
