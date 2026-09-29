import type { LogicalExpr } from "@/lib/edge/analytics/engine/logical/expression";
import {
  grainKeys,
  type LogicalGrain,
  sameGrainShape,
} from "@/lib/edge/analytics/engine/logical/grain";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import {
  type AggregateNode,
  type LogicalAggregateMeasure,
  type LogicalNode,
  setOperationResultNullable,
  type SourceValueBinding,
} from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  LogicalPlan,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import type { LogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";
import type { LogicalSlot } from "@/lib/edge/analytics/engine/logical/slots";
import { isSameLogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";
import { semanticAttribute } from "@/lib/edge/analytics/engine/semantic/attributes";
import { semanticDimension } from "@/lib/edge/analytics/engine/semantic/dimensions";
import {
  isAnalyticsEntityKind,
  validateResolvedAnalyticsScope,
} from "@/lib/edge/analytics/engine/semantic/entities";
import { semanticMetric } from "@/lib/edge/analytics/engine/semantic/metrics";
import {
  isSemanticRelationshipId,
  semanticRelationship,
} from "@/lib/edge/analytics/engine/semantic/relationships";
import { isCanonicalSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  createSemanticTemporalDomains,
  isCalendarGranularity,
  temporalDomainExists,
} from "@/lib/edge/analytics/engine/semantic/time";

export type LogicalPlanIssueCode =
  | "invalid-envelope"
  | "duplicate-id"
  | "invalid-topology"
  | "invisible-slot"
  | "invalid-expression"
  | "invalid-grain"
  | "invalid-join"
  | "invalid-source"
  | "invalid-output";

export interface LogicalPlanIssue {
  readonly code: LogicalPlanIssueCode;
  readonly path: string;
  readonly message: string;
}

export class LogicalPlanError extends Error {
  readonly issues: readonly LogicalPlanIssue[];

  constructor(issues: readonly LogicalPlanIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "LogicalPlanError";
    this.issues = Object.freeze([...issues]);
  }
}

export interface InferredLogicalExpression {
  readonly type: LogicalValueType;
  readonly nullable: boolean;
}

export type LogicalExpressionSlotResolver = (
  id: SlotId,
  path: string,
) => Pick<LogicalSlot, "type" | "nullable">;

function scalar(
  scalarType:
    "boolean" | "number" | "string" | "date" | "datetime" | "json-scalar",
  unit?: "ms" | "px" | "ratio",
): LogicalValueType {
  return { kind: "scalar", scalar: scalarType, ...(unit ? { unit } : {}) };
}

function sameType(left: LogicalValueType, right: LogicalValueType): boolean {
  return isSameLogicalValueType(left, right);
}

function requireCompatible(
  left: LogicalValueType,
  right: LogicalValueType,
  path: string,
  detail = "Expression operand types are incompatible.",
): void {
  if (!sameType(left, right)) {
    throw new LogicalPlanError([
      { code: "invalid-expression", path, message: detail },
    ]);
  }
}

function validateStringNormalization(
  normalization: unknown,
  operands: readonly LogicalValueType[],
  path: string,
): void {
  if (normalization === undefined) return;
  if (normalization !== "trim" && normalization !== "trim-case-fold") {
    throw new LogicalPlanError([
      {
        code: "invalid-expression",
        path,
        message: "String normalization mode is invalid.",
      },
    ]);
  }
  if (
    operands.some(
      (operand) => operand.kind !== "scalar" || operand.scalar !== "string",
    )
  ) {
    throw new LogicalPlanError([
      {
        code: "invalid-expression",
        path,
        message: "String normalization requires string scalar operands.",
      },
    ]);
  }
}

function infer(
  expression: LogicalExpr,
  resolveSlot: LogicalExpressionSlotResolver,
  path: string,
): InferredLogicalExpression {
  switch (expression.kind) {
    case "slot":
      return resolveSlot(expression.slot, `${path}.slot`);
    case "literal":
      if (
        expression.valueType.kind !== "scalar" ||
        ![
          "boolean",
          "number",
          "string",
          "date",
          "datetime",
          "json-scalar",
          "unknown",
        ].includes(expression.valueType.scalar) ||
        (expression.valueType.unit !== undefined &&
          (!(["ms", "px", "ratio"] as const).includes(
            expression.valueType.unit,
          ) ||
            expression.valueType.scalar !== "number")) ||
        (expression.valueType.scalar === "boolean" &&
          expression.value !== null &&
          typeof expression.value !== "boolean") ||
        (expression.valueType.scalar === "number" &&
          expression.value !== null &&
          (typeof expression.value !== "number" ||
            !Number.isFinite(expression.value))) ||
        (["string", "date", "datetime", "json-scalar"].includes(
          expression.valueType.scalar,
        ) &&
          expression.value !== null &&
          typeof expression.value !== "string")
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "Literal value does not match its declared scalar type.",
          },
        ]);
      }
      return {
        type: expression.valueType,
        nullable: expression.value === null,
      };
    case "elapsed-duration-literal":
      if (
        typeof expression.amount !== "number" ||
        !Number.isFinite(expression.amount) ||
        !["ms", "s", "m", "h", "d", "w"].includes(expression.unit)
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message:
              "Elapsed duration literals require a finite amount and elapsed unit.",
          },
        ]);
      }
      return { type: { kind: "duration" }, nullable: false };
    case "calendar-period-literal":
      if (
        typeof expression.amount !== "number" ||
        !Number.isFinite(expression.amount) ||
        !["d", "w", "mo", "y"].includes(expression.unit)
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message:
              "Calendar period literals require a finite amount and calendar unit.",
          },
        ]);
      }
      return { type: { kind: "calendar-period" }, nullable: false };
    case "comparison": {
      const left = infer(expression.left, resolveSlot, `${path}.left`);
      const right = infer(expression.right, resolveSlot, `${path}.right`);
      requireCompatible(left.type, right.type, path);
      validateStringNormalization(
        expression.stringNormalization,
        [left.type, right.type],
        `${path}.stringNormalization`,
      );
      if (
        left.type.kind === "entity" &&
        !["eq", "neq"].includes(expression.operator)
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "Entity values only support equality and inequality.",
          },
        ]);
      }
      if (
        left.type.kind === "bucket" &&
        !["eq", "neq"].includes(expression.operator)
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "Bucket values only support equality and inequality.",
          },
        ]);
      }
      if (
        left.type.kind === "calendar-period" &&
        !["eq", "neq"].includes(expression.operator)
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "Calendar periods only support equality and inequality.",
          },
        ]);
      }
      return {
        type: scalar("boolean"),
        nullable: left.nullable || right.nullable,
      };
    }
    case "boolean": {
      if (expression.terms.length === 0) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "Boolean expressions must contain at least one term.",
          },
        ]);
      }
      const terms = expression.terms.map((term, index) =>
        infer(term, resolveSlot, `${path}.terms[${index}]`),
      );
      if (
        terms.some(
          (term) =>
            term.type.kind !== "scalar" || term.type.scalar !== "boolean",
        )
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "Boolean operators require boolean scalar terms.",
          },
        ]);
      }
      return {
        type: scalar("boolean"),
        nullable: terms.some((term) => term.nullable),
      };
    }
    case "not": {
      const input = infer(expression.input, resolveSlot, `${path}.input`);
      if (input.type.kind !== "scalar" || input.type.scalar !== "boolean") {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "NOT requires a boolean scalar expression.",
          },
        ]);
      }
      return input;
    }
    case "null-test":
      infer(expression.input, resolveSlot, `${path}.input`);
      return { type: scalar("boolean"), nullable: false };
    case "set-membership": {
      const input = infer(expression.input, resolveSlot, `${path}.input`);
      validateStringNormalization(
        expression.stringNormalization,
        [input.type],
        `${path}.stringNormalization`,
      );
      expression.values.forEach((value, index) => {
        infer(value, resolveSlot, `${path}.values[${index}]`);
        requireCompatible(
          input.type,
          value.valueType,
          `${path}.values[${index}]`,
          "Set membership literal does not match the input type.",
        );
      });
      return {
        type: scalar("boolean"),
        nullable:
          input.nullable || expression.values.some((v) => v.value === null),
      };
    }
    case "string-match": {
      const input = infer(expression.input, resolveSlot, `${path}.input`);
      if (input.type.kind !== "scalar" || input.type.scalar !== "string") {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "String matching requires a string scalar expression.",
          },
        ]);
      }
      validateStringNormalization(
        expression.stringNormalization,
        [input.type],
        `${path}.stringNormalization`,
      );
      return { type: scalar("boolean"), nullable: input.nullable };
    }
    case "arithmetic": {
      if (
        expression.operator === "divide" &&
        expression.zeroDenominator !== "null"
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "Division must map a zero denominator to null.",
          },
        ]);
      }
      const left = infer(expression.left, resolveSlot, `${path}.left`);
      const right = infer(expression.right, resolveSlot, `${path}.right`);
      const nullable = left.nullable || right.nullable;
      if (
        expression.operator === "subtract" &&
        left.type.kind === "scalar" &&
        right.type.kind === "scalar" &&
        left.type.scalar === "datetime" &&
        right.type.scalar === "datetime"
      ) {
        return { type: { kind: "duration" }, nullable };
      }
      if (
        (expression.operator === "add" || expression.operator === "subtract") &&
        left.type.kind === right.type.kind &&
        (left.type.kind === "duration" || left.type.kind === "calendar-period")
      ) {
        return { type: left.type, nullable };
      }
      if (left.type.kind === "duration" || right.type.kind === "duration") {
        const leftDuration = left.type.kind === "duration";
        const rightDuration = right.type.kind === "duration";
        const leftNumber =
          left.type.kind === "scalar" &&
          left.type.scalar === "number" &&
          left.type.unit === undefined;
        const rightNumber =
          right.type.kind === "scalar" &&
          right.type.scalar === "number" &&
          right.type.unit === undefined;
        if (expression.operator === "divide" && leftDuration && rightDuration)
          return { type: scalar("number", "ratio"), nullable };
        if (
          (expression.operator === "multiply" &&
            ((leftDuration && rightNumber) || (rightDuration && leftNumber))) ||
          (expression.operator === "divide" && leftDuration && rightNumber)
        ) {
          return { type: { kind: "duration" }, nullable };
        }
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message:
              "Elapsed duration arithmetic requires durations or unitless numbers.",
          },
        ]);
      }
      if (
        left.type.kind === "calendar-period" ||
        right.type.kind === "calendar-period"
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message:
              "Calendar periods only support addition and subtraction with calendar periods.",
          },
        ]);
      }
      if (
        left.type.kind !== "scalar" ||
        right.type.kind !== "scalar" ||
        left.type.scalar !== "number" ||
        right.type.scalar !== "number"
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "Arithmetic operators require numeric scalar operands.",
          },
        ]);
      }
      let resultType: LogicalValueType;
      if (expression.operator === "add" || expression.operator === "subtract") {
        requireCompatible(left.type, right.type, path);
        resultType = left.type;
      } else if (expression.operator === "multiply") {
        if (left.type.unit && right.type.unit) {
          throw new LogicalPlanError([
            {
              code: "invalid-expression",
              path,
              message: "Multiplying two unit-bearing values is unsupported.",
            },
          ]);
        }
        resultType = left.type.unit ? left.type : right.type;
      } else if (left.type.unit && right.type.unit) {
        if (left.type.unit !== right.type.unit) {
          throw new LogicalPlanError([
            {
              code: "invalid-expression",
              path,
              message: "Division units are incompatible.",
            },
          ]);
        }
        resultType = scalar("number", "ratio");
      } else {
        if (left.type.unit) resultType = left.type;
        else if (!right.type.unit) resultType = scalar("number", "ratio");
        else {
          throw new LogicalPlanError([
            {
              code: "invalid-expression",
              path,
              message: "Division by a unit-bearing value is unsupported.",
            },
          ]);
        }
      }
      return {
        type: resultType,
        nullable,
      };
    }
    case "round": {
      const input = infer(expression.input, resolveSlot, `${path}.input`);
      if (input.type.kind !== "scalar" || input.type.scalar !== "number") {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "ROUND requires a numeric scalar expression.",
          },
        ]);
      }
      return input;
    }
    case "coalesce": {
      if (expression.values.length === 0) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "COALESCE requires at least one value.",
          },
        ]);
      }
      const values = expression.values.map((value, index) =>
        infer(value, resolveSlot, `${path}.values[${index}]`),
      );
      values
        .slice(1)
        .forEach((value) =>
          requireCompatible(values[0].type, value.type, path),
        );
      return {
        type: values[0].type,
        nullable: values.every((value) => value.nullable),
      };
    }
    case "case": {
      const branches = expression.branches.map((branch, index) => {
        const condition = infer(
          branch.when,
          resolveSlot,
          `${path}.branches[${index}].when`,
        );
        if (
          condition.type.kind !== "scalar" ||
          condition.type.scalar !== "boolean"
        ) {
          throw new LogicalPlanError([
            {
              code: "invalid-expression",
              path: `${path}.branches[${index}].when`,
              message: "CASE conditions must be boolean scalar expressions.",
            },
          ]);
        }
        return infer(
          branch.then,
          resolveSlot,
          `${path}.branches[${index}].then`,
        );
      });
      const otherwise = infer(
        expression.otherwise,
        resolveSlot,
        `${path}.otherwise`,
      );
      branches.forEach((branch) =>
        requireCompatible(branch.type, otherwise.type, path),
      );
      return {
        type: otherwise.type,
        nullable:
          otherwise.nullable || branches.some((branch) => branch.nullable),
      };
    }
    case "time-bucket": {
      const input = infer(expression.input, resolveSlot, `${path}.input`);
      if (
        !isCalendarGranularity(expression.granularity) ||
        typeof expression.reportingTimeZone !== "string" ||
        expression.reportingTimeZone.length === 0
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message:
              "Time buckets require a supported granularity and reporting time zone.",
          },
        ]);
      }
      if (
        input.type.kind !== "scalar" ||
        !["date", "datetime", "number"].includes(input.type.scalar)
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message:
              "Time bucketing requires a date, datetime, or epoch value.",
          },
        ]);
      }
      return { type: { kind: "bucket" }, nullable: input.nullable };
    }
  }
}

export function inferLogicalExpression(
  expression: LogicalExpr,
  resolveSlot: LogicalExpressionSlotResolver,
  path = "expression",
): InferredLogicalExpression {
  return infer(expression, resolveSlot, path);
}

interface RelationState {
  readonly node: LogicalNode;
  readonly visible: ReadonlySet<SlotId>;
  readonly grain: LogicalGrain;
  readonly slotTypes: ReadonlyMap<SlotId, LogicalSlot>;
}

function fail(
  code: LogicalPlanIssueCode,
  path: string,
  message: string,
): never {
  throw new LogicalPlanError([{ code, path, message }]);
}

function sameGrain(left: LogicalGrain, right: LogicalGrain): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "scalar" && right.kind === "scalar") return true;
  if (left.kind === "entity" && right.kind === "entity") {
    return left.entity === right.entity && left.key === right.key;
  }
  return (
    left.kind === "keyed" &&
    right.kind === "keyed" &&
    left.keys.length === right.keys.length &&
    left.keys.every((key, index) => key === right.keys[index])
  );
}

function checkGrain(
  declared: LogicalGrain,
  expected: LogicalGrain,
  slots: ReadonlyMap<SlotId, LogicalSlot>,
  path: string,
): void {
  if (!sameGrain(declared, expected)) {
    fail(
      "invalid-grain",
      path,
      "Declared grain does not match node semantics.",
    );
  }
  const grainKeySet = new Set(grainKeys(expected));
  if (
    expected.kind === "keyed" &&
    (expected.keys.length === 0 || grainKeySet.size !== expected.keys.length)
  ) {
    fail(
      "invalid-grain",
      path,
      "Keyed grain must contain unique visible keys.",
    );
  }
  for (const key of grainKeySet) {
    const slot = slots.get(key);
    if (!slot) fail("invalid-grain", path, `Grain key ${key} is not declared.`);
    if (expected.kind === "entity" && slot.nullable) {
      fail("invalid-grain", path, `Grain key ${key} must be non-null.`);
    }
    if (expected.kind === "entity") {
      if (slot.type.kind !== "entity" || slot.type.entity !== expected.entity) {
        fail(
          "invalid-grain",
          path,
          `Entity grain key must have type Entity<${expected.entity}>.`,
        );
      }
    }
  }
}

function compareSlot(
  slot: LogicalSlot,
  expected: InferredLogicalExpression,
  path: string,
): void {
  if (!sameType(slot.type, expected.type)) {
    fail(
      "invalid-expression",
      path,
      "Output slot type does not match expression type.",
    );
  }
  if (slot.nullable !== expected.nullable) {
    fail(
      "invalid-expression",
      path,
      "Output slot nullability does not match expression.",
    );
  }
}

function resolveVisibleSlot(
  state: RelationState,
  id: SlotId,
  path: string,
): LogicalSlot {
  if (!state.visible.has(id)) {
    fail(
      "invisible-slot",
      path,
      `Slot ${id} is not visible from this relation.`,
    );
  }
  const slot = state.slotTypes.get(id);
  if (!slot) fail("invisible-slot", path, `Slot ${id} is not declared.`);
  return slot;
}

function validateOutputSlots(
  output: readonly SlotId[],
  slots: ReadonlyMap<SlotId, LogicalSlot>,
  path: string,
): void {
  const seen = new Set<SlotId>();
  output.forEach((id, index) => {
    if (seen.has(id))
      fail(
        "invalid-topology",
        `${path}[${index}]`,
        "Output slot is duplicated.",
      );
    seen.add(id);
    if (!slots.has(id))
      fail(
        "invalid-topology",
        `${path}[${index}]`,
        `Slot ${id} is not declared.`,
      );
  });
}

function sameOutput(
  left: readonly SlotId[],
  right: readonly SlotId[],
): boolean {
  return (
    left.length === right.length &&
    left.every((slot, index) => slot === right[index])
  );
}

function assertRelation(
  id: RelationId,
  states: ReadonlyMap<RelationId, RelationState>,
  path: string,
): RelationState {
  const state = states.get(id);
  if (!state)
    fail("invalid-topology", path, `Input relation ${id} must appear earlier.`);
  return state;
}

function joinKeysCoverGrain(
  right: RelationState,
  keys: readonly { readonly left: SlotId; readonly right: SlotId }[],
): boolean {
  const rightKeys = grainKeys(right.grain);
  return rightKeys.every((key) =>
    keys.some((joinKey) => joinKey.right === key),
  );
}

function validateJoinKeys(
  left: RelationState,
  right: RelationState,
  keys: readonly { readonly left: SlotId; readonly right: SlotId }[],
  path: string,
): void {
  const seenLeft = new Set<SlotId>();
  const seenRight = new Set<SlotId>();
  keys.forEach((key, index) => {
    const keyPath = `${path}[${index}]`;
    if (seenLeft.has(key.left) || seenRight.has(key.right)) {
      fail("invalid-join", keyPath, "Join key slots must not repeat.");
    }
    seenLeft.add(key.left);
    seenRight.add(key.right);
    const leftSlot = resolveVisibleSlot(left, key.left, `${keyPath}.left`);
    const rightSlot = resolveVisibleSlot(right, key.right, `${keyPath}.right`);
    if (!sameType(leftSlot.type, rightSlot.type)) {
      fail("invalid-join", keyPath, "Join key types must match exactly.");
    }
  });
}

function validateSourceBinding(
  binding: SourceValueBinding,
  entity: LogicalNode & { readonly kind: "source" },
  slot: LogicalSlot,
  path: string,
): void {
  if (binding.kind === "self") {
    if (
      slot.type.kind !== "entity" ||
      slot.type.entity !== entity.entity ||
      slot.nullable
    ) {
      fail(
        "invalid-source",
        path,
        "Self binding must be a non-null entity slot matching the source.",
      );
    }
    return;
  }
  if (binding.kind === "related-entity") {
    const relationship = semanticRelationship(binding.relationship);
    if (!relationship || relationship.from !== entity.entity) {
      fail(
        "invalid-source",
        path,
        "Relationship is not available from this source entity.",
      );
    }
    if (
      slot.type.kind !== "entity" ||
      slot.type.entity !== relationship.to ||
      slot.nullable !== relationship.optional
    ) {
      fail(
        "invalid-source",
        path,
        "Related entity slot type or nullability is invalid.",
      );
    }
    return;
  }
  if (binding.kind === "attribute") {
    const attribute = semanticAttribute(binding.attribute);
    if (!attribute)
      fail("invalid-source", path, `Unknown attribute ${binding.attribute}.`);
    const observationFallback =
      entity.entity === "observation" &&
      (attribute.nativeEntity === "page" ||
        attribute.nativeEntity === "event") &&
      attribute.observationKinds.includes(attribute.nativeEntity);
    if (attribute.nativeEntity !== entity.entity && !observationFallback) {
      fail(
        "invalid-source",
        path,
        "Attribute is not available on this source entity.",
      );
    }
    const nullable = attribute.nullable || observationFallback;
    if (
      !sameType(slot.type, attribute.valueType) ||
      slot.nullable !== nullable
    ) {
      fail(
        "invalid-source",
        path,
        "Attribute slot metadata differs from the semantic catalog.",
      );
    }
    return;
  }
  if (
    !["page", "event", "observation"].includes(entity.entity) ||
    slot.type.kind !== "scalar" ||
    slot.type.scalar !== "datetime" ||
    slot.nullable
  ) {
    fail(
      "invalid-source",
      path,
      "Occurrence time is only available as a non-null datetime on observations.",
    );
  }
}

function inferAggregateMeasure(
  measure: LogicalAggregateMeasure,
  state: RelationState,
  path: string,
): InferredLogicalExpression {
  if (measure.kind === "count-rows") {
    return { type: scalar("number"), nullable: false };
  }
  const input = inferLogicalExpression(
    measure.input,
    (id, slotPath) => resolveVisibleSlot(state, id, slotPath),
    `${path}.input`,
  );
  if (measure.kind === "count-distinct") {
    return { type: scalar("number"), nullable: false };
  }
  if (measure.kind === "sum" || measure.kind === "avg") {
    if (input.type.kind !== "scalar" || input.type.scalar !== "number") {
      fail(
        "invalid-expression",
        `${path}.input`,
        "SUM and AVG require numeric values.",
      );
    }
  }
  if (
    (measure.kind === "min" || measure.kind === "max") &&
    input.type.kind !== "scalar"
  ) {
    fail(
      "invalid-expression",
      `${path}.input`,
      "MIN and MAX require scalar values.",
    );
  }
  return { type: input.type, nullable: true };
}

function aggregateExpectedGrain(node: AggregateNode): LogicalGrain {
  return node.groups.length === 0
    ? { kind: "scalar" }
    : { kind: "keyed", keys: node.groups.map((group) => group.slot) };
}

function validateNode(
  node: LogicalNode,
  path: string,
  slots: ReadonlyMap<SlotId, LogicalSlot>,
  states: ReadonlyMap<RelationId, RelationState>,
  plan: LogicalPlan,
): RelationState {
  validateOutputSlots(node.output, slots, `${path}.output`);
  const types = slots;
  let expectedOutput: readonly SlotId[];
  let expectedGrain: LogicalGrain;
  switch (node.kind) {
    case "source": {
      if (!isAnalyticsEntityKind(node.entity))
        fail("invalid-source", `${path}.entity`, "Unknown source entity.");
      if (!temporalDomainExists(plan.context.time, node.temporalDomain)) {
        fail(
          "invalid-source",
          `${path}.temporalDomain`,
          "Source temporal domain is invalid.",
        );
      }
      const bindingIds = new Set<SlotId>();
      const selfBindings = node.values.filter((value) => value.kind === "self");
      if (selfBindings.length !== 1)
        fail(
          "invalid-source",
          `${path}.values`,
          "Every source must expose exactly one self entity slot.",
        );
      node.values.forEach((binding, index) => {
        const bindingPath = `${path}.values[${index}]`;
        if (bindingIds.has(binding.slot))
          fail(
            "invalid-source",
            bindingPath,
            "Source binding slot is duplicated.",
          );
        bindingIds.add(binding.slot);
        const slot = types.get(binding.slot);
        if (!slot)
          fail(
            "invalid-source",
            `${bindingPath}.slot`,
            "Source binding slot is not declared.",
          );
        validateSourceBinding(binding, node, slot, bindingPath);
      });
      expectedOutput = node.values.map((binding) => binding.slot);
      if (!sameOutput(node.output, expectedOutput))
        fail(
          "invalid-source",
          `${path}.output`,
          "Source output must match its value bindings.",
        );
      const self = selfBindings[0];
      if (!self)
        fail(
          "invalid-source",
          `${path}.values`,
          "Source self binding is missing.",
        );
      expectedGrain = { kind: "entity", entity: node.entity, key: self.slot };
      break;
    }
    case "relationship-lookup": {
      if (!isSemanticRelationshipId(node.relationship)) {
        fail(
          "invalid-topology",
          `${path}.relationship`,
          "Relationship lookup references an unknown semantic relationship.",
        );
      }
      const relationship = semanticRelationship(node.relationship);
      if (!relationship) {
        fail(
          "invalid-topology",
          `${path}.relationship`,
          "Relationship lookup references an unknown semantic relationship.",
        );
      }
      if (node.timeSemantics !== "identity-no-activity-filter") {
        fail(
          "invalid-topology",
          `${path}.timeSemantics`,
          "Relationship lookup must use identity semantics without activity-time filtering.",
        );
      }
      if (
        relationship.cardinality !== "one-to-one" &&
        relationship.cardinality !== "many-to-one"
      ) {
        fail(
          "invalid-topology",
          `${path}.relationship`,
          "Relationship lookup requires a single-valued relationship.",
        );
      }
      const input = assertRelation(node.input, states, `${path}.input`);
      if (
        input.grain.kind !== "entity" ||
        input.grain.entity !== relationship.from
      ) {
        fail(
          "invalid-grain",
          `${path}.input`,
          "Relationship lookup input must have the relationship source entity grain.",
        );
      }
      if (node.inputKey !== input.grain.key) {
        fail(
          "invalid-topology",
          `${path}.inputKey`,
          "Relationship lookup must use the input entity grain key.",
        );
      }
      const inputKey = resolveVisibleSlot(
        input,
        node.inputKey,
        `${path}.inputKey`,
      );
      if (
        inputKey.type.kind !== "entity" ||
        inputKey.type.entity !== relationship.from ||
        inputKey.nullable
      ) {
        fail(
          "invalid-grain",
          `${path}.inputKey`,
          "Relationship lookup key must be a visible, non-null source entity key.",
        );
      }
      const relatedSlot = types.get(node.relatedSlot);
      if (
        !relatedSlot ||
        relatedSlot.type.kind !== "entity" ||
        relatedSlot.type.entity !== relationship.to ||
        relatedSlot.nullable !== relationship.optional ||
        relatedSlot.lineage.kind !== "relationship" ||
        relatedSlot.lineage.relationship !== relationship.id
      ) {
        fail(
          "invalid-expression",
          `${path}.relatedSlot`,
          "Relationship lookup output type, nullability, or lineage differs from the semantic catalog.",
        );
      }
      expectedOutput = [...input.node.output, node.relatedSlot];
      expectedGrain = input.grain;
      break;
    }
    case "filter": {
      const input = assertRelation(node.input, states, `${path}.input`);
      const predicate = inferLogicalExpression(
        node.predicate,
        (id, slotPath) => resolveVisibleSlot(input, id, slotPath),
        `${path}.predicate`,
      );
      if (
        predicate.type.kind !== "scalar" ||
        predicate.type.scalar !== "boolean"
      ) {
        fail(
          "invalid-expression",
          `${path}.predicate`,
          "Filter predicate must be boolean.",
        );
      }
      expectedOutput = input.node.output;
      expectedGrain = input.grain;
      break;
    }
    case "project": {
      const input = assertRelation(node.input, states, `${path}.input`);
      node.projections.forEach((projection, index) => {
        const expected = inferLogicalExpression(
          projection.expression,
          (id, slotPath) => resolveVisibleSlot(input, id, slotPath),
          `${path}.projections[${index}].expression`,
        );
        const slot = types.get(projection.slot);
        if (!slot)
          fail(
            "invalid-topology",
            `${path}.projections[${index}].slot`,
            "Projection output slot is not declared.",
          );
        compareSlot(slot, expected, `${path}.projections[${index}].slot`);
      });
      expectedOutput = node.projections.map((projection) => projection.slot);
      const mapping = new Map<SlotId, SlotId>();
      const sourceGrainKeys = grainKeys(input.grain);
      for (const key of sourceGrainKeys) {
        const projection = node.projections.find(
          (candidate) =>
            candidate.expression.kind === "slot" &&
            candidate.expression.slot === key,
        );
        if (!projection)
          fail(
            "invalid-grain",
            path,
            "Project must preserve every input grain key.",
          );
        mapping.set(key, projection.slot);
      }
      if (input.grain.kind === "entity") {
        const key = mapping.get(input.grain.key);
        if (!key)
          fail("invalid-grain", path, "Project lost the entity grain key.");
        expectedGrain = { kind: "entity", entity: input.grain.entity, key };
      } else if (input.grain.kind === "keyed") {
        expectedGrain = {
          kind: "keyed",
          keys: input.grain.keys.map((key) => mapping.get(key)!),
        };
      } else expectedGrain = { kind: "scalar" };
      break;
    }
    case "aggregate": {
      const input = assertRelation(node.input, states, `${path}.input`);
      node.groups.forEach((group, index) => {
        const expression = inferLogicalExpression(
          group.expression,
          (id, slotPath) => resolveVisibleSlot(input, id, slotPath),
          `${path}.groups[${index}].expression`,
        );
        const slot = types.get(group.slot);
        if (!slot)
          fail(
            "invalid-topology",
            `${path}.groups[${index}].slot`,
            "Group output slot is not declared.",
          );
        compareSlot(slot, expression, `${path}.groups[${index}].slot`);
      });
      node.measures.forEach((measure, index) => {
        const expected = inferAggregateMeasure(
          measure,
          input,
          `${path}.measures[${index}]`,
        );
        const slot = types.get(measure.output);
        if (!slot)
          fail(
            "invalid-topology",
            `${path}.measures[${index}].output`,
            "Measure output slot is not declared.",
          );
        compareSlot(slot, expected, `${path}.measures[${index}].output`);
      });
      expectedOutput = [
        ...node.groups.map((group) => group.slot),
        ...node.measures.map((measure) => measure.output),
      ];
      expectedGrain = aggregateExpectedGrain(node);
      break;
    }
    case "distinct": {
      const input = assertRelation(node.input, states, `${path}.input`);
      node.keys.forEach((key, index) => {
        const inputSlot = resolveVisibleSlot(
          input,
          key.input,
          `${path}.keys[${index}].input`,
        );
        const outputSlot = types.get(key.output);
        if (!outputSlot)
          fail(
            "invalid-topology",
            `${path}.keys[${index}].output`,
            "Distinct output slot is not declared.",
          );
        const nullable = node.excludeNull ? false : inputSlot.nullable;
        if (
          !sameType(outputSlot.type, inputSlot.type) ||
          outputSlot.nullable !== nullable
        ) {
          fail(
            "invalid-expression",
            `${path}.keys[${index}].output`,
            "Distinct output metadata does not match its input.",
          );
        }
      });
      expectedOutput = node.keys.map((key) => key.output);
      const keys = node.keys.map((key) => key.output);
      expectedGrain =
        keys.length === 1 &&
        types.get(keys[0]!)?.type.kind === "entity" &&
        !types.get(keys[0]!)?.nullable
          ? {
              kind: "entity",
              entity: (
                types.get(keys[0]!)!.type as Extract<
                  LogicalValueType,
                  { kind: "entity" }
                >
              ).entity,
              key: keys[0]!,
            }
          : { kind: "keyed", keys };
      break;
    }
    case "set-operation": {
      if (
        !(["union", "intersect", "difference"] as const).includes(
          node.operation,
        )
      )
        fail(
          "invalid-topology",
          `${path}.operation`,
          "Set operation kind is invalid.",
        );
      if (node.inputs.length < 2)
        fail(
          "invalid-topology",
          `${path}.inputs`,
          "Set operations require at least two input relations.",
        );
      if (node.operation === "difference" && node.inputs.length !== 2)
        fail(
          "invalid-topology",
          `${path}.inputs`,
          "Difference requires exactly two input relations.",
        );
      const inputs = node.inputs.map((id, index) =>
        assertRelation(id, states, `${path}.inputs[${index}]`),
      );
      const first = inputs[0]!;
      inputs.slice(1).forEach((input, inputIndex) => {
        if (
          input.node.output.length !== first.node.output.length ||
          !sameGrainShape(input.grain, first.grain)
        ) {
          fail(
            "invalid-grain",
            `${path}.inputs[${inputIndex + 1}]`,
            "Set inputs must have compatible output and grain shapes.",
          );
        }
        input.node.output.forEach((id, slotIndex) => {
          const firstSlot = types.get(first.node.output[slotIndex]!);
          const itemSlot = types.get(id);
          if (
            !firstSlot ||
            !itemSlot ||
            !sameType(firstSlot.type, itemSlot.type)
          ) {
            fail(
              "invalid-expression",
              `${path}.inputs[${inputIndex + 1}][${slotIndex}]`,
              "Set input slot types must match by position.",
            );
          }
        });
        const firstGrainPositions = grainKeys(first.grain).map((key) =>
          first.node.output.indexOf(key),
        );
        const inputGrainPositions = grainKeys(input.grain).map((key) =>
          input.node.output.indexOf(key),
        );
        if (
          firstGrainPositions.some(
            (position, index) => position !== inputGrainPositions[index],
          )
        ) {
          fail(
            "invalid-grain",
            `${path}.inputs[${inputIndex + 1}]`,
            "Set input grain keys must occupy matching output positions.",
          );
        }
      });
      if (node.output.length !== first.node.output.length)
        fail(
          "invalid-topology",
          `${path}.output`,
          "Set output arity must match its inputs.",
        );
      node.output.forEach((id, index) => {
        const slot = types.get(id)!;
        const inputsAtPosition = inputs.map((input) =>
          types.get(input.node.output[index]!)!,
        );
        const expectedNullable = setOperationResultNullable(
          node.operation,
          inputsAtPosition.map((input) => input.nullable),
        );
        if (
          !sameType(slot.type, inputsAtPosition[0]!.type) ||
          slot.nullable !== expectedNullable
        ) {
          fail(
            "invalid-expression",
            `${path}.output[${index}]`,
            "Set output metadata must represent all inputs.",
          );
        }
      });
      const firstKeys = grainKeys(first.grain);
      const remapped = firstKeys.map((key) => {
        const position = first.node.output.indexOf(key);
        if (position < 0)
          fail(
            "invalid-grain",
            path,
            "Input grain key is not visible in its output.",
          );
        return node.output[position]!;
      });
      if (first.grain.kind === "entity")
        expectedGrain = {
          kind: "entity",
          entity: first.grain.entity,
          key: remapped[0]!,
        };
      else if (first.grain.kind === "keyed")
        expectedGrain = { kind: "keyed", keys: remapped };
      else expectedGrain = { kind: "scalar" };
      expectedOutput = node.output;
      break;
    }
    case "semi-join":
    case "anti-join": {
      const left = assertRelation(node.left, states, `${path}.left`);
      const right = assertRelation(node.right, states, `${path}.right`);
      validateJoinKeys(left, right, node.keys, `${path}.keys`);
      expectedOutput = left.node.output;
      expectedGrain = left.grain;
      break;
    }
    case "join": {
      const left = assertRelation(node.left, states, `${path}.left`);
      const right = assertRelation(node.right, states, `${path}.right`);
      validateJoinKeys(left, right, node.keys, `${path}.keys`);
      if (!joinKeysCoverGrain(right, node.keys)) {
        fail(
          "invalid-join",
          `${path}.keys`,
          "Join keys do not cover right grain.",
        );
      }
      if (node.joinType === "inner") {
        if (node.rightAliases.length !== 0)
          fail(
            "invalid-join",
            `${path}.rightAliases`,
            "Inner joins do not alias right slots.",
          );
        expectedOutput = [...left.node.output, ...right.node.output];
      } else {
        if (node.rightAliases.length !== right.node.output.length)
          fail(
            "invalid-join",
            `${path}.rightAliases`,
            "Left joins must alias every right output slot.",
          );
        node.rightAliases.forEach((alias, index) => {
          if (alias.source !== right.node.output[index])
            fail(
              "invalid-join",
              `${path}.rightAliases[${index}].source`,
              "Left join aliases must preserve right output order.",
            );
          const source = types.get(alias.source)!;
          const output = types.get(alias.alias);
          if (
            !output ||
            !sameType(source.type, output.type) ||
            !output.nullable
          ) {
            fail(
              "invalid-join",
              `${path}.rightAliases[${index}].alias`,
              "Left join right outputs must be nullable aliases of source slots.",
            );
          }
        });
        expectedOutput = [
          ...left.node.output,
          ...node.rightAliases.map((alias) => alias.alias),
        ];
      }
      expectedGrain = left.grain;
      break;
    }
    case "sort": {
      const input = assertRelation(node.input, states, `${path}.input`);
      node.keys.forEach((key, index) => {
        const keyPath = `${path}.keys[${index}]`;
        resolveVisibleSlot(input, key.slot, `${keyPath}.slot`);
        if (key.direction !== "asc" && key.direction !== "desc")
          fail(
            "invalid-topology",
            `${keyPath}.direction`,
            "Sort direction is invalid.",
          );
        if (key.nulls !== "first" && key.nulls !== "last")
          fail(
            "invalid-topology",
            `${keyPath}.nulls`,
            "Sort null ordering is invalid.",
          );
      });
      expectedOutput = input.node.output;
      expectedGrain = input.grain;
      break;
    }
    case "limit": {
      const input = assertRelation(node.input, states, `${path}.input`);
      if (!Number.isInteger(node.count) || node.count < 0)
        fail(
          "invalid-topology",
          `${path}.count`,
          "Limit count must be a non-negative integer.",
        );
      expectedOutput = input.node.output;
      expectedGrain = input.grain;
      break;
    }
  }
  if (!sameOutput(node.output, expectedOutput)) {
    fail(
      "invalid-topology",
      `${path}.output`,
      "Node output does not match derived visible slots.",
    );
  }
  if (grainKeys(expectedGrain).some((key) => !node.output.includes(key))) {
    fail(
      "invalid-grain",
      `${path}.grain`,
      "Every grain key must be visible in the node output.",
    );
  }
  checkGrain(node.grain, expectedGrain, slots, `${path}.grain`);
  return {
    node,
    visible: new Set(node.output),
    grain: expectedGrain,
    slotTypes: types,
  };
}

export function validateLogicalPlan(plan: LogicalPlan): ValidatedLogicalPlan {
  if (
    !plan ||
    plan.version !== 1 ||
    !plan.context ||
    !Array.isArray(plan.nodes) ||
    !Array.isArray(plan.slots) ||
    !Array.isArray(plan.outputs)
  ) {
    fail(
      "invalid-envelope",
      "plan",
      "Logical plan envelope is invalid or unsupported.",
    );
  }
  try {
    createSemanticTemporalDomains(plan.context.time);
  } catch (error) {
    if (error instanceof LogicalPlanError) throw error;
    fail("invalid-envelope", "context", "Semantic query context is invalid.");
  }
  try {
    validateResolvedAnalyticsScope(plan.context.scope);
  } catch (error) {
    if (error instanceof LogicalPlanError) throw error;
    fail(
      "invalid-envelope",
      "context.scope",
      "Resolved scope is invalid or inconsistent.",
    );
  }
  if (
    !plan.context.subject ||
    !Array.isArray(plan.context.subject.siteIds) ||
    !isCanonicalSemanticSubjectDomain(plan.context.subject)
  ) {
    fail(
      "invalid-envelope",
      "context.subject",
      "Subject domain must include canonical site IDs.",
    );
  }
  const slots = new Map<SlotId, LogicalSlot>();
  (plan.slots as readonly LogicalSlot[]).forEach((slot, index) => {
    if (!slot || slots.has(slot.id))
      fail(
        "duplicate-id",
        `slots[${index}].id`,
        "Logical slot IDs must be unique.",
      );
    slots.set(slot.id, slot);
  });
  const relationIds = new Set<RelationId>();
  const producedSlots = new Set<SlotId>();
  const states = new Map<RelationId, RelationState>();
  (plan.nodes as readonly LogicalNode[]).forEach((node, index) => {
    const path = `nodes[${index}]`;
    if (!node || relationIds.has(node.id))
      fail(
        "duplicate-id",
        `${path}.id`,
        "Logical relation IDs must be unique.",
      );
    relationIds.add(node.id);
    const newlyProduced: readonly SlotId[] = (() => {
      switch (node.kind) {
        case "source":
          return node.values.map((binding) => binding.slot);
        case "relationship-lookup":
          return [node.relatedSlot];
        case "project":
          return node.projections.map((binding) => binding.slot);
        case "aggregate":
          return [
            ...node.groups.map((binding) => binding.slot),
            ...node.measures.map((measure) => measure.output),
          ];
        case "distinct":
          return node.keys.map((key) => key.output);
        case "set-operation":
          return node.output;
        case "join":
          return node.rightAliases.map((alias) => alias.alias);
        case "filter":
        case "semi-join":
        case "anti-join":
        case "sort":
        case "limit":
          return [];
      }
    })();
    for (const [slotIndex, slotId] of newlyProduced.entries()) {
      if (producedSlots.has(slotId)) {
        fail(
          "duplicate-id",
          `${path}.output[${slotIndex}]`,
          `Slot ${slotId} has more than one producer.`,
        );
      }
      producedSlots.add(slotId);
    }
    states.set(node.id, validateNode(node, path, slots, states, plan));
  });
  const outputIds = new Set<string>();
  (plan.outputs as readonly LogicalOutput[]).forEach((output, index) => {
    const path = `outputs[${index}]`;
    if (!output.id || outputIds.has(output.id))
      fail(
        "invalid-output",
        `${path}.id`,
        "Logical output IDs must be non-empty and unique.",
      );
    outputIds.add(output.id);
    const relation = states.get(output.relation);
    if (!relation)
      fail(
        "invalid-output",
        `${path}.relation`,
        "Output relation does not exist.",
      );
    const names = new Set<string>();
    output.fields.forEach((field, fieldIndex) => {
      const fieldPath = `${path}.fields[${fieldIndex}]`;
      if (!field.name || names.has(field.name))
        fail(
          "invalid-output",
          `${fieldPath}.name`,
          "Output field names must be non-empty and unique.",
        );
      names.add(field.name);
      resolveVisibleSlot(relation, field.slot, `${fieldPath}.slot`);
      if (field.semantic?.kind === "dimension") {
        const dimension = semanticDimension(field.semantic.id);
        const attribute = dimension
          ? semanticAttribute(dimension.attribute)
          : undefined;
        const slot = relation.slotTypes.get(field.slot);
        if (!dimension || !attribute || !slot)
          fail(
            "invalid-output",
            `${fieldPath}.semantic.id`,
            "Unknown semantic dimension.",
          );
        if (!sameType(slot.type, attribute.valueType))
          fail(
            "invalid-output",
            `${fieldPath}.slot`,
            "Dimension output slot does not match its semantic value type.",
          );
      }
      if (field.semantic?.kind === "metric") {
        const metric = semanticMetric(field.semantic.id);
        const slot = relation.slotTypes.get(field.slot);
        if (!metric || metric.visibility !== "public" || !slot)
          fail(
            "invalid-output",
            `${fieldPath}.semantic.id`,
            "Metric output must reference a registered public metric.",
          );
        if (!sameType(slot.type, metric.valueType))
          fail(
            "invalid-output",
            `${fieldPath}.slot`,
            "Metric output slot does not match its semantic value type.",
          );
      }
    });
  });
  return plan as ValidatedLogicalPlan;
}
