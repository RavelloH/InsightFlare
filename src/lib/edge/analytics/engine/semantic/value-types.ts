import type { FilterScalarType } from "@/lib/filter-contract/filter-types";

import type { AnalyticsEntityKind } from "./entities";

export type SemanticScalarType = FilterScalarType;
export type SemanticUnit = "ms" | "px" | "ratio";

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

export type LogicalValueType =
  | SemanticScalarValueType
  | SemanticEntityValueType<AnalyticsEntityKind>
  | SemanticBucketValueType;
