// @vitest-environment node
import { readFileSync } from "node:fs";
import type { SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import * as singletonReuse from "@/lib/db/query/physical/shared-singleton-lookup-reuse";
import type { Env } from "@/lib/edge/types";

import { buildJourneyEventFieldsCostFixture } from "./remote-d1/journey-event-fields-cost-fixture";
import {
  assertPositiveJourneyEventFieldsDto,
  executeJourneyEventFieldsCostScenario,
  JOURNEY_EVENT_FIELDS_COST_SCENARIOS,
} from "./remote-d1/journey-event-fields-cost-scenarios";
import {
  observeCostDatabase,
  summarizeCost,
} from "./remote-d1/referrers-cost-harness";
import { inspectRetentionCohortPlan } from "./remote-d1/retention-cost-guard";

describe("Retention, Funnel and Event fields actual provider cost shapes", () => {
  const local = createMigratedDatabase();
  beforeAll(() => {
    for (const sql of buildJourneyEventFieldsCostFixture(160).seed)
      local.exec(sql);
    local.exec("PRAGMA query_only=ON");
  });
  afterAll(() => local.close());

  it.each(JOURNEY_EVENT_FIELDS_COST_SCENARIOS)(
    "$name preserves the entire DTO against the pre-owner-materialization path",
    async (scenario) => {
      const trace = {
        preparedSql: [] as string[],
        bindings: [] as SQLInputValue[][],
      };
      const measured = observeCostDatabase(
        createSqliteD1Database(local, trace),
      );
      const actual = await executeJourneyEventFieldsCostScenario(
        { DB: measured.database, MAIN_SECRET: "c01-secret" } as Env,
        scenario,
      );
      const before = vi
        .spyOn(singletonReuse, "sharedSingletonLookupReuse")
        .mockReturnValue(false);
      let reference;
      try {
        reference = await executeJourneyEventFieldsCostScenario(
          {
            DB: createSqliteD1Database(local),
            MAIN_SECRET: "c01-secret",
          } as Env,
          scenario,
        );
      } finally {
        before.mockRestore();
      }
      expect(actual.value).toEqual(reference.value);
      expect(actual.actualStrategies).toEqual(reference.actualStrategies);
      assertPositiveJourneyEventFieldsDto(scenario, actual.value);
      expect(actual.coreCalls).toBe(0);
      const cost = summarizeCost(measured.observations);
      expect(cost).toMatchObject({
        metadataStatus: "unsupported",
        rowsRead: null,
        rowsWritten: null,
        sqlDurationMs: null,
      });
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.maxParameters).toBeLessThanOrEqual(100);
      expect(cost.maxSqlBytes).toBeLessThanOrEqual(100000);
      if (scenario.operation === "retention") {
        const inspections = trace.preparedSql.map((sql, index) =>
          inspectRetentionCohortPlan(
            sql,
            local
              .prepare(`EXPLAIN QUERY PLAN ${sql}`)
              .all(...trace.bindings[index]!)
              .map((row) => ({
                id: Number(row.id),
                parent: Number(row.parent),
                detail: String(row.detail),
              })),
          ),
        );
        expect(
          inspections.flatMap((inspection) => inspection.violations),
        ).toEqual([]);
        expect(
          inspections.reduce(
            (total, inspection) => total + inspection.cohortLookups,
            0,
          ),
        ).toBeGreaterThan(0);
      }
    },
  );

  it("rejects the frozen actual former cohort scan even though other membership lookups are indexed", () => {
    const before = JSON.parse(
      readFileSync(
        new URL(
          "./remote-d1/fixtures/retention-cohort-before.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { sql: string; params: SQLInputValue[] };
    const plan = local
      .prepare(`EXPLAIN QUERY PLAN ${before.sql}`)
      .all(...before.params)
      .map((row) => ({
        id: Number(row.id),
        parent: Number(row.parent),
        detail: String(row.detail),
      }));
    const inspection = inspectRetentionCohortPlan(before.sql, plan);
    expect(inspection.cohortRelations).toBeGreaterThan(0);
    expect(
      inspection.violations.some((violation) =>
        violation.detail.startsWith("SCAN "),
      ),
    ).toBe(true);
  });
});
