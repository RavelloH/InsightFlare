import {
  aggregate,
  and,
  antiJoin,
  callFunction,
  coalesce,
  count,
  distinct,
  eq,
  filter,
  gt,
  gte,
  inList,
  isNotNull,
  isNull,
  join,
  lt,
  lte,
  neq,
  not,
  or,
  param,
  project,
  semiJoin,
  union,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  Predicate,
  SqlExpression,
} from "@/lib/db/query/expression";
import type { LogicalExpr } from "@/lib/edge/analytics/engine/logical/expression";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type {
  AggregateNode,
  AntiJoinNode,
  DistinctNode,
  JoinNode,
  LogicalNode,
  ProjectNode,
  RelationshipLookupNode,
  SemiJoinNode,
  SetOperationNode,
  SourceNode,
} from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  LogicalOutput,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import type {
  LogicalSlot,
  LogicalValueType,
} from "@/lib/edge/analytics/engine/logical/slots";
import type { AnalyticsEntityKind } from "@/lib/edge/analytics/engine/semantic/entities";

import {
  type AnalyticsDbRelation,
  AnalyticsRelationalStorage,
  type AnalyticsRelationalStorageContext,
} from "./analytics-relational-storage";

type SlotLayout =
  | {
      readonly kind: "scalar";
      readonly type: LogicalValueType;
      readonly nullable: boolean;
      readonly valueColumn: string;
      readonly candidateBounded: boolean;
    }
  | {
      readonly kind: "entity";
      readonly type: Extract<LogicalValueType, { readonly kind: "entity" }>;
      readonly nullable: boolean;
      readonly keyColumns: readonly string[];
      readonly presentColumn?: string;
      readonly candidateBounded: boolean;
    };

interface LoweredRelation {
  readonly relation: AnalyticsDbRelation;
  readonly slots: ReadonlyMap<SlotId, SlotLayout>;
  readonly candidateActivity?: "page" | "event" | "observation";
  readonly candidateActivitySessionRelation?: RelationId;
  readonly candidateActivitySessionRestricted: boolean;
}

type LoweredValue =
  | {
      readonly kind: "scalar";
      readonly expression: AnyExpression;
      readonly type: LogicalValueType;
      readonly nullable: boolean;
      readonly candidateBounded: boolean;
    }
  | {
      readonly kind: "entity";
      readonly entity: AnalyticsEntityKind;
      readonly keys: readonly AnyExpression[];
      readonly present: Predicate;
      readonly nullable: boolean;
      readonly candidateBounded: boolean;
    };

export class AnalyticsRelationalLoweringError extends Error {
  constructor(
    readonly node: string,
    reason: string,
  ) {
    super(reason);
    this.name = "AnalyticsRelationalLoweringError";
  }
}

function nodePath(id: RelationId): string {
  return `nodes[${String(id)}]`;
}

function reject(node: string, reason: string): never {
  throw new AnalyticsRelationalLoweringError(node, reason);
}

function slotColumn(index: number, role: string): string {
  return `s${index}_${role}`;
}

function relationColumn(
  relation: AnalyticsDbRelation,
  name: string,
  path: string,
): AnyExpression {
  const value = relation.columns[name];
  if (!value)
    reject(path, `Missing lowered DB column ${JSON.stringify(name)}.`);
  return value;
}

function asPredicate(expression: AnyExpression, path: string): Predicate {
  if (expression.resultType.affinity !== "integer")
    reject(path, "A relational predicate must lower to an integer expression.");
  return expression as Predicate;
}

function logicalSlot(
  slots: ReadonlyMap<SlotId, LogicalSlot>,
  id: SlotId,
  path: string,
): LogicalSlot {
  const slot = slots.get(id);
  if (!slot) reject(path, `Missing validated Logical slot ${String(id)}.`);
  return slot;
}

function layoutValue(
  relation: AnalyticsDbRelation,
  slot: SlotLayout,
  path: string,
): LoweredValue {
  if (slot.kind === "scalar") {
    return {
      kind: "scalar",
      expression: relationColumn(relation, slot.valueColumn, path),
      type: slot.type,
      nullable: slot.nullable,
      candidateBounded: slot.candidateBounded,
    };
  }
  return {
    kind: "entity",
    entity: slot.type.entity,
    keys: slot.keyColumns.map((name) => relationColumn(relation, name, path)),
    present: slot.presentColumn
      ? asPredicate(relationColumn(relation, slot.presentColumn, path), path)
      : isNotNull(relationColumn(relation, slot.keyColumns[0]!, path)),
    nullable: slot.nullable,
    candidateBounded: slot.candidateBounded,
  };
}

function slotLayout(
  value: LoweredValue,
  slot: LogicalSlot,
  index: number,
  path: string,
): {
  readonly layout: SlotLayout;
  readonly projections: Record<string, AnyExpression>;
} {
  const projections: Record<string, AnyExpression> = {};
  if (value.kind === "scalar") {
    if (slot.type.kind === "entity")
      reject(path, "An entity slot cannot be mapped from a scalar expression.");
    if (value.expression.resultType.nullable && !slot.nullable)
      reject(
        path,
        "The lowered scalar can be NULL but the Logical slot cannot.",
      );
    const valueColumn = slotColumn(index, "v");
    projections[valueColumn] = value.expression;
    return {
      layout: {
        kind: "scalar",
        type: slot.type,
        nullable: slot.nullable,
        valueColumn,
        candidateBounded: value.candidateBounded,
      },
      projections,
    };
  }

  if (
    slot.type.kind !== "entity" ||
    slot.type.entity !== value.entity ||
    value.nullable !== slot.nullable
  )
    reject(path, "The lowered entity key does not match its Logical slot.");
  if (value.keys.length === 0)
    reject(path, "Entity identity requires at least one physical key column.");
  const keyColumns = value.keys.map((expression, keyIndex) => {
    const name = slotColumn(index, `k${keyIndex}`);
    projections[name] = expression;
    return name;
  });
  const presentColumn = slot.nullable
    ? slotColumn(index, "present")
    : undefined;
  if (presentColumn) projections[presentColumn] = value.present;
  return {
    layout: {
      kind: "entity",
      type: slot.type,
      nullable: slot.nullable,
      keyColumns,
      ...(presentColumn ? { presentColumn } : {}),
      candidateBounded: value.candidateBounded,
    },
    projections,
  };
}

function projectedValues(
  input: AnalyticsDbRelation,
  values: readonly { readonly slot: SlotId; readonly value: LoweredValue }[],
  logicalSlots: ReadonlyMap<SlotId, LogicalSlot>,
  path: string,
): LoweredRelation {
  const projections: Record<string, AnyExpression> = {};
  const layouts = new Map<SlotId, SlotLayout>();
  values.forEach(({ slot, value }, index) => {
    const meta = logicalSlot(logicalSlots, slot, `${path}.${String(slot)}`);
    const projected = slotLayout(value, meta, index, `${path}.${String(slot)}`);
    Object.assign(projections, projected.projections);
    layouts.set(slot, projected.layout);
  });
  const relation: AnalyticsDbRelation = project(input, projections);
  return {
    relation,
    slots: layouts,
    candidateActivitySessionRestricted: false,
  };
}

function readValue(
  relation: AnalyticsDbRelation,
  slots: ReadonlyMap<SlotId, SlotLayout>,
  id: SlotId,
  path: string,
): LoweredValue {
  const layout = slots.get(id);
  if (!layout)
    reject(path, `Slot ${String(id)} is not visible in this relation.`);
  return layoutValue(relation, layout, path);
}

function combinePredicates(
  operator: "and" | "or",
  predicates: readonly Predicate[],
  path: string,
): Predicate {
  const [first, ...rest] = predicates;
  if (!first) reject(path, "A Boolean expression must contain a term.");
  if (rest.length === 0) return first;
  return operator === "and" ? and(first, ...rest) : or(first, ...rest);
}

function scalarValue(value: LoweredValue, path: string): AnyExpression {
  if (value.kind !== "scalar")
    reject(path, "This expression requires a scalar Logical value.");
  return value.expression;
}

function applyTrim(
  expression: AnyExpression,
  logicalType: LogicalValueType,
  path: string,
): AnyExpression {
  if (logicalType.kind !== "scalar" || logicalType.scalar !== "string")
    reject(path, "Trim normalization is supported only for string values.");
  return callFunction("trim", expression as SqlExpression<string | null>);
}

function equalityForEntities(
  left: LoweredValue,
  right: LoweredValue,
  operator: "eq" | "neq",
  path: string,
): Predicate {
  if (left.kind !== "entity" || right.kind !== "entity")
    reject(path, "Entity comparison requires two entity identities.");
  if (
    left.entity !== right.entity ||
    left.keys.length !== right.keys.length ||
    left.nullable ||
    right.nullable
  )
    reject(
      path,
      "Only matching non-null composite entity keys are comparable.",
    );
  const equalKeys = combinePredicates(
    "and",
    left.keys.map((key, index) => eq(key, right.keys[index]!)),
    path,
  );
  return operator === "eq" ? equalKeys : not(equalKeys);
}

function lowerExpression(
  expression: LogicalExpr,
  relation: AnalyticsDbRelation,
  logicalSlots: ReadonlyMap<SlotId, LogicalSlot>,
  visible: ReadonlyMap<SlotId, SlotLayout>,
  path: string,
): LoweredValue {
  switch (expression.kind) {
    case "slot": {
      return readValue(relation, visible, expression.slot, `${path}.slot`);
    }
    case "literal":
      return {
        kind: "scalar",
        expression: param(expression.value),
        type: expression.valueType,
        nullable: expression.value === null,
        candidateBounded: false,
      };
    case "comparison": {
      const left = lowerExpression(
        expression.left,
        relation,
        logicalSlots,
        visible,
        `${path}.left`,
      );
      const right = lowerExpression(
        expression.right,
        relation,
        logicalSlots,
        visible,
        `${path}.right`,
      );
      if (left.kind === "entity" || right.kind === "entity") {
        if (expression.stringNormalization !== undefined)
          reject(path, "Entity comparisons do not use string normalization.");
        if (expression.operator !== "eq" && expression.operator !== "neq")
          reject(path, "Entity identities support equality only.");
        return {
          kind: "scalar",
          expression: equalityForEntities(
            left,
            right,
            expression.operator,
            path,
          ),
          type: { kind: "scalar", scalar: "boolean" },
          nullable: false,
          candidateBounded: false,
        };
      }
      let leftExpression = scalarValue(left, `${path}.left`);
      let rightExpression = scalarValue(right, `${path}.right`);
      const leftType =
        left.kind === "scalar"
          ? left.type
          : reject(path, "Entity comparison requires matching entity keys.");
      const rightType =
        right.kind === "scalar"
          ? right.type
          : reject(path, "Entity comparison requires matching entity keys.");
      if (expression.stringNormalization === "trim") {
        leftExpression =
          expression.left.kind === "literal" &&
          typeof expression.left.value === "string"
            ? param(expression.left.value.trim())
            : applyTrim(leftExpression, leftType, `${path}.left`);
        rightExpression =
          expression.right.kind === "literal" &&
          typeof expression.right.value === "string"
            ? param(expression.right.value.trim())
            : applyTrim(rightExpression, rightType, `${path}.right`);
      } else if (expression.stringNormalization !== undefined) {
        reject(path, "This adapter does not support case-fold normalization.");
      }
      let predicate: Predicate;
      switch (expression.operator) {
        case "eq":
          predicate = eq(leftExpression, rightExpression);
          break;
        case "neq":
          predicate = neq(leftExpression, rightExpression);
          break;
        case "gt":
          predicate = gt(leftExpression, rightExpression);
          break;
        case "gte":
          predicate = gte(leftExpression, rightExpression);
          break;
        case "lt":
          predicate = lt(leftExpression, rightExpression);
          break;
        case "lte":
          predicate = lte(leftExpression, rightExpression);
          break;
      }
      return {
        kind: "scalar",
        expression: predicate,
        type: { kind: "scalar", scalar: "boolean" },
        nullable: left.nullable || right.nullable,
        candidateBounded: false,
      };
    }
    case "boolean": {
      const loweredTerms = expression.terms.map((term, index) =>
        lowerExpression(
          term,
          relation,
          logicalSlots,
          visible,
          `${path}.terms[${index}]`,
        ),
      );
      const terms = loweredTerms.map((term, index) =>
        asPredicate(
          scalarValue(term, `${path}.terms[${index}]`),
          `${path}.terms[${index}]`,
        ),
      );
      return {
        kind: "scalar",
        expression: combinePredicates(expression.operator, terms, path),
        type: { kind: "scalar", scalar: "boolean" },
        nullable: loweredTerms.some((term) => term.nullable),
        candidateBounded: false,
      };
    }
    case "not": {
      const loweredInput = lowerExpression(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
      );
      const input = scalarValue(loweredInput, `${path}.input`);
      return {
        kind: "scalar",
        expression: not(asPredicate(input, path)),
        type: { kind: "scalar", scalar: "boolean" },
        nullable: loweredInput.nullable,
        candidateBounded: false,
      };
    }
    case "null-test": {
      const input = lowerExpression(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
      );
      const predicate =
        input.kind === "entity"
          ? expression.negated
            ? input.present
            : not(input.present)
          : expression.negated
            ? isNotNull(input.expression)
            : isNull(input.expression);
      return {
        kind: "scalar",
        expression: predicate,
        type: { kind: "scalar", scalar: "boolean" },
        nullable: false,
        candidateBounded: false,
      };
    }
    case "set-membership": {
      const input = lowerExpression(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
      );
      const inputExpression = scalarValue(input, `${path}.input`);
      const inputType =
        input.kind === "scalar"
          ? input.type
          : reject(`${path}.input`, "Membership requires a scalar value.");
      let membershipValue = inputExpression;
      if (expression.stringNormalization === "trim")
        membershipValue = applyTrim(
          inputExpression,
          inputType,
          `${path}.input`,
        );
      else if (expression.stringNormalization !== undefined)
        reject(path, "This adapter does not support case-fold normalization.");
      const values = expression.values.map((literal, index) => {
        if (literal.kind !== "literal")
          reject(
            `${path}.values[${index}]`,
            "Membership values must be literals.",
          );
        const value =
          expression.stringNormalization === "trim" &&
          typeof literal.value === "string"
            ? literal.value.trim()
            : literal.value;
        return value;
      });
      const included = inList(membershipValue, values);
      const predicate = expression.negated ? not(included) : included;
      return {
        kind: "scalar",
        expression: predicate,
        type: { kind: "scalar", scalar: "boolean" },
        nullable:
          input.nullable ||
          expression.values.some((value) => value.value === null),
        candidateBounded: false,
      };
    }
    case "coalesce": {
      const loweredValues = expression.values.map((item, index) =>
        lowerExpression(
          item,
          relation,
          logicalSlots,
          visible,
          `${path}.values[${index}]`,
        ),
      );
      if (loweredValues.length === 0)
        reject(path, "COALESCE requires at least one value.");
      const values = loweredValues.map((value, index) =>
        scalarValue(value, `${path}.values[${index}]`),
      );
      const first = loweredValues[0]!;
      if (first.kind !== "scalar")
        reject(path, "COALESCE currently supports scalar values only.");
      let expressionValue: AnyExpression = values[0]!;
      for (const value of values.slice(1))
        expressionValue = coalesce(expressionValue, value);
      return {
        kind: "scalar",
        expression: expressionValue,
        type: first.type,
        nullable: loweredValues.every((value) => value.nullable),
        candidateBounded: false,
      };
    }
    case "elapsed-duration-literal":
    case "calendar-period-literal":
    case "string-match":
    case "arithmetic":
    case "round":
    case "case":
    case "time-bucket":
      reject(
        path,
        `Expression kind ${expression.kind} is outside the current D1 capability set.`,
      );
  }
}

function valueForSlot(
  relation: AnalyticsDbRelation,
  slots: ReadonlyMap<SlotId, SlotLayout>,
  id: SlotId,
  path: string,
): LoweredValue {
  return readValue(relation, slots, id, path);
}

function keyEqual(
  left: LoweredValue,
  right: LoweredValue,
  path: string,
): Predicate {
  if (left.kind === "entity" || right.kind === "entity") {
    if (left.kind !== "entity" || right.kind !== "entity")
      reject(path, "A composite entity join key cannot match a scalar key.");
    if (left.entity !== right.entity || left.keys.length !== right.keys.length)
      reject(path, "Composite join keys have incompatible entity identities.");
    const components: Predicate[] = left.keys.map((value, index) =>
      eq(value, right.keys[index]!),
    );
    if (left.nullable) components.push(left.present);
    if (right.nullable) components.push(right.present);
    return combinePredicates("and", components, path);
  }
  return eq(left.expression, right.expression);
}

function assertNonNullableSessionSet(
  inputNode: LogicalNode,
  entry: LoweredRelation,
  path: string,
): void {
  if (inputNode.output.length !== 1)
    reject(path, "Only unary Session identity sets are currently supported.");
  const value = entry.slots.get(inputNode.output[0]!);
  if (
    !value ||
    value.kind !== "entity" ||
    value.type.entity !== "session" ||
    value.nullable ||
    value.keyColumns.length !== 2
  )
    reject(path, "Set operations require a non-null composite Session key.");
}

export interface LoweredAnalyticsLogicalOutput {
  readonly relation: AnalyticsDbRelation;
  readonly slots: ReadonlyMap<SlotId, SlotLayout>;
  readonly output: LogicalOutput;
  readonly candidateBounded: boolean;
  readonly candidateActivity?: "page" | "event" | "observation";
  readonly candidateActivitySessionRelation?: RelationId;
  readonly candidateActivitySessionRestricted: boolean;
  readonly relationId: RelationId;
}

export interface AnalyticsDbOutputColumn {
  readonly name: string;
  readonly slot: SlotId;
  /** Entity outputs must name a component of their physical composite key. */
  readonly component?: number;
}

/** Memoized per-node lowering from validated Analytics IR into Generic DB Relations. */
export class AnalyticsLogicalToDbLowerer {
  readonly #plan: ValidatedLogicalPlan;
  readonly #nodes: ReadonlyMap<RelationId, LogicalNode>;
  readonly #logicalSlots: ReadonlyMap<SlotId, LogicalSlot>;
  readonly #memo = new Map<RelationId, LoweredRelation>();
  readonly #loweredSources = new Map<
    string,
    {
      readonly relation: AnalyticsDbRelation;
      readonly layouts: readonly SlotLayout[];
    }
  >();
  readonly #requiredSlots = new Map<RelationId, Set<SlotId>>();
  readonly #storage: AnalyticsRelationalStorage;

  constructor(
    plan: ValidatedLogicalPlan,
    storageContext: AnalyticsRelationalStorageContext,
  ) {
    this.#plan = plan;
    this.#nodes = new Map(plan.nodes.map((node) => [node.id, node] as const));
    this.#logicalSlots = new Map(
      plan.slots.map((slot) => [slot.id, slot] as const),
    );
    this.#storage = new AnalyticsRelationalStorage(storageContext);
  }

  lower(output: LogicalOutput): LoweredAnalyticsLogicalOutput {
    this.#prepareRequiredSlots(output);
    const root = this.#lowerNode(output.relation);
    if (this.#memo.size !== this.#plan.nodes.length) {
      const unreachable = this.#plan.nodes.find(
        (node) => !this.#memo.has(node.id),
      );
      reject(
        unreachable ? nodePath(unreachable.id) : "nodes",
        "Every relational and Boolean node must contribute to the selected output.",
      );
    }
    const outputNode = this.#nodes.get(output.relation);
    const outputValue = output.fields[0]
      ? root.slots.get(output.fields[0].slot)
      : undefined;
    return {
      relation: root.relation,
      slots: root.slots,
      output,
      candidateBounded:
        output.fields.length === 1 &&
        outputValue?.kind === "entity" &&
        outputValue.type.entity === "session" &&
        outputValue.candidateBounded,
      candidateActivity: root.candidateActivity,
      candidateActivitySessionRelation: root.candidateActivitySessionRelation,
      candidateActivitySessionRestricted:
        root.candidateActivitySessionRestricted,
      relationId: outputNode?.id ?? output.relation,
    };
  }

  lowerSourceValue(
    lowered: LoweredAnalyticsLogicalOutput,
    slot: SlotId,
    path: string,
  ): LoweredValue {
    return valueForSlot(lowered.relation, lowered.slots, slot, path);
  }

  projectOutput(
    lowered: LoweredAnalyticsLogicalOutput,
    columns: readonly AnalyticsDbOutputColumn[],
  ): AnalyticsDbRelation {
    const projections: Record<string, AnyExpression> = {};
    for (const { name, slot, component } of columns) {
      if (Object.hasOwn(projections, name))
        reject(
          "outputs",
          `Output column ${JSON.stringify(name)} is duplicated.`,
        );
      const value = this.lowerSourceValue(
        lowered,
        slot,
        `outputs.${JSON.stringify(name)}`,
      );
      if (value.kind === "scalar") {
        if (component !== undefined)
          reject(
            "outputs",
            `Scalar output ${JSON.stringify(name)} has no key component.`,
          );
        projections[name] = value.expression;
      } else {
        if (
          component === undefined ||
          !Number.isSafeInteger(component) ||
          component < 0 ||
          component >= value.keys.length
        )
          reject(
            "outputs",
            `Entity output ${JSON.stringify(name)} requires a valid key component.`,
          );
        projections[name] = value.keys[component]!;
      }
    }
    return project(lowered.relation, projections);
  }

  isCandidateBoundedSlot(relation: RelationId, slot: SlotId): boolean {
    return this.#lowerNode(relation).slots.get(slot)?.candidateBounded === true;
  }

  candidateActivity(
    relation: RelationId,
  ): "page" | "event" | "observation" | undefined {
    return this.#lowerNode(relation).candidateActivity;
  }

  isCandidateActivitySessionRestricted(relation: RelationId): boolean {
    return (
      this.#lowerNode(relation).candidateActivitySessionRelation !== undefined
    );
  }

  candidateActivitySessionRelation(
    relation: RelationId,
  ): RelationId | undefined {
    return this.#lowerNode(relation).candidateActivitySessionRelation;
  }

  lowerRelation(relation: RelationId): LoweredAnalyticsLogicalOutput {
    const entry = this.#lowerNode(relation);
    const output: LogicalOutput = {
      id: "internal",
      relation,
      fields: this.#plan.nodes
        .find((node) => node.id === relation)!
        .output.map((slot) => ({ name: String(slot), slot })),
    };
    return {
      relation: entry.relation,
      slots: entry.slots,
      output,
      candidateBounded: false,
      candidateActivity: entry.candidateActivity,
      candidateActivitySessionRelation: entry.candidateActivitySessionRelation,
      candidateActivitySessionRestricted:
        entry.candidateActivitySessionRestricted,
      relationId: relation,
    };
  }

  #lowerNode(id: RelationId): LoweredRelation {
    const existing = this.#memo.get(id);
    if (existing) return existing;
    const node = this.#nodes.get(id);
    if (!node) reject(nodePath(id), "The relation references a missing node.");
    const path = nodePath(id);
    let result: LoweredRelation;
    switch (node.kind) {
      case "source":
        result = this.#lowerSource(node, path);
        break;
      case "relationship-lookup":
        result = this.#lowerRelationshipLookup(node, path);
        break;
      case "filter": {
        const input = this.#lowerNode(node.input);
        const visible = new Map(input.slots);
        const predicate = asPredicate(
          scalarValue(
            lowerExpression(
              node.predicate,
              input.relation,
              this.#logicalSlots,
              visible,
              `${path}.predicate`,
            ),
            `${path}.predicate`,
          ),
          `${path}.predicate`,
        );
        const filtered: AnalyticsDbRelation = filter(input.relation, predicate);
        const values = node.output
          .filter((slot) => this.#requiredOutput(node).has(slot))
          .map((slot) => ({
            slot,
            value: readValue(filtered, input.slots, slot, path),
          }));
        const projected = projectedValues(
          filtered,
          values,
          this.#logicalSlots,
          path,
        );
        result = {
          ...projected,
          candidateActivity: input.candidateActivity,
          candidateActivitySessionRelation:
            input.candidateActivitySessionRelation,
          candidateActivitySessionRestricted:
            input.candidateActivitySessionRestricted,
        };
        break;
      }
      case "project":
        result = this.#lowerProject(node, path);
        break;
      case "distinct":
        result = this.#lowerDistinct(node, path);
        break;
      case "set-operation":
        result = this.#lowerSetOperation(node, path);
        break;
      case "semi-join":
      case "anti-join":
        result = this.#lowerMembershipJoin(node, path);
        break;
      case "aggregate":
        result = this.#lowerAggregate(node, path);
        break;
      case "join":
        result = this.#lowerJoin(node, path);
        break;
      case "sort":
      case "limit":
        reject(
          path,
          `Logical ${node.kind} is outside the current D1 capability set.`,
        );
    }
    this.#memo.set(id, result);
    return result;
  }

  #lowerSource(node: SourceNode, path: string): LoweredRelation {
    let lowered;
    try {
      lowered = this.#storage.lowerSource(
        node,
        path,
        this.#requiredOutput(node),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const separator = message.indexOf(": ");
      if (separator > 0 && message.startsWith(path + "."))
        reject(message.slice(0, separator), message.slice(separator + 2));
      reject(path, message);
    }
    const values = node.output
      .filter((slot) => this.#requiredOutput(node).has(slot))
      .map((slot) => {
        const value = lowered.values.get(slot);
        if (!value)
          reject(path, `The source does not bind slot ${String(slot)}.`);
        const logical = logicalSlot(
          this.#logicalSlots,
          slot,
          `${path}.${String(slot)}`,
        );
        const binding = node.values.find(
          (candidate) => candidate.slot === slot,
        );
        if (!binding)
          reject(path, `The source does not declare slot ${String(slot)}.`);
        const lineageMatches =
          (binding.kind === "self" &&
            logical.lineage.kind === "entity" &&
            logical.lineage.entity === node.entity) ||
          (binding.kind === "related-entity" &&
            logical.lineage.kind === "relationship" &&
            logical.lineage.relationship === binding.relationship) ||
          (binding.kind === "attribute" &&
            logical.lineage.kind === "attribute" &&
            logical.lineage.attribute === binding.attribute);
        const bindingName =
          binding.kind === "attribute"
            ? binding.attribute
            : binding.kind === "related-entity"
              ? binding.relationship
              : node.entity;
        if (!lineageMatches)
          reject(
            `${path}.${String(slot)}`,
            `Source value lineage for ${bindingName} differs from its declared binding.`,
          );
        if (value.kind === "scalar") {
          if (logical.type.kind === "entity")
            reject(path, "A source attribute cannot bind an entity slot.");
          return {
            slot,
            value: {
              kind: "scalar",
              expression: value.value,
              type: logical.type,
              nullable: logical.nullable,
              candidateBounded: false,
            } satisfies LoweredValue,
          };
        }
        if (
          logical.type.kind !== "entity" ||
          logical.type.entity !== value.entity ||
          logical.nullable !== value.nullable
        )
          reject(
            path,
            `Source binding for ${String(slot)} differs from its registered Logical metadata.`,
          );
        return { slot, value };
      });
    const sourceSignature = JSON.stringify([
      node.entity,
      node.temporalDomain,
      node.values.map((binding) => {
        const logical = logicalSlot(
          this.#logicalSlots,
          binding.slot,
          `${path}.${String(binding.slot)}`,
        );
        const value =
          binding.kind === "self"
            ? ["self"]
            : binding.kind === "related-entity"
              ? ["relationship", binding.relationship]
              : binding.kind === "attribute"
                ? ["attribute", binding.attribute]
                : ["occurrence-time"];
        return [
          value,
          this.#requiredOutput(node).has(binding.slot),
          logical.type,
          logical.nullable,
          logical.lineage,
        ];
      }),
    ]);
    const cached = this.#loweredSources.get(sourceSignature);
    if (cached) {
      if (cached.layouts.length !== values.length)
        reject(path, "A reused Source carrier has a different slot layout.");
      return {
        relation: cached.relation,
        slots: new Map(
          values.map(
            ({ slot }, index) => [slot, cached.layouts[index]!] as const,
          ),
        ),
        candidateActivity:
          node.temporalDomain === "candidate" &&
          (node.entity === "page" ||
            node.entity === "event" ||
            node.entity === "observation")
            ? node.entity
            : undefined,
        candidateActivitySessionRestricted: false,
      };
    }
    const result = projectedValues(
      lowered.relation,
      values,
      this.#logicalSlots,
      path,
    );
    this.#loweredSources.set(sourceSignature, {
      relation: result.relation,
      layouts: values.map(({ slot }) => {
        const layout = result.slots.get(slot);
        if (!layout)
          reject(path, `A lowered Source has no layout for ${String(slot)}.`);
        return layout;
      }),
    });
    return {
      ...result,
      candidateActivity:
        node.temporalDomain === "candidate" &&
        (node.entity === "page" ||
          node.entity === "event" ||
          node.entity === "observation")
          ? node.entity
          : undefined,
      candidateActivitySessionRestricted: false,
    };
  }

  #lowerProject(node: ProjectNode, path: string): LoweredRelation {
    const input = this.#lowerNode(node.input);
    const visible = new Map(input.slots);
    const values = node.projections
      .filter((projection) => this.#requiredOutput(node).has(projection.slot))
      .map((projection, index) => {
        const value = lowerExpression(
          projection.expression,
          input.relation,
          this.#logicalSlots,
          visible,
          `${path}.projections[${index}].expression`,
        );
        const outputMeta = logicalSlot(
          this.#logicalSlots,
          projection.slot,
          `${path}.projections[${index}].slot`,
        );
        if (value.kind === "scalar")
          return {
            slot: projection.slot,
            value: {
              ...value,
              type: outputMeta.type,
              nullable: outputMeta.nullable,
            },
          };
        if (projection.expression.kind !== "slot")
          reject(
            path,
            "Entity projections must directly rebind a visible entity slot.",
          );
        return {
          slot: projection.slot,
          value: { ...value, nullable: outputMeta.nullable },
        };
      });
    const projected = projectedValues(
      input.relation,
      values,
      this.#logicalSlots,
      path,
    );
    const preservesActivity =
      input.candidateActivity !== undefined &&
      node.grain.kind === "entity" &&
      node.grain.entity === input.candidateActivity;
    return {
      ...projected,
      candidateActivity: preservesActivity
        ? input.candidateActivity
        : undefined,
      candidateActivitySessionRestricted:
        preservesActivity && input.candidateActivitySessionRestricted,
      candidateActivitySessionRelation: preservesActivity
        ? input.candidateActivitySessionRelation
        : undefined,
    };
  }

  #lowerDistinct(node: DistinctNode, path: string): LoweredRelation {
    if (node.keys.length === 0)
      reject(path, "Distinct requires at least one visible key.");
    const input = this.#lowerNode(node.input);
    let relation = input.relation;
    const visible = new Map(input.slots);
    if (node.excludeNull) {
      const guards = node.keys.map((key, index) => {
        const value = readValue(
          relation,
          visible,
          key.input,
          `${path}.keys[${index}]`,
        );
        return value.kind === "entity"
          ? value.present
          : isNotNull(value.expression);
      });
      relation = filter(relation, combinePredicates("and", guards, path));
    }
    const values = node.keys.map((key, index) => {
      const value = readValue(
        relation,
        visible,
        key.input,
        `${path}.keys[${index}]`,
      );
      return {
        slot: key.output,
        value: node.excludeNull ? { ...value, nullable: false } : value,
      };
    });
    const projected = projectedValues(
      relation,
      values,
      this.#logicalSlots,
      path,
    );
    const distinctRelation: AnalyticsDbRelation = distinct(projected.relation);
    const preservesActivity =
      input.candidateActivity !== undefined &&
      node.grain.kind === "entity" &&
      node.grain.entity === input.candidateActivity;
    return {
      relation: distinctRelation,
      slots: projected.slots,
      candidateActivity: preservesActivity
        ? input.candidateActivity
        : undefined,
      candidateActivitySessionRestricted:
        preservesActivity && input.candidateActivitySessionRestricted,
      candidateActivitySessionRelation: preservesActivity
        ? input.candidateActivitySessionRelation
        : undefined,
    };
  }

  #lowerSetOperation(node: SetOperationNode, path: string): LoweredRelation {
    const inputs = node.inputs.map((id) => this.#lowerNode(id));
    for (const [index, input] of inputs.entries()) {
      const inputNode = this.#nodes.get(node.inputs[index]!);
      if (!inputNode) reject(path, `Set input ${index} does not exist.`);
      assertNonNullableSessionSet(inputNode, input, `${path}.inputs[${index}]`);
    }
    if (node.output.length !== 1)
      reject(path, "Only unary Session identity sets are currently supported.");

    const aligned = inputs.map((input, inputIndex) => {
      const sourceNode = this.#nodes.get(node.inputs[inputIndex]!);
      if (!sourceNode) reject(path, "Set input node is missing.");
      const values = sourceNode.output.map((sourceSlot, slotIndex) => ({
        slot: node.output[slotIndex]!,
        value: readValue(
          input.relation,
          input.slots,
          sourceSlot,
          `${path}.inputs[${inputIndex}].output[${slotIndex}]`,
        ),
      }));
      return projectedValues(input.relation, values, this.#logicalSlots, path);
    });

    let relation = aligned[0]!.relation;
    if (node.operation === "union") {
      for (const next of aligned.slice(1))
        relation = union(relation, next.relation);
      const bounded = inputs.every((input, index) => {
        const sourceNode = this.#nodes.get(node.inputs[index]!);
        const sourceSlot = sourceNode?.output[0];
        return (
          sourceSlot !== undefined &&
          input.slots.get(sourceSlot)?.candidateBounded === true
        );
      });
      const initial = aligned[0]!.slots.get(node.output[0]!);
      if (!initial) reject(path, "Union output mapping is missing.");
      return {
        relation,
        slots: new Map([
          [node.output[0]!, { ...initial, candidateBounded: bounded }],
        ]),
        candidateActivitySessionRestricted: false,
      };
    }

    let accumulated = aligned[0]!;
    let bounded = this.#inputSetSlotBounded(inputs[0]!, node.inputs[0]!);
    for (let index = 1; index < aligned.length; index++) {
      const next = aligned[index]!;
      const leftValue = readValue(
        accumulated.relation,
        accumulated.slots,
        node.output[0]!,
        path,
      );
      const rightValue = readValue(
        next.relation,
        next.slots,
        node.output[0]!,
        path,
      );
      const condition = keyEqual(leftValue, rightValue, `${path}.keys[0]`);
      const joined =
        node.operation === "intersect"
          ? semiJoin(accumulated.relation, next.relation, condition)
          : antiJoin(accumulated.relation, next.relation, condition);
      const selected = projectedValues(
        joined,
        [
          {
            slot: node.output[0]!,
            value: readValue(joined, accumulated.slots, node.output[0]!, path),
          },
        ],
        this.#logicalSlots,
        path,
      );
      relation = distinct(selected.relation);
      bounded =
        node.operation === "intersect"
          ? bounded ||
            this.#inputSetSlotBounded(inputs[index]!, node.inputs[index]!)
          : bounded;
      const layout = selected.slots.get(node.output[0]!);
      if (!layout) reject(path, "Set operation output mapping is missing.");
      accumulated = {
        relation,
        slots: new Map([
          [node.output[0]!, { ...layout, candidateBounded: bounded }],
        ]),
        candidateActivitySessionRestricted: false,
      };
    }
    return accumulated;
  }

  #lowerRelationshipLookup(
    node: RelationshipLookupNode,
    path: string,
  ): LoweredRelation {
    if (node.relationship !== "observation.session")
      reject(
        path,
        `Relationship ${node.relationship} has no D1 lookup mapping.`,
      );
    const input = this.#lowerNode(node.input);
    const required = this.#requiredOutput(node);
    const outputValues = node.output.filter((slot) => required.has(slot));
    if (!required.has(node.relatedSlot)) {
      const forwarded = projectedValues(
        input.relation,
        outputValues.map((slot) => ({
          slot,
          value: readValue(input.relation, input.slots, slot, path),
        })),
        this.#logicalSlots,
        path,
      );
      return {
        ...forwarded,
        candidateActivity: input.candidateActivity,
        candidateActivitySessionRelation:
          input.candidateActivitySessionRelation,
        candidateActivitySessionRestricted:
          input.candidateActivitySessionRestricted,
      };
    }
    const key = readValue(
      input.relation,
      input.slots,
      node.inputKey,
      `${path}.inputKey`,
    );
    if (key.kind !== "entity" || key.entity !== "observation" || key.nullable)
      reject(
        path,
        "Observation session lookup requires a non-null composite Observation key.",
      );
    if (!this.#hasStorageBackedObservationIdentity(node.input, node.inputKey))
      reject(
        path,
        "Observation session lookup requires an identity preserved from a registered Page/Event Source.",
      );
    if (key.keys.length !== 3)
      reject(
        path,
        "Observation session lookup requires site, activity kind, and local identity keys.",
      );
    const observationKind = key.keys[1]! as SqlExpression<
      string | null,
      ExpressionResultType<"text", boolean>
    >;
    // Page/Event identity lookups may use indexed INNER joins only after
    // proving that the Observation identity is carried unchanged from a
    // registered Source. Once an Event row is found, its owner Page is an
    // optional relationship: retain the Event and expose a null Session when
    // the same-site owner lookup has no match.
    const pageInput = filter(
      input.relation,
      eq(observationKind, param("page")),
    );
    const pageKey = readValue(
      pageInput,
      input.slots,
      node.inputKey,
      `${path}.inputKey`,
    );
    if (pageKey.kind !== "entity" || pageKey.entity !== "observation")
      reject(path, "Observation identity was lost during Page lookup.");
    const pageTable = this.#storage.observationPageIdentityRows();
    const pages = project(pageTable, {
      site_pk: pageTable.columns.site_pk,
      visit_id: pageTable.columns.visit_id,
      session_id: pageTable.columns.session_id,
    });
    const pageJoined = join(
      pageInput,
      pages,
      and(
        eq(pageKey.keys[0]!, pages.columns.site_pk),
        eq(pageKey.keys[2]!, pages.columns.visit_id),
      ),
    );
    const pageSessionId = relationColumn(pageJoined, "right_session_id", path);
    const pageSessionText = pageSessionId as SqlExpression<
      string | null,
      ExpressionResultType<"text", boolean>
    >;
    const pageValues: {
      readonly slot: SlotId;
      readonly value: LoweredValue;
    }[] = node.output
      .filter((slot) => slot !== node.relatedSlot && required.has(slot))
      .map((slot) => ({
        slot,
        value: this.#joinedValue(
          pageJoined,
          input.slots.get(slot),
          "left_",
          path,
        ),
      }));
    pageValues.push({
      slot: node.relatedSlot,
      value: {
        kind: "entity",
        entity: "session",
        keys: [
          relationColumn(pageJoined, "right_site_pk", path),
          pageSessionId,
        ],
        present: asPredicate(
          and(isNotNull(pageSessionText), neq(pageSessionText, param(""))),
          path,
        ),
        nullable: true,
        candidateBounded: pageKey.candidateBounded,
      },
    });
    const pageResult = projectedValues(
      pageJoined,
      pageValues,
      this.#logicalSlots,
      path,
    );

    const eventInput = filter(
      input.relation,
      eq(observationKind, param("event")),
    );
    const eventKey = readValue(
      eventInput,
      input.slots,
      node.inputKey,
      `${path}.inputKey`,
    );
    if (eventKey.kind !== "entity" || eventKey.entity !== "observation")
      reject(path, "Observation identity was lost during Event lookup.");
    const eventTable = this.#storage.observationEventIdentityRows();
    const events = project(eventTable, {
      site_pk: eventTable.columns.site_pk,
      event_id: eventTable.columns.event_id,
      visit_id: eventTable.columns.visit_id,
    });
    const eventJoined = join(
      eventInput,
      events,
      and(
        eq(eventKey.keys[0]!, events.columns.site_pk),
        eq(eventKey.keys[2]!, events.columns.event_id),
      ),
    );
    const ownerTable = this.#storage.observationPageIdentityRows();
    const owners = project(ownerTable, {
      site_pk: ownerTable.columns.site_pk,
      visit_id: ownerTable.columns.visit_id,
      session_id: ownerTable.columns.session_id,
    });
    const eventWithOwner = join(
      eventJoined,
      owners,
      and(
        eq(eventJoined.columns.right_site_pk, owners.columns.site_pk),
        eq(eventJoined.columns.right_visit_id, owners.columns.visit_id),
      ),
      "left",
    );
    const ownerSessionId = relationColumn(
      eventWithOwner,
      "right_session_id",
      path,
    );
    const ownerSessionText = ownerSessionId as SqlExpression<
      string | null,
      ExpressionResultType<"text", boolean>
    >;
    const eventValues: {
      readonly slot: SlotId;
      readonly value: LoweredValue;
    }[] = node.output
      .filter((slot) => slot !== node.relatedSlot && required.has(slot))
      .map((slot) => ({
        slot,
        value: this.#joinedValue(
          eventWithOwner,
          input.slots.get(slot),
          "left_left_",
          path,
        ),
      }));
    eventValues.push({
      slot: node.relatedSlot,
      value: {
        kind: "entity",
        entity: "session",
        keys: [
          relationColumn(eventWithOwner, "right_site_pk", path),
          ownerSessionId,
        ],
        present: asPredicate(
          and(isNotNull(ownerSessionText), neq(ownerSessionText, param(""))),
          path,
        ),
        nullable: true,
        candidateBounded: eventKey.candidateBounded,
      },
    });
    const eventResult = projectedValues(
      eventWithOwner,
      eventValues,
      this.#logicalSlots,
      path,
    );
    const projected: LoweredRelation = {
      relation: union(pageResult.relation, eventResult.relation, true),
      slots: pageResult.slots,
      candidateActivity: input.candidateActivity,
      candidateActivitySessionRelation: input.candidateActivitySessionRelation,
      candidateActivitySessionRestricted:
        input.candidateActivitySessionRestricted,
    };
    return {
      ...projected,
      candidateActivity: input.candidateActivity,
      candidateActivitySessionRelation: input.candidateActivitySessionRelation,
      candidateActivitySessionRestricted:
        input.candidateActivitySessionRestricted,
    };
  }

  #lowerMembershipJoin(
    node: SemiJoinNode | AntiJoinNode,
    path: string,
  ): LoweredRelation {
    const left = this.#lowerNode(node.left);
    const right = this.#lowerNode(node.right);
    if (node.keys.length === 0)
      reject(path, "Membership joins require at least one explicit key.");
    const conditions = node.keys.map((key, index) =>
      keyEqual(
        readValue(
          left.relation,
          left.slots,
          key.left,
          `${path}.keys[${index}].left`,
        ),
        readValue(
          right.relation,
          right.slots,
          key.right,
          `${path}.keys[${index}].right`,
        ),
        `${path}.keys[${index}]`,
      ),
    );
    const condition = combinePredicates("and", conditions, path);
    const relation =
      node.kind === "semi-join"
        ? semiJoin(left.relation, right.relation, condition)
        : antiJoin(left.relation, right.relation, condition);

    const boundedSlots = new Set<SlotId>();
    for (const [slot, layout] of left.slots) {
      if (layout.candidateBounded) boundedSlots.add(slot);
    }
    for (const key of node.keys) {
      const leftValue = left.slots.get(key.left);
      const rightValue = right.slots.get(key.right);
      if (
        node.kind === "semi-join" &&
        leftValue?.kind === "entity" &&
        rightValue?.kind === "entity" &&
        leftValue.type.entity === rightValue.type.entity &&
        rightValue.candidateBounded
      )
        boundedSlots.add(key.left);
    }
    const required = this.#requiredOutput(node);
    const projected = projectedValues(
      relation,
      node.output
        .filter((slot) => required.has(slot))
        .map((slot) => ({
          slot,
          value: readValue(relation, left.slots, slot, path),
        })),
      this.#logicalSlots,
      path,
    );
    const slots = new Map(
      [...projected.slots].map(
        ([slot, layout]) =>
          [
            slot,
            { ...layout, candidateBounded: boundedSlots.has(slot) },
          ] as const,
      ),
    );
    const pageSessionRestricted =
      node.kind === "semi-join" &&
      left.candidateActivity === "page" &&
      node.keys.length === 1 &&
      node.keys.every((key) => {
        const leftSlot = logicalSlot(this.#logicalSlots, key.left, path);
        const rightSlot = logicalSlot(this.#logicalSlots, key.right, path);
        return (
          leftSlot.type.kind === "entity" &&
          leftSlot.type.entity === "session" &&
          this.#hasRelationshipLineage(key.left, "page.session") &&
          rightSlot.type.kind === "entity" &&
          rightSlot.type.entity === "session" &&
          right.slots.get(key.right)?.candidateBounded === true
        );
      });
    return {
      relation: projected.relation,
      slots,
      candidateActivity: left.candidateActivity,
      candidateActivitySessionRelation:
        left.candidateActivitySessionRelation ??
        (pageSessionRestricted ? node.right : undefined),
      candidateActivitySessionRestricted:
        left.candidateActivitySessionRestricted || pageSessionRestricted,
    };
  }

  #hasStorageBackedObservationIdentity(
    relation: RelationId,
    slot: SlotId,
    active = new Set<string>(),
  ): boolean {
    const visitKey = `${String(relation)}:${String(slot)}`;
    if (active.has(visitKey)) return false;
    const nextActive = new Set(active).add(visitKey);
    const node = this.#nodes.get(relation);
    if (!node || !node.output.includes(slot)) return false;
    switch (node.kind) {
      case "source": {
        const binding = node.values.find((item) => item.slot === slot);
        return (
          (binding?.kind === "self" && node.entity === "observation") ||
          (binding?.kind === "related-entity" &&
            node.entity === "event" &&
            binding.relationship === "event.observation")
        );
      }
      case "filter":
      case "sort":
      case "limit":
        return this.#hasStorageBackedObservationIdentity(
          node.input,
          slot,
          nextActive,
        );
      case "project": {
        const projection = node.projections.find((item) => item.slot === slot);
        return (
          projection?.expression.kind === "slot" &&
          this.#hasStorageBackedObservationIdentity(
            node.input,
            projection.expression.slot,
            nextActive,
          )
        );
      }
      case "aggregate": {
        const group = node.groups.find((item) => item.slot === slot);
        return (
          group?.expression.kind === "slot" &&
          this.#hasStorageBackedObservationIdentity(
            node.input,
            group.expression.slot,
            nextActive,
          )
        );
      }
      case "distinct": {
        const key = node.keys.find((item) => item.output === slot);
        return (
          key !== undefined &&
          this.#hasStorageBackedObservationIdentity(
            node.input,
            key.input,
            nextActive,
          )
        );
      }
      case "set-operation": {
        const index = node.output.indexOf(slot);
        return (
          index >= 0 &&
          node.inputs.every((inputId) => {
            const input = this.#nodes.get(inputId);
            const inputSlot = input?.output[index];
            return (
              inputSlot !== undefined &&
              this.#hasStorageBackedObservationIdentity(
                inputId,
                inputSlot,
                nextActive,
              )
            );
          })
        );
      }
      case "semi-join":
      case "anti-join":
        return this.#hasStorageBackedObservationIdentity(
          node.left,
          slot,
          nextActive,
        );
      case "join": {
        if (this.#nodes.get(node.left)?.output.includes(slot))
          return this.#hasStorageBackedObservationIdentity(
            node.left,
            slot,
            nextActive,
          );
        const alias = node.rightAliases.find((item) => item.alias === slot);
        const sourceSlot = alias?.source ?? slot;
        return (
          node.joinType === "inner" &&
          (alias !== undefined ||
            this.#nodes.get(node.right)?.output.includes(sourceSlot) ===
              true) &&
          this.#hasStorageBackedObservationIdentity(
            node.right,
            sourceSlot,
            nextActive,
          )
        );
      }
      case "relationship-lookup":
        return (
          slot !== node.relatedSlot &&
          this.#hasStorageBackedObservationIdentity(
            node.input,
            slot,
            nextActive,
          )
        );
    }
  }

  #lowerAggregate(node: AggregateNode, path: string): LoweredRelation {
    if (
      node.groups.length !== 0 ||
      node.measures.length !== 1 ||
      node.measures[0]?.kind !== "count-rows"
    )
      reject(
        path,
        "Only ungrouped COUNT_ROWS aggregates are currently supported.",
      );
    const input = this.#lowerNode(node.input);
    const output = node.measures[0].output;
    const valueColumn = slotColumn(0, "v");
    const relation: AnalyticsDbRelation = aggregate(input.relation, {
      groupBy: {},
      aggregates: { [valueColumn]: count() },
    });
    const slot = logicalSlot(this.#logicalSlots, output, `${path}.output`);
    if (
      slot.type.kind !== "scalar" ||
      slot.type.scalar !== "number" ||
      slot.nullable
    )
      reject(path, "COUNT_ROWS output must be a non-null numeric scalar.");
    const slots = new Map<SlotId, SlotLayout>([
      [
        output,
        {
          kind: "scalar",
          type: slot.type,
          nullable: false,
          valueColumn,
          candidateBounded: false,
        },
      ],
    ]);
    return { relation, slots, candidateActivitySessionRestricted: false };
  }

  #lowerJoin(node: JoinNode, path: string): LoweredRelation {
    if (
      node.joinType !== "inner" ||
      node.keys.length !== 0 ||
      node.grain.kind !== "scalar"
    )
      reject(
        path,
        "Only a keyless inner join of scalar relations is supported.",
      );
    const left = this.#lowerNode(node.left);
    const right = this.#lowerNode(node.right);
    const leftCount = left.relation.fields[0];
    if (!leftCount)
      reject(
        path,
        "A scalar aggregate input must expose its COUNT_ROWS value.",
      );
    const joined = join(
      left.relation,
      right.relation,
      isNotNull(relationColumn(left.relation, leftCount.name, path)),
    );
    const leftNode = this.#logicalNode(node.left)!;
    const rightNode = this.#logicalNode(node.right)!;
    const required = this.#requiredOutput(node);
    const values = [
      ...leftNode.output
        .filter((slot) => required.has(slot))
        .map((slot) => ({
          slot,
          value: this.#joinedValue(joined, left.slots.get(slot), "left_", path),
        })),
      ...rightNode.output
        .filter((slot) => required.has(slot))
        .map((slot) => ({
          slot,
          value: this.#joinedValue(
            joined,
            right.slots.get(slot),
            "right_",
            path,
          ),
        })),
    ];
    const projected = projectedValues(joined, values, this.#logicalSlots, path);
    return projected;
  }

  #joinedValue(
    joined: AnalyticsDbRelation,
    layout: SlotLayout | undefined,
    prefix: string,
    path: string,
  ): LoweredValue {
    if (!layout) reject(path, "Join input slot mapping is missing.");
    if (layout.kind === "scalar")
      return {
        kind: "scalar",
        expression: relationColumn(
          joined,
          `${prefix}${layout.valueColumn}`,
          path,
        ),
        type: layout.type,
        nullable: layout.nullable,
        candidateBounded: layout.candidateBounded,
      };
    return {
      kind: "entity",
      entity: layout.type.entity,
      keys: layout.keyColumns.map((name) =>
        relationColumn(joined, `${prefix}${name}`, path),
      ),
      present: layout.presentColumn
        ? asPredicate(
            relationColumn(joined, `${prefix}${layout.presentColumn}`, path),
            path,
          )
        : isNotNull(
            relationColumn(joined, `${prefix}${layout.keyColumns[0]!}`, path),
          ),
      nullable: layout.nullable,
      candidateBounded: layout.candidateBounded,
    };
  }

  #prepareRequiredSlots(output: LogicalOutput): void {
    this.#requiredSlots.clear();
    this.#addRequiredSlots(
      output.relation,
      output.fields.map((field) => field.slot),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.#plan.nodes) {
        const needed = this.#requiredSlots.get(node.id);
        if (!needed) continue;
        const add = (relation: RelationId, slots: readonly SlotId[]) => {
          if (this.#addRequiredSlots(relation, slots)) changed = true;
        };
        switch (node.kind) {
          case "source":
            break;
          case "filter":
            add(node.input, [
              ...node.output.filter((slot) => needed.has(slot)),
              ...this.#expressionSlots(node.predicate),
            ]);
            break;
          case "project":
            for (const projection of node.projections) {
              if (needed.has(projection.slot))
                add(node.input, this.#expressionSlots(projection.expression));
            }
            break;
          case "relationship-lookup":
            add(node.input, [
              ...node.output.filter(
                (slot) => slot !== node.relatedSlot && needed.has(slot),
              ),
              ...(needed.has(node.relatedSlot) ? [node.inputKey] : []),
            ]);
            break;
          case "distinct":
            add(
              node.input,
              node.keys.map((key) => key.input),
            );
            break;
          case "set-operation":
            for (const inputId of node.inputs) {
              const source = this.#nodes.get(inputId);
              if (!source) continue;
              add(
                inputId,
                node.output.flatMap((slot, index) =>
                  needed.has(slot) && source.output[index] !== undefined
                    ? [source.output[index]!]
                    : [],
                ),
              );
            }
            break;
          case "semi-join":
          case "anti-join": {
            const left = this.#nodes.get(node.left);
            if (!left) break;
            add(node.left, [
              ...left.output.filter((slot) => needed.has(slot)),
              ...node.keys.map((key) => key.left),
            ]);
            add(
              node.right,
              node.keys.map((key) => key.right),
            );
            break;
          }
          case "aggregate": {
            const source = this.#nodes.get(node.input);
            if (source) add(node.input, source.output);
            break;
          }
          case "join": {
            const left = this.#nodes.get(node.left);
            const right = this.#nodes.get(node.right);
            if (left)
              add(node.left, [
                ...left.output.filter((slot) => needed.has(slot)),
                ...node.keys.map((key) => key.left),
              ]);
            if (right)
              add(node.right, [
                ...right.output.filter((slot) => needed.has(slot)),
                ...node.keys.map((key) => key.right),
              ]);
            break;
          }
          case "sort":
            add(node.input, [
              ...node.keys.map((key) => key.slot),
              ...node.output,
            ]);
            break;
          case "limit":
            add(node.input, node.output);
            break;
        }
      }
    }
  }

  #addRequiredSlots(relation: RelationId, slots: readonly SlotId[]): boolean {
    const required = this.#requiredSlots.get(relation) ?? new Set<SlotId>();
    let changed = false;
    for (const slot of slots) {
      if (required.has(slot)) continue;
      required.add(slot);
      changed = true;
    }
    this.#requiredSlots.set(relation, required);
    return changed;
  }

  #requiredOutput(node: LogicalNode): ReadonlySet<SlotId> {
    const required = this.#requiredSlots.get(node.id);
    return required && required.size > 0 ? required : new Set(node.output);
  }

  #expressionSlots(expression: LogicalExpr): readonly SlotId[] {
    switch (expression.kind) {
      case "slot":
        return [expression.slot];
      case "literal":
      case "elapsed-duration-literal":
      case "calendar-period-literal":
        return [];
      case "comparison":
      case "arithmetic":
        return [
          ...this.#expressionSlots(expression.left),
          ...this.#expressionSlots(expression.right),
        ];
      case "boolean":
        return expression.terms.flatMap((term) => this.#expressionSlots(term));
      case "not":
      case "null-test":
      case "string-match":
      case "round":
      case "time-bucket":
        return this.#expressionSlots(expression.input);
      case "set-membership":
        return this.#expressionSlots(expression.input);
      case "coalesce":
        return expression.values.flatMap((value) =>
          this.#expressionSlots(value),
        );
      case "case":
        return [
          ...expression.branches.flatMap((branch) => [
            ...this.#expressionSlots(branch.when),
            ...this.#expressionSlots(branch.then),
          ]),
          ...this.#expressionSlots(expression.otherwise),
        ];
    }
  }

  #inputSetSlotBounded(
    entry: LoweredRelation,
    relationId: RelationId,
  ): boolean {
    const node = this.#nodes.get(relationId);
    const slot = node?.output[0];
    return (
      slot !== undefined && entry.slots.get(slot)?.candidateBounded === true
    );
  }

  #hasRelationshipLineage(id: SlotId, relationship: "page.session"): boolean {
    const seen = new Set<SlotId>();
    let current: SlotId | undefined = id;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const slot = this.#logicalSlots.get(current);
      if (!slot) return false;
      if (
        slot.lineage.kind === "relationship" &&
        slot.lineage.relationship === relationship
      )
        return true;
      current = slot.lineage.kind === "alias" ? slot.lineage.source : undefined;
    }
    return false;
  }

  #logicalNode(id: RelationId): LogicalNode | undefined {
    return this.#nodes.get(id);
  }
}
