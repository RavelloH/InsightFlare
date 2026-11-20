// @vitest-environment node
import { describe, expect, it } from "vitest";

import { registerComparisonQueryProviders } from "@/lib/edge/analytics/composition/comparison-query-providers";
import { createComparisonRuntime } from "@/lib/edge/analytics/composition/comparison-runtime";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import { createD1TeamProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-team-runtime";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  FILTER_SCOPE_CAPABILITIES,
} from "@/lib/edge/analytics/contract";
import { compileScopedDatasetSql } from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  parseFilterDsl,
  validateFilterConditionDomains,
  validateFilterRelationDomains,
} from "@/lib/filter-contract";

/**
 * Legal AST coverage corpus sourced from the public DSL grammar, type
 * validator and history tests. Every case must compile to database SQL and
 * bound values without requesting JS activity/payload materialization.
 */
const CASES: readonly [string, "event" | "session" | "visitor"][] = [
  ['page.path eq "/home"', "event"],
  ['event.name eq "purchase"', "event"],
  ['event.payload("/cart/0/sku") eq "A"', "event"],
  ['EVENT { $.payload("/sku") eq "A" } exists', "session"],
  ['PAGE { $.path eq "/home" } exists', "visitor"],
  ['SESSION { EVENT { $.name eq "purchase" } exists } exists', "visitor"],
  ["VISITOR { count(SESSION) gt 0 } exists", "session"],
  ['PAGE { $.path eq "/home" AND $.path neq "/docs" } exists', "session"],
  ['NOT EVENT { $.name eq "purchase" } exists', "session"],
  ['count(EVENT { $.name eq "purchase" }) eq 0', "session"],
  ["count(PAGE) gte 1", "session"],
  ['count(EVENT -> payload("/sku")) gte 1', "session"],
  ['first(EVENT).name eq "purchase"', "session"],
  ['last(EVENT).name eq "purchase"', "visitor"],
  ['nth(EVENT, 2).name eq "purchase"', "session"],
  ['first(EVENT -> payload("/sku")) eq "A"', "session"],
  ['last(EVENT -> payload("/sku")) eq "A"', "session"],
  ['nth(EVENT -> payload("/sku"), 3) eq "A"', "session"],
  ['sum(EVENT -> payload("/amount")) gte 2', "visitor"],
  ['avg(EVENT -> payload("/amount")) gte 2', "visitor"],
  ['min(EVENT -> payload("/amount")) lte 2', "session"],
  ['max(EVENT -> payload("/amount")) gte 5', "session"],
  ['countDistinct(EVENT -> payload("/sku")) gte 2', "visitor"],
  ["add(count(EVENT), count(PAGE)) gte 1", "session"],
  ["div(count(PAGE), count(EVENT)) gt 0", "session"],
  ["time(first(EVENT)) gte @now-14d", "session"],
  ["time(last(PAGE)) between [@now-30d, @now]", "visitor"],
  ['time(nth(EVENT { $.name eq "purchase" }, 3)) gte @now-30d', "session"],
  [
    'time between [@now-60d, @now-30d] AND first(EVENT).name eq "purchase"',
    "session",
  ],
  ["countDistinct(bucket(PAGE, 1d)) gte 1", "visitor"],
  ["count(window(EVENT, @range.start, [0d, 7d])) gte 1", "session"],
  ["count(window(EVENT, first(EVENT), [0d, 7d])) gte 1", "session"],
  ["periods(EVENT, 1w) { count($items) gte 3 } exists", "session"],
  ["count(periods(EVENT, 1w)) gte 1", "visitor"],
  ["first(periods(EVENT, 1w)) exists", "session"],
  [
    'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) exists',
    "session",
  ],
  [
    "sequence([EVENT, EVENT, EVENT]) { $gap(1, 2) lte 1h AND $span lte 3d } exists",
    "session",
  ],
  [
    'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $same($.payload("/sku")) } exists',
    "session",
  ],
  ["adjacent(sequence([PAGE, EVENT])) exists", "session"],
  ["without(sequence([PAGE, EVENT]), EVENT) exists", "visitor"],
  [
    "without(sequence([window(EVENT, @range.start, [0d, 1d]), window(EVENT, @range.end, [-1d, 0d])]), EVENT) exists",
    "session",
  ],
  [
    'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $span lte 30d AND count(periods(EVENT, 1w) { count($items) gte 3 }) gte 1 } exists',
    "session",
  ],
];

describe("P5 35 scoped QueryOperation SQL integration contract", () => {
  const scopedOperations = Object.entries(FILTER_SCOPE_CAPABILITIES).filter(
    ([, value]) => value.kind === "scoped",
  );
  const unscopedOperations = Object.entries(FILTER_SCOPE_CAPABILITIES).filter(
    ([, value]) => value.kind === "none",
  );

  it("enumerates exactly 35 scoped and five intentionally unsupported operations", () => {
    expect(scopedOperations).toHaveLength(35);
    expect(unscopedOperations).toHaveLength(5);
    const advanced = parseFilterDsl(
      'count(EVENT { $.name eq "purchase" }) gte 1',
      analyticsFilterRegistry,
    );
    for (const [operation] of unscopedOperations) {
      expect(createScopedFilterPlan(operation as never, advanced)).toBeNull();
    }
  });

  it.each(scopedOperations)("compiles advanced SQL for %s", (operation) => {
    const document = parseFilterDsl(
      'count(EVENT { $.name eq "purchase" }) gte 1',
      analyticsFilterRegistry,
    );
    const plan = createScopedFilterPlan(operation as never, document)!;
    expect(plan).not.toBeNull();
    const time = createQueryTime(100, 300, "UTC", 400);
    const prepared = attachScopedFilterMetadata(document, {
      requestedScope: plan.scope,
      resolvedScope: plan.scope,
      plan,
      time,
      siteIds: ["site-a"],
    });
    const dataset = compileScopedDatasetSql({
      filters: prepared,
      plan,
      siteIds: ["site-a"],
      window: {
        startMs: 100,
        endExclusiveMs: 300,
        timeZone: "UTC",
        nowMs: 400,
      },
    });
    expect(dataset.ctes).toContain("scope_filter_read_visits");
    expect(dataset.ctes).toContain(
      plan.scope === "event"
        ? "scope_filter_matched_events"
        : "scope_filter_qualified_entities",
    );
    expect(dataset.ctes).not.toContain("scope_advanced_matching_entities");
    expect(dataset.visitRelation).toBe("scope_final_visits");
  });
});

describe("P3–P5 full legal advanced AST SQL compile coverage", () => {
  it.each(CASES)("%s, scope %s", (source, scope) => {
    const doc = parseFilterDsl(source, analyticsFilterRegistry);
    const plan = createScopedFilterPlan("overview", doc, scope)!;
    const analysis = analyzeFilterDocument(doc, analyticsFilterRegistry);
    validateFilterConditionDomains(doc, scope, analyticsFilterRegistry);
    validateFilterRelationDomains(doc, scope, analysis);
    const window = {
      startMs: Date.parse("2026-11-01T00:00:00Z"),
      endExclusiveMs: Date.parse("2026-11-20T00:00:00Z"),
      nowMs: Date.parse("2026-11-20T00:00:01Z"),
      timeZone: "America/Los_Angeles",
    };
    const filters = attachScopedFilterMetadata(doc, {
      requestedScope: scope,
      resolvedScope: plan.scope,
      plan,
      time: createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        window.timeZone,
        window.nowMs,
      ),
      siteIds: ["site-a"],
    });
    const compiled = compileScopedDatasetSql({
      filters,
      plan,
      siteIds: ["site-a"],
      window,
    });
    expect(compiled.ctes).toContain("scope_final_visits");
    expect(compiled.ctes).toContain("scope_final_events");
    expect(compiled.ctes).not.toContain("scope_advanced_matching_entities");
    expect(compiled.bindings.length).toBeGreaterThanOrEqual(6);
  });
});

describe("P5 actual production provider wiring for every declared scoped operation", () => {
  it("registers every implemented scoped consumer and explicitly excludes missing Explore", () => {
    const env = { DB: {} } as never;
    const site = createD1SiteProviderRegistry({ env, siteId: "site-a" });
    registerComparisonQueryProviders(
      site,
      createComparisonRuntime({ env, siteId: "site-a" }),
    );
    const team = createD1TeamProviderRegistry({ env });
    const scoped = Object.entries(FILTER_SCOPE_CAPABILITIES)
      .filter(([, capability]) => capability.kind === "scoped")
      .map(([operation]) => operation);
    expect(scoped).toHaveLength(35);
    expect(site.resolve("explore")).toBeUndefined();
    expect(team.resolve("explore")).toBeUndefined();
    for (const operation of scoped.filter(
      (name) => !["explore", "team-dashboard"].includes(name),
    )) {
      expect(
        site.resolve(operation as never) ?? team.resolve(operation as never),
        "Missing actual D1 production provider for " + operation,
      ).toBeDefined();
    }
    // Team dashboard is composed through the private SSR query runtime,
    // not through a synthetic D1 site/team API v1 provider.
  });
});
