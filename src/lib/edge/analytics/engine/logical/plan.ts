import type { QueryOperation } from "@/lib/edge/analytics/contract/types";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type { LogicalSlot } from "@/lib/edge/analytics/engine/logical/slots";
import type { SemanticDimensionId } from "@/lib/edge/analytics/engine/semantic/dimensions";
import type { ResolvedAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import type { SemanticMetricId } from "@/lib/edge/analytics/engine/semantic/metrics";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import type { SemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

export type { SemanticSubjectDomain, SemanticTemporalDomains };
export type { ResolvedAnalyticsScope };

export interface LogicalPlanContext {
  readonly subject: SemanticSubjectDomain;
  readonly time: SemanticTemporalDomains;
  readonly scope: ResolvedAnalyticsScope;
  readonly originOperation?: QueryOperation;
}

export interface LogicalOutputField {
  readonly name: string;
  readonly slot: SlotId;
  readonly semantic?:
    | { readonly kind: "metric"; readonly id: SemanticMetricId }
    | { readonly kind: "dimension"; readonly id: SemanticDimensionId };
}

export interface LogicalOutput {
  readonly id: string;
  readonly relation: RelationId;
  readonly fields: readonly LogicalOutputField[];
}

export interface LogicalPlan {
  readonly version: 1;
  readonly context: LogicalPlanContext;
  readonly slots: readonly LogicalSlot[];
  readonly nodes: readonly LogicalNode[];
  readonly outputs: readonly LogicalOutput[];
}

/**
 * Makes a detached, deeply frozen snapshot of an untrusted Logical plan.
 * Logical plans are data records; accessors, class instances, symbols, and
 * cyclic object graphs are deliberately rejected at this boundary.
 */
export function snapshotLogicalPlan(plan: LogicalPlan): LogicalPlan {
  const active = new WeakSet<object>();
  const copies = new WeakMap<object, object>();

  const clone = (value: unknown): unknown => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value !== "object")
      throw new Error("logical_plan_unsupported_snapshot_value");
    if (active.has(value)) throw new Error("logical_plan_cyclic_snapshot");
    const copied = copies.get(value);
    if (copied) return copied;

    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    )
      throw new Error("logical_plan_unsupported_snapshot_value");

    active.add(value);
    const output: object = isArray ? [] : Object.create(prototype);
    copies.set(value, output);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string")
        throw new Error("logical_plan_unsupported_snapshot_value");
      if (isArray && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor))
        throw new Error("logical_plan_unsupported_snapshot_value");
      Object.defineProperty(output, key, {
        value: clone(descriptor.value),
        enumerable: descriptor.enumerable,
        configurable: false,
        writable: false,
      });
    }
    active.delete(value);
    return Object.freeze(output);
  };

  try {
    return clone(plan) as LogicalPlan;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("logical_plan_unsupported_snapshot_value");
  }
}

declare const validatedLogicalPlan: unique symbol;
export type ValidatedLogicalPlan = LogicalPlan & {
  readonly [validatedLogicalPlan]: true;
};

export function assertNever(value: never): never {
  throw new Error(`Unexpected logical plan value: ${String(value)}`);
}
