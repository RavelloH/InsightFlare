import {
  type C01FixtureMeasurement,
  c01FixtureRequestFingerprint,
} from "./analytics-fixture-cost-budgets";

/** New independent C01 fixture, local after evidence only; no remote baseline exists. */
const BUDGETS = {
  "2000": {
    seedFingerprint:
      "aab0e7b3d1fef7d252d461c9188b322d4d01972ab7c81e5b5bf1284d43ff0059",
    scenarios: {
      "retention / no filter": {
        maxRowsRead: 34134,
        maxStatements: 1,
        requestFingerprint:
          "1a192cc76075818e7d56a683e7562478a114caabafbac9981a48513ef4963c25",
      },
      "retention / count": {
        maxRowsRead: 49711,
        maxStatements: 2,
        requestFingerprint:
          "f2d334a42bbb96760ac2ae2de468ae4de93f48f9c678d8721bfe40872fa20da2",
      },
      "retention / count + time": {
        maxRowsRead: 22500,
        maxStatements: 4,
        requestFingerprint:
          "60c92cb4f5ca7bde5c58c6ff95b456a6b5517b9829e22f91e0a36d1227af1c90",
      },
      "funnel-analysis / no filter": {
        maxRowsRead: 47076,
        maxStatements: 2,
        requestFingerprint:
          "aadb08fee7cdf38b0610d530a421d042e63852a86a33b2d06f25befe4209874f",
      },
      "funnel-analysis / count": {
        maxRowsRead: 84590,
        maxStatements: 4,
        requestFingerprint:
          "e805e603fbda4557fd62e4f621368e40ddca3752b778c096eab6e25106fbaf62",
      },
      "funnel-analysis / count + time": {
        maxRowsRead: 79520,
        maxStatements: 5,
        requestFingerprint:
          "0082c29afc39fddeac0835b3ec8141caca95bc89246403437e545aa884691f76",
      },
      "event-fields / no filter": {
        maxRowsRead: 11607,
        maxStatements: 1,
        requestFingerprint:
          "972b3ffc9e901488bf768d30e8ee266648c4439dd25916cc8cb7a007fa79d971",
      },
      "event-fields / count": {
        maxRowsRead: 19113,
        maxStatements: 2,
        requestFingerprint:
          "41aebfbde73bff96953da63781739d3ef7f1fabb4147d41c05e535cc50f657eb",
      },
      "event-fields / count + time": {
        maxRowsRead: 22401,
        maxStatements: 4,
        requestFingerprint:
          "092ede93b1d69093cf1c277989789141fe35a5976af97888a711cb98b064bb08",
      },
    },
  },
  "10000": {
    seedFingerprint:
      "dbeef9a93ff9788b88f6deda983e208fb16b2571bd0d3b43fb1ad6a35b334c41",
    scenarios: {
      "retention / no filter": {
        maxRowsRead: 169969,
        maxStatements: 1,
        requestFingerprint:
          "1a192cc76075818e7d56a683e7562478a114caabafbac9981a48513ef4963c25",
      },
      "retention / count": {
        maxRowsRead: 247536,
        maxStatements: 2,
        requestFingerprint:
          "f2d334a42bbb96760ac2ae2de468ae4de93f48f9c678d8721bfe40872fa20da2",
      },
      "retention / count + time": {
        maxRowsRead: 111912,
        maxStatements: 4,
        requestFingerprint:
          "60c92cb4f5ca7bde5c58c6ff95b456a6b5517b9829e22f91e0a36d1227af1c90",
      },
      "funnel-analysis / no filter": {
        maxRowsRead: 234434,
        maxStatements: 2,
        requestFingerprint:
          "aadb08fee7cdf38b0610d530a421d042e63852a86a33b2d06f25befe4209874f",
      },
      "funnel-analysis / count": {
        maxRowsRead: 421178,
        maxStatements: 4,
        requestFingerprint:
          "e805e603fbda4557fd62e4f621368e40ddca3752b778c096eab6e25106fbaf62",
      },
      "funnel-analysis / count + time": {
        maxRowsRead: 396124,
        maxStatements: 5,
        requestFingerprint:
          "0082c29afc39fddeac0835b3ec8141caca95bc89246403437e545aa884691f76",
      },
      "event-fields / no filter": {
        maxRowsRead: 57447,
        maxStatements: 1,
        requestFingerprint:
          "972b3ffc9e901488bf768d30e8ee266648c4439dd25916cc8cb7a007fa79d971",
      },
      "event-fields / count": {
        maxRowsRead: 94832,
        maxStatements: 2,
        requestFingerprint:
          "41aebfbde73bff96953da63781739d3ef7f1fabb4147d41c05e535cc50f657eb",
      },
      "event-fields / count + time": {
        maxRowsRead: 111385,
        maxStatements: 4,
        requestFingerprint:
          "092ede93b1d69093cf1c277989789141fe35a5976af97888a711cb98b064bb08",
      },
    },
  },
} as const;

/** Fixed local fixture budgets: measured after reads +20%+100, actual statement
 * cap, zero writes. No latency threshold and no optimizer policy is encoded. */
export function assertJourneyEventFieldsCostBudget(
  input: C01FixtureMeasurement,
) {
  if (
    input.engine !== "local-miniflare" &&
    input.engine !== "remote-cloudflare-d1"
  )
    throw new Error("c01_next_fixture_engine_unsupported");
  const scale =
    input.visits === 2000
      ? BUDGETS["2000"]
      : input.visits === 10000
        ? BUDGETS["10000"]
        : undefined;
  if (!scale) throw new Error("c01_next_fixture_scale_unsupported");
  if (input.seedFingerprint !== scale.seedFingerprint)
    throw new Error("c01_next_fixture_seed_changed");
  const budget = (
    scale.scenarios as Readonly<
      Record<
        string,
        {
          readonly maxRowsRead: number;
          readonly maxStatements: number;
          readonly requestFingerprint: string;
        }
      >
    >
  )[input.scenario.name];
  if (
    !budget ||
    c01FixtureRequestFingerprint(input.scenario, input.time) !==
      budget.requestFingerprint
  )
    throw new Error("c01_next_fixture_request_changed");
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
    throw new Error("c01_next_fixture_metadata_unavailable");
  if (rowsWritten !== 0) throw new Error("c01_next_fixture_writes");
  if (statements > budget.maxStatements)
    throw new Error(
      `c01_next_fixture_statements:${input.scenario.name}:${statements}>${budget.maxStatements}`,
    );
  if (rowsRead > budget.maxRowsRead)
    throw new Error(
      `c01_next_fixture_reads:${input.scenario.name}:${rowsRead}>${budget.maxRowsRead}`,
    );
  return {
    ...budget,
    baselineEngine: "local-miniflare" as const,
    remoteBeforeAvailable: false,
    actualRowsRead: rowsRead,
    actualStatements: statements,
    rowsWritten: 0 as const,
  };
}

export function assertJourneyEventFieldsCostGrowth(
  smaller: C01FixtureMeasurement,
  larger: C01FixtureMeasurement,
) {
  if (
    smaller.engine !== larger.engine ||
    smaller.visits !== 2000 ||
    larger.visits !== 10000 ||
    c01FixtureRequestFingerprint(smaller.scenario, smaller.time) !==
      c01FixtureRequestFingerprint(larger.scenario, larger.time)
  )
    throw new Error("c01_next_fixture_growth_inputs_incompatible");
  const small = assertJourneyEventFieldsCostBudget(smaller);
  const large = assertJourneyEventFieldsCostBudget(larger);
  const actualGrowth = large.actualRowsRead / small.actualRowsRead;
  if (actualGrowth > 7)
    throw new Error(
      `c01_next_fixture_growth:${larger.scenario.name}:${actualGrowth}>7`,
    );
  return {
    smallerVisits: 2000,
    largerVisits: 10000,
    actualGrowth,
    maxGrowth: 7,
  };
}
