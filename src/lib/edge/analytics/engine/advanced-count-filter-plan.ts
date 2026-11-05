import type { EpochMs, TimeRange } from "@/lib/edge/analytics/contract/types";
import {
  advancedCountPayloadPaths,
  advancedCountRegisteredStringLiteralsAreAscii,
} from "@/lib/edge/analytics/engine/advanced-count-payload-selector";
import type {
  LogicalExpressionHandle,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  type AdvancedFilterNumericCompatibilityDomain,
  type AdvancedFilterNumericCompatibilityRequirement,
  deriveAdvancedFilterNumericCompatibilityRequirements,
} from "@/lib/edge/analytics/engine/semantic/advanced-filter-field-requirements";
import { semanticAttribute } from "@/lib/edge/analytics/engine/semantic/attributes";
import {
  type CountBareField,
  countBareField,
  isQualifiedGeoBareField,
  type QualifiedGeoComparisonProvenance,
  type QualifiedGeoRawCountEligibilityWitness,
} from "@/lib/edge/analytics/engine/semantic/count-bare-fields";
import {
  type AdvancedCountFiniteCollection,
  type AdvancedCountScalarField,
  advancedCountScalarFieldKey,
  resolveAdvancedCountFiniteCollection,
  resolveAdvancedCountScalarField,
} from "@/lib/edge/analytics/engine/semantic/count-scalar-fields";
import {
  type AdvancedCountNumberSelectorField,
  type AdvancedCountSelectorCollection,
  type AdvancedCountSelectorField,
  advancedCountSelectorField,
  advancedCountSelectorNeedsStringClass,
  advancedCountSelectorRequiresSafeRange,
} from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { snapshotEventPayloadTopLevelPaths } from "@/lib/edge/analytics/engine/semantic/event-payload-logical";
import {
  sameSemanticSubjectDomain,
  type SemanticSubjectDomain,
} from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import type { AnalyzedFilterDocument } from "@/lib/filter-contract/filter-semantics";
import type {
  FilterCondition,
  FilterExpression,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

import {
  ADVANCED_FILTER_ACTIVITY_LIMIT,
  ADVANCED_FILTER_MAX_ACTIVITIES,
  eligibleAdvancedFilterActivities,
} from "./advanced-filter-activity-plan";
import {
  type QualifiedGeoBareLeafCreation,
  registeredFieldLeafPredicateExpression as sharedRegisteredFieldLeafPredicateExpression,
} from "./registered-field-leaf";

const GUARDED_ACTIVITY_OUTPUT = "advanced-filter-count-guard";
const MATCHED_IDENTITY_OUTPUT = "advanced-filter-count-matches";
const COMBINED_COUNT_OUTPUT = "advanced-filter-count-combined";
const PAYLOAD_COMBINED_GUARD_OUTPUT =
  "advanced-filter-count-payload-combined-guard";
const PAYLOAD_COMBINED_SCOPE_OUTPUT =
  "advanced-filter-count-payload-combined-scope";
const COUNT_ATTRIBUTES = [
  "observation.kind",
  "observation.sameSiteEventName",
  "observation.rawSiteId",
] as const;

export interface AdvancedCountFilterSiteLowerBound {
  readonly siteId: string;
  readonly startMs: number;
}

type AdvancedCountNumericCompatibilityRequirement =
  AdvancedFilterNumericCompatibilityRequirement;

function checkedNumericCompatibilityRequirements(
  requirements: readonly AdvancedCountNumericCompatibilityRequirement[],
): readonly AdvancedCountNumericCompatibilityRequirement[] {
  const seen = new Set<string>();
  const normalized = requirements.map((requirement) => {
    const field = advancedCountSelectorField(requirement.fieldId);
    if (
      !field ||
      field.kind !== "number" ||
      (requirement.domain !== "page-only" &&
        requirement.domain !== "page-and-event") ||
      (requirement.proof !== undefined &&
        requirement.proof !== "safe-number" &&
        requirement.proof !== "exact-aggregate") ||
      seen.has(requirement.fieldId)
    )
      throw new Error(
        "advanced_count_plan_received_invalid_numeric_compatibility_requirement",
      );
    seen.add(requirement.fieldId);
    return {
      fieldId: field.fieldId,
      domain: requirement.domain,
      ...(requirement.proof === "exact-aggregate"
        ? { proof: requirement.proof }
        : {}),
    };
  });
  return normalized.sort((left, right) =>
    left.fieldId.localeCompare(right.fieldId),
  );
}

function matchNumericCompatibilityRequirements(input: {
  readonly root: FilterExpression;
  readonly numericCompatibilityRequirements?: readonly AdvancedCountNumericCompatibilityRequirement[];
  readonly numericCompatibilityFieldIds?: readonly string[];
}): readonly AdvancedCountNumericCompatibilityRequirement[] {
  const derived = deriveAdvancedFilterNumericCompatibilityRequirements(
    input.root,
  );
  if (input.numericCompatibilityRequirements !== undefined) {
    const provided = checkedNumericCompatibilityRequirements(
      input.numericCompatibilityRequirements,
    );
    if (JSON.stringify(provided) !== JSON.stringify(derived))
      throw new Error(
        "advanced_count_match_numeric_compatibility_requirements_mismatch",
      );
  }
  if (input.numericCompatibilityFieldIds !== undefined) {
    const provided = [...input.numericCompatibilityFieldIds].sort();
    if (
      new Set(provided).size !== provided.length ||
      JSON.stringify(provided) !==
        JSON.stringify(derived.map(({ fieldId }) => fieldId))
    )
      throw new Error(
        "advanced_count_match_numeric_compatibility_fields_mismatch",
      );
  }
  return derived;
}

function epochRange(range: {
  readonly startMs: number;
  readonly endExclusiveMs: number;
}): TimeRange {
  return {
    startMs: range.startMs as EpochMs,
    endExclusiveMs: range.endExclusiveMs as EpochMs,
  };
}

function builderFor(input: {
  readonly subject: SemanticSubjectDomain;
  readonly candidateRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly readRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly filterRange?: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly reportingTimeZone: string;
  readonly capturedAtMs: number;
  readonly scope: "session" | "visitor" | "event";
}): LogicalPlanBuilder {
  const candidate = epochRange(input.candidateRange);
  const read = epochRange(input.readRange);
  const filter = input.filterRange ? epochRange(input.filterRange) : undefined;
  return new LogicalPlanBuilder({
    subject: input.subject,
    time: createSemanticTemporalDomains({
      candidate,
      read: { kind: "bounded", range: read },
      ...(filter ? { filter } : {}),
      reportingTimeZone: input.reportingTimeZone as never,
      capturedAtMs: input.capturedAtMs as EpochMs,
    }),
    scope: resolveAnalyticsScope(input.scope),
  });
}

function observationSource(
  builder: LogicalPlanBuilder,
  temporalDomain: "candidate" | "filter" | "read",
  scope?: "session" | "visitor",
  includeId = false,
  selectorAttributes: readonly string[] = [],
) {
  return builder.source("observation", {
    temporalDomain,
    attributes: [
      ...COUNT_ATTRIBUTES,
      ...selectorAttributes,
      ...(includeId ? ["observation.id"] : []),
      ...(scope ? [`observation.${scope}Id`] : []),
    ],
    includeOccurrenceTime: true,
  });
}

/**
 * A bounded scalar gate over the exact eligible activity union. The SQL
 * LIMIT makes the result saturate at 20,001 while retaining a NULL-id flag.
 */
export function buildAdvancedCountFilterGuardPlan(input: {
  readonly subject: SemanticSubjectDomain;
  readonly range: { readonly startMs: number; readonly endExclusiveMs: number };
  readonly reportingTimeZone: string;
  readonly numericCompatibilityFieldIds?: readonly string[];
  readonly numericCompatibilityRequirements?: readonly AdvancedCountNumericCompatibilityRequirement[];
}): ValidatedLogicalPlan {
  if (
    !Number.isSafeInteger(input.range.startMs) ||
    !Number.isSafeInteger(input.range.endExclusiveMs) ||
    input.range.startMs >= input.range.endExclusiveMs
  )
    throw new Error("advanced_filter_count_guard_invalid_range");
  const builder = builderFor({
    subject: input.subject,
    candidateRange: input.range,
    readRange: input.range,
    reportingTimeZone: input.reportingTimeZone,
    capturedAtMs: input.range.endExclusiveMs - 1,
    scope: "session",
  });
  const numericRequirements = checkedNumericCompatibilityRequirements(
    input.numericCompatibilityRequirements ??
      (input.numericCompatibilityFieldIds ?? []).map((fieldId) => ({
        fieldId,
        domain: "page-only" as const,
      })),
  );
  if (
    input.numericCompatibilityRequirements !== undefined &&
    input.numericCompatibilityFieldIds !== undefined &&
    JSON.stringify([...input.numericCompatibilityFieldIds].sort()) !==
      JSON.stringify(numericRequirements.map(({ fieldId }) => fieldId))
  )
    throw new Error(
      "advanced_count_guard_numeric_compatibility_fields_mismatch",
    );
  const numericFields = numericRequirements.map((requirement) => {
    const field = advancedCountSelectorField(requirement.fieldId);
    if (!field || field.kind !== "number")
      throw new Error("advanced_count_guard_received_unchecked_numeric_field");
    return {
      field,
      domain: requirement.domain,
      proof: requirement.proof ?? "safe-number",
    };
  });
  const source = builder.source("observation", {
    temporalDomain: "candidate",
    attributes: [
      ...COUNT_ATTRIBUTES,
      "observation.siteIdentityConsistent",
      "observation.id",
      ...numericFields.flatMap(({ field, proof }) => [
        field.valueAttribute,
        proof === "exact-aggregate"
          ? field.exactAggregateAttribute
          : field.safeRangeAttribute,
      ]),
    ],
    includeOccurrenceTime: true,
  });
  const eligible = eligibleAdvancedFilterActivities(builder, source);
  const capped = builder.limit(eligible, ADVANCED_FILTER_ACTIVITY_LIMIT);
  const numeric = (value: number) =>
    builder.literal(value, { kind: "scalar", scalar: "number" });
  const missingIdentity = builder.caseWhen(
    [
      {
        when: builder.isNull(builder.slot(capped, "attribute:observation.id")),
        then: numeric(1),
      },
    ],
    numeric(0),
  );
  const mismatchedSiteIdentity = builder.caseWhen(
    [
      {
        when: builder.not(
          builder.slot(capped, "attribute:observation.siteIdentityConsistent"),
        ),
        then: numeric(1),
      },
    ],
    numeric(0),
  );
  const isPage = builder.compare(
    "eq",
    builder.slot(capped, "attribute:observation.kind"),
    builder.literal("page", { kind: "scalar", scalar: "string" }),
  );
  const isEvent = builder.compare(
    "eq",
    builder.slot(capped, "attribute:observation.kind"),
    builder.literal("event", { kind: "scalar", scalar: "string" }),
  );
  const invalidNumericFieldCounts = numericFields.map(
    ({ field, domain, proof }) => {
      const rawValue = builder.slot(
        capped,
        `attribute:${field.valueAttribute}`,
      );
      const validRange = builder.slot(
        capped,
        `attribute:${proof === "exact-aggregate" ? field.exactAggregateAttribute : field.safeRangeAttribute}`,
      );
      return {
        name: field.invalidCountOutput,
        kind: "sum" as const,
        expression: builder.caseWhen(
          [
            {
              when: builder.and(
                domain === "page-only" ? isPage : builder.or(isPage, isEvent),
                builder.isNull(rawValue, true),
                builder.not(validRange),
              ),
              then: numeric(1),
            },
          ],
          numeric(0),
        ),
      };
    },
  );
  const totals = builder.aggregate(capped, {}, [
    { name: "rawCount", kind: "count-rows" },
    { name: "nullActivityIdCount", kind: "sum", expression: missingIdentity },
    {
      name: "siteIdentityMismatchCount",
      kind: "sum",
      expression: mismatchedSiteIdentity,
    },
    ...invalidNumericFieldCounts,
  ]);
  builder.output(GUARDED_ACTIVITY_OUTPUT, totals, [
    { name: "rawCount", slot: "rawCount" },
    { name: "nullActivityIdCount", slot: "nullActivityIdCount" },
    {
      name: "siteIdentityMismatchCount",
      slot: "siteIdentityMismatchCount",
    },
    ...numericFields.map(({ field }) => ({
      name: field.invalidCountOutput,
      slot: field.invalidCountOutput,
    })),
  ]);
  return builder.finish();
}

function addPerSiteLowerBound(
  builder: LogicalPlanBuilder,
  relation: ReturnType<typeof observationSource>,
  lowerBounds: readonly AdvancedCountFilterSiteLowerBound[],
  broadStartMs: number,
): ReturnType<typeof observationSource> {
  if (!lowerBounds.some((bound) => bound.startMs > broadStartMs))
    return relation;
  const siteId = builder.slot(relation, "attribute:observation.rawSiteId");
  const time = builder.slot(relation, "time");
  return builder.filter(
    relation,
    builder.or(
      ...lowerBounds.map((bound) =>
        builder.and(
          builder.compare(
            "eq",
            siteId,
            builder.literal(bound.siteId, {
              kind: "scalar",
              scalar: "string",
            }),
          ),
          builder.compare(
            "gte",
            time,
            builder.literal(bound.startMs, {
              kind: "scalar",
              scalar: "datetime",
            }),
          ),
        ),
      ),
    ),
  );
}

function scopeIdentityAttribute(scope: "session" | "visitor"): string {
  return `attribute:observation.${scope}Id`;
}

function truthyScopeRows(
  builder: LogicalPlanBuilder,
  relation: ReturnType<typeof observationSource>,
  scope: "session" | "visitor",
) {
  const identity = builder.slot(relation, scopeIdentityAttribute(scope));
  return builder.filter(
    relation,
    builder.and(
      builder.isNull(identity, true),
      builder.compare(
        "neq",
        identity,
        builder.literal("", { kind: "scalar", scalar: "string" }),
      ),
    ),
  );
}

interface CountSelectorContribution {
  readonly input: Extract<FilterTargetExpression, { kind: "selector" }>;
  readonly name: string;
}

interface ScalarCollectionContribution {
  readonly input: FilterTargetExpression;
  readonly resolved: AdvancedCountScalarField;
  readonly key: string;
  readonly index: number;
  readonly valueName: string;
  readonly nullMarkerName?: string;
  readonly distinctName?: string;
  readonly minimumName?: string;
  readonly maximumName?: string;
  readonly sumName?: string;
  readonly averageName?: string;
}

function scalarCollectionNullValue(
  builder: LogicalPlanBuilder,
  contribution: ScalarCollectionContribution,
): LogicalExpressionHandle {
  const valueType = semanticAttribute(
    contribution.resolved.field.valueAttribute,
  )?.valueType;
  if (valueType?.kind !== "scalar")
    throw new Error("advanced_count_plan_missing_scalar_value_type");
  return builder.literal(null, valueType);
}

interface BareFieldContribution {
  readonly condition: FilterCondition;
  readonly field: CountBareField;
  readonly name: string;
}

function countSelectorKey(
  input: Extract<FilterTargetExpression, { kind: "selector" }>,
): string {
  return JSON.stringify(input);
}

function countSelectorContributions(
  root: FilterExpression,
): ReadonlyMap<string, CountSelectorContribution> {
  const result = new Map<string, CountSelectorContribution>();
  const addCollection = (collection: AdvancedCountFiniteCollection) => {
    if (collection.kind !== "selector") return;
    const input = collection.selector;
    const key = countSelectorKey(input);
    if (!result.has(key))
      result.set(key, { input, name: `selectorCount${result.size}` });
  };
  const visitTarget = (target: FilterTargetExpression): void => {
    if (target.kind === "arithmetic") {
      visitTarget(target.left);
      visitTarget(target.right);
      return;
    }
    if (target.kind !== "reducer" || target.reducer !== "count") return;
    const collection = resolveAdvancedCountFiniteCollection(target.input);
    if (collection) addCollection(collection);
  };
  const visitExpression = (expression: FilterExpression): void => {
    if (expression.kind === "not") {
      visitExpression(expression.child);
      return;
    }
    if (expression.kind === "and" || expression.kind === "or") {
      expression.children.forEach(visitExpression);
      return;
    }
    if (expression.kind !== "condition") return;
    if (
      expression.target.kind !== "field" &&
      (expression.operator === "exists" || expression.operator === "notExists")
    ) {
      const collection = resolveAdvancedCountFiniteCollection(
        expression.target,
      );
      if (collection) addCollection(collection);
      return;
    }
    visitTarget(expression.target);
  };
  visitExpression(root);
  return result;
}

function scalarCollectionContributions(
  root: FilterExpression,
): ReadonlyMap<string, ScalarCollectionContribution> {
  const result = new Map<string, ScalarCollectionContribution>();
  const visitTarget = (target: FilterTargetExpression): void => {
    if (target.kind === "arithmetic") {
      visitTarget(target.left);
      visitTarget(target.right);
      return;
    }
    if (
      target.kind !== "reducer" ||
      (target.reducer !== "countDistinct" &&
        target.reducer !== "min" &&
        target.reducer !== "max" &&
        target.reducer !== "sum" &&
        target.reducer !== "avg")
    )
      return;
    const resolved = resolveAdvancedCountScalarField(target.input);
    if (!resolved) return;
    const key = advancedCountScalarFieldKey(target.input, resolved);
    const existing = result.get(key);
    const index = existing?.index ?? result.size;
    const contribution =
      existing ??
      ({
        input: target.input,
        resolved,
        key,
        index,
        valueName: `scalarDistinctValue${index}`,
      } satisfies ScalarCollectionContribution);
    result.set(key, {
      ...contribution,
      ...(target.reducer === "countDistinct"
        ? {
            nullMarkerName: `scalarDistinctNullMarker${index}`,
            distinctName:
              contribution.distinctName ?? `scalarDistinctCount${index}`,
          }
        : target.reducer === "min"
          ? {
              minimumName: contribution.minimumName ?? `scalarMinimum${index}`,
            }
          : target.reducer === "max"
            ? {
                maximumName:
                  contribution.maximumName ?? `scalarMaximum${index}`,
              }
            : target.reducer === "sum"
              ? {
                  sumName: contribution.sumName ?? `scalarSum${index}`,
                }
              : {
                  averageName:
                    contribution.averageName ?? `scalarAverage${index}`,
                }),
    });
  };
  const visitExpression = (expression: FilterExpression): void => {
    if (expression.kind === "not") {
      visitExpression(expression.child);
      return;
    }
    if (expression.kind === "and" || expression.kind === "or") {
      expression.children.forEach(visitExpression);
      return;
    }
    if (expression.kind === "condition") visitTarget(expression.target);
  };
  visitExpression(root);
  return result;
}

function bareStringConditionKey(condition: FilterCondition): string {
  return JSON.stringify(condition);
}

function bareFieldContributions(
  root: FilterExpression,
  allowQualifiedGeoBareFields: boolean,
): ReadonlyMap<string, BareFieldContribution> {
  const result = new Map<string, BareFieldContribution>();
  let stringCount = 0;
  let numericCount = 0;
  const visitExpression = (expression: FilterExpression): void => {
    if (expression.kind === "not") {
      visitExpression(expression.child);
      return;
    }
    if (expression.kind === "and" || expression.kind === "or") {
      expression.children.forEach(visitExpression);
      return;
    }
    if (expression.kind !== "condition" || expression.target.kind !== "field")
      return;
    const field = countBareField(
      expression.target.field,
      allowQualifiedGeoBareFields,
    );
    if (!field)
      throw new Error("advanced_count_plan_received_unchecked_bare_field");
    const key = bareStringConditionKey(expression);
    if (!result.has(key)) {
      const suffix = field.kind === "string" ? stringCount++ : numericCount++;
      result.set(key, {
        condition: expression,
        field,
        name: `bare${field.kind === "string" ? "String" : "Numeric"}Contribution${suffix}`,
      });
    }
  };
  visitExpression(root);
  return result;
}

function collectBareFieldAttributes(
  contributions: ReadonlyMap<string, BareFieldContribution>,
  attributes: Set<string>,
): void {
  for (const contribution of contributions.values()) {
    const { condition, field } = contribution;
    if (!(COUNT_ATTRIBUTES as readonly string[]).includes(field.valueAttribute))
      attributes.add(field.valueAttribute);
    if (
      field.kind === "string" &&
      !isQualifiedGeoBareField(field) &&
      advancedCountSelectorNeedsStringClass(field, condition.operator)
    )
      attributes.add(field.stringClassAttribute);
    if (
      field.kind === "number" &&
      advancedCountSelectorRequiresSafeRange(field, condition.operator)
    )
      attributes.add(field.safeRangeAttribute);
  }
}

function collectSelectorPredicateAttributes(
  expression: FilterExpression,
  collection: AdvancedCountSelectorCollection,
  attributes: Set<string>,
): void {
  if (expression.kind === "not")
    return collectSelectorPredicateAttributes(
      expression.child,
      collection,
      attributes,
    );
  if (expression.kind === "and" || expression.kind === "or") {
    expression.children.forEach((child) =>
      collectSelectorPredicateAttributes(child, collection, attributes),
    );
    return;
  }
  if (expression.kind !== "condition")
    throw new Error("advanced_count_plan_received_unchecked_selector");
  if (expression.target.kind === "event-payload") return;
  if (expression.target.kind !== "field")
    throw new Error("advanced_count_plan_received_unchecked_selector");
  const selectorField = advancedCountSelectorField(expression.target.field);
  if (!selectorField || selectorField.collection !== collection)
    throw new Error("advanced_count_plan_received_unchecked_selector_field");
  if (
    !(COUNT_ATTRIBUTES as readonly string[]).includes(
      selectorField.valueAttribute,
    )
  )
    attributes.add(selectorField.valueAttribute);
  if (advancedCountSelectorNeedsStringClass(selectorField, expression.operator))
    attributes.add(selectorField.stringClassAttribute);
  if (
    advancedCountSelectorRequiresSafeRange(selectorField, expression.operator)
  )
    attributes.add(selectorField.safeRangeAttribute);
}

function selectorPredicateExpression(
  builder: LogicalPlanBuilder,
  relation: Parameters<LogicalPlanBuilder["slot"]>[0],
  collection: "page" | "event",
  expression: FilterExpression,
  payloadPathIndexes: ReadonlyMap<string, number>,
): LogicalExpressionHandle {
  if (expression.kind === "not")
    return builder.not(
      selectorPredicateExpression(
        builder,
        relation,
        collection,
        expression.child,
        payloadPathIndexes,
      ),
    );
  if (expression.kind === "and" || expression.kind === "or") {
    const children = expression.children.map((child) =>
      selectorPredicateExpression(
        builder,
        relation,
        collection,
        child,
        payloadPathIndexes,
      ),
    );
    return expression.kind === "and"
      ? builder.and(...children)
      : builder.or(...children);
  }
  if (expression.kind !== "condition")
    throw new Error("advanced_count_plan_received_unchecked_selector");

  if (expression.target.kind === "event-payload") {
    if (collection !== "event")
      throw new Error("advanced_count_plan_received_unchecked_selector");
    const propertyIndex = payloadPathIndexes.get(expression.target.path);
    if (propertyIndex === undefined)
      throw new Error("advanced_count_plan_missing_payload_property");
    return eventPayloadLeafPredicateExpression(
      builder,
      relation,
      expression,
      propertyIndex,
    );
  }
  return registeredFieldLeafPredicateExpression(
    builder,
    relation,
    expression,
    collection,
  );
}

function eventPayloadLeafPredicateExpression(
  builder: LogicalPlanBuilder,
  relation: Parameters<LogicalPlanBuilder["slot"]>[0],
  condition: FilterCondition,
  propertyIndex: number,
): LogicalExpressionHandle {
  if (condition.target.kind !== "event-payload")
    throw new Error("advanced_count_plan_received_unchecked_payload_leaf");
  const slot = (field: string) =>
    builder.slot(relation, `right.payloadProperty${propertyIndex}${field}`);
  const numberType = { kind: "scalar", scalar: "number" } as const;
  const stringType = { kind: "scalar", scalar: "string" } as const;
  const zero = builder.literal(0, numberType);
  const one = builder.literal(1, numberType);
  const present = builder.compare("eq", slot("Present01"), one);
  const valueType = slot("ValueType");
  const stringValue = slot("StringValue");
  const isString = builder.compare("eq", valueType, one);
  const stringDomain = builder.and(present, isString);
  const nonNullPresent = builder.and(
    present,
    builder.isNull(valueType, true),
    builder.compare("neq", valueType, zero),
  );
  const values = Array.isArray(condition.value)
    ? condition.value
    : [condition.value];
  const equalsAny = (candidates: readonly unknown[]) =>
    builder.or(
      ...candidates.map((candidate) => {
        if (typeof candidate !== "string")
          throw new Error(
            "advanced_count_plan_received_unchecked_payload_value",
          );
        return builder.compare(
          "eq",
          stringValue,
          builder.literal(candidate, stringType),
        );
      }),
    );
  let predicate: LogicalExpressionHandle;
  if (condition.operator === "isEmpty" || condition.operator === "notEmpty") {
    predicate = builder.and(
      stringDomain,
      builder.compare(
        condition.operator === "isEmpty" ? "eq" : "neq",
        stringValue,
        builder.literal("", stringType),
      ),
    );
  } else if (condition.operator === "eq" || condition.operator === "in") {
    predicate = builder.and(stringDomain, equalsAny(values));
  } else if (condition.operator === "neq" || condition.operator === "notIn") {
    predicate = builder.and(
      nonNullPresent,
      builder.or(builder.not(isString), builder.not(equalsAny(values))),
    );
  } else {
    throw new Error("advanced_count_plan_received_unchecked_payload_operator");
  }
  // Each payload leaf is two-valued before parent NOT/AND/OR semantics run.
  return builder.caseWhen(
    [
      {
        when: predicate,
        then: builder.literal(true, { kind: "scalar", scalar: "boolean" }),
      },
    ],
    builder.literal(false, { kind: "scalar", scalar: "boolean" }),
  );
}

function registeredFieldLeafPredicateExpression(
  builder: LogicalPlanBuilder,
  relation: Parameters<LogicalPlanBuilder["slot"]>[0],
  condition: FilterCondition,
  expectedCollection?: "page" | "event",
): LogicalExpressionHandle {
  return sharedRegisteredFieldLeafPredicateExpression(
    builder,
    relation,
    condition,
    expectedCollection,
    "advanced_count_plan_received_unchecked_selector_field",
  );
}

function collectionCardinalityExpression(
  builder: LogicalPlanBuilder,
  relation: Parameters<LogicalPlanBuilder["slot"]>[0],
  collection: AdvancedCountFiniteCollection,
  selectorCounts: ReadonlyMap<string, CountSelectorContribution>,
): ReturnType<LogicalPlanBuilder["slot"]> {
  if (collection.kind === "page")
    return builder.numericValue(builder.slot(relation, "pageCount"));
  if (collection.kind === "event")
    return builder.numericValue(builder.slot(relation, "eventCount"));
  const contribution = selectorCounts.get(
    countSelectorKey(collection.selector),
  );
  if (!contribution)
    throw new Error("advanced_count_plan_missing_selector_contribution");
  return builder.numericValue(builder.slot(relation, contribution.name));
}

function countExpression(
  builder: LogicalPlanBuilder,
  relation: Parameters<LogicalPlanBuilder["slot"]>[0],
  target: FilterTargetExpression,
  selectorCounts: ReadonlyMap<string, CountSelectorContribution>,
  scalarCollections: ReadonlyMap<string, ScalarCollectionContribution>,
): ReturnType<LogicalPlanBuilder["slot"]> {
  if (target.kind === "reducer" && target.reducer === "count") {
    const collection = resolveAdvancedCountFiniteCollection(target.input);
    if (collection)
      return collectionCardinalityExpression(
        builder,
        relation,
        collection,
        selectorCounts,
      );
    throw new Error("advanced_count_plan_received_unchecked_target");
  }
  if (
    target.kind === "reducer" &&
    (target.reducer === "countDistinct" ||
      target.reducer === "min" ||
      target.reducer === "max" ||
      target.reducer === "sum" ||
      target.reducer === "avg")
  ) {
    const scalarField = resolveAdvancedCountScalarField(target.input);
    if (!scalarField)
      throw new Error("advanced_count_plan_received_unchecked_target");
    const key = advancedCountScalarFieldKey(target.input, scalarField);
    const contribution = scalarCollections.get(key);
    if (!contribution)
      throw new Error("advanced_count_plan_missing_scalar_collection");
    const name =
      target.reducer === "countDistinct"
        ? contribution.distinctName
        : target.reducer === "min"
          ? contribution.minimumName
          : target.reducer === "max"
            ? contribution.maximumName
            : target.reducer === "sum"
              ? contribution.sumName
              : contribution.averageName;
    if (!name)
      throw new Error("advanced_count_plan_missing_scalar_reducer_output");
    return builder.numericValue(builder.slot(relation, name));
  }
  if (target.kind !== "arithmetic")
    throw new Error("advanced_count_plan_received_unchecked_target");
  const left = countExpression(
    builder,
    relation,
    target.left,
    selectorCounts,
    scalarCollections,
  );
  const right = countExpression(
    builder,
    relation,
    target.right,
    selectorCounts,
    scalarCollections,
  );
  return builder.numericValue(
    builder.arithmetic(
      target.operator === "add"
        ? "add"
        : target.operator === "sub"
          ? "subtract"
          : target.operator === "mul"
            ? "multiply"
            : "divide",
      left,
      right,
    ),
  );
}

function predicateExpression(
  builder: LogicalPlanBuilder,
  relation: Parameters<LogicalPlanBuilder["slot"]>[0],
  expression: FilterExpression,
  selectorCounts: ReadonlyMap<string, CountSelectorContribution>,
  scalarCollections: ReadonlyMap<string, ScalarCollectionContribution>,
  bareStringFields: ReadonlyMap<string, BareFieldContribution>,
  bareFieldMode: "contribution" | "candidate" = "contribution",
): ReturnType<LogicalPlanBuilder["slot"]> {
  if (expression.kind === "not")
    return builder.not(
      predicateExpression(
        builder,
        relation,
        expression.child,
        selectorCounts,
        scalarCollections,
        bareStringFields,
        bareFieldMode,
      ),
    );
  if (expression.kind === "and" || expression.kind === "or") {
    const terms = expression.children.map((child) =>
      predicateExpression(
        builder,
        relation,
        child,
        selectorCounts,
        scalarCollections,
        bareStringFields,
        bareFieldMode,
      ),
    );
    return expression.kind === "and"
      ? builder.and(...terms)
      : builder.or(...terms);
  }
  if (expression.kind !== "condition")
    throw new Error("advanced_count_plan_received_unchecked_expression");

  if (expression.target.kind === "field") {
    const contribution = bareStringFields.get(
      bareStringConditionKey(expression),
    );
    if (!contribution)
      throw new Error("advanced_count_plan_missing_bare_field_contribution");
    if (bareFieldMode === "candidate")
      return registeredFieldLeafPredicateExpression(
        builder,
        relation,
        contribution.condition,
      );
    return builder.compare(
      "gt",
      builder.slot(relation, contribution.name),
      builder.literal(0, { kind: "scalar", scalar: "number" }),
    );
  }

  if (expression.operator === "exists" || expression.operator === "notExists") {
    const collection = resolveAdvancedCountFiniteCollection(expression.target);
    if (!collection)
      throw new Error("advanced_count_plan_received_unchecked_target");
    const cardinality = collectionCardinalityExpression(
      builder,
      relation,
      collection,
      selectorCounts,
    );
    return builder.compare(
      expression.operator === "exists" ? "gt" : "eq",
      cardinality,
      builder.literal(0, { kind: "scalar", scalar: "number" }),
    );
  }

  const value = countExpression(
    builder,
    relation,
    expression.target,
    selectorCounts,
    scalarCollections,
  );
  if (expression.operator === "isNull" || expression.operator === "notNull")
    return builder.isNull(value, expression.operator === "notNull");
  if (value.type.kind !== "scalar" || value.type.scalar !== "number")
    throw new Error("advanced_count_plan_received_unchecked_value");
  const numericType = value.type;
  const falseValue = builder.compare(
    "eq",
    builder.literal(0, { kind: "scalar", scalar: "number" }),
    builder.literal(1, { kind: "scalar", scalar: "number" }),
  );
  let predicate: ReturnType<typeof builder.slot>;
  if (expression.operator === "in" || expression.operator === "notIn") {
    if (!Array.isArray(expression.value) || expression.value.length === 0)
      throw new Error("advanced_count_plan_received_unchecked_set");
    if (expression.value.every((item) => item === null)) {
      predicate =
        expression.operator === "in" ? falseValue : builder.isNull(value, true);
    } else {
      const values = expression.value.map((item) => {
        if (typeof item !== "number" || !Number.isFinite(item))
          throw new Error("advanced_count_plan_received_unchecked_set");
        return builder.literal(item, numericType);
      });
      predicate = builder.in(value, values, expression.operator === "notIn");
    }
  } else if (expression.operator === "between") {
    if (
      !Array.isArray(expression.value) ||
      expression.value.length !== 2 ||
      typeof expression.value[0] !== "number" ||
      !Number.isFinite(expression.value[0]) ||
      typeof expression.value[1] !== "number" ||
      !Number.isFinite(expression.value[1]) ||
      expression.value[0] > expression.value[1]
    )
      throw new Error("advanced_count_plan_received_unchecked_range");
    predicate = builder.and(
      builder.compare(
        "gte",
        value,
        builder.literal(expression.value[0], numericType),
      ),
      builder.compare(
        "lte",
        value,
        builder.literal(expression.value[1], numericType),
      ),
    );
  } else {
    if (
      typeof expression.value !== "number" ||
      !Number.isFinite(expression.value)
    )
      throw new Error("advanced_count_plan_received_unchecked_value");
    predicate = builder.compare(
      expression.operator as "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
      value,
      builder.literal(expression.value, numericType),
    );
  }
  return builder.caseWhen(
    [{ when: builder.isNull(value), then: falseValue }],
    predicate,
  );
}

interface AdvancedCountFilterMatchPlanCommon {
  readonly subject: SemanticSubjectDomain;
  readonly candidateRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly readRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly filterRange?: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly expressionRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly expressionUsesExplicitRange: boolean;
  readonly lowerBounds: readonly AdvancedCountFilterSiteLowerBound[];
  readonly reportingTimeZone: string;
  readonly capturedAtMs: number;
  readonly analysis: AnalyzedFilterDocument;
  readonly numericCompatibilityFieldIds?: readonly string[];
  readonly numericCompatibilityRequirements?: readonly AdvancedCountNumericCompatibilityRequirement[];
  readonly allowPrivateQualifiedGeoBareFields?: true;
}

export type AdvancedCountFilterMatchPlanInput =
  AdvancedCountFilterMatchPlanCommon & {
    readonly scope: "session" | "visitor";
    readonly candidateAnchor?: never;
  };

export type AdvancedEventCandidateCountPlanInput =
  AdvancedCountFilterMatchPlanCommon & {
    readonly scope: "event";
    readonly candidateAnchor: { readonly kind: "event-candidate" };
  };

export type AdvancedCountQualificationPlanInput =
  AdvancedCountFilterMatchPlanInput | AdvancedEventCandidateCountPlanInput;

export interface AdvancedCountQualificationFragment<
  Scope extends "session" | "visitor" | "event" = "session" | "visitor",
> {
  readonly matches: LogicalRelationHandle;
  readonly controls: LogicalRelationHandle;
  readonly groupedSummary: LogicalRelationHandle;
  readonly numericCompatibilityFields: readonly {
    readonly fieldId: string;
    readonly invalidCountOutput: string;
  }[];
  readonly comparisonProvenance: readonly QualifiedGeoComparisonProvenance[];
  readonly scope: Scope;
  readonly candidateGrain?: "event-candidate";
  readonly additionalGroupedSummaries?: readonly LogicalRelationHandle[];
  readonly subject: SemanticSubjectDomain;
}

/** Creates the exact Count context that can also own the consuming report. */
export function createAdvancedCountQualificationBuilder(
  input: AdvancedCountQualificationPlanInput,
): LogicalPlanBuilder {
  return builderFor({
    subject: input.subject,
    candidateRange: input.candidateRange,
    readRange: input.readRange,
    ...(input.expressionUsesExplicitRange
      ? { filterRange: input.expressionRange }
      : {}),
    reportingTimeZone: input.reportingTimeZone,
    capturedAtMs: input.capturedAtMs,
    scope: input.scope,
  });
}

/** Appends the normal combined Count relation graph without materializing IDs. */
export function appendAdvancedCountQualification(
  builder: LogicalPlanBuilder,
  input: AdvancedCountFilterMatchPlanInput,
): AdvancedCountQualificationFragment {
  return appendAdvancedCountQualificationChecked(
    builder,
    input,
  ) as AdvancedCountQualificationFragment;
}

export function appendAdvancedEventCandidateCountQualification(
  builder: LogicalPlanBuilder,
  input: AdvancedEventCandidateCountPlanInput,
): AdvancedCountQualificationFragment<"event"> {
  return appendAdvancedCountQualificationChecked(
    builder,
    input,
  ) as AdvancedCountQualificationFragment<"event">;
}

function appendAdvancedCountQualificationChecked(
  builder: LogicalPlanBuilder,
  input: AdvancedCountQualificationPlanInput,
): AdvancedCountQualificationFragment<"session" | "visitor" | "event"> {
  const context = builder.context;
  const validTime =
    context.time.candidate.startMs === input.candidateRange.startMs &&
    context.time.candidate.endExclusiveMs ===
      input.candidateRange.endExclusiveMs &&
    context.time.read.kind === "bounded" &&
    context.time.read.range.startMs === input.readRange.startMs &&
    context.time.read.range.endExclusiveMs === input.readRange.endExclusiveMs &&
    context.time.filter === undefined &&
    context.time.reportingTimeZone === input.reportingTimeZone &&
    context.time.capturedAtMs === input.capturedAtMs;
  if (
    !sameSemanticSubjectDomain(context.subject, input.subject) ||
    context.scope.requested !== input.scope ||
    context.scope.contractScope !== input.scope ||
    context.scope.logicalScope !==
      resolveAnalyticsScope(input.scope).logicalScope ||
    (input.scope === "event" &&
      input.candidateAnchor?.kind !== "event-candidate") ||
    (input.scope !== "event" && input.candidateAnchor !== undefined) ||
    !validTime
  )
    throw new Error("advanced_count_qualification_context_mismatch");
  const fragment = appendAdvancedCountFilterPlan(
    input,
    true,
    false,
    builder,
    true,
  );
  if (!fragment)
    throw new Error("advanced_count_qualification_fragment_missing");
  return fragment;
}

export function buildAdvancedCountFilterMatchPlan(
  input: AdvancedCountFilterMatchPlanInput,
): ValidatedLogicalPlan {
  return buildAdvancedCountFilterPlan(input, false);
}

/**
 * Builds the single-snapshot count gate and matcher. Callers must still check
 * the bounded grouped aggregate's physical materialization before compiling.
 */
export function buildAdvancedCountFilterCombinedPlan(
  input: AdvancedCountFilterMatchPlanInput,
): ValidatedLogicalPlan {
  return buildAdvancedCountFilterPlan(input, true);
}

/** Builds the one-statement grouped count plan with Event payload controls. */
export function buildAdvancedCountFilterPayloadCombinedPlan(
  input: AdvancedCountFilterMatchPlanInput,
): ValidatedLogicalPlan {
  if (
    input.numericCompatibilityRequirements?.length ||
    input.numericCompatibilityFieldIds?.length
  )
    throw new Error("advanced_count_payload_plan_numeric_proof_unsupported");
  return buildAdvancedCountFilterPlan(input, true, true);
}

/** Returns the bounded grouped aggregate width used by combined count plans. */
export function advancedCountFilterCombinedGroupWidth(
  plan: ValidatedLogicalPlan,
): number | null {
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const grouped = plan.nodes.find(
    (node) =>
      node.kind === "aggregate" &&
      node.groups.length === 2 &&
      nodes.get(node.input)?.kind === "limit",
  );
  return grouped?.kind === "aggregate" ? grouped.output.length : null;
}

function buildAdvancedCountFilterPlan(
  input: AdvancedCountFilterMatchPlanInput,
  combined: boolean,
  payloadCombined = false,
): ValidatedLogicalPlan {
  const builder = createAdvancedCountQualificationBuilder(input);
  appendAdvancedCountFilterPlan(
    input,
    combined,
    payloadCombined,
    builder,
    false,
  );
  return builder.finish();
}

function appendAdvancedCountFilterPlan(
  input: AdvancedCountQualificationPlanInput,
  combined: boolean,
  payloadCombined: boolean,
  builder: LogicalPlanBuilder,
  qualificationOnly: boolean,
):
  | AdvancedCountQualificationFragment<"session" | "visitor" | "event">
  | undefined {
  if (input.scope === "event") {
    if (
      input.candidateAnchor?.kind !== "event-candidate" ||
      !combined ||
      !qualificationOnly ||
      payloadCombined
    )
      throw new Error("advanced_count_event_candidate_plan_not_applicable");
    return appendEventCandidateCountQualification(builder, input);
  }
  if (combined) {
    const exactRange =
      input.candidateRange.startMs === input.readRange.startMs &&
      input.candidateRange.endExclusiveMs === input.readRange.endExclusiveMs &&
      input.candidateRange.startMs === input.expressionRange.startMs &&
      input.candidateRange.endExclusiveMs ===
        input.expressionRange.endExclusiveMs;
    if (
      input.subject.siteIds.length !== 1 ||
      input.expressionUsesExplicitRange ||
      !exactRange ||
      input.lowerBounds.length !== 1 ||
      input.lowerBounds[0]?.siteId !== input.subject.siteIds[0] ||
      input.lowerBounds[0]?.startMs !== input.candidateRange.startMs
    )
      throw new Error("advanced_count_combined_plan_not_applicable");
  }
  const lowerBoundsCoverCandidate = input.lowerBounds.every(
    (bound) => bound.startMs <= input.candidateRange.startMs,
  );
  const exactImplicitRange =
    input.expressionRange.startMs === input.candidateRange.startMs &&
    input.expressionRange.endExclusiveMs ===
      input.candidateRange.endExclusiveMs;
  const expressionCoversCandidate =
    input.expressionRange.startMs <= input.candidateRange.startMs &&
    input.expressionRange.endExclusiveMs >= input.candidateRange.endExclusiveMs;
  // Choose the anchor strategy before constructing relations. Logical plans
  // require every constructed relation to remain reachable from an output.
  const singleBagMode = input.expressionUsesExplicitRange
    ? "same-range"
    : lowerBoundsCoverCandidate && exactImplicitRange
      ? "same-range"
      : lowerBoundsCoverCandidate && expressionCoversCandidate
        ? "candidate-marked"
        : "separate";
  if (qualificationOnly && (!combined || payloadCombined))
    throw new Error("advanced_count_qualification_requires_normal_combined");
  const selectorCounts = countSelectorContributions(
    input.analysis.document.root!,
  );
  const payloadPaths = payloadCombined
    ? snapshotEventPayloadTopLevelPaths(
        advancedCountPayloadPaths(input.analysis.document.root!),
      )
    : [];
  if (payloadCombined && payloadPaths.length === 0)
    throw new Error("advanced_count_payload_plan_requires_payload_selector");
  if (
    payloadCombined &&
    !advancedCountRegisteredStringLiteralsAreAscii(
      input.analysis.document.root!,
    )
  )
    throw new Error("advanced_count_payload_plan_registered_non_ascii_literal");
  const payloadPathIndexes = new Map(
    payloadPaths.map(({ path }, index) => [path, index]),
  );
  const payloadFacts = (() => {
    if (!payloadCombined) return undefined;
    const events = builder.source("event", {
      temporalDomain: "read",
      attributes: ["event.report.localId", "event.report.ownerPresent"],
    });
    const ownerScopedEvents = builder.filter(
      events,
      builder.compare(
        "eq",
        builder.slot(events, "attribute:event.report.ownerPresent"),
        builder.literal(true, { kind: "scalar", scalar: "boolean" }),
      ),
    );
    const properties = builder.eventPayloadProperties(
      ownerScopedEvents,
      payloadPaths.map(({ path }) => path),
    );
    const numberType = { kind: "scalar", scalar: "number" } as const;
    const booleanType = { kind: "scalar", scalar: "boolean" } as const;
    const zero = builder.literal(0, numberType);
    const one = builder.literal(1, numberType);
    const booleanAs01 = (propertyIndex: number, field: string) => {
      const value = builder.slot(
        properties,
        `payloadProperty:${propertyIndex}:${field}`,
      );
      return builder.caseWhen(
        [
          {
            when: builder.compare(
              "eq",
              value,
              builder.literal(true, booleanType),
            ),
            then: one,
          },
          {
            when: builder.compare(
              "eq",
              value,
              builder.literal(false, booleanType),
            ),
            then: zero,
          },
        ],
        builder.literal(null, numberType),
      );
    };
    const measures: Parameters<LogicalPlanBuilder["aggregate"]>[2][number][] = [
      { name: "payloadFactMultiplicity", kind: "count-rows" },
    ];
    for (const [propertyIndex] of payloadPaths.entries()) {
      for (const field of [
        "present",
        "structureCompatible",
        "valueCompatible",
      ] as const)
        measures.push({
          name: `payloadProperty${propertyIndex}${
            field === "present"
              ? "Present01"
              : field === "structureCompatible"
                ? "StructureCompatible01"
                : "ValueCompatible01"
          }`,
          kind: "min",
          expression: booleanAs01(propertyIndex, field),
        });
      for (const field of ["valueType", "stringValue"] as const)
        measures.push({
          name: `payloadProperty${propertyIndex}${
            field === "valueType" ? "ValueType" : "StringValue"
          }`,
          kind: "min",
          expression: builder.slot(
            properties,
            `payloadProperty:${propertyIndex}:${field}`,
          ),
        });
    }
    const fact = builder.aggregate(
      properties,
      {
        siteId: builder.literal(input.subject.siteIds[0]!, {
          kind: "scalar",
          scalar: "string",
        }),
        eventId: builder.slot(properties, "attribute:event.report.localId"),
      },
      measures,
    );
    return { fact };
  })();
  const scalarCollections = scalarCollectionContributions(
    input.analysis.document.root!,
  );
  const numericCompatibilityRequirements =
    matchNumericCompatibilityRequirements({
      root: input.analysis.document.root!,
      numericCompatibilityRequirements: input.numericCompatibilityRequirements,
      numericCompatibilityFieldIds: input.numericCompatibilityFieldIds,
    });
  const numericCompatibilityProofs = new Map(
    numericCompatibilityRequirements.map(({ fieldId, proof }) => [
      fieldId,
      proof ?? "safe-number",
    ]),
  );
  const bareStringFields = bareFieldContributions(
    input.analysis.document.root!,
    input.allowPrivateQualifiedGeoBareFields === true,
  );
  const qualifiedGeoRawCountWitness =
    input.allowPrivateQualifiedGeoBareFields === true
      ? (() => {
          if (
            !combined ||
            payloadCombined ||
            input.expressionUsesExplicitRange ||
            input.subject.siteIds.length !== 1 ||
            input.candidateRange.startMs !== input.readRange.startMs ||
            input.candidateRange.endExclusiveMs !==
              input.readRange.endExclusiveMs ||
            input.expressionRange.startMs !== input.candidateRange.startMs ||
            input.expressionRange.endExclusiveMs !==
              input.candidateRange.endExclusiveMs
          )
            throw new Error(
              "advanced_count_geo_comparison_resource_witness_invalid",
            );
          return Object.freeze({
            kind: "candidate-eligible-activity-count" as const,
            siteId: input.subject.siteIds[0]!,
            scope: input.scope,
            subjectSiteIds: Object.freeze([...input.subject.siteIds]),
            candidateRange: Object.freeze({ ...input.candidateRange }),
            readRange: Object.freeze({ ...input.readRange }),
            rawCountMaximum: ADVANCED_FILTER_MAX_ACTIVITIES as 20_000,
            rawCountObservationLimit: ADVANCED_FILTER_ACTIVITY_LIMIT as 20_001,
            activityEligibility: "page-or-same-site-event" as const,
          } satisfies QualifiedGeoRawCountEligibilityWitness);
        })()
      : undefined;
  const comparisonProvenanceByKey = new Map<
    string,
    QualifiedGeoComparisonProvenance
  >();
  const recordQualifiedGeoLeaf = (
    relation: Parameters<LogicalPlanBuilder["slot"]>[0],
    leaf: QualifiedGeoBareLeafCreation,
  ) => {
    if (!qualifiedGeoRawCountWitness)
      throw new Error("advanced_count_geo_comparison_resource_witness_missing");
    const provenance: QualifiedGeoComparisonProvenance = Object.freeze({
      fieldId: leaf.field.fieldId,
      attributeId: leaf.field.valueAttribute,
      relationId: leaf.relationId,
      slotId: leaf.slotId,
      semanticProfile: leaf.field.semanticProfile,
      normalization: "trim-case-fold",
      operator: leaf.literalProof.operator,
      literalValues: Object.freeze([...leaf.literalProof.values]),
      temporalDomains: Object.freeze([...relation.temporalDomains]),
      rawCountEligibilityWitness: qualifiedGeoRawCountWitness,
    });
    const key = JSON.stringify([
      provenance.fieldId,
      provenance.attributeId,
      provenance.relationId,
      provenance.slotId,
      provenance.semanticProfile,
      provenance.operator,
      provenance.literalValues,
    ]);
    comparisonProvenanceByKey.set(key, provenance);
  };
  const selectorAttributes = new Set<string>();
  const bareFieldAttributes = new Set<string>();
  for (const { input: selector } of selectorCounts.values()) {
    if (selector.collection.kind !== "entity-root")
      throw new Error("advanced_count_plan_received_unchecked_selector");
    if (
      selector.collection.entity !== "page" &&
      selector.collection.entity !== "event"
    )
      throw new Error("advanced_count_plan_received_unchecked_selector");
    collectSelectorPredicateAttributes(
      selector.predicate,
      selector.collection.entity,
      selectorAttributes,
    );
  }
  collectBareFieldAttributes(bareStringFields, bareFieldAttributes);
  for (const contribution of scalarCollections.values()) {
    const { field, collection } = contribution.resolved;
    selectorAttributes.add(field.valueAttribute);
    selectorAttributes.add(
      numericCompatibilityProofs.get(field.fieldId) === "exact-aggregate"
        ? field.exactAggregateAttribute
        : field.safeRangeAttribute,
    );
    if (collection.kind === "selector")
      collectSelectorPredicateAttributes(
        collection.selector.predicate,
        "page",
        selectorAttributes,
      );
  }
  const numericCompatibilityFields = numericCompatibilityRequirements.map(
    ({ fieldId }): Extract<AdvancedCountSelectorField, { kind: "number" }> => {
      const field = advancedCountSelectorField(fieldId);
      if (!field || field.kind !== "number")
        throw new Error(
          "advanced_count_match_received_unchecked_numeric_field",
        );
      return field;
    },
  );
  const numericCompatibilityDomains = new Map(
    numericCompatibilityRequirements.map(({ fieldId, domain }) => [
      fieldId,
      domain,
    ]),
  );
  const numericCompatibilityAttribute = (
    field: AdvancedCountNumberSelectorField,
  ) =>
    numericCompatibilityProofs.get(field.fieldId) === "exact-aggregate"
      ? field.exactAggregateAttribute
      : field.safeRangeAttribute;
  const pageAndEventNumericRequirements =
    numericCompatibilityRequirements.filter(
      ({ domain }) => domain === "page-and-event",
    );
  const bagDomain = input.expressionUsesExplicitRange ? "filter" : "read";
  const bagBroadStart = input.expressionRange.startMs;
  const usesCandidateContributionBag =
    singleBagMode === "separate" &&
    (bareStringFields.size > 0 || pageAndEventNumericRequirements.length > 0);
  const numericCompatibilityAttributes = numericCompatibilityFields.flatMap(
    (field) => [field.valueAttribute, numericCompatibilityAttribute(field)],
  );
  const bagAttributes =
    singleBagMode === "separate"
      ? [...selectorAttributes, ...numericCompatibilityAttributes]
      : [...selectorAttributes, ...bareFieldAttributes];
  const eligibleBag = eligibleAdvancedFilterActivities(
    builder,
    observationSource(builder, bagDomain, input.scope, combined, [
      ...new Set([
        ...bagAttributes,
        ...(combined ? ["observation.siteIdentityConsistent"] : []),
      ]),
    ]),
  );
  const bag = addPerSiteLowerBound(
    builder,
    eligibleBag,
    input.lowerBounds,
    bagBroadStart,
  );
  const scopeIdentityName = scopeIdentityAttribute(input.scope);
  const anchors =
    singleBagMode === "separate" && !usesCandidateContributionBag
      ? builder.distinct(
          truthyScopeRows(
            builder,
            eligibleAdvancedFilterActivities(
              builder,
              observationSource(builder, "candidate", input.scope),
            ),
            input.scope,
          ),
          [
            {
              input: "attribute:observation.rawSiteId",
              output: "siteId",
            },
            { input: scopeIdentityName, output: "entityId" },
          ],
        )
      : undefined;
  // Candidate anchors and bare existential witnesses follow the candidate
  // domain. Read or filter lower bounds constrain expression contributions
  // only, so they must not remove an otherwise eligible candidate row.
  const candidateContributionSource = usesCandidateContributionBag
    ? eligibleAdvancedFilterActivities(
        builder,
        observationSource(builder, "candidate", input.scope, false, [
          ...new Set([
            ...selectorAttributes,
            ...bareFieldAttributes,
            ...numericCompatibilityAttributes,
          ]),
        ]),
      )
    : undefined;
  const candidateContributionRows = candidateContributionSource
    ? pageAndEventNumericRequirements.length > 0
      ? candidateContributionSource
      : truthyScopeRows(builder, candidateContributionSource, input.scope)
    : undefined;
  // Numeric compatibility counts must see the complete eligible bag in this
  // matcher statement, even for identities that the root predicate rejects.
  const groupedRows =
    combined || numericCompatibilityFields.length > 0
      ? bag
      : truthyScopeRows(builder, bag, input.scope);
  const predicateRows = payloadFacts
    ? builder.join(
        groupedRows,
        payloadFacts.fact,
        [
          {
            left: "attribute:observation.rawSiteId",
            right: "siteId",
          },
          { left: "attribute:observation.id", right: "eventId" },
        ],
        "left",
      )
    : groupedRows;
  const zero = builder.literal(0, { kind: "scalar", scalar: "number" });
  const one = builder.literal(1, { kind: "scalar", scalar: "number" });
  const anchorContribution =
    singleBagMode === "same-range"
      ? one
      : singleBagMode === "candidate-marked"
        ? builder.caseWhen(
            [
              {
                when: builder.and(
                  builder.compare(
                    "gte",
                    builder.slot(predicateRows, "time"),
                    builder.literal(input.candidateRange.startMs, {
                      kind: "scalar",
                      scalar: "datetime",
                    }),
                  ),
                  builder.compare(
                    "lt",
                    builder.slot(predicateRows, "time"),
                    builder.literal(input.candidateRange.endExclusiveMs, {
                      kind: "scalar",
                      scalar: "datetime",
                    }),
                  ),
                ),
                then: one,
              },
            ],
            zero,
          )
        : zero;
  const kind = builder.slot(predicateRows, "attribute:observation.kind");
  const activityContribution = (
    relation: typeof predicateRows,
    activityKind: "page" | "event",
  ) =>
    builder.caseWhen(
      [
        {
          when: builder.compare(
            "eq",
            builder.slot(relation, "attribute:observation.kind"),
            builder.literal(activityKind, {
              kind: "scalar",
              scalar: "string",
            }),
          ),
          then: one,
        },
      ],
      zero,
    );
  const numericCompatibilityContribution = (
    relation: Parameters<LogicalPlanBuilder["slot"]>[0],
    field: AdvancedCountNumberSelectorField,
    domain: AdvancedFilterNumericCompatibilityDomain,
  ) => {
    const rawValue = builder.slot(
      relation,
      `attribute:${field.valueAttribute}`,
    );
    const safeRange = builder.slot(
      relation,
      `attribute:${numericCompatibilityAttribute(field)}`,
    );
    const rowKind = builder.slot(relation, "attribute:observation.kind");
    const isPage = builder.compare(
      "eq",
      rowKind,
      builder.literal("page", { kind: "scalar", scalar: "string" }),
    );
    const isEvent = builder.compare(
      "eq",
      rowKind,
      builder.literal("event", { kind: "scalar", scalar: "string" }),
    );
    return builder.caseWhen(
      [
        {
          when: builder.and(
            domain === "page-only" ? isPage : builder.or(isPage, isEvent),
            builder.isNull(rawValue, true),
            builder.not(safeRange),
          ),
          then: one,
        },
      ],
      zero,
    );
  };
  const bareStringFieldContribution = (
    relation: Parameters<LogicalPlanBuilder["slot"]>[0],
    contribution: BareFieldContribution,
    candidateMarked: boolean,
    onQualifiedGeoBareLeaf?: (input: QualifiedGeoBareLeafCreation) => void,
  ) => {
    const predicate = sharedRegisteredFieldLeafPredicateExpression(
      builder,
      relation,
      contribution.condition,
      undefined,
      "advanced_count_plan_received_unchecked_bare_field",
      {
        bareField: contribution.field,
        ...(onQualifiedGeoBareLeaf ? { onQualifiedGeoBareLeaf } : {}),
      },
    );
    const candidatePredicate = candidateMarked
      ? builder.and(
          builder.compare(
            "gte",
            builder.slot(relation, "time"),
            builder.literal(input.candidateRange.startMs, {
              kind: "scalar",
              scalar: "datetime",
            }),
          ),
          builder.compare(
            "lt",
            builder.slot(relation, "time"),
            builder.literal(input.candidateRange.endExclusiveMs, {
              kind: "scalar",
              scalar: "datetime",
            }),
          ),
        )
      : undefined;
    return builder.caseWhen(
      [
        {
          when: candidatePredicate
            ? builder.and(candidatePredicate, predicate)
            : predicate,
          then: one,
        },
      ],
      zero,
    );
  };
  const selectorContribution = (contribution: CountSelectorContribution) => {
    if (contribution.input.collection.kind !== "entity-root")
      throw new Error("advanced_count_plan_received_unchecked_selector");
    const collection = contribution.input.collection.entity;
    if (collection !== "page" && collection !== "event")
      throw new Error("advanced_count_plan_received_unchecked_selector");
    return builder.caseWhen(
      [
        {
          when: builder.and(
            builder.compare(
              "eq",
              kind,
              builder.literal(collection, {
                kind: "scalar",
                scalar: "string",
              }),
            ),
            selectorPredicateExpression(
              builder,
              predicateRows,
              collection,
              contribution.input.predicate,
              payloadPathIndexes,
            ),
          ),
          then: one,
        },
      ],
      zero,
    );
  };
  const observationProjection: Record<string, LogicalExpressionHandle> = {
    siteId: builder.slot(predicateRows, "attribute:observation.rawSiteId"),
    entityId: builder.slot(predicateRows, scopeIdentityName),
    anchorContribution,
    pageContribution: activityContribution(predicateRows, "page"),
    eventContribution: activityContribution(predicateRows, "event"),
    ...(combined
      ? {
          guardRawCountContribution: one,
          guardNullActivityIdContribution: builder.caseWhen(
            [
              {
                when: builder.isNull(
                  builder.slot(predicateRows, "attribute:observation.id"),
                ),
                then: one,
              },
            ],
            zero,
          ),
          guardSiteIdentityMismatchContribution: builder.caseWhen(
            [
              {
                when: builder.not(
                  builder.slot(
                    predicateRows,
                    "attribute:observation.siteIdentityConsistent",
                  ),
                ),
                then: one,
              },
            ],
            zero,
          ),
        }
      : {}),
    ...(payloadFacts
      ? {
          payloadMissingFactContribution: builder.caseWhen(
            [
              {
                when: builder.and(
                  builder.compare(
                    "eq",
                    kind,
                    builder.literal("event", {
                      kind: "scalar",
                      scalar: "string",
                    }),
                  ),
                  builder.caseWhen(
                    [
                      {
                        when: builder.isNull(
                          builder.slot(
                            predicateRows,
                            "right.payloadFactMultiplicity",
                          ),
                        ),
                        then: builder.literal(true, {
                          kind: "scalar",
                          scalar: "boolean",
                        }),
                      },
                      {
                        when: builder.compare(
                          "neq",
                          builder.slot(
                            predicateRows,
                            "right.payloadFactMultiplicity",
                          ),
                          one,
                        ),
                        then: builder.literal(true, {
                          kind: "scalar",
                          scalar: "boolean",
                        }),
                      },
                    ],
                    builder.literal(false, {
                      kind: "scalar",
                      scalar: "boolean",
                    }),
                  ),
                ),
                then: one,
              },
            ],
            zero,
          ),
        }
      : {}),
  };
  for (const contribution of selectorCounts.values())
    observationProjection[contribution.name] =
      selectorContribution(contribution);
  for (const field of numericCompatibilityFields) {
    const domain = numericCompatibilityDomains.get(field.fieldId)!;
    observationProjection[field.invalidCountOutput] =
      numericCompatibilityContribution(predicateRows, field, domain);
  }
  for (const contribution of scalarCollections.values()) {
    const { field, collection } = contribution.resolved;
    const isPage = builder.compare(
      "eq",
      kind,
      builder.literal("page", { kind: "scalar", scalar: "string" }),
    );
    const selectedPage =
      collection.kind === "page"
        ? isPage
        : builder.and(
            isPage,
            selectorPredicateExpression(
              builder,
              predicateRows,
              "page",
              collection.selector.predicate,
              payloadPathIndexes,
            ),
          );
    const rawValue = builder.slot(
      predicateRows,
      `attribute:${field.valueAttribute}`,
    );
    const exactAggregate =
      numericCompatibilityProofs.get(field.fieldId) === "exact-aggregate";
    const scalarValueIncluded = exactAggregate
      ? builder.and(
          selectedPage,
          builder.slot(
            predicateRows,
            `attribute:${field.exactAggregateAttribute}`,
          ),
        )
      : selectedPage;
    observationProjection[contribution.valueName] = builder.caseWhen(
      [{ when: scalarValueIncluded, then: rawValue }],
      scalarCollectionNullValue(builder, contribution),
    );
    if (contribution.nullMarkerName)
      observationProjection[contribution.nullMarkerName] = builder.caseWhen(
        [
          {
            when: builder.and(selectedPage, builder.isNull(rawValue)),
            then: one,
          },
        ],
        zero,
      );
  }
  for (const contribution of bareStringFields.values())
    observationProjection[contribution.name] = usesCandidateContributionBag
      ? zero
      : bareStringFieldContribution(
          predicateRows,
          contribution,
          singleBagMode === "candidate-marked",
          (leaf) => recordQualifiedGeoLeaf(predicateRows, leaf),
        );
  const observationRows = builder.project(predicateRows, observationProjection);
  // Keep Limit as the grouped Aggregate's immediate input so the bounded
  // group-summary physical rule can prove and materialize this exact bag.
  const boundedObservationRows = combined
    ? builder.limit(observationRows, ADVANCED_FILTER_ACTIVITY_LIMIT)
    : observationRows;
  const contributionNames = [
    "anchorContribution",
    "pageContribution",
    "eventContribution",
    ...(combined
      ? [
          "guardRawCountContribution",
          "guardNullActivityIdContribution",
          "guardSiteIdentityMismatchContribution",
          ...(payloadFacts ? ["payloadMissingFactContribution"] : []),
        ]
      : []),
    ...[...selectorCounts.values()].map((contribution) => contribution.name),
    ...numericCompatibilityFields.map((field) => field.invalidCountOutput),
    ...[...bareStringFields.values()].map((contribution) => contribution.name),
    ...[...scalarCollections.values()].flatMap((contribution) =>
      contribution.nullMarkerName ? [contribution.nullMarkerName] : [],
    ),
  ];
  const scalarValueNames = [...scalarCollections.values()].map(
    (contribution) => contribution.valueName,
  );
  const supplementalContributionRows = candidateContributionRows
    ? builder.project(candidateContributionRows, {
        siteId: builder.slot(
          candidateContributionRows,
          "attribute:observation.rawSiteId",
        ),
        entityId: builder.slot(candidateContributionRows, scopeIdentityName),
        anchorContribution: one,
        pageContribution: zero,
        eventContribution: zero,
        ...Object.fromEntries(
          [...selectorCounts.values()].map(({ name }) => [name, zero]),
        ),
        ...Object.fromEntries(
          numericCompatibilityFields.map((field) => [
            field.invalidCountOutput,
            numericCompatibilityContribution(
              candidateContributionRows,
              field,
              numericCompatibilityDomains.get(field.fieldId)!,
            ),
          ]),
        ),
        ...Object.fromEntries(
          [...bareStringFields.values()].map((contribution) => [
            contribution.name,
            bareStringFieldContribution(
              candidateContributionRows,
              contribution,
              false,
              (leaf) => recordQualifiedGeoLeaf(candidateContributionRows, leaf),
            ),
          ]),
        ),
        ...Object.fromEntries(
          [...scalarCollections.values()].flatMap((contribution) => [
            [
              contribution.valueName,
              scalarCollectionNullValue(builder, contribution),
            ],
            ...(contribution.nullMarkerName
              ? [[contribution.nullMarkerName, zero] as const]
              : []),
          ]),
        ),
      })
    : anchors
      ? builder.project(anchors, {
          siteId: builder.slot(anchors, "siteId"),
          entityId: builder.slot(anchors, "entityId"),
          anchorContribution: one,
          pageContribution: zero,
          eventContribution: zero,
          ...Object.fromEntries(
            [...selectorCounts.values()].map(({ name }) => [name, zero]),
          ),
          ...Object.fromEntries(
            numericCompatibilityFields.map((field) => [
              field.invalidCountOutput,
              zero,
            ]),
          ),
          ...Object.fromEntries(
            [...bareStringFields.values()].map(({ name }) => [name, zero]),
          ),
          ...Object.fromEntries(
            [...scalarCollections.values()].flatMap((contribution) => [
              [
                contribution.valueName,
                scalarCollectionNullValue(builder, contribution),
              ],
              ...(contribution.nullMarkerName
                ? [[contribution.nullMarkerName, zero] as const]
                : []),
            ]),
          ),
        })
      : undefined;
  const contributionBag = supplementalContributionRows
    ? builder.appendRows(
        [supplementalContributionRows, boundedObservationRows],
        ["siteId", "entityId", ...contributionNames, ...scalarValueNames],
      )
    : boundedObservationRows;
  const scalarCollectionMeasures = [...scalarCollections.values()].flatMap(
    (contribution) => [
      ...(contribution.distinctName
        ? [
            {
              name: contribution.distinctName,
              kind: "count-distinct" as const,
              expression: builder.slot(contributionBag, contribution.valueName),
            },
          ]
        : []),
      ...(contribution.minimumName
        ? [
            {
              name: contribution.minimumName,
              kind: "min" as const,
              expression: builder.slot(contributionBag, contribution.valueName),
            },
          ]
        : []),
      ...(contribution.maximumName
        ? [
            {
              name: contribution.maximumName,
              kind: "max" as const,
              expression: builder.slot(contributionBag, contribution.valueName),
            },
          ]
        : []),
      ...(contribution.sumName
        ? [
            {
              name: contribution.sumName,
              kind: "sum" as const,
              expression: builder.numericValue(
                builder.slot(contributionBag, contribution.valueName),
              ),
            },
          ]
        : []),
      ...(contribution.averageName
        ? [
            {
              name: contribution.averageName,
              kind: "avg" as const,
              expression: builder.numericValue(
                builder.slot(contributionBag, contribution.valueName),
              ),
            },
          ]
        : []),
    ],
  );
  const totals = builder.aggregate(
    contributionBag,
    {
      siteId: builder.slot(contributionBag, "siteId"),
      entityId: builder.slot(contributionBag, "entityId"),
    },
    [
      ...contributionNames.map((name) => ({
        name,
        kind: "sum" as const,
        expression: builder.slot(contributionBag, name),
      })),
      ...scalarCollectionMeasures,
    ],
  );
  const hasCandidateAnchor = builder.compare(
    "gt",
    builder.coalesce(builder.slot(totals, "anchorContribution"), zero),
    zero,
  );
  const invalidNumericDomain = (
    relation: Parameters<LogicalPlanBuilder["slot"]>[0],
    pageCountName: "pageCount" | "pageContribution" = "pageCount",
  ) =>
    builder.or(
      ...numericCompatibilityFields.map((field) =>
        builder.compare(
          "gt",
          builder.coalesce(
            builder.slot(relation, field.invalidCountOutput),
            zero,
          ),
          zero,
        ),
      ),
      ...(numericCompatibilityRequirements.some(
        ({ proof }) => proof === "exact-aggregate",
      )
        ? [
            builder.compare(
              "gt",
              builder.coalesce(builder.slot(relation, pageCountName), zero),
              builder.literal(ADVANCED_FILTER_MAX_ACTIVITIES, {
                kind: "scalar",
                scalar: "number",
              }),
            ),
          ]
        : []),
    );
  const matchDomain = combined
    ? builder.and(
        hasCandidateAnchor,
        builder.isNull(builder.slot(totals, "entityId"), true),
        builder.compare(
          "neq",
          builder.slot(totals, "entityId"),
          builder.literal("", { kind: "scalar", scalar: "string" }),
        ),
      )
    : numericCompatibilityFields.length > 0
      ? builder.or(
          hasCandidateAnchor,
          invalidNumericDomain(totals, "pageContribution"),
        )
      : hasCandidateAnchor;
  // The payload carrier returns every scope row with a SQL matched bit; the
  // legacy combined shape continues to filter identities before projection.
  const anchored = payloadCombined
    ? totals
    : builder.filter(totals, matchDomain);
  const countsProjection: Record<string, LogicalExpressionHandle> = {
    siteId: builder.slot(anchored, "siteId"),
    entityId: builder.slot(anchored, "entityId"),
    pageCount: builder.coalesce(
      builder.slot(anchored, "pageContribution"),
      zero,
    ),
    eventCount: builder.coalesce(
      builder.slot(anchored, "eventContribution"),
      zero,
    ),
    ...(numericCompatibilityFields.length > 0 || payloadCombined
      ? {
          anchorContribution: builder.coalesce(
            builder.slot(anchored, "anchorContribution"),
            zero,
          ),
        }
      : {}),
    ...(payloadCombined
      ? {
          rawCount: builder.coalesce(
            builder.slot(anchored, "guardRawCountContribution"),
            zero,
          ),
          nullActivityIdCount: builder.coalesce(
            builder.slot(anchored, "guardNullActivityIdContribution"),
            zero,
          ),
          siteIdentityMismatchCount: builder.coalesce(
            builder.slot(anchored, "guardSiteIdentityMismatchContribution"),
            zero,
          ),
          payloadMissingFactCount: builder.coalesce(
            builder.slot(anchored, "payloadMissingFactContribution"),
            zero,
          ),
        }
      : {}),
  };
  for (const contribution of selectorCounts.values())
    countsProjection[contribution.name] = builder.coalesce(
      builder.slot(anchored, contribution.name),
      zero,
    );
  for (const contribution of bareStringFields.values())
    countsProjection[contribution.name] = builder.coalesce(
      builder.slot(anchored, contribution.name),
      zero,
    );
  for (const field of numericCompatibilityFields) {
    const invalidCount = builder.coalesce(
      builder.slot(anchored, field.invalidCountOutput),
      zero,
    );
    countsProjection[field.invalidCountOutput] =
      numericCompatibilityProofs.get(field.fieldId) === "exact-aggregate"
        ? builder.caseWhen(
            [
              {
                when: builder.compare(
                  "gt",
                  builder.slot(anchored, "pageContribution"),
                  builder.literal(ADVANCED_FILTER_MAX_ACTIVITIES, {
                    kind: "scalar",
                    scalar: "number",
                  }),
                ),
                then: one,
              },
            ],
            invalidCount,
          )
        : invalidCount;
  }
  for (const contribution of scalarCollections.values()) {
    if (contribution.distinctName) {
      if (!contribution.nullMarkerName)
        throw new Error("advanced_count_plan_missing_scalar_null_marker");
      const includesNull = builder.caseWhen(
        [
          {
            when: builder.compare(
              "gt",
              builder.coalesce(
                builder.slot(anchored, contribution.nullMarkerName),
                zero,
              ),
              zero,
            ),
            then: one,
          },
        ],
        zero,
      );
      countsProjection[contribution.distinctName] = builder.numericValue(
        builder.arithmetic(
          "add",
          builder.coalesce(
            builder.slot(anchored, contribution.distinctName),
            zero,
          ),
          includesNull,
        ),
      );
    }
    if (contribution.minimumName)
      countsProjection[contribution.minimumName] = builder.numericValue(
        builder.slot(anchored, contribution.minimumName),
      );
    if (contribution.maximumName)
      countsProjection[contribution.maximumName] = builder.numericValue(
        builder.slot(anchored, contribution.maximumName),
      );
    if (contribution.sumName)
      countsProjection[contribution.sumName] = builder.numericValue(
        builder.coalesce(builder.slot(anchored, contribution.sumName), zero),
      );
    if (contribution.averageName)
      countsProjection[contribution.averageName] = builder.numericValue(
        builder.slot(anchored, contribution.averageName),
      );
  }
  const countsWithSelectors = builder.project(anchored, countsProjection);
  const filterMatch = predicateExpression(
    builder,
    countsWithSelectors,
    input.analysis.document.root!,
    selectorCounts,
    scalarCollections,
    bareStringFields,
  );
  if (payloadCombined) {
    if (!payloadFacts || numericCompatibilityFields.length > 0)
      throw new Error("advanced_count_payload_plan_controls_missing");
    const payloadStringType = {
      kind: "scalar",
      scalar: "string",
    } as const;
    const invalid01 = (
      relation: Parameters<LogicalPlanBuilder["slot"]>[0],
      name: string,
    ) => {
      const value = builder.slot(relation, name);
      return builder.caseWhen(
        [
          { when: builder.isNull(value), then: one },
          { when: builder.compare("neq", value, one), then: one },
        ],
        zero,
      );
    };
    const payloadFact = payloadFacts.fact;
    const sumPayloadPathControls = (field: string) =>
      payloadPaths
        .map((_, index) =>
          invalid01(payloadFact, `payloadProperty${index}${field}`),
        )
        .reduce((sum, value) => builder.arithmetic("add", sum, value), zero);
    const payloadGuardNames = [
      "payloadStructureInvalidCount",
      "payloadValueInvalidCount",
      "payloadMultiplicityInvalidCount",
    ] as const;
    const payloadControls = builder.project(payloadFact, {
      payloadStructureInvalidCount: builder.numericValue(
        sumPayloadPathControls("StructureCompatible01"),
      ),
      payloadValueInvalidCount: builder.numericValue(
        sumPayloadPathControls("ValueCompatible01"),
      ),
      payloadMultiplicityInvalidCount: builder.caseWhen(
        [
          {
            when: builder.compare(
              "neq",
              builder.slot(payloadFact, "payloadFactMultiplicity"),
              one,
            ),
            then: one,
          },
        ],
        zero,
      ),
    });
    const guardTotals = builder.aggregate(
      payloadControls,
      {},
      payloadGuardNames.map((name) => ({
        name,
        kind: "sum" as const,
        expression: builder.slot(payloadControls, name),
      })),
    );
    const guard = builder.project(
      guardTotals,
      Object.fromEntries(
        payloadGuardNames.map((name) => [
          name,
          builder.coalesce(builder.slot(guardTotals, name), zero),
        ]),
      ),
    );
    const scopeMatched = builder.and(
      builder.compare(
        "gt",
        builder.slot(countsWithSelectors, "anchorContribution"),
        zero,
      ),
      builder.isNull(builder.slot(countsWithSelectors, "entityId"), true),
      builder.compare(
        "neq",
        builder.slot(countsWithSelectors, "entityId"),
        builder.literal("", payloadStringType),
      ),
      filterMatch,
    );
    const scopeRows = builder.project(countsWithSelectors, {
      rowKind: builder.literal("scope", payloadStringType),
      matched: builder.caseWhen([{ when: scopeMatched, then: one }], zero),
      rawCount: builder.slot(countsWithSelectors, "rawCount"),
      nullActivityIdCount: builder.slot(
        countsWithSelectors,
        "nullActivityIdCount",
      ),
      siteIdentityMismatchCount: builder.slot(
        countsWithSelectors,
        "siteIdentityMismatchCount",
      ),
      payloadMissingFactCount: builder.slot(
        countsWithSelectors,
        "payloadMissingFactCount",
      ),
      siteId: builder.slot(countsWithSelectors, "siteId"),
      entityId: builder.slot(countsWithSelectors, "entityId"),
    });
    builder.output(
      PAYLOAD_COMBINED_GUARD_OUTPUT,
      guard,
      payloadGuardNames.map((name) => ({ name, slot: name })),
    );
    const scopeFields = [
      "matched",
      "rawCount",
      "nullActivityIdCount",
      "siteIdentityMismatchCount",
      "payloadMissingFactCount",
      "siteId",
      "entityId",
    ] as const;
    builder.output(
      PAYLOAD_COMBINED_SCOPE_OUTPUT,
      scopeRows,
      scopeFields.map((name) => ({ name, slot: name })),
    );
    return undefined;
  }
  const matched =
    numericCompatibilityFields.length === 0
      ? builder.filter(countsWithSelectors, filterMatch)
      : builder.filter(
          countsWithSelectors,
          builder.or(
            invalidNumericDomain(countsWithSelectors),
            builder.and(
              builder.compare(
                "gt",
                builder.slot(countsWithSelectors, "anchorContribution"),
                zero,
              ),
              builder.isNull(
                builder.slot(countsWithSelectors, "entityId"),
                true,
              ),
              builder.compare(
                "neq",
                builder.slot(countsWithSelectors, "entityId"),
                builder.literal("", { kind: "scalar", scalar: "string" }),
              ),
              filterMatch,
            ),
          ),
        );
  if (combined) {
    const stringType = { kind: "scalar", scalar: "string" } as const;
    const summary = builder.aggregate(totals, {}, [
      {
        name: "combinedRawCount",
        kind: "sum",
        expression: builder.slot(totals, "guardRawCountContribution"),
      },
      {
        name: "combinedNullActivityIdCount",
        kind: "sum",
        expression: builder.slot(totals, "guardNullActivityIdContribution"),
      },
      {
        name: "combinedSiteIdentityMismatchCount",
        kind: "sum",
        expression: builder.slot(
          totals,
          "guardSiteIdentityMismatchContribution",
        ),
      },
      ...numericCompatibilityFields.map((field) => ({
        name: field.invalidCountOutput,
        kind: "sum" as const,
        expression: builder.slot(totals, field.invalidCountOutput),
      })),
    ]);
    const controlsBase = qualificationOnly
      ? builder.project(summary, {
          rawCount: builder.coalesce(
            builder.slot(summary, "combinedRawCount"),
            zero,
          ),
          nullActivityIdCount: builder.coalesce(
            builder.slot(summary, "combinedNullActivityIdCount"),
            zero,
          ),
          siteIdentityMismatchCount: builder.coalesce(
            builder.slot(summary, "combinedSiteIdentityMismatchCount"),
            zero,
          ),
          ...Object.fromEntries(
            numericCompatibilityFields.map((field) => [
              field.invalidCountOutput,
              builder.coalesce(
                builder.slot(summary, field.invalidCountOutput),
                zero,
              ),
            ]),
          ),
        })
      : undefined;
    const guardRow = qualificationOnly
      ? undefined
      : builder.project(summary, {
          rowKind: builder.literal("guard", stringType),
          rawCount: builder.coalesce(
            builder.slot(summary, "combinedRawCount"),
            zero,
          ),
          nullActivityIdCount: builder.coalesce(
            builder.slot(summary, "combinedNullActivityIdCount"),
            zero,
          ),
          siteIdentityMismatchCount: builder.coalesce(
            builder.slot(summary, "combinedSiteIdentityMismatchCount"),
            zero,
          ),
          ...Object.fromEntries(
            numericCompatibilityFields.map((field) => [
              field.invalidCountOutput,
              builder.coalesce(
                builder.slot(summary, field.invalidCountOutput),
                zero,
              ),
            ]),
          ),
          siteId: builder.literal("", stringType),
          entityId: builder.literal("", stringType),
        });
    if (qualificationOnly) {
      if (!controlsBase)
        throw new Error("advanced_count_qualification_controls_missing");
      const stringType = { kind: "scalar", scalar: "string" } as const;
      const numberType = { kind: "scalar", scalar: "number" } as const;
      const siteId = builder.slot(matched, "siteId");
      const entityId = builder.slot(matched, "entityId");
      const invalidMatches = builder.filter(
        matched,
        builder.or(
          builder.isNull(siteId),
          builder.compare("eq", siteId, builder.literal("", stringType)),
          builder.compare(
            "neq",
            siteId,
            builder.literal(input.subject.siteIds[0]!, stringType),
          ),
          builder.isNull(entityId),
          builder.compare("eq", entityId, builder.literal("", stringType)),
        ),
      );
      const invalidIdentitySummary = builder.aggregate(invalidMatches, {}, [
        { name: "invalidIdentityCount", kind: "count-rows" },
      ]);
      const identityGroups = builder.aggregate(matched, { siteId, entityId }, [
        { name: "identityMultiplicity", kind: "count-rows" },
      ]);
      const repeatedIdentityGroups = builder.filter(
        identityGroups,
        builder.compare(
          "gt",
          builder.slot(identityGroups, "identityMultiplicity"),
          builder.literal(1, numberType),
        ),
      );
      const repeatedIdentitySummary = builder.aggregate(
        repeatedIdentityGroups,
        {},
        [{ name: "duplicateIdentityCount", kind: "count-rows" }],
      );
      const withInvalidIdentity = builder.join(
        controlsBase,
        invalidIdentitySummary,
        [],
      );
      const withIdentityControls = builder.join(
        withInvalidIdentity,
        repeatedIdentitySummary,
        [],
      );
      const controlsProjection: Record<string, LogicalExpressionHandle> = {
        rawCount: builder.slot(withIdentityControls, "rawCount"),
        nullActivityIdCount: builder.slot(
          withIdentityControls,
          "nullActivityIdCount",
        ),
        siteIdentityMismatchCount: builder.slot(
          withIdentityControls,
          "siteIdentityMismatchCount",
        ),
        entityKind: builder.literal(input.scope, stringType),
        invalidIdentityCount: builder.slot(
          withIdentityControls,
          "right.invalidIdentityCount",
        ),
        duplicateIdentityCount: builder.slot(
          withIdentityControls,
          "right.duplicateIdentityCount",
        ),
      };
      for (const field of numericCompatibilityFields)
        controlsProjection[field.invalidCountOutput] = builder.slot(
          withIdentityControls,
          field.invalidCountOutput,
        );
      const controls = builder.project(
        withIdentityControls,
        controlsProjection,
      );
      return {
        matches: matched,
        controls,
        groupedSummary: totals,
        numericCompatibilityFields: numericCompatibilityFields.map(
          ({ fieldId, invalidCountOutput }) => ({
            fieldId,
            invalidCountOutput,
          }),
        ),
        comparisonProvenance: Object.freeze([
          ...comparisonProvenanceByKey.values(),
        ]),
        scope: input.scope,
        subject: input.subject,
      };
    }
    if (!guardRow) throw new Error("advanced_count_combined_guard_row_missing");
    const matchRows = builder.project(matched, {
      rowKind: builder.literal("match", stringType),
      rawCount: zero,
      nullActivityIdCount: zero,
      siteIdentityMismatchCount: zero,
      ...Object.fromEntries(
        numericCompatibilityFields.map((field) => [
          field.invalidCountOutput,
          zero,
        ]),
      ),
      siteId: builder.slot(matched, "siteId"),
      entityId: builder.slot(matched, "entityId"),
    });
    const outputFields = [
      "rowKind",
      "rawCount",
      "nullActivityIdCount",
      "siteIdentityMismatchCount",
      ...numericCompatibilityFields.map((field) => field.invalidCountOutput),
      "siteId",
      "entityId",
    ] as const;
    const rows = builder.appendRows([guardRow, matchRows], outputFields);
    builder.output(
      COMBINED_COUNT_OUTPUT,
      rows,
      outputFields.map((name) => ({ name, slot: name })),
    );
    return undefined;
  }
  if (numericCompatibilityFields.length === 0) {
    const output = builder.project(matched, {
      siteId: builder.slot(matched, "siteId"),
      entityId: builder.slot(matched, "entityId"),
    });
    builder.output(MATCHED_IDENTITY_OUTPUT, output, [
      { name: "siteId", slot: "siteId" },
      { name: "entityId", slot: "entityId" },
    ]);
    return undefined;
  }

  const stringType = { kind: "scalar", scalar: "string" } as const;
  const numericCompatibilityNames = numericCompatibilityFields.map(
    (field) => field.invalidCountOutput,
  );
  const matchedRows = builder.project(matched, {
    rowKind: builder.caseWhen(
      [
        {
          when: invalidNumericDomain(matched),
          then: builder.literal("numeric-domain", stringType),
        },
      ],
      builder.literal("match", stringType),
    ),
    siteId: builder.slot(matched, "siteId"),
    entityId: builder.slot(matched, "entityId"),
    ...Object.fromEntries(
      numericCompatibilityNames.map((name) => [
        name,
        builder.slot(matched, name),
      ]),
    ),
  });
  const outputNames = [
    "rowKind",
    "siteId",
    "entityId",
    ...numericCompatibilityNames,
  ];
  builder.output(
    MATCHED_IDENTITY_OUTPUT,
    matchedRows,
    outputNames.map((name) => ({ name, slot: name })),
  );
  return undefined;
}

function appendEventCandidateCountQualification(
  builder: LogicalPlanBuilder,
  input: AdvancedEventCandidateCountPlanInput,
): AdvancedCountQualificationFragment<"event"> {
  const exactRange =
    input.candidateRange.startMs === input.readRange.startMs &&
    input.candidateRange.endExclusiveMs === input.readRange.endExclusiveMs &&
    input.candidateRange.startMs === input.expressionRange.startMs &&
    input.candidateRange.endExclusiveMs ===
      input.expressionRange.endExclusiveMs;
  if (
    input.subject.siteIds.length !== 1 ||
    input.expressionUsesExplicitRange ||
    !exactRange ||
    input.lowerBounds.length !== 1 ||
    input.lowerBounds[0]?.siteId !== input.subject.siteIds[0] ||
    input.lowerBounds[0]?.startMs !== input.candidateRange.startMs
  )
    throw new Error("advanced_count_event_candidate_plan_not_applicable");

  const root = input.analysis.document.root;
  if (!root)
    throw new Error("advanced_count_event_candidate_plan_requires_root");
  const selectorCounts = countSelectorContributions(root);
  const scalarCollections = scalarCollectionContributions(root);
  if (scalarCollections.size > 0)
    throw new Error(
      "advanced_count_event_candidate_scalar_reducer_unsupported",
    );
  const numericCompatibilityRequirements =
    matchNumericCompatibilityRequirements({
      root,
      numericCompatibilityRequirements: input.numericCompatibilityRequirements,
      numericCompatibilityFieldIds: input.numericCompatibilityFieldIds,
    });
  const numericCompatibilityFields = numericCompatibilityRequirements.map(
    ({ fieldId }): Extract<AdvancedCountSelectorField, { kind: "number" }> => {
      const field = advancedCountSelectorField(fieldId);
      if (!field || field.kind !== "number")
        throw new Error(
          "advanced_count_event_candidate_unchecked_numeric_field",
        );
      return field;
    },
  );
  const numericCompatibilityDomains = new Map(
    numericCompatibilityRequirements.map(({ fieldId, domain }) => [
      fieldId,
      domain,
    ]),
  );
  const numericCompatibilityProofs = new Map(
    numericCompatibilityRequirements.map(({ fieldId, proof }) => [
      fieldId,
      proof ?? "safe-number",
    ]),
  );
  const bareFields = bareFieldContributions(root, false);
  const selectorAttributes = new Set<string>();
  for (const { input: selector } of selectorCounts.values()) {
    if (selector.collection.kind !== "entity-root")
      throw new Error("advanced_count_event_candidate_selector_unchecked");
    if (
      selector.collection.entity !== "page" &&
      selector.collection.entity !== "event"
    )
      throw new Error("advanced_count_event_candidate_selector_unchecked");
    collectSelectorPredicateAttributes(
      selector.predicate,
      selector.collection.entity,
      selectorAttributes,
    );
  }
  const bareAttributes = new Set<string>();
  collectBareFieldAttributes(bareFields, bareAttributes);
  const numericAttributes = numericCompatibilityFields.flatMap((field) => [
    field.valueAttribute,
    numericCompatibilityProofs.get(field.fieldId) === "exact-aggregate"
      ? field.exactAggregateAttribute
      : field.safeRangeAttribute,
  ]);
  const attributes = [
    ...COUNT_ATTRIBUTES,
    "observation.id",
    "observation.sessionId",
    "observation.visitId",
    "observation.siteIdentityConsistent",
    ...selectorAttributes,
    ...bareAttributes,
    ...numericAttributes,
  ];
  const source = builder.source("observation", {
    temporalDomain: "candidate",
    attributes: [...new Set(attributes)],
    includeOccurrenceTime: true,
  });
  const eligible = eligibleAdvancedFilterActivities(builder, source);
  // Count the M+1 bounded prefix independently. Reports, summaries, and
  // diagnostics consume admittedRows: the full bag under the cap, empty above.
  const bounded = builder.limit(eligible, ADVANCED_FILTER_ACTIVITY_LIMIT);
  const counter = builder.aggregate(bounded, {}, [
    { name: "rawCount", kind: "count-rows" },
  ]);
  const admittedCounter = builder.filter(
    counter,
    builder.compare(
      "lte",
      builder.slot(counter, "rawCount"),
      builder.literal(ADVANCED_FILTER_MAX_ACTIVITIES, {
        kind: "scalar",
        scalar: "number",
      }),
    ),
  );
  const countControl = builder.project(counter, {
    rawCount: builder.slot(counter, "rawCount"),
  });
  const boundedRowsWithAdmission = builder.join(bounded, admittedCounter, []);
  const admittedRows = builder.project(
    boundedRowsWithAdmission,
    Object.fromEntries(
      Object.keys(bounded.slots).map((name) => [
        name,
        builder.slot(boundedRowsWithAdmission, name),
      ]),
    ),
  );
  const zero = builder.literal(0, { kind: "scalar", scalar: "number" });
  const one = builder.literal(1, { kind: "scalar", scalar: "number" });
  const string = (value: string) =>
    builder.literal(value, { kind: "scalar", scalar: "string" });
  const kind = builder.slot(admittedRows, "attribute:observation.kind");
  const siteId = builder.slot(admittedRows, "attribute:observation.rawSiteId");
  const activityContribution = (activityKind: "page" | "event") =>
    builder.caseWhen(
      [
        {
          when: builder.compare("eq", kind, string(activityKind)),
          then: one,
        },
      ],
      zero,
    );
  const selectorContribution = (
    contribution: CountSelectorContribution,
  ): LogicalExpressionHandle => {
    if (contribution.input.collection.kind !== "entity-root")
      throw new Error("advanced_count_event_candidate_selector_unchecked");
    const collection = contribution.input.collection.entity;
    if (collection !== "page" && collection !== "event")
      throw new Error("advanced_count_event_candidate_selector_unchecked");
    return builder.caseWhen(
      [
        {
          when: builder.and(
            builder.compare("eq", kind, string(collection)),
            selectorPredicateExpression(
              builder,
              admittedRows,
              collection,
              contribution.input.predicate,
              new Map(),
            ),
          ),
          then: one,
        },
      ],
      zero,
    );
  };
  const numericCompatibilityContribution = (
    field: Extract<AdvancedCountSelectorField, { kind: "number" }>,
  ): LogicalExpressionHandle => {
    const raw = builder.slot(admittedRows, `attribute:${field.valueAttribute}`);
    const rangeAttribute =
      numericCompatibilityProofs.get(field.fieldId) === "exact-aggregate"
        ? field.exactAggregateAttribute
        : field.safeRangeAttribute;
    const validRange = builder.slot(
      admittedRows,
      `attribute:${rangeAttribute}`,
    );
    const rowKind = builder.slot(admittedRows, "attribute:observation.kind");
    const isPage = builder.compare("eq", rowKind, string("page"));
    const isEvent = builder.compare("eq", rowKind, string("event"));
    const domain = numericCompatibilityDomains.get(field.fieldId)!;
    return builder.caseWhen(
      [
        {
          when: builder.and(
            domain === "page-only" ? isPage : builder.or(isPage, isEvent),
            builder.isNull(raw, true),
            builder.not(validRange),
          ),
          then: one,
        },
      ],
      zero,
    );
  };
  const measures = [
    {
      name: "pageCount",
      kind: "sum" as const,
      expression: activityContribution("page"),
    },
    {
      name: "eventCount",
      kind: "sum" as const,
      expression: activityContribution("event"),
    },
    ...[...selectorCounts.values()].map((contribution) => ({
      name: contribution.name,
      kind: "sum" as const,
      expression: selectorContribution(contribution),
    })),
  ];
  const summary = (rootAttribute: "observation.sessionId" | "observation.id") =>
    builder.aggregate(
      admittedRows,
      {
        siteId,
        rootId: builder.slot(admittedRows, `attribute:${rootAttribute}`),
      },
      measures,
    );
  const sessionSummary = summary("observation.sessionId");
  const localIdSummary = summary("observation.id");
  const rawControls = builder.aggregate(admittedRows, {}, [
    {
      name: "nullActivityIdCount",
      kind: "sum",
      expression: builder.caseWhen(
        [
          {
            when: builder.isNull(
              builder.slot(admittedRows, "attribute:observation.id"),
            ),
            then: one,
          },
        ],
        zero,
      ),
    },
    {
      name: "siteIdentityMismatchCount",
      kind: "sum",
      expression: builder.caseWhen(
        [
          {
            when: builder.not(
              builder.slot(
                admittedRows,
                "attribute:observation.siteIdentityConsistent",
              ),
            ),
            then: one,
          },
        ],
        zero,
      ),
    },
    ...numericCompatibilityFields.map((field) => ({
      name: field.invalidCountOutput,
      kind: "sum" as const,
      expression: numericCompatibilityContribution(field),
    })),
  ]);
  const controlsBase = builder.project(
    rawControls,
    Object.fromEntries([
      [
        "nullActivityIdCount",
        builder.coalesce(
          builder.slot(rawControls, "nullActivityIdCount"),
          zero,
        ),
      ],
      [
        "siteIdentityMismatchCount",
        builder.coalesce(
          builder.slot(rawControls, "siteIdentityMismatchCount"),
          zero,
        ),
      ],
      ...numericCompatibilityFields.map((field) => [
        field.invalidCountOutput,
        builder.coalesce(
          builder.slot(rawControls, field.invalidCountOutput),
          zero,
        ),
      ]),
    ]),
  );
  const rawSessionId = builder.slot(
    admittedRows,
    "attribute:observation.sessionId",
  );
  const hasSession = builder.and(
    builder.isNull(rawSessionId, true),
    builder.compare("neq", rawSessionId, string("")),
  );
  const noSession = builder.or(
    builder.isNull(rawSessionId),
    builder.compare("eq", rawSessionId, string("")),
  );
  const sessionCandidates = builder.filter(admittedRows, hasSession);
  const localIdCandidates = builder.filter(admittedRows, noSession);
  const joinSummary = (
    candidates: LogicalRelationHandle,
    grouped: LogicalRelationHandle,
    rootAttribute: "observation.sessionId" | "observation.id",
  ) =>
    builder.join(
      candidates,
      grouped,
      [
        { left: "attribute:observation.rawSiteId", right: "siteId" },
        { left: `attribute:${rootAttribute}`, right: "rootId" },
      ],
      "left",
    );
  const matchedRootCandidates = [
    joinSummary(sessionCandidates, sessionSummary, "observation.sessionId"),
    joinSummary(localIdCandidates, localIdSummary, "observation.id"),
  ];
  const projectedCandidateNames = [
    "siteId",
    "entityId",
    "candidateKind",
    "visitId",
    "pageCount",
    "eventCount",
    ...[...selectorCounts.values()].map(({ name }) => name),
    ...[
      ...new Set([
        ...bareAttributes,
        ...[...bareFields.values()].map(({ field }) => field.valueAttribute),
      ]),
    ].map((attribute) => `attribute:${attribute}`),
  ];
  const candidateRows = matchedRootCandidates.map((relation) =>
    builder.project(relation, {
      siteId: builder.slot(relation, "attribute:observation.rawSiteId"),
      entityId: builder.slot(relation, "attribute:observation.id"),
      candidateKind: builder.slot(relation, "attribute:observation.kind"),
      visitId: builder.slot(relation, "attribute:observation.visitId"),
      pageCount: builder.coalesce(
        builder.slot(relation, "right.pageCount"),
        zero,
      ),
      eventCount: builder.coalesce(
        builder.slot(relation, "right.eventCount"),
        zero,
      ),
      ...Object.fromEntries(
        [...selectorCounts.values()].map(({ name }) => [
          name,
          builder.coalesce(builder.slot(relation, `right.${name}`), zero),
        ]),
      ),
      ...Object.fromEntries(
        [
          ...new Set([
            ...bareAttributes,
            ...[...bareFields.values()].map(
              ({ field }) => field.valueAttribute,
            ),
          ]),
        ].map((attribute) => [
          `attribute:${attribute}`,
          builder.slot(relation, `attribute:${attribute}`),
        ]),
      ),
    }),
  );
  const candidates = builder.appendRows(candidateRows, projectedCandidateNames);
  const filterMatch = predicateExpression(
    builder,
    candidates,
    root,
    selectorCounts,
    scalarCollections,
    bareFields,
    "candidate",
  );
  const matchingCandidates = builder.filter(candidates, filterMatch);
  const matches = builder.project(matchingCandidates, {
    siteId: builder.slot(matchingCandidates, "siteId"),
    entityId: builder.slot(matchingCandidates, "entityId"),
    candidateKind: builder.slot(matchingCandidates, "candidateKind"),
    visitId: builder.slot(matchingCandidates, "visitId"),
  });
  const invalidMatches = builder.filter(
    matches,
    builder.or(
      builder.isNull(builder.slot(matches, "siteId")),
      builder.compare("eq", builder.slot(matches, "siteId"), string("")),
      builder.compare(
        "neq",
        builder.slot(matches, "siteId"),
        string(input.subject.siteIds[0]!),
      ),
      builder.isNull(builder.slot(matches, "entityId")),
      builder.compare("eq", builder.slot(matches, "entityId"), string("")),
      builder.and(
        builder.compare(
          "neq",
          builder.slot(matches, "candidateKind"),
          string("page"),
        ),
        builder.compare(
          "neq",
          builder.slot(matches, "candidateKind"),
          string("event"),
        ),
      ),
    ),
  );
  const invalidIdentitySummary = builder.aggregate(invalidMatches, {}, [
    { name: "invalidIdentityCount", kind: "count-rows" },
  ]);
  const identityGroups = builder.aggregate(
    matches,
    {
      siteId: builder.slot(matches, "siteId"),
      candidateKind: builder.slot(matches, "candidateKind"),
      entityId: builder.slot(matches, "entityId"),
    },
    [{ name: "identityMultiplicity", kind: "count-rows" }],
  );
  const repeatedIdentityGroups = builder.filter(
    identityGroups,
    builder.compare(
      "gt",
      builder.slot(identityGroups, "identityMultiplicity"),
      one,
    ),
  );
  const duplicateIdentitySummary = builder.aggregate(
    repeatedIdentityGroups,
    {},
    [{ name: "duplicateIdentityCount", kind: "count-rows" }],
  );
  const withRawControls = builder.join(countControl, controlsBase, []);
  const withInvalidIdentity = builder.join(
    withRawControls,
    invalidIdentitySummary,
    [],
  );
  const withIdentityControls = builder.join(
    withInvalidIdentity,
    duplicateIdentitySummary,
    [],
  );
  const controls = builder.project(withIdentityControls, {
    rawCount: builder.slot(withIdentityControls, "rawCount"),
    nullActivityIdCount: builder.slot(
      withIdentityControls,
      "right.nullActivityIdCount",
    ),
    siteIdentityMismatchCount: builder.slot(
      withIdentityControls,
      "right.siteIdentityMismatchCount",
    ),
    entityKind: string("event"),
    invalidIdentityCount: builder.coalesce(
      builder.slot(withIdentityControls, "right.invalidIdentityCount"),
      zero,
    ),
    duplicateIdentityCount: builder.coalesce(
      builder.slot(withIdentityControls, "right.duplicateIdentityCount"),
      zero,
    ),
    ...Object.fromEntries(
      numericCompatibilityFields.map((field) => [
        field.invalidCountOutput,
        builder.slot(withIdentityControls, `right.${field.invalidCountOutput}`),
      ]),
    ),
  });
  return {
    matches,
    controls,
    groupedSummary: sessionSummary,
    additionalGroupedSummaries: [localIdSummary],
    numericCompatibilityFields: numericCompatibilityFields.map(
      ({ fieldId, invalidCountOutput }) => ({ fieldId, invalidCountOutput }),
    ),
    comparisonProvenance: Object.freeze([]),
    scope: "event",
    candidateGrain: "event-candidate",
    subject: input.subject,
  };
}

export const ADVANCED_COUNT_FILTER_OUTPUTS = {
  guard: GUARDED_ACTIVITY_OUTPUT,
  matches: MATCHED_IDENTITY_OUTPUT,
  combined: COMBINED_COUNT_OUTPUT,
  payloadCombinedGuard: PAYLOAD_COMBINED_GUARD_OUTPUT,
  payloadCombinedScope: PAYLOAD_COMBINED_SCOPE_OUTPUT,
} as const;
