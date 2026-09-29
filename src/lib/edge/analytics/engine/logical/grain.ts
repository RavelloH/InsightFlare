import type { SlotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { AnalyticsEntityKind } from "@/lib/edge/analytics/engine/semantic/entities";

export type LogicalGrain =
  | {
      readonly kind: "entity";
      readonly entity: AnalyticsEntityKind;
      readonly key: SlotId;
    }
  | { readonly kind: "keyed"; readonly keys: readonly SlotId[] }
  | { readonly kind: "scalar" };

export function grainKeys(grain: LogicalGrain): readonly SlotId[] {
  if (grain.kind === "entity") return [grain.key];
  if (grain.kind === "keyed") return grain.keys;
  return [];
}

export function remapGrain(
  grain: LogicalGrain,
  mapping: ReadonlyMap<SlotId, SlotId>,
): LogicalGrain {
  if (grain.kind === "scalar") return { kind: "scalar" };
  if (grain.kind === "entity") {
    const key = mapping.get(grain.key);
    if (key === undefined) throw new Error("logical_grain_key_not_mapped");
    return { kind: "entity", entity: grain.entity, key };
  }
  const keys = grain.keys.map((source) => {
    const output = mapping.get(source);
    if (output === undefined) throw new Error("logical_grain_key_not_mapped");
    return output;
  });
  return { kind: "keyed", keys };
}

export function sameGrainShape(
  left: LogicalGrain,
  right: LogicalGrain,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "scalar" && right.kind === "scalar") return true;
  if (left.kind === "entity" && right.kind === "entity") {
    return left.entity === right.entity;
  }
  return (
    left.kind === "keyed" &&
    right.kind === "keyed" &&
    left.keys.length === right.keys.length
  );
}
