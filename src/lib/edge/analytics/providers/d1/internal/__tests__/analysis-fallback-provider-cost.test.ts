// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";

import {
  ANALYSIS_FALLBACK_SCENARIOS,
  buildAnalysisFallbackCostFixture,
  executeAnalysisFallbackCost,
} from "./remote-d1/analysis-fallback-cost-harness";

const fixture = buildAnalysisFallbackCostFixture(48);
const database = createMigratedDatabase();
beforeAll(() => {
  for (const sql of fixture.seed) database.exec(sql);
  database.exec("PRAGMA query_only=ON");
});
afterAll(() => database.close());

describe.sequential.each(ANALYSIS_FALLBACK_SCENARIOS)(
  "$name actual fallback routes, complete metadata and cross-route cursor",
  (scenario) => {
    type Result = Awaited<ReturnType<typeof executeAnalysisFallbackCost>>;
    let old: Result | undefined;
    let oldNext: Result | undefined;
    it("captures the complete original fallback result", async () => {
      const db = createSqliteD1Database(database);
      old = await executeAnalysisFallbackCost(db, scenario, "old-bridge");
    });
    it("matches the complete original fallback result", async () => {
      if (!old) throw new Error("analysis_native_reference_missing");
      const db = createSqliteD1Database(database);
      const relation = await executeAnalysisFallbackCost(
        db,
        scenario,
        "request-relation",
      );
      expect(relation).toEqual(old);
    });
    if (scenario.name === "visitors/session/goal") {
      it("captures the original next page with the original cursor", async () => {
        if (!old) throw new Error("analysis_native_reference_missing");
        if (!old.ok) throw new Error("analysis_native_reference_failed");
        const cursor = old.data.pagination.nextCursor;
        expect(cursor).toBeTypeOf("string");
        const db = createSqliteD1Database(database);
        oldNext = await executeAnalysisFallbackCost(
          db,
          scenario,
          "old-bridge",
          cursor,
        );
      });
      it("matches the original next page with the same cursor", async () => {
        if (!old || !old.ok || !oldNext)
          throw new Error("analysis_native_next_reference_missing");
        const cursor = old.data.pagination.nextCursor;
        const db = createSqliteD1Database(database);
        const relationNext = await executeAnalysisFallbackCost(
          db,
          scenario,
          "request-relation",
          cursor,
        );
        expect(relationNext).toEqual(oldNext);
      });
    }
  },
);
