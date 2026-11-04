import { D1_MAX_BOUND_PARAMETERS } from "@/lib/db/d1-budget";
import type { DatabaseBinding } from "@/lib/db/types";

import type { PhysicalParameterSlotLayout } from "./contracts";

function reusableBindingKey(value: DatabaseBinding): string | undefined {
  if (value === null) return "null:";
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "boolean") return `boolean:${value ? "1" : "0"}`;
  if (typeof value === "number" && Number.isFinite(value))
    return `number:${Object.is(value, -0) ? "-0" : String(value)}`;
  return undefined;
}

/** Reuse only safe primitive values, and only when the original exceeds D1's cap. */
export function optimizePhysicalParameterSlots(
  bindings: readonly DatabaseBinding[],
): PhysicalParameterSlotLayout | undefined {
  if (bindings.length <= D1_MAX_BOUND_PARAMETERS) return undefined;

  const slotsByKey = new Map<string, number>();
  const occurrenceSlots: number[] = [];
  const uniqueBindings: DatabaseBinding[] = [];
  for (const binding of bindings) {
    const key = reusableBindingKey(binding);
    const existing = key === undefined ? undefined : slotsByKey.get(key);
    if (existing !== undefined) {
      occurrenceSlots.push(existing);
      continue;
    }

    const slot = uniqueBindings.length + 1;
    uniqueBindings.push(binding);
    occurrenceSlots.push(slot);
    if (key !== undefined) slotsByKey.set(key, slot);
  }
  if (uniqueBindings.length >= bindings.length) return undefined;
  return {
    strategy: "numbered-reuse",
    occurrenceCount: bindings.length,
    slotCount: uniqueBindings.length,
    occurrenceSlots,
    bindings: uniqueBindings,
  };
}
