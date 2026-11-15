// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";

import {
  observeCostDatabase,
  summarizeCost,
} from "./remote-d1/referrers-cost-harness";
import {
  executeSecondaryCostScenario,
  SECONDARY_COST_SCENARIOS,
} from "./remote-d1/secondary-cost-scenarios";
import { buildDataStatements, buildSiteStatements } from "./remote-d1/seed";

describe("Secondary list provider cost instrumentation on real native SQLite", () => {
  const local = createMigratedDatabase();
  beforeAll(() => {
    for (const sql of [
      ...buildSiteStatements(),
      ...buildDataStatements({ visits: 160 }),
    ])
      local.exec(sql);
    local.exec("PRAGMA query_only=ON");
  });
  afterAll(() => local.close());
  it.each(SECONDARY_COST_SCENARIOS)(
    "$name records actual strategy and bound SQL",
    async (scenario) => {
      const observed = observeCostDatabase(createSqliteD1Database(local));
      const execution = await executeSecondaryCostScenario(
        { DB: observed.database, MAIN_SECRET: "c01-secret" } as Env,
        scenario,
      );
      expect(execution.actualStrategies.length).toBeGreaterThan(0);
      expect(execution.coreCalls).toBe(0);
      expect(execution.value).toMatchObject({ pagination: { limit: 20 } });
      if (!scenario.filterDsl)
        expect(
          (execution.value as { items: unknown[] }).items.length,
        ).toBeGreaterThan(0);
      const cost = summarizeCost(observed.observations);
      expect(cost.metadataStatus).toBe("unsupported");
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.maxParameters).toBeLessThanOrEqual(100);
      expect(cost.maxSqlBytes).toBeLessThanOrEqual(100000);
    },
  );
});
