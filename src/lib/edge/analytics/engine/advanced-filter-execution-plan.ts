import type { QueryTime } from "@/lib/edge/analytics/contract";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import {
  type AdvancedCountFilterSupport,
  classifyAdvancedCountFilter,
} from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import {
  type AdvancedFilterExecutionStrategy,
  advancedFilterLeafCapabilities,
  type AdvancedFilterLeafCapability,
} from "@/lib/edge/analytics/engine/advanced-filter-leaf-capabilities";
import {
  classifyTwoStepSequence,
  type SupportedSequence,
} from "@/lib/edge/analytics/engine/advanced-filter-sequence-support";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import type { SemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { FILTER_EVALUATOR_LIMITS } from "@/lib/filter-contract/filter-evaluator";
import type { FilterRelationScope } from "@/lib/filter-contract/filter-types";
import type { FilterDocument } from "@/lib/filter-contract/filters";
export type { AdvancedFilterExecutionStrategy } from "@/lib/edge/analytics/engine/advanced-filter-leaf-capabilities";

export interface AdvancedFilterMembershipDomain {
  readonly subject: SemanticSubjectDomain;
  readonly activityRoles: readonly ["page", "event"];
  /** IDs are always paired with their site and activity/entity role. */
  readonly identity: {
    readonly site: "siteId";
    readonly grain: "session" | "visitor" | "activity";
    readonly roles: readonly ("session" | "visitor" | "page" | "event")[];
  };
  readonly time: SemanticTemporalDomains;
  readonly expressionDomain: "candidate" | "filter";
}

export interface AdvancedFilterExecutionDecision {
  readonly strategy: AdvancedFilterExecutionStrategy;
  readonly permittedStrategies: readonly AdvancedFilterExecutionStrategy[];
  readonly reason: string;
  readonly leafCapabilities: readonly AdvancedFilterLeafCapability[];
  readonly wholeTreeProof: {
    readonly kind: AdvancedCountFilterSupport["kind"];
    readonly path: string;
    readonly code: string;
  };
  readonly membership: AdvancedFilterMembershipDomain;
  readonly coreBounds: {
    readonly maxActivities: number;
    readonly maxSequenceMatches: number;
    readonly maxSequenceWork: number;
  };
}

export interface AdvancedFilterExecutionPlan {
  readonly decision: AdvancedFilterExecutionDecision;
  /** Whole-tree proof, including relation domains and boolean shape. */
  readonly support: AdvancedCountFilterSupport;
  /** Independent whole-tree Seq proof; it does not grant Count eligibility. */
  readonly sequenceSupport?: SupportedSequence;
}

/**
 * Select among the existing builders. Capability, rather than an unmeasured
 * cost threshold, determines the choice. SQL runtime compatibility guards can
 * subsequently select the declared bounded Core fallback.
 */
export function planAdvancedFilterExecution(input: {
  readonly subject: SemanticSubjectDomain;
  readonly filters: FilterDocument;
  readonly scope: FilterRelationScope;
  readonly time: QueryTime;
  /** The caller has established report request/provenance eligibility. */
  readonly reportFusionAvailable: boolean;
  readonly allowPrivateQualifiedGeoBareFields?: true;
}): AdvancedFilterExecutionPlan {
  const time = input.time;
  const leafCapabilities = advancedFilterLeafCapabilities(input.filters);
  const leavesPermit = (strategy: AdvancedFilterExecutionStrategy) =>
    leafCapabilities.every((leaf) =>
      leaf.permittedStrategies.includes(strategy),
    );
  // Keep the existing caller's validation/error order. This describes its
  // domains; coverage and range availability remain execution preconditions.
  const domains: SemanticTemporalDomains = {
    candidate: time.range,
    ...(time.filterRange ? { filter: time.filterRange } : {}),
    read: time.fullHistory
      ? { kind: "retained-history" }
      : { kind: "bounded", range: time.readRange ?? time.range },
    reportingTimeZone: time.reportingTimeZone,
    capturedAtMs: time.capturedAtMs,
  };
  const options = input.allowPrivateQualifiedGeoBareFields
    ? { allowPrivateQualifiedGeoBareFields: true as const }
    : {};
  const support = classifyAdvancedCountFilter(input.filters, input.scope, {
    ...options,
    ...(time.filterRange !== undefined
      ? {
          timeLeafContext: {
            candidateRange: time.range,
            capturedAtMs: time.capturedAtMs,
          },
        }
      : {}),
  });
  // Existing fused builders have no independent expression window. Reprove
  // their exact capability without the membership time-leaf context.
  const readRange = time.readRange ?? time.range;
  const sameWindow =
    !time.fullHistory &&
    time.filterRange === undefined &&
    !time.filterRangeEmpty &&
    readRange.startMs === time.range.startMs &&
    readRange.endExclusiveMs === time.range.endExclusiveMs;
  const fusionSupport =
    input.reportFusionAvailable && sameWindow
      ? classifyAdvancedCountFilter(input.filters, input.scope, options)
      : undefined;
  const sequenceRelevant = leafCapabilities.some(
    (leaf) => leaf.family === "seq",
  );
  const sequenceProof = sequenceRelevant
    ? classifyTwoStepSequence(input.filters, input.scope, time)
    : undefined;
  const sequenceSupport =
    sequenceProof?.kind === "supported" && leavesPermit("sql-membership")
      ? sequenceProof
      : undefined;
  const strategy: AdvancedFilterExecutionStrategy =
    fusionSupport?.kind === "supported" && leavesPermit("sql-report-fusion")
      ? "sql-report-fusion"
      : (support.kind === "supported" && leavesPermit("sql-membership")) ||
          sequenceSupport !== undefined
        ? "sql-membership"
        : "bounded-core";
  const permittedStrategies: AdvancedFilterExecutionStrategy[] = [
    "bounded-core",
  ];
  if (
    (support.kind === "supported" && leavesPermit("sql-membership")) ||
    sequenceSupport !== undefined
  )
    permittedStrategies.unshift("sql-membership");
  if (fusionSupport?.kind === "supported" && leavesPermit("sql-report-fusion"))
    permittedStrategies.unshift("sql-report-fusion");
  return {
    ...(sequenceSupport ? { sequenceSupport } : {}),
    decision: {
      strategy,
      permittedStrategies,
      leafCapabilities,
      wholeTreeProof: {
        kind: sequenceProof?.kind ?? support.kind,
        path: sequenceProof
          ? sequenceProof.kind === "supported"
            ? "root"
            : sequenceProof.path
          : support.path,
        code: sequenceProof?.code ?? support.code,
      },
      reason:
        strategy === "sql-report-fusion"
          ? "whole-tree-report-fusion-supported"
          : sequenceProof
            ? sequenceSupport
              ? "whole-tree-sequence-membership-supported"
              : sequenceProof.code
            : support.kind === "unsupported"
              ? support.code
              : !sameWindow
                ? "independent-membership-time-domains"
                : input.reportFusionAvailable &&
                    fusionSupport?.kind === "unsupported"
                  ? fusionSupport.code
                  : "membership-builder-selected",
      membership: {
        subject: input.subject,
        activityRoles: ["page", "event"],
        identity: {
          site: "siteId",
          grain: input.scope === "event" ? "activity" : input.scope,
          roles: input.scope === "event" ? ["page", "event"] : [input.scope],
        },
        time: domains,
        expressionDomain:
          time.filterRange !== undefined ? "filter" : "candidate",
      },
      coreBounds: {
        maxActivities: ADVANCED_FILTER_MAX_ACTIVITIES,
        maxSequenceMatches: FILTER_EVALUATOR_LIMITS.maxSequenceMatches,
        maxSequenceWork: FILTER_EVALUATOR_LIMITS.maxSequenceWork,
      },
    },
    support: fusionSupport?.kind === "supported" ? fusionSupport : support,
  };
}
