import type { compileD1Query } from "@/lib/db";
import { D1StatementBudgetError } from "@/lib/db";
import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import {
  ADVANCED_FILTER_ACTIVITY_OUTPUT_ID,
  ADVANCED_FILTER_MAX_ACTIVITIES,
  buildAdvancedFilterActivityPlan,
} from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { classifyTwoStepSequence } from "@/lib/edge/analytics/engine/advanced-filter-sequence-support";
import { acceptSequenceAggregate } from "@/lib/edge/analytics/engine/advanced-sequence-envelope";
import {
  buildSequenceAggregateEnvelope,
  type SequencePlanInput,
} from "@/lib/edge/analytics/engine/advanced-sequence-filter-plan";
import type {
  LogicalPlanContext,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import type { PageReaderConsumer } from "@/lib/edge/analytics/engine/page-membership-reader-catalog";
import type { ActivityReadRange } from "@/lib/edge/analytics/engine/semantic/activity-read-ranges";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { sameSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { planWholeMembershipCoreReads } from "@/lib/edge/analytics/engine/whole-membership-core-read-plan";
import {
  buildChannelsCoveragePredecessorPlan,
  buildChannelsMembershipStage,
  buildWholeMembershipCoreStage,
  buildWholeMembershipReadPlan,
  WHOLE_MEMBERSHIP_CORE_OUTPUT,
  WHOLE_MEMBERSHIP_OUTPUT,
  WHOLE_MEMBERSHIP_READ_OUTPUT,
} from "@/lib/edge/analytics/engine/whole-membership-stage-plan";
import {
  advanceWholeMembershipStage,
  beginWholeMembershipStage,
  type WholeMembershipState,
} from "@/lib/edge/analytics/engine/whole-membership-stage-transition";
import { semanticSubjectForAuthorizedSubset } from "@/lib/edge/analytics/providers/d1/internal/authorized-site-subject";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import type { FilterDocument } from "@/lib/filter-contract/filters";

import type { AdvancedFilterActivityRow } from "./advanced-filter-activity-query";
import {
  queryAdvancedFilterCountCombined,
  queryAdvancedFilterCountGuard,
  queryAdvancedFilterCountMatches,
  queryAdvancedFilterCountPayloadCombined,
} from "./advanced-filter-count-query";
import { ADVANCED_FILTER_MAX_PAYLOAD_NODES } from "./advanced-filter-count-resource-policy";
import type { AdvancedFilterPayloadNode } from "./advanced-filter-payload-query";
import { lowerAnalyticsLogicalCommand } from "./analytics-logical-command-lowering";
import { buildChannelsMembershipSuccessor } from "./channel-membership-stage";
import { queryD1CompiledAll } from "./core-sources";
import {
  type D1ReadDiagnostics,
  recordAdvancedFilterExecution,
} from "./diagnostics";
import { buildPageMembershipSuccessor } from "./page-membership-stage";
import { qualificationRequestOwnDataSnapshot } from "./pages-dashboard-qualification-request";
import { entityMembershipRelation } from "./prepared-membership-relations";
import { createQualificationExecutionInputsForTrustedPlan } from "./qualification-execution-inputs";
import type { QualificationMatchRow } from "./whole-filter-membership-executor";
import {
  evaluateWholeMembershipCoreRows,
  reconstructWholeMembershipPayloads,
} from "./whole-membership-core-operation";
import {
  type CountMembershipCommand,
  type CountMembershipCommandResult,
  planCountMembershipCommands,
} from "./whole-membership-count-program";

/** Actual SQL provenance, not a strategy label invented after execution. */
export type WholeMembershipSqlCommand =
  | CountMembershipCommand
  | {
      readonly kind: "logical-sql";
      readonly plan: ValidatedLogicalPlan;
      readonly outputId: string;
      readonly query: ReturnType<typeof compileD1Query>;
    };

function invalidInput(
  path: string,
  code: string,
): AnalyticsProviderDomainError {
  return new AnalyticsProviderDomainError({
    kind: "invalid-input",
    issues: [{ path, code }],
  });
}

function compileOutput(
  plan: ValidatedLogicalPlan,
  outputId: string,
  operation: string,
) {
  const lowered = lowerAnalyticsLogicalCommand(plan, outputId, operation);
  if (lowered.kind !== "logical-sql")
    throw new Error("whole_membership_expected_sql_command");
  return lowered;
}

/** One async frame, with the same original leaf awaits. Do not route these
 * through an extra async command adapter. Reaction parity still needs tests. */
async function runCount(input: {
  readonly env: Env;
  readonly state: Extract<WholeMembershipState, { kind: "sql-alternative" }>;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly originalReadRange: ActivityReadRange;
  readonly originalScopePlan?: Pick<ScopedFilterPlan, "scope">;
  readonly commands: WholeMembershipSqlCommand[];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}) {
  const { state } = input;
  if (state.job.kind !== "count-membership")
    throw new Error("whole_membership_expected_count_job");
  const program = planCountMembershipCommands({
    subject: state.stage.context.subject,
    siteIds: state.stage.context.subject.siteIds,
    support: state.job.support,
    plan: input.originalScopePlan ?? { scope: state.node.executionScope },
    time: input.queryTime,
    coverage: state.coverage,
    readRange: input.originalReadRange,
    signal: input.signal,
  });
  let step = program.next();
  while (!step.done) {
    const command = step.value;
    input.commands.push(command);
    let result: CountMembershipCommandResult;
    switch (command.kind) {
      case "count-combined":
        result = {
          kind: command.kind,
          value: await queryAdvancedFilterCountCombined({
            env: input.env,
            query: command.query,
            diagnostics: input.diagnostics,
          }),
        };
        break;
      case "count-payload-combined":
        result = {
          kind: command.kind,
          value: await queryAdvancedFilterCountPayloadCombined({
            env: input.env,
            query: command.query,
            diagnostics: input.diagnostics,
          }),
        };
        break;
      case "count-guard":
        result = {
          kind: command.kind,
          value: await queryAdvancedFilterCountGuard({
            env: input.env,
            query: command.query,
            numericCompatibilityFields: command.numericCompatibilityFields,
            diagnostics: input.diagnostics,
          }),
        };
        break;
      case "count-matches":
        result = {
          kind: command.kind,
          value: await queryAdvancedFilterCountMatches({
            env: input.env,
            query: command.query,
            numericCompatibilityFields: command.numericCompatibilityFields,
            diagnostics: input.diagnostics,
          }),
        };
        break;
    }
    step = program.next(result);
  }
  return step.value;
}

async function runSequence(input: {
  readonly env: Env;
  readonly state: Extract<WholeMembershipState, { kind: "sql-alternative" }>;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly originalReadRange: ActivityReadRange;
  readonly originalScopePlan?: Pick<ScopedFilterPlan, "scope">;
  readonly commands: WholeMembershipSqlCommand[];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}) {
  const { state } = input;
  const support = classifyTwoStepSequence(
    input.filters,
    input.originalScopePlan?.scope ?? state.node.executionScope,
    input.queryTime,
  );
  if (support.kind === "unsupported")
    return { kind: "fallback" as const, reason: support.code };
  input.signal?.throwIfAborted();
  const planInput: SequencePlanInput = {
    subject: state.stage.context.subject,
    support,
    range: { ...input.queryTime.range },
    reportingTimeZone: input.queryTime.reportingTimeZone,
    capturedAtMs: input.queryTime.capturedAtMs,
  };
  let command: WholeMembershipSqlCommand;
  try {
    const plan = buildSequenceAggregateEnvelope(planInput);
    command = compileOutput(
      plan,
      plan.outputs[0]!.id,
      "analytics.sequence-aggregate-envelope",
    );
  } catch (error) {
    if (!(error instanceof D1StatementBudgetError)) throw error;
    return { kind: "fallback" as const, reason: "sequence_compile_budget" };
  }
  input.commands.push(command);
  const rows = await queryD1CompiledAll<object>(
    input.env,
    command.query,
    input.diagnostics,
  );
  input.signal?.throwIfAborted();
  return acceptSequenceAggregate(
    planInput,
    rows as Readonly<Record<string, unknown>>[],
  );
}

function activityRowFromCompiledOutput(row: object): AdvancedFilterActivityRow {
  const values: Record<string, unknown> = Object.fromEntries(
    Object.entries(row),
  );
  return {
    ...values,
    kind: values.kind as AdvancedFilterActivityRow["kind"],
    id: values.id as AdvancedFilterActivityRow["id"],
    site_id: values.site_id,
    visit_id: values.visit_id as AdvancedFilterActivityRow["visit_id"],
    session_id: values.session_id as AdvancedFilterActivityRow["session_id"],
    visitor_id: values.visitor_id as AdvancedFilterActivityRow["visitor_id"],
    time: values.time as number,
    event_name: values.event_name as AdvancedFilterActivityRow["event_name"],
  };
}

/** Corresponds to the old queryAdvancedFilterActivityRange async leaf, not
 * another generic callback adapter. The loader's outer await stays separate. */
async function readActivityAtOriginalLeaf(input: {
  readonly env: Env;
  readonly state: Extract<WholeMembershipState, { kind: "core-inputs" }>;
  readonly range: ActivityReadRange;
  readonly siteIds: readonly string[];
  readonly commands: WholeMembershipSqlCommand[];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}): Promise<AdvancedFilterActivityRow[]> {
  const plan = buildAdvancedFilterActivityPlan({
    subject: semanticSubjectForAuthorizedSubset(
      input.state.stage.context.subject,
      input.siteIds,
      "activity",
    ),
    range: input.range,
  });
  // The original leaf compiles before this abort check. Common compilation is
  // synchronous; the subsequent query uses exactly this compiled command.
  const command = compileOutput(
    plan,
    ADVANCED_FILTER_ACTIVITY_OUTPUT_ID,
    currentD1Operation() ?? "analytics.query.all",
  );
  input.commands.push(command);
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const rows = await queryD1CompiledAll<object>(
    input.env,
    command.query,
    input.diagnostics,
  );
  return rows.map(activityRowFromCompiledOutput);
}

async function loadCoreActivities(input: {
  readonly env: Env;
  readonly state: Extract<WholeMembershipState, { kind: "core-inputs" }>;
  readonly reads: ReturnType<typeof planWholeMembershipCoreReads>["activities"];
  readonly commands: WholeMembershipSqlCommand[];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}) {
  const activities: AdvancedFilterActivityRow[] = [];
  for (const read of input.reads) {
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const rows = await readActivityAtOriginalLeaf({
      ...input,
      range: read.range,
      siteIds: read.siteIds,
    });
    activities.push(...rows);
    if (activities.length > ADVANCED_FILTER_MAX_ACTIVITIES)
      throw invalidInput("filters", "filter_activity_limit_exceeded");
  }
  return activities;
}

async function readPayloadAtOriginalLeaf(input: {
  readonly env: Env;
  readonly state: Extract<WholeMembershipState, { kind: "core-inputs" }>;
  readonly read: ReturnType<
    typeof planWholeMembershipCoreReads
  >["payloads"][number];
  readonly commands: WholeMembershipSqlCommand[];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}): Promise<AdvancedFilterPayloadNode[]> {
  const plan = buildWholeMembershipReadPlan({
    stage: input.state.stage,
    read: input.read,
    siteIds: input.read.siteIds,
  });
  const command = compileOutput(
    plan,
    WHOLE_MEMBERSHIP_READ_OUTPUT,
    currentD1Operation() ?? "analytics.query.all",
  );
  if (command.source !== "payload-nodes")
    throw new Error("whole_membership_expected_payload_read");
  input.commands.push(command);
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return await queryD1CompiledAll<AdvancedFilterPayloadNode>(
    input.env,
    command.query,
    input.diagnostics,
  );
}

async function loadCorePayloads(input: {
  readonly env: Env;
  readonly state: Extract<WholeMembershipState, { kind: "core-inputs" }>;
  readonly reads: ReturnType<typeof planWholeMembershipCoreReads>["payloads"];
  readonly commands: WholeMembershipSqlCommand[];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}) {
  const payloads: AdvancedFilterPayloadNode[] = [];
  for (const read of input.reads) {
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const rows = await readPayloadAtOriginalLeaf({ ...input, read });
    payloads.push(...rows);
    if (payloads.length > ADVANCED_FILTER_MAX_PAYLOAD_NODES)
      throw invalidInput("filters", "filter_payload_node_limit_exceeded");
  }
  // This was originally inside the payload sibling, before Promise.all settles.
  return reconstructWholeMembershipPayloads(payloads);
}

/** Coverage is timeless site metadata. Its private result can be reused only
 * from this invocation's actual finite read, with the same authenticated subject
 * and output schema. Later legitimate changes to evaluation time do not
 * invalidate metadata. This does not authorize a late re-scope: Stage 0 and
 * the reader retain their independently captured scope/context checks. */
function sameCoverageProvenance(
  plan: ValidatedLogicalPlan,
  context: LogicalPlanContext,
): boolean {
  const node = plan.nodes[0];
  const output = plan.outputs[0];
  return (
    Object.isFrozen(plan) &&
    plan.nodes.length === 1 &&
    node?.kind === "membership-read" &&
    node.read.kind === "site-coverage" &&
    plan.outputs.length === 1 &&
    output?.id === WHOLE_MEMBERSHIP_READ_OUTPUT &&
    output.relation === node.id &&
    node.output.length === 2 &&
    output.fields.length === 2 &&
    output.fields[0].name === "siteId" &&
    output.fields[0].slot === node.output[0] &&
    output.fields[1].name === "createdAtSeconds" &&
    output.fields[1].slot === node.output[1] &&
    sameSemanticSubjectDomain(plan.context.subject, context.subject)
  );
}

interface ChannelsInvocationInput {
  /** Only the deferred factory can select its own actual coverage predecessor. */
  readonly coverageFromOriginalPredecessor?: true;
  readonly profile?:
    | "page-role-single-site-entity-v1"
    | "whole-original-completion-single-site-entity-v1"
    | "whole-original-completion-team-entity-v1";
  readonly env: Env;
  readonly subject: SemanticSubjectDomain;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scope: "session" | "visitor" | "event";
  readonly originalScopePlan?: Pick<ScopedFilterPlan, "scope">;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}

type CompletedStage = Extract<WholeMembershipState, { kind: "complete" }>;

/** Actual output of this invocation, never supplied by a caller. Rows preserve
 * their original order/kind. Projection, role filtering and DISTINCT belong to
 * explicit consumer IR, rather than an output-name resolver. */
export interface WholeMembershipPhysicalTerminal {
  readonly plan: ValidatedLogicalPlan;
  readonly outputId: string;
  readonly rows: readonly Readonly<QualificationMatchRow>[];
}

/** Invocation-local physical execution state, not an application authority or
 * semantic membership handle. Only its own actual LogicalRead can set coverage.
 * The authenticated deferred object must own this frame before activation.
 * There is deliberately no method accepting rows, a Map, or a completed state. */
class ChannelsWholeMembershipInvocation {
  static isActualInvocation(
    value: unknown,
  ): value is ChannelsWholeMembershipInvocation {
    return typeof value === "object" && value !== null && #input in value;
  }

  readonly #input: ChannelsInvocationInput;
  readonly #commands: WholeMembershipSqlCommand[] = [];
  #coverageStarted = false;
  #coverage:
    | {
        readonly plan: ValidatedLogicalPlan;
        readonly values: ReadonlyMap<string, number>;
      }
    | undefined;
  #stageStarted = false;
  #deferredOwner: object | undefined;
  #completed: CompletedStage | undefined;
  #physicalTerminal: WholeMembershipPhysicalTerminal | undefined;
  #retainPhysicalTerminal = false;
  #physicalEarlyEmpty = false;
  #fullHistoryAtEntry = false;
  #originalReadRange: ActivityReadRange | undefined;
  readonly #semanticStages: ValidatedLogicalPlan[] = [];
  #projected:
    | {
        readonly stage: ValidatedLogicalPlan;
        readonly relation: ReturnType<typeof entityMembershipRelation>;
      }
    | undefined;
  #successorBound = false;
  #readerFilters: FilterDocument | undefined;
  #readerConsumer: PageReaderConsumer | undefined;

  constructor(input: ChannelsInvocationInput) {
    this.#input = input;
  }

  /** Called immediately after the existing deferred object is inserted in the
   * existing authentication WeakSet. This records identity, not authority: the
   * AFE adapter must still call its original isDeferredEventQualification first.
   * No new map/ID, caller-provided result, or public authorization token exists. */
  retainDeferredOwnerAtOriginalConstruction(owner: object): void {
    if (this.#deferredOwner || this.#stageStarted)
      throw new Error("channels_membership_deferred_owner_replayed");
    this.#deferredOwner = owner;
  }

  /** An object passing this check is not thereby authenticated. The only future
   * call site is after the existing AFE authentication check, never before it. */
  assertSameDeferredOwner(owner: object): void {
    if (!this.#deferredOwner || this.#deferredOwner !== owner)
      throw new Error("channels_membership_deferred_owner_mismatch");
  }

  /** Called instead of the existing siteCoverage leaf, at that exact original
   * await. It does not build Stage 0, normalize filters, or build the report. */
  async readCoverageAtOriginalCheckpoint(): Promise<
    ReadonlyMap<string, number>
  > {
    if (this.#coverageStarted)
      throw new Error("channels_coverage_predecessor_replayed");
    this.#coverageStarted = true;
    const input = this.#input;
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const plan = buildChannelsCoveragePredecessorPlan(input);
    const command = compileOutput(
      plan,
      WHOLE_MEMBERSHIP_READ_OUTPUT,
      currentD1Operation() ?? "analytics.query.all",
    );
    if (command.source !== "site-coverage")
      throw new Error("whole_membership_expected_coverage_read");
    this.#commands.push(command);
    const rows = await queryD1CompiledAll(
      input.env,
      command.query,
      input.diagnostics,
    );
    const values = new Map<string, number>();
    for (const row of rows)
      if (
        typeof row.siteId === "string" &&
        typeof row.createdAtSeconds === "number"
      )
        values.set(row.siteId, Math.trunc(row.createdAtSeconds * 1_000));
    this.#coverage = { plan, values };
    // Old admission can inspect coverage, but cannot mutate the private physical
    // predecessor by retaining this returned data copy.
    return new Map(values);
  }

  /** The common runtime selects this finite program without introducing an
   * async wrapper. Stage construction itself remains inside the original whole
   * evaluator's async frame, including its synchronous rejection boundary. */
  executeAtOriginalEvaluatorCheckpoint(): Promise<CompletedStage> {
    return this.#execute();
  }

  /** Return the old evaluator result from the SAME original async frame.
   * No .then conversion or wrapper async function changes reaction order. */
  executeRawAtOriginalEvaluatorCheckpoint(): Promise<QualificationMatchRow[]> {
    return this.#execute("qualification-match-rows");
  }

  /** Called by the common physical frame, forwarding the original async body. */
  executeRawForProgramAtOriginalCheckpoint(): Promise<QualificationMatchRow[]> {
    this.#retainPhysicalTerminal = true;
    return this.#execute("qualification-match-rows");
  }

  /** Original register checkpoint, after the evaluator await. Only the private
   * result of this invocation is projected; callers cannot provide match rows. */
  projectAtOriginalRegistrationCheckpoint(owner: object): void {
    this.assertSameDeferredOwner(owner);
    if (!this.#completed || this.#projected)
      throw new Error("channels_membership_projection_not_available");
    const completed = this.#completed;
    const relation = entityMembershipRelation(
      completed.stage.context.subject.siteIds,
      completed.matches.map((match) => ({
        siteId: match.siteId,
        kind: "entity" as const,
        id: match.entityId,
      })),
    );
    this.#projected = { stage: completed.stage, relation };
  }

  /** Capture the actual finite reader at the fallback call, after cursor decode.
   * Keep its reference rather than freeze semantic values at a new checkpoint.
   * Current values are compared only at the original canonical build. */
  retainReaderConsumerAtOriginalFallbackCheckpoint(
    owner: object,
    consumer: PageReaderConsumer,
  ): void {
    this.assertSameDeferredOwner(owner);
    if (
      this.#input.profile !== "page-role-single-site-entity-v1" ||
      this.#stageStarted ||
      this.#readerConsumer
    )
      throw new Error("page_membership_reader_consumer_replayed");
    this.#readerConsumer = consumer;
  }

  /** Retain the exact shallow copy returned at the original fallback return.
   * The successor cannot substitute another document using matching metadata. */
  retainReaderFiltersAtOriginalReturnCheckpoint(
    owner: object,
    filters: FilterDocument,
  ): void {
    this.assertSameDeferredOwner(owner);
    if (!this.#projected || this.#readerFilters)
      throw new Error("channels_membership_reader_filters_replayed");
    this.#readerFilters = filters;
  }

  /** AFE must authenticate owner using its existing WeakSet before this call.
   * This consumes only this frame's completed physical relation, exactly once. */
  bindSuccessorAtOriginalBuilderCheckpoint(input: {
    readonly owner: object;
    readonly siteId: string;
    readonly filters: FilterDocument;
    readonly queryTime: QueryTime;
    readonly scopePlan: ScopedFilterPlan;
    readonly limit: number;
    readonly consumer?: PageReaderConsumer;
  }) {
    this.assertSameDeferredOwner(input.owner);
    const projected = this.#projected;
    if (
      !projected ||
      this.#successorBound ||
      input.filters !== this.#readerFilters
    )
      throw new Error("channels_membership_successor_not_available");
    if (this.#input.profile === "page-role-single-site-entity-v1") {
      const retained = qualificationRequestOwnDataSnapshot(
        this.#readerConsumer,
      );
      const selected = qualificationRequestOwnDataSnapshot(input.consumer);
      if (
        retained === undefined ||
        selected === undefined ||
        retained !== selected
      )
        throw new Error("page_membership_reader_descriptor_mismatch");
    }
    const edge =
      this.#input.profile === "page-role-single-site-entity-v1"
        ? buildPageMembershipSuccessor({
            ...input,
            predecessor: projected.stage,
            consumer: input.consumer,
          })
        : buildChannelsMembershipSuccessor({
            ...input,
            predecessor: projected.stage,
          });
    const executionInputs = createQualificationExecutionInputsForTrustedPlan(
      [{ dependencyRef: edge.dependencyRef, relation: projected.relation }],
      edge.successor,
    );
    // Failed canonical construction/binding does not consume a successful slot.
    this.#successorBound = true;
    return { plan: edge.successor, executionInputs };
  }

  /** Read-only actual completion. The earliest empty-range [] path deliberately
   * has no terminal plan and therefore cannot satisfy a program dependency. */
  physicalTerminal(): WholeMembershipPhysicalTerminal | undefined {
    return this.#physicalTerminal;
  }

  physicalEarlyEmpty(): boolean {
    return this.#physicalEarlyEmpty;
  }

  observedSemanticStages(): readonly ValidatedLogicalPlan[] {
    return Object.freeze([...this.#semanticStages]);
  }

  observedSqlCommands(): readonly WholeMembershipSqlCommand[] {
    return Object.freeze([...this.#commands]);
  }

  /** A physical result can only be selected by the exact completed plan object.
   * No raw identities or caller-created completion are accepted. This method
   * does not bind a report; authenticated deferred/request checks remain needed. */
  completedFor(stage: ValidatedLogicalPlan): CompletedStage {
    if (!this.#completed || this.#completed.stage !== stage)
      throw new Error("channels_membership_predecessor_not_completed");
    return this.#completed;
  }

  #execute(): Promise<CompletedStage>;
  #execute(
    output: "qualification-match-rows",
  ): Promise<QualificationMatchRow[]>;
  async #execute(
    output?: "qualification-match-rows",
  ): Promise<CompletedStage | QualificationMatchRow[]> {
    // Old whole evaluator returns before subject/planner/coverage validation.
    // Only the new raw-result entry has this legacy early-return contract.
    if (
      output === "qualification-match-rows" &&
      this.#input.queryTime.filterRangeEmpty
    ) {
      if (this.#retainPhysicalTerminal) this.#physicalEarlyEmpty = true;
      return [];
    }
    if (this.#stageStarted)
      throw new Error("channels_membership_stage_replayed");
    this.#stageStarted = true;
    // This is the old evaluateWholeFilterMembership entry checkpoint. Building
    // here preserves its async error boundary; no report is built here.
    // The deferred frame is constructed at the original coverage read. Read
    // execution scope again at the old evaluator entry, just as the old Core
    // call reads the live captured plan. Its coverage remains timeless metadata.
    const inputAtEntry = this.#input.coverageFromOriginalPredecessor
      ? { ...this.#input, scope: this.#input.originalScopePlan!.scope }
      : this.#input;
    const stage = buildChannelsMembershipStage({
      ...inputAtEntry,
      coverageSource:
        output === "qualification-match-rows" &&
        !inputAtEntry.coverageFromOriginalPredecessor
          ? "read"
          : "invocation-predecessor",
    });
    const lowered = lowerAnalyticsLogicalCommand(
      stage,
      "channels-whole-membership",
      currentD1Operation() ?? "analytics.query.all",
    );
    if (lowered.kind !== "whole-membership-program")
      throw new Error("channels_membership_expected_program");
    const input = {
      ...inputAtEntry,
      stage: lowered.plan,
      commands: this.#commands,
    };
    let state = beginWholeMembershipStage(stage);
    this.#semanticStages.push(stage);
    this.#fullHistoryAtEntry = input.queryTime.fullHistory === true;
    while (state.kind !== "complete") {
      if (state.kind === "failed") throw state.error;
      if (state.kind === "invalid-input")
        throw invalidInput(state.issue.path, state.issue.code);
      if (state.kind === "coverage") {
        let coverage: ReadonlyMap<string, number>;
        if (state.node.coverageSource === "invocation-predecessor") {
          // Missing provenance must fail, never silently read coverage again.
          const predecessor = this.#coverage;
          if (
            !predecessor ||
            !sameCoverageProvenance(predecessor.plan, state.readPlan.context)
          )
            throw new Error("channels_coverage_predecessor_context_mismatch");
          coverage = predecessor.values;
        } else if (output === "qualification-match-rows") {
          // Preserve old evaluateWholeFilterMembership → siteCoverage → SQL
          // async frames instead of inlining the coverage query await.
          coverage = await this.readCoverageAtOriginalCheckpoint();
        } else {
          if (input.signal?.aborted)
            throw new DOMException("Aborted", "AbortError");
          const command = compileOutput(
            state.readPlan,
            WHOLE_MEMBERSHIP_READ_OUTPUT,
            currentD1Operation() ?? "analytics.query.all",
          );
          if (command.source !== "site-coverage")
            throw new Error("whole_membership_expected_coverage_read");
          input.commands.push(command);
          const rows = await queryD1CompiledAll(
            input.env,
            command.query,
            input.diagnostics,
          );
          const values = new Map<string, number>();
          for (const row of rows)
            if (
              typeof row.siteId === "string" &&
              typeof row.createdAtSeconds === "number"
            )
              values.set(row.siteId, Math.trunc(row.createdAtSeconds * 1_000));
          coverage = values;
        }
        // Retain the same original readRange object, rather than an early deep
        // copy. Later Core checkpoints observe legal mutations at the old time.
        this.#originalReadRange = this.#fullHistoryAtEntry
          ? {
              startMs: Math.min(
                ...stage.context.subject.siteIds.map(
                  (siteId) => coverage.get(siteId) ?? Number.MAX_SAFE_INTEGER,
                ),
              ),
              endExclusiveMs: input.queryTime.capturedAtMs + 1,
            }
          : (input.queryTime.readRange ?? input.queryTime.range);
        state = advanceWholeMembershipStage(state, {
          kind: "coverage",
          coverage,
          ...(output === "qualification-match-rows"
            ? {
                lateEvaluationTime: {
                  queryTime: input.queryTime,
                  fullHistoryAtEntry: this.#fullHistoryAtEntry,
                },
              }
            : {}),
        });
        if (state.kind === "sql-alternative" || state.kind === "core-inputs")
          recordAdvancedFilterExecution(
            input.diagnostics,
            state.planned.execution.decision,
          );
        continue;
      }
      if (state.kind === "sql-alternative") {
        if (state.job.kind === "sequence-membership") {
          const result = await runSequence({
            ...input,
            state,
            originalReadRange: this.#originalReadRange ?? state.readRange,
          });
          if (result.kind === "evaluated") {
            state = advanceWholeMembershipStage(state, {
              kind: "sql-evaluated",
              matches: result.matches,
            });
          } else {
            recordAdvancedFilterExecution(input.diagnostics, {
              ...state.planned.execution.decision,
              strategy: "bounded-core",
              reason: `sql-runtime-${result.reason}`,
            });
            state = advanceWholeMembershipStage(state, { kind: "sql-refused" });
          }
        } else {
          const result = await runCount({
            ...input,
            state,
            originalReadRange: this.#originalReadRange ?? state.readRange,
          });
          if (result.kind === "evaluated") {
            state = advanceWholeMembershipStage(state, {
              kind: "sql-evaluated",
              matches: (result.matches.entityIds ?? []).map(
                ({ siteId, id }) => ({ siteId, entityId: id }),
              ),
            });
          } else {
            if (input.diagnostics)
              input.diagnostics.advancedCountSqlFallbackReason =
                result.fallbackReason;
            recordAdvancedFilterExecution(input.diagnostics, {
              ...state.planned.execution.decision,
              strategy: "bounded-core",
              reason: `sql-runtime-${result.fallbackReason.kind}`,
            });
            state = advanceWholeMembershipStage(state, { kind: "sql-refused" });
          }
        }
        continue;
      }
      // Original checkpoint 1: only now read the captured document root for
      // payload selection. It is not a fresh Count eligibility check.
      const reads = planWholeMembershipCoreReads(state, {
        root: input.filters.root,
        candidateRange: input.queryTime.range,
        readRange: this.#originalReadRange ?? state.readRange,
      });
      const [rows, payloads] = await Promise.all([
        loadCoreActivities({ ...input, state, reads: reads.activities }),
        reads.payloads.length
          ? loadCorePayloads({ ...input, state, reads: reads.payloads })
          : Promise.resolve(new Map<string, unknown>()),
      ]);
      // Original checkpoint 2: capture a later semantic stage only after both
      // read chains, immediately before the fixed synchronous Core operation.
      const coreStage = buildWholeMembershipCoreStage({
        stage,
        filters: input.filters,
        queryTime: input.queryTime,
        readRange: this.#originalReadRange ?? state.readRange,
        fullHistoryAtEntry: this.#fullHistoryAtEntry,
        bounds: state.job.bounds,
        ...(output === "qualification-match-rows"
          ? { lateExecutionScope: input.originalScopePlan!.scope }
          : {}),
      });
      this.#semanticStages.push(coreStage);
      const coreCommand = lowerAnalyticsLogicalCommand(
        coreStage,
        WHOLE_MEMBERSHIP_CORE_OUTPUT,
        currentD1Operation() ?? "analytics.query.all",
      );
      if (coreCommand.kind !== "bounded-filter-core")
        throw new Error("whole_membership_expected_core_operation");
      const matches = evaluateWholeMembershipCoreRows(
        state,
        rows,
        payloads,
        coreCommand.node,
        ...(output === "qualification-match-rows"
          ? ([input.originalScopePlan!] as const)
          : []),
      );
      // The whole-original profile declares site/kind/id, preserving event
      // result kinds if the captured plan changes at the original checkpoints.
      if (output === "qualification-match-rows") {
        if (this.#retainPhysicalTerminal)
          this.#physicalTerminal = Object.freeze({
            plan: coreStage,
            outputId: WHOLE_MEMBERSHIP_CORE_OUTPUT,
            rows: Object.freeze(
              matches.map((match) => Object.freeze({ ...match })),
            ),
          });
        return matches;
      }
      state = advanceWholeMembershipStage(state, {
        kind: "core-evaluated",
        matches: matches.map(({ siteId, id }) => ({ siteId, entityId: id })),
      });
    }
    // Caller-visible read-back cannot mutate the physical predecessor output.
    const completed: CompletedStage = Object.freeze({
      kind: "complete",
      stage,
      matches: Object.freeze(
        state.matches.map((match) => Object.freeze({ ...match })),
      ),
    });
    this.#completed = completed;
    if (output !== "qualification-match-rows") return completed;
    const terminalRows = state.matches.map((match) => ({
      siteId: match.siteId,
      kind: "entity" as const,
      id: match.entityId,
    }));
    if (this.#retainPhysicalTerminal)
      this.#physicalTerminal = Object.freeze({
        plan: stage,
        outputId: WHOLE_MEMBERSHIP_OUTPUT,
        rows: Object.freeze(
          terminalRows.map((match) => Object.freeze({ ...match })),
        ),
      });
    if (output === "qualification-match-rows") return terminalRows;
    return completed;
  }
}

/** Provider-only construction. It accepts captured invocation context, never
 * coverage/matches/caps. Construction itself performs no plan validation/read.
 * This draft is not reachable from the public API or the existing channels. */
export function createChannelsWholeMembershipInvocation(
  input: ChannelsInvocationInput & { readonly scope: "session" | "visitor" },
) {
  return new ChannelsWholeMembershipInvocation(input);
}

/** Same private frame and actual stage interpreter; no alternate evaluator or map. */
export function createPageWholeMembershipInvocation(
  input: Omit<ChannelsInvocationInput, "profile"> & {
    readonly scope: "session" | "visitor";
  },
) {
  return new ChannelsWholeMembershipInvocation({
    ...input,
    profile: "page-role-single-site-entity-v1",
  });
}

/** Provider-only finite entry for an already admitted existing completion.
 * No caller coverage, result, budget, reader callback or ID is accepted.
 * Its own coverage LogicalRead runs at the old evaluator await. */
export function createWholeOriginalCompletionMembershipInvocation(
  input: Omit<ChannelsInvocationInput, "profile" | "originalScopePlan"> & {
    readonly originalScopePlan: Pick<ScopedFilterPlan, "scope">;
  },
) {
  return new ChannelsWholeMembershipInvocation({
    ...input,
    profile: "whole-original-completion-single-site-entity-v1",
  });
}

/** Team entry has no caller-provided coverage/result/slot budget. The same
 * raw interpreter, two Core checkpoints and original promise frame are used. */
export function createTeamWholeOriginalMembershipInvocation(
  input: Omit<
    ChannelsInvocationInput,
    "profile" | "scope" | "originalScopePlan"
  > & {
    readonly scope: "session" | "visitor";
    readonly originalScopePlan: Pick<ScopedFilterPlan, "scope">;
  },
) {
  return new ChannelsWholeMembershipInvocation({
    ...input,
    profile: "whole-original-completion-team-entity-v1",
  });
}

/** Authenticated deferred owners reuse the actual coverage read made by this
 * same private frame. No caller Map, result, slot budget or SQL is accepted. */
export function createDeferredWholeOriginalCompletionMembershipInvocation(
  input: Omit<
    ChannelsInvocationInput,
    "profile" | "coverageFromOriginalPredecessor" | "originalScopePlan"
  > & {
    readonly originalScopePlan: Pick<ScopedFilterPlan, "scope">;
  },
) {
  return new ChannelsWholeMembershipInvocation({
    ...input,
    profile: "whole-original-completion-single-site-entity-v1",
    coverageFromOriginalPredecessor: true,
  });
}

/** Concrete private-field provenance, not a caller-supplied completion record. */
export function isWholeMembershipPhysicalInvocation(
  value: unknown,
): value is ChannelsWholeMembershipInvocation {
  return ChannelsWholeMembershipInvocation.isActualInvocation(value);
}
