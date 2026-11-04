import {
  add,
  and,
  callFunction,
  caseWhen,
  castReal,
  castText,
  coalesce,
  concatText,
  constant,
  DatabaseCompilerError,
  div,
  eq,
  gt,
  gte,
  inList,
  isNotNull,
  isNull,
  lt,
  lte,
  mul,
  neq,
  not,
  param,
  sub,
  textContains,
  textEndsWith,
  textLike,
  textPosition,
  textStartsWith,
  textSubstring,
  trimCharacters,
  trimSpaces,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  Predicate,
  SqlExpression,
} from "@/lib/db/query/expression";
import { buildCalendarBucketPlan } from "@/lib/edge/analytics/contract";
import type { LogicalExpr } from "@/lib/edge/analytics/engine/logical/expression";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
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
import { semanticPageDimension } from "@/lib/edge/analytics/engine/semantic/page-dimensions";
import type { SemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import {
  browserEngineExpression,
  osVersionExpression,
  trafficChannelExpression,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scalar-filter-lowering";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import {
  normalizeAsciiCaseFoldedText,
  type RegisteredComparisonAdmissionBinding,
} from "@/lib/edge/analytics/providers/d1/internal/comparison-domain-admission";
import { DIRECT_REFERRER_FILTER_VALUE } from "@/lib/edge/analytics/providers/d1/internal/core-types";

import { AnalyticsRelationalLoweringError, reject } from "./errors";
import {
  asPredicate,
  combinePredicates,
  logicalSlot,
  type LoweredValue,
  readValue,
  scalarValue,
  type SlotLayout,
} from "./values";

const ECMASCRIPT_TRIM_CHARACTERS =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

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

export interface ComparisonAdmissionExpressionContext {
  readonly binding: RegisteredComparisonAdmissionBinding;
  readonly owner: object;
  readonly relationId: RelationId;
}

export function lowerExpression(
  expression: LogicalExpr,
  relation: AnalyticsDbRelation,
  logicalSlots: ReadonlyMap<SlotId, LogicalSlot>,
  visible: ReadonlyMap<SlotId, SlotLayout>,
  path: string,
  time: SemanticTemporalDomains,
  admission?: ComparisonAdmissionExpressionContext,
): LoweredValue {
  return lowerExpressionInternal(
    expression,
    relation,
    logicalSlots,
    visible,
    path,
    time,
    admission,
  );
}

function lowerExpressionInternal(
  expression: LogicalExpr,
  relation: AnalyticsDbRelation,
  logicalSlots: ReadonlyMap<SlotId, LogicalSlot>,
  visible: ReadonlyMap<SlotId, SlotLayout>,
  path: string,
  time: SemanticTemporalDomains,
  admission?: ComparisonAdmissionExpressionContext,
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
      const left = lowerExpressionInternal(
        expression.left,
        relation,
        logicalSlots,
        visible,
        `${path}.left`,
        time,
        admission,
      );
      const right = lowerExpressionInternal(
        expression.right,
        relation,
        logicalSlots,
        visible,
        `${path}.right`,
        time,
        admission,
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
      } else if (expression.stringNormalization === "trim-case-fold") {
        if (
          !admission?.binding.authorizesExpression(
            admission.owner,
            admission.relationId,
            expression,
          )
        )
          reject(
            path,
            "This adapter does not support case-fold normalization.",
          );
        leftExpression = normalizeAsciiCaseFoldedText(leftExpression);
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
        lowerExpressionInternal(
          term,
          relation,
          logicalSlots,
          visible,
          `${path}.terms[${index}]`,
          time,
          admission,
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
      const loweredInput = lowerExpressionInternal(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
        admission,
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
      const input = lowerExpressionInternal(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
        admission,
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
      const input = lowerExpressionInternal(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
        admission,
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
      else if (expression.stringNormalization === "trim-case-fold") {
        if (
          !admission?.binding.authorizesExpression(
            admission.owner,
            admission.relationId,
            expression,
          )
        )
          reject(
            path,
            "This adapter does not support case-fold normalization.",
          );
        membershipValue = normalizeAsciiCaseFoldedText(inputExpression);
      } else if (expression.stringNormalization !== undefined)
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
        lowerExpressionInternal(
          item,
          relation,
          logicalSlots,
          visible,
          `${path}.values[${index}]`,
          time,
          admission,
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
        const when = lowerExpressionInternal(
          branch.when,
          relation,
          logicalSlots,
          visible,
          `${path}.branches[${index}].when`,
          time,
          admission,
        );
        const then = lowerExpressionInternal(
          branch.then,
          relation,
          logicalSlots,
          visible,
          `${path}.branches[${index}].then`,
          time,
          admission,
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
      const otherwise = lowerExpressionInternal(
        expression.otherwise,
        relation,
        logicalSlots,
        visible,
        `${path}.otherwise`,
        time,
        admission,
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
      const input = lowerExpressionInternal(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
        admission,
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
      const input = lowerExpressionInternal(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
        admission,
      );
      if (
        input.kind !== "scalar" ||
        input.type.kind !== "scalar" ||
        input.type.scalar !== "string"
      )
        reject(path, "String normalization requires a string scalar value.");
      if (
        expression.normalization !== "trim-ascii-space" &&
        expression.normalization !== "trim"
      )
        reject(path, "The string normalization mode is unsupported.");
      return {
        kind: "scalar",
        expression:
          expression.normalization === "trim-ascii-space"
            ? trimSpaces(input.expression as SqlExpression<string | null>)
            : trimCharacters(
                input.expression as SqlExpression<
                  string | null,
                  ExpressionResultType<"text" | "unknown", boolean>
                >,
                constant(ECMASCRIPT_TRIM_CHARACTERS),
              ),
        type: { kind: "scalar", scalar: "string" },
        nullable: input.nullable,
        candidateBounded: input.candidateBounded,
      };
    }
    case "number-report-text": {
      const input = lowerExpressionInternal(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
        admission,
      );
      if (
        expression.semantics !== "legacy-report-number-v1" ||
        input.kind !== "scalar" ||
        input.type.kind !== "scalar" ||
        input.type.scalar !== "number" ||
        input.type.unit !== undefined ||
        !["integer", "real", "numeric"].includes(
          input.expression.resultType.affinity,
        )
      )
        reject(
          path,
          "Legacy report number text requires a unitless numeric scalar.",
        );
      const numericExpression = input.expression as SqlExpression<
        number | null,
        ExpressionResultType<"integer" | "real" | "numeric", boolean>
      >;
      return {
        kind: "scalar",
        expression: castText(numericExpression),
        type: { kind: "scalar", scalar: "string" },
        nullable: input.nullable,
        candidateBounded: input.candidateBounded,
      };
    }
    case "text-concatenation": {
      if (expression.values.length < 2)
        reject(path, "Text concatenation requires at least two operands.");
      const values = expression.values.map((value, index) =>
        lowerExpressionInternal(
          value,
          relation,
          logicalSlots,
          visible,
          `${path}.values[${index}]`,
          time,
          admission,
        ),
      );
      const textValues = values.map((value) => {
        if (
          value.kind !== "scalar" ||
          value.type.kind !== "scalar" ||
          value.type.scalar !== "string"
        )
          reject(path, "Text concatenation accepts only scalar strings.");
        return value.expression as SqlExpression<
          string | null,
          ExpressionResultType<"text", boolean>
        >;
      });
      const concatenated = textValues
        .slice(1)
        .reduce<
          SqlExpression<string | null, ExpressionResultType<"text", boolean>>
        >((previous, next) => concatText(previous, next), textValues[0]!);
      return {
        kind: "scalar",
        expression: concatenated,
        type: { kind: "scalar", scalar: "string" },
        nullable: values.some((value) => value.nullable),
        candidateBounded: values.some((value) => value.candidateBounded),
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
        const value = lowerExpressionInternal(
          dependency.expression,
          relation,
          logicalSlots,
          visible,
          `${path}.dependencies.${dependency.attribute}`,
          time,
          admission,
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
      const input = lowerExpressionInternal(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
        admission,
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
      if (
        expression.operator === "add" &&
        expression.right.kind === "elapsed-duration-literal" &&
        inferred.type.kind === "scalar" &&
        inferred.type.scalar === "datetime"
      ) {
        const durationScale = {
          ms: 1,
          s: 1_000,
          m: 60_000,
          h: 3_600_000,
          d: 86_400_000,
          w: 604_800_000,
        } as const;
        const elapsedMs =
          expression.right.amount * durationScale[expression.right.unit];
        if (!Number.isFinite(elapsedMs))
          reject(
            path,
            "Elapsed duration is outside finite epoch milliseconds.",
          );
        const left = lowerExpressionInternal(
          expression.left,
          relation,
          logicalSlots,
          visible,
          `${path}.left`,
          time,
          admission,
        );
        if (
          left.kind !== "scalar" ||
          left.type.kind !== "scalar" ||
          left.type.scalar !== "datetime"
        )
          reject(path, "Datetime addition requires a datetime left operand.");
        const timestamp = scalarValue(left, `${path}.left`);
        if (
          !["integer", "real", "numeric", "unknown"].includes(
            timestamp.resultType.affinity,
          )
        )
          reject(path, "Datetime epoch addition requires a numeric SQL value.");
        return {
          kind: "scalar",
          expression: add(
            timestamp as SqlExpression<number | null>,
            param(elapsedMs),
          ),
          type: inferred.type,
          nullable: inferred.nullable,
          candidateBounded: left.candidateBounded,
        };
      }
      const left = lowerExpressionInternal(
        expression.left,
        relation,
        logicalSlots,
        visible,
        `${path}.left`,
        time,
        admission,
      );
      const right = lowerExpressionInternal(
        expression.right,
        relation,
        logicalSlots,
        visible,
        `${path}.right`,
        time,
        admission,
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
      const input = lowerExpressionInternal(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
        admission,
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
      const input = lowerExpressionInternal(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
        admission,
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
    case "numeric-value": {
      const input = lowerExpressionInternal(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
        admission,
      );
      if (
        input.kind !== "scalar" ||
        input.type.kind !== "scalar" ||
        input.type.scalar !== "number"
      )
        reject(path, "Numeric-value requires a lowered numeric scalar.");
      const numericExpression = scalarValue(
        input,
        `${path}.input`,
      ) as SqlExpression<number | null>;
      return {
        kind: "scalar",
        expression: castReal(numericExpression),
        type: { kind: "scalar", scalar: "number" },
        nullable: input.nullable,
        candidateBounded: input.candidateBounded,
      };
    }
    case "round": {
      const input = lowerExpressionInternal(
        expression.input,
        relation,
        logicalSlots,
        visible,
        `${path}.input`,
        time,
        admission,
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
