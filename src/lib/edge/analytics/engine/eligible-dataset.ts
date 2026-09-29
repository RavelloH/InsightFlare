import type { LogicalRelationHandle } from "./logical/builder";
import type {
  AnalyticsEntityKind,
  LogicalFilterScope,
} from "./semantic/entities";
import type { MetricTimeGroupingPolicy } from "./semantic/metrics";
import type { SemanticSubjectDomain } from "./semantic/subject";
import type { PlannedGrouping } from "./grouping";

export type EligibleDatasetScope =
  | { readonly kind: "unfiltered" }
  | {
      readonly kind: "matching";
      readonly target: LogicalFilterScope;
      readonly relation: LogicalRelationHandle;
      readonly entitySlotName: string;
    };

export interface EligibleDatasetResolver {
  readonly subject: SemanticSubjectDomain;
  readonly scope: EligibleDatasetScope;
  relation(entity: AnalyticsEntityKind): LogicalRelationHandle;
  association(
    entity: AnalyticsEntityKind,
    grouping: PlannedGrouping,
    timeGroupingPolicy?: MetricTimeGroupingPolicy,
  ): LogicalRelationHandle;
}

export interface EligibleDatasetCallbacks {
  readonly subject: SemanticSubjectDomain;
  readonly scope: EligibleDatasetScope;
  readonly resolveRelation: (
    entity: AnalyticsEntityKind,
  ) => LogicalRelationHandle;
  readonly resolveAssociation: (
    entity: AnalyticsEntityKind,
    grouping: PlannedGrouping,
    timeGroupingPolicy?: MetricTimeGroupingPolicy,
  ) => LogicalRelationHandle;
}

/** Lazy memoization only; this resolver contributes no dedicated plan nodes. */
export class LazyEligibleDataset implements EligibleDatasetResolver {
  readonly subject: SemanticSubjectDomain;
  readonly scope: EligibleDatasetScope;
  readonly #resolveRelation: EligibleDatasetCallbacks["resolveRelation"];
  readonly #resolveAssociation: EligibleDatasetCallbacks["resolveAssociation"];
  readonly #relations = new Map<AnalyticsEntityKind, LogicalRelationHandle>();
  readonly #associations = new Map<string, LogicalRelationHandle>();

  constructor(callbacks: EligibleDatasetCallbacks) {
    this.subject = callbacks.subject;
    this.scope = callbacks.scope;
    this.#resolveRelation = callbacks.resolveRelation;
    this.#resolveAssociation = callbacks.resolveAssociation;
  }

  relation(entity: AnalyticsEntityKind): LogicalRelationHandle {
    const cached = this.#relations.get(entity);
    if (cached) return cached;
    const resolved = this.#resolveRelation(entity);
    this.#relations.set(entity, resolved);
    return resolved;
  }

  association(
    entity: AnalyticsEntityKind,
    grouping: PlannedGrouping,
    timeGroupingPolicy?: MetricTimeGroupingPolicy,
  ): LogicalRelationHandle {
    const key = [
      entity,
      grouping.spine.id,
      [...grouping.dimensions.keys()].sort().join(","),
      grouping.timeBucket?.granularity ?? "no-time-bucket",
      timeGroupingPolicy ?? "no-metric-time-policy",
    ].join(":");
    const cached = this.#associations.get(key);
    if (cached) return cached;
    const resolved = this.#resolveAssociation(
      entity,
      grouping,
      timeGroupingPolicy,
    );
    this.#associations.set(key, resolved);
    return resolved;
  }
}
