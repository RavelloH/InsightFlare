import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import type { WholeMembershipNode } from "@/lib/edge/analytics/engine/logical/whole-membership";
import type { ActivityReadRange } from "@/lib/edge/analytics/engine/semantic/activity-read-ranges";
import {
  planWholeFilterMembershipJobs,
  type WholeFilterMembershipJob,
} from "@/lib/edge/analytics/engine/whole-filter-membership-jobs";
import {
  buildWholeMembershipReadPlan,
  WHOLE_MEMBERSHIP_OUTPUT,
} from "@/lib/edge/analytics/engine/whole-membership-stage-plan";

export interface WholeMembershipIdentity {
  readonly siteId: string;
  readonly entityId: string;
}

type Planned = ReturnType<typeof planWholeFilterMembershipJobs>;
interface StageFrame {
  readonly stage: ValidatedLogicalPlan;
  readonly node: WholeMembershipNode;
  readonly planned: Planned;
}
interface CoveredFrame extends StageFrame {
  readonly coverage: ReadonlyMap<string, number>;
  readonly readRange: ActivityReadRange;
}

/** Commands are data, not callbacks or storage handles. The physical interpreter
 * must attach an observed compiled SQL child to every storage action. */
export type WholeMembershipState =
  | (StageFrame & {
      readonly kind: "coverage";
      readonly readPlan: ValidatedLogicalPlan;
    })
  | (CoveredFrame & {
      readonly kind: "sql-alternative";
      readonly ordinal: number;
      readonly job: Exclude<
        WholeFilterMembershipJob,
        { kind: "bounded-original-core" }
      >;
    })
  | (CoveredFrame & {
      readonly kind: "core-inputs";
      readonly ordinal: number;
      readonly job: Extract<
        WholeFilterMembershipJob,
        { kind: "bounded-original-core" }
      >;
    })
  | {
      readonly kind: "complete";
      readonly stage: ValidatedLogicalPlan;
      readonly matches: readonly WholeMembershipIdentity[];
    }
  | {
      readonly kind: "invalid-input";
      readonly stage: ValidatedLogicalPlan;
      readonly issue: {
        readonly path: "filters" | "readRange";
        readonly code: "filter_evaluation_range_unavailable";
      };
    }
  | {
      readonly kind: "failed";
      readonly stage: ValidatedLogicalPlan;
      readonly error: unknown;
    };

export type WholeMembershipResult =
  | {
      readonly kind: "coverage";
      readonly coverage: ReadonlyMap<string, number>;
      /** Only the original-completion profile reads these values after its own coverage await. */
      readonly lateEvaluationTime?: {
        readonly queryTime: QueryTime;
        readonly fullHistoryAtEntry: boolean;
      };
    }
  | {
      readonly kind: "sql-evaluated";
      readonly matches: readonly WholeMembershipIdentity[];
    }
  | { readonly kind: "sql-refused" }
  | {
      readonly kind: "core-evaluated";
      readonly matches: readonly WholeMembershipIdentity[];
    }
  | { readonly kind: "failed"; readonly error: unknown };

export function requireWholeMembershipStage(
  stage: ValidatedLogicalPlan,
): WholeMembershipNode {
  validateLogicalPlan(stage);
  const node = stage.nodes[0];
  const output = stage.outputs[0];
  const observation =
    node?.kind === "whole-filter-membership" &&
    (node.executionScope === "event" ||
      node.profile === "whole-original-completion-team-entity-v1");
  const names = observation
    ? ["site_id", "match_kind", "match_id"]
    : ["site_id", "entity_id"];
  if (
    !Object.isFrozen(stage) ||
    stage.nodes.length !== 1 ||
    node?.kind !== "whole-filter-membership" ||
    stage.outputs.length !== 1 ||
    output.id !== WHOLE_MEMBERSHIP_OUTPUT ||
    output.relation !== node.id ||
    output.fields.length !== names.length ||
    output.fields.some(
      (field, index) =>
        field.name !== names[index] || field.slot !== node.output[index],
    )
  )
    throw new Error("invalid_whole_membership_stage");
  return node;
}

export function beginWholeMembershipStage(
  stage: ValidatedLogicalPlan,
): WholeMembershipState {
  const node = requireWholeMembershipStage(stage);
  // Only admitted single-site, valid-envelope requests enter this draft.
  // The standard logical validator already ran; this is not an N=0 or malformed
  // internal-state parity claim about the old evaluator's earlier shortcut.
  if (node.queryTime.filterRangeEmpty)
    return { kind: "complete", stage, matches: [] };
  const planned = planWholeFilterMembershipJobs({
    subject: stage.context.subject,
    filters: node.filters,
    scope: node.executionScope,
    time: node.queryTime,
    reportFusionAvailable: false,
  });
  const frame: StageFrame = { stage, node, planned };
  return {
    ...frame,
    kind: "coverage",
    readPlan: buildWholeMembershipReadPlan({
      stage,
      read: { kind: "site-coverage" },
    }),
  };
}

function covered(
  frame: StageFrame,
  coverage: ReadonlyMap<string, number>,
  lateEvaluationTime?: {
    readonly queryTime: QueryTime;
    readonly fullHistoryAtEntry: boolean;
  },
): WholeMembershipState {
  const time = lateEvaluationTime?.queryTime ?? frame.node.queryTime;
  const siteIds = frame.stage.context.subject.siteIds;
  const fullHistory =
    lateEvaluationTime?.fullHistoryAtEntry ?? time.fullHistory === true;
  const readRange = fullHistory
    ? {
        startMs: Math.min(
          ...siteIds.map(
            (siteId) => coverage.get(siteId) ?? Number.MAX_SAFE_INTEGER,
          ),
        ),
        endExclusiveMs: time.capturedAtMs + 1,
      }
    : (time.readRange ?? time.range);
  // Keep the old range check before the per-site coverage check.
  if (readRange.endExclusiveMs > time.capturedAtMs + 1)
    return unavailable(frame);
  for (const siteId of siteIds) {
    const createdAt = coverage.get(siteId);
    if (
      createdAt === undefined ||
      (!fullHistory && readRange.startMs < createdAt)
    )
      return unavailable(frame);
  }
  return next({ ...frame, coverage, readRange }, 0);
}

function unavailable(frame: StageFrame): WholeMembershipState {
  return {
    kind: "invalid-input",
    stage: frame.stage,
    issue: { path: "readRange", code: "filter_evaluation_range_unavailable" },
  };
}

function next(frame: CoveredFrame, ordinal: number): WholeMembershipState {
  const job = frame.planned.jobs[ordinal];
  if (!job) throw new Error("whole_membership_missing_original_core_job");
  return job.kind === "bounded-original-core"
    ? { ...frame, kind: "core-inputs", ordinal, job }
    : { ...frame, kind: "sql-alternative", ordinal, job };
}

/** A refused SQL result advances only the existing independently proven job
 * list. Diagnostics retain the original rich refusal value in the provider;
 * it is deliberately not coerced into a new engine approximation here. */
export function advanceWholeMembershipStage(
  state: WholeMembershipState,
  result: WholeMembershipResult,
): WholeMembershipState {
  if (
    state.kind === "complete" ||
    state.kind === "failed" ||
    state.kind === "invalid-input"
  )
    throw new Error("whole_membership_terminal_transition");
  if (result.kind === "failed")
    return { kind: "failed", stage: state.stage, error: result.error };
  if (state.kind === "coverage") {
    if (result.kind !== "coverage")
      throw new Error("whole_membership_expected_coverage");
    if (
      result.lateEvaluationTime &&
      state.node.profile !==
        "whole-original-completion-single-site-entity-v1" &&
      state.node.profile !== "whole-original-completion-team-entity-v1"
    )
      throw new Error("whole_membership_unexpected_late_coverage_time");
    return covered(state, result.coverage, result.lateEvaluationTime);
  }
  if (state.kind === "sql-alternative") {
    if (result.kind === "sql-refused") return next(state, state.ordinal + 1);
    if (result.kind !== "sql-evaluated")
      throw new Error("whole_membership_expected_sql_result");
    return { kind: "complete", stage: state.stage, matches: result.matches };
  }
  if (result.kind !== "core-evaluated")
    throw new Error("whole_membership_expected_original_core_result");
  return { kind: "complete", stage: state.stage, matches: result.matches };
}
