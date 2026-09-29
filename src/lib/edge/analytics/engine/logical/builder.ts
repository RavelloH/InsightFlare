import type { CalendarGranularity } from "@/lib/edge/analytics/contract/types";
import {
  calendarPeriodLiteral,
  elapsedDurationLiteral,
  type LogicalExpr,
  type LogicalLiteralValue,
  type LogicalStringNormalization,
} from "@/lib/edge/analytics/engine/logical/expression";
import type { LogicalGrain } from "@/lib/edge/analytics/engine/logical/grain";
import {
  grainKeys,
  sameGrainShape,
} from "@/lib/edge/analytics/engine/logical/grain";
import {
  type RelationId,
  relationId,
  type SlotId,
  slotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import {
  type LogicalAggregateMeasure,
  type LogicalNode,
  type ProjectBinding,
  setOperationResultNullable,
  type SortKey,
} from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  LogicalOutputField,
  LogicalPlan,
  LogicalPlanContext,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import type {
  LogicalSlot,
  LogicalValueType,
  SlotLineage,
} from "@/lib/edge/analytics/engine/logical/slots";
import { isSameLogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";
import {
  inferLogicalExpression,
  type InferredLogicalExpression,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/validator";
import {
  semanticAttribute,
  type SemanticAttributeId,
} from "@/lib/edge/analytics/engine/semantic/attributes";
import {
  type AnalyticsEntityKind,
  validateResolvedAnalyticsScope,
} from "@/lib/edge/analytics/engine/semantic/entities";
import type { SemanticRelationshipId } from "@/lib/edge/analytics/engine/semantic/relationships";
import { semanticRelationship } from "@/lib/edge/analytics/engine/semantic/relationships";
import {
  createSemanticTemporalDomains,
  temporalDomainExists,
  type TemporalDomainRef,
} from "@/lib/edge/analytics/engine/semantic/time";
import type {
  CalendarPeriodUnit,
  ElapsedDurationUnit,
} from "@/lib/edge/analytics/engine/semantic/value-types";

export interface LogicalRelationHandle {
  readonly id: RelationId;
  readonly slots: Readonly<Record<string, SlotId>>;
  readonly grain: LogicalGrain;
  readonly entityKey?: SlotId;
  /** Explicit source-domain provenance propagated through relational operators. */
  readonly temporalDomains: readonly TemporalDomainRef[];
}

export interface LogicalExpressionHandle extends InferredLogicalExpression {
  readonly expression: LogicalExpr;
}

export interface LogicalSourceOptions {
  readonly temporalDomain?: TemporalDomainRef;
  readonly attributes?: readonly SemanticAttributeId[];
  readonly relationships?: readonly SemanticRelationshipId[];
  readonly includeOccurrenceTime?: boolean;
}

export interface LogicalAggregateInput {
  readonly name: string;
  readonly kind: LogicalAggregateMeasure["kind"];
  readonly expression?: LogicalExpressionHandle;
}

export interface LogicalOutputInput {
  readonly name: string;
  readonly slot: string;
  readonly semantic?: LogicalOutputField["semantic"];
}

interface InternalRelationState {
  readonly handle: LogicalRelationHandle;
  readonly node: LogicalNode;
}

export class LogicalPlanBuilder {
  readonly #context: LogicalPlanContext;
  readonly #nodes: LogicalNode[] = [];
  readonly #slots: LogicalSlot[] = [];
  readonly #outputs: LogicalPlan["outputs"][number][] = [];
  readonly #slotById = new Map<SlotId, LogicalSlot>();
  readonly #relationById = new Map<RelationId, InternalRelationState>();
  #nextRelationId = 0;
  #nextSlotId = 0;

  get context(): LogicalPlanContext {
    return this.#context;
  }

  constructor(context: LogicalPlanContext) {
    const time = createSemanticTemporalDomains(context.time);
    this.#context = Object.freeze({
      ...context,
      time,
      scope: validateResolvedAnalyticsScope(context.scope),
      subject: Object.freeze({
        ...context.subject,
        siteIds: Object.freeze([...context.subject.siteIds]),
      }),
    });
  }

  source(
    entity: AnalyticsEntityKind,
    options: LogicalSourceOptions = {},
  ): LogicalRelationHandle {
    const temporalDomain = options.temporalDomain ?? "candidate";
    if (!temporalDomainExists(this.#context.time, temporalDomain)) {
      throw new Error(
        `logical_source_invalid_temporal_domain:${temporalDomain}`,
      );
    }
    const values: Extract<LogicalNode, { kind: "source" }>["values"][number][] =
      [];
    const namedSlots: Record<string, SlotId> = {};
    const self = this.#newSlot({ kind: "entity", entity }, false, {
      kind: "entity",
      entity,
    });
    namedSlots.entity = self.id;
    values.push({ kind: "self", slot: self.id });

    for (const relationshipId of options.relationships ?? []) {
      const relationship = semanticRelationship(relationshipId);
      if (!relationship || relationship.from !== entity) {
        throw new Error(
          `logical_source_invalid_relationship:${relationshipId}`,
        );
      }
      const slot = this.#newSlot(
        { kind: "entity", entity: relationship.to },
        relationship.optional,
        { kind: "relationship", relationship: relationship.id },
      );
      const name = `relationship:${relationshipId}`;
      if (name in namedSlots)
        throw new Error(`logical_source_duplicate_name:${name}`);
      namedSlots[name] = slot.id;
      values.push({
        kind: "related-entity",
        slot: slot.id,
        relationship: relationshipId,
      });
    }

    for (const attributeId of options.attributes ?? []) {
      const attribute = semanticAttribute(attributeId);
      const observationFallback =
        entity === "observation" &&
        !!attribute &&
        (attribute.nativeEntity === "page" ||
          attribute.nativeEntity === "event") &&
        attribute.observationKinds.includes(attribute.nativeEntity);
      if (
        !attribute ||
        (attribute.nativeEntity !== entity && !observationFallback)
      ) {
        throw new Error(`logical_source_invalid_attribute:${attributeId}`);
      }
      const slot = this.#newSlot(
        attribute.valueType,
        attribute.nullable || observationFallback,
        { kind: "attribute", attribute: attribute.id },
      );
      const name = `attribute:${attributeId}`;
      if (name in namedSlots)
        throw new Error(`logical_source_duplicate_name:${name}`);
      namedSlots[name] = slot.id;
      values.push({ kind: "attribute", slot: slot.id, attribute: attributeId });
    }

    if (options.includeOccurrenceTime) {
      if (!["page", "event", "observation"].includes(entity)) {
        throw new Error("logical_source_occurrence_time_unavailable");
      }
      const slot = this.#newSlot(
        { kind: "scalar", scalar: "datetime" },
        false,
        { kind: "derived", operation: "occurrence-time", inputs: [] },
      );
      namedSlots.time = slot.id;
      values.push({ kind: "occurrence-time", slot: slot.id });
    }

    const node = {
      kind: "source",
      id: this.#newRelationId(),
      entity,
      temporalDomain,
      values,
      output: values.map((value) => value.slot),
      grain: { kind: "entity", entity, key: self.id },
    } satisfies LogicalNode;
    return this.#addNode(node, namedSlots, node.grain, [temporalDomain]);
  }

  relationshipLookup(
    input: LogicalRelationHandle,
    relationshipId: SemanticRelationshipId,
  ): LogicalRelationHandle {
    const state = this.#owned(input);
    const relationship = semanticRelationship(relationshipId);
    if (!relationship) {
      throw new Error(`logical_builder_unknown_relationship:${relationshipId}`);
    }
    if (
      relationship.cardinality !== "one-to-one" &&
      relationship.cardinality !== "many-to-one"
    ) {
      throw new Error(
        `logical_builder_relationship_lookup_not_single_valued:${relationshipId}`,
      );
    }
    if (
      input.grain.kind !== "entity" ||
      input.grain.entity !== relationship.from ||
      input.entityKey !== input.grain.key ||
      !state.node.output.includes(input.grain.key)
    ) {
      throw new Error(
        `logical_builder_relationship_lookup_requires_entity:${relationshipId}`,
      );
    }
    const inputKey = this.#slotById.get(input.grain.key);
    if (
      !inputKey ||
      inputKey.type.kind !== "entity" ||
      inputKey.type.entity !== relationship.from ||
      inputKey.nullable
    ) {
      throw new Error(
        `logical_builder_relationship_lookup_requires_nonnull_key:${relationshipId}`,
      );
    }
    const name = `relationship:${relationshipId}`;
    if (name in input.slots) {
      throw new Error(`logical_builder_duplicate_name:${name}`);
    }
    const related = this.#newSlot(
      { kind: "entity", entity: relationship.to },
      relationship.optional,
      { kind: "relationship", relationship: relationship.id },
    );
    const node = {
      kind: "relationship-lookup",
      id: this.#newRelationId(),
      input: input.id,
      relationship: relationshipId,
      inputKey: input.grain.key,
      relatedSlot: related.id,
      timeSemantics: "identity-no-activity-filter",
      output: [...state.node.output, related.id],
      grain: input.grain,
    } satisfies LogicalNode;
    return this.#addNode(
      node,
      { ...input.slots, [name]: related.id },
      node.grain,
      input.temporalDomains,
    );
  }

  slot(relation: LogicalRelationHandle, name: string): LogicalExpressionHandle {
    this.#owned(relation);
    const id = relation.slots[name];
    if (id === undefined)
      throw new Error(`logical_builder_unknown_slot:${name}`);
    const slot = this.#slotById.get(id);
    if (!slot) throw new Error(`logical_builder_missing_slot:${id}`);
    return this.#expression({ kind: "slot", slot: id });
  }

  literal(
    value: LogicalLiteralValue,
    type: Extract<LogicalValueType, { kind: "scalar" }>,
  ): LogicalExpressionHandle {
    return this.#expression({
      kind: "literal",
      value,
      valueType: type,
    });
  }

  elapsedDuration(
    amount: number,
    unit: ElapsedDurationUnit,
  ): LogicalExpressionHandle {
    return this.#expression(elapsedDurationLiteral(amount, unit));
  }

  calendarPeriod(
    amount: number,
    unit: CalendarPeriodUnit,
  ): LogicalExpressionHandle {
    return this.#expression(calendarPeriodLiteral(amount, unit));
  }

  compare(
    operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
    left: LogicalExpressionHandle,
    right: LogicalExpressionHandle,
    stringNormalization?: LogicalStringNormalization,
  ): LogicalExpressionHandle {
    return this.#expression({
      kind: "comparison",
      operator,
      left: left.expression,
      right: right.expression,
      ...(stringNormalization ? { stringNormalization } : {}),
    });
  }

  and(...terms: readonly LogicalExpressionHandle[]): LogicalExpressionHandle {
    return this.#boolean("and", terms);
  }

  or(...terms: readonly LogicalExpressionHandle[]): LogicalExpressionHandle {
    return this.#boolean("or", terms);
  }

  not(input: LogicalExpressionHandle): LogicalExpressionHandle {
    return this.#expression({ kind: "not", input: input.expression });
  }

  isNull(
    input: LogicalExpressionHandle,
    negated = false,
  ): LogicalExpressionHandle {
    return this.#expression({
      kind: "null-test",
      input: input.expression,
      negated,
    });
  }

  in(
    input: LogicalExpressionHandle,
    values: readonly LogicalExpressionHandle[],
    negated = false,
    stringNormalization?: LogicalStringNormalization,
  ): LogicalExpressionHandle {
    const literals = values.map((value) => {
      if (value.expression.kind !== "literal") {
        throw new Error("logical_builder_set_membership_requires_literals");
      }
      return value.expression;
    });
    return this.#expression({
      kind: "set-membership",
      input: input.expression,
      values: literals,
      negated,
      ...(stringNormalization ? { stringNormalization } : {}),
    });
  }

  stringMatch(
    operator: "contains" | "starts-with" | "ends-with",
    input: LogicalExpressionHandle,
    value: string,
    caseSensitive = false,
    stringNormalization?: LogicalStringNormalization,
  ): LogicalExpressionHandle {
    return this.#expression({
      kind: "string-match",
      operator,
      input: input.expression,
      value,
      caseSensitive,
      ...(stringNormalization ? { stringNormalization } : {}),
    });
  }

  arithmetic(
    operator: "add" | "subtract" | "multiply" | "divide",
    left: LogicalExpressionHandle,
    right: LogicalExpressionHandle,
  ): LogicalExpressionHandle {
    return this.#expression({
      kind: "arithmetic",
      operator,
      left: left.expression,
      right: right.expression,
      ...(operator === "divide" ? { zeroDenominator: "null" as const } : {}),
    });
  }

  round(input: LogicalExpressionHandle): LogicalExpressionHandle {
    return this.#expression({ kind: "round", input: input.expression });
  }

  coalesce(
    ...values: readonly LogicalExpressionHandle[]
  ): LogicalExpressionHandle {
    return this.#expression({
      kind: "coalesce",
      values: values.map((value) => value.expression),
    });
  }

  caseWhen(
    branches: readonly {
      readonly when: LogicalExpressionHandle;
      readonly then: LogicalExpressionHandle;
    }[],
    otherwise: LogicalExpressionHandle,
  ): LogicalExpressionHandle {
    return this.#expression({
      kind: "case",
      branches: branches.map((branch) => ({
        when: branch.when.expression,
        then: branch.then.expression,
      })),
      otherwise: otherwise.expression,
    });
  }

  timeBucket(
    input: LogicalExpressionHandle,
    granularity: CalendarGranularity,
  ): LogicalExpressionHandle {
    return this.#expression({
      kind: "time-bucket",
      input: input.expression,
      granularity,
      reportingTimeZone: this.#context.time.reportingTimeZone,
    });
  }

  filter(
    input: LogicalRelationHandle,
    predicate: LogicalExpressionHandle,
  ): LogicalRelationHandle {
    this.#assertExpressionVisible(
      input,
      predicate.expression,
      "filter.predicate",
    );
    if (
      predicate.type.kind !== "scalar" ||
      predicate.type.scalar !== "boolean"
    ) {
      throw new Error("logical_builder_filter_requires_boolean");
    }
    const source = this.#owned(input);
    const node = {
      kind: "filter",
      id: this.#newRelationId(),
      input: input.id,
      predicate: predicate.expression,
      output: source.node.output,
      grain: input.grain,
    } satisfies LogicalNode;
    return this.#addNode(node, input.slots, node.grain, input.temporalDomains);
  }

  project(
    input: LogicalRelationHandle,
    projections: Readonly<Record<string, LogicalExpressionHandle>>,
  ): LogicalRelationHandle {
    this.#owned(input);
    const names = Object.keys(projections);
    if (new Set(names).size !== names.length || names.some((name) => !name)) {
      throw new Error("logical_builder_invalid_projection_names");
    }
    const bindings: ProjectBinding[] = [];
    const slots: Record<string, SlotId> = {};
    const grainMapping = new Map<SlotId, SlotId>();
    const addProjection = (
      name: string,
      expression: LogicalExpr,
      metadata: InferredLogicalExpression,
    ) => {
      const sourceId = expression.kind === "slot" ? expression.slot : undefined;
      const slot = this.#newSlot(
        metadata.type,
        metadata.nullable,
        sourceId === undefined
          ? {
              kind: "derived",
              operation: expression.kind,
              inputs: this.#referencedSlots(expression),
            }
          : { kind: "alias", source: sourceId },
      );
      bindings.push({ slot: slot.id, expression });
      slots[name] = slot.id;
      if (sourceId !== undefined && grainKeys(input.grain).includes(sourceId)) {
        grainMapping.set(sourceId, slot.id);
      }
    };
    for (const [name, expression] of Object.entries(projections)) {
      this.#assertExpressionVisible(
        input,
        expression.expression,
        `project.${name}`,
      );
      addProjection(name, expression.expression, expression);
    }
    for (const [index, key] of grainKeys(input.grain).entries()) {
      if (!grainMapping.has(key)) {
        const name = `$grain${index}`;
        if (name in slots)
          throw new Error("logical_builder_reserved_projection_name");
        const slot = this.#slotById.get(key);
        if (!slot) throw new Error("logical_builder_missing_grain_slot");
        addProjection(
          name,
          { kind: "slot", slot: key },
          { type: slot.type, nullable: slot.nullable },
        );
      }
    }
    const grain = this.#mappedGrain(input.grain, grainMapping);
    const node = {
      kind: "project",
      id: this.#newRelationId(),
      input: input.id,
      projections: bindings,
      output: bindings.map((binding) => binding.slot),
      grain,
    } satisfies LogicalNode;
    return this.#addNode(node, slots, grain, input.temporalDomains);
  }

  aggregate(
    input: LogicalRelationHandle,
    groups: Readonly<Record<string, LogicalExpressionHandle>>,
    measures: readonly LogicalAggregateInput[],
  ): LogicalRelationHandle {
    this.#owned(input);
    const groupBindings: ProjectBinding[] = [];
    const measureBindings: LogicalAggregateMeasure[] = [];
    const slots: Record<string, SlotId> = {};
    for (const [name, expression] of Object.entries(groups)) {
      this.#assertExpressionVisible(
        input,
        expression.expression,
        `aggregate.groups.${name}`,
      );
      if (!name || name in slots)
        throw new Error("logical_builder_invalid_group_name");
      const slot = this.#newSlot(expression.type, expression.nullable, {
        kind: "derived",
        operation: "group",
        inputs: this.#referencedSlots(expression.expression),
      });
      groupBindings.push({ slot: slot.id, expression: expression.expression });
      slots[name] = slot.id;
    }
    for (const measure of measures) {
      if (!measure.name || measure.name in slots)
        throw new Error("logical_builder_duplicate_aggregate_name");
      if (measure.kind !== "count-rows" && !measure.expression) {
        throw new Error(
          `logical_builder_aggregate_expression_required:${measure.name}`,
        );
      }
      if (measure.expression) {
        this.#assertExpressionVisible(
          input,
          measure.expression.expression,
          `aggregate.measures.${measure.name}`,
        );
      }
      let valueType: LogicalValueType = { kind: "scalar", scalar: "number" };
      let nullable = false;
      if (
        measure.kind === "sum" ||
        measure.kind === "avg" ||
        measure.kind === "min" ||
        measure.kind === "max"
      ) {
        valueType = measure.expression!.type;
        nullable = true;
      }
      const output = this.#newSlot(valueType, nullable, {
        kind: "derived",
        operation: `aggregate:${measure.kind}`,
        inputs: measure.expression
          ? this.#referencedSlots(measure.expression.expression)
          : [],
      });
      slots[measure.name] = output.id;
      if (measure.kind === "count-rows")
        measureBindings.push({ kind: "count-rows", output: output.id });
      else if (measure.kind === "count-distinct")
        measureBindings.push({
          kind: "count-distinct",
          input: measure.expression!.expression,
          output: output.id,
        });
      else
        measureBindings.push({
          kind: measure.kind,
          input: measure.expression!.expression,
          output: output.id,
        });
    }
    const groupSlots = groupBindings.map((group) => group.slot);
    const grain: LogicalGrain =
      groupSlots.length === 0
        ? { kind: "scalar" }
        : { kind: "keyed", keys: groupSlots };
    const node = {
      kind: "aggregate",
      id: this.#newRelationId(),
      input: input.id,
      groups: groupBindings,
      measures: measureBindings,
      output: [
        ...groupSlots,
        ...measureBindings.map((measure) => measure.output),
      ],
      grain,
    } satisfies LogicalNode;
    return this.#addNode(node, slots, grain, input.temporalDomains);
  }

  distinct(
    input: LogicalRelationHandle,
    keys: readonly { readonly input: string; readonly output?: string }[],
    options: { readonly excludeNull?: boolean } = {},
  ): LogicalRelationHandle {
    this.#owned(input);
    if (keys.length === 0)
      throw new Error("logical_builder_distinct_requires_keys");
    const excludeNull = options.excludeNull ?? false;
    const keyBindings = keys.map(({ input: name, output }, index) => {
      const sourceId = input.slots[name];
      if (sourceId === undefined)
        throw new Error(`logical_builder_unknown_slot:${name}`);
      const sourceSlot = this.#slotById.get(sourceId)!;
      const outputName = output ?? name;
      if (
        !outputName ||
        keys
          .slice(0, index)
          .some((prior) => (prior.output ?? prior.input) === outputName)
      ) {
        throw new Error("logical_builder_duplicate_distinct_name");
      }
      const alias = this.#newSlot(
        sourceSlot.type,
        excludeNull ? false : sourceSlot.nullable,
        { kind: "alias", source: sourceId },
      );
      return { input: sourceId, output: alias.id, name: outputName };
    });
    const slots = Object.fromEntries(
      keyBindings.map((key) => [key.name, key.output]),
    );
    const grain: LogicalGrain =
      keyBindings.length === 1 &&
      this.#slotById.get(keyBindings[0]!.output)!.type.kind === "entity" &&
      excludeNull
        ? {
            kind: "entity",
            entity: (
              this.#slotById.get(keyBindings[0]!.output)!.type as Extract<
                LogicalValueType,
                { kind: "entity" }
              >
            ).entity,
            key: keyBindings[0]!.output,
          }
        : { kind: "keyed", keys: keyBindings.map((key) => key.output) };
    const node = {
      kind: "distinct",
      id: this.#newRelationId(),
      input: input.id,
      keys: keyBindings.map(({ input: inputId, output }) => ({
        input: inputId,
        output,
      })),
      excludeNull,
      output: keyBindings.map((key) => key.output),
      grain,
    } satisfies LogicalNode;
    return this.#addNode(node, slots, grain, input.temporalDomains);
  }

  distinctEntity(
    input: LogicalRelationHandle,
    entitySlotName: string,
    outputName = entitySlotName,
  ): LogicalRelationHandle {
    const sourceSlot = input.slots[entitySlotName];
    const slot =
      sourceSlot === undefined ? undefined : this.#slotById.get(sourceSlot);
    if (!slot || slot.type.kind !== "entity") {
      throw new Error("logical_builder_distinct_entity_requires_entity_slot");
    }
    return this.distinct(
      input,
      [{ input: entitySlotName, output: outputName }],
      { excludeNull: true },
    );
  }

  setOperation(
    operation: "union" | "intersect" | "difference",
    inputs: readonly LogicalRelationHandle[],
  ): LogicalRelationHandle {
    if (inputs.length < 2)
      throw new Error("logical_builder_set_requires_two_inputs");
    if (operation === "difference" && inputs.length !== 2)
      throw new Error("logical_builder_difference_requires_two_inputs");
    const states = inputs.map((input) => this.#owned(input));
    const first = inputs[0]!;
    const firstNode = states[0]!.node;
    if (
      states.some(
        (state) =>
          state.node.output.length !== firstNode.output.length ||
          !sameGrainShape(state.handle.grain, first.grain),
      )
    ) {
      throw new Error("logical_builder_set_incompatible_shape");
    }
    const firstSlots = firstNode.output;
    const output: SlotId[] = [];
    const names = Object.keys(first.slots);
    for (let index = 0; index < firstSlots.length; index += 1) {
      const sourceSlots = states.map((state) =>
        this.#slotById.get(state.node.output[index]!)!,
      );
      if (
        sourceSlots.some(
          (slot) => !isSameLogicalValueType(slot.type, sourceSlots[0]!.type),
        )
      ) {
        throw new Error("logical_builder_set_incompatible_types");
      }
      const key = this.#newSlot(
        sourceSlots[0]!.type,
        setOperationResultNullable(
          operation,
          sourceSlots.map((slot) => slot.nullable),
        ),
        {
          kind: "derived",
          operation: `set:${operation}`,
          inputs: sourceSlots.map((slot) => slot.id),
        },
      );
      output.push(key.id);
    }
    const slots: Record<string, SlotId> = {};
    names.forEach((name) => {
      const oldPosition = firstNode.output.indexOf(first.slots[name]!);
      if (oldPosition >= 0) slots[name] = output[oldPosition]!;
    });
    const keys = grainKeys(first.grain).map((key) => {
      const position = firstNode.output.indexOf(key);
      if (position < 0)
        throw new Error("logical_builder_set_grain_not_visible");
      return output[position]!;
    });
    const grain: LogicalGrain =
      first.grain.kind === "entity"
        ? { kind: "entity", entity: first.grain.entity, key: keys[0]! }
        : first.grain.kind === "keyed"
          ? { kind: "keyed", keys }
          : { kind: "scalar" };
    const node = {
      kind: "set-operation",
      id: this.#newRelationId(),
      operation,
      inputs: inputs.map((input) => input.id),
      output,
      grain,
    } satisfies LogicalNode;
    return this.#addNode(
      node,
      slots,
      grain,
      this.#mergeTemporalDomains(...inputs),
    );
  }

  semiJoin(
    left: LogicalRelationHandle,
    right: LogicalRelationHandle,
    keys: readonly { readonly left: string; readonly right: string }[],
  ): LogicalRelationHandle {
    return this.#membershipJoin("semi-join", left, right, keys);
  }

  antiJoin(
    left: LogicalRelationHandle,
    right: LogicalRelationHandle,
    keys: readonly { readonly left: string; readonly right: string }[],
  ): LogicalRelationHandle {
    return this.#membershipJoin("anti-join", left, right, keys);
  }

  join(
    left: LogicalRelationHandle,
    right: LogicalRelationHandle,
    keys: readonly { readonly left: string; readonly right: string }[],
    joinType: "inner" | "left" = "inner",
  ): LogicalRelationHandle {
    const leftState = this.#owned(left);
    this.#owned(right);
    if (left.id === right.id)
      throw new Error("logical_builder_self_join_requires_distinct_sources");
    const joinKeys = this.#joinKeys(left, right, keys);
    this.#assertRightUnique(right, joinKeys);
    const slots: Record<string, SlotId> = { ...left.slots };
    const rightAliases: { source: SlotId; alias: SlotId }[] = [];
    const rightOutput: SlotId[] = [];
    for (const [name, sourceId] of Object.entries(right.slots)) {
      const sourceSlot = this.#slotById.get(sourceId)!;
      let outputId = sourceId;
      if (joinType === "left") {
        const alias = this.#newSlot(sourceSlot.type, true, {
          kind: "alias",
          source: sourceId,
        });
        outputId = alias.id;
        rightAliases.push({ source: sourceId, alias: outputId });
      }
      const resultName = `right.${name}`;
      if (resultName in slots)
        throw new Error("logical_builder_join_output_name_collision");
      slots[resultName] = outputId;
      rightOutput.push(outputId);
    }
    const grain = left.grain;
    const node = {
      kind: "join",
      id: this.#newRelationId(),
      joinType,
      left: left.id,
      right: right.id,
      keys: joinKeys,
      rightAliases,
      output: [...leftState.node.output, ...rightOutput],
      grain,
    } satisfies LogicalNode;
    return this.#addNode(
      node,
      slots,
      grain,
      this.#mergeTemporalDomains(left, right),
    );
  }

  sort(
    input: LogicalRelationHandle,
    keys: readonly {
      readonly slot: string;
      readonly direction: "asc" | "desc";
      readonly nulls: "first" | "last";
    }[],
  ): LogicalRelationHandle {
    const source = this.#owned(input);
    const sortKeys: SortKey[] = keys.map((key) => {
      const slot = input.slots[key.slot];
      if (slot === undefined || !source.node.output.includes(slot))
        throw new Error("logical_builder_sort_slot_not_visible");
      return { ...key, slot };
    });
    const node = {
      kind: "sort",
      id: this.#newRelationId(),
      input: input.id,
      keys: sortKeys,
      output: source.node.output,
      grain: input.grain,
    } satisfies LogicalNode;
    return this.#addNode(node, input.slots, node.grain, input.temporalDomains);
  }

  limit(input: LogicalRelationHandle, count: number): LogicalRelationHandle {
    const source = this.#owned(input);
    if (!Number.isInteger(count) || count < 0)
      throw new Error("logical_builder_invalid_limit");
    const node = {
      kind: "limit",
      id: this.#newRelationId(),
      input: input.id,
      count,
      output: source.node.output,
      grain: input.grain,
    } satisfies LogicalNode;
    return this.#addNode(node, input.slots, node.grain, input.temporalDomains);
  }

  output(
    id: string,
    relation: LogicalRelationHandle,
    fields: readonly LogicalOutputInput[],
  ): void {
    this.#owned(relation);
    if (!id || this.#outputs.some((output) => output.id === id)) {
      throw new Error("logical_builder_duplicate_output_id");
    }
    const names = new Set<string>();
    const resolved = fields.map((field) => {
      if (!field.name || names.has(field.name))
        throw new Error("logical_builder_duplicate_output_name");
      names.add(field.name);
      const slot = relation.slots[field.slot];
      if (slot === undefined)
        throw new Error(`logical_builder_unknown_output_slot:${field.slot}`);
      return {
        name: field.name,
        slot,
        ...(field.semantic ? { semantic: field.semantic } : {}),
      };
    });
    this.#outputs.push({ id, relation: relation.id, fields: resolved });
  }

  finish(): ValidatedLogicalPlan {
    const plan: LogicalPlan = {
      version: 1,
      context: this.#context,
      slots: [...this.#slots],
      nodes: [...this.#nodes],
      outputs: [...this.#outputs],
    };
    return validateLogicalPlan(plan);
  }

  #membershipJoin(
    kind: "semi-join" | "anti-join",
    left: LogicalRelationHandle,
    right: LogicalRelationHandle,
    namedKeys: readonly { readonly left: string; readonly right: string }[],
  ): LogicalRelationHandle {
    const leftState = this.#owned(left);
    this.#owned(right);
    const keys = this.#joinKeys(left, right, namedKeys);
    const node = {
      kind,
      id: this.#newRelationId(),
      left: left.id,
      right: right.id,
      keys,
      output: leftState.node.output,
      grain: left.grain,
    } satisfies LogicalNode;
    return this.#addNode(
      node,
      left.slots,
      node.grain,
      this.#mergeTemporalDomains(left, right),
    );
  }

  #joinKeys(
    left: LogicalRelationHandle,
    right: LogicalRelationHandle,
    namedKeys: readonly { readonly left: string; readonly right: string }[],
  ): { readonly left: SlotId; readonly right: SlotId }[] {
    if (namedKeys.length === 0 && right.grain.kind !== "scalar") {
      throw new Error("logical_builder_join_requires_keys");
    }
    const keys = namedKeys.map(({ left: leftName, right: rightName }) => {
      const leftId = left.slots[leftName];
      const rightId = right.slots[rightName];
      if (leftId === undefined || rightId === undefined)
        throw new Error("logical_builder_unknown_join_key");
      const leftSlot = this.#slotById.get(leftId)!;
      const rightSlot = this.#slotById.get(rightId)!;
      if (!isSameLogicalValueType(leftSlot.type, rightSlot.type))
        throw new Error("logical_builder_join_key_type_mismatch");
      return { left: leftId, right: rightId };
    });
    if (
      new Set(keys.map((key) => key.left)).size !== keys.length ||
      new Set(keys.map((key) => key.right)).size !== keys.length
    ) {
      throw new Error("logical_builder_duplicate_join_key");
    }
    return keys;
  }

  #assertRightUnique(
    right: LogicalRelationHandle,
    keys: readonly { readonly left: SlotId; readonly right: SlotId }[],
  ): void {
    if (
      right.grain.kind !== "scalar" &&
      !grainKeys(right.grain).every((key) =>
        keys.some((joinKey) => joinKey.right === key),
      )
    ) {
      throw new Error("logical_builder_join_keys_do_not_cover_right_grain");
    }
  }

  #assertExpressionVisible(
    relation: LogicalRelationHandle,
    expression: LogicalExpr,
    path: string,
  ): void {
    const state = this.#owned(relation);
    inferLogicalExpression(
      expression,
      (id, _slotPath) => {
        if (!state.node.output.includes(id))
          throw new Error(`${path}:logical_builder_invisible_slot:${id}`);
        const slot = this.#slotById.get(id);
        if (!slot)
          throw new Error(`${path}:logical_builder_missing_slot:${id}`);
        return slot;
      },
      path,
    );
  }

  #expression(expression: LogicalExpr): LogicalExpressionHandle {
    const inferred = inferLogicalExpression(expression, (id) => {
      const slot = this.#slotById.get(id);
      if (!slot)
        throw new Error(`logical_builder_unknown_expression_slot:${id}`);
      return slot;
    });
    return Object.freeze({ expression, ...inferred });
  }

  #boolean(
    operator: "and" | "or",
    terms: readonly LogicalExpressionHandle[],
  ): LogicalExpressionHandle {
    return this.#expression({
      kind: "boolean",
      operator,
      terms: terms.map((term) => term.expression),
    });
  }

  #referencedSlots(expression: LogicalExpr): readonly SlotId[] {
    const result = new Set<SlotId>();
    const visit = (value: LogicalExpr): void => {
      switch (value.kind) {
        case "slot":
          result.add(value.slot);
          return;
        case "literal":
        case "elapsed-duration-literal":
        case "calendar-period-literal":
          return;
        case "comparison":
        case "arithmetic":
          visit(value.left);
          visit(value.right);
          return;
        case "boolean":
          value.terms.forEach(visit);
          return;
        case "not":
        case "null-test":
        case "string-match":
        case "round":
        case "time-bucket":
          visit(value.input);
          return;
        case "set-membership":
          visit(value.input);
          return;
        case "coalesce":
          value.values.forEach(visit);
          return;
        case "case":
          value.branches.forEach((branch) => {
            visit(branch.when);
            visit(branch.then);
          });
          visit(value.otherwise);
          return;
      }
    };
    visit(expression);
    return [...result];
  }

  #mappedGrain(
    grain: LogicalGrain,
    mapping: ReadonlyMap<SlotId, SlotId>,
  ): LogicalGrain {
    if (grain.kind === "scalar") return grain;
    if (grain.kind === "entity") {
      const key = mapping.get(grain.key);
      if (key === undefined)
        throw new Error("logical_builder_project_lost_grain");
      return { kind: "entity", entity: grain.entity, key };
    }
    return {
      kind: "keyed",
      keys: grain.keys.map((key) => {
        const mapped = mapping.get(key);
        if (mapped === undefined)
          throw new Error("logical_builder_project_lost_grain");
        return mapped;
      }),
    };
  }

  #newSlot(
    type: LogicalValueType,
    nullable: boolean,
    lineage: SlotLineage,
  ): LogicalSlot {
    const frozenType = Object.freeze({ ...type }) as LogicalValueType;
    const slot = Object.freeze({
      id: slotId(this.#nextSlotId++),
      type: frozenType,
      nullable,
      lineage,
    });
    this.#slots.push(slot);
    this.#slotById.set(slot.id, slot);
    return slot;
  }

  #newRelationId(): RelationId {
    return relationId(this.#nextRelationId++);
  }

  #addNode(
    node: LogicalNode,
    namedSlots: Readonly<Record<string, SlotId>>,
    grain: LogicalGrain,
    temporalDomains: readonly TemporalDomainRef[],
  ): LogicalRelationHandle {
    this.#nodes.push(node);
    const handle: LogicalRelationHandle = Object.freeze({
      id: node.id,
      slots: Object.freeze({ ...namedSlots }),
      grain,
      temporalDomains: Object.freeze([...temporalDomains]),
      ...(grain.kind === "entity" ? { entityKey: grain.key } : {}),
    });
    this.#relationById.set(node.id, { handle, node });
    return handle;
  }

  #owned(handle: LogicalRelationHandle): InternalRelationState {
    const state = this.#relationById.get(handle.id);
    if (!state || state.handle !== handle)
      throw new Error("logical_builder_foreign_relation_handle");
    return state;
  }

  #mergeTemporalDomains(
    ...relations: readonly LogicalRelationHandle[]
  ): readonly TemporalDomainRef[] {
    return [
      ...new Set(relations.flatMap((relation) => relation.temporalDomains)),
    ];
  }
}
