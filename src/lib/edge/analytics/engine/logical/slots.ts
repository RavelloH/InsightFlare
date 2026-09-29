import type { SlotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import type { AnalyticsEntityKind } from "@/lib/edge/analytics/engine/semantic/entities";
import type { SemanticMetricId } from "@/lib/edge/analytics/engine/semantic/metrics";
import type { SemanticRelationshipId } from "@/lib/edge/analytics/engine/semantic/relationships";
import type { LogicalValueType } from "@/lib/edge/analytics/engine/semantic/value-types";

export type { LogicalValueType } from "@/lib/edge/analytics/engine/semantic/value-types";

export interface LogicalSlot {
  readonly id: SlotId;
  readonly type: LogicalValueType;
  readonly nullable: boolean;
  readonly lineage: SlotLineage;
}

export type SlotLineage =
  | { readonly kind: "entity"; readonly entity: AnalyticsEntityKind }
  | {
      readonly kind: "relationship";
      readonly relationship: SemanticRelationshipId;
    }
  | { readonly kind: "attribute"; readonly attribute: SemanticAttributeId }
  | { readonly kind: "metric"; readonly metric: SemanticMetricId }
  | { readonly kind: "alias"; readonly source: SlotId }
  | {
      readonly kind: "derived";
      readonly operation: string;
      readonly inputs: readonly SlotId[];
    };

export function entityValueType(entity: AnalyticsEntityKind): LogicalValueType {
  return { kind: "entity", entity };
}

export function isSameLogicalValueType(
  left: LogicalValueType,
  right: LogicalValueType,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "entity" && right.kind === "entity") {
    return left.entity === right.entity;
  }
  if (left.kind === "bucket" && right.kind === "bucket") return true;
  if (left.kind === "scalar" && right.kind === "scalar") {
    return left.scalar === right.scalar && left.unit === right.unit;
  }
  return false;
}
