import type {
  CalendarGranularity,
  ReportingTimeZone,
} from "@/lib/edge/analytics/contract/types";
import type { SlotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";
import type { SemanticScalarType } from "@/lib/edge/analytics/engine/semantic/value-types";

export type LogicalLiteralValue = string | number | boolean | null;

export interface LogicalSlotExpression {
  readonly kind: "slot";
  readonly slot: SlotId;
}

export interface LogicalLiteralExpression {
  readonly kind: "literal";
  readonly value: LogicalLiteralValue;
  readonly valueType: LogicalValueType;
}

export interface LogicalComparisonExpression {
  readonly kind: "comparison";
  readonly operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  readonly left: LogicalExpr;
  readonly right: LogicalExpr;
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
}

export interface LogicalStringMatchExpression {
  readonly kind: "string-match";
  readonly operator: "contains" | "starts-with" | "ends-with";
  readonly input: LogicalExpr;
  readonly value: string;
  readonly caseSensitive: boolean;
}

export interface LogicalArithmeticExpression {
  readonly kind: "arithmetic";
  readonly operator: "add" | "subtract" | "multiply" | "divide";
  readonly left: LogicalExpr;
  readonly right: LogicalExpr;
  /** Division makes undefined ratios null instead of inventing a numeric value. */
  readonly zeroDenominator?: "null";
}

export interface LogicalRoundExpression {
  readonly kind: "round";
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

export type LogicalExpr =
  | LogicalSlotExpression
  | LogicalLiteralExpression
  | LogicalComparisonExpression
  | LogicalBooleanExpression
  | LogicalNotExpression
  | LogicalNullTestExpression
  | LogicalSetMembershipExpression
  | LogicalStringMatchExpression
  | LogicalArithmeticExpression
  | LogicalRoundExpression
  | LogicalCoalesceExpression
  | LogicalCaseExpression
  | TimeBucketExpr;

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
