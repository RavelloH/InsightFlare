import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import {
  ADVANCED_FILTER_ACTIVITY_OUTPUT_ID,
  type AdvancedFilterActivityRange,
  buildAdvancedFilterActivityPlan,
} from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import type { D1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

import { queryD1CompiledAll } from "./core-sources";

export interface AdvancedFilterActivityRow extends Record<string, unknown> {
  readonly kind: "page" | "event";
  readonly id: string | null;
  readonly site_id: unknown;
  readonly visit_id: string | null;
  readonly session_id: string | null;
  readonly visitor_id: string | null;
  readonly time: number;
  readonly event_name: string | null;
}

export interface AdvancedFilterActivityRangeQuery {
  readonly env: Env;
  readonly subject: SemanticSubjectDomain;
  readonly siteIds: readonly string[];
  readonly range: AdvancedFilterActivityRange;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}

function subjectForAuthorizedSubset(
  subject: SemanticSubjectDomain,
  siteIds: readonly string[],
): SemanticSubjectDomain {
  const authorizedSiteIds = new Set<string>(subject.siteIds);
  if (
    siteIds.length === 0 ||
    siteIds.some((siteId) => !authorizedSiteIds.has(siteId))
  )
    throw new Error("advanced_filter_activity_site_subset_unauthorized");
  if (subject.origin === "site" && siteIds.length !== 1)
    throw new Error("advanced_filter_activity_site_subset_invalid");
  return createSemanticSubjectDomain({
    origin: subject.origin,
    siteIds: siteIds as SemanticSubjectDomain["siteIds"],
    ...(subject.teamId ? { teamId: subject.teamId } : {}),
  });
}

function rowFromCompiledOutput(row: object): AdvancedFilterActivityRow {
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

/** Reads one authorized site subset and one half-open activity range. */
export async function queryAdvancedFilterActivityRange(
  input: AdvancedFilterActivityRangeQuery,
): Promise<AdvancedFilterActivityRow[]> {
  const subject = subjectForAuthorizedSubset(input.subject, input.siteIds);
  const plan = buildAdvancedFilterActivityPlan({
    subject,
    range: input.range,
  });
  const output = plan.outputs.find(
    (candidate) => candidate.id === ADVANCED_FILTER_ACTIVITY_OUTPUT_ID,
  );
  if (!output) throw new Error("advanced_filter_activity_output_missing");

  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteIds: plan.context.subject.siteIds,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const query = compileD1Query(lowerLogicalPlan(relation), {
    tag: currentD1Operation() ?? "analytics.query.all",
  });
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const rows = await queryD1CompiledAll<object>(
    input.env,
    query,
    input.diagnostics,
  );
  return rows.map(rowFromCompiledOutput);
}
