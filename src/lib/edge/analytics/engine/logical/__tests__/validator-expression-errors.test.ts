import { describe, expect, it } from "vitest";

import {
  calendarPeriodLiteral,
  elapsedDurationLiteral,
  type LogicalExpr,
  scalarLiteral,
} from "@/lib/edge/analytics/engine/logical/expression";
import { slotId } from "@/lib/edge/analytics/engine/logical/ids";
import {
  inferLogicalExpression,
  LogicalPlanError,
} from "@/lib/edge/analytics/engine/logical/validator";

const ids = {
  str: slotId(1),
  num: slotId(2),
  bool: slotId(3),
  dt: slotId(4),
  bucket: slotId(5),
  entity: slotId(6),
  ms: slotId(7),
};

const slots = new Map<number, unknown>([
  [ids.str, { type: { kind: "scalar", scalar: "string" }, nullable: false }],
  [ids.num, { type: { kind: "scalar", scalar: "number" }, nullable: false }],
  [ids.bool, { type: { kind: "scalar", scalar: "boolean" }, nullable: true }],
  [ids.dt, { type: { kind: "scalar", scalar: "datetime" }, nullable: false }],
  [
    ids.bucket,
    {
      type: { kind: "bucket", granularity: "day", reportingTimeZone: "UTC" },
      nullable: false,
    },
  ],
  [ids.entity, { type: { kind: "entity", entity: "page" }, nullable: false }],
  [
    ids.ms,
    { type: { kind: "scalar", scalar: "number", unit: "ms" }, nullable: false },
  ],
]);

function resolve(id: number) {
  const slot = slots.get(id);
  if (!slot) throw new Error(`unknown ${id}`);
  return slot as never;
}

const slot = (id: keyof typeof ids): LogicalExpr => ({
  kind: "slot",
  slot: ids[id],
});
const str = (value: string | null = "a") => scalarLiteral(value, "string");
const num = (value: number | null = 1) => scalarLiteral(value, "number");
const bool = (value: boolean | null = true) => scalarLiteral(value, "boolean");
const infer = (expression: unknown) =>
  inferLogicalExpression(expression as LogicalExpr, resolve);

function issue(expression: unknown) {
  try {
    inferLogicalExpression(expression as LogicalExpr, resolve, "e");
  } catch (error) {
    expect(error).toBeInstanceOf(LogicalPlanError);
    const issues = (error as LogicalPlanError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("invalid-expression");
    return issues[0]!;
  }
  throw new Error("expected_expression_error");
}

const divide = (left: unknown, right: unknown) => ({
  kind: "arithmetic",
  operator: "divide",
  zeroDenominator: "null",
  left,
  right,
});

describe("logical expression inference rejection rules", () => {
  const cases: readonly (readonly [string, unknown, string])[] = [
    [
      "literal with unknown scalar",
      { ...str(), valueType: { kind: "scalar", scalar: "bogus" } },
      "Literal value does not match",
    ],
    [
      "literal with non-scalar type",
      { ...str(), valueType: { kind: "duration" } },
      "Literal value does not match",
    ],
    [
      "unit on non-number literal",
      {
        ...str(),
        valueType: { kind: "scalar", scalar: "string", unit: "ms" },
      },
      "Literal value does not match",
    ],
    [
      "bad unit literal",
      { ...num(), valueType: { kind: "scalar", scalar: "number", unit: "kg" } },
      "Literal value does not match",
    ],
    [
      "boolean literal with string",
      { ...bool(), value: "yes" },
      "Literal value does not match",
    ],
    [
      "non finite number literal",
      num(Number.POSITIVE_INFINITY),
      "Literal value does not match",
    ],
    [
      "datetime literal with boolean",
      { ...scalarLiteral("x", "datetime"), value: true },
      "Literal value does not match",
    ],
    [
      "string literal with number",
      { ...str(), value: 3 },
      "Literal value does not match",
    ],
    [
      "elapsed duration non finite",
      { kind: "elapsed-duration-literal", amount: Number.NaN, unit: "ms" },
      "Elapsed duration literals",
    ],
    [
      "elapsed duration unit",
      { kind: "elapsed-duration-literal", amount: 1, unit: "mo" },
      "Elapsed duration literals",
    ],
    [
      "calendar period non finite",
      {
        kind: "calendar-period-literal",
        amount: Number.POSITIVE_INFINITY,
        unit: "d",
      },
      "Calendar period literals",
    ],
    [
      "calendar period unit",
      { kind: "calendar-period-literal", amount: 1, unit: "ms" },
      "Calendar period literals",
    ],
    [
      "comparison type mismatch",
      { kind: "comparison", operator: "eq", left: str(), right: num() },
      "operand types are incompatible",
    ],
    [
      "entity ordering",
      {
        kind: "comparison",
        operator: "gt",
        left: slot("entity"),
        right: slot("entity"),
      },
      "Entity values only support equality",
    ],
    [
      "bucket ordering",
      {
        kind: "comparison",
        operator: "lt",
        left: slot("bucket"),
        right: slot("bucket"),
      },
      "Bucket values only support equality",
    ],
    [
      "calendar period ordering",
      {
        kind: "comparison",
        operator: "gte",
        left: calendarPeriodLiteral(1, "d"),
        right: calendarPeriodLiteral(2, "d"),
      },
      "Calendar periods only support equality",
    ],
    [
      "invalid normalization mode",
      {
        kind: "comparison",
        operator: "eq",
        left: str(),
        right: str(),
        stringNormalization: "upper",
      },
      "String normalization mode is invalid.",
    ],
    [
      "comparison normalization on numbers",
      {
        kind: "comparison",
        operator: "eq",
        left: num(),
        right: num(),
        stringNormalization: "trim",
      },
      "requires string scalar operands",
    ],
    [
      "ascii normalization on ordering",
      {
        kind: "comparison",
        operator: "gt",
        left: str(),
        right: str(),
        stringNormalization: "ascii-case-fold",
      },
      "only for equality comparisons",
    ],
    [
      "empty boolean",
      { kind: "boolean", operator: "and", terms: [] },
      "at least one term",
    ],
    [
      "non boolean term",
      { kind: "boolean", operator: "or", terms: [num()] },
      "require boolean scalar terms",
    ],
    [
      "not non boolean",
      { kind: "not", input: num() },
      "NOT requires a boolean",
    ],
    [
      "set membership literal mismatch",
      { kind: "set-membership", input: str(), values: [num()], negated: false },
      "literal does not match the input type",
    ],
    [
      "set membership normalization on number",
      {
        kind: "set-membership",
        input: num(),
        values: [num()],
        negated: false,
        stringNormalization: "trim",
      },
      "requires string scalar operands",
    ],
    [
      "set membership comparison-only normalization",
      {
        kind: "set-membership",
        input: str(),
        values: [str()],
        negated: false,
        stringNormalization: "ascii-case-fold",
      },
      "invalid for this expression",
    ],
    [
      "unknown legacy search semantics",
      {
        kind: "string-match",
        operator: "contains",
        input: str(),
        value: "a",
        caseSensitive: false,
        semantics: "other",
      },
      "Legacy search semantics",
    ],
    [
      "legacy search starts-with",
      {
        kind: "string-match",
        operator: "starts-with",
        input: str(),
        value: "a",
        caseSensitive: false,
        semantics: "legacy-record-search-v1",
      },
      "Legacy search semantics",
    ],
    [
      "legacy report search not normalized",
      {
        kind: "string-match",
        operator: "contains",
        input: str(),
        value: " A ",
        caseSensitive: false,
        semantics: "legacy-report-search-v1",
      },
      "Legacy search semantics",
    ],
    [
      "non string match value",
      {
        kind: "string-match",
        operator: "contains",
        input: str(),
        value: 4,
        caseSensitive: false,
      },
      "Legacy search semantics",
    ],
    [
      "string match on number",
      {
        kind: "string-match",
        operator: "contains",
        input: num(),
        value: "a",
        caseSensitive: false,
      },
      "String matching requires",
    ],
    [
      "string match comparison-only normalization",
      {
        kind: "string-match",
        operator: "contains",
        input: str(),
        value: "a",
        caseSensitive: false,
        stringNormalization: "ascii-case-fold",
      },
      "invalid for this expression",
    ],
    [
      "invalid string-normalize mode",
      { kind: "string-normalize", input: str(), normalization: "upper" },
      "String normalization mode is invalid.",
    ],
    [
      "string-normalize number",
      { kind: "string-normalize", input: num(), normalization: "trim" },
      "requires a string scalar",
    ],
    [
      "report text with wrong semantics",
      { kind: "number-report-text", input: num(), semantics: "x" },
      "unitless numeric scalar",
    ],
    [
      "report text of string",
      {
        kind: "number-report-text",
        input: str(),
        semantics: "legacy-report-number-v1",
      },
      "unitless numeric scalar",
    ],
    [
      "concat with one operand",
      { kind: "text-concatenation", values: [str()] },
      "at least two operands",
    ],
    [
      "concat with number",
      { kind: "text-concatenation", values: [str(), num()] },
      "accepts only scalar strings",
    ],
    [
      "unknown page dimension",
      { kind: "page-dimension", dimension: "nope", dependencies: [] },
      "dependencies must exactly match",
    ],
    [
      "divide without null policy",
      { kind: "arithmetic", operator: "divide", left: num(), right: num() },
      "zero denominator to null",
    ],
    [
      "duration times duration",
      {
        kind: "arithmetic",
        operator: "multiply",
        left: elapsedDurationLiteral(1, "s"),
        right: elapsedDurationLiteral(1, "s"),
      },
      "Elapsed duration arithmetic",
    ],
    [
      "calendar period multiplied",
      {
        kind: "arithmetic",
        operator: "multiply",
        left: calendarPeriodLiteral(1, "d"),
        right: num(),
      },
      "Calendar periods only support addition",
    ],
    [
      "arithmetic on strings",
      { kind: "arithmetic", operator: "add", left: str(), right: str() },
      "require numeric scalar operands",
    ],
    [
      "add mismatched units",
      {
        kind: "arithmetic",
        operator: "add",
        left: slot("ms"),
        right: slot("num"),
      },
      "operand types are incompatible",
    ],
    [
      "multiply two units",
      {
        kind: "arithmetic",
        operator: "multiply",
        left: slot("ms"),
        right: slot("ms"),
      },
      "two unit-bearing values",
    ],
    [
      "divide incompatible units",
      divide(slot("ms"), scalarLiteral(1, "number", "px")),
      "Division units are incompatible",
    ],
    [
      "divide by unit-bearing",
      divide(num(), slot("ms")),
      "Division by a unit-bearing value",
    ],
    [
      "numeric-value of string",
      { kind: "numeric-value", input: str() },
      "Numeric-value requires",
    ],
    ["abs of string", { kind: "absolute", input: str() }, "ABS requires"],
    [
      "round of string",
      { kind: "round", input: str() },
      "ROUND requires a numeric",
    ],
    [
      "round bad precision",
      { kind: "round", input: num(), decimalPlaces: 16 },
      "integer from 0 through 15",
    ],
    [
      "round fractional precision",
      { kind: "round", input: num(), decimalPlaces: 1.5 },
      "integer from 0 through 15",
    ],
    ["empty coalesce", { kind: "coalesce", values: [] }, "at least one value"],
    [
      "mixed coalesce",
      { kind: "coalesce", values: [str(), num()] },
      "operand types are incompatible",
    ],
    [
      "case non boolean condition",
      {
        kind: "case",
        branches: [{ when: num(), then: str() }],
        otherwise: str(),
      },
      "CASE conditions must be boolean",
    ],
    [
      "case mixed branches",
      {
        kind: "case",
        branches: [{ when: bool(), then: num() }],
        otherwise: str(),
      },
      "operand types are incompatible",
    ],
    [
      "time bucket bad granularity",
      {
        kind: "time-bucket",
        input: slot("dt"),
        granularity: "decade",
        reportingTimeZone: "UTC",
      },
      "supported granularity",
    ],
    [
      "time bucket empty zone",
      {
        kind: "time-bucket",
        input: slot("dt"),
        granularity: "day",
        reportingTimeZone: "",
      },
      "supported granularity",
    ],
    [
      "time bucket of string",
      {
        kind: "time-bucket",
        input: str(),
        granularity: "day",
        reportingTimeZone: "UTC",
      },
      "date, datetime, or epoch",
    ],
    [
      "bucket index of number",
      { kind: "bucket-index", input: num() },
      "calendar bucket expression",
    ],
  ];

  it.each(cases)("rejects %s", (_name, expression, message) => {
    expect(issue(expression).message).toContain(message);
  });

  it("reports the failing path of nested operands", () => {
    expect(
      issue({
        kind: "boolean",
        operator: "and",
        terms: [bool(), { kind: "not", input: num() }],
      }).path,
    ).toBe("e.terms[1]");
  });

  it("accepts the permitted counterparts of the rejected shapes", () => {
    const ratio = { kind: "scalar", scalar: "number", unit: "ratio" };
    expect(infer(divide(slot("ms"), slot("ms"))).type).toEqual(ratio);
    expect(infer(divide(num(), num()))).toEqual({
      type: ratio,
      nullable: true,
    });
    expect(
      infer(
        divide(elapsedDurationLiteral(1, "s"), elapsedDurationLiteral(2, "s")),
      ).type,
    ).toEqual(ratio);
    expect(
      infer({
        kind: "arithmetic",
        operator: "multiply",
        left: elapsedDurationLiteral(1, "s"),
        right: num(),
      }).type,
    ).toEqual({ kind: "duration" });
    expect(
      infer({
        kind: "arithmetic",
        operator: "subtract",
        left: slot("dt"),
        right: slot("dt"),
      }).type,
    ).toEqual({ kind: "duration" });
    expect(
      infer({
        kind: "arithmetic",
        operator: "add",
        left: slot("dt"),
        right: elapsedDurationLiteral(1, "h"),
      }).type,
    ).toEqual({ kind: "scalar", scalar: "datetime" });
    expect(
      infer({
        kind: "arithmetic",
        operator: "add",
        left: calendarPeriodLiteral(1, "d"),
        right: calendarPeriodLiteral(1, "w"),
      }).type,
    ).toEqual({ kind: "calendar-period" });
    expect(infer(divide(slot("ms"), num())).type).toEqual({
      kind: "scalar",
      scalar: "number",
      unit: "ms",
    });
    expect(
      infer({
        kind: "text-concatenation",
        values: [slot("str"), str(null)],
      }),
    ).toEqual({ type: { kind: "scalar", scalar: "string" }, nullable: true });
  });
});
