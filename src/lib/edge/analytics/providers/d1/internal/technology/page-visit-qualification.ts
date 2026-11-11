import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  bindPageVisitQualificationPreparation,
  pageVisitQualificationConsumerKey,
  type PageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export type TechnologyPageVisitConsumer =
  "cross" | "browser-cross" | "radar" | "share-trend";

export interface TechnologyPageVisitQualification {
  readonly preparation: PageVisitQualificationPreparation;
  /** Exact QueryTime used by the existing compatibility reader. */
  readonly queryTime: QueryTime;
  /** Exact QueryTime sealed by the Core preparation (may differ in nonsemantic request identity). */
  readonly preparationQueryTime?: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
}

export function technologyPageVisitQualificationConsumerKey(
  consumer: TechnologyPageVisitConsumer,
  configuration: unknown,
) {
  return pageVisitQualificationConsumerKey(
    `technology-${consumer}`,
    configuration,
  );
}

/** Freeze an owner-built plan, then attach its exact request-local Page relation. */
export function bindTechnologyPageVisitQualification(input: {
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly qualification: TechnologyPageVisitQualification | undefined;
  readonly plan: ValidatedLogicalPlan;
}): {
  readonly plan: ValidatedLogicalPlan;
  readonly executionInputs:
    ReturnType<typeof bindPageVisitQualificationPreparation> | undefined;
} {
  if (!input.qualification)
    return { plan: input.plan, executionInputs: undefined };
  const plan = snapshotPageVisitQualificationPlan(input.plan);
  const executionInputs = bindPageVisitQualificationPreparation({
    preparation: input.qualification.preparation,
    siteId: input.siteId,
    filters: input.filters,
    queryTime:
      input.qualification.preparationQueryTime ?? input.qualification.queryTime,
    scopePlan: input.qualification.scopePlan,
    consumerKey: input.qualification.consumerKey,
    plan,
  });
  return { plan, executionInputs };
}
