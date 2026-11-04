import type { FunnelConfigV2 } from "@/lib/edge/analytics/contract";
import {
  appendFunnelProgressionRelations,
  type FunnelProgressionSourceSelections,
} from "@/lib/edge/analytics/engine/funnel-progression-report-plan";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";

export interface JourneyFunnelListQualificationInput {
  readonly builder: LogicalPlanBuilder;
  readonly sources: FunnelProgressionSourceSelections;
  readonly config: FunnelConfigV2;
  readonly stepIndex: number;
  readonly outcome?: "converted" | "dropoff";
  readonly countMatches: LogicalRelationHandle;
  readonly siteId: string;
  readonly countScope: "visitor" | "session";
  readonly preparedPlanOperation: "visitors" | "sessions";
  readonly reportPages: LogicalRelationHandle;
  readonly reportEvents: LogicalRelationHandle;
}

/** Restricts list observations to Count-qualified Funnel outcome identities. */
export function appendJourneyFunnelListQualification(
  input: JourneyFunnelListQualificationInput,
): {
  readonly pages: LogicalRelationHandle;
  readonly events: LogicalRelationHandle;
} {
  const listScope =
    input.preparedPlanOperation === "visitors" ? "visitor" : "session";
  if (input.config.progressionScope !== listScope)
    throw new Error("journey_funnel_list_qualification_scope_mismatch");

  const progression = appendFunnelProgressionRelations({
    builder: input.builder,
    sources: input.sources,
    config: input.config,
    throughStepIndex: input.stepIndex,
    preparedPlanOperation: input.preparedPlanOperation,
    qualificationMembership: {
      matches: input.countMatches,
      siteId: input.siteId,
      countScope: input.countScope,
    },
  });
  const reached = progression.reachedSteps[input.stepIndex];
  if (!reached) throw new Error("funnel_step_not_found");
  const membership =
    input.outcome === "dropoff"
      ? input.stepIndex === 0
        ? input.builder.filter(
            reached,
            input.builder.literal(false, { kind: "scalar", scalar: "boolean" }),
          )
        : input.builder.antiJoin(
            progression.reachedSteps[input.stepIndex - 1]!,
            reached,
            [{ left: "identity", right: "identity" }],
          )
      : reached;

  const pageIdentity =
    input.config.progressionScope === "visitor"
      ? "attribute:page.report.visitorId"
      : "attribute:page.report.sessionId";
  const eventIdentity =
    input.config.progressionScope === "visitor"
      ? "attribute:event.report.ownerVisitorId"
      : "attribute:event.report.ownerSessionId";
  return {
    pages: input.builder.semiJoin(input.reportPages, membership, [
      { left: pageIdentity, right: "identity" },
    ]),
    events: input.builder.semiJoin(input.reportEvents, membership, [
      { left: eventIdentity, right: "identity" },
    ]),
  };
}
