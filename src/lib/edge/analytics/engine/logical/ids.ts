import type { Brand } from "@/lib/edge/analytics/contract/types";

export type RelationId = Brand<number, "LogicalRelationId">;
export type SlotId = Brand<number, "LogicalSlotId">;

export function relationId(value: number): RelationId {
  return value as RelationId;
}

export function slotId(value: number): SlotId {
  return value as SlotId;
}
