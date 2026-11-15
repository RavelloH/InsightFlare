import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import { buildCanonicalPageReaderPlan } from "@/lib/edge/analytics/engine/canonical-page-reader-plan";
import {
  snapshotLogicalPlan,
  type ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import {
  type PageReaderConsumer,
  pageReaderProfile,
} from "@/lib/edge/analytics/engine/page-membership-reader-catalog";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import {
  createSemanticSubjectDomain,
  sameSemanticSubjectDomain,
} from "@/lib/edge/analytics/engine/semantic/subject";
import { WHOLE_MEMBERSHIP_OUTPUT } from "@/lib/edge/analytics/engine/whole-membership-stage-plan";
import { requireWholeMembershipStage } from "@/lib/edge/analytics/engine/whole-membership-stage-transition";
import type { FilterDocument } from "@/lib/filter-contract/filters";

/** Canonical finite reader construction at the original builder checkpoint.
 * This edge is descriptive. Only the authenticated invocation can attach its
 * own completed relation to this exact plan. No caller-supplied slot budget. */
export function buildPageMembershipSuccessor(input: {
  readonly predecessor: ValidatedLogicalPlan;
  readonly consumer: PageReaderConsumer | undefined;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
}) {
  const producer = requireWholeMembershipStage(input.predecessor);
  const selected = input.consumer && pageReaderProfile(input.consumer);
  if (
    producer.profile !== "page-role-single-site-entity-v1" ||
    !input.consumer ||
    !selected ||
    selected.stage !== "request" ||
    selected.sourceRoles.length !== 1 ||
    selected.sourceRoles[0] !== "page" ||
    input.scopePlan.mode !== "entity" ||
    input.scopePlan.scope !== producer.executionScope ||
    input.scopePlan.preparedMembership !== undefined ||
    input.predecessor.context.subject.siteIds[0] !== input.siteId
  )
    throw new Error("page_membership_predecessor_context_mismatch");
  const successor = validateLogicalPlan(
    snapshotLogicalPlan(
      buildCanonicalPageReaderPlan(input.consumer, {
        siteId: input.siteId,
        filters: input.filters,
        queryTime: input.queryTime,
        scopePlan: input.scopePlan,
        qualificationSemantics: "whole-original",
        qualificationDependencyRefs: [
          EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
        ],
      }),
    ),
  );
  const expected = createSemanticSubjectDomain({
    origin: "site",
    siteIds: input.predecessor.context.subject.siteIds,
  });
  const sources = successor.nodes.filter((node) => node.kind === "source");
  const source = sources[0];
  if (
    !sameSemanticSubjectDomain(successor.context.subject, expected) ||
    sources.length !== 1 ||
    source?.entity !== "page" ||
    source.selection?.mode !== "entity" ||
    source.selection.scope !== producer.executionScope ||
    source.selection.preparedMembership !== undefined ||
    source.selection.qualificationDependencyRefs?.length !== 1 ||
    source.selection.qualificationDependencyRefs[0] !==
      EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY ||
    successor.outputs.length !== selected.planOutputIds.length ||
    successor.outputs.some(
      (output, index) => output.id !== selected.planOutputIds[index],
    )
  )
    throw new Error("page_membership_successor_contract_mismatch");
  return Object.freeze({
    kind: "page-whole-membership-predecessor-v1" as const,
    predecessor: input.predecessor,
    predecessorOutput: WHOLE_MEMBERSHIP_OUTPUT,
    successor,
    dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  });
}
