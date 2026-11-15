import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import {
  buildOverviewChannelsPlan,
  OVERVIEW_CHANNELS_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import {
  snapshotLogicalPlan,
  type ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import {
  createSemanticSubjectDomain,
  sameSemanticSubjectDomain,
} from "@/lib/edge/analytics/engine/semantic/subject";
import { WHOLE_MEMBERSHIP_OUTPUT } from "@/lib/edge/analytics/engine/whole-membership-stage-plan";
import { requireWholeMembershipStage } from "@/lib/edge/analytics/engine/whole-membership-stage-transition";
import type { FilterDocument } from "@/lib/filter-contract/filters";

/** An explicit edge between two already validated logical stages. This object
 * has no matches/relation/Env and grants no authority to execute storage. The
 * invocation's physical frame must connect its own actually completed output. */
export interface ChannelsMembershipPredecessorEdge {
  readonly kind: "channels-whole-membership-predecessor-v1";
  readonly predecessor: ValidatedLogicalPlan;
  readonly predecessorOutput: typeof WHOLE_MEMBERSHIP_OUTPUT;
  readonly successor: ValidatedLogicalPlan;
  readonly successorOutput: typeof OVERVIEW_CHANNELS_REPORT_OUTPUT;
  readonly dependencyRef: typeof EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY;
}

/** Call only at queryChannelsFromD1's existing canonical-builder checkpoint.
 * Stage 0 must not call this function or receive a callback that can call it.
 * The runtime's authenticated deferred input supplies these captured values;
 * a reader tag alone never authorizes this function or the later physical bind. */
export function buildChannelsMembershipSuccessor(input: {
  readonly predecessor: ValidatedLogicalPlan;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly limit: number;
}): ChannelsMembershipPredecessorEdge {
  const producer = requireWholeMembershipStage(input.predecessor);
  // Do not reinterpret unsupported observation, cross-site or old-ID carriers.
  if (
    input.scopePlan.mode !== "entity" ||
    input.scopePlan.scope !== producer.executionScope ||
    input.scopePlan.preparedMembership !== undefined ||
    input.predecessor.context.subject.siteIds[0] !== input.siteId
  )
    throw new Error("channels_membership_predecessor_context_mismatch");
  const successor = validateLogicalPlan(
    snapshotLogicalPlan(
      buildOverviewChannelsPlan({
        siteId: input.siteId,
        filters: input.filters,
        queryTime: input.queryTime,
        scopePlan: input.scopePlan,
        limit: input.limit,
        qualificationSemantics: "whole-original",
        qualificationDependencyRefs: [
          EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
        ],
      }),
    ),
  );
  // The canonical site reader deliberately omits authorization-only teamId;
  // its exact site must still be inside the already authenticated predecessor.
  const readerDomain = createSemanticSubjectDomain({
    origin: "site",
    siteIds: input.predecessor.context.subject.siteIds,
  });
  if (!sameSemanticSubjectDomain(successor.context.subject, readerDomain))
    throw new Error("channels_membership_successor_subject_mismatch");
  const sources = successor.nodes.filter((node) => node.kind === "source");
  const source = sources[0];
  if (
    sources.length !== 1 ||
    source?.entity !== "page" ||
    source.selection?.mode !== "entity" ||
    source.selection.scope !== producer.executionScope ||
    source.selection.preparedMembership !== undefined ||
    source.selection.qualificationDependencyRefs?.length !== 1 ||
    source.selection.qualificationDependencyRefs[0] !==
      EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY ||
    successor.outputs.length !== 1 ||
    successor.outputs[0].id !== OVERVIEW_CHANNELS_REPORT_OUTPUT
  )
    throw new Error("channels_membership_successor_contract_mismatch");
  return Object.freeze({
    kind: "channels-whole-membership-predecessor-v1",
    predecessor: input.predecessor,
    predecessorOutput: WHOLE_MEMBERSHIP_OUTPUT,
    successor,
    successorOutput: OVERVIEW_CHANNELS_REPORT_OUTPUT,
    dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  });
}
