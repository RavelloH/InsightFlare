import { describe, expect, it } from "vitest";

import {
  attachFilterScopePreference,
  attachScopedFilterMetadata,
  createScopedFilterPlan,
  type FilterDocument,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  queryOverviewAggregate,
  queryTrendAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/overview";
import { canUseHourlyRollupsForFilter } from "@/lib/edge/analytics/providers/d1/internal/rollup-eligibility";
import type { Env } from "@/lib/edge/types";

const HOUR = 3_600_000;
const window = {
  startMs: 12 * HOUR,
  endExclusiveMs: 14 * HOUR,
  nowMs: 14 * HOUR,
  timeZone: "UTC",
};
const empty: FilterDocument = { version: 1, root: null };
const time = {
  range: { startMs: window.startMs, endExclusiveMs: window.endExclusiveMs },
  reportingTimeZone: "UTC",
  capturedAtMs: window.nowMs,
} as QueryTime;

function filters(scope: "event" | "session" | "visitor") {
  const plan = createScopedFilterPlan("overview", empty, scope)!;
  return attachScopedFilterMetadata(empty, {
    requestedScope: scope,
    resolvedScope: plan.scope,
    plan,
    time,
    siteIds: ["site-safe"],
  });
}
function fixture() {
  const calls: string[] = [];
  const db = {
    prepare(sql: string) {
      calls.push(sql);
      return {
        bind() {
          return this;
        },
        async all() {
          if (sql.includes("visit_hourly_aggregation_state"))
            return {
              results: [{ siteId: "site-safe", aggregatedUntilHour: 13 }],
              meta: { rows_read: 1 },
            };
          if (sql.includes("visit_hourly_rollups"))
            return { results: [], meta: { rows_read: 0 } };
          return {
            results: [
              {
                views: 4,
                sessions: 2,
                visitors: 2,
                bounces: 1,
                totalDuration: 30,
                durationViews: 4,
              },
            ],
            meta: { rows_read: 2 },
          };
        },
      };
    },
  };
  return { env: { DB: db } as unknown as Env, calls };
}

describe("Rollup eligibility after Filter-SQL scope preparation", () => {
  it("allows empty auto/Event filter documents even after a typed plan was attached", () => {
    expect(canUseHourlyRollupsForFilter(empty)).toBe(true);
    expect(canUseHourlyRollupsForFilter(filters("event"))).toBe(true);
  });
  it("honors the real Query Application preparation for both single-site and team-site operations", () => {
    const cases = [
      ["overview", siteQueryContext("site-safe", "private-dashboard")],
      ["team-sites", teamQueryContext("team-1", "api-v1", ["site-safe"])],
    ] as const;
    for (const [operation, context] of cases) {
      const prepared = prepareScopedQuery(operation, {
        context,
        time,
        filters: empty,
        scopePreference: "auto",
      } as QueryInput);
      expect(prepared.scopePlan?.mode).toBe("observation");
      expect(canUseHourlyRollupsForFilter(prepared.filters)).toBe(true);
      const entity = prepareScopedQuery(operation, {
        context,
        time,
        filters: empty,
        scopePreference: "session",
      } as QueryInput);
      expect(entity.scopePlan?.mode).toBe("entity");
      expect(canUseHourlyRollupsForFilter(entity.filters)).toBe(false);
    }
  });
  it("preserves explicit session/visitor scope even with an empty AST", () => {
    expect(canUseHourlyRollupsForFilter(filters("session"))).toBe(false);
    expect(canUseHourlyRollupsForFilter(filters("visitor"))).toBe(false);
    expect(
      canUseHourlyRollupsForFilter(
        attachFilterScopePreference(empty, "session"),
      ),
    ).toBe(false);
  });
  it("does not roll up an actual filtered predicate", () => {
    const predicate: FilterDocument = {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "page.path" as never },
        operator: "eq",
        value: "/docs",
      },
    };
    expect(canUseHourlyRollupsForFilter(predicate)).toBe(false);
  });
  it("routes planned empty Event overview to an actual hourly rollup query instead of raw", async () => {
    const f = fixture();
    const result = await queryOverviewAggregate(
      f.env,
      "site-safe",
      window,
      filters("event"),
    );
    expect(result.diagnosticSource).toBe("rollup");
    expect(
      f.calls.some((sql) => sql.includes("visit_hourly_aggregation_state")),
    ).toBe(true);
    expect(f.calls.some((sql) => sql.includes("visit_hourly_rollups"))).toBe(
      true,
    );
    expect(f.calls.some((sql) => sql.includes("session_rollup AS"))).toBe(
      false,
    );
  });
  it("routes planned empty Event trend to hourly rollups, not Raw CTE", async () => {
    const f = fixture();
    const result = await queryTrendAggregate(
      f.env,
      "site-safe",
      window,
      "hour",
      filters("event"),
    );
    expect(result.diagnosticSource).toBe("rollup");
    expect(
      f.calls.some((sql) => sql.includes("visit_hourly_aggregation_state")),
    ).toBe(true);
    expect(f.calls.some((sql) => sql.includes("visit_hourly_rollups"))).toBe(
      true,
    );
  });
});
