import type {
  EpochMs,
  QueryWindow,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

export type JourneyTargetIdentity =
  | { readonly type: "visitor"; readonly value: string }
  | { readonly type: "session"; readonly value: string };

/** A typed semantic existence read over the bounded Page/Event Observation bag. */
export function buildJourneyTargetPresencePlan(input: {
  readonly siteId: string;
  readonly target: JourneyTargetIdentity;
  readonly window: QueryWindow;
}): ValidatedLogicalPlan {
  if (!input.target || typeof input.target.value !== "string")
    throw new Error("journey_target_presence_invalid_target");

  const attribute = (() => {
    switch (input.target.type) {
      case "visitor":
        return "observation.visitorId" as const;
      case "session":
        return "observation.sessionId" as const;
      default:
        throw new Error("journey_target_presence_unsupported_target");
    }
  })();
  const range = {
    startMs: input.window.startMs as EpochMs,
    endExclusiveMs: input.window.endExclusiveMs as EpochMs,
  };
  const builder = new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [input.siteId as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate: range,
      read: { kind: "bounded", range },
      reportingTimeZone: input.window.timeZone as ReportingTimeZone,
      capturedAtMs: input.window.nowMs as EpochMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });

  const observations = builder.source("observation", {
    temporalDomain: "candidate",
    attributes: [attribute],
  });
  const identity = builder.slot(observations, `attribute:${attribute}`);
  const target = builder.literal(input.target.value, {
    kind: "scalar",
    scalar: "string",
  });
  const matching = builder.filter(
    observations,
    builder.compare("eq", identity, target),
  );
  const presence = builder.project(matching, {
    present: builder.literal(1, { kind: "scalar", scalar: "number" }),
  });
  const first = builder.limit(presence, 1);
  builder.output("journey-target-presence", first, [
    { name: "present", slot: "present" },
  ]);
  return builder.finish();
}
