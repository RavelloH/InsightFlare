import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import type { AdvancedFilterExecutionPlan } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import type { LogicalNodeBase } from "@/lib/edge/analytics/engine/logical/nodes";
import type { LogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { LogicalSlot } from "@/lib/edge/analytics/engine/logical/slots";
import type { ActivityReadRange } from "@/lib/edge/analytics/engine/semantic/activity-read-ranges";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { FILTER_EVALUATOR_LIMITS } from "@/lib/filter-contract/filter-evaluator";
import type { FilterDocument } from "@/lib/filter-contract/filters";

/** Semantic data only: constructing this node grants no application authority. */
export interface WholeMembershipNode extends LogicalNodeBase {
  readonly kind: "whole-filter-membership";
  readonly profile:
    | "channels-single-site-entity-v1"
    | "page-role-single-site-entity-v1"
    | "whole-original-completion-single-site-entity-v1"
    | "whole-original-completion-team-entity-v1";
  /** Literal semantic input port, not an ID looked up in a registry. */
  readonly coverageSource: "read" | "invocation-predecessor";
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly executionScope: "session" | "visitor" | "event";
  /** Fixed semantic inputs resolved by the same captured invocation at the
   * original two Core checkpoints. No callback or storage authority is carried. */
  readonly lateFilterInput: "captured-document-at-core-checkpoints";
}

/** A later, separately validated semantic stage. Its document is captured only
 * after the original Core reads finish, not from the earlier SQL strategy plan. */
export interface WholeMembershipCoreNode extends LogicalNodeBase {
  readonly kind: "whole-filter-core";
  readonly profile:
    | "channels-single-site-entity-v1"
    | "page-role-single-site-entity-v1"
    | "whole-original-completion-single-site-entity-v1"
    | "whole-original-completion-team-entity-v1";
  readonly inputSource: "invocation-core-read-results";
  /** Only the whole-completion profile has a post-Core result-kind checkpoint. */
  readonly resultScopeInput?: "captured-scope-plan-after-core";
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly executionScope: "session" | "visitor" | "event";
  readonly readRange: ActivityReadRange;
  readonly fullHistoryAtEntry: boolean;
  readonly bounds: AdvancedFilterExecutionPlan["decision"]["coreBounds"];
}

export const MEMBERSHIP_COVERAGE_FIELDS = [
  { name: "siteId", scalar: "string", nullable: false },
  { name: "createdAtSeconds", scalar: "number", nullable: false },
] as const;

/** Keep raw payload storage values; reconstruction is a separate bounded host step. */
export const MEMBERSHIP_PAYLOAD_FIELDS = [
  { name: "event_id", scalar: "string", nullable: false },
  { name: "node_id", scalar: "number", nullable: false },
  { name: "parent_node_id", scalar: "number", nullable: true },
  { name: "key_name", scalar: "string", nullable: true },
  { name: "array_index", scalar: "number", nullable: true },
  { name: "value_type", scalar: "number", nullable: false },
  { name: "string_value", scalar: "string", nullable: true },
  { name: "number_value", scalar: "number", nullable: true },
  { name: "boolean_value", scalar: "number", nullable: true },
] as const;

export type MembershipReadSpec =
  | { readonly kind: "site-coverage" }
  | {
      readonly kind: "payload-nodes";
      readonly range: ActivityReadRange;
      readonly paths: readonly string[];
      readonly wholePayload: boolean;
    };

export interface MembershipReadNode extends LogicalNodeBase {
  readonly kind: "membership-read";
  readonly read: MembershipReadSpec;
}

export function membershipReadFields(read: MembershipReadSpec) {
  return read.kind === "site-coverage"
    ? MEMBERSHIP_COVERAGE_FIELDS
    : MEMBERSHIP_PAYLOAD_FIELDS;
}

function sameData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      sameData(Reflect.get(left, key), Reflect.get(right, key)),
  );
}

/** Called only after validateLogicalPlan's own-data/cycle walk. No normalization. */
export function wholeMembershipNodeProblem(
  node: WholeMembershipNode | WholeMembershipCoreNode | MembershipReadNode,
  plan: LogicalPlan,
  slots: ReadonlyMap<LogicalSlot["id"], LogicalSlot>,
): string | undefined {
  const joint =
    node.kind !== "membership-read" &&
    node.profile === "whole-original-completion-team-entity-v1";
  // A finite read may use an authenticated team context. Membership/Core
  // stages require the new explicit team profile; old profiles stay site-only.
  if (
    node.kind !== "membership-read" &&
    (joint
      ? plan.context.subject.origin !== "team"
      : plan.context.subject.origin !== "site" ||
        plan.context.subject.siteIds.length !== 1)
  )
    return "Membership profile subject domain mismatch.";
  if (node.kind === "whole-filter-core") {
    if (
      (node.profile !== "channels-single-site-entity-v1" &&
        node.profile !== "page-role-single-site-entity-v1" &&
        node.profile !== "whole-original-completion-single-site-entity-v1" &&
        !joint) ||
      node.inputSource !== "invocation-core-read-results" ||
      (node.executionScope !== "session" &&
        node.executionScope !== "visitor" &&
        !(
          (node.profile === "whole-original-completion-single-site-entity-v1" ||
            joint) &&
          node.executionScope === "event"
        )) ||
      (node.profile === "whole-original-completion-single-site-entity-v1" ||
      joint
        ? plan.context.scope.contractScope !== node.executionScope
        : plan.context.scope.logicalScope !== node.executionScope) ||
      !sameData(
        plan.context.time,
        semanticTemporalDomainsFromQueryTime(node.queryTime),
      ) ||
      typeof node.fullHistoryAtEntry !== "boolean" ||
      !Number.isFinite(node.readRange.startMs) ||
      !Number.isFinite(node.readRange.endExclusiveMs) ||
      node.readRange.startMs >= node.readRange.endExclusiveMs ||
      !sameData(node.bounds, {
        maxActivities: ADVANCED_FILTER_MAX_ACTIVITIES,
        maxSequenceMatches: FILTER_EVALUATOR_LIMITS.maxSequenceMatches,
        maxSequenceWork: FILTER_EVALUATOR_LIMITS.maxSequenceWork,
      })
    )
      return "Core requires the original fixed bounds and complete context.";
    // Do not call the Count/Seq planner or normalize the late document here.
    const kinded =
      node.profile === "whole-original-completion-single-site-entity-v1" ||
      joint;
    if (
      !node.filters ||
      node.filters.version !== 1 ||
      node.output.length !== (kinded ? 3 : 2)
    )
      return "Core requires the late original document and finite identity schema.";
    if (kinded) {
      if (node.resultScopeInput !== "captured-scope-plan-after-core")
        return "Whole completion requires its original post-Core scope input.";
      const fields = plan.outputs[0]?.fields;
      if (
        plan.outputs.length !== 1 ||
        fields?.length !== 3 ||
        fields[0]?.name !== "site_id" ||
        fields[1]?.name !== "match_kind" ||
        fields[2]?.name !== "match_id" ||
        fields.some((field, index) => field.slot !== node.output[index])
      )
        return "Whole completion exposes exactly site/kind/id.";
    } else if (node.resultScopeInput !== undefined)
      return "Ordinary membership has no late result scope input.";
    for (const id of node.output) {
      const slot = slots.get(id);
      if (
        !slot ||
        slot.nullable ||
        slot.type.kind !== "scalar" ||
        slot.type.scalar !== "string"
      )
        return "Core identity output must contain only non-null strings.";
    }
    return undefined;
  }
  if (node.kind === "whole-filter-membership") {
    if (
      (node.profile !== "channels-single-site-entity-v1" &&
        node.profile !== "page-role-single-site-entity-v1" &&
        node.profile !== "whole-original-completion-single-site-entity-v1" &&
        !joint) ||
      node.lateFilterInput !== "captured-document-at-core-checkpoints" ||
      (node.coverageSource !== "read" &&
        node.coverageSource !== "invocation-predecessor") ||
      (node.executionScope !== "session" &&
        node.executionScope !== "visitor" &&
        !(
          node.profile === "whole-original-completion-single-site-entity-v1" &&
          node.executionScope === "event"
        )) ||
      (node.profile === "whole-original-completion-single-site-entity-v1" ||
      joint
        ? plan.context.scope.contractScope !== node.executionScope
        : plan.context.scope.logicalScope !== node.executionScope)
    )
      return "Membership v1 requires a closed single-site S/V profile.";
    if (
      !sameData(
        plan.context.time,
        semanticTemporalDomainsFromQueryTime(node.queryTime),
      )
    )
      return "Membership time must equal its complete original QueryTime domains.";
    if (!node.filters || node.filters.version !== 1)
      return "Membership requires the original filter document.";
    // Strategy proof belongs to beginWholeMembershipStage at the evaluator
    // checkpoint, after its empty-window shortcut. Generic shape validation
    // must not execute that planner again or invent a fresh Count-only gate.
    const observation = node.executionScope === "event" || joint;
    const names = observation
      ? ["site_id", "match_kind", "match_id"]
      : ["site_id", "entity_id"];
    if (node.output.length !== names.length)
      return observation
        ? "Observation membership exposes exactly site/kind/id."
        : "Membership has exactly site_id/entity_id.";
    const fields = plan.outputs[0]?.fields;
    if (
      observation &&
      (plan.outputs.length !== 1 ||
        fields?.length !== 3 ||
        fields.some(
          (field, index) =>
            field.name !== names[index] || field.slot !== node.output[index],
        ))
    )
      return "Observation membership exposes exactly site/kind/id.";
    for (const id of node.output) {
      const slot = slots.get(id);
      if (
        !slot ||
        slot.nullable ||
        slot.type.kind !== "scalar" ||
        slot.type.scalar !== "string"
      )
        return "Membership identity output must be a non-null string pair.";
    }
    return undefined;
  }
  if (node.read.kind !== "site-coverage" && node.read.kind !== "payload-nodes")
    return "Unknown membership read.";
  if (node.read.kind === "payload-nodes") {
    const { range, paths, wholePayload } = node.read;
    if (
      !Number.isFinite(range.startMs) ||
      !Number.isFinite(range.endExclusiveMs) ||
      range.startMs >= range.endExclusiveMs ||
      typeof wholePayload !== "boolean" ||
      !Array.isArray(paths) ||
      paths.some((path) => typeof path !== "string")
    )
      return "Invalid payload read range or exact path list.";
    // Do not sort/dedupe or reinterpret caller paths: the old planner owns them.
    if (
      plan.context.time.read.kind !== "bounded" ||
      !sameData(range, plan.context.time.read.range)
    )
      return "Payload read must use its declared bounded logical domain.";
  }
  const fields = membershipReadFields(node.read);
  if (node.output.length !== fields.length)
    return "Membership read schema is fixed.";
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    const slot = slots.get(node.output[index]);
    if (
      !slot ||
      slot.nullable !== field.nullable ||
      slot.type.kind !== "scalar" ||
      slot.type.scalar !== field.scalar
    )
      return "Membership read output does not match the finite storage schema.";
  }
  return undefined;
}
