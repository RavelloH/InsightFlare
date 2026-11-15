// @vitest-environment node
import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  checkDifferentialFilterCase,
  generateDifferentialFilterCases,
} from "@/lib/edge/analytics/engine/__tests__/differential/filter-cases";
import * as countSupport from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import type { Env } from "@/lib/edge/types";

import {
  ANALYTICS_COST_SCENARIOS,
  executeAnalyticsCostScenario,
} from "./remote-d1/analytics-cost-scenarios";
import { buildDataStatements, buildSiteStatements } from "./remote-d1/seed";

// Keep one canonical request for every report, then vary the entire filter
// tree. The oracle runs the actual provider with SQL qualification disabled.
const REPORTS = ANALYTICS_COST_SCENARIOS.filter(
  (scenario) => scenario.filterDsl === undefined,
);
// This seed produces identical tree inputs at original indices 0 and 3.
// Preserve the first original index for shrink/reproduction diagnostics; run
// every distinct tree for every unchanged report/scope/window/fixture tuple.
const SAMPLES = generateDifferentialFilterCases(0x20261116, 6).filter(
  (sample, index, samples) =>
    samples.findIndex(
      (candidate) =>
        JSON.stringify(candidate.tree) === JSON.stringify(sample.tree),
    ) === index,
);

describe.each([19, 96])(
  "generated analytics-family parity, %i visits",
  (visits) => {
    let database: DatabaseSync;
    let env: Env;
    beforeAll(() => {
      database = createMigratedDatabase();
      for (const sql of [
        ...buildSiteStatements(),
        ...buildDataStatements({ visits }),
      ])
        database.exec(sql);
      env = {
        DB: createSqliteD1Database(database),
        MAIN_SECRET: "analytics-family-differential-test",
      } as unknown as Env;
    });
    afterAll(() => database?.close());

    for (const report of REPORTS)
      for (const scope of ["session", "visitor"] as const)
        for (const independentWindow of [false, true])
          it.each(SAMPLES)(
            `${report.name}/${scope}/independentWindow=${independentWindow}: seed $seed case $index`,
            async (sample) => {
              async function execute(dsl: string, forceCore: boolean) {
                const classification = forceCore
                  ? vi
                      .spyOn(countSupport, "classifyAdvancedCountFilter")
                      .mockReturnValue({
                        kind: "unsupported",
                        path: "root",
                        code: "forced_core_oracle",
                        reason: "Generated analytics-family Core oracle.",
                      })
                  : undefined;
                try {
                  const result = await executeAnalyticsCostScenario(env, {
                    ...report,
                    scope,
                    filterDsl: independentWindow
                      ? `(${dsl}) and time gte @range.start+1d`
                      : dsl,
                  });
                  if (forceCore) {
                    expect(result.coreCalls).toBeGreaterThan(0);
                    expect(result.actualStrategies).toContain("bounded-core");
                  } else {
                    expect(result.coreCalls).toBe(0);
                    expect(result.actualStrategies).toEqual(
                      expect.arrayContaining([
                        expect.stringMatching(
                          /^sql-(?:report-fusion|membership)$/u,
                        ),
                      ]),
                    );
                  }
                  return { value: result.value, source: result.source };
                } finally {
                  classification?.mockRestore();
                }
              }

              await checkDifferentialFilterCase({
                sample,
                reference: (dsl) => execute(dsl, true),
                candidates: { sql: (dsl) => execute(dsl, false) },
              });
            },
          );
  },
);
