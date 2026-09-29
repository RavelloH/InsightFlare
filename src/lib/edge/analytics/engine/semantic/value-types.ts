import type { FilterScalarType } from "@/lib/filter-contract/filter-types";

import type { AnalyticsEntityKind } from "./entities";

/** Temporal amounts have dedicated logical kinds so their unit semantics cannot be erased. */
export type SemanticScalarType = Exclude<
  FilterScalarType,
  "duration" | "calendar-period"
>;
export type SemanticUnit = "ms" | "px" | "ratio";
export type ElapsedDurationUnit = "ms" | "s" | "m" | "h" | "d" | "w";
export type CalendarPeriodUnit = "d" | "w" | "mo" | "y";

export interface SemanticScalarValueType {
  readonly kind: "scalar";
  readonly scalar: SemanticScalarType;
  readonly unit?: SemanticUnit;
}

export interface SemanticEntityValueType<Entity extends string = string> {
  readonly kind: "entity";
  readonly entity: Entity;
}

export interface SemanticBucketValueType {
  readonly kind: "bucket";
}

export interface ElapsedDurationValueType {
  readonly kind: "duration";
}

export interface CalendarPeriodValueType {
  readonly kind: "calendar-period";
}

export type LogicalValueType =
  | SemanticScalarValueType
  | SemanticEntityValueType<AnalyticsEntityKind>
  | SemanticBucketValueType
  | ElapsedDurationValueType
  | CalendarPeriodValueType;
