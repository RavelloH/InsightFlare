import type {
  EpochMs,
  ReportingTimeZone,
  TimeRange,
} from "@/lib/edge/analytics/contract/types";
import {
  ADVANCED_FILTER_ACTIVITY_LIMIT,
  eligibleAdvancedFilterActivities,
} from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import {
  type LogicalExpressionHandle,
  LogicalPlanBuilder,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { registeredFieldLeafPredicateExpression } from "@/lib/edge/analytics/engine/registered-field-leaf";
import { advancedCountSelectorField } from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterExpression } from "@/lib/filter-contract/filters";

import {
  assertSequenceProof,
  type SequenceStep,
  type SupportedSequence,
} from "./advanced-filter-sequence-support";

export interface SequencePlanInput {
  readonly subject: SemanticSubjectDomain;
  readonly support: SupportedSequence;
  readonly range: TimeRange;
  readonly reportingTimeZone: ReportingTimeZone;
  readonly capturedAtMs: EpochMs;
}
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const STRING = { kind: "scalar", scalar: "string" } as const;
function builderFor(input: SequencePlanInput): LogicalPlanBuilder {
  assertSequenceProof(input.support);
  const candidate = input.support.windowCandidateRange;
  if (
    candidate &&
    (candidate.startMs !== input.range.startMs ||
      candidate.endExclusiveMs !== input.range.endExclusiveMs)
  )
    throw new Error("sequence_sql_window_context_changed");
  return new LogicalPlanBuilder({
    subject: input.subject,
    scope: resolveAnalyticsScope(input.support.scope),
    time: createSemanticTemporalDomains({
      candidate: input.range,
      read: { kind: "bounded", range: input.range },
      reportingTimeZone: input.reportingTimeZone,
      capturedAtMs: input.capturedAtMs,
    }),
  });
}
function attributes(input: SequencePlanInput): string[] {
  const fields = new Set([
    "observation.kind",
    "observation.id",
    "observation.rawSiteId",
    "observation.siteIdentityConsistent",
    "observation.sameSiteEventName",
    `observation.${input.support.scope}Id`,
  ]);
  const visit = (expression: FilterExpression): void => {
    if (expression.kind === "not") visit(expression.child);
    else if (expression.kind === "and" || expression.kind === "or")
      expression.children.forEach(visit);
    else if (
      expression.kind === "condition" &&
      expression.target.kind === "field"
    ) {
      const field = advancedCountSelectorField(expression.target.field);
      if (!field || field.kind !== "string")
        throw new Error("sequence_sql_unchecked_field");
      fields.add(field.valueAttribute);
      fields.add(field.stringClassAttribute);
    }
  };
  for (const step of input.support.steps)
    if (step.predicate) visit(step.predicate);
  return [...fields];
}
function predicate(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
  expression: FilterExpression,
  kind: "page" | "event",
): LogicalExpressionHandle {
  if (expression.kind === "not")
    return builder.not(predicate(builder, rows, expression.child, kind));
  if (expression.kind === "and" || expression.kind === "or")
    return builder[expression.kind](
      ...expression.children.map((child) =>
        predicate(builder, rows, child, kind),
      ),
    );
  if (expression.kind !== "condition")
    throw new Error("sequence_sql_predicate_unchecked");
  return registeredFieldLeafPredicateExpression(
    builder,
    rows,
    expression,
    kind,
  );
}
function stepPredicate(
  builder: LogicalPlanBuilder,
  rows: LogicalRelationHandle,
  input: SequencePlanInput,
  step: SequenceStep,
): LogicalExpressionHandle {
  const identity = builder.slot(
    rows,
    `attribute:observation.${input.support.scope}Id`,
  );
  const filters = [
    builder.compare(
      "eq",
      builder.slot(rows, "attribute:observation.kind"),
      builder.literal(step.kind, STRING),
    ),
    builder.isNull(identity, true),
    builder.compare("neq", identity, builder.literal("", STRING)),
  ];
  if (step.predicate)
    filters.push(predicate(builder, rows, step.predicate, step.kind));
  if (step.window) {
    const datetime = { kind: "scalar", scalar: "datetime" } as const;
    filters.push(
      builder.compare(
        "gte",
        builder.slot(rows, "time"),
        builder.literal(step.window.startMs, datetime),
      ),
      builder.compare(
        "lt",
        builder.slot(rows, "time"),
        builder.literal(step.window.endExclusiveMs, datetime),
      ),
    );
  }
  return builder.and(...filters);
}

function output(
  builder: LogicalPlanBuilder,
  id: string,
  rows: LogicalRelationHandle,
  names: readonly string[],
): void {
  builder.output(
    id,
    rows,
    names.map((name) => ({ name, slot: name })),
  );
}
/** One source pass, one per-entity aggregate. Canonical storage is proven by
 * an explicit semantic source fact, not declared column affinity. */
export function buildSequenceAggregateEnvelope(
  input: SequencePlanInput,
): ValidatedLogicalPlan {
  const builder = builderFor(input),
    guard = `observation.${input.support.scope}OrderCanonical`;
  const sourceRows = eligibleAdvancedFilterActivities(
    builder,
    builder.source("observation", {
      temporalDomain: "candidate",
      attributes: [...attributes(input), guard],
      includeOccurrenceTime: true,
    }),
  );
  const rows = builder.limit(sourceRows, ADVANCED_FILTER_ACTIVITY_LIMIT);
  const zero = builder.literal(0, NUMBER),
    one = builder.literal(1, NUMBER),
    nullTime = builder.literal(null, { kind: "scalar", scalar: "datetime" });
  const indicator = (condition: LogicalExpressionHandle) =>
    builder.caseWhen([{ when: condition, then: one }], zero);
  const first = stepPredicate(builder, rows, input, input.support.steps[0]),
    second = stepPredicate(builder, rows, input, input.support.steps[1]);
  const selectedTime = (condition: LogicalExpressionHandle) =>
    builder.caseWhen(
      [{ when: condition, then: builder.slot(rows, "time") }],
      nullTime,
    );
  const canonical = builder.and(
    builder.slot(rows, `attribute:${guard}`),
    builder.slot(rows, "attribute:observation.siteIdentityConsistent"),
  );
  const grouped = builder.aggregate(
    rows,
    {
      siteId: builder.slot(rows, "attribute:observation.rawSiteId"),
      entityId: builder.slot(
        rows,
        `attribute:observation.${input.support.scope}Id`,
      ),
    },
    [
      { name: "rawCount", kind: "count-rows" },
      { name: "canonical", kind: "min", expression: indicator(canonical) },
      { name: "firstCount", kind: "sum", expression: indicator(first) },
      { name: "secondCount", kind: "sum", expression: indicator(second) },
      { name: "firstTime", kind: "min", expression: selectedTime(first) },
      { name: "secondTime", kind: "max", expression: selectedTime(second) },
      {
        name: "participatingTimes",
        kind: "count-distinct",
        expression: selectedTime(builder.or(first, second)),
      },
      {
        name: "firstTimes",
        kind: "count-distinct",
        expression: selectedTime(first),
      },
      {
        name: "secondTimes",
        kind: "count-distinct",
        expression: selectedTime(second),
      },
    ],
  );
  const [firstStep, secondStep] = input.support.steps;
  const ordered = builder.or(
    builder.compare(
      "lt",
      builder.slot(grouped, "firstTime"),
      builder.slot(grouped, "secondTime"),
    ),
    builder.and(
      builder.compare(
        "eq",
        builder.slot(grouped, "firstTime"),
        builder.slot(grouped, "secondTime"),
      ),
      builder.compare(
        "lt",
        builder.literal(firstStep.kind === "page" ? 0 : 1, NUMBER),
        builder.literal(secondStep.kind === "page" ? 0 : 1, NUMBER),
      ),
    ),
  );
  const fields = [
    "siteId",
    "entityId",
    "rawCount",
    "canonical",
    "firstCount",
    "secondCount",
    "participatingTimes",
    "firstTimes",
    "secondTimes",
  ];
  const canonicalGroup = builder.compare(
    "eq",
    builder.slot(grouped, "canonical"),
    one,
  );
  const projected = builder.project(
    grouped,
    Object.fromEntries([
      ...fields.map((name) => [
        name,
        name === "siteId" || name === "entityId"
          ? builder.caseWhen(
              [{ when: canonicalGroup, then: builder.slot(grouped, name) }],
              builder.literal(null, STRING),
            )
          : builder.slot(grouped, name),
      ]),
      ["matches", indicator(ordered)],
    ]),
  );
  output(builder, "sequence-aggregate-envelope", projected, [
    ...fields,
    "matches",
  ]);
  return builder.finish();
}
