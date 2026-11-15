import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  compileD1Query,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  lowerLogicalPlan,
} from "@/lib/db";
import { createTimeRange } from "@/lib/edge/analytics/contract";
import type { SiteId, TeamId } from "@/lib/edge/analytics/contract/types";
import {
  ADVANCED_COUNT_FILTER_OUTPUTS,
  buildAdvancedCountFilterMatchPlan,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { classifyAdvancedCountFilter } from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import type { AdvancedFilterNumericCompatibilityRequirement } from "@/lib/edge/analytics/engine/semantic/advanced-filter-field-requirements";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";
import { validateFilterConditionDomains } from "@/lib/filter-contract/filter-semantics";
import { validateFilterRelationDomains } from "@/lib/filter-contract/filter-types";

interface BudgetMeasurement {
  readonly siteCount: number;
  readonly bindingCount: number;
  readonly sqlBytes: number;
  readonly sqlSha256: string;
  readonly siteMembershipShape: "expanded" | "json-array";
  readonly jsonMembershipSites: number;
}

function compiledMeasurement(siteCount: number): BudgetMeasurement {
  const siteIds = Array.from(
    { length: siteCount },
    (_, index) => `wave75-site-${String(index).padStart(2, "0")}` as SiteId,
  );
  const timeRange = createTimeRange(0, 100_000);
  const support = classifyAdvancedCountFilter(
    parseFilterDsl(
      "count(page) gte 1 AND count(event) gte 1",
      analyticsFilterRegistry,
    ),
    "session",
  );
  if (support.kind !== "supported")
    throw new Error("wave75_count_binding_filter_not_supported");
  const plan = buildAdvancedCountFilterMatchPlan({
    subject: createSemanticSubjectDomain({
      origin: "team",
      teamId: "wave75-binding-team" as TeamId,
      siteIds,
    }),
    candidateRange: timeRange,
    readRange: timeRange,
    expressionRange: timeRange,
    expressionUsesExplicitRange: false,
    lowerBounds: siteIds.map((siteId, index) => ({
      siteId,
      startMs: index * 1_000,
    })),
    scope: "session",
    reportingTimeZone: "UTC",
    capturedAtMs: 100_000,
    analysis: support.analysis,
  });
  const output = plan.outputs.find(
    (candidate) => candidate.id === ADVANCED_COUNT_FILTER_OUTPUTS.matches,
  );
  if (!output) throw new Error("wave75_count_binding_output_missing");
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteIds,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const projected = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const compiled = compileD1Query(lowerLogicalPlan(projected), {
    tag: "analytics.advanced_filter.count_match",
  });
  const sqlBytes = Buffer.byteLength(compiled.sql, "utf8");
  const siteIdsMembershipEncoded = (compiled.bindings ?? []).some((binding) => {
    if (typeof binding !== "string" || !binding.startsWith("[")) return false;
    try {
      const values = JSON.parse(binding) as unknown;
      return (
        Array.isArray(values) &&
        values.length === siteIds.length &&
        values.every((value, index) => value === siteIds[index])
      );
    } catch {
      return false;
    }
  });
  const siteMembershipShape = siteIdsMembershipEncoded
    ? "json-array"
    : "expanded";
  return {
    siteCount,
    bindingCount: compiled.bindings?.length ?? 0,
    sqlBytes,
    sqlSha256: createHash("sha256").update(compiled.sql).digest("hex"),
    siteMembershipShape,
    jsonMembershipSites: siteIdsMembershipEncoded ? siteCount : 0,
  };
}

function selectorMatchPlan(
  filterDsl: string,
  numericCompatibilityFieldIds?: readonly string[],
  numericCompatibilityRequirements?: readonly AdvancedFilterNumericCompatibilityRequirement[],
) {
  const siteIds = ["wave82-selector-contract-site" as SiteId];
  const timeRange = createTimeRange(0, 100_000);
  const support = classifyAdvancedCountFilter(
    parseFilterDsl(filterDsl, analyticsFilterRegistry),
    "session",
  );
  if (support.kind !== "supported")
    throw new Error("wave82_selector_contract_filter_not_supported");
  return buildAdvancedCountFilterMatchPlan({
    subject: createSemanticSubjectDomain({
      origin: "team",
      teamId: "wave82-selector-contract-team" as TeamId,
      siteIds,
    }),
    candidateRange: timeRange,
    readRange: timeRange,
    expressionRange: timeRange,
    expressionUsesExplicitRange: false,
    lowerBounds: [{ siteId: siteIds[0]!, startMs: 0 }],
    scope: "session",
    reportingTimeZone: "UTC",
    capturedAtMs: 100_000,
    analysis: support.analysis,
    ...(numericCompatibilityFieldIds === undefined
      ? {}
      : { numericCompatibilityFieldIds }),
    ...(numericCompatibilityRequirements === undefined
      ? {}
      : { numericCompatibilityRequirements }),
  });
}

function compiledMatch(plan: ReturnType<typeof selectorMatchPlan>) {
  const siteIds = ["wave82-selector-contract-site" as SiteId];
  const output = plan.outputs.find(
    (candidate) => candidate.id === ADVANCED_COUNT_FILTER_OUTPUTS.matches,
  );
  if (!output) throw new Error("wave82_selector_contract_output_missing");
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteIds,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const projected = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  return {
    output,
    compiled: compileD1Query(lowerLogicalPlan(projected), {
      tag: "analytics.advanced_filter.count_match",
    }),
  };
}

describe("advanced count matcher full-history budgets", () => {
  it("keeps representative site batches within shared limits and records JSON membership changes", () => {
    const measurements = [1, 20, 21, 22, 24, 26].map(compiledMeasurement);
    for (const measurement of measurements) {
      expect(measurement.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(measurement.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    }
    expect(measurements[1]?.siteMembershipShape).toBe("expanded");
    expect(measurements[2]?.siteMembershipShape).toBe("expanded");
    expect(measurements[3]?.siteMembershipShape).toBe("json-array");
    expect(measurements[4]?.siteMembershipShape).toBe("json-array");
    expect(measurements[5]?.siteMembershipShape).toBe("json-array");
    expect(measurements[3]?.jsonMembershipSites).toBe(22);
    expect(measurements[4]?.jsonMembershipSites).toBe(24);
    expect(measurements[5]?.jsonMembershipSites).toBe(26);
    console.info(
      "Wave75 full-history match binding budget",
      JSON.stringify({
        measurements,
        sharedBindingLimit: D1_MAX_BOUND_PARAMETERS,
        sharedSqlUtf8Limit: D1_MAX_SQL_UTF8_BYTES,
      }),
    );
  });

  it("derives numeric matcher proof fields from the analyzed selector AST", () => {
    const numeric = compiledMatch(
      selectorMatchPlan("count(page { page.durationMs gt 5 }) eq 1"),
    );
    expect(numeric.output.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(["rowKind", "invalidContextPageDurationMsCount"]),
    );
    expect(numeric.compiled.sql).toContain("typeof(");
    expect(numeric.compiled.sql).toContain("duration_ms");

    expect(() =>
      selectorMatchPlan("count(page { page.durationMs gt 5 }) eq 1", []),
    ).toThrow("advanced_count_match_numeric_compatibility_fields_mismatch");

    const rawPresence = compiledMatch(
      selectorMatchPlan("count(page { page.durationMs exists }) eq 1"),
    );
    expect(rawPresence.output.fields.map((field) => field.name)).toEqual([
      "siteId",
      "entityId",
    ]);
    expect(rawPresence.compiled.sql).not.toContain("typeof(");
  });

  it("requires exact numeric proof domains while deriving bare-field proof", () => {
    const bare = compiledMatch(selectorMatchPlan("page.durationMs gt 5"));
    expect(bare.output.fields.map((field) => field.name)).toContain(
      "invalidContextPageDurationMsCount",
    );
    expect(bare.compiled.sql).toContain("event");
    expect(bare.compiled.sql).toContain("typeof(");

    expect(() =>
      selectorMatchPlan("page.durationMs gt 5", undefined, []),
    ).toThrow(
      "advanced_count_match_numeric_compatibility_requirements_mismatch",
    );
    expect(() =>
      selectorMatchPlan("page.durationMs gt 5", undefined, [
        { fieldId: "page.durationMs", domain: "page-only" },
      ]),
    ).toThrow(
      "advanced_count_match_numeric_compatibility_requirements_mismatch",
    );
    expect(() =>
      selectorMatchPlan("page.durationMs gt 5", undefined, [
        { fieldId: "page.durationMs", domain: "page-and-event" },
        { fieldId: "page.durationMs", domain: "page-and-event" },
      ]),
    ).toThrow(
      "advanced_count_plan_received_invalid_numeric_compatibility_requirement",
    );
  });
});

describe("advanced count Engine capability boundary", () => {
  const capabilityCases = [
    {
      filterDsl: "countDistinct(page.path) eq 2",
      engineError: "advanced_count_plan_received_unchecked_target",
    },
    {
      filterDsl: 'min(page.title) eq "x"',
      engineError: "advanced_count_plan_received_unchecked_target",
    },
    {
      filterDsl: 'max(event.name) eq "x"',
      engineError: "advanced_count_plan_received_unchecked_target",
    },
    {
      filterDsl: "count(page.geo.country) eq 1",
      engineError: "advanced_count_plan_received_unchecked_target",
    },
    {
      filterDsl: 'geo.country eq "US"',
      engineError: "advanced_count_plan_received_unchecked_bare_field",
    },
    {
      filterDsl: 'count(page { geo.country eq "US" }) eq 1',
      engineError: "advanced_count_plan_received_unchecked_selector_field",
    },
    {
      filterDsl: "count(page { count(event) gte 1 }) gte 1",
      engineError: "advanced_count_plan_received_unchecked_selector",
    },
  ] as const;

  it.each(capabilityCases)(
    "rejects the valid but unclassified Engine input $filterDsl",
    ({ filterDsl, engineError }) => {
      const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
      const analysis = analyzeFilterDocument(document, analyticsFilterRegistry);
      validateFilterConditionDomains(
        document,
        "session",
        analyticsFilterRegistry,
      );
      validateFilterRelationDomains(document, "session", analysis);

      expect(classifyAdvancedCountFilter(document, "session")).toMatchObject({
        kind: "unsupported",
      });

      const siteId = "wave88-engine-capability-site" as SiteId;
      const range = createTimeRange(0, 100_000);
      expect(() =>
        buildAdvancedCountFilterMatchPlan({
          subject: createSemanticSubjectDomain({
            origin: "site",
            siteIds: [siteId],
          }),
          candidateRange: range,
          readRange: range,
          expressionRange: range,
          expressionUsesExplicitRange: false,
          lowerBounds: [{ siteId, startMs: range.startMs }],
          scope: "session",
          reportingTimeZone: "UTC",
          capturedAtMs: range.endExclusiveMs,
          analysis,
        }),
      ).toThrow(engineError);
    },
  );
});
