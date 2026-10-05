import {
  type EventPayloadValueTypeCode,
  eventPayloadValueTypeCode,
  eventPayloadValueTypeLabel,
} from "@/lib/edge/analytics/engine/semantic/event-payload-value-type";

export function normalizeFilterValue(value: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : undefined;
}

export function customEventJsonTypeLabel(valueType: number): string {
  return eventPayloadValueTypeLabel(valueType);
}

export function customEventJsonTypeCode(
  valueType: string,
): EventPayloadValueTypeCode | null {
  return eventPayloadValueTypeCode(valueType);
}
