import { describe, expect, it } from "vitest";

import { analyticsFilterRegistry } from "@/lib/edge/analytics/contract/filter-registry";
import { executeObservationFilterOnScopedDataset } from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import { parseFilterDsl } from "@/lib/filter-contract";

const dataset = {
  ctes: "scope_raw_visits AS (...), scope_raw_events AS (...)",
  bindings: [{ value: "base" }],
  visitRelation: "scope_final_visits",
  eventRelation: "scope_final_events",
  sessionRelation: "scope_final_sessions",
  visitorRelation: "scope_final_visitors",
  scope: "event" as const,
};

describe("scoped dataset Observation Filter primitive", () => {
  it("projects a step onto the existing final relations and derives identities", () => {
    const result = executeObservationFilterOnScopedDataset(
      dataset,
      parseFilterDsl('page.path eq "/pricing"', analyticsFilterRegistry),
      "funnel_step_0",
    );

    expect(result.matchedVisitRelation).toBe("funnel_step_0_matched_visits");
    expect(result.matchedEventRelation).toBe("funnel_step_0_matched_events");
    expect(result.ctes).toContain(
      "FROM scope_final_visits funnel_step_0_visit_filter",
    );
    expect(result.ctes).toContain(
      "FROM scope_final_events funnel_step_0_event_filter",
    );
    expect(result.ctes).toContain("SELECT DISTINCT site_pk, session_id");
    expect(result.ctes).toContain("TRIM(COALESCE(session_id, '')) != ''");
    expect(result.ctes).toContain("SELECT DISTINCT site_pk, visitor_id");
    expect(result.bindings).toEqual([
      { value: "/pricing" },
      { value: "/pricing" },
    ]);
  });

  it("keeps per-step CTE namespaces isolated and rejects unsafe names", () => {
    const filter = parseFilterDsl(
      'event.name eq "signup"',
      analyticsFilterRegistry,
    );
    const first = executeObservationFilterOnScopedDataset(
      dataset,
      filter,
      "step_a",
    );
    const second = executeObservationFilterOnScopedDataset(
      dataset,
      filter,
      "step_b",
    );

    expect(first.ctes).not.toContain("step_b_");
    expect(second.ctes).not.toContain("step_a_");
    expect(() =>
      executeObservationFilterOnScopedDataset(dataset, filter, "step;drop"),
    ).toThrow("internal SQL identifier");
  });
});
