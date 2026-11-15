import type {
  createChannelsWholeMembershipInvocation,
  createWholeOriginalCompletionMembershipInvocation,
} from "./whole-membership-stage-program";

/** A finite multi-command invocation, distinct from a single SQL relation. The
 * invocation constructs Stage 0 at the original evaluator checkpoint, lowers it
 * through lowerAnalyticsLogicalCommand, and interprets only that closed node.
 * This entry is intentionally synchronous: it returns the original async frame.
 * No arbitrary host function, caller-completed result, or external coverage is
 * accepted. Each database command retains its validated LogicalPlan and DBIR. */
type ChannelsLogicalStageInput = {
  readonly kind: "channels-whole-membership-at-original-checkpoint";
  readonly invocation: ReturnType<
    typeof createChannelsWholeMembershipInvocation
  >;
};
type WholeOriginalLogicalStageInput = {
  readonly kind: "whole-original-completion-at-original-checkpoint";
  readonly invocation: ReturnType<
    typeof createWholeOriginalCompletionMembershipInvocation
  >;
};
export function executeAnalyticsLogicalStage(
  input: ChannelsLogicalStageInput,
): ReturnType<
  ChannelsLogicalStageInput["invocation"]["executeAtOriginalEvaluatorCheckpoint"]
>;
export function executeAnalyticsLogicalStage(
  input: WholeOriginalLogicalStageInput,
): ReturnType<
  WholeOriginalLogicalStageInput["invocation"]["executeRawAtOriginalEvaluatorCheckpoint"]
>;
export function executeAnalyticsLogicalStage(
  input: ChannelsLogicalStageInput | WholeOriginalLogicalStageInput,
) {
  switch (input.kind) {
    case "channels-whole-membership-at-original-checkpoint":
      return input.invocation.executeAtOriginalEvaluatorCheckpoint();
    case "whole-original-completion-at-original-checkpoint":
      return input.invocation.executeRawAtOriginalEvaluatorCheckpoint();
  }
}
