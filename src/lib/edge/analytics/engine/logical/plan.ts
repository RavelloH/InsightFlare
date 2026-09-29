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

declare const validatedLogicalPlan: unique symbol;
export type ValidatedLogicalPlan = LogicalPlan & {
  readonly [validatedLogicalPlan]: true;
};

export function assertNever(value: never): never {
  throw new Error(`Unexpected logical plan value: ${String(value)}`);
}
