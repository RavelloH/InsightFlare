import type { QueryTime } from "@/lib/edge/analytics/contract";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";

/** Closed-catalog values only. None of these types grants request authority. */
export type WholeFilterPreparationKey = "original" | "current" | "reference";

/** One actual Source occurrence in the canonical child plan. Repeated roles
 * remain separate occurrences; this is not a caller-supplied fanout allowance. */
export interface ExactMembershipSourceUse {
  readonly entity: "page" | "event";
  readonly dependencyRef: QualificationDependencyRef;
}

/** A canonical reader may have multiple outputs in the same frozen plan.
 * readerKey groups that single binding; output count must not widen plan reuse.
 * The provider still validates the exact output/plan identity and full context. */
export interface ExactOutputDescriptor {
  readonly key: string;
  readonly readerKey: string;
  readonly preparationKey: WholeFilterPreparationKey;
  readonly outputId: string;
  readonly queryTime: QueryTime;
  readonly sources: readonly ExactMembershipSourceUse[];
}
