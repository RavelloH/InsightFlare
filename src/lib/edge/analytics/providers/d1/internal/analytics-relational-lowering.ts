import {
  add,
  aggregate,
  and,
  antiJoin,
  avg,
  callFunction,
  caseWhen,
  castInteger,
  castReal,
  castText,
  coalesce,
  concatText,
  constant,
  count,
  countDistinct,
  DatabaseCompilerError,
  distinct,
  div,
  eq,
  filter,
  gt,
  gte,
  inList,
  isNotNull,
  isNull,
  join,
  limit as limitRelation,
  lt,
  lte,
  max,
  min,
  mul,
  neq,
  not,
  or,
  param,
  project,
  rowNumber,
  semiJoin,
  sort as sortRelation,
  sub,
  sum,
  textContains,
  textEndsWith,
  textLike,
  textPosition,
  textStartsWith,
  textSubstring,
  trimSpaces,
  union,
  window as windowRelation,
  windowCountRows,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  Predicate,
  SqlExpression,
} from "@/lib/db/query/expression";
import type { WindowOrderKey } from "@/lib/db/query/plan";
import { buildCalendarBucketPlan } from "@/lib/edge/analytics/contract";
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
  OrderedMemberNode,
  ProjectNode,
  RankedMembersNode,
  RelationshipLookupNode,
  RowConcatenationNode,
  SampleStatisticsNode,
  SemiJoinNode,
  SetOperationNode,
  SortKey,
  SourceNode,
} from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  LogicalOutput,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { assertNever } from "@/lib/edge/analytics/engine/logical/plan";
import type {
  LogicalSlot,
  LogicalValueType,
} from "@/lib/edge/analytics/engine/logical/slots";
import { isSameLogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";
import {
  inferLogicalExpression,
  LogicalPlanError,
} from "@/lib/edge/analytics/engine/logical/validator";
import { semanticAttribute } from "@/lib/edge/analytics/engine/semantic/attributes";
import type { AnalyticsEntityKind } from "@/lib/edge/analytics/engine/semantic/entities";
import { semanticPageDimension } from "@/lib/edge/analytics/engine/semantic/page-dimensions";
import type { SemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

import {
  browserEngineExpression,
  osVersionExpression,
  trafficChannelExpression,
} from "./analytics-legacy-scalar-filter-lowering";
import { AnalyticsLegacyScopedStorage } from "./analytics-legacy-scoped-storage";
import {
  type AnalyticsDbRelation,
  AnalyticsRelationalStorage,
  type AnalyticsRelationalStorageContext,
  type LoweredAnalyticsSource,
  normalizeAnalyticsRelationalSiteIds,
} from "./analytics-relational-storage";
import { DIRECT_REFERRER_FILTER_VALUE } from "./core-types";

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
  if (values.length === 0) {
    const relation: AnalyticsDbRelation = project(input, {
      __analytics_row: param(1),
    });
    return {
      relation,
      slots: layouts,
      candidateActivitySessionRestricted: false,
    };
  }
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

function scalarAggregateValue(
  value: LoweredValue,
  path: string,
): Extract<LoweredValue, { readonly kind: "scalar" }> & {
  readonly type: Extract<
    LogicalValueType,
    { readonly kind: "scalar" | "bucket" }
  >;
} {
  if (
    value.kind !== "scalar" ||
    (value.type.kind !== "scalar" && value.type.kind !== "bucket")
  )
    reject(path, "Scalar aggregation requires a scalar Logical value.");
  return { ...value, type: value.type };
}

function numericAggregateExpression(
  value: LoweredValue,
  path: string,
): SqlExpression<number | null> {
  const scalar = scalarAggregateValue(value, path);
  if (scalar.type.kind !== "scalar" || scalar.type.scalar !== "number")
    reject(path, "SUM and AVG require numeric scalar values.");
  return scalar.expression as SqlExpression<number | null>;
}

function comparableAggregateValue(
  value: LoweredValue,
  path: string,
): Extract<LoweredValue, { readonly kind: "scalar" }> & {
  readonly type: Extract<LogicalValueType, { readonly kind: "scalar" }>;
} {
  const scalar = scalarAggregateValue(value, path);
  if (scalar.type.kind !== "scalar")
    reject(path, "MIN and MAX require a comparable scalar value.");
  if (
    !["string", "number", "boolean", "date", "datetime"].includes(
      scalar.type.scalar,
    )
  )
    reject(path, "MIN and MAX require a comparable scalar value.");
  return {
    ...scalar,
    type: scalar.type as Extract<LogicalValueType, { readonly kind: "scalar" }>,
  };
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

function trimAsciiSpaces(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function normalizeStringComparisonValue(
  expression: AnyExpression,
  logicalType: LogicalValueType,
  literal: LogicalExpr | undefined,
  normalization: "trim-ascii-space" | "ascii-case-fold",
  path: string,
): AnyExpression {
  if (logicalType.kind !== "scalar" || logicalType.scalar !== "string")
    reject(path, "String normalization is supported only for string values.");
  if (literal?.kind === "literal" && typeof literal.value === "string") {
    return param(
      normalization === "trim-ascii-space"
        ? trimAsciiSpaces(literal.value)
        : foldAsciiCase(literal.value),
    );
  }
  const text = expression as SqlExpression<string | null>;
  return normalization === "trim-ascii-space"
    ? trimSpaces(text)
    : callFunction("lower", text);
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
  time: SemanticTemporalDomains,
): LoweredValue {
  switch (expression.kind) {
    case "slot": {
      return readValue(relation, visible, expression.slot, `${path}.slot`);
    }
    case "literal":
      return {
        kind: "scalar",
        expression:
          expression.value === null
            ? constant(null)
            : expression.value === ""
              ? constant("")
              : param(expression.value),
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
        time,
      );
      const right = lowerExpression(
        expression.right,
        relation,
        logicalSlots,
        visible,
        `${path}.right`,
        time,
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
      if (
        (expression.stringNormalization === "trim-ascii-space" ||
          expression.stringNormalization === "ascii-case-fold") &&
        expression.operator !== "eq" &&
        expression.operator !== "neq"
      )
        reject(
          path,
          "ASCII normalization is supported only for equality comparisons.",
        );
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
      } else if (
        expression.stringNormalization === "trim-ascii-space" ||
        expression.stringNormalization === "ascii-case-fold"
      ) {
        leftExpression = normalizeStringComparisonValue(
          leftExpression,
          leftType,
          expression.left,
          expression.stringNormalization,
          `${path}.left`,
        );
        rightExpression = normalizeStringComparisonValue(
          rightExpression,
          rightType,
          expression.right,
          expression.stringNormalization,
          `${path}.right`,
        );
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
          time,
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
        time,
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
        time,
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
        time,
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
          time,
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
    case "case": {
      const branchNullabilities: boolean[] = [];
      const branches = expression.branches.map((branch, index) => {
        const when = lowerExpression(
          branch.when,
          relation,
          logicalSlots,
          visible,
          `${path}.branches[${index}].when`,
          time,
        );
        const then = lowerExpression(
          branch.then,
          relation,
          logicalSlots,
          visible,
          `${path}.branches[${index}].then`,
          time,
        );
        if (
          when.kind !== "scalar" ||
          when.type.kind !== "scalar" ||
          when.type.scalar !== "boolean"
        )
          reject(
            `${path}.branches[${index}].when`,
            "CASE conditions must lower to boolean scalar values.",
          );
        if (then.kind !== "scalar")
          reject(
            `${path}.branches[${index}].then`,
            "CASE branches cannot return entity values.",
          );
        branchNullabilities.push(then.nullable);
        return {
          when: asPredicate(when.expression, `${path}.branches[${index}].when`),
          then: then.expression,
        };
      });
      const otherwise = lowerExpression(
        expression.otherwise,
        relation,
        logicalSlots,
        visible,
        `${path}.otherwise`,
        time,
      );
      if (otherwise.kind !== "scalar")
        reject(path, "CASE fallback cannot return an entity value.");
      return {
        kind: "scalar",
        expression: caseWhen(
          branches as [
            { when: Predicate; then: AnyExpression },
            ...{ when: Predicate; then: AnyExpression }[],
          ],
          otherwise.expression,
        ),
        type: otherwise.type,
        nullable: otherwise.nullable || branchNullabilities.some(Boolean),
        candidateBounded: false,
      };
    }
    case "string-match": {
      const input = lowerExpression(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
      );
      if (
        input.kind !== "scalar" ||
        input.type.kind !== "scalar" ||
        input.type.scalar !== "string"
      )
        reject(path, "String matching requires a string scalar expression.");
      if (expression.semantics === "legacy-record-search-v1") {
        if (
          expression.operator !== "contains" ||
          expression.caseSensitive ||
          expression.stringNormalization !== undefined
        )
          reject(path, "The legacy record-search expression is malformed.");
        const nullableText = input.expression as SqlExpression<
          string | null,
          ExpressionResultType<"text", boolean>
        >;
        const normalized = callFunction(
          "lower",
          trimSpaces(coalesce(nullableText, param(""))),
        );
        const escaped = expression.value
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_");
        return {
          kind: "scalar",
          expression: textLike(normalized, param(`%${escaped}%`), "\\"),
          type: { kind: "scalar", scalar: "boolean" },
          nullable: false,
          candidateBounded: false,
        };
      }
      if (expression.semantics === "legacy-report-search-v1") {
        if (
          expression.operator !== "contains" ||
          expression.caseSensitive ||
          expression.stringNormalization !== undefined ||
          expression.value !== expression.value.trim().toLowerCase()
        )
          reject(path, "The legacy report-search expression is malformed.");
        const nullableText = input.expression as SqlExpression<
          string | null,
          ExpressionResultType<"text", boolean>
        >;
        const normalized = callFunction(
          "lower",
          coalesce(nullableText, param("")),
        );
        const escaped = expression.value
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_");
        return {
          kind: "scalar",
          expression: textLike(normalized, param(`%${escaped}%`), "\\"),
          type: { kind: "scalar", scalar: "boolean" },
          nullable: false,
          candidateBounded: false,
        };
      }
      if (!expression.caseSensitive)
        reject(
          path,
          "Case-insensitive matching is not supported by this adapter.",
        );

      let value = expression.value;
      let stringInput = input.expression as SqlExpression<string | null>;
      if (expression.stringNormalization === "trim") {
        stringInput = applyTrim(
          stringInput,
          input.type,
          `${path}.input`,
        ) as SqlExpression<string | null>;
        value = value.trim();
      } else if (expression.stringNormalization !== undefined) {
        reject(path, "This adapter does not support case-fold normalization.");
      }

      let predicate: AnyExpression;
      try {
        predicate =
          expression.operator === "starts-with"
            ? textStartsWith(stringInput, value)
            : expression.operator === "ends-with"
              ? textEndsWith(stringInput, value)
              : textContains(stringInput, value);
      } catch (error) {
        if (
          error instanceof DatabaseCompilerError &&
          error.code === "invalid_plan" &&
          error.message.includes("unpaired UTF-16 surrogate")
        )
          reject(`${path}.value`, error.message);
        throw error;
      }
      return {
        kind: "scalar",
        expression: predicate,
        type: { kind: "scalar", scalar: "boolean" },
        nullable: input.nullable,
        candidateBounded: false,
      };
    }
    case "string-normalize": {
      const input = lowerExpression(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
      );
      if (
        input.kind !== "scalar" ||
        input.type.kind !== "scalar" ||
        input.type.scalar !== "string"
      )
        reject(path, "String normalization requires a string scalar value.");
      if (expression.normalization !== "trim-ascii-space")
        reject(path, "The string normalization mode is unsupported.");
      return {
        kind: "scalar",
        expression: trimSpaces(
          input.expression as SqlExpression<string | null>,
        ),
        type: { kind: "scalar", scalar: "string" },
        nullable: input.nullable,
        candidateBounded: input.candidateBounded,
      };
    }
    case "page-dimension": {
      const definition = semanticPageDimension(expression.dimension);
      const names = expression.dependencies.map(
        (dependency) => dependency.attribute,
      );
      if (
        !definition ||
        names.length !== definition.dependencies.length ||
        new Set(names).size !== names.length ||
        definition.dependencies.some((attribute) => !names.includes(attribute))
      )
        reject(
          path,
          "Page dimension dependencies do not match its definition.",
        );

      const dependencies = new Map<string, SqlExpression>();
      const nullableDependencies = new Map<string, boolean>();
      for (const dependency of expression.dependencies) {
        const attribute = semanticAttribute(dependency.attribute);
        const value = lowerExpression(
          dependency.expression,
          relation,
          logicalSlots,
          visible,
          `${path}.dependencies.${dependency.attribute}`,
          time,
        );
        if (
          !attribute ||
          attribute.valueType.kind !== "scalar" ||
          value.kind !== "scalar" ||
          value.type.kind !== "scalar" ||
          !isSameLogicalValueType(value.type, attribute.valueType)
        )
          reject(
            `${path}.dependencies.${dependency.attribute}`,
            "Page dimension dependency has an incompatible scalar type.",
          );
        const expectedAffinity = attribute.valueType.scalar;
        const actualAffinity = value.expression.resultType.affinity;
        if (
          (expectedAffinity === "string" && actualAffinity !== "text") ||
          (expectedAffinity === "number" &&
            !["integer", "real", "numeric"].includes(actualAffinity))
        )
          reject(
            `${path}.dependencies.${dependency.attribute}`,
            "Page dimension dependency has an incompatible SQL affinity.",
          );
        dependencies.set(
          dependency.attribute,
          value.expression as SqlExpression,
        );
        nullableDependencies.set(dependency.attribute, value.nullable);
      }
      const get = (attribute: string): SqlExpression => {
        const value = dependencies.get(attribute);
        if (!value)
          reject(path, `Missing page dimension dependency ${attribute}.`);
        return value;
      };
      const text = (attribute: string) =>
        get(attribute) as SqlExpression<string | null>;
      let result: AnyExpression;
      switch (expression.dimension) {
        case "countryCode":
          result = callFunction(
            "upper",
            trimSpaces(coalesce(text("page.report.country"), constant(""))),
          );
          break;
        case "trafficChannel":
          result = trafficChannelExpression({
            referrer_host: get("page.report.referrerHost"),
            utm_source: get("page.report.utmSource"),
            utm_medium: get("page.report.utmMedium"),
            utm_campaign: get("page.report.utmCampaign"),
          });
          break;
        case "browserEngine":
          result = browserEngineExpression(
            get("page.report.browser"),
            get("page.report.os"),
          );
          break;
        case "osVersion":
          result = osVersionExpression(
            get("page.report.os"),
            get("page.report.osVersion"),
          );
          break;
        case "overviewOsVersion": {
          const os = trimSpaces(coalesce(text("page.report.os"), constant("")));
          const version = trimSpaces(
            coalesce(text("page.report.osVersion"), constant("")),
          );
          result = caseWhen(
            [
              {
                when: and(neq(os, constant("")), neq(version, constant(""))),
                then: concatText(os, constant(" "), version),
              },
              { when: neq(os, constant("")), then: os },
              { when: neq(version, constant("")), then: version },
            ],
            constant(""),
          );
          break;
        }
        case "browserMajorVersion": {
          const version = text("page.report.browserVersion") as SqlExpression<
            string | null,
            ExpressionResultType<"text", boolean>
          >;
          const position = textPosition(version, constant("."));
          result = trimSpaces(
            caseWhen(
              [
                { when: eq(version, constant("")), then: constant("") },
                {
                  when: gt(position, constant(0)),
                  then: textSubstring(
                    version,
                    constant(1),
                    sub(position, constant(1)),
                  ),
                },
              ],
              version,
            ),
          );
          break;
        }
        case "screenSize": {
          const width = get("page.report.screenWidth") as SqlExpression<
            number | null,
            ExpressionResultType<"integer" | "real" | "numeric", boolean>
          >;
          const height = get("page.report.screenHeight") as SqlExpression<
            number | null,
            ExpressionResultType<"integer" | "real" | "numeric", boolean>
          >;
          result = caseWhen(
            [
              {
                when: and(gt(width, constant(0)), gt(height, constant(0))),
                then: coalesce(
                  concatText(castText(width), constant("x"), castText(height)),
                  constant(""),
                ),
              },
            ],
            constant(""),
          );
          break;
        }
        case "referrerDomain": {
          const host = trimSpaces(
            coalesce(text("page.report.referrerHost"), constant("")),
          );
          result = caseWhen(
            [{ when: neq(host, constant("")), then: host }],
            constant(DIRECT_REFERRER_FILTER_VALUE),
          );
          break;
        }
        case "geoRegion":
        case "geoCity": {
          const country = trimSpaces(text("page.report.country"));
          const regionCode = trimSpaces(text("page.report.regionCode"));
          const region = trimSpaces(text("page.report.region"));
          const selectedRegion = caseWhen(
            [{ when: neq(regionCode, constant("")), then: regionCode }],
            region,
          );
          const allEmpty = [
            eq(country, constant("")),
            eq(regionCode, constant("")),
            eq(region, constant("")),
          ];
          if (expression.dimension === "geoCity") {
            const city = trimSpaces(text("page.report.city"));
            allEmpty.push(eq(city, constant("")));
          }
          const separator = constant("::");
          const combined =
            expression.dimension === "geoCity"
              ? concatText(
                  country,
                  separator,
                  selectedRegion,
                  separator,
                  region,
                  separator,
                  trimSpaces(text("page.report.city")),
                )
              : concatText(
                  country,
                  separator,
                  selectedRegion,
                  separator,
                  region,
                );
          result = caseWhen(
            [
              {
                when: and(...(allEmpty as [Predicate, ...Predicate[]])),
                then: constant(""),
              },
            ],
            combined,
          );
          break;
        }
        default:
          return reject(path, "The page dimension is unsupported.");
      }
      if (result.resultType.affinity !== "text")
        reject(path, "Page dimension expression must have text affinity.");
      return {
        kind: "scalar",
        expression: result,
        type: { kind: "scalar", scalar: "string" },
        nullable:
          definition.nullableFromDependencies &&
          [...nullableDependencies.values()].some(Boolean),
        candidateBounded: false,
      };
    }
    case "absolute": {
      const input = lowerExpression(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
      );
      if (
        input.kind !== "scalar" ||
        input.type.kind !== "scalar" ||
        input.type.scalar !== "number"
      )
        reject(path, "ABS requires a numeric scalar expression.");
      return {
        kind: "scalar",
        expression: callFunction(
          "abs",
          input.expression as SqlExpression<number | null>,
        ),
        type: input.type,
        nullable: input.nullable,
        candidateBounded: input.candidateBounded,
      };
    }
    case "arithmetic": {
      if (
        !["add", "subtract", "multiply", "divide"].includes(expression.operator)
      )
        reject(path, "The arithmetic operator is unsupported.");
      if (
        expression.operator === "divide" &&
        expression.zeroDenominator !== "null"
      )
        reject(path, "Division must map a zero denominator to NULL.");
      let inferred;
      try {
        inferred = inferLogicalExpression(
          expression,
          (id, slotPath) => {
            if (!visible.has(id))
              reject(slotPath, "Arithmetic references a hidden Logical slot.");
            return logicalSlot(logicalSlots, id, slotPath);
          },
          path,
        );
      } catch (error) {
        if (error instanceof AnalyticsRelationalLoweringError) throw error;
        if (error instanceof LogicalPlanError)
          reject(path, "Arithmetic operand type or unit is unsupported.");
        throw error;
      }
      const left = lowerExpression(
        expression.left,
        relation,
        logicalSlots,
        visible,
        `${path}.left`,
        time,
      );
      const right = lowerExpression(
        expression.right,
        relation,
        logicalSlots,
        visible,
        `${path}.right`,
        time,
      );
      if (
        left.kind !== "scalar" ||
        right.kind !== "scalar" ||
        left.type.kind !== "scalar" ||
        right.type.kind !== "scalar" ||
        left.type.scalar !== "number" ||
        right.type.scalar !== "number"
      )
        reject(path, "Arithmetic requires numeric scalar expressions.");
      const leftExpression = scalarValue(left, `${path}.left`);
      const rightExpression = scalarValue(right, `${path}.right`);
      if (
        !["integer", "real", "numeric", "unknown"].includes(
          leftExpression.resultType.affinity,
        ) ||
        !["integer", "real", "numeric", "unknown"].includes(
          rightExpression.resultType.affinity,
        )
      )
        reject(path, "Arithmetic requires numeric SQL affinities.");
      const numericLeft = leftExpression as SqlExpression<number | null>;
      const numericRight = rightExpression as SqlExpression<number | null>;
      const result =
        expression.operator === "add"
          ? add(numericLeft, numericRight)
          : expression.operator === "subtract"
            ? sub(numericLeft, numericRight)
            : expression.operator === "multiply"
              ? mul(numericLeft, numericRight)
              : div(castReal(numericLeft), numericRight);
      return {
        kind: "scalar",
        expression: result,
        type: inferred.type,
        nullable: inferred.nullable,
        candidateBounded: false,
      };
    }
    case "time-bucket": {
      const input = lowerExpression(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
      );
      if (
        input.kind !== "scalar" ||
        input.type.kind !== "scalar" ||
        !["date", "datetime", "number"].includes(input.type.scalar)
      )
        reject(path, "Time bucketing requires a temporal or epoch scalar.");
      if (expression.reportingTimeZone !== time.reportingTimeZone)
        reject(path, "Time buckets must use the Semantic reporting time zone.");
      const calendar = buildCalendarBucketPlan({
        range: time.candidate,
        granularity: expression.granularity,
        reportingTimeZone: expression.reportingTimeZone,
        maxBuckets: 2000,
      });
      if (calendar.buckets.length === 0)
        reject(path, "The candidate range has no calendar buckets.");
      const value = input.expression as SqlExpression<
        number | null,
        ExpressionResultType<"integer" | "real" | "numeric", boolean>
      >;
      const first = calendar.buckets[0]!;
      const last = calendar.buckets.at(-1)!;
      // Calendar buckets are adjacent and ordered. Bound the whole CASE once,
      // then test each exclusive end; repeating both bounds in every branch
      // makes long, otherwise-valid windows exceed D1's SQL size budget.
      const branches: Array<{ when: Predicate; then: AnyExpression }> = [
        {
          when: lt(value, constant(Number(first.startMs))),
          then: constant(null),
        },
        {
          when: gte(value, constant(Number(last.endExclusiveMs))),
          then: constant(null),
        },
        ...calendar.buckets.map((bucket) => ({
          when: lt(value, constant(Number(bucket.endExclusiveMs))),
          then: constant(bucket.index),
        })),
      ];
      return {
        kind: "scalar",
        expression: caseWhen(
          branches as [
            { when: Predicate; then: AnyExpression },
            ...{ when: Predicate; then: AnyExpression }[],
          ],
          constant(null),
        ),
        type: {
          kind: "bucket",
          granularity: expression.granularity,
          reportingTimeZone: expression.reportingTimeZone,
        },
        nullable: true,
        candidateBounded: input.candidateBounded,
      };
    }
    case "bucket-index": {
      const input = lowerExpression(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
      );
      if (input.kind !== "scalar" || input.type.kind !== "bucket")
        reject(path, "Bucket-index requires a lowered calendar bucket.");
      return {
        kind: "scalar",
        expression: input.expression,
        type: { kind: "scalar", scalar: "number" },
        nullable: true,
        candidateBounded: input.candidateBounded,
      };
    }
    case "round": {
      const input = lowerExpression(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
      );
      if (
        input.kind !== "scalar" ||
        input.type.kind !== "scalar" ||
        input.type.scalar !== "number"
      )
        reject(path, "ROUND requires a lowered numeric scalar.");
      const decimalPlaces = expression.decimalPlaces;
      if (
        decimalPlaces !== undefined &&
        (!Number.isInteger(decimalPlaces) ||
          decimalPlaces < 0 ||
          decimalPlaces > 15)
      )
        reject(
          path,
          "ROUND precision must be a static integer from 0 through 15.",
        );
      // The validated logical scalar type is the source of truth here; the
      // generic SQL expression node has intentionally erased its value type.
      const numericExpression = input.expression as SqlExpression<
        number | null
      >;
      return {
        kind: "scalar",
        expression:
          decimalPlaces === undefined
            ? callFunction("round", numericExpression)
            : callFunction("round", numericExpression, constant(decimalPlaces)),
        type: input.type,
        nullable: input.nullable,
        candidateBounded: input.candidateBounded,
      };
    }
    case "elapsed-duration-literal":
    case "calendar-period-literal":
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

function assertNonNullableUnaryEntitySet(
  inputNode: LogicalNode,
  entry: LoweredRelation,
  logicalSlots: ReadonlyMap<SlotId, LogicalSlot>,
  path: string,
): AnalyticsEntityKind {
  if (inputNode.output.length !== 1)
    reject(path, "Only unary scoped identity sets are currently supported.");
  const slot = inputNode.output[0]!;
  const value = entry.slots.get(slot);
  const declared = logicalSlot(logicalSlots, slot, path);
  if (
    inputNode.grain.kind !== "entity" ||
    inputNode.grain.key !== slot ||
    !value ||
    value.kind !== "entity" ||
    !["observation", "session", "visitor"].includes(value.type.entity) ||
    inputNode.grain.entity !== value.type.entity ||
    declared.type.kind !== "entity" ||
    declared.type.entity !== value.type.entity ||
    declared.nullable ||
    value.nullable
  )
    reject(
      path,
      value?.kind === "entity" && value.type.entity === "session"
        ? "Set operations require a non-null composite Session key."
        : "Set operations require one non-null scoped entity identity.",
    );
  const expectedKeyWidth = value.type.entity === "observation" ? 3 : 2;
  if (value.keyColumns.length !== expectedKeyWidth)
    reject(path, "Set operation entity key has an invalid composite width.");
  return value.type.entity;
}

function logicalNodeInputs(node: LogicalNode): readonly RelationId[] {
  switch (node.kind) {
    case "source":
      return [];
    case "relationship-lookup":
    case "filter":
    case "project":
    case "aggregate":
    case "sample-statistics":
    case "distinct":
    case "ordered-member":
    case "ranked-members":
    case "sort":
    case "limit":
      return [node.input];
    case "set-operation":
      return node.inputs;
    case "row-concatenation":
      return node.inputs;
    case "semi-join":
    case "anti-join":
    case "join":
      return [node.left, node.right];
  }
  return assertNever(node);
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
  readonly #sourceSelectionIds = new WeakMap<object, number>();
  #nextSourceSelectionId = 1;
  readonly #requiredSlots = new Map<RelationId, Set<SlotId>>();
  readonly #storage: AnalyticsRelationalStorage;
  readonly #scopedStorage: AnalyticsLegacyScopedStorage;

  constructor(
    plan: ValidatedLogicalPlan,
    storageContext: AnalyticsRelationalStorageContext,
  ) {
    this.#plan = plan;
    let subjectSiteIds: readonly string[];
    let storageSiteIds: readonly string[];
    try {
      subjectSiteIds = normalizeAnalyticsRelationalSiteIds({
        siteIds: plan.context.subject.siteIds,
        time: plan.context.time,
      });
      storageSiteIds = normalizeAnalyticsRelationalSiteIds(storageContext);
    } catch (error) {
      reject(
        "context.subject",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (
      subjectSiteIds.length !== storageSiteIds.length ||
      subjectSiteIds.some((siteId, index) => siteId !== storageSiteIds[index])
    )
      reject(
        "context.subject",
        "Storage site IDs must exactly match the authorized Semantic subject.",
      );
    this.#nodes = new Map(plan.nodes.map((node) => [node.id, node] as const));
    this.#logicalSlots = new Map(
      plan.slots.map((slot) => [slot.id, slot] as const),
    );
    this.#storage = new AnalyticsRelationalStorage(storageContext);
    this.#scopedStorage = new AnalyticsLegacyScopedStorage(storageContext);
  }

  #sourceSelectionId(selection: object | undefined): number | null {
    if (!selection) return null;
    const existing = this.#sourceSelectionIds.get(selection);
    if (existing !== undefined) return existing;
    const next = this.#nextSourceSelectionId++;
    this.#sourceSelectionIds.set(selection, next);
    return next;
  }

  lower(output: LogicalOutput): LoweredAnalyticsLogicalOutput {
    return this.lowerMany([output])[0]!;
  }

  /** Lowers related outputs with one required-slot analysis and shared memo. */
  lowerMany(
    outputs: readonly LogicalOutput[],
  ): readonly LoweredAnalyticsLogicalOutput[] {
    if (outputs.length === 0)
      reject("outputs", "At least one Logical output is required.");
    const selectedNodes = this.#reachableNodeIds(
      outputs.map((output) => output.relation),
    );
    const declaredOutputNodes = this.#reachableNodeIds(
      this.#plan.outputs.map((candidate) => candidate.relation),
    );
    const orphan = this.#plan.nodes.find(
      (node) => !declaredOutputNodes.has(node.id),
    );
    if (orphan)
      reject(
        nodePath(orphan.id),
        "Every relational and Boolean node must be reachable from a declared output.",
      );

    // A multi-output caller needs the union of required slots on shared nodes.
    // Lower all roots after that union is known so they share one source graph.
    this.#memo.clear();
    this.#prepareRequiredSlots(outputs, selectedNodes);
    const roots = outputs.map((output) => this.#lowerNode(output.relation));
    if (this.#memo.size !== selectedNodes.size) {
      const unreachable = this.#plan.nodes.find(
        (node) => selectedNodes.has(node.id) && !this.#memo.has(node.id),
      );
      reject(
        unreachable ? nodePath(unreachable.id) : "nodes",
        "Every relation in the selected output dependency graph must be lowered.",
      );
    }
    return outputs.map((output, index) => {
      const root = roots[index]!;
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
    });
  }

  #reachableNodeIds(roots: readonly RelationId[]): Set<RelationId> {
    const reachable = new Set<RelationId>();
    const pending = [...roots];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (reachable.has(id)) continue;
      const node = this.#nodes.get(id);
      if (!node)
        reject(nodePath(id), "The relation references a missing node.");
      reachable.add(id);
      pending.push(...logicalNodeInputs(node));
    }
    return reachable;
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
              this.#plan.context.time,
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
      case "ordered-member":
        result = this.#lowerOrderedMember(node, path);
        break;
      case "ranked-members":
        result = this.#lowerRankedMembers(node, path);
        break;
      case "distinct":
        result = this.#lowerDistinct(node, path);
        break;
      case "set-operation":
        result = this.#lowerSetOperation(node, path);
        break;
      case "row-concatenation":
        result = this.#lowerRowConcatenation(node, path);
        break;
      case "semi-join":
      case "anti-join":
        result = this.#lowerMembershipJoin(node, path);
        break;
      case "aggregate":
        result = this.#lowerAggregate(node, path);
        break;
      case "sample-statistics":
        result = this.#lowerSampleStatistics(node, path);
        break;
      case "join":
        result = this.#lowerJoin(node, path);
        break;
      case "sort": {
        const input = this.#lowerNode(node.input);
        const keys: {
          readonly expression: SqlExpression;
          readonly direction: "ASC" | "DESC";
        }[] = [];
        node.keys.forEach((key, index) => {
          const keyPath = `${path}.keys[${index}]`;
          const logical = logicalSlot(
            this.#logicalSlots,
            key.slot,
            `${keyPath}.slot`,
          );
          if (logical.type.kind !== "scalar" && logical.type.kind !== "bucket")
            reject(keyPath, "Sort keys must be scalar or bucket values.");
          const value = readValue(
            input.relation,
            input.slots,
            key.slot,
            `${keyPath}.slot`,
          );
          if (value.kind !== "scalar")
            reject(keyPath, "Sort keys must be scalar values.");
          const direction = key.direction === "asc" ? "ASC" : "DESC";
          const nativeNulls = key.direction === "asc" ? "first" : "last";
          if (key.nulls !== nativeNulls) {
            keys.push({
              expression: isNull(value.expression),
              direction: key.nulls === "first" ? "DESC" : "ASC",
            });
          }
          keys.push({ expression: value.expression, direction });
        });
        result = {
          ...input,
          relation: sortRelation(input.relation, keys),
        };
        break;
      }
      case "limit": {
        const input = this.#lowerNode(node.input);
        result = {
          ...input,
          relation: limitRelation(input.relation, node.count),
        };
        break;
      }
    }
    this.#memo.set(id, result);
    return result;
  }

  #lowerSource(node: SourceNode, path: string): LoweredRelation {
    let lowered: LoweredAnalyticsSource;
    try {
      const source = this.#storage.lowerSource(
        node,
        path,
        this.#requiredOutput(node),
      );
      lowered = this.#scopedStorage.lowerSelectedReportSource(
        node,
        path,
        source,
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
            logical.lineage.attribute === binding.attribute) ||
          (binding.kind === "occurrence-time" &&
            logical.lineage.kind === "derived" &&
            logical.lineage.operation === "occurrence-time");
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
      this.#sourceSelectionId(node.selection),
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
          node.selection === undefined &&
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
        node.selection === undefined &&
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
          this.#plan.context.time,
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
    const inputEntities: AnalyticsEntityKind[] = [];
    for (const [index, input] of inputs.entries()) {
      const inputNode = this.#nodes.get(node.inputs[index]!);
      if (!inputNode) reject(path, `Set input ${index} does not exist.`);
      inputEntities.push(
        assertNonNullableUnaryEntitySet(
          inputNode,
          input,
          this.#logicalSlots,
          `${path}.inputs[${index}]`,
        ),
      );
    }
    if (node.output.length !== 1)
      reject(path, "Only unary scoped identity sets are currently supported.");
    const outputSlot = node.output[0]!;
    const outputType = logicalSlot(
      this.#logicalSlots,
      outputSlot,
      `${path}.output[0]`,
    );
    const entity = inputEntities[0]!;
    if (
      inputEntities.some((inputEntity) => inputEntity !== entity) ||
      node.grain.kind !== "entity" ||
      node.grain.key !== outputSlot ||
      node.grain.entity !== entity ||
      outputType.type.kind !== "entity" ||
      outputType.type.entity !== entity ||
      outputType.nullable
    )
      reject(
        path,
        "Set inputs and output must preserve one non-null scoped entity identity.",
      );

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

  #lowerRowConcatenation(
    node: RowConcatenationNode,
    path: string,
  ): LoweredRelation {
    const inputs = node.inputs.map((id) => this.#lowerNode(id));
    const required = this.#requiredOutput(node);
    const aligned = inputs.map((input, inputIndex) => {
      const values = node.columns
        .filter((column) => required.has(column.output))
        .map((column) => {
          const sourceSlot = column.inputs[inputIndex];
          if (sourceSlot === undefined)
            reject(
              path,
              `Input ${inputIndex} has no mapping for ${column.name}.`,
            );
          const value = readValue(
            input.relation,
            input.slots,
            sourceSlot,
            `${path}.inputs[${inputIndex}].${column.name}`,
          );
          if (value.kind !== "scalar")
            reject(
              `${path}.inputs[${inputIndex}].${column.name}`,
              "Row concatenation accepts only scalar or bucket values.",
            );
          const outputMeta = logicalSlot(
            this.#logicalSlots,
            column.output,
            `${path}.${column.name}`,
          );
          return {
            slot: column.output,
            value: {
              ...value,
              type: outputMeta.type,
              candidateBounded: false,
            },
          };
        });
      return projectedValues(
        input.relation,
        values,
        this.#logicalSlots,
        `${path}.inputs[${inputIndex}]`,
      );
    });
    let relation = aligned[0]!.relation;
    for (const next of aligned.slice(1))
      relation = union(relation, next.relation, true);
    const slots = new Map<SlotId, SlotLayout>();
    for (const column of node.columns) {
      if (!required.has(column.output)) continue;
      const initial = aligned[0]!.slots.get(column.output);
      if (!initial || initial.kind !== "scalar")
        reject(path, `Output mapping for ${column.name} is missing.`);
      slots.set(column.output, { ...initial, candidateBounded: false });
    }
    return {
      relation,
      slots,
      candidateActivitySessionRestricted: false,
    };
  }

  #lowerRelationshipLookup(
    node: RelationshipLookupNode,
    path: string,
  ): LoweredRelation {
    if (
      node.relationship !== "observation.session" &&
      node.relationship !== "observation.visitor"
    )
      reject(
        path,
        `Relationship ${node.relationship} has no D1 lookup mapping.`,
      );
    const target =
      node.relationship === "observation.session"
        ? { entity: "session" as const, idColumn: "session_id" as const }
        : { entity: "visitor" as const, idColumn: "visitor_id" as const };
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
        `Observation ${target.entity} lookup requires a non-null composite Observation key.`,
      );
    if (!this.#hasStorageBackedObservationIdentity(node.input, node.inputKey))
      reject(
        path,
        `Observation ${target.entity} lookup requires an identity preserved from a registered Page/Event Source.`,
      );
    if (key.keys.length !== 3)
      reject(
        path,
        `Observation ${target.entity} lookup requires site, activity kind, and local identity keys.`,
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
      [target.idColumn]: pageTable.columns[target.idColumn],
    });
    const pageJoined = join(
      pageInput,
      pages,
      and(
        eq(pageKey.keys[0]!, pages.columns.site_pk),
        eq(pageKey.keys[2]!, pages.columns.visit_id),
      ),
    );
    const pageTargetId = relationColumn(
      pageJoined,
      `right_${target.idColumn}`,
      path,
    );
    const pageTargetText = pageTargetId as SqlExpression<
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
        entity: target.entity,
        keys: [relationColumn(pageJoined, "right_site_pk", path), pageTargetId],
        present: asPredicate(
          and(isNotNull(pageTargetText), neq(pageTargetText, param(""))),
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
      [target.idColumn]: ownerTable.columns[target.idColumn],
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
    const ownerTargetId = relationColumn(
      eventWithOwner,
      `right_${target.idColumn}`,
      path,
    );
    const ownerTargetText = ownerTargetId as SqlExpression<
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
        entity: target.entity,
        keys: [
          relationColumn(eventWithOwner, "right_site_pk", path),
          ownerTargetId,
        ],
        present: asPredicate(
          and(isNotNull(ownerTargetText), neq(ownerTargetText, param(""))),
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
            binding.relationship === "event.observation") ||
          (binding?.kind === "related-entity" &&
            node.entity === "page" &&
            binding.relationship === "page.observation")
        );
      }
      case "filter":
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
      case "ordered-member":
        return this.#hasStorageBackedObservationIdentity(
          node.input,
          slot,
          nextActive,
        );
      case "ranked-members":
        return (
          slot !== node.rankSlot &&
          this.#hasStorageBackedObservationIdentity(
            node.input,
            slot,
            nextActive,
          )
        );
      case "semi-join":
      case "anti-join":
        return this.#hasStorageBackedObservationIdentity(
          node.left,
          slot,
          nextActive,
        );
      case "set-operation": {
        if (
          node.output.length !== 1 ||
          node.output[0] !== slot ||
          node.grain.kind !== "entity" ||
          node.grain.key !== slot ||
          node.grain.entity !== "observation"
        )
          return false;
        return node.inputs.every((inputId) => {
          const inputNode = this.#nodes.get(inputId);
          const inputSlot = inputNode?.output[0];
          return (
            inputNode?.output.length === 1 &&
            inputNode.grain.kind === "entity" &&
            inputNode.grain.entity === "observation" &&
            inputNode.grain.key === inputSlot &&
            inputSlot !== undefined &&
            this.#hasStorageBackedObservationIdentity(
              inputId,
              inputSlot,
              nextActive,
            )
          );
        });
      }
      case "aggregate":
      case "sample-statistics":
      case "join":
      case "row-concatenation":
        // Aggregates and joins do not supply a storage-backed Observation key.
        return false;
      case "sort":
        return this.#hasStorageBackedObservationIdentity(
          node.input,
          slot,
          nextActive,
        );
      case "limit":
        return this.#hasStorageBackedObservationIdentity(
          node.input,
          slot,
          nextActive,
        );
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
    const input = this.#lowerNode(node.input);
    const required = this.#requiredOutput(node);
    const groupBy: Record<string, AnyExpression> = {};
    const aggregates: Record<string, AnyExpression> = {};
    const slots = new Map<SlotId, SlotLayout>();
    const visible = new Map(input.slots);

    node.groups.forEach((group, index) => {
      const groupPath = `${path}.groups[${index}].expression`;
      const value = scalarAggregateValue(
        lowerExpression(
          group.expression,
          input.relation,
          this.#logicalSlots,
          visible,
          groupPath,
          this.#plan.context.time,
        ),
        groupPath,
      );
      const outputSlot = logicalSlot(
        this.#logicalSlots,
        group.slot,
        `${path}.groups[${index}].slot`,
      );
      if (
        (outputSlot.type.kind !== "scalar" &&
          outputSlot.type.kind !== "bucket") ||
        !isSameLogicalValueType(outputSlot.type, value.type) ||
        outputSlot.nullable !== value.nullable
      )
        reject(
          `${path}.groups[${index}]`,
          "Group output metadata must match its scalar or bucket expression.",
        );

      const valueColumn = slotColumn(index, "g");
      groupBy[valueColumn] = value.expression;
      slots.set(group.slot, {
        kind: "scalar",
        type: outputSlot.type,
        nullable: outputSlot.nullable,
        valueColumn,
        candidateBounded: false,
      });
    });

    let selectedMeasureCount = 0;
    node.measures.forEach((measure, index) => {
      if (!required.has(measure.output)) return;
      selectedMeasureCount += 1;
      const outputSlot = logicalSlot(
        this.#logicalSlots,
        measure.output,
        `${path}.measures[${index}].output`,
      );
      const valueColumn = slotColumn(node.groups.length + index, "a");
      let expression: AnyExpression;
      let expectedType: LogicalValueType;
      let expectedNullable: boolean;

      if (measure.kind === "count-rows") {
        expression = count();
        expectedType = { kind: "scalar", scalar: "number" };
        expectedNullable = false;
      } else {
        const measurePath = `${path}.measures[${index}].input`;
        const value = lowerExpression(
          measure.input,
          input.relation,
          this.#logicalSlots,
          visible,
          measurePath,
          this.#plan.context.time,
        );
        if (measure.kind === "count-distinct") {
          const scalar = scalarAggregateValue(value, measurePath);
          expression = countDistinct(scalar.expression);
          expectedType = { kind: "scalar", scalar: "number" };
          expectedNullable = false;
        } else if (measure.kind === "sum") {
          const scalar = scalarAggregateValue(value, measurePath);
          expression = sum(numericAggregateExpression(scalar, measurePath));
          expectedType = scalar.type;
          expectedNullable = true;
        } else if (measure.kind === "avg") {
          const scalar = scalarAggregateValue(value, measurePath);
          expression = avg(numericAggregateExpression(scalar, measurePath));
          expectedType = scalar.type;
          expectedNullable = true;
        } else if (measure.kind === "min") {
          const scalar = comparableAggregateValue(value, measurePath);
          expression = min(scalar.expression);
          expectedType = scalar.type;
          expectedNullable = true;
        } else {
          const scalar = comparableAggregateValue(value, measurePath);
          expression = max(scalar.expression);
          expectedType = scalar.type;
          expectedNullable = true;
        }
      }

      if (
        outputSlot.type.kind !== "scalar" ||
        !isSameLogicalValueType(outputSlot.type, expectedType) ||
        outputSlot.nullable !== expectedNullable
      )
        reject(
          `${path}.measures[${index}].output`,
          "Aggregate output metadata must match its Logical measure.",
        );
      aggregates[valueColumn] = expression;
      slots.set(measure.output, {
        kind: "scalar",
        type: outputSlot.type,
        nullable: outputSlot.nullable,
        valueColumn,
        candidateBounded: false,
      });
    });

    if (node.groups.length === 0 && selectedMeasureCount === 0) {
      // An ungrouped aggregate still emits exactly one row for an empty bag.
      // Keep that cardinality with a hidden COUNT(*) instead of lowering
      // measure expressions that no selected output consumes.
      aggregates[slotColumn(node.measures.length, "h")] = count();
    }

    const relation: AnalyticsDbRelation = aggregate(input.relation, {
      groupBy,
      aggregates,
    });
    return { relation, slots, candidateActivitySessionRestricted: false };
  }

  #lowerSampleStatistics(
    node: SampleStatisticsNode,
    path: string,
  ): LoweredRelation {
    const input = this.#lowerNode(node.input);
    const visible = new Map(input.slots);
    const selected: Record<string, AnyExpression> = {};
    const groupColumns = node.groups.map((group, index) => {
      const groupPath = `${path}.groups[${index}]`;
      const value = scalarAggregateValue(
        lowerExpression(
          group.expression,
          input.relation,
          this.#logicalSlots,
          visible,
          `${groupPath}.expression`,
          this.#plan.context.time,
        ),
        `${groupPath}.expression`,
      );
      const outputSlot = logicalSlot(
        this.#logicalSlots,
        group.slot,
        `${groupPath}.slot`,
      );
      if (
        (outputSlot.type.kind !== "scalar" &&
          outputSlot.type.kind !== "bucket") ||
        !isSameLogicalValueType(outputSlot.type, value.type) ||
        outputSlot.nullable !== value.nullable
      )
        reject(
          groupPath,
          "Sample statistics group metadata must match its expression.",
        );
      const column = slotColumn(index, "g");
      selected[column] = value.expression;
      return {
        slot: group.slot,
        column,
        type: outputSlot.type,
        nullable: outputSlot.nullable,
      };
    });
    const numericValue = scalarAggregateValue(
      lowerExpression(
        node.value,
        input.relation,
        this.#logicalSlots,
        visible,
        `${path}.value`,
        this.#plan.context.time,
      ),
      `${path}.value`,
    );
    if (
      numericValue.type.kind !== "scalar" ||
      numericValue.type.scalar !== "number"
    )
      reject(
        `${path}.value`,
        "Sample statistics require numeric scalar values.",
      );
    const valueColumn = slotColumn(node.groups.length, "v");
    selected[valueColumn] = numericValue.expression;

    const projected = project(input.relation, selected);
    const projectedValue = projected.columns[valueColumn] as AnyExpression;
    const nonNull = filter(projected, isNotNull(projectedValue));
    const partitionBy = groupColumns.map(
      ({ column }) => nonNull.columns[column] as SqlExpression,
    );
    const ordinalColumn = "__analytics_sample_ordinal";
    const partitionCountColumn = "__analytics_sample_count";
    if (
      Object.hasOwn(selected, ordinalColumn) ||
      Object.hasOwn(selected, partitionCountColumn)
    )
      reject(path, "Sample statistics window aliases conflict with inputs.");
    const ordered = windowRelation(nonNull, {
      __analytics_sample_ordinal: rowNumber({
        partitionBy,
        orderBy: [
          {
            expression: nonNull.columns[valueColumn] as SqlExpression,
            direction: "ASC",
          },
        ],
      }),
      __analytics_sample_count: windowCountRows({ partitionBy }),
    });
    const groupBy: Record<string, AnyExpression> = Object.fromEntries(
      groupColumns.map(({ column }) => [
        column,
        ordered.columns[column] as AnyExpression,
      ]),
    );
    const aggregates: Record<string, AnyExpression> = {};
    const outputLayouts = new Map<SlotId, SlotLayout>();
    for (const group of groupColumns) {
      outputLayouts.set(group.slot, {
        kind: "scalar",
        type: group.type,
        nullable: group.nullable,
        valueColumn: group.column,
        candidateBounded: false,
      });
    }

    const samplesSlot = logicalSlot(
      this.#logicalSlots,
      node.samplesOutput,
      `${path}.samplesOutput`,
    );
    const averageSlot = logicalSlot(
      this.#logicalSlots,
      node.averageOutput,
      `${path}.averageOutput`,
    );
    if (
      samplesSlot.type.kind !== "scalar" ||
      samplesSlot.type.scalar !== "number" ||
      samplesSlot.type.unit !== undefined ||
      samplesSlot.nullable ||
      averageSlot.type.kind !== "scalar" ||
      !isSameLogicalValueType(averageSlot.type, numericValue.type) ||
      !averageSlot.nullable
    )
      reject(path, "Sample statistics output metadata is invalid.");

    const samplesColumn = slotColumn(node.groups.length, "samples");
    const averageColumn = slotColumn(node.groups.length + 1, "avg");
    aggregates[samplesColumn] = count();
    aggregates[averageColumn] = avg(
      ordered.columns[valueColumn] as SqlExpression<number | null>,
    );
    outputLayouts.set(node.samplesOutput, {
      kind: "scalar",
      type: samplesSlot.type,
      nullable: false,
      valueColumn: samplesColumn,
      candidateBounded: false,
    });
    outputLayouts.set(node.averageOutput, {
      kind: "scalar",
      type: averageSlot.type,
      nullable: true,
      valueColumn: averageColumn,
      candidateBounded: false,
    });

    node.percentiles.forEach((item, index) => {
      const outputSlot = logicalSlot(
        this.#logicalSlots,
        item.output,
        `${path}.percentiles[${index}].output`,
      );
      if (
        outputSlot.type.kind !== "scalar" ||
        !isSameLogicalValueType(outputSlot.type, numericValue.type) ||
        !outputSlot.nullable
      )
        reject(
          `${path}.percentiles[${index}].output`,
          "Quantile output metadata must preserve the numeric input type and be nullable.",
        );
      const threshold = castInteger(
        div(
          add(
            mul(
              ordered.columns[partitionCountColumn] as SqlExpression<number>,
              constant(item.percentile),
            ),
            constant(99),
          ),
          constant(100),
        ),
      );
      const column = slotColumn(node.groups.length + index + 2, "quantile");
      aggregates[column] = min(
        caseWhen(
          [
            {
              when: gte(
                ordered.columns[ordinalColumn] as SqlExpression<
                  number,
                  ExpressionResultType<"integer", false>
                >,
                threshold,
              ),
              then: ordered.columns[valueColumn] as SqlExpression<
                number | null,
                ExpressionResultType<"numeric", true>
              >,
            },
          ],
          constant(null),
        ),
      );
      outputLayouts.set(item.output, {
        kind: "scalar",
        type: outputSlot.type,
        nullable: true,
        valueColumn: column,
        candidateBounded: false,
      });
    });

    const relation: AnalyticsDbRelation = aggregate(ordered, {
      groupBy,
      aggregates,
    });
    return {
      relation,
      slots: outputLayouts,
      candidateActivitySessionRestricted: false,
    };
  }

  #windowPartitionBy(
    groups: readonly SlotId[],
    input: LoweredRelation,
    path: string,
  ): AnyExpression[] {
    return groups.map((slot, index) => {
      const slotPath = `${path}.groups[${index}]`;
      const logical = logicalSlot(this.#logicalSlots, slot, slotPath);
      if (logical.type.kind !== "scalar")
        reject(slotPath, "Ordered-member groups must be scalar values.");
      const value = readValue(input.relation, input.slots, slot, slotPath);
      if (value.kind !== "scalar")
        reject(slotPath, "Ordered-member groups must be scalar values.");
      return value.expression;
    });
  }

  #windowOrderBy(
    keys: readonly SortKey[],
    input: LoweredRelation,
    path: string,
  ): WindowOrderKey[] {
    const orderBy: WindowOrderKey[] = [];
    keys.forEach((key, index) => {
      const keyPath = `${path}.order[${index}]`;
      const logical = logicalSlot(
        this.#logicalSlots,
        key.slot,
        `${keyPath}.slot`,
      );
      if (logical.type.kind !== "scalar")
        reject(keyPath, "Ordered-member keys must be scalar values.");
      const value = readValue(
        input.relation,
        input.slots,
        key.slot,
        `${keyPath}.slot`,
      );
      if (value.kind !== "scalar")
        reject(keyPath, "Ordered-member keys must be scalar values.");
      const direction = key.direction === "asc" ? "ASC" : "DESC";
      const nativeNulls = key.direction === "asc" ? "first" : "last";
      if (key.nulls !== nativeNulls) {
        orderBy.push({
          expression: isNull(value.expression),
          direction: key.nulls === "first" ? "DESC" : "ASC",
        });
      }
      orderBy.push({ expression: value.expression, direction });
    });
    return orderBy;
  }

  #lowerOrderedMember(node: OrderedMemberNode, path: string): LoweredRelation {
    const input = this.#lowerNode(node.input);
    const partitionBy = this.#windowPartitionBy(node.groups, input, path);
    const orderBy = this.#windowOrderBy(node.order, input, path);

    if (partitionBy.length === 0 || orderBy.length === 0)
      reject(path, "Ordered-member requires groups and order keys.");
    const ranked = windowRelation(input.relation, {
      __analytics_ordered_member_rank: rowNumber({
        partitionBy,
        orderBy: orderBy as [WindowOrderKey, ...WindowOrderKey[]],
      }),
    });
    const selected = filter(
      ranked,
      eq(ranked.columns.__analytics_ordered_member_rank, param(1)),
    );
    const inputNode = this.#logicalNode(node.input);
    if (!inputNode)
      reject(`${path}.input`, "The ordered-member input node is missing.");
    const values = inputNode.output
      .filter((slot) => this.#requiredOutput(node).has(slot))
      .map((slot) => ({
        slot,
        value: readValue(selected, input.slots, slot, path),
      }));
    const projected = projectedValues(
      selected,
      values,
      this.#logicalSlots,
      path,
    );
    return {
      ...projected,
      candidateActivity: input.candidateActivity,
      candidateActivitySessionRelation: input.candidateActivitySessionRelation,
      candidateActivitySessionRestricted:
        input.candidateActivitySessionRestricted,
    };
  }

  #lowerRankedMembers(node: RankedMembersNode, path: string): LoweredRelation {
    const inputNode = this.#logicalNode(node.input);
    if (!inputNode)
      reject(`${path}.input`, "The ranked-members input node is missing.");
    const inputGrain = inputNode.grain;
    if (
      inputGrain.kind !== "keyed" ||
      inputGrain.keys.length === 0 ||
      new Set(inputGrain.keys).size !== inputGrain.keys.length
    )
      reject(
        `${path}.input.grain`,
        "Ranked members require a unique keyed grain.",
      );
    if (
      new Set(node.groups).size !== node.groups.length ||
      node.order.length === 0 ||
      new Set(node.order.map((key) => key.slot)).size !== node.order.length
    )
      reject(path, "Ranked-member grouping and ordering keys are invalid.");
    for (const [index, slot] of [
      ...node.groups,
      ...node.order.map((key) => key.slot),
    ].entries()) {
      if (!inputNode.output.includes(slot))
        reject(
          `${path}.keys[${index}]`,
          "Ranked-member key is not visible in its input.",
        );
      if (
        logicalSlot(this.#logicalSlots, slot, `${path}.keys[${index}]`).type
          .kind !== "scalar"
      )
        reject(`${path}.keys[${index}]`, "Ranked-member keys must be scalar.");
    }
    for (const [index, key] of node.order.entries()) {
      if (
        (key.direction !== "asc" && key.direction !== "desc") ||
        (key.nulls !== "first" && key.nulls !== "last")
      )
        reject(
          `${path}.order[${index}]`,
          "Ranked-member ordering metadata is invalid.",
        );
    }
    const rankingKeys = [
      ...new Set([...node.groups, ...node.order.map((key) => key.slot)]),
    ];
    if (
      inputGrain.keys.some(
        (key) =>
          !rankingKeys.includes(key) ||
          logicalSlot(this.#logicalSlots, key, `${path}.input.grain`).type
            .kind !== "scalar",
      ) ||
      node.grain.kind !== "keyed" ||
      node.grain.keys.length !== inputGrain.keys.length ||
      node.grain.keys.some((key, index) => key !== inputGrain.keys[index])
    )
      reject(
        `${path}.grain`,
        "Ranked-member keys must cover and preserve input grain.",
      );
    if (
      node.output.length !== inputNode.output.length + 1 ||
      inputNode.output.some((slot, index) => node.output[index] !== slot) ||
      node.output.at(-1) !== node.rankSlot ||
      inputNode.output.includes(node.rankSlot)
    )
      reject(
        `${path}.output`,
        "Ranked members must append exactly one new rank slot.",
      );
    const rankSlot = logicalSlot(
      this.#logicalSlots,
      node.rankSlot,
      `${path}.rankSlot`,
    );
    if (
      !isSameLogicalValueType(rankSlot.type, {
        kind: "scalar",
        scalar: "number",
      }) ||
      rankSlot.nullable ||
      rankSlot.lineage.kind !== "derived" ||
      rankSlot.lineage.operation !== "ranked-members" ||
      rankSlot.lineage.inputs.length !== rankingKeys.length ||
      rankSlot.lineage.inputs.some((slot, index) => slot !== rankingKeys[index])
    )
      reject(
        `${path}.rankSlot`,
        "Rank output must be a new non-null unitless numeric derived slot.",
      );

    const input = this.#lowerNode(node.input);
    const required = this.#requiredOutput(node);
    const rankNeeded = required.has(node.rankSlot);
    let relation = input.relation;
    if (rankNeeded) {
      const partitionBy = this.#windowPartitionBy(node.groups, input, path);
      const orderBy = this.#windowOrderBy(node.order, input, path);
      if (orderBy.length === 0)
        reject(path, "Ranked members require order keys.");
      relation = windowRelation(input.relation, {
        __analytics_ranked_member_ordinal: rowNumber({
          partitionBy,
          orderBy: orderBy as [WindowOrderKey, ...WindowOrderKey[]],
        }),
      });
    }
    const values = inputNode.output
      .filter((slot) => required.has(slot))
      .map((slot) => ({
        slot,
        value: readValue(relation, input.slots, slot, path),
      }));
    if (rankNeeded) {
      values.push({
        slot: node.rankSlot,
        value: {
          kind: "scalar",
          expression: relationColumn(
            relation,
            "__analytics_ranked_member_ordinal",
            `${path}.rankSlot`,
          ),
          type: { kind: "scalar", scalar: "number" },
          nullable: false,
          candidateBounded: false,
        },
      });
    }
    const projected = projectedValues(
      relation,
      values,
      this.#logicalSlots,
      path,
    );
    return {
      ...projected,
      candidateActivity: input.candidateActivity,
      candidateActivitySessionRelation: input.candidateActivitySessionRelation,
      candidateActivitySessionRestricted:
        input.candidateActivitySessionRestricted,
    };
  }

  #lowerJoin(node: JoinNode, path: string): LoweredRelation {
    const leftNode = this.#logicalNode(node.left);
    const rightNode = this.#logicalNode(node.right);
    if (!leftNode || !rightNode) reject(path, "A join input node is missing.");
    const keylessScalarBroadcast =
      node.joinType === "inner" &&
      node.keys.length === 0 &&
      rightNode.grain.kind === "scalar";
    const keylessScalarInner =
      keylessScalarBroadcast && node.grain.kind === "scalar";
    if (!keylessScalarBroadcast) {
      if (
        (node.joinType !== "inner" && node.joinType !== "left") ||
        node.keys.length === 0 ||
        rightNode.grain.kind === "entity"
      )
        reject(
          path,
          "Only keyless scalar inner joins and keyed scalar inner/left joins are supported.",
        );
      const coveredRightKeys = new Set(node.keys.map((key) => key.right));
      for (const [index, key] of node.keys.entries()) {
        const leftKey = logicalSlot(
          this.#logicalSlots,
          key.left,
          `${path}.keys[${index}].left`,
        );
        const rightKey = logicalSlot(
          this.#logicalSlots,
          key.right,
          `${path}.keys[${index}].right`,
        );
        if (
          (leftKey.type.kind !== "scalar" && leftKey.type.kind !== "bucket") ||
          (rightKey.type.kind !== "scalar" &&
            rightKey.type.kind !== "bucket") ||
          !isSameLogicalValueType(leftKey.type, rightKey.type)
        )
          reject(
            `${path}.keys[${index}]`,
            "Keyed joins require matching scalar or bucket key types.",
          );
      }
      const rightGrainKeys =
        rightNode.grain.kind === "keyed" ? rightNode.grain.keys : [];
      for (const [index, key] of rightGrainKeys.entries()) {
        const slot = logicalSlot(
          this.#logicalSlots,
          key,
          `${path}.right.grain.keys[${index}]`,
        );
        if (
          (slot.type.kind !== "scalar" && slot.type.kind !== "bucket") ||
          !coveredRightKeys.has(key)
        )
          reject(
            `${path}.keys`,
            "Join keys must cover the complete scalar or bucket right grain.",
          );
      }
    }
    const left = this.#lowerNode(node.left);
    const right = this.#lowerNode(node.right);
    const predicate = keylessScalarBroadcast
      ? eq(param(1), param(1))
      : combinePredicates(
          "and",
          node.keys.map((key, index) => {
            const leftValue = readValue(
              left.relation,
              left.slots,
              key.left,
              `${path}.keys[${index}].left`,
            );
            const rightValue = readValue(
              right.relation,
              right.slots,
              key.right,
              `${path}.keys[${index}].right`,
            );
            if (leftValue.kind !== "scalar" || rightValue.kind !== "scalar")
              reject(
                `${path}.keys[${index}]`,
                "Keyed joins require scalar physical key expressions.",
              );
            return eq(leftValue.expression, rightValue.expression);
          }),
          `${path}.keys`,
        );
    const joined = join(
      left.relation,
      right.relation,
      predicate,
      node.joinType,
    );
    const required = this.#requiredOutput(node);
    const values: { readonly slot: SlotId; readonly value: LoweredValue }[] = [
      ...leftNode.output
        .filter((slot) => required.has(slot))
        .map((slot) => ({
          slot,
          value: this.#joinedValue(joined, left.slots.get(slot), "left_", path),
        })),
    ];
    const aliases =
      node.joinType === "left"
        ? new Map(node.rightAliases.map((alias) => [alias.source, alias.alias]))
        : undefined;
    for (const sourceSlot of rightNode.output) {
      const outputSlot = aliases?.get(sourceSlot) ?? sourceSlot;
      if (!required.has(outputSlot)) continue;
      let value = this.#joinedValue(
        joined,
        right.slots.get(sourceSlot),
        "right_",
        path,
      );
      if (!keylessScalarInner) {
        if (value.kind !== "scalar")
          reject(
            `${path}.right.${String(sourceSlot)}`,
            "Keyed joins currently expose scalar right values only.",
          );
        if (aliases) {
          const alias = logicalSlot(
            this.#logicalSlots,
            outputSlot,
            `${path}.rightAliases.${String(outputSlot)}`,
          );
          if (alias.type.kind !== "scalar" || !alias.nullable)
            reject(
              `${path}.rightAliases.${String(outputSlot)}`,
              "Left-joined scalar aliases must be nullable.",
            );
          value = { ...value, nullable: alias.nullable };
        }
      }
      values.push({ slot: outputSlot, value });
    }
    const projected = projectedValues(joined, values, this.#logicalSlots, path);
    return keylessScalarInner
      ? projected
      : {
          ...projected,
          candidateActivity: left.candidateActivity,
          candidateActivitySessionRelation:
            left.candidateActivitySessionRelation,
          candidateActivitySessionRestricted:
            left.candidateActivitySessionRestricted,
        };
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

  #prepareRequiredSlots(
    outputs: readonly LogicalOutput[],
    reachable: ReadonlySet<RelationId>,
  ): void {
    this.#requiredSlots.clear();
    for (const output of outputs)
      this.#addRequiredSlots(
        output.relation,
        output.fields.map((field) => field.slot),
      );
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.#plan.nodes) {
        if (!reachable.has(node.id)) continue;
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
          case "ordered-member":
            add(node.input, [
              ...node.output.filter((slot) => needed.has(slot)),
              ...node.groups,
              ...node.order.map((key) => key.slot),
            ]);
            break;
          case "ranked-members":
            add(node.input, [
              ...node.output.filter(
                (slot) => slot !== node.rankSlot && needed.has(slot),
              ),
              ...node.groups,
              ...node.order.map((key) => key.slot),
            ]);
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
          case "row-concatenation":
            node.inputs.forEach((inputId, inputIndex) =>
              add(
                inputId,
                node.columns.flatMap((column) =>
                  needed.has(column.output) &&
                  column.inputs[inputIndex] !== undefined
                    ? [column.inputs[inputIndex]!]
                    : [],
                ),
              ),
            );
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
            add(node.input, [
              ...node.groups.flatMap((group) =>
                this.#expressionSlots(group.expression),
              ),
              ...node.measures.flatMap((measure) =>
                !needed.has(measure.output) || measure.kind === "count-rows"
                  ? []
                  : this.#expressionSlots(measure.input),
              ),
            ]);
            break;
          }
          case "sample-statistics":
            add(node.input, [
              ...node.groups.flatMap((group) =>
                this.#expressionSlots(group.expression),
              ),
              ...this.#expressionSlots(node.value),
            ]);
            break;
          case "join": {
            const left = this.#nodes.get(node.left);
            const right = this.#nodes.get(node.right);
            if (left)
              add(node.left, [
                ...left.output.filter((slot) => needed.has(slot)),
                ...node.keys.map((key) => key.left),
              ]);
            if (right) {
              const requestedRight =
                node.joinType === "left"
                  ? node.rightAliases
                      .filter((alias) => needed.has(alias.alias))
                      .map((alias) => alias.source)
                  : right.output.filter((slot) => needed.has(slot));
              add(node.right, [
                ...requestedRight,
                ...node.keys.map((key) => key.right),
              ]);
            }
            break;
          }
          case "sort":
            add(node.input, [
              ...node.output.filter((slot) => needed.has(slot)),
              ...node.keys.map((key) => key.slot),
            ]);
            break;
          case "limit":
            add(
              node.input,
              node.output.filter((slot) => needed.has(slot)),
            );
            break;
        }
      }
    }
  }

  #addRequiredSlots(relation: RelationId, slots: readonly SlotId[]): boolean {
    let changed = false;
    let required = this.#requiredSlots.get(relation);
    if (!required) {
      required = new Set<SlotId>();
      this.#requiredSlots.set(relation, required);
      changed = true;
    }
    for (const slot of slots) {
      if (required.has(slot)) continue;
      required.add(slot);
      changed = true;
    }
    return changed;
  }

  #requiredOutput(node: LogicalNode): ReadonlySet<SlotId> {
    const required = this.#requiredSlots.get(node.id);
    return required ?? new Set(node.output);
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
      case "string-normalize":
      case "absolute":
      case "round":
      case "time-bucket":
      case "bucket-index":
        return this.#expressionSlots(expression.input);
      case "page-dimension":
        return expression.dependencies.flatMap((dependency) =>
          this.#expressionSlots(dependency.expression),
        );
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
