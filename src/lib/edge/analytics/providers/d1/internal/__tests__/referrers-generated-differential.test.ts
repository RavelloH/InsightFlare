import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  checkDifferentialFilterCase,
  generateDifferentialFilterCases,
} from "@/lib/edge/analytics/engine/__tests__/differential/filter-cases";
import type { Env } from "@/lib/edge/types";

import { executeCostStrategy } from "./remote-d1/referrers-cost-harness";
import { buildDataStatements, buildSiteStatements } from "./remote-d1/seed";

const SAMPLES = generateDifferentialFilterCases(0x20261113, 12);

describe.each([0, 19, 96])(
  "generated Referrers parity, %i visits",
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
        MAIN_SECRET: "generated-differential-test",
      } as unknown as Env;
    });
    afterAll(() => database?.close());

    for (const scope of ["session", "visitor"] as const)
      it.each(SAMPLES)(`${scope}, seed $seed case $index`, async (sample) => {
        await checkDifferentialFilterCase({
          sample,
          reference: async (dsl) =>
            (await executeCostStrategy(env, scope, "core", dsl)).value,
          candidates: {
            fused: async (dsl) =>
              (await executeCostStrategy(env, scope, "fused", dsl)).value,
            membership: async (dsl) =>
              (await executeCostStrategy(env, scope, "member-relation", dsl))
                .value,
          },
        });
      });
  },
);
