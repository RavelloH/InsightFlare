import type {
  CalendarGranularity,
  ReportingTimeZone,
} from "@/lib/edge/analytics/contract/types";
import type { SlotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import type { SemanticPageDimensionId } from "@/lib/edge/analytics/engine/semantic/page-dimensions";
import type {
  CalendarPeriodUnit,
  ElapsedDurationUnit,
  LogicalValueType,
  SemanticScalarType,
} from "@/lib/edge/analytics/engine/semantic/value-types";

export type LogicalLiteralValue = string | number | boolean | null;
export type LogicalStringNormalization =
  "trim" | "trim-case-fold" | "trim-ascii-space" | "ascii-case-fold";

export interface LogicalSlotExpression {
  readonly kind: "slot";
  readonly slot: SlotId;
}

export interface LogicalLiteralExpression {
  readonly kind: "literal";
  readonly value: LogicalLiteralValue;
  readonly valueType: Extract<LogicalValueType, { readonly kind: "scalar" }>;
}

export interface LogicalElapsedDurationLiteralExpression {
  readonly kind: "elapsed-duration-literal";
  readonly amount: number;
  readonly unit: ElapsedDurationUnit;
}

export interface LogicalCalendarPeriodLiteralExpression {
  readonly kind: "calendar-period-literal";
  readonly amount: number;
  readonly unit: CalendarPeriodUnit;
}

export interface LogicalComparisonExpression {
  readonly kind: "comparison";
  readonly operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  readonly left: LogicalExpr;
  readonly right: LogicalExpr;
  /** Storage-independent Filter v1 string comparison semantics. */
  readonly stringNormalization?: LogicalStringNormalization;
}

export interface LogicalBooleanExpression {
  readonly kind: "boolean";
  readonly operator: "and" | "or";
  readonly terms: readonly LogicalExpr[];
}

export interface LogicalNotExpression {
  readonly kind: "not";
  readonly input: LogicalExpr;
}

export interface LogicalNullTestExpression {
  readonly kind: "null-test";
  readonly input: LogicalExpr;
  readonly negated: boolean;
}

export interface LogicalSetMembershipExpression {
  readonly kind: "set-membership";
  readonly input: LogicalExpr;
  readonly values: readonly LogicalLiteralExpression[];
  readonly negated: boolean;
  /** Storage-independent Filter v1 string comparison semantics. */
  readonly stringNormalization?: LogicalStringNormalization;
}

export interface LogicalStringMatchExpression {
  readonly kind: "string-match";
  readonly operator: "contains" | "starts-with" | "ends-with";
  readonly input: LogicalExpr;
  readonly value: string;
  readonly caseSensitive: boolean;
  readonly semantics?: "legacy-record-search-v1" | "legacy-report-search-v1";
  /** Storage-independent Filter v1 string normalization semantics. */
  readonly stringNormalization?: LogicalStringNormalization;
}

export interface LogicalStringNormalizeExpression {
  readonly kind: "string-normalize";
  readonly input: LogicalExpr;
  readonly normalization: "trim" | "trim-ascii-space";
}

export interface LogicalNumberReportTextExpression {
  readonly kind: "number-report-text";
  readonly input: LogicalExpr;
  readonly semantics: "legacy-report-number-v1";
}

/** Ordered scalar text concatenation; NULL propagates unless callers coalesce it. */
export interface LogicalTextConcatenationExpression {
  readonly kind: "text-concatenation";
  readonly values: readonly LogicalExpr[];
}

export interface LogicalPageDimensionExpression {
  readonly kind: "page-dimension";
  readonly dimension: SemanticPageDimensionId;
  readonly dependencies: readonly {
    readonly attribute: SemanticAttributeId;
    readonly expression: LogicalExpr;
  }[];
}

export interface LogicalArithmeticExpression {
  readonly kind: "arithmetic";
  readonly operator: "add" | "subtract" | "multiply" | "divide";
  readonly left: LogicalExpr;
  readonly right: LogicalExpr;
  /** Division makes undefined ratios null instead of inventing a numeric value. */
  readonly zeroDenominator?: "null";
}

/**
 * Coerce a number to IEEE-754 binary64 (SQLite REAL), erase its unit without
 * unit scaling, and preserve negative values and NULLs.
 */
export interface LogicalNumericValueExpression {
  readonly kind: "numeric-value";
  readonly input: LogicalExpr;
}

export interface LogicalRoundExpression {
  readonly kind: "round";
  readonly input: LogicalExpr;
  /** Fixed decimal precision; omitted precision keeps SQLite's one-argument form. */
  readonly decimalPlaces?: number;
}

export interface LogicalAbsoluteExpression {
  readonly kind: "absolute";
  readonly input: LogicalExpr;
}

export interface LogicalCoalesceExpression {
  readonly kind: "coalesce";
  readonly values: readonly LogicalExpr[];
}

export interface LogicalCaseExpression {
  readonly kind: "case";
  readonly branches: readonly {
    readonly when: LogicalExpr;
    readonly then: LogicalExpr;
  }[];
  readonly otherwise: LogicalExpr;
}

export interface TimeBucketExpr {
  readonly kind: "time-bucket";
  readonly input: LogicalExpr;
  readonly granularity: CalendarGranularity;
  readonly reportingTimeZone: ReportingTimeZone;
}

export interface BucketIndexExpr {
  readonly kind: "bucket-index";
  readonly input: LogicalExpr;
}

export type LogicalExpr =
  | LogicalSlotExpression
  | LogicalLiteralExpression
  | LogicalElapsedDurationLiteralExpression
  | LogicalCalendarPeriodLiteralExpression
  | LogicalComparisonExpression
  | LogicalBooleanExpression
  | LogicalNotExpression
  | LogicalNullTestExpression
  | LogicalSetMembershipExpression
  | LogicalStringMatchExpression
  | LogicalStringNormalizeExpression
  | LogicalNumberReportTextExpression
  | LogicalTextConcatenationExpression
  | LogicalPageDimensionExpression
  | LogicalArithmeticExpression
  | LogicalNumericValueExpression
  | LogicalAbsoluteExpression
  | LogicalRoundExpression
  | LogicalCoalesceExpression
  | LogicalCaseExpression
  | TimeBucketExpr
  | BucketIndexExpr;

export function scalarLiteral(
  value: LogicalLiteralValue,
  scalar: SemanticScalarType,
  unit?: "ms" | "px" | "ratio",
): LogicalLiteralExpression {
  return {
    kind: "literal",
    value,
    valueType: {
      kind: "scalar",
      scalar,
      ...(unit ? { unit } : {}),
    },
  };
}

export function elapsedDurationLiteral(
  amount: number,
  unit: ElapsedDurationUnit,
): LogicalElapsedDurationLiteralExpression {
  return {
    kind: "elapsed-duration-literal",
    amount: Object.is(amount, -0) ? 0 : amount,
    unit,
  };
}

export function calendarPeriodLiteral(
  amount: number,
  unit: CalendarPeriodUnit,
): LogicalCalendarPeriodLiteralExpression {
  return {
    kind: "calendar-period-literal",
    amount: Object.is(amount, -0) ? 0 : amount,
    unit,
  };
}
