import { describe, expect, it } from "vitest";

import { compileD1Query } from "@/lib/db";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";

const SITE = "relational-lowering-gaps-site";

type SlotType =
  | { readonly kind: "scalar"; readonly scalar: "string" | "number" }
  | { readonly kind: "entity"; readonly entity: "page" };

function createBuilder(): LogicalPlanBuilder {
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE as never],
    }),
    time: createSemanticTemporalDomains({
      candidate: { startMs: 0 as never, endExclusiveMs: 1 as never },
      read: { kind: "retained-history" },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 0 as never,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

function withNode(
  plan: ValidatedLogicalPlan,
  id: RelationId,
  update: (node: LogicalNode) => LogicalNode,
): ValidatedLogicalPlan {
  return {
    ...plan,
    nodes: plan.nodes.map((node) => (node.id === id ? update(node) : node)),
  } as ValidatedLogicalPlan;
}

function withSlot(
  plan: ValidatedLogicalPlan,
  id: SlotId,
  patch: { readonly type?: SlotType; readonly nullable?: boolean },
): ValidatedLogicalPlan {
  return {
    ...plan,
    slots: plan.slots.map((slot) =>
      slot.id === id ? { ...slot, ...patch } : slot,
    ),
  } as ValidatedLogicalPlan;
}

function lowerer(plan: ValidatedLogicalPlan): AnalyticsLogicalToDbLowerer {
  return new AnalyticsLogicalToDbLowerer(plan, {
    siteId: SITE,
    time: plan.context.time,
  });
}

function lower(plan: ValidatedLogicalPlan): void {
  lowerer(plan).lower(plan.outputs[0]!);
}

type Pages = ReturnType<LogicalPlanBuilder["source"]>;

const PAGE_ATTRIBUTES = [
  "page.report.localId",
  "page.report.status",
  "page.report.durationMs",
] as const;

function aggregatePlan() {
  const builder = createBuilder();
  const pages = builder.source("page", {
    temporalDomain: "read",
    attributes: PAGE_ATTRIBUTES,
  });
  const aggregate = builder.aggregate(
    pages,
    { status: builder.slot(pages, "attribute:page.report.status") },
    [{ name: "rows", kind: "count-rows" }],
  );
  builder.output("aggregate", aggregate, [
    { name: "status", slot: "status" },
    { name: "rows", slot: "rows" },
  ]);
  return { plan: builder.finish(), id: aggregate.id, slots: aggregate.slots };
}

function sampleStatisticsPlan() {
  const builder = createBuilder();
  const pages = builder.source("page", {
    temporalDomain: "read",
    attributes: PAGE_ATTRIBUTES,
  });
  const stats = builder.sampleStatistics(
    pages,
    { status: builder.slot(pages, "attribute:page.report.status") },
    builder.slot(pages, "attribute:page.report.durationMs"),
    [{ name: "p50", percentile: 50 }],
  );
  builder.output("stats", stats, [
    { name: "status", slot: "status" },
    { name: "samples", slot: "samples" },
    { name: "avg", slot: "avg" },
    { name: "p50", slot: "p50" },
  ]);
  return {
    plan: builder.finish(),
    id: stats.id,
    slots: stats.slots,
    pagesSlots: pages.slots,
  };
}

describe("relational lowerer defensive guards", () => {
  it("requires at least one output", () => {
    const { plan } = aggregatePlan();
    expect(() => lowerer(plan).lowerMany([])).toThrow(
      "At least one Logical output is required.",
    );
  });

  it("rejects a second analytics qualification admission policy", () => {
    const { plan } = aggregatePlan();
    expect(
      () =>
        new AnalyticsLogicalToDbLowerer(
          plan,
          { siteId: SITE, time: plan.context.time },
          {
            eventQualificationAdmissionPolicy: {} as never,
            analyticsQualificationAdmissionPolicy: {} as never,
          },
        ),
    ).toThrow(
      "Only one analytics qualification admission policy may be supplied.",
    );
  });

  it("rejects an unusable comparison admission binding", () => {
    const { plan } = aggregatePlan();
    expect(
      () =>
        new AnalyticsLogicalToDbLowerer(
          plan,
          { siteId: SITE, time: plan.context.time },
          {
            comparisonDomainAdmissionBinding: {
              attach: () => false,
            } as never,
          },
        ),
    ).toThrow(
      "The comparison admission binding must be unused and target this exact frozen plan.",
    );
  });

  it("rejects a conflicting storage site context", () => {
    const { plan } = aggregatePlan();
    expect(
      () =>
        new AnalyticsLogicalToDbLowerer(plan, {
          siteId: SITE,
          siteIds: [SITE],
          time: plan.context.time,
        } as never),
    ).toThrow("analytics_relational_site_context_requires_siteId_or_siteIds");
  });

  it("rechecks Aggregate group and measure output metadata", () => {
    const { plan, id } = aggregatePlan();
    const node = plan.nodes.find((candidate) => candidate.id === id)!;
    if (node.kind !== "aggregate") throw new Error("expected_aggregate");

    const group = node.groups[0]!.slot;
    expect(() =>
      lower(
        withSlot(plan, group, { type: { kind: "scalar", scalar: "number" } }),
      ),
    ).toThrow(
      "Group output metadata must match its scalar or bucket expression.",
    );
    expect(() => lower(withSlot(plan, group, { nullable: true }))).toThrow(
      "Group output metadata must match its scalar or bucket expression.",
    );

    const measure = node.measures[0]!.output;
    expect(() =>
      lower(
        withSlot(plan, measure, { type: { kind: "scalar", scalar: "string" } }),
      ),
    ).toThrow("Aggregate output metadata must match its Logical measure.");
  });

  it("rechecks Sample Statistics group, value and percentile metadata", () => {
    const { plan, id } = sampleStatisticsPlan();
    const node = plan.nodes.find((candidate) => candidate.id === id)!;
    if (node.kind !== "sample-statistics")
      throw new Error("expected_sample_statistics");

    const group = node.groups[0]!.slot;
    expect(() =>
      lower(
        withSlot(plan, group, { type: { kind: "scalar", scalar: "number" } }),
      ),
    ).toThrow("Sample statistics group metadata must match its expression.");

    const percentile = node.percentiles[0]!.output;
    expect(() =>
      lower(withSlot(plan, percentile, { nullable: false })),
    ).toThrow(
      "Quantile output metadata must preserve the numeric input type and be nullable.",
    );
  });

  it("rejects Distinct without visible keys", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      temporalDomain: "read",
      attributes: PAGE_ATTRIBUTES,
    });
    const distinct = builder.distinct(pages, [
      { input: "attribute:page.report.status" },
    ]);
    builder.output("distinct", distinct, [
      { name: "status", slot: "attribute:page.report.status" },
    ]);
    const plan = builder.finish();
    expect(() =>
      lower(
        withNode(plan, distinct.id, (node) =>
          node.kind === "distinct" ? { ...node, keys: [] } : node,
        ),
      ),
    ).toThrow("Distinct requires at least one visible key.");
  });
});

describe("observation identity lineage for relationship lookups", () => {
  type Wrap = (
    builder: LogicalPlanBuilder,
    base: ReturnType<LogicalPlanBuilder["source"]>,
  ) => ReturnType<LogicalPlanBuilder["source"]>;

  function lookupSql(wrap: Wrap): string {
    const builder = createBuilder();
    const observations = builder.source("observation", {
      temporalDomain: "candidate",
    });
    const wrapped = wrap(builder, observations);
    const lookedUp = builder.relationshipLookup(wrapped, "observation.session");
    builder.output("lookup", lookedUp, [
      { name: "entity", slot: "entity" },
      { name: "session", slot: "relationship:observation.session" },
    ]);
    const plan = builder.finish();
    const instance = lowerer(plan);
    const output = plan.outputs[0]!;
    const lowered = instance.lower(output);
    const relation = instance.projectOutput(lowered, [
      { name: "session", slot: output.fields[1]!.slot, component: 1 },
    ]);
    return compileD1Query(relation).sql;
  }

  it("accepts identities preserved through limit and set operations", () => {
    const limited = lookupSql((builder, base) => builder.limit(base, 3));
    expect(limited).toContain("LIMIT");
    const union = lookupSql((builder, base) =>
      builder.setOperation("union", [
        base,
        builder.source("observation", { temporalDomain: "candidate" }),
      ]),
    );
    expect(union).toContain("UNION");
  });

  it("accepts identities preserved through a prior relationship lookup", () => {
    const sql = lookupSql((builder, base) =>
      builder.relationshipLookup(base, "observation.visitor"),
    );
    expect(sql).toContain("visitor_id");
  });

  it("accepts identities preserved through membership joins", () => {
    for (const kind of ["semiJoin", "antiJoin"] as const) {
      const sql = lookupSql((builder, base) =>
        builder[kind](
          base,
          builder.source("observation", { temporalDomain: "candidate" }),
          [{ left: "entity", right: "entity" }],
        ),
      );
      expect(sql).toContain(kind === "semiJoin" ? "EXISTS" : "NOT EXISTS");
    }
  });
});

describe("expression lowering defensive guards", () => {
  type Expr = Record<string, unknown> & { readonly kind: string };

  function forged(
    build: (
      builder: LogicalPlanBuilder,
      pages: ReturnType<LogicalPlanBuilder["source"]>,
    ) => ReturnType<LogicalPlanBuilder["slot"]>,
    forge: (original: Expr, slots: Record<string, Expr>) => Expr,
  ): ValidatedLogicalPlan {
    const builder = createBuilder();
    const pages = builder.source("page", {
      temporalDomain: "read",
      attributes: PAGE_ATTRIBUTES,
    });
    const projected = builder.project(pages, { out: build(builder, pages) });
    builder.output("projected", projected, [{ name: "out", slot: "out" }]);
    const plan = builder.finish();
    return {
      ...plan,
      nodes: plan.nodes.map((node) =>
        node.kind === "project"
          ? {
              ...node,
              projections: node.projections.map((projection) =>
                (projection.expression as unknown as Expr).kind === "slot"
                  ? projection
                  : {
                      ...projection,
                      expression: forge(
                        projection.expression as unknown as Expr,
                        {
                          status: builder.slot(
                            pages,
                            "attribute:page.report.status",
                          ).expression as unknown as Expr,
                        },
                      ),
                    },
              ),
            }
          : node,
      ),
    } as ValidatedLogicalPlan;
  }

  const status = (builder: LogicalPlanBuilder, pages: Pages) =>
    builder.slot(pages, "attribute:page.report.status");
  const duration = (builder: LogicalPlanBuilder, pages: Pages) =>
    builder.slot(pages, "attribute:page.report.durationMs");

  it("rejects malformed text concatenation", () => {
    const build = (b: LogicalPlanBuilder, pages: Pages) =>
      b.concatText(status(b, pages), status(b, pages));
    expect(() =>
      lower(
        forged(build, (e) => ({
          ...e,
          values: (e.values as Expr[]).slice(0, 1),
        })),
      ),
    ).toThrow("Text concatenation requires at least two operands.");
    expect(() =>
      lower(
        forged(build, (e) => ({
          ...e,
          values: [
            (e.values as Expr[])[0],
            {
              kind: "literal",
              value: 1,
              valueType: { kind: "scalar", scalar: "number" },
            },
          ],
        })),
      ),
    ).toThrow("Text concatenation accepts only scalar strings.");
  });

  it("rejects forged report number text semantics", () => {
    const build = (b: LogicalPlanBuilder, pages: Pages) =>
      b.reportNumberText(duration(b, pages));
    expect(() =>
      lower(forged(build, (e) => ({ ...e, semantics: "other-v1" }))),
    ).toThrow("Legacy report number text requires a unitless numeric scalar.");
  });

  it("rejects forged arithmetic operators, divisions and operands", () => {
    const build = (b: LogicalPlanBuilder, pages: Pages) =>
      b.arithmetic("divide", duration(b, pages), duration(b, pages));
    expect(() =>
      lower(forged(build, (e) => ({ ...e, operator: "modulo" }))),
    ).toThrow("The arithmetic operator is unsupported.");
    expect(() =>
      lower(forged(build, (e) => ({ ...e, zeroDenominator: undefined }))),
    ).toThrow("Division must map a zero denominator to NULL.");
    expect(() =>
      lower(
        forged(build, (e) => ({
          ...e,
          left: { kind: "slot", slot: 987_654 },
        })),
      ),
    ).toThrow("Arithmetic references a hidden Logical slot.");
    expect(() =>
      lower(
        forged(build, (e) => ({
          ...e,
          right: {
            kind: "literal",
            value: "x",
            valueType: { kind: "scalar", scalar: "string" },
          },
        })),
      ),
    ).toThrow("Arithmetic operand type or unit is unsupported.");
  });

  it("rejects elapsed durations that overflow epoch milliseconds", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      temporalDomain: "read",
      attributes: ["page.report.startedAt"],
    });
    const started = builder.slot(pages, "attribute:page.report.startedAt");
    const plus = builder.arithmetic(
      "add",
      started,
      builder.elapsedDuration(1, "w"),
    );
    const projected = builder.project(pages, { out: plus });
    builder.output("projected", projected, [{ name: "out", slot: "out" }]);
    const plan = withNode(builder.finish(), projected.id, (node) =>
      node.kind === "project"
        ? {
            ...node,
            projections: node.projections.map((projection) => ({
              ...projection,
              expression: {
                ...(projection.expression as unknown as Expr),
                right: {
                  kind: "elapsed-duration-literal",
                  amount: Number.MAX_VALUE,
                  unit: "w",
                },
              },
            })) as never,
          }
        : node,
    );
    expect(() => lower(plan)).toThrow(
      "Elapsed duration is outside finite epoch milliseconds.",
    );
  });

  it("rejects non-numeric ROUND and numeric-value inputs", () => {
    const rounded = (b: LogicalPlanBuilder, pages: Pages) =>
      b.round(duration(b, pages));
    expect(() =>
      lower(
        forged(rounded, (e) => ({
          ...e,
          input: { kind: "slot", slot: 987_654 },
        })),
      ),
    ).toThrow();
  });

  it("rejects unsupported string normalization on comparisons", () => {
    const builder = createBuilder();
    const pages = builder.source("page", {
      temporalDomain: "read",
      attributes: PAGE_ATTRIBUTES,
    });
    const filtered = builder.filter(
      pages,
      builder.compare(
        "eq",
        builder.slot(pages, "attribute:page.report.status"),
        builder.literal("open", { kind: "scalar", scalar: "string" }),
      ),
    );
    builder.output("filtered", filtered, [
      { name: "localId", slot: "attribute:page.report.localId" },
    ]);
    const plan = builder.finish();
    for (const normalization of ["trim-case-fold", "bogus"]) {
      const mutated = withNode(plan, filtered.id, (node) =>
        node.kind === "filter"
          ? ({
              ...node,
              predicate: {
                ...(node.predicate as unknown as Expr),
                stringNormalization: normalization,
              },
            } as never)
          : node,
      );
      expect(() => lower(mutated)).toThrow(
        "This adapter does not support case-fold normalization.",
      );
    }
  });
});
