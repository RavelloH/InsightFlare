import {
  aggregate,
  and,
  callFunction,
  caseWhen,
  constant,
  count,
  eq,
  isNotNull,
  limit,
  not,
  param,
  trimCharacters,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  SqlExpression,
} from "@/lib/db/query/expression";
import type { LogicalExpr } from "@/lib/edge/analytics/engine/logical/expression";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type {
  LogicalPlan,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import type { LogicalSlot } from "@/lib/edge/analytics/engine/logical/slots";
import type {
  QualifiedGeoComparisonProvenance,
  QualifiedGeoRawCountEligibilityWitness,
} from "@/lib/edge/analytics/engine/semantic/count-bare-fields";

import type { AnalyticsDbRelation } from "./analytics-relational-storage";

export type RegisteredComparisonAdmissionField =
  QualifiedGeoComparisonProvenance["fieldId"];

export interface RegisteredComparisonAdmissionDescriptor {
  readonly kind: "comparison";
  readonly fieldId: RegisteredComparisonAdmissionField;
  readonly outputName: string;
  readonly semanticProfile: "case-folded-text";
  readonly adapterDomain: "ascii-text-no-nul";
}

export interface LoweredComparisonAdmissionInput {
  readonly relation: AnalyticsDbRelation;
  readonly values: readonly {
    readonly fieldId: RegisteredComparisonAdmissionField;
    readonly outputName: string;
    readonly value: AnyExpression;
  }[];
}

export interface CompletedComparisonDomainAdmission {
  readonly input: LoweredComparisonAdmissionInput;
  readonly aggregate: AnalyticsDbRelation;
}

export interface ComparisonAdmissionLowererReader {
  readComparisonAdmissionInput(
    relationId: RelationId,
    slotId: SlotId,
  ):
    | {
        readonly relation: AnalyticsDbRelation;
        readonly valueColumn: string;
      }
    | undefined;
}

const ASCII_ECMASCRIPT_TRIM = "\u0009\u000a\u000b\u000c\u000d\u0020";

interface RegisteredComparisonSource {
  readonly attributeId: string;
  readonly valueContract: "request-cf-javascript-string";
}

function registeredComparisonSource(
  fieldId: RegisteredComparisonAdmissionField,
): RegisteredComparisonSource {
  switch (fieldId) {
    case "geo.country":
      return {
        attributeId: "observation.contextPageCountry",
        valueContract: "request-cf-javascript-string",
      };
    case "geo.region":
      return {
        attributeId: "observation.contextPageRegion",
        valueContract: "request-cf-javascript-string",
      };
  }
}

function comparisonOutputName(
  fieldId: RegisteredComparisonAdmissionField,
): string {
  switch (fieldId) {
    case "geo.country":
      return "invalidComparisonGeoCountryCount";
    case "geo.region":
      return "invalidComparisonGeoRegionCount";
  }
}

function isAsciiWithoutNul(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code > 0x7f) return false;
  }
  return true;
}

function sameRange(
  left: { readonly startMs: number; readonly endExclusiveMs: number },
  right: { readonly startMs: number; readonly endExclusiveMs: number },
): boolean {
  return (
    left.startMs === right.startMs &&
    left.endExclusiveMs === right.endExclusiveMs
  );
}

function resolveAttributeLineage(
  slots: ReadonlyMap<SlotId, LogicalSlot>,
  slotId: SlotId,
): string | undefined {
  const seen = new Set<SlotId>();
  let current = slotId;
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const slot = slots.get(current);
    if (!slot) return undefined;
    if (slot.type.kind !== "scalar" || slot.type.scalar !== "string")
      return undefined;
    if (slot.lineage.kind === "attribute") return slot.lineage.attribute;
    if (slot.lineage.kind !== "alias") return undefined;
    current = slot.lineage.source;
  }
}

function validateWitness(
  plan: LogicalPlan,
  siteId: string,
  scope: "session" | "visitor",
  witness: QualifiedGeoRawCountEligibilityWitness,
): boolean {
  const time = plan.context.time;
  const subjectSites = plan.context.subject.siteIds;
  return (
    witness.kind === "candidate-eligible-activity-count" &&
    witness.siteId === siteId &&
    witness.scope === scope &&
    witness.subjectSiteIds.length === 1 &&
    witness.subjectSiteIds[0] === siteId &&
    subjectSites.length === 1 &&
    subjectSites[0] === siteId &&
    plan.context.scope.contractScope === scope &&
    time.filter === undefined &&
    sameRange(time.candidate, witness.candidateRange) &&
    time.read.kind === "bounded" &&
    sameRange(time.read.range, witness.readRange) &&
    sameRange(witness.candidateRange, witness.readRange) &&
    witness.rawCountMaximum === 20_000 &&
    witness.rawCountObservationLimit === 20_001 &&
    witness.activityEligibility === "page-or-same-site-event"
  );
}

function validatePlanProvenance(
  plan: ValidatedLogicalPlan,
  provenance: readonly QualifiedGeoComparisonProvenance[],
  input: {
    readonly siteId: string;
    readonly scope: "session" | "visitor";
    readonly reportSourceRelationIds: readonly RelationId[];
    readonly rawCountEligibilityWitness: QualifiedGeoRawCountEligibilityWitness;
  },
): readonly QualifiedGeoComparisonProvenance[] {
  if (
    !Object.isFrozen(plan) ||
    !Object.isFrozen(plan.nodes) ||
    !Object.isFrozen(plan.slots) ||
    !validateWitness(
      plan,
      input.siteId,
      input.scope,
      input.rawCountEligibilityWitness,
    ) ||
    provenance.length === 0
  )
    throw new Error("comparison_domain_admission_binding_invalid");

  const slots = new Map(plan.slots.map((slot) => [slot.id, slot]));
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const reports = new Set(input.reportSourceRelationIds);
  const seenPredicates = new Set<string>();
  const relations = new Set<RelationId>();
  const fields = new Set<RegisteredComparisonAdmissionField>();
  const validated: QualifiedGeoComparisonProvenance[] = [];

  for (const candidate of provenance) {
    const node = nodes.get(candidate.relationId);
    const source = registeredComparisonSource(candidate.fieldId);
    const attribute = source.attributeId;
    const slot = slots.get(candidate.slotId);
    const key = JSON.stringify([
      candidate.fieldId,
      candidate.relationId,
      candidate.slotId,
      candidate.operator,
      candidate.literalValues,
    ]);
    if (
      !node ||
      !node.output.includes(candidate.slotId) ||
      reports.has(candidate.relationId) ||
      source.valueContract !== "request-cf-javascript-string" ||
      !slot ||
      !attribute ||
      candidate.attributeId !== attribute ||
      candidate.semanticProfile !== "case-folded-text" ||
      candidate.normalization !== "trim-case-fold" ||
      (!candidate.temporalDomains.includes("candidate") &&
        !candidate.temporalDomains.includes("read")) ||
      (candidate.operator !== "eq" && candidate.operator !== "in") ||
      candidate.literalValues.length === 0 ||
      candidate.literalValues.some((value) => !isAsciiWithoutNul(value)) ||
      resolveAttributeLineage(slots, candidate.slotId) !== attribute ||
      JSON.stringify(candidate.rawCountEligibilityWitness) !==
        JSON.stringify(input.rawCountEligibilityWitness) ||
      seenPredicates.has(key)
    )
      throw new Error("comparison_domain_admission_provenance_invalid");
    seenPredicates.add(key);
    relations.add(candidate.relationId);
    fields.add(candidate.fieldId);
    validated.push(
      Object.freeze({
        ...candidate,
        literalValues: Object.freeze([...candidate.literalValues]),
        temporalDomains: Object.freeze([...candidate.temporalDomains]),
      }),
    );
  }

  if (relations.size !== 1 || fields.size === 0)
    throw new Error("comparison_domain_admission_source_relation_ambiguous");
  return Object.freeze(validated);
}

function matchesLiteralValues(
  values: readonly unknown[],
  expected: readonly string[],
): boolean {
  return (
    values.length === expected.length &&
    values.every((value, index) => value === expected[index])
  );
}

function expressionMatchesProvenance(
  expression: LogicalExpr,
  relationId: RelationId,
  candidate: QualifiedGeoComparisonProvenance,
): boolean {
  if (
    expression.kind === "comparison" &&
    expression.operator === "eq" &&
    expression.stringNormalization === "trim-case-fold" &&
    relationId === candidate.relationId &&
    expression.left.kind === "slot" &&
    expression.left.slot === candidate.slotId &&
    expression.right.kind === "literal" &&
    typeof expression.right.value === "string"
  )
    return (
      candidate.operator === "eq" &&
      matchesLiteralValues([expression.right.value], candidate.literalValues)
    );

  if (
    expression.kind === "set-membership" &&
    !expression.negated &&
    expression.stringNormalization === "trim-case-fold" &&
    relationId === candidate.relationId &&
    expression.input.kind === "slot" &&
    expression.input.slot === candidate.slotId &&
    expression.values.every(
      (value) => value.kind === "literal" && typeof value.value === "string",
    )
  )
    return (
      candidate.operator === "in" &&
      matchesLiteralValues(
        expression.values.map(({ value }) => value),
        candidate.literalValues,
      )
    );
  return false;
}

export class RegisteredComparisonAdmissionBinding {
  readonly plan: ValidatedLogicalPlan;
  readonly descriptors: readonly RegisteredComparisonAdmissionDescriptor[];
  readonly #provenance: readonly QualifiedGeoComparisonProvenance[];
  #owner: object | undefined;
  #active = false;
  #used = false;
  #materialized = false;

  constructor(input: {
    readonly plan: ValidatedLogicalPlan;
    readonly provenance: readonly QualifiedGeoComparisonProvenance[];
    readonly siteId: string;
    readonly scope: "session" | "visitor";
    readonly reportSourceRelationIds: readonly RelationId[];
    readonly rawCountEligibilityWitness: QualifiedGeoRawCountEligibilityWitness;
  }) {
    this.plan = input.plan;
    this.#provenance = validatePlanProvenance(
      input.plan,
      input.provenance,
      input,
    );
    const byField = new Map<
      RegisteredComparisonAdmissionField,
      RegisteredComparisonAdmissionDescriptor
    >();
    for (const item of this.#provenance)
      byField.set(
        item.fieldId,
        Object.freeze({
          kind: "comparison",
          fieldId: item.fieldId,
          outputName: comparisonOutputName(item.fieldId),
          semanticProfile: "case-folded-text",
          adapterDomain: "ascii-text-no-nul",
        }),
      );
    this.descriptors = Object.freeze([...byField.values()]);
  }

  attach(owner: object, plan: ValidatedLogicalPlan): boolean {
    if (this.#owner || this.plan !== plan || !Object.isFrozen(plan))
      return false;
    this.#owner = owner;
    return true;
  }

  begin(
    owner: object,
    plan: ValidatedLogicalPlan,
    selectedRelationIds: ReadonlySet<RelationId>,
  ): boolean {
    if (
      this.#owner !== owner ||
      this.plan !== plan ||
      this.#used ||
      this.#provenance.some((item) => !selectedRelationIds.has(item.relationId))
    )
      return false;
    this.#used = true;
    this.#active = true;
    return true;
  }

  authorizesExpression(
    owner: object,
    relationId: RelationId,
    expression: LogicalExpr,
  ): boolean {
    return (
      this.#active &&
      this.#owner === owner &&
      this.#provenance.some((candidate) =>
        expressionMatchesProvenance(expression, relationId, candidate),
      )
    );
  }

  materialize(
    owner: object,
    read: ComparisonAdmissionLowererReader,
  ): LoweredComparisonAdmissionInput | undefined {
    if (this.#owner !== owner || !this.#active || this.#materialized)
      return undefined;
    const groups = new Map<
      RegisteredComparisonAdmissionField,
      QualifiedGeoComparisonProvenance
    >();
    for (const candidate of this.#provenance)
      if (!groups.has(candidate.fieldId))
        groups.set(candidate.fieldId, candidate);

    const lowered = [...groups.values()].map((candidate) => {
      const source = read.readComparisonAdmissionInput(
        candidate.relationId,
        candidate.slotId,
      );
      if (!source)
        throw new Error("comparison_domain_admission_lowered_slot_missing");
      return {
        candidate,
        relation: source.relation,
        valueColumn: source.valueColumn,
      };
    });
    const first = lowered[0];
    if (!first || lowered.some((item) => item.relation !== first.relation))
      throw new Error("comparison_domain_admission_lowered_relation_mismatch");
    const witness = first.candidate.rawCountEligibilityWitness;
    const source = limit(first.relation, witness.rawCountObservationLimit);
    const values = lowered.map(({ candidate, valueColumn }) => {
      const value = source.columns[valueColumn];
      if (!value)
        throw new Error("comparison_domain_admission_lowered_slot_missing");
      return {
        fieldId: candidate.fieldId,
        outputName: comparisonOutputName(candidate.fieldId),
        value,
      };
    });
    this.#materialized = true;
    return Object.freeze({ relation: source, values: Object.freeze(values) });
  }

  finish(owner: object): void {
    if (this.#owner !== owner || !this.#active)
      throw new Error("comparison_domain_admission_lowering_state_invalid");
    this.#active = false;
  }
}

export function createRegisteredComparisonAdmissionBinding(input: {
  readonly plan: ValidatedLogicalPlan;
  readonly provenance: readonly QualifiedGeoComparisonProvenance[];
  readonly siteId: string;
  readonly scope: "session" | "visitor";
  readonly reportSourceRelationIds: readonly RelationId[];
  readonly rawCountEligibilityWitness: QualifiedGeoRawCountEligibilityWitness;
}): RegisteredComparisonAdmissionBinding {
  return new RegisteredComparisonAdmissionBinding(input);
}

export function asciiTextNoNulPredicate(value: AnyExpression) {
  const textClass = eq(callFunction("storage-class", value), param("text"));
  const byteLength = callFunction(
    "byte-length",
    value as SqlExpression<string | ArrayBuffer | ArrayBufferView | null>,
  );
  const characterLength = callFunction(
    "length",
    value as SqlExpression<string | ArrayBuffer | ArrayBufferView | null>,
  );
  return and(textClass, eq(byteLength, characterLength));
}

/** Total normalized value: outside the admitted domain, return SQL NULL. */
export function normalizeAsciiCaseFoldedText(
  value: AnyExpression,
): AnyExpression {
  return caseWhen(
    [
      {
        when: asciiTextNoNulPredicate(value),
        then: callFunction(
          "lower",
          trimCharacters(
            value as SqlExpression<
              string | null,
              ExpressionResultType<"text" | "unknown", boolean>
            >,
            constant(ASCII_ECMASCRIPT_TRIM),
          ),
        ),
      },
    ],
    constant(null),
  );
}

export function comparisonDomainMismatchPredicate(value: AnyExpression) {
  return and(isNotNull(value), not(asciiTextNoNulPredicate(value)));
}

export function buildComparisonDomainAggregate(
  input: LoweredComparisonAdmissionInput,
) {
  const aggregates = Object.fromEntries(
    input.values.map(({ outputName, value }) => [
      outputName,
      count(
        caseWhen(
          [
            {
              when: comparisonDomainMismatchPredicate(value),
              then: constant(1),
            },
          ],
          constant(null),
        ),
      ),
    ]),
  );
  return aggregate(input.relation, { groupBy: {}, aggregates });
}

export function isComparisonDomainSingletonAggregate(
  relation: AnalyticsDbRelation,
  outputNames: readonly string[],
): boolean {
  const node = relation.node;
  const expectedNames = new Set(outputNames);
  const aggregateNames =
    node.kind === "aggregate"
      ? new Set(node.aggregates.map(({ name }) => name))
      : new Set<string>();
  const fieldNames = new Set(relation.fields.map(({ name }) => name));
  return (
    node.kind === "aggregate" &&
    node.groups.length === 0 &&
    outputNames.length > 0 &&
    expectedNames.size === outputNames.length &&
    node.aggregates.length === outputNames.length &&
    aggregateNames.size === outputNames.length &&
    node.aggregates.every(
      ({ name, expression }) =>
        expectedNames.has(name) &&
        expression.kind === "aggregate" &&
        expression.name === "COUNT",
    ) &&
    relation.fields.length === outputNames.length &&
    fieldNames.size === outputNames.length &&
    relation.fields.every(({ name }) => expectedNames.has(name)) &&
    outputNames.every((name) => relation.columns[name] !== undefined)
  );
}
