import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { RelationId } from "@/lib/edge/analytics/engine/logical/ids";
import type { SourceMembershipInput } from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  LogicalOutput,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { snapshotLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { transformQualifiedPageProgramSources } from "@/lib/edge/analytics/engine/program-membership-plan-transform";
import type { ProgramMembershipOutput } from "@/lib/edge/analytics/engine/program-membership-source";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { Env } from "@/lib/edge/types";

import {
  lowerAnalyticsLogicalCommand,
  lowerAnalyticsLogicalOutputSetCommand,
  type LoweredAnalyticsLogicalCommand,
  type LoweredAnalyticsLogicalOutputSetCommand,
} from "./analytics-logical-command-lowering";
import type { AnalyticsDbRelation } from "./analytics-relational-storage";
import type {
  AnalyticsReportMultiOutputSelection,
  SelectedOutputField,
} from "./analytics-report-output-selection";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  D1SqlProgramPhysicalFrame,
  D1WholeProgramPhysicalFrame,
  type WholeProgramInvocation,
} from "./logical-program-physical-frame";
import {
  matchProgramMembershipConstantFold,
  type ProgramMembershipConstantFold,
} from "./program-membership-constant-folding";
import type { QualificationExecutionInputs } from "./qualification-execution-inputs";
import {
  assertQualificationPlanContext,
  assertQualificationRequestSnapshot,
  type QualificationPlanContext,
  type QualificationRequestSnapshot,
  snapshotQualificationRequest,
} from "./qualification-plan-context";

/** A real IR→DBIR fused operator. Created only after actual predecessor
 * completion and successful role normalization; not individual-node memo data. */
export interface ProgramMembershipPhysicalFold {
  readonly kind: "program-membership-constant-fold";
  readonly consumer: ValidatedLogicalPlan;
  readonly edge: SourceMembershipInput;
  readonly logical: ProgramMembershipConstantFold;
  readonly relation: AnalyticsDbRelation;
}

/** An actual analysis-result edge, not a name used to look up registered rows. */
export interface D1LogicalProgramDependency {
  readonly input: RelationId;
  readonly producerStage: number;
  readonly output: LogicalOutput;
}

export interface D1LogicalProgramStage {
  readonly index: number;
  readonly plan: ValidatedLogicalPlan;
  readonly outputs: readonly LogicalOutput[];
  readonly dependencies: readonly D1LogicalProgramDependency[];
}

/** Physical lowering produced from a declared stage in this execution. */
export interface D1LogicalProgramPhysicalFrame {
  readonly stage: D1LogicalProgramStage;
  readonly output: LogicalOutput;
  readonly command: LoweredAnalyticsLogicalCommand;
}

export interface D1LogicalProgramOutputSetPhysicalFrame {
  readonly stage: D1LogicalProgramStage;
  readonly outputs: readonly LogicalOutput[];
  readonly command: LoweredAnalyticsLogicalOutputSetCommand;
  readonly execution: D1SqlProgramPhysicalFrame;
}

interface WholeOriginalPageConsumer {
  readonly consumer: object;
  readonly context: QualificationRequestSnapshot;
  consumed: boolean;
  producerStage?: D1LogicalProgramStage;
  producerOutput?: LogicalOutput;
}

/** Snapshot consumer data while retaining only the exact actual program child.
 * The ordinary snapshot helper and all non-program callers remain unchanged. */
function snapshotProgramPageConsumerPlan(
  plan: ValidatedLogicalPlan,
  producer: ProgramMembershipOutput,
): ValidatedLogicalPlan {
  const copied = snapshotLogicalPlan(plan);
  const nodes = copied.nodes.map((node, index) => {
    const original = plan.nodes[index]!;
    if (original.kind !== "analysis-result" || original.execution !== "program")
      return node;
    if (
      node.kind !== "analysis-result" ||
      original.childPlan !== producer.plan ||
      original.outputId !== producer.output.id
    )
      throw new Error("qualification_execution_program_producer_mismatch");
    return Object.freeze({ ...node, childPlan: producer.plan });
  });
  return validateLogicalPlan(
    Object.freeze({ ...copied, nodes: Object.freeze(nodes) }),
  );
}

/**
 * One incremental LogicalPlan program and its actual lowering frames.
 * Construction reads no query, scope, filters, time, environment, or rows.
 * Physical frames own actual execution/completion. Declarations never accept
 * completed rows, foreign Maps or application qualification handles.
 */
export class D1LogicalProgramExecution {
  // Native consumers belong to this actual execution, not a parallel handle registry.
  // No relation, external row set, arbitrary role budget or opaque carrier is stored.
  readonly #wholePageConsumers: WholeOriginalPageConsumer[] = [];
  readonly #stages: D1LogicalProgramStage[] = [];
  readonly #physicalFrames: (
    D1LogicalProgramPhysicalFrame | D1LogicalProgramOutputSetPhysicalFrame
  )[] = [];
  readonly #executingWholeFrames: D1WholeProgramPhysicalFrame[] = [];
  readonly #executingSqlFrames: D1SqlProgramPhysicalFrame[] = [];

  /** Read immutable data for a failed attempt switching to its original refs path.
   * The existing request association is the identity; copied owner objects cannot reset it. */
  readWholeOriginalPageConsumerSnapshot(
    consumer: object,
  ): QualificationRequestSnapshot | undefined {
    const state = this.#wholePageConsumers.find(
      (item) => item.consumer === consumer,
    );
    if (state?.consumed)
      throw new Error("qualification_execution_preparation_replayed");
    return state?.context;
  }

  /** Convert one canonical consumer at its original synchronous checkpoint.
   * The real producer stage/output and this execution's one-time claim replace
   * opaque PageVisit preparation; no physical relation is supplied by the caller. */
  bindWholeOriginalPageConsumer(
    input: QualificationRequestSnapshot & {
      readonly consumer: object;
      readonly plan: ValidatedLogicalPlan;
      readonly readerQueryTime: QueryTime;
      readonly membershipOutput: ProgramMembershipOutput;
      readonly requestSnapshot?: QualificationRequestSnapshot;
    },
  ): ValidatedLogicalPlan {
    let state = this.#wholePageConsumers.find(
      (item) => item.consumer === input.consumer,
    );
    if (!state) {
      const context =
        input.requestSnapshot ??
        snapshotQualificationRequest({
          ...input,
          qualificationSemantics: "whole-original",
          dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
        });
      state = { consumer: input.consumer, context, consumed: false };
      this.#wholePageConsumers.push(state);
    }
    if (state.consumed)
      throw new Error("qualification_execution_preparation_replayed");
    assertQualificationRequestSnapshot(input, state.context);
    const producer = input.membershipOutput;
    if (
      state.context.scopePlan.mode !== "entity" ||
      (state.context.scopePlan.scope !== "session" &&
        state.context.scopePlan.scope !== "visitor") ||
      this.completedWholeOutputs.filter(
        (item) =>
          item.plan === producer.plan && item.output === producer.output,
      ).length !== 1
    )
      throw new Error("qualification_execution_program_producer_mismatch");
    const context: QualificationPlanContext = {
      ...state.context,
      qualificationSemantics: "whole-original" as const,
      dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
      availableDependencies: [EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY],
      // The original common catalog already checked every canonical Source.
      // Derive the actual occurrence count; no caller budget is accepted.
      maxSourcesPerRole: input.plan.nodes.filter(
        (node) => node.kind === "source",
      ).length,
    };
    assertQualificationPlanContext(input.plan, context, input.readerQueryTime);
    const plan = snapshotProgramPageConsumerPlan(
      transformQualifiedPageProgramSources(input.plan, producer),
      producer,
    );
    if (
      state.context.scopePlan.mode !== "entity" ||
      (state.context.scopePlan.scope !== "session" &&
        state.context.scopePlan.scope !== "visitor") ||
      this.completedWholeOutputs.filter(
        (item) =>
          item.plan === producer.plan && item.output === producer.output,
      ).length !== 1
    )
      throw new Error("qualification_execution_program_producer_mismatch");
    assertQualificationPlanContext(
      plan,
      context,
      input.readerQueryTime,
      undefined,
      undefined,
      producer,
    );
    const producerStage = this.#stages.find(
      (stage) =>
        stage.plan === producer.plan && stage.outputs.includes(producer.output),
    );
    if (!producerStage)
      throw new Error("qualification_execution_program_producer_mismatch");
    state.producerStage = producerStage;
    state.producerOutput = producer.output;
    state.consumed = true;
    return plan;
  }

  executeSqlAtOriginalReportCheckpoint(
    stage: D1LogicalProgramStage,
    outputId: string,
    operation: string,
    env: Env,
    diagnostics?: D1ReadDiagnostics,
  ) {
    const lowered = this.lowerStageOutput(stage, outputId, operation);
    if (lowered.command.kind !== "logical-sql")
      throw new Error("logical_program_expected_sql_frame");
    const frame = new D1SqlProgramPhysicalFrame(lowered.command);
    this.#executingSqlFrames.push(frame);
    // The single existing report-query await frame is now the SQL frame's body.
    return frame.executeAtOriginalReportAwait(env, diagnostics);
  }

  /** One actual output-set command/SQL at the original report await. */
  executeOutputSetAtOriginalReportCheckpoint(
    stage: D1LogicalProgramStage,
    selection: AnalyticsReportMultiOutputSelection,
    outputSchemas: readonly (readonly SelectedOutputField[])[],
    env: Env,
    diagnostics?: D1ReadDiagnostics,
    qualificationExecutionInputs?: QualificationExecutionInputs,
  ) {
    if (this.#stages[stage.index] !== stage)
      throw new Error("logical_program_stage_foreign");
    if (
      selection.outputIds.length !== stage.outputs.length ||
      selection.outputIds.some((id, index) => stage.outputs[index]?.id !== id)
    )
      throw new Error("logical_program_output_set_mismatch");
    const command = lowerAnalyticsLogicalOutputSetCommand(
      stage.plan,
      stage.outputs,
      outputSchemas,
      selection,
      this,
      qualificationExecutionInputs,
    );
    const frame = new D1SqlProgramPhysicalFrame(command);
    const lowered = Object.freeze({
      stage,
      outputs: stage.outputs,
      command,
      execution: frame,
    });
    this.#physicalFrames.push(lowered);
    this.#executingSqlFrames.push(frame);
    // Directly return the same single DB-await frame; never wrap it in then/async.
    return frame.executeAtOriginalReportAwait(env, diagnostics);
  }

  /** No async frame, no .then: preserve the invocation's original Promise. */
  executeWholeAtOriginalCheckpoint(invocation: WholeProgramInvocation) {
    if (
      this.#executingWholeFrames.some(
        (frame) => frame.invocation === invocation,
      )
    )
      throw new Error("logical_program_invocation_replayed");
    const frame = new D1WholeProgramPhysicalFrame(invocation);
    this.#executingWholeFrames.push(frame);
    return frame.executeAtOriginalCheckpoint();
  }

  /** The exact plan/output are exposed only from a real successful frame.
   * Declaration alone, failed invocation, foreign object and early [] cannot
   * create a completed predecessor. No method accepts externally supplied rows. */
  completedWholeOutput(invocation: WholeProgramInvocation) {
    const frame = this.#executingWholeFrames.find(
      (item) => item.invocation === invocation,
    );
    if (!frame) throw new Error("logical_program_invocation_foreign");
    const completed = frame.completedOutput();
    if (!completed) return undefined;
    if (!this.#stages.some((stage) => stage.plan === completed.plan))
      this.#appendStage(completed.plan, [completed.output.id], true);
    return completed;
  }

  /** Actual, already-declared physical producers available to later stages.
   * Descriptors contain no rows or lookup IDs. A reader still builds explicit
   * program AnalysisResult edges, validated against this executing graph. */
  get completedWholeOutputs(): readonly {
    readonly plan: ValidatedLogicalPlan;
    readonly output: LogicalOutput;
  }[] {
    return Object.freeze(
      this.#executingWholeFrames.flatMap((frame) => {
        const completed = frame.completedOutputIfPresent();
        if (
          !completed ||
          !this.#stages.some(
            (stage) =>
              stage.plan === completed.plan &&
              stage.outputs.includes(completed.output),
          )
        )
          return [];
        return [completed];
      }),
    );
  }

  /** Fold only the exact IR edge contained in an actual declared consumer.
   * The frame supplies its own completed data; no caller rows are accepted. */
  foldSourceMembershipInput(
    consumer: ValidatedLogicalPlan,
    edge: SourceMembershipInput,
  ) {
    return this.lowerSourceMembershipInput(consumer, edge)?.relation;
  }

  /** Return a physical fusion artifact as well as the relation for the Source
   * lowerer's graph accounting. Failed/unknown folds produce no artifact. */
  lowerSourceMembershipInput(
    consumer: ValidatedLogicalPlan,
    edge: SourceMembershipInput,
  ): ProgramMembershipPhysicalFold | undefined {
    const stage = this.#stages.find((item) => item.plan === consumer);
    if (
      !stage ||
      !consumer.nodes.some(
        (node) =>
          node.kind === "source" && node.membershipInputs?.includes(edge),
      )
    )
      throw new Error("logical_program_source_edge_foreign");
    const folded = matchProgramMembershipConstantFold(consumer, edge);
    if (!folded) return undefined;
    const dependency = stage.dependencies.find(
      (item) => item.input === folded.imported.id,
    );
    const producer = dependency && this.#stages[dependency.producerStage];
    if (
      !dependency ||
      !producer ||
      producer.plan !== folded.imported.childPlan ||
      dependency.output.id !== folded.imported.outputId
    )
      throw new Error("logical_program_dependency_foreign");
    const frames = this.#executingWholeFrames.filter((frame) =>
      frame.hasOutput(producer.plan, dependency.output),
    );
    if (frames.length !== 1)
      throw new Error("logical_program_output_not_completed");
    const relation = frames[0]!.lowerIdentityRole(
      producer.plan,
      dependency.output,
      folded.role,
    );
    return Object.freeze({
      kind: "program-membership-constant-fold",
      consumer,
      edge,
      logical: folded,
      relation,
    });
  }

  get stages(): readonly D1LogicalProgramStage[] {
    return Object.freeze([...this.#stages]);
  }

  get physicalFrames(): readonly (
    D1LogicalProgramPhysicalFrame | D1LogicalProgramOutputSetPhysicalFrame
  )[] {
    return Object.freeze([...this.#physicalFrames]);
  }

  /** Called only at the existing canonical-builder / command checkpoint. */
  appendStage(
    plan: ValidatedLogicalPlan,
    outputIds: readonly string[],
  ): D1LogicalProgramStage {
    // Freeze a detached canonical stage BEFORE its command is executed. Only
    // explicit program imports retain exact already-executed producer identity.
    validateLogicalPlan(plan);
    const copied = snapshotLogicalPlan(plan);
    const nodes = copied.nodes.map((node, index) => {
      const original = plan.nodes[index]!;
      if (
        original.kind !== "analysis-result" ||
        original.execution !== "program"
      )
        return node;
      if (node.kind !== "analysis-result")
        throw new Error("logical_program_snapshot_node_mismatch");
      if (!this.#stages.some((stage) => stage.plan === original.childPlan))
        throw new Error("logical_program_producer_not_declared");
      return Object.freeze({ ...node, childPlan: original.childPlan });
    });
    const canonical = validateLogicalPlan(
      Object.freeze({ ...copied, nodes: Object.freeze(nodes) }),
    );
    return this.#appendStage(canonical, outputIds, false);
  }

  #appendStage(
    plan: ValidatedLogicalPlan,
    outputIds: readonly string[],
    alreadyExecuted: boolean,
  ): D1LogicalProgramStage {
    validateLogicalPlan(plan);
    if (alreadyExecuted && !Object.isFrozen(plan))
      throw new Error("logical_program_executed_plan_not_frozen");
    if (outputIds.length === 0 || new Set(outputIds).size !== outputIds.length)
      throw new Error("logical_program_outputs_invalid");
    const outputs = outputIds.map((outputId) => {
      const matches = plan.outputs.filter((output) => output.id === outputId);
      if (matches.length !== 1)
        throw new Error(`logical_program_output_missing:${outputId}`);
      return matches[0]!;
    });
    const dependencies = plan.nodes.flatMap((node) => {
      if (node.kind !== "analysis-result" || node.execution !== "program")
        return [];
      const producer = this.#stages.find(
        (stage) => stage.plan === node.childPlan,
      );
      const output = producer?.outputs.find(
        (candidate) => candidate.id === node.outputId,
      );
      if (!producer || !output)
        throw new Error("logical_program_producer_not_declared");
      return [
        Object.freeze({
          input: node.id,
          producerStage: producer.index,
          output,
        }),
      ];
    });
    const stage = Object.freeze({
      index: this.#stages.length,
      plan,
      outputs: Object.freeze(outputs),
      dependencies: Object.freeze(dependencies),
    });
    this.#stages.push(stage);
    return stage;
  }

  readImportedOutput(
    _consumer: ValidatedLogicalPlan,
    _input: RelationId,
  ): never {
    // Do not eagerly validate/encode all raw kinds before a consumer role
    // Filter. Unsupported program chains need an explicit physical lowering.
    throw new Error("logical_program_import_requires_supported_constant_fold");
  }

  /**
   * Uses the existing real command lowerer; this is not a fake SQL wrapper.
   * Its ordinary SQL path still rejects unexecuted staged child plans.
   * No supplied rows or completed-stage objects can be registered here.
   */
  lowerStageOutput(
    stage: D1LogicalProgramStage,
    outputId: string,
    operation: string,
  ): D1LogicalProgramPhysicalFrame {
    if (this.#stages[stage.index] !== stage)
      throw new Error("logical_program_stage_foreign");
    const output = stage.outputs.find((candidate) => candidate.id === outputId);
    if (!output) throw new Error(`logical_program_output_missing:${outputId}`);
    const command = lowerAnalyticsLogicalCommand(
      stage.plan,
      outputId,
      operation,
      this,
    );
    const frame = Object.freeze({ stage, output, command });
    this.#physicalFrames.push(frame);
    return frame;
  }
}
