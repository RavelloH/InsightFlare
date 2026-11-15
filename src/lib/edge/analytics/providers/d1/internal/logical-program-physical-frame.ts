import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import type {
  LogicalOutput,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

import type {
  LoweredAnalyticsLogicalCommand,
  LoweredAnalyticsLogicalOutputSetCommand,
} from "./analytics-logical-command-lowering";
import type { AnalyticsDbRelation } from "./analytics-relational-storage";
import { queryD1CompiledAll } from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  entityMembershipRelation,
  eventMembershipRelation,
  visitMembershipRelation,
} from "./prepared-membership-relations";
import type { createWholeOriginalCompletionMembershipInvocation } from "./whole-membership-stage-program";
import { isWholeMembershipPhysicalInvocation } from "./whole-membership-stage-program";

export type WholeProgramInvocation = ReturnType<
  typeof createWholeOriginalCompletionMembershipInvocation
>;

/** A real invocation is the frame's only producer. It has no rows setter,
 * completion callback, ID lookup, or separately populated result registry. */
export class D1WholeProgramPhysicalFrame {
  readonly invocation: WholeProgramInvocation;
  #started = false;

  constructor(invocation: WholeProgramInvocation) {
    if (!isWholeMembershipPhysicalInvocation(invocation))
      throw new Error("logical_program_invocation_foreign");
    this.invocation = invocation;
  }

  executeAtOriginalCheckpoint() {
    if (this.#started)
      throw new Error("logical_program_physical_frame_replayed");
    this.#started = true;
    // Synchronous forwarding is deliberate: do not insert async/.then around
    // the existing raw evaluator's Promise, rejection or sibling ordering.
    return this.invocation.executeRawForProgramAtOriginalCheckpoint();
  }

  completedOutputIfPresent() {
    if (!this.#started) return undefined;
    const terminal = this.invocation.physicalTerminal();
    if (!terminal) return undefined;
    const output = terminal.plan.outputs.find(
      (item) => item.id === terminal.outputId,
    );
    if (!output) throw new Error("logical_program_terminal_output_missing");
    return Object.freeze({ plan: terminal.plan, output });
  }

  completedOutput() {
    const completed = this.completedOutputIfPresent();
    if (!completed && this.#started && this.invocation.physicalEarlyEmpty())
      return undefined;
    if (!completed) throw new Error("logical_program_frame_not_completed");
    return completed;
  }

  hasOutput(plan: ValidatedLogicalPlan, output: LogicalOutput): boolean {
    if (!this.#started) return false;
    const terminal = this.invocation.physicalTerminal();
    return (
      terminal?.plan === plan &&
      terminal.outputId === output.id &&
      plan.outputs.includes(output)
    );
  }

  /** Called only after the lowerer matches the actual visible
   * AnalysisResult -> [kind Filter] -> identity Project -> pair Distinct.
   * Reuse the original role normalizer, including its validation ordering,
   * JSON pair deduplication, locale ordering and SQLite text encoding. */
  lowerIdentityRole(
    plan: ValidatedLogicalPlan,
    output: LogicalOutput,
    role: "entity" | "visit" | "event",
  ): AnalyticsDbRelation {
    if (!this.hasOutput(plan, output))
      throw new Error("logical_program_output_foreign");
    const terminal = this.invocation.physicalTerminal()!;
    const names = output.fields.map((field) => field.name).join("/");
    if (
      names !== "site_id/match_kind/match_id" &&
      !(names === "site_id/entity_id" && role === "entity")
    )
      throw new Error("logical_program_terminal_schema_unsupported");
    const normalize =
      role === "entity"
        ? entityMembershipRelation
        : role === "visit"
          ? visitMembershipRelation
          : eventMembershipRelation;
    return normalize(plan.context.subject.siteIds, terminal.rows);
  }
}

/** Owns a real single-SQL command (one output or an ordered output set) and its original awaited provider call. The
 * ordinary report helper's inner async body is relocated here, not wrapped. */
export class D1SqlProgramPhysicalFrame {
  readonly command:
    | Extract<LoweredAnalyticsLogicalCommand, { kind: "logical-sql" }>
    | LoweredAnalyticsLogicalOutputSetCommand;
  #started = false;
  #completed: readonly Readonly<Record<string, unknown>>[] | undefined;
  #executedQuery: ReturnType<typeof compileD1Query> | undefined;

  constructor(
    command:
      | Extract<LoweredAnalyticsLogicalCommand, { kind: "logical-sql" }>
      | LoweredAnalyticsLogicalOutputSetCommand,
  ) {
    this.command = command;
  }

  async executeAtOriginalReportAwait(
    env: Env,
    diagnostics?: D1ReadDiagnostics,
  ): Promise<Record<string, unknown>[]> {
    if (this.#started) throw new Error("logical_program_sql_frame_replayed");
    this.#started = true;
    // Output-set compilation stays inside the original async DB-await body.
    // In particular a compile failure still rejects this inner Promise first.
    const query =
      this.command.kind === "logical-sql"
        ? this.command.query
        : compileD1Query(lowerLogicalPlan(this.command.relation), {
            tag: currentD1Operation() ?? "analytics.query.all",
          });
    this.#executedQuery = query;
    const rows = await queryD1CompiledAll<object>(env, query, diagnostics);
    const result = rows.map((row) => Object.fromEntries(Object.entries(row)));
    this.#completed = Object.freeze(
      result.map((row) => Object.freeze({ ...row })),
    );
    return result;
  }

  /** Read-only evidence of the query actually passed to the one DB await. */
  get executedQuery() {
    return this.#executedQuery;
  }

  /** No consumption of arbitrary SQL types as VALUES is licensed yet. This
   * observation exposes actual SQL completion, not mutable result authority. */
  completedFor(plan: ValidatedLogicalPlan, outputId: string) {
    if (
      this.command.plan !== plan ||
      this.command.kind !== "logical-sql" ||
      this.command.outputId !== outputId ||
      !this.#completed
    )
      throw new Error("logical_program_sql_output_not_completed");
    return this.#completed;
  }
}
