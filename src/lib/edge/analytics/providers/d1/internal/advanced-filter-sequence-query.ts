import {
  compileD1Query,
  D1StatementBudgetError,
  lowerLogicalPlan,
} from "@/lib/db";
import type { QueryTime } from "@/lib/edge/analytics/contract";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import { classifyTwoStepSequence } from "@/lib/edge/analytics/engine/advanced-filter-sequence-support";
import {
  acceptSequenceAggregate,
  type SequenceAcceptance,
} from "@/lib/edge/analytics/engine/advanced-sequence-envelope";
import {
  buildSequenceAggregateEnvelope,
  type SequencePlanInput,
} from "@/lib/edge/analytics/engine/advanced-sequence-filter-plan";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import type { Env } from "@/lib/edge/types";
import type { FilterDocument } from "@/lib/filter-contract/filters";

import { AnalyticsLogicalToDbLowerer } from "./analytics-relational-lowering";
import { queryD1CompiledAll } from "./core-sources";
import type { D1ReadDiagnostics } from "./diagnostics";

/** A distinct whole-tree Seq strategy. Call only after the existing site,
 * audience, coverage and read-domain guards. Every fallback must continue the
 * entire original Core request; its reason is diagnostic, not a public error. */
export interface SequenceSqlExecutionInput {
  readonly env: Env;
  readonly subject: SemanticSubjectDomain;
  readonly siteIds: readonly string[];
  readonly filters: FilterDocument;
  readonly plan: ScopedFilterPlan;
  readonly time: QueryTime;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}

export function compileSequenceAggregate(input: SequencePlanInput) {
  const plan = buildSequenceAggregateEnvelope(input);
  const output = plan.outputs[0]!;
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteIds: input.subject.siteIds,
    time: plan.context.time,
  });
  const relation = lowerer.projectOutput(
    lowerer.lower(output),
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  return compileD1Query(lowerLogicalPlan(relation), {
    tag: "analytics.sequence-aggregate-envelope",
  });
}

export async function tryEvaluateSequenceSql(
  input: SequenceSqlExecutionInput,
): Promise<SequenceAcceptance> {
  const allowedSiteIds = new Map(
    input.subject.siteIds.map((siteId) => [String(siteId), siteId]),
  );
  if (input.siteIds.some((siteId) => !allowedSiteIds.has(siteId)))
    return { kind: "fallback", reason: "sequence_site_context_mismatch" };
  const support = classifyTwoStepSequence(
    input.filters,
    input.plan.scope,
    input.time,
  );
  if (support.kind === "unsupported")
    return { kind: "fallback", reason: support.code };
  input.signal?.throwIfAborted();
  const planInput: SequencePlanInput = {
    subject: {
      ...input.subject,
      siteIds: input.siteIds.map((siteId) => allowedSiteIds.get(siteId)!),
    },
    support,
    range: { ...input.time.range },
    reportingTimeZone: input.time.reportingTimeZone,
    capturedAtMs: input.time.capturedAtMs,
  };
  let query: ReturnType<typeof compileSequenceAggregate>;
  try {
    query = compileSequenceAggregate(planInput);
  } catch (error) {
    if (!(error instanceof D1StatementBudgetError)) throw error;
    return { kind: "fallback", reason: "sequence_compile_budget" };
  }
  const rows = await queryD1CompiledAll<object>(
    input.env,
    query,
    input.diagnostics,
  );
  input.signal?.throwIfAborted();
  return acceptSequenceAggregate(
    planInput,
    rows as Readonly<Record<string, unknown>>[],
  );
}
