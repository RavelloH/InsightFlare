import { createHash } from "node:crypto";

import type { QueryTime } from "@/lib/edge/analytics/contract";

import type { ProviderCostScenario } from "./analytics-cost-scenarios";

/** C01 fixed seed/request fixture only. These are regression budgets, not optimizer thresholds. */
const FIXTURE_BUDGETS = {
  "2000": {
    seedFingerprint:
      "09fa29a15432fa8e26e00c02f1615a0f678d2345a7c2e04f3c85148f2e076a14",
    scenarios: {
      "pages aggregate / no filter": {
        maxRowsRead: 13147,
        maxStatements: 1,
        requestFingerprint:
          "3bf4b00e58bffcb2f6f62fff548441dbee4cd94d3e53a72968b6d53a4fdc8799",
        originalRemoteRowsReadCeiling: 10872,
      },
      "pages aggregate / session count": {
        maxRowsRead: 23631,
        maxStatements: 2,
        requestFingerprint:
          "4ac2ea3cc6f7f86e9092c1e09e57a37a0682928c89f766c53154ccd7de7c99f9",
        originalRemoteRowsReadCeiling: 19609,
      },
      "pages aggregate / visitor count": {
        maxRowsRead: 22114,
        maxStatements: 2,
        requestFingerprint:
          "25a6cf671a905b5b8c7545e4d7a3f1322af1c79a680bcd382f178642bfc47d16",
        originalRemoteRowsReadCeiling: 18345,
      },
      "pages aggregate / session count + time": {
        maxRowsRead: 16372,
        maxStatements: 4,
        requestFingerprint:
          "1f5a02ee2118b5ce84c0bb823cd0888eeda1b64fcca624293df650857224b5ca",
        originalRemoteRowsReadCeiling: 13560,
      },
      "pages tabs / no filter": {
        maxRowsRead: 60556,
        maxStatements: 1,
        requestFingerprint:
          "261373d4dd6a6de3c932b4623e4c8a0aa122fa99e3ea3fed7e7d4b682a982c24",
        originalRemoteRowsReadCeiling: 50380,
      },
      "pages tabs / session count": {
        maxRowsRead: 53341,
        maxStatements: 2,
        requestFingerprint:
          "0dfda7f87419859f2e74cfc7cb815c38fdf59d9239a48b4491cc40ab05220536",
        originalRemoteRowsReadCeiling: 44367,
      },
      "pages tabs / visitor count": {
        maxRowsRead: 72211,
        maxStatements: 2,
        requestFingerprint:
          "dad1fee9dd54a3c93741d5f9a2df5939ac9293bf3b618fda83b0c1b4a00c8b9c",
        originalRemoteRowsReadCeiling: 60092,
      },
      "pages tabs / session count + time": {
        maxRowsRead: 33856,
        maxStatements: 4,
        requestFingerprint:
          "c191682af0f02ccb3d93dcb251fcb476c9dbe333aef65d188f8dcc358fde8d9d",
        originalRemoteRowsReadCeiling: 28130,
      },
      "overview summary / no filter": {
        maxRowsRead: 60603,
        maxStatements: 1,
        requestFingerprint:
          "31597b9312b8ce2a3d7e81b8ad4447ebcc47e0c4ed4957d5bcf0bdcb56f8a008",
        originalRemoteRowsReadCeiling: 5374887,
      },
      "overview summary / session count": {
        maxRowsRead: 76965,
        maxStatements: 2,
        requestFingerprint:
          "34be339fc5364642738086de7664d3db301194dcd73d4e4defef10898cc2d77a",
        originalRemoteRowsReadCeiling: 5079324,
      },
      "overview summary / visitor count": {
        maxRowsRead: 78805,
        maxStatements: 2,
        requestFingerprint:
          "4a86d1fbdaef80bc60a7e4760f69c292d57699edc8ba7fa263b6cb8e5dc52f43",
        originalRemoteRowsReadCeiling: 3247277,
      },
      "overview summary / session count + time": {
        maxRowsRead: 47958,
        maxStatements: 4,
        requestFingerprint:
          "f17be83fb1b1d3d775788ae237cc237c90928e56c4f57c53085faf65ef3cb4da",
        originalRemoteRowsReadCeiling: 795869,
      },
      "overview trend / no filter": {
        maxRowsRead: 51643,
        maxStatements: 1,
        requestFingerprint:
          "2efcda0d78779856fb531ed9e3f9b10b5dc9437d4e6051cbc991950beb879078",
        originalRemoteRowsReadCeiling: 2706736,
      },
      "overview trend / session count": {
        maxRowsRead: 71892,
        maxStatements: 2,
        requestFingerprint:
          "2243c3508d08be790c239f59f0d5d7350d63a44ed1bda9b44f882aeb9976f1df",
        originalRemoteRowsReadCeiling: 5077592,
      },
      "overview trend / visitor count": {
        maxRowsRead: 75116,
        maxStatements: 2,
        requestFingerprint:
          "bc59bfe0e186dc9ace0577afbc88e82c54b5a4ae67d06bce6c5db801cd836d3e",
        originalRemoteRowsReadCeiling: 3247146,
      },
      "overview trend / session count + time": {
        maxRowsRead: 37008,
        maxStatements: 4,
        requestFingerprint:
          "c4d7dc9e068078647ac240992f364f59ee5ac28eca4733c985432da2688ec9d1",
        originalRemoteRowsReadCeiling: 30756,
      },
      "events summary / no filter": {
        maxRowsRead: 15021,
        maxStatements: 1,
        requestFingerprint:
          "192d65958bf8ac51b68c6beb163b25b248cd1e11aaf5300ed200ca786edbc7af",
        originalRemoteRowsReadCeiling: 1572396,
      },
      "events summary / session count": {
        maxRowsRead: 25525,
        maxStatements: 2,
        requestFingerprint:
          "0d94538b0b4c3e448291d97a2e5e748b284b2aa382b63d6f869ac0c9ca2c8e0f",
        originalRemoteRowsReadCeiling: 21187,
      },
      "events summary / visitor count": {
        maxRowsRead: 26140,
        maxStatements: 2,
        requestFingerprint:
          "65cc4222c779d7504c097c4b1fe33dd079492a824424c152f017d2eb913e2dc7",
        originalRemoteRowsReadCeiling: 21700,
      },
      "events summary / session count + time": {
        maxRowsRead: 23425,
        maxStatements: 4,
        requestFingerprint:
          "2afabb7a5288fdd02738dac75bf05f792211d87db4d73669d904d080380e556c",
        originalRemoteRowsReadCeiling: 19437,
      },
      "events types / no filter": {
        maxRowsRead: 8474,
        maxStatements: 1,
        requestFingerprint:
          "88692b5805fd12cce95a76ab3812e3d636e67069d1a7c0c7355f13b969d0a31e",
        originalRemoteRowsReadCeiling: 1566940,
      },
      "events types / session count": {
        maxRowsRead: 20662,
        maxStatements: 2,
        requestFingerprint:
          "747719273a5467fc71eb0016cea149c6b4fa5d178ad05677e172e7f8729283a7",
        originalRemoteRowsReadCeiling: 17135,
      },
      "events types / visitor count": {
        maxRowsRead: 20019,
        maxStatements: 2,
        requestFingerprint:
          "7a324491c6280bac07d07bc3fd1263ec282465fe70a1f05f6969b067c0f294d7",
        originalRemoteRowsReadCeiling: 16599,
      },
      "events types / session count + time": {
        maxRowsRead: 19270,
        maxStatements: 4,
        requestFingerprint:
          "21cfd55b31bfbec0d677b64b0e4a3fcfe6468e072dcc8f7d0deff2c8e5a12275",
        originalRemoteRowsReadCeiling: 15975,
      },
      "events trend / no filter": {
        maxRowsRead: 16864,
        maxStatements: 2,
        requestFingerprint:
          "9a9797b31f1628b9f15abea9d9de1e10280a73880441e4b434acb276d2368809",
        originalRemoteRowsReadCeiling: 3133894,
      },
      "events trend / session count": {
        maxRowsRead: 32473,
        maxStatements: 2,
        requestFingerprint:
          "f76659f5747b979c5cbfb2d2bb509e8e851d3874ce8e651089faf2ffee9e1062",
        originalRemoteRowsReadCeiling: 26977,
      },
      "events trend / visitor count": {
        maxRowsRead: 34869,
        maxStatements: 2,
        requestFingerprint:
          "87b03ea0ade2cbca9b51b549fc733e210c005843b401e64cc6aeeda28a083bb7",
        originalRemoteRowsReadCeiling: 28974,
      },
      "events trend / session count + time": {
        maxRowsRead: 25960,
        maxStatements: 5,
        requestFingerprint:
          "1f7bdac69f30a097ca2d9fa47779eca2c31c2f7a71f87b720e4dca6cd8a8bf55",
        originalRemoteRowsReadCeiling: 21550,
      },
    },
  },
  "10000": {
    seedFingerprint:
      "3eca71718f7fa7873c5c3348584528221206594ecac1490d751ab9a654f7f998",
    scenarios: {
      "pages aggregate / no filter": {
        maxRowsRead: 65265,
        maxStatements: 1,
        requestFingerprint:
          "3bf4b00e58bffcb2f6f62fff548441dbee4cd94d3e53a72968b6d53a4fdc8799",
      },
      "pages aggregate / session count": {
        maxRowsRead: 117583,
        maxStatements: 2,
        requestFingerprint:
          "4ac2ea3cc6f7f86e9092c1e09e57a37a0682928c89f766c53154ccd7de7c99f9",
      },
      "pages aggregate / visitor count": {
        maxRowsRead: 109996,
        maxStatements: 2,
        requestFingerprint:
          "25a6cf671a905b5b8c7545e4d7a3f1322af1c79a680bcd382f178642bfc47d16",
      },
      "pages aggregate / session count + time": {
        maxRowsRead: 81436,
        maxStatements: 4,
        requestFingerprint:
          "1f5a02ee2118b5ce84c0bb823cd0888eeda1b64fcca624293df650857224b5ca",
      },
      "pages tabs / no filter": {
        maxRowsRead: 301998,
        maxStatements: 1,
        requestFingerprint:
          "261373d4dd6a6de3c932b4623e4c8a0aa122fa99e3ea3fed7e7d4b682a982c24",
      },
      "pages tabs / session count": {
        maxRowsRead: 266071,
        maxStatements: 2,
        requestFingerprint:
          "0dfda7f87419859f2e74cfc7cb815c38fdf59d9239a48b4491cc40ab05220536",
      },
      "pages tabs / visitor count": {
        maxRowsRead: 360747,
        maxStatements: 2,
        requestFingerprint:
          "dad1fee9dd54a3c93741d5f9a2df5939ac9293bf3b618fda83b0c1b4a00c8b9c",
      },
      "pages tabs / session count + time": {
        maxRowsRead: 168872,
        maxStatements: 4,
        requestFingerprint:
          "c191682af0f02ccb3d93dcb251fcb476c9dbe333aef65d188f8dcc358fde8d9d",
      },
      "overview summary / no filter": {
        maxRowsRead: 302565,
        maxStatements: 1,
        requestFingerprint:
          "31597b9312b8ce2a3d7e81b8ad4447ebcc47e0c4ed4957d5bcf0bdcb56f8a008",
      },
      "overview summary / session count": {
        maxRowsRead: 384366,
        maxStatements: 2,
        requestFingerprint:
          "34be339fc5364642738086de7664d3db301194dcd73d4e4defef10898cc2d77a",
      },
      "overview summary / visitor count": {
        maxRowsRead: 393746,
        maxStatements: 2,
        requestFingerprint:
          "4a86d1fbdaef80bc60a7e4760f69c292d57699edc8ba7fa263b6cb8e5dc52f43",
      },
      "overview summary / session count + time": {
        maxRowsRead: 239541,
        maxStatements: 4,
        requestFingerprint:
          "f17be83fb1b1d3d775788ae237cc237c90928e56c4f57c53085faf65ef3cb4da",
      },
      "overview trend / no filter": {
        maxRowsRead: 257646,
        maxStatements: 1,
        requestFingerprint:
          "2efcda0d78779856fb531ed9e3f9b10b5dc9437d4e6051cbc991950beb879078",
      },
      "overview trend / session count": {
        maxRowsRead: 358806,
        maxStatements: 2,
        requestFingerprint:
          "2243c3508d08be790c239f59f0d5d7350d63a44ed1bda9b44f882aeb9976f1df",
      },
      "overview trend / visitor count": {
        maxRowsRead: 375142,
        maxStatements: 2,
        requestFingerprint:
          "bc59bfe0e186dc9ace0577afbc88e82c54b5a4ae67d06bce6c5db801cd836d3e",
      },
      "overview trend / session count + time": {
        maxRowsRead: 184710,
        maxStatements: 4,
        requestFingerprint:
          "c4d7dc9e068078647ac240992f364f59ee5ac28eca4733c985432da2688ec9d1",
      },
      "events summary / no filter": {
        maxRowsRead: 74541,
        maxStatements: 1,
        requestFingerprint:
          "192d65958bf8ac51b68c6beb163b25b248cd1e11aaf5300ed200ca786edbc7af",
      },
      "events summary / session count": {
        maxRowsRead: 127026,
        maxStatements: 2,
        requestFingerprint:
          "0d94538b0b4c3e448291d97a2e5e748b284b2aa382b63d6f869ac0c9ca2c8e0f",
      },
      "events summary / visitor count": {
        maxRowsRead: 130112,
        maxStatements: 2,
        requestFingerprint:
          "65cc4222c779d7504c097c4b1fe33dd079492a824424c152f017d2eb913e2dc7",
      },
      "events summary / session count + time": {
        maxRowsRead: 116763,
        maxStatements: 4,
        requestFingerprint:
          "2afabb7a5288fdd02738dac75bf05f792211d87db4d73669d904d080380e556c",
      },
      "events types / no filter": {
        maxRowsRead: 41954,
        maxStatements: 1,
        requestFingerprint:
          "88692b5805fd12cce95a76ab3812e3d636e67069d1a7c0c7355f13b969d0a31e",
      },
      "events types / session count": {
        maxRowsRead: 102826,
        maxStatements: 2,
        requestFingerprint:
          "747719273a5467fc71eb0016cea149c6b4fa5d178ad05677e172e7f8729283a7",
      },
      "events types / visitor count": {
        maxRowsRead: 99622,
        maxStatements: 2,
        requestFingerprint:
          "7a324491c6280bac07d07bc3fd1263ec282465fe70a1f05f6969b067c0f294d7",
      },
      "events types / session count + time": {
        maxRowsRead: 96019,
        maxStatements: 4,
        requestFingerprint:
          "21cfd55b31bfbec0d677b64b0e4a3fcfe6468e072dcc8f7d0deff2c8e5a12275",
      },
      "events trend / no filter": {
        maxRowsRead: 83824,
        maxStatements: 2,
        requestFingerprint:
          "9a9797b31f1628b9f15abea9d9de1e10280a73880441e4b434acb276d2368809",
      },
      "events trend / session count": {
        maxRowsRead: 161598,
        maxStatements: 2,
        requestFingerprint:
          "f76659f5747b979c5cbfb2d2bb509e8e851d3874ce8e651089faf2ffee9e1062",
      },
      "events trend / visitor count": {
        maxRowsRead: 173653,
        maxStatements: 2,
        requestFingerprint:
          "87b03ea0ade2cbca9b51b549fc733e210c005843b401e64cc6aeeda28a083bb7",
      },
      "events trend / session count + time": {
        maxRowsRead: 129482,
        maxStatements: 5,
        requestFingerprint:
          "1f7bdac69f30a097ca2d9fa47779eca2c31c2f7a71f87b720e4dca6cd8a8bf55",
      },
    },
  },
} as const;

export interface C01FixtureMeasurement {
  readonly engine: "local-miniflare" | "remote-cloudflare-d1";
  readonly visits: number;
  readonly seedFingerprint: string;
  readonly scenario: ProviderCostScenario;
  readonly time: QueryTime;
  readonly cost: {
    readonly rowsRead: unknown;
    readonly rowsWritten: unknown;
    readonly statements: unknown;
  };
}
function stable(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value))
    throw new Error("c01_fixture_request_not_json");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("c01_fixture_request_not_plain_json");
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((child) => stable(child, ancestors));
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          stable((value as Record<string, unknown>)[key], ancestors),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}
function requestFingerprint(
  scenario: ProviderCostScenario,
  time: QueryTime,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stable({
          name: scenario.name,
          family: scenario.family,
          operation: scenario.operation,
          scope: scenario.scope,
          filterDsl: scenario.filterDsl ?? null,
          parameters: scenario.parameters,
          time,
        }),
      ),
    )
    .digest("hex");
}
export { requestFingerprint as c01FixtureRequestFingerprint };
export function assertC01AnalyticsFixtureBudget(input: C01FixtureMeasurement) {
  const scale =
    input.visits === 2000
      ? FIXTURE_BUDGETS["2000"]
      : input.visits === 10000
        ? FIXTURE_BUDGETS["10000"]
        : undefined;
  if (!scale) throw new Error("c01_fixture_scale_unsupported:" + input.visits);
  if (input.seedFingerprint !== scale.seedFingerprint)
    throw new Error("c01_fixture_seed_changed");
  const budget = (
    scale.scenarios as Readonly<
      Record<
        string,
        {
          readonly maxRowsRead: number;
          readonly maxStatements: number;
          readonly requestFingerprint: string;
          readonly originalRemoteRowsReadCeiling?: number;
        }
      >
    >
  )[input.scenario.name];
  if (!budget)
    throw new Error("c01_fixture_scenario_unsupported:" + input.scenario.name);
  if (
    requestFingerprint(input.scenario, input.time) !== budget.requestFingerprint
  )
    throw new Error("c01_fixture_request_changed:" + input.scenario.name);
  const { rowsRead, rowsWritten, statements } = input.cost;
  if (
    typeof rowsRead !== "number" ||
    !Number.isSafeInteger(rowsRead) ||
    rowsRead <= 0 ||
    typeof rowsWritten !== "number" ||
    !Number.isSafeInteger(rowsWritten) ||
    rowsWritten < 0 ||
    typeof statements !== "number" ||
    !Number.isSafeInteger(statements) ||
    statements <= 0
  )
    throw new Error("c01_fixture_metadata_unavailable:" + input.scenario.name);
  if (rowsWritten !== 0)
    throw new Error("c01_fixture_writes:" + input.scenario.name);
  if (statements > budget.maxStatements)
    throw new Error(
      "c01_fixture_statements:" +
        input.scenario.name +
        ":" +
        statements +
        ">" +
        budget.maxStatements,
    );
  if (
    input.engine !== "local-miniflare" &&
    input.engine !== "remote-cloudflare-d1"
  )
    throw new Error("c01_fixture_engine_unsupported");
  if (
    input.engine === "remote-cloudflare-d1" &&
    budget.originalRemoteRowsReadCeiling !== undefined &&
    rowsRead > budget.originalRemoteRowsReadCeiling
  )
    throw new Error(
      "c01_fixture_original_remote_ceiling:" + input.scenario.name,
    );
  if (rowsRead > budget.maxRowsRead)
    throw new Error(
      "c01_fixture_rows_read:" +
        input.scenario.name +
        ":" +
        rowsRead +
        ">" +
        budget.maxRowsRead,
    );
  return {
    ...budget,
    actualRowsRead: rowsRead,
    actualStatements: statements,
    rowsWritten: 0 as const,
  };
}
export function assertC01AnalyticsFixtureGrowth(
  smaller: C01FixtureMeasurement,
  larger: C01FixtureMeasurement,
) {
  if (
    smaller.engine !== larger.engine ||
    smaller.visits !== 2000 ||
    larger.visits !== 10000 ||
    requestFingerprint(smaller.scenario, smaller.time) !==
      requestFingerprint(larger.scenario, larger.time)
  )
    throw new Error("c01_fixture_growth_inputs_incompatible");
  const small = assertC01AnalyticsFixtureBudget(smaller);
  const large = assertC01AnalyticsFixtureBudget(larger);
  const actualGrowth = large.actualRowsRead / small.actualRowsRead;
  if (actualGrowth > 7)
    throw new Error(
      "c01_fixture_growth:" + larger.scenario.name + ":" + actualGrowth + ">7",
    );
  return {
    smallerVisits: 2000 as const,
    largerVisits: 10000 as const,
    maxGrowth: 7 as const,
    actualGrowth,
  };
}
