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
import {
  EVENT_PAYLOAD_PROPERTY_FIELDS,
  type EventPayloadPropertyField,
  isEventPayloadTopLevelPathSnapshot,
} from "@/lib/edge/analytics/engine/semantic/event-payload-logical";
import {
  EVENT_PAYLOAD_OCCURRENCE_FIELDS,
  type EventPayloadOccurrenceField,
  isEventPayloadOccurrenceField,
} from "@/lib/edge/analytics/engine/semantic/event-payload-occurrences";
import { semanticMetric } from "@/lib/edge/analytics/engine/semantic/metrics";
import { semanticPageDimension } from "@/lib/edge/analytics/engine/semantic/page-dimensions";
import {
  isSemanticRelationshipId,
  semanticRelationship,
} from "@/lib/edge/analytics/engine/semantic/relationships";
import { validateSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import {
  isCanonicalSemanticSubjectDomain,
  sameSemanticSubjectDomain,
} from "@/lib/edge/analytics/engine/semantic/subject";
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
  comparisonOperator?: "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
): void {
  if (normalization === undefined) return;
  const isComparisonOnlyMode =
    normalization === "trim-ascii-space" || normalization === "ascii-case-fold";
  if (
    normalization !== "trim" &&
    normalization !== "trim-case-fold" &&
    !isComparisonOnlyMode
  ) {
    throw new LogicalPlanError([
      {
        code: "invalid-expression",
        path,
        message: "String normalization mode is invalid.",
      },
    ]);
  }
  if (isComparisonOnlyMode && comparisonOperator === undefined) {
    throw new LogicalPlanError([
      {
        code: "invalid-expression",
        path,
        message: "String normalization mode is invalid for this expression.",
      },
    ]);
  }
  if (
    isComparisonOnlyMode &&
    comparisonOperator !== "eq" &&
    comparisonOperator !== "neq"
  ) {
    throw new LogicalPlanError([
      {
        code: "invalid-expression",
        path,
        message:
          "ASCII string normalization is supported only for equality comparisons.",
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
        (expression.valueType.scalar === "datetime" &&
          expression.value !== null &&
          !(
            typeof expression.value === "string" ||
            (typeof expression.value === "number" &&
              Number.isFinite(expression.value))
          )) ||
        (["string", "date", "json-scalar"].includes(
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
        expression.operator,
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
      const validLegacySearch =
        expression.semantics === undefined ||
        (expression.semantics === "legacy-record-search-v1" &&
          expression.operator === "contains" &&
          !expression.caseSensitive &&
          expression.stringNormalization === undefined) ||
        (expression.semantics === "legacy-report-search-v1" &&
          expression.operator === "contains" &&
          !expression.caseSensitive &&
          expression.stringNormalization === undefined &&
          typeof expression.value === "string" &&
          expression.value === expression.value.trim().toLowerCase());
      if (!validLegacySearch || typeof expression.value !== "string") {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path: path + ".semantics",
            message:
              "Legacy search semantics require case-insensitive, unnormalized contains with a normalized report search value.",
          },
        ]);
      }
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
      return {
        type: scalar("boolean"),
        nullable:
          expression.semantics === "legacy-record-search-v1" ||
          expression.semantics === "legacy-report-search-v1"
            ? false
            : input.nullable,
      };
    }
    case "string-normalize": {
      if (
        expression.normalization !== "trim-ascii-space" &&
        expression.normalization !== "trim"
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path: path + ".normalization",
            message: "String normalization mode is invalid.",
          },
        ]);
      }
      const input = infer(expression.input, resolveSlot, `${path}.input`);
      if (input.type.kind !== "scalar" || input.type.scalar !== "string") {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "String normalization requires a string scalar value.",
          },
        ]);
      }
      return { type: scalar("string"), nullable: input.nullable };
    }
    case "number-report-text": {
      const input = infer(expression.input, resolveSlot, `${path}.input`);
      if (
        expression.semantics !== "legacy-report-number-v1" ||
        input.type.kind !== "scalar" ||
        input.type.scalar !== "number" ||
        input.type.unit !== undefined
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message:
              "Legacy report number text requires a unitless numeric scalar.",
          },
        ]);
      }
      return { type: scalar("string"), nullable: input.nullable };
    }
    case "text-concatenation": {
      if (expression.values.length < 2) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path: `${path}.values`,
            message: "Text concatenation requires at least two operands.",
          },
        ]);
      }
      const values = expression.values.map((value, index) =>
        infer(value, resolveSlot, `${path}.values[${index}]`),
      );
      if (
        values.some(
          (value) =>
            value.type.kind !== "scalar" || value.type.scalar !== "string",
        )
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path: `${path}.values`,
            message: "Text concatenation accepts only scalar strings.",
          },
        ]);
      }
      return {
        type: scalar("string"),
        nullable: values.some((value) => value.nullable),
      };
    }
    case "page-dimension": {
      const definition = semanticPageDimension(expression.dimension);
      const dependencyNames = expression.dependencies.map(
        (dependency) => dependency.attribute,
      );
      if (
        !definition ||
        dependencyNames.length !== definition.dependencies.length ||
        new Set(dependencyNames).size !== dependencyNames.length ||
        definition.dependencies.some(
          (attribute) => !dependencyNames.includes(attribute),
        )
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path: `${path}.dependencies`,
            message:
              "Page dimension dependencies must exactly match the finite semantic definition.",
          },
        ]);
      }
      const dependencies = expression.dependencies.map((dependency, index) => {
        const attribute = semanticAttribute(dependency.attribute);
        const inferred = infer(
          dependency.expression,
          resolveSlot,
          `${path}.dependencies[${index}].expression`,
        );
        if (
          !attribute ||
          attribute.valueType.kind !== "scalar" ||
          !isSameLogicalValueType(inferred.type, attribute.valueType)
        ) {
          throw new LogicalPlanError([
            {
              code: "invalid-expression",
              path: `${path}.dependencies[${index}]`,
              message:
                "Page dimension dependency type does not match its semantic attribute.",
            },
          ]);
        }
        return inferred;
      });
      return {
        type: scalar("string"),
        nullable:
          definition.nullableFromDependencies &&
          dependencies.some((dependency) => dependency.nullable),
      };
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
      const nullable =
        left.nullable || right.nullable || expression.operator === "divide";
      if (
        expression.operator === "add" &&
        left.type.kind === "scalar" &&
        left.type.scalar === "datetime" &&
        expression.right.kind === "elapsed-duration-literal"
      ) {
        return { type: left.type, nullable };
      }
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
    case "numeric-value": {
      const input = infer(expression.input, resolveSlot, `${path}.input`);
      if (input.type.kind !== "scalar" || input.type.scalar !== "number") {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "Numeric-value requires a numeric scalar expression.",
          },
        ]);
      }
      return { type: scalar("number"), nullable: input.nullable };
    }
    case "absolute": {
      const input = infer(expression.input, resolveSlot, `${path}.input`);
      if (input.type.kind !== "scalar" || input.type.scalar !== "number") {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "ABS requires a numeric scalar expression.",
          },
        ]);
      }
      return input;
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
      if (
        expression.decimalPlaces !== undefined &&
        (!Number.isInteger(expression.decimalPlaces) ||
          expression.decimalPlaces < 0 ||
          expression.decimalPlaces > 15)
      ) {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "ROUND precision must be an integer from 0 through 15.",
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
      // Calendar bucketing can return NULL outside the candidate range or
      // after the shared 2000-bucket cap, even when its input is non-null.
      return {
        type: {
          kind: "bucket",
          granularity: expression.granularity,
          reportingTimeZone: expression.reportingTimeZone,
        },
        nullable: true,
      };
    }
    case "bucket-index": {
      const input = infer(expression.input, resolveSlot, `${path}.input`);
      if (input.type.kind !== "bucket") {
        throw new LogicalPlanError([
          {
            code: "invalid-expression",
            path,
            message: "Bucket indexes require a calendar bucket expression.",
          },
        ]);
      }
      return { type: scalar("number"), nullable: true };
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
  if (left.kind === "bag" && right.kind === "bag") return true;
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
  if (right.grain.kind === "bag") return false;
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

function logicalExpressionSlotReferences(expression: LogicalExpr): SlotId[] {
  const slots = new Set<SlotId>();
  const visit = (value: LogicalExpr): void => {
    switch (value.kind) {
      case "slot":
        slots.add(value.slot);
        break;
      case "literal":
      case "elapsed-duration-literal":
      case "calendar-period-literal":
        break;
      case "comparison":
      case "arithmetic":
        visit(value.left);
        visit(value.right);
        break;
      case "boolean":
        value.terms.forEach(visit);
        break;
      case "not":
      case "null-test":
      case "set-membership":
      case "string-match":
      case "string-normalize":
      case "number-report-text":
      case "numeric-value":
      case "absolute":
      case "round":
      case "time-bucket":
      case "bucket-index":
        visit(value.input);
        break;
      case "text-concatenation":
        value.values.forEach(visit);
        break;
      case "page-dimension":
        value.dependencies.forEach((dependency) =>
          visit(dependency.expression),
        );
        break;
      case "coalesce":
        value.values.forEach(visit);
        break;
      case "case":
        value.branches.forEach((branch) => {
          visit(branch.when);
          visit(branch.then);
        });
        visit(value.otherwise);
        break;
    }
  };
  visit(expression);
  return [...slots];
}

function hasDerivedLineage(
  slot: LogicalSlot | undefined,
  operation: string,
  inputs: readonly SlotId[],
): boolean {
  return (
    slot?.lineage.kind === "derived" &&
    slot.lineage.operation === operation &&
    slot.lineage.inputs.length === inputs.length &&
    slot.lineage.inputs.every((input, index) => input === inputs[index])
  );
}

function hasEventPayloadSourceProof(
  relation: RelationId,
  eventKey: SlotId,
  states: ReadonlyMap<RelationId, RelationState>,
  active: ReadonlySet<RelationId> = new Set(),
): boolean {
  if (active.has(relation)) return false;
  const state = states.get(relation);
  const key = state?.slotTypes.get(eventKey);
  if (
    !state ||
    state.grain.kind !== "entity" ||
    state.grain.entity !== "event" ||
    state.grain.key !== eventKey ||
    !state.node.output.includes(eventKey) ||
    key?.type.kind !== "entity" ||
    key.type.entity !== "event" ||
    key.nullable
  )
    return false;
  const nextActive = new Set(active).add(relation);
  if (state.node.kind === "filter")
    return hasEventPayloadSourceProof(
      state.node.input,
      eventKey,
      states,
      nextActive,
    );
  if (state.node.kind === "semi-join") {
    const left = states.get(state.node.left);
    return (
      left !== undefined &&
      state.node.output.length === left.node.output.length &&
      state.node.output.every(
        (slot, index) => slot === left.node.output[index],
      ) &&
      left.grain.kind === "entity" &&
      left.grain.entity === "event" &&
      left.grain.key === eventKey &&
      hasEventPayloadSourceProof(state.node.left, eventKey, states, nextActive)
    );
  }
  if (state.node.kind !== "source") return false;
  return (
    state.node.entity === "event" &&
    state.grain.kind === "entity" &&
    state.grain.entity === "event" &&
    state.grain.key === eventKey &&
    state.node.values.some(
      (binding) => binding.kind === "self" && binding.slot === eventKey,
    ) &&
    key?.type.kind === "entity" &&
    key.type.entity === "event" &&
    key.lineage.kind === "entity" &&
    key.lineage.entity === "event" &&
    !key.nullable
  );
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
      if (node.selection) {
        if (node.entity !== "event" && node.entity !== "page")
          fail(
            "invalid-source",
            path + ".selection",
            "Scoped selections are currently supported only on Page and Event Sources.",
          );
        if (
          (node.entity === "page" &&
            node.selection.profile !== "prepared-scoped-v1" &&
            node.selection.profile !== "prepared-page-reader-window-v1" &&
            node.selection.profile !== "prepared-scoped-reader-window-v1" &&
            node.selection.profile !== "direct-page-analytics-v1" &&
            node.selection.profile !== "direct-page-session-compat-v1" &&
            node.selection.profile !== "direct-page-entity-only-compat-v1") ||
          (node.entity === "event" &&
            (node.selection.profile === "direct-page-analytics-v1" ||
              node.selection.profile === "prepared-page-reader-window-v1"))
        )
          fail(
            "invalid-source",
            path + ".selection",
            "The scoped selection profile does not match its Source entity.",
          );
        if (
          node.entity === "page" &&
          (node.selection.profile === "prepared-scoped-v1" ||
            node.selection.profile === "prepared-page-reader-window-v1" ||
            node.selection.profile === "prepared-scoped-reader-window-v1") &&
          node.selection.eventNameGate !== undefined
        )
          fail(
            "invalid-source",
            path + ".selection",
            "page_selection_event_name_unsupported",
          );
        try {
          validateSemanticScopedSourceSelection(node.selection, plan.context);
        } catch (error) {
          fail(
            "invalid-source",
            path + ".selection",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
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
    case "event-payload-occurrences": {
      const input = assertRelation(node.input, states, `${path}.input`);
      if (
        input.grain.kind !== "entity" ||
        input.grain.entity !== "event" ||
        input.grain.key !== node.eventKey
      )
        fail(
          "invalid-grain",
          `${path}.input`,
          "Payload occurrences require one selected Event Entity relation.",
        );
      const eventKey = resolveVisibleSlot(
        input,
        node.eventKey,
        `${path}.eventKey`,
      );
      if (
        eventKey.type.kind !== "entity" ||
        eventKey.type.entity !== "event" ||
        eventKey.nullable
      )
        fail(
          "invalid-grain",
          `${path}.eventKey`,
          "Payload expansion requires the non-null Event Entity key.",
        );
      if (!hasEventPayloadSourceProof(node.input, node.eventKey, states))
        fail(
          "invalid-source",
          `${path}.eventKey`,
          "Payload expansion requires the business Event identity from the same transparent Event Source ancestry.",
        );
      if (!Array.isArray(node.fields) || node.fields.length === 0)
        fail(
          "invalid-topology",
          `${path}.fields`,
          "Payload occurrence expansion requires at least one finite output field.",
        );
      const fields = new Set<string>();
      const outputs = new Set<SlotId>();
      node.fields.forEach((binding, index) => {
        const fieldPath = `${path}.fields[${index}]`;
        if (
          !binding ||
          typeof binding.field !== "string" ||
          !isEventPayloadOccurrenceField(binding.field) ||
          fields.has(binding.field)
        )
          fail(
            "invalid-topology",
            `${fieldPath}.field`,
            "Payload occurrence fields must be unique registered names.",
          );
        fields.add(binding.field);
        const field = binding.field as EventPayloadOccurrenceField;
        if (outputs.has(binding.slot))
          fail(
            "invalid-topology",
            `${fieldPath}.slot`,
            "Payload occurrence output slots must be unique.",
          );
        outputs.add(binding.slot);
        const slot = types.get(binding.slot);
        const definition = EVENT_PAYLOAD_OCCURRENCE_FIELDS[field];
        if (
          !slot ||
          !sameType(slot.type, definition.type) ||
          slot.nullable !== definition.nullable ||
          !hasDerivedLineage(slot, `event-payload-occurrence:${field}`, [
            node.eventKey,
          ])
        )
          fail(
            "invalid-expression",
            `${fieldPath}.slot`,
            "Payload occurrence output type, nullability, or source lineage differs from its finite schema.",
          );
      });
      expectedOutput = node.fields.map(({ slot }) => slot);
      expectedGrain = { kind: "bag" };
      break;
    }
    case "event-payload-properties": {
      const input = assertRelation(node.input, states, `${path}.input`);
      if (!isEventPayloadTopLevelPathSnapshot(node.paths))
        fail(
          "invalid-topology",
          `${path}.paths`,
          "Payload paths must be a sorted finite set of supported one-segment pointers.",
        );
      const eventKey = resolveVisibleSlot(
        input,
        node.eventKey,
        `${path}.eventKey`,
      );
      if (
        input.grain.kind !== "entity" ||
        input.grain.entity !== "event" ||
        input.grain.key !== node.eventKey ||
        eventKey.type.kind !== "entity" ||
        eventKey.type.entity !== "event" ||
        eventKey.nullable ||
        !hasEventPayloadSourceProof(node.input, node.eventKey, states)
      )
        fail(
          "invalid-source",
          `${path}.input`,
          "Payload properties require a canonical Event entity relation and preserve its selected row domain.",
        );
      if (
        !Array.isArray(node.properties) ||
        node.properties.length !== node.paths.length
      )
        fail(
          "invalid-topology",
          `${path}.properties`,
          "Properties must match the finite path set.",
        );
      const seen = new Set<string>();
      const produced: SlotId[] = [];
      node.properties.forEach((property, i) => {
        if (
          property.path !== node.paths[i]?.path ||
          property.key !== node.paths[i]?.key ||
          !Array.isArray(property.fields) ||
          property.fields.length !==
            Object.keys(EVENT_PAYLOAD_PROPERTY_FIELDS).length
        )
          fail(
            "invalid-topology",
            `${path}.properties[${i}]`,
            "Property fields must match the registered path and finite schema.",
          );
        const fieldNames = new Set<string>();
        for (const [j, binding] of property.fields.entries()) {
          const at = `${path}.properties[${i}].fields[${j}]`;
          if (
            !binding ||
            typeof binding.field !== "string" ||
            !Object.hasOwn(EVENT_PAYLOAD_PROPERTY_FIELDS, binding.field) ||
            fieldNames.has(binding.field) ||
            seen.has(String(binding.slot))
          )
            fail(
              "invalid-topology",
              at,
              "Property fields and slots must be unique registered outputs.",
            );
          fieldNames.add(binding.field);
          seen.add(String(binding.slot));
          produced.push(binding.slot);
          const field = binding.field as EventPayloadPropertyField;
          const slot = types.get(binding.slot);
          const definition = EVENT_PAYLOAD_PROPERTY_FIELDS[field];
          if (
            !slot ||
            !sameType(slot.type, definition.type) ||
            slot.nullable !== definition.nullable ||
            !hasDerivedLineage(slot, `event-payload-property:${i}:${field}`, [
              node.eventKey,
            ])
          )
            fail(
              "invalid-expression",
              `${at}.slot`,
              "Property slot schema or Event lineage differs from its registered definition.",
            );
        }
      });
      expectedOutput = [...input.node.output, ...produced];
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
      } else expectedGrain = input.grain;
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
    case "sample-statistics": {
      const input = assertRelation(node.input, states, `${path}.input`);
      const outputNames = new Set<string>(["samples", "avg"]);
      node.groups.forEach((group, index) => {
        const groupPath = `${path}.groups[${index}]`;
        if (
          typeof group.name !== "string" ||
          !group.name ||
          outputNames.has(group.name)
        )
          fail(
            "invalid-topology",
            `${groupPath}.name`,
            "Sample statistics output names must be non-empty and unique.",
          );
        outputNames.add(group.name);
        const inferred = inferLogicalExpression(
          group.expression,
          (id, slotPath) => resolveVisibleSlot(input, id, slotPath),
          `${groupPath}.expression`,
        );
        if (inferred.type.kind !== "scalar" && inferred.type.kind !== "bucket")
          fail(
            "invalid-expression",
            `${groupPath}.expression`,
            "Sample statistics groups must be scalar or bucket values.",
          );
        const output = types.get(group.slot);
        if (!output)
          fail(
            "invalid-topology",
            `${groupPath}.slot`,
            "Group output slot is not declared.",
          );
        compareSlot(output, inferred, `${groupPath}.slot`);
        if (
          !hasDerivedLineage(
            output,
            "group",
            logicalExpressionSlotReferences(group.expression),
          )
        )
          fail(
            "invalid-expression",
            `${groupPath}.slot`,
            "Group output lineage does not match its expression.",
          );
      });
      const value = inferLogicalExpression(
        node.value,
        (id, slotPath) => resolveVisibleSlot(input, id, slotPath),
        `${path}.value`,
      );
      if (value.type.kind !== "scalar" || value.type.scalar !== "number")
        fail(
          "invalid-expression",
          `${path}.value`,
          "Sample statistics require a numeric scalar value.",
        );
      const valueInputs = logicalExpressionSlotReferences(node.value);
      const samples = types.get(node.samplesOutput);
      if (
        !samples ||
        !sameType(samples.type, scalar("number")) ||
        samples.nullable ||
        !hasDerivedLineage(samples, "sample-statistics:count", valueInputs)
      )
        fail(
          "invalid-expression",
          `${path}.samplesOutput`,
          "Sample count must be a non-null unitless numeric derived slot.",
        );
      const average = types.get(node.averageOutput);
      if (
        !average ||
        !sameType(average.type, value.type) ||
        !average.nullable ||
        !hasDerivedLineage(average, "sample-statistics:avg", valueInputs)
      )
        fail(
          "invalid-expression",
          `${path}.averageOutput`,
          "Average must preserve the numeric input type and be nullable.",
        );
      node.percentiles.forEach((item, index) => {
        const percentilePath = `${path}.percentiles[${index}]`;
        if (
          typeof item.name !== "string" ||
          !item.name ||
          outputNames.has(item.name) ||
          !Number.isFinite(item.percentile) ||
          !Number.isInteger(item.percentile) ||
          item.percentile < 0 ||
          item.percentile > 100
        )
          fail(
            "invalid-topology",
            percentilePath,
            "Percentiles require a unique output name and an integer from 0 through 100.",
          );
        outputNames.add(item.name);
        const output = types.get(item.output);
        if (
          !output ||
          !sameType(output.type, value.type) ||
          !output.nullable ||
          !hasDerivedLineage(
            output,
            `sample-statistics:quantile:${item.percentile}`,
            valueInputs,
          )
        )
          fail(
            "invalid-expression",
            `${percentilePath}.output`,
            "Quantile output must preserve the numeric input type and be nullable.",
          );
      });
      expectedOutput = [
        ...node.groups.map((group) => group.slot),
        node.samplesOutput,
        node.averageOutput,
        ...node.percentiles.map((item) => item.output),
      ];
      expectedGrain =
        node.groups.length === 0
          ? { kind: "scalar" }
          : { kind: "keyed", keys: node.groups.map((group) => group.slot) };
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
    case "row-concatenation": {
      if (node.inputs.length < 2)
        fail(
          "invalid-topology",
          `${path}.inputs`,
          "Row concatenation requires at least two inputs.",
        );
      if (node.columns.length === 0)
        fail(
          "invalid-topology",
          `${path}.columns`,
          "Row concatenation requires at least one output column.",
        );
      const inputs = node.inputs.map((id, index) =>
        assertRelation(id, states, `${path}.inputs[${index}]`),
      );
      const names = new Set<string>();
      const outputs = new Set<SlotId>();
      node.columns.forEach((column, index) => {
        const columnPath = `${path}.columns[${index}]`;
        if (!column.name || names.has(column.name))
          fail(
            "invalid-topology",
            `${columnPath}.name`,
            "Row concatenation column names must be non-empty and unique.",
          );
        names.add(column.name);
        if (outputs.has(column.output))
          fail(
            "invalid-topology",
            `${columnPath}.output`,
            "Row concatenation output slots must be unique.",
          );
        outputs.add(column.output);
        if (column.inputs.length !== inputs.length)
          fail(
            "invalid-topology",
            `${columnPath}.inputs`,
            "Every output column must map one slot from each input.",
          );
        const sourceSlots = column.inputs.map((id, inputIndex) =>
          resolveVisibleSlot(
            inputs[inputIndex]!,
            id,
            `${columnPath}.inputs[${inputIndex}]`,
          ),
        );
        const first = sourceSlots[0]!;
        if (
          (first.type.kind !== "scalar" && first.type.kind !== "bucket") ||
          sourceSlots.some(
            (slot) =>
              (slot.type.kind !== "scalar" && slot.type.kind !== "bucket") ||
              !sameType(slot.type, first.type),
          )
        )
          fail(
            "invalid-expression",
            `${columnPath}.inputs`,
            "Row concatenation supports only exactly matching scalar or bucket values.",
          );
        const output = types.get(column.output);
        const nullable = sourceSlots.some((slot) => slot.nullable);
        if (
          !output ||
          !sameType(output.type, first.type) ||
          output.nullable !== nullable ||
          !hasDerivedLineage(
            output,
            "append-rows",
            sourceSlots.map((slot) => slot.id),
          )
        )
          fail(
            "invalid-expression",
            `${columnPath}.output`,
            "Row concatenation output type, nullability, or provenance does not match its inputs.",
          );
      });
      expectedOutput = node.columns.map((column) => column.output);
      expectedGrain = { kind: "bag" };
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
      if (inputs.some((input) => input.grain.kind === "bag"))
        fail(
          "invalid-grain",
          `${path}.inputs`,
          "Entity set operations cannot consume bag-grain relations.",
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
      if (node.keys.length === 0 && right.grain.kind !== "scalar")
        fail(
          "invalid-join",
          `${path}.keys`,
          "Membership joins require keys unless the right relation is scalar.",
        );
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
      if (right.grain.kind === "keyed") {
        const keyedSlots = [
          ...right.grain.keys,
          ...node.keys.flatMap((key) => [key.left, key.right]),
        ];
        if (
          keyedSlots.some((id) => {
            const kind = types.get(id)?.type.kind;
            return kind !== "scalar" && kind !== "bucket";
          })
        )
          fail(
            "invalid-join",
            `${path}.keys`,
            "Joins to keyed relations require scalar or bucket grain and key slots.",
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
            !output.nullable ||
            output.lineage.kind !== "alias" ||
            output.lineage.source !== alias.source
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
    case "ordered-member": {
      const input = assertRelation(node.input, states, `${path}.input`);
      if (node.groups.length === 0)
        fail(
          "invalid-topology",
          `${path}.groups`,
          "Ordered member selection requires at least one group key.",
        );
      if (new Set(node.groups).size !== node.groups.length)
        fail(
          "invalid-topology",
          `${path}.groups`,
          "Ordered member group keys must not repeat.",
        );
      node.groups.forEach((id, index) => {
        const group = resolveVisibleSlot(input, id, `${path}.groups[${index}]`);
        if (group.type.kind !== "scalar")
          fail(
            "invalid-expression",
            `${path}.groups[${index}]`,
            "Ordered member groups require scalar slots.",
          );
      });
      if (node.order.length === 0)
        fail(
          "invalid-topology",
          `${path}.order`,
          "Ordered member selection requires at least one order key.",
        );
      const orderSlots = node.order.map((key) => key.slot);
      if (new Set(orderSlots).size !== orderSlots.length)
        fail(
          "invalid-topology",
          `${path}.order`,
          "Ordered member order keys must not repeat.",
        );
      node.order.forEach((key, index) => {
        const keyPath = `${path}.order[${index}]`;
        const orderSlot = resolveVisibleSlot(
          input,
          key.slot,
          `${keyPath}.slot`,
        );
        if (orderSlot.type.kind !== "scalar")
          fail(
            "invalid-expression",
            `${keyPath}.slot`,
            "Ordered member ordering requires scalar slots.",
          );
        if (key.direction !== "asc" && key.direction !== "desc")
          fail(
            "invalid-topology",
            `${keyPath}.direction`,
            "Ordered member direction is invalid.",
          );
        if (key.nulls !== "first" && key.nulls !== "last")
          fail(
            "invalid-topology",
            `${keyPath}.nulls`,
            "Ordered member null ordering is invalid.",
          );
      });
      expectedOutput = input.node.output;
      expectedGrain = { kind: "keyed", keys: [...node.groups] };
      break;
    }
    case "ranked-members": {
      const input = assertRelation(node.input, states, `${path}.input`);
      if (input.grain.kind !== "keyed" || input.grain.keys.length === 0)
        fail(
          "invalid-grain",
          `${path}.input`,
          "Ranked members require an input with a non-empty keyed grain.",
        );
      if (new Set(node.groups).size !== node.groups.length)
        fail(
          "invalid-topology",
          `${path}.groups`,
          "Ranked member partition keys must not repeat.",
        );
      node.groups.forEach((id, index) => {
        const group = resolveVisibleSlot(input, id, `${path}.groups[${index}]`);
        if (group.type.kind !== "scalar")
          fail(
            "invalid-expression",
            `${path}.groups[${index}]`,
            "Ranked member partition keys must be scalar slots.",
          );
      });
      if (node.order.length === 0)
        fail(
          "invalid-topology",
          `${path}.order`,
          "Ranked members require at least one order key.",
        );
      const orderSlots = node.order.map((key) => key.slot);
      if (new Set(orderSlots).size !== orderSlots.length)
        fail(
          "invalid-topology",
          `${path}.order`,
          "Ranked member order keys must not repeat.",
        );
      node.order.forEach((key, index) => {
        const keyPath = `${path}.order[${index}]`;
        const orderSlot = resolveVisibleSlot(
          input,
          key.slot,
          `${keyPath}.slot`,
        );
        if (orderSlot.type.kind !== "scalar")
          fail(
            "invalid-expression",
            `${keyPath}.slot`,
            "Ranked member order keys must be scalar slots.",
          );
        if (key.direction !== "asc" && key.direction !== "desc")
          fail(
            "invalid-topology",
            `${keyPath}.direction`,
            "Ranked member order direction is invalid.",
          );
        if (key.nulls !== "first" && key.nulls !== "last")
          fail(
            "invalid-topology",
            `${keyPath}.nulls`,
            "Ranked member null ordering is invalid.",
          );
      });
      const rankingKeys = [
        ...new Set([...node.groups, ...node.order.map((key) => key.slot)]),
      ];
      if (
        new Set(input.grain.keys).size !== input.grain.keys.length ||
        input.grain.keys.some((key, index) => {
          const slot = resolveVisibleSlot(
            input,
            key,
            `${path}.input.grain[${index}]`,
          );
          return slot.type.kind !== "scalar" || !rankingKeys.includes(key);
        })
      )
        fail(
          "invalid-grain",
          `${path}.order`,
          "Partition and order keys must cover the complete scalar input grain.",
        );
      const rank = types.get(node.rankSlot);
      const expectedLineageInputs = rankingKeys;
      if (
        input.node.output.includes(node.rankSlot) ||
        !rank ||
        !sameType(rank.type, scalar("number")) ||
        rank.nullable ||
        rank.lineage.kind !== "derived" ||
        rank.lineage.operation !== "ranked-members" ||
        rank.lineage.inputs.length !== expectedLineageInputs.length ||
        rank.lineage.inputs.some(
          (slot, index) => slot !== expectedLineageInputs[index],
        )
      )
        fail(
          "invalid-expression",
          `${path}.rankSlot`,
          "Rank output must be a new non-null unitless numeric derived slot.",
        );
      expectedOutput = [...input.node.output, node.rankSlot];
      expectedGrain = input.grain;
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
    case "analysis-result": {
      if (!node.childPlan || typeof node.childPlan !== "object")
        fail(
          "invalid-topology",
          `${path}.childPlan`,
          "Analysis result child plan is missing.",
        );
      if (
        Array.isArray(node.childPlan.nodes) &&
        node.childPlan.nodes.some((child) => child?.kind === "analysis-result")
      )
        fail(
          "invalid-topology",
          `${path}.childPlan`,
          "Nested analysis-result nodes are not supported.",
        );
      let childPlan: ValidatedLogicalPlan;
      try {
        childPlan = validateLogicalPlan(node.childPlan);
      } catch (error) {
        fail(
          "invalid-topology",
          `${path}.childPlan`,
          error instanceof Error
            ? error.message
            : "Child Logical plan is invalid.",
        );
      }
      if (
        !sameSemanticSubjectDomain(
          plan.context.subject,
          childPlan.context.subject,
        )
      )
        fail(
          "invalid-source",
          `${path}.childPlan.context.subject`,
          "Analysis result child must use the exact same Semantic subject.",
        );
      if (
        !node.outputId ||
        !Array.isArray(node.mappings) ||
        node.mappings.length === 0
      )
        fail(
          "invalid-topology",
          path,
          "Analysis result output and field mappings are required.",
        );
      const childOutput = childPlan.outputs.find(
        (output) => output.id === node.outputId,
      );
      if (!childOutput)
        fail(
          "invalid-output",
          `${path}.outputId`,
          "Analysis result must reference a declared child output.",
        );
      const childOutputNode = childPlan.nodes.find(
        (candidate) => candidate.id === childOutput.relation,
      );
      if (!childOutputNode)
        fail(
          "invalid-output",
          `${path}.outputId`,
          "Child output relation is missing.",
        );
      if (
        childOutputNode.grain.kind !== "scalar" &&
        childOutputNode.grain.kind !== "keyed"
      )
        fail(
          "invalid-grain",
          `${path}.childPlan`,
          "Only scalar or keyed analysis results may be imported.",
        );
      const childSlots = new Map(
        childPlan.slots.map((slot) => [slot.id, slot] as const),
      );
      const childFields = new Map(
        childOutput.fields.map((field) => [field.name, field] as const),
      );
      if (
        childOutput.fields.some(
          (field) => childSlots.get(field.slot)?.type.kind !== "scalar",
        )
      )
        fail(
          "invalid-grain",
          `${path}.childPlan.outputs`,
          "Every imported child output field must be scalar.",
        );
      const mappedFields = new Set<string>();
      const mappedSlots = new Set<SlotId>();
      const mappedSources = new Map<SlotId, SlotId>();
      const mappedOutput: SlotId[] = [];
      node.mappings.forEach((mapping, index) => {
        const mappingPath = `${path}.mappings[${index}]`;
        const sourceField = childFields.get(mapping.field);
        const source = sourceField
          ? childSlots.get(sourceField.slot)
          : undefined;
        const target = types.get(mapping.slot);
        if (
          !mapping.field ||
          !sourceField ||
          !source ||
          source.type.kind !== "scalar"
        )
          fail(
            "invalid-output",
            `${mappingPath}.field`,
            "Mapping must name a scalar field of the declared child output.",
          );
        if (
          mappedFields.has(mapping.field) ||
          mappedSlots.has(mapping.slot) ||
          mappedSources.has(sourceField.slot)
        )
          fail(
            "invalid-output",
            mappingPath,
            "Analysis result field and target mappings must be one-to-one.",
          );
        if (!target)
          fail(
            "invisible-slot",
            `${mappingPath}.slot`,
            "Mapped parent slot is not declared.",
          );
        if (
          !sameType(target.type, source.type) ||
          target.nullable !== source.nullable
        )
          fail(
            "invalid-expression",
            `${mappingPath}.slot`,
            "Imported slot type, unit, and nullability must match the child output.",
          );
        if (
          target.lineage.kind !== "analysis-result" ||
          target.lineage.relation !== node.id ||
          target.lineage.outputId !== node.outputId ||
          target.lineage.field !== mapping.field ||
          target.lineage.sourceSlot !== sourceField.slot
        )
          fail(
            "invalid-output",
            `${mappingPath}.slot`,
            "Imported slot provenance does not match the declared child output.",
          );
        mappedFields.add(mapping.field);
        mappedSlots.add(mapping.slot);
        mappedSources.set(sourceField.slot, mapping.slot);
        mappedOutput.push(mapping.slot);
      });
      if (childOutputNode.grain.kind === "keyed") {
        if (
          new Set(childOutputNode.grain.keys).size !==
          childOutputNode.grain.keys.length
        )
          fail(
            "invalid-grain",
            `${path}.childPlan`,
            "Child keyed grain cannot contain duplicate keys.",
          );
        for (const key of childOutputNode.grain.keys) {
          const field = childOutput.fields.find(
            (candidate) => candidate.slot === key,
          );
          if (!field || !mappedSources.has(key))
            fail(
              "invalid-grain",
              `${path}.mappings`,
              "Every child keyed-grain key must be declared and mapped.",
            );
        }
        expectedGrain = {
          kind: "keyed",
          keys: childOutputNode.grain.keys.map((key) =>
            mappedSources.get(key)!,
          ),
        };
      } else {
        expectedGrain = { kind: "scalar" };
      }
      expectedOutput = mappedOutput;
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
  const active = new WeakSet<object>();
  const visited = new WeakSet<object>();
  const assertAcyclic = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (active.has(value))
      fail(
        "invalid-envelope",
        "plan",
        "Logical plan object graph must be acyclic.",
      );
    if (visited.has(value)) return;
    active.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor))
        fail(
          "invalid-envelope",
          "plan",
          "Logical plan must contain only data properties.",
        );
      assertAcyclic(descriptor.value);
    }
    active.delete(value);
    visited.add(value);
  };
  try {
    assertAcyclic(plan);
  } catch (error) {
    if (error instanceof LogicalPlanError) throw error;
    fail(
      "invalid-envelope",
      "plan",
      "Logical plan object graph is not safely inspectable.",
    );
  }
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
        case "event-payload-occurrences":
          return node.fields.map((binding) => binding.slot);
        case "event-payload-properties":
          return node.properties.flatMap((property) =>
            property.fields.map(({ slot }) => slot),
          );
        case "relationship-lookup":
          return [node.relatedSlot];
        case "project":
          return node.projections.map((binding) => binding.slot);
        case "aggregate":
          return [
            ...node.groups.map((binding) => binding.slot),
            ...node.measures.map((measure) => measure.output),
          ];
        case "sample-statistics":
          return [
            ...node.groups.map((binding) => binding.slot),
            node.samplesOutput,
            node.averageOutput,
            ...node.percentiles.map((item) => item.output),
          ];
        case "distinct":
          return node.keys.map((key) => key.output);
        case "set-operation":
          return node.output;
        case "row-concatenation":
          return node.columns.map((column) => column.output);
        case "join":
          return node.rightAliases.map((alias) => alias.alias);
        case "filter":
        case "semi-join":
        case "anti-join":
        case "ordered-member":
          return [];
        case "ranked-members":
          return [node.rankSlot];
        case "analysis-result":
          return node.mappings.map((mapping) => mapping.slot);
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
