import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  type QualificationDependencyRef,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

import {
  type DeferredEventQualificationOperation,
  prepareDeferredEventMembershipQualification,
} from "./advanced-filter-execution";
import {
  bindPageVisitQualificationPreparation,
  pageVisitQualificationConsumerKey,
  snapshotPageVisitQualificationPlan,
} from "./page-visit-qualification-execution";
import type { QualificationExecutionInputs } from "./qualification-execution-inputs";

export interface EventMembershipReportContext {
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly qualificationDependencyRefs: readonly QualificationDependencyRef[];
}

export interface EventMembershipFallbackPlan {
  readonly plan: ValidatedLogicalPlan;
  readonly executionInputs: QualificationExecutionInputs;
}

/**
 * Event report owners call this after native SQL refused a request. It
 * evaluates the existing Core filter once into a request-private Event
 * membership relation, lets the owner build its complete canonical plan with
 * the semantic dependency, freezes that exact plan and binds the relation to
 * it once. It returns undefined (before any Core evaluation) for any request
 * outside the private, single-site, same-window slice so that caller keeps its
 * complete existing fallback.
 */
export async function prepareEventMembershipFallbackPlan(input: {
  readonly deferred: unknown & {
    readonly siteId: string;
    readonly filters: FilterDocument;
    readonly time: QueryTime;
    readonly metadata: { readonly plan: ScopedFilterPlan };
  };
  readonly operations: readonly DeferredEventQualificationOperation[];
  readonly operation: string;
  /** Exact request configuration: limit, search, cursor, audience, ... */
  readonly configuration: unknown;
  readonly buildPlan: (
    context: EventMembershipReportContext,
  ) => ValidatedLogicalPlan;
}): Promise<EventMembershipFallbackPlan | undefined> {
  const { deferred } = input;
  const consumerKey = pageVisitQualificationConsumerKey(
    input.operation,
    input.configuration,
  );
  const preparation = await prepareDeferredEventMembershipQualification(
    deferred,
    consumerKey,
    input.operations,
  );
  if (!preparation) return undefined;
  const plan = snapshotPageVisitQualificationPlan(
    input.buildPlan({
      queryTime: deferred.time,
      scopePlan: deferred.metadata.plan,
      qualificationDependencyRefs: [EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY],
    }),
  );
  const executionInputs = bindPageVisitQualificationPreparation({
    preparation,
    siteId: deferred.siteId,
    filters: deferred.filters,
    queryTime: deferred.time,
    scopePlan: deferred.metadata.plan,
    consumerKey,
    plan,
  });
  return { plan, executionInputs };
}
