import {
  INVOCATION_METRICS_DATASET,
  INVOCATION_METRICS_SCHEMA_VERSION,
} from "@/lib/edge/analytics-engine/invocation-schema";
import {
  INVOCATION_METRICS_SCHEMA_V2,
  V2_COVERAGE_SHIFT,
  V2_FLAG,
} from "@/lib/edge/analytics-engine/invocation-schema-v2";

import {
  HOTSPOT_KINDS,
  type HotspotKind,
  type InvocationQuery,
  type InvocationView,
  parseInvocationQuery,
} from "./invocation-metrics-input";

type QueryName =
  | "summary"
  | "trend"
  | "legacy"
  | Exclude<InvocationView, "overview" | "hotspots">
  | HotspotKind;
export type InvocationStatement = {
  name: QueryName;
  sql: string;
  limit: number;
};

const flag = (key: keyof typeof V2_FLAG) =>
  `intDiv(double19, ${2 ** V2_FLAG[key]}) % 2 = 1`;
const coverage = (key: keyof typeof V2_COVERAGE_SHIFT) =>
  `intDiv(double19, ${2 ** V2_COVERAGE_SHIFT[key]}) % 4`;
const weight = "_sample_interval";
const count = `COUNT(*) AS retainedSamples, SUM(${weight}) AS estimatedInvocations, max(${weight}) AS maxSampleInterval`;
const handler = `blob1 = 'worker' AND blob2 = 'request' AND ${flag("handlerPresent")}`;
const latency = `SUM(if(${handler}, ${weight}, 0)) AS handlerWeight, ${[50, 95, 99].map((percentile) => `quantileExactWeighted(0.${percentile})(if(${handler}, double2, 0), if(${handler}, ${weight}, 0)) AS p${percentile}`).join(", ")}`;

const COVERED_METRICS = {
  d1RowsRead: ["double6", "d1RowsRead", "blob1 = 'worker' AND double4 > 0"],
  d1SqlEngineMs: ["double8", "d1SqlEngine", "blob1 = 'worker' AND double4 > 0"],
  d1ApiWallMs: ["double9", "d1ApiWall", "blob1 = 'worker' AND double4 > 0"],
  doFetchWallMs: ["double12", "doFetchWall", "double11 > 0"],
  doSqlRowsRead: ["double13", "doSqlRowsRead", "blob1 = 'do'"],
} as const;

const coveredColumns = Object.entries(COVERED_METRICS).flatMap(
  ([name, [slot, key, applicable]]) => {
    const code = coverage(key);
    const sum = (condition: string, value: string, suffix: string) =>
      `SUM(if(${condition}, ${value}, 0)) AS ${name}${suffix}`;
    return [
      sum(applicable, weight, "Applicable"),
      sum(`${applicable} AND ${code} = 2`, weight, "Complete"),
      sum(`${applicable} AND ${code} = 1`, weight, "Partial"),
      sum(
        `${applicable} AND ${code} IN (1, 2)`,
        `${weight} * ${slot}`,
        "Observed",
      ),
    ];
  },
);

const aggregate = `${count}, ${latency}, SUM(double1 * ${weight}) AS invocationWallMs, SUM(if(blob1 = 'worker', double4 * ${weight}, 0)) AS workerD1Statements, SUM(double11 * ${weight}) AS doFetchCalls, ${coveredColumns.join(", ")}`;

const HOTSPOTS = {
  "api-hot": [
    14,
    14,
    `${flag("hotQueryPresent")} AND ${flag("hotQueryApiWallPresent")}`,
  ],
  "sql-engine-fallback": [
    14,
    15,
    `${flag("hotQueryPresent")} AND NOT (${flag("hotQueryApiWallPresent")}) AND ${coverage("hotQueryEngine")} = 2`,
  ],
  scan: [
    17,
    17,
    `${flag("scanQueryPresent")} AND ${coverage("scanQueryRowsRead")} = 2`,
  ],
} as const;

export function buildInvocationStatements(
  params: URLSearchParams,
  now: number,
): { query: InvocationQuery; statements: InvocationStatement[] } | null {
  const query = parseInvocationQuery(params, now);
  if (!query) return null;
  const {
    window,
    source,
    trigger,
    resultClass,
    routeKey,
    appVersion,
    limit,
    view,
    kind,
    interval,
    timeZone,
  } = query;
  const time = `timestamp >= toDateTime(${window.effectiveFrom / 1000}) AND timestamp < toDateTime(${window.effectiveTo / 1000})`;
  const predicates = [
    time,
    `double20 = ${INVOCATION_METRICS_SCHEMA_V2}`,
    "blob1 IN ('worker', 'do')",
    "blob2 IN ('request', 'alarm', 'scheduled', 'websocket')",
  ];
  for (const [slot, value] of [
    ["blob1", source === "all" ? null : source],
    ["blob2", trigger],
    ["blob6", resultClass],
    ["blob4", routeKey],
    ["blob10", appVersion],
  ] as const) {
    if (value) predicates.push(`${slot} = '${value}'`);
  }
  const where = predicates.join(" AND ");
  const statement = (
    name: QueryName,
    columns: string,
    cap: number,
    tail = "",
    filter = where,
  ): InvocationStatement => ({
    name,
    limit: cap,
    sql: `SELECT ${columns} FROM ${INVOCATION_METRICS_DATASET} WHERE ${filter}${tail ? ` ${tail}` : ""} LIMIT ${cap} FORMAT JSONEachRow`,
  });
  const dimensions =
    "blob1 AS source, blob2 AS trigger, blob4 AS routeKey, blob10 AS appVersion";
  const sort = "ORDER BY estimatedInvocations DESC";
  let statements: InvocationStatement[];
  switch (view) {
    case "overview":
      statements = [
        statement("summary", aggregate, 1),
        statement(
          "trend",
          `toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '1' ${interval.toUpperCase()}, '${timeZone}')) AS bucket, ${aggregate}`,
          limit,
          "GROUP BY bucket ORDER BY bucket DESC",
        ),
        statement(
          "legacy",
          "COUNT(*) AS retainedSamples",
          1,
          "",
          `${time} AND double20 = ${INVOCATION_METRICS_SCHEMA_VERSION}`,
        ),
      ];
      break;
    case "routes":
      statements = [
        statement(
          "routes",
          `${dimensions}, ${aggregate}`,
          limit,
          `GROUP BY blob1, blob2, blob4, blob10 ${sort}, blob1, blob2, blob4, blob10`,
        ),
      ];
      break;
    case "errors":
      statements = [
        statement(
          "errors",
          `${dimensions}, blob6 AS resultClass, blob11 AS category, blob12 AS code, blob13 AS operation, ${count}`,
          limit,
          `AND (blob12 != '' OR blob6 = 'failure') GROUP BY blob1, blob2, blob4, blob10, blob6, blob11, blob12, blob13 ${sort}, blob1, blob2, blob4, blob10, blob6, blob11, blob12, blob13`,
        ),
      ];
      break;
    case "samples":
      statements = [
        statement(
          "samples",
          `toUnixTimestamp(timestamp) AS timestampSeconds, ${dimensions}, blob6 AS resultClass, blob11 AS category, blob12 AS code, blob13 AS operation, blob14 AS hotQueryId, blob15 AS variant, blob16 AS filterShape, blob17 AS scanQueryId, blob18 AS dominantPhase, substring(blob19, 1, 4097) AS details, blob20 AS filterFamily, ${weight} AS sampleInterval, double1 AS invocationWallMs, double2 AS handlerWallMs, double18 AS httpStatus, double19 AS flags`,
          limit,
          "ORDER BY timestamp DESC",
        ),
      ];
      break;
    case "hotspots":
      statements = [
        statement("summary", count, 1),
        ...(kind ? [kind] : HOTSPOT_KINDS).map((selected) => {
          const [blob, slot, eligible] = HOTSPOTS[selected];
          const shapeColumns =
            selected === "scan"
              ? ""
              : ", blob15 AS variant, blob16 AS filterShape, blob20 AS filterFamily";
          const shapeGroup =
            selected === "scan" ? "" : ", blob15, blob16, blob20";
          return statement(
            selected,
            `${dimensions}, blob${blob} AS queryId${shapeColumns}, ${count}, SUM(double${slot} * ${weight}) AS weightedValue`,
            limit,
            `AND ${eligible} AND blob${blob} != '' GROUP BY blob1, blob2, blob4, blob10, blob${blob}${shapeGroup} ORDER BY weightedValue DESC, blob1, blob2, blob4, blob10, blob${blob}${shapeGroup}`,
          );
        }),
      ];
      break;
  }
  return { query, statements };
}
