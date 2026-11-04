import { describe, expect, it } from "vitest";

import {
  type LogicalPlan,
  LogicalPlanBuilder,
  remapGrain,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine/logical";
import { slotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";
import { LogicalPlanError } from "@/lib/edge/analytics/engine/logical/validator";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

function createBuilder(): LogicalPlanBuilder {
  const candidate = { startMs: 0 as never, endExclusiveMs: 1_000 as never };
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: ["logical-safety-site" as never],
    }),
    time: createSemanticTemporalDomains({
      candidate,
      read: { kind: "bounded", range: candidate },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 1_000 as never,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

function expectIssue(plan: LogicalPlan, code: string, path: string): void {
  try {
    validateLogicalPlan(plan);
  } catch (error) {
    if (!(error instanceof LogicalPlanError)) throw error;
    expect(error.issues).toContainEqual(
      expect.objectContaining({ code, path }),
    );
    return;
  }
  throw new Error(`Expected LogicalPlanError at ${path}.`);
}

describe("Analytics logical safety contracts", () => {
  it("remaps entity and keyed grain keys without changing cardinality shape", () => {
    const first = slotId(11);
    const second = slotId(12);
    const mappedFirst = slotId(21);
    const mappedSecond = slotId(22);
    const mapping = new Map([
      [first, mappedFirst],
      [second, mappedSecond],
    ]);

    expect(
      remapGrain({ kind: "entity", entity: "event", key: first }, mapping),
    ).toEqual({ kind: "entity", entity: "event", key: mappedFirst });
    expect(
      remapGrain({ kind: "keyed", keys: [first, second] }, mapping),
    ).toEqual({ kind: "keyed", keys: [mappedFirst, mappedSecond] });
    expect(remapGrain({ kind: "scalar" }, mapping)).toEqual({
      kind: "scalar",
    });
    expect(remapGrain({ kind: "bag" }, mapping)).toEqual({ kind: "bag" });
    expect(() =>
      remapGrain({ kind: "entity", entity: "page", key: first }, new Map()),
    ).toThrow("logical_grain_key_not_mapped");
    expect(() =>
      remapGrain(
        { kind: "keyed", keys: [first, second] },
        new Map([[first, mappedFirst]]),
      ),
    ).toThrow("logical_grain_key_not_mapped");
  });

  it("keeps grouped grain keys visible and remaps them through projections", () => {
    const builder = createBuilder();
    const pages = builder.source("page", { attributes: ["geo.country"] });
    const grouped = builder.aggregate(
      pages,
      { country: builder.slot(pages, "attribute:geo.country") },
      [{ name: "views", kind: "count-rows" }],
    );
    const renamed = builder.project(grouped, {
      countryCode: builder.slot(grouped, "country"),
      views: builder.slot(grouped, "views"),
    });
    builder.output("country-views", renamed, [
      {
        name: "country",
        slot: "countryCode",
        semantic: { kind: "dimension", id: "geo.country" },
      },
      {
        name: "views",
        slot: "views",
        semantic: { kind: "metric", id: "views" },
      },
    ]);

    const plan = builder.finish();
    expect(grouped.grain).toEqual({
      kind: "keyed",
      keys: [grouped.slots.country],
    });
    expect(renamed.grain).toEqual({
      kind: "keyed",
      keys: [renamed.slots.countryCode],
    });
    if (grouped.grain.kind !== "keyed" || renamed.grain.kind !== "keyed") {
      throw new Error("projected_group_grain_missing_key");
    }
    expect(renamed.grain.keys[0]).not.toBe(grouped.grain.keys[0]);
    expect(validateLogicalPlan(plan)).toEqual(plan);
  });

  it("allows public metric labels and rejects private, unknown, or mistyped labels", () => {
    type ScalarValueType = Extract<LogicalValueType, { kind: "scalar" }>;
    const createMetricPlan = (valueType: ScalarValueType): LogicalPlan => {
      const builder = createBuilder();
      const pages = builder.source("page");
      const value = builder.project(pages, {
        value: builder.literal(1, valueType),
      });
      builder.output("metric", value, [{ name: "value", slot: "value" }]);
      return builder.finish();
    };

    const withMetric = (plan: LogicalPlan, id: string): LogicalPlan => ({
      ...plan,
      outputs: plan.outputs.map((output) => ({
        ...output,
        fields: output.fields.map((field) => ({
          ...field,
          semantic: { kind: "metric" as const, id: id as never },
        })),
      })),
    });

    const valid = withMetric(
      createMetricPlan({ kind: "scalar", scalar: "number" }),
      "views",
    );
    expect(validateLogicalPlan(valid)).toEqual(valid);

    const privateMetric = withMetric(valid, "totalDurationMs");
    expectIssue(
      privateMetric,
      "invalid-output",
      "outputs[0].fields[0].semantic.id",
    );

    const unknownMetric = withMetric(valid, "futureMetric");
    expectIssue(
      unknownMetric,
      "invalid-output",
      "outputs[0].fields[0].semantic.id",
    );

    const mistypedPublicMetric = withMetric(
      createMetricPlan({
        kind: "scalar",
        scalar: "number",
        unit: "ms",
      }),
      "views",
    );
    expectIssue(
      mistypedPublicMetric,
      "invalid-output",
      "outputs[0].fields[0].slot",
    );
  });
});
