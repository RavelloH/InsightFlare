import type { AdvancedCountQualificationFragment } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { RelationId } from "@/lib/edge/analytics/engine/logical/ids";

export interface QualificationPlanMetadata {
  readonly candidateGrain?: "event-candidate";
  readonly additionalGroupedSummaryRelationIds?: readonly RelationId[];
  readonly eventCandidateReportProjection?: "page-visits";
}

/** Copies only the shared qualification metadata proven by an Engine fragment. */
export function qualificationPlanMetadata<
  Scope extends "session" | "visitor" | "event",
>(
  qualification: AdvancedCountQualificationFragment<Scope>,
  eventCandidateReportProjection?: "page-visits",
): QualificationPlanMetadata {
  if (
    eventCandidateReportProjection !== undefined &&
    (qualification.scope !== "event" ||
      qualification.candidateGrain !== "event-candidate")
  )
    throw new Error("qualification_plan_candidate_projection_invalid");

  return {
    ...(qualification.candidateGrain
      ? { candidateGrain: qualification.candidateGrain }
      : {}),
    ...(qualification.additionalGroupedSummaries
      ? {
          additionalGroupedSummaryRelationIds:
            qualification.additionalGroupedSummaries.map(({ id }) => id),
        }
      : {}),
    ...(eventCandidateReportProjection
      ? { eventCandidateReportProjection }
      : {}),
  };
}
