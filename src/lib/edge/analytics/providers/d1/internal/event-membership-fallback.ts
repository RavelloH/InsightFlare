import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
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
  /** For Page Sources of the same plan; present only when requested. */
  readonly pageVisitDependencyRefs: readonly QualificationDependencyRef[];
}

export interface EventMembershipFallbackPlan {
  readonly plan: ValidatedLogicalPlan;
  readonly executionInputs: QualificationExecutionInputs;
}

/** One Core evaluation whose Event membership may be bound to the owner's plans. */
export interface EventMembershipFallback {
  /** Freeze and bind one more canonical plan the owner built for this request. */
  readonly bindPlan: (
    buildPlan: (context: EventMembershipReportContext) => ValidatedLogicalPlan,
  ) => EventMembershipFallbackPlan;
}

interface EventMembershipFallbackInput {
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
  /** The plan also reads Page visits (for example session-boundary cards). */
  readonly withPageVisits?: boolean;
}

/**
 * Event report owners call this after native SQL refused a request. It
 * evaluates the existing Core filter once into a request-private Event
 * membership relation. The owner then binds each complete canonical plan it
 * needs (usually one; dependent multi-read reports declare `maxPlans`), and
 * every plan is frozen and validated against the same request context. It
 * returns undefined (before any Core evaluation) for any request outside the
 * private, single-site, same-window slice so that caller keeps its complete
 * existing fallback.
 */
export async function prepareEventMembershipFallback(
  input: EventMembershipFallbackInput & {
    readonly maxPlans?: number;
    readonly maxSourcesPerRole?: number;
  },
): Promise<EventMembershipFallback | undefined> {
  const { deferred } = input;
  const consumerKey = pageVisitQualificationConsumerKey(
    input.operation,
    input.configuration,
  );
  const preparation = await prepareDeferredEventMembershipQualification(
    deferred,
    consumerKey,
    input.operations,
    {
      maxBindings: input.maxPlans ?? 1,
      ...(input.maxSourcesPerRole
        ? { maxSourcesPerRole: input.maxSourcesPerRole }
        : {}),
      ...(input.withPageVisits ? { withPageVisits: true } : {}),
    },
  );
  if (!preparation) return undefined;
  return {
    bindPlan: (buildPlan) => {
      const plan = snapshotPageVisitQualificationPlan(
        buildPlan({
          queryTime: deferred.time,
          scopePlan: deferred.metadata.plan,
          qualificationDependencyRefs: [
            EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
          ],
          pageVisitDependencyRefs: input.withPageVisits
            ? [EVENT_FILTER_PAGE_VISIT_DEPENDENCY]
            : [],
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
    },
  };
}

/** Single-plan convenience for owners whose fallback is one report plan. */
export async function prepareEventMembershipFallbackPlan(
  input: EventMembershipFallbackInput & {
    readonly buildPlan: (
      context: EventMembershipReportContext,
    ) => ValidatedLogicalPlan;
  },
): Promise<EventMembershipFallbackPlan | undefined> {
  const fallback = await prepareEventMembershipFallback(input);
  return fallback?.bindPlan(input.buildPlan);
}
