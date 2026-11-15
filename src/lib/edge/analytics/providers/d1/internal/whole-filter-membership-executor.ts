import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import type { QueryTime } from "@/lib/edge/analytics/contract";
import { type ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import type { AdvancedCountFilterSupport } from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import { activityEvaluationReadRanges as evaluationReadRanges } from "@/lib/edge/analytics/engine/semantic/activity-read-ranges";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { planWholeFilterMembershipJobs } from "@/lib/edge/analytics/engine/whole-filter-membership-jobs";
import type { AdvancedFilterActivityRow } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-activity-query";
import { queryAdvancedFilterActivityRange } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-activity-query";
import {
  queryAdvancedFilterCountCombined,
  queryAdvancedFilterCountGuard,
  queryAdvancedFilterCountMatches,
  queryAdvancedFilterCountPayloadCombined,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-query";
import { ADVANCED_FILTER_MAX_PAYLOAD_NODES } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-resource-policy";
import type { AdvancedFilterPayloadNode } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-payload-query";
import { queryAdvancedFilterPayloadNodes } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-payload-query";
import { tryEvaluateSequenceSql } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-sequence-query";
import { siteCoverage } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-site-coverage";
import type { D1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { recordAdvancedFilterExecution } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  type CountMembershipCommandResult,
  planCountMembershipCommands,
} from "@/lib/edge/analytics/providers/d1/internal/whole-membership-count-program";
import type { Env } from "@/lib/edge/types";
import { evaluateFilterDocument } from "@/lib/filter-contract/filter-evaluator";
import type {
  FilterDocument,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

import {
  entitiesForRows,
  reconstructWholeMembershipPayloads as reconstructPayloads,
} from "./whole-membership-core-operation";

const SITE_CHUNK_SIZE = 90;
type RawEvaluationRow = AdvancedFilterActivityRow;
type RawPayloadNode = AdvancedFilterPayloadNode;
export interface QualificationMatchRow {
  readonly siteId: string;
  readonly kind: "entity" | "visit" | "event";
  readonly id: string;
}

function invalidInput(
  path: string,
  code: string,
): AnalyticsProviderDomainError {
  return new AnalyticsProviderDomainError({
    kind: "invalid-input",
    issues: [{ path, code }],
  });
}

function siteChunks(siteIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < siteIds.length; index += SITE_CHUNK_SIZE) {
    chunks.push(siteIds.slice(index, index + SITE_CHUNK_SIZE));
  }
  return chunks;
}

function payloadPaths(expression: FilterDocument["root"]): {
  readonly paths: readonly string[];
  readonly wholePayload: boolean;
} {
  const paths = new Set<string>();
  let wholePayload = false;
  const target = (value: FilterTargetExpression): void => {
    if (value.kind === "event-payload") paths.add(value.path);
    else if (value.kind === "member") {
      target(value.object);
      if (value.member === "payload") wholePayload = true;
    } else if (value.kind === "context-intrinsic") {
      if (value.intrinsic === "same") target(value.input);
    } else if (value.kind === "occurrence-time") {
      target(value.input);
    } else if (value.kind === "selector") {
      target(value.collection);
      visit(value.predicate);
    } else if (value.kind === "projection") {
      target(value.collection);
      if (value.member === "payload") {
        if (value.path) paths.add(value.path);
        else wholePayload = true;
      }
    } else if (value.kind === "reducer") target(value.input);
    else if (value.kind === "arithmetic") {
      target(value.left);
      target(value.right);
    } else if (value.kind === "bucket") target(value.input);
    else if (value.kind === "window") {
      target(value.collection);
      target(value.anchor);
    } else if (value.kind === "periods") target(value.collection);
    else if (value.kind === "sequence") value.steps.forEach(target);
    else if (value.kind === "adjacent") target(value.sequence);
    else if (value.kind === "without") {
      target(value.sequence);
      target(value.excluded);
    }
  };
  const visit = (node: FilterDocument["root"]): void => {
    if (!node) return;
    if (node.kind === "condition") {
      target(node.target);
      if (
        node.value &&
        typeof node.value === "object" &&
        !Array.isArray(node.value) &&
        "kind" in node.value
      )
        target(node.value as FilterTargetExpression);
    } else if (node.kind === "not") visit(node.child);
    else node.children.forEach(visit);
  };
  visit(expression);
  return { paths: [...paths].sort(), wholePayload };
}

async function loadActivities(
  env: Env,
  subject: SemanticSubjectDomain,
  siteIds: readonly string[],
  ranges: readonly {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  }[],
  diagnostics?: D1ReadDiagnostics,
  signal?: AbortSignal,
): Promise<RawEvaluationRow[]> {
  const activities: RawEvaluationRow[] = [];
  for (const chunk of siteChunks(siteIds)) {
    for (const range of ranges) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const rows = await queryAdvancedFilterActivityRange({
        env,
        subject,
        siteIds: chunk,
        range,
        diagnostics,
        signal,
      });
      activities.push(...rows);
      if (activities.length > ADVANCED_FILTER_MAX_ACTIVITIES) {
        throw invalidInput("filters", "filter_activity_limit_exceeded");
      }
    }
  }
  return activities;
}

async function loadPayloads(
  env: Env,
  subject: SemanticSubjectDomain,
  siteIds: readonly string[],
  ranges: readonly {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  }[],
  paths: ReturnType<typeof payloadPaths>,
  diagnostics?: D1ReadDiagnostics,
  signal?: AbortSignal,
): Promise<Map<string, unknown>> {
  const payloadNodes: RawPayloadNode[] = [];
  for (const chunk of siteChunks(siteIds)) {
    for (const range of ranges) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const rows = await queryAdvancedFilterPayloadNodes({
        env,
        subject,
        siteIds: chunk,
        range,
        paths: paths.paths,
        wholePayload: paths.wholePayload,
        diagnostics,
        signal,
      });
      payloadNodes.push(...rows);
      if (payloadNodes.length > ADVANCED_FILTER_MAX_PAYLOAD_NODES) {
        throw invalidInput("filters", "filter_payload_node_limit_exceeded");
      }
    }
  }
  return reconstructPayloads(payloadNodes);
}

type EvaluationRange = {
  readonly startMs: number;
  readonly endExclusiveMs: number;
};

async function evaluateAdvancedCountSql(input: {
  readonly env: Env;
  readonly subject: SemanticSubjectDomain;
  readonly siteIds: readonly string[];
  readonly support: Extract<AdvancedCountFilterSupport, { kind: "supported" }>;
  readonly plan: ScopedFilterPlan;
  readonly time: QueryTime;
  readonly coverage: ReadonlyMap<string, number>;
  readonly readRange: EvaluationRange;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}) {
  const program = planCountMembershipCommands({
    subject: input.subject,
    siteIds: input.siteIds,
    support: input.support,
    plan: input.plan,
    time: input.time,
    coverage: input.coverage,
    readRange: input.readRange,
    signal: input.signal,
  });
  let step = program.next();
  while (!step.done) {
    const command = step.value;
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

export interface WholeFilterMembershipInput {
  readonly env: Env;
  readonly subject: SemanticSubjectDomain;
  readonly siteIds: readonly string[];
  readonly filters: FilterDocument;
  readonly plan: ScopedFilterPlan;
  readonly time: QueryTime;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
  readonly coverage?: ReadonlyMap<string, number>;
}

export async function evaluateWholeFilterMembership(
  input: WholeFilterMembershipInput,
): Promise<QualificationMatchRow[]> {
  if (input.time.filterRangeEmpty) return [];
  const { execution: executionPlan, jobs } = planWholeFilterMembershipJobs({
    subject: {
      ...input.subject,
      siteIds: input.siteIds as SemanticSubjectDomain["siteIds"],
    },
    filters: input.filters,
    scope: input.plan.scope,
    time: input.time,
    reportFusionAvailable: false,
  });
  const authorizedSiteIds = new Set<string>(input.subject.siteIds);
  if (input.siteIds.some((siteId) => !authorizedSiteIds.has(siteId)))
    throw invalidInput(
      "filters",
      "advanced_filter_execution_site_context_mismatch",
    );
  const fullHistory = input.time.fullHistory === true;
  const coverage =
    input.coverage ??
    (await siteCoverage(
      input.env,
      input.siteIds,
      input.diagnostics,
      input.signal,
    ));
  const readRange = fullHistory
    ? {
        startMs: Math.min(
          ...input.siteIds.map(
            (siteId) => coverage.get(siteId) ?? Number.MAX_SAFE_INTEGER,
          ),
        ),
        endExclusiveMs: input.time.capturedAtMs + 1,
      }
    : (input.time.readRange ?? input.time.range);
  if (readRange.endExclusiveMs > input.time.capturedAtMs + 1) {
    throw invalidInput("readRange", "filter_evaluation_range_unavailable");
  }
  for (const siteId of input.siteIds) {
    const createdAt = coverage.get(siteId);
    if (
      createdAt === undefined ||
      (!fullHistory && readRange.startMs < createdAt)
    ) {
      throw invalidInput("readRange", "filter_evaluation_range_unavailable");
    }
  }
  recordAdvancedFilterExecution(input.diagnostics, executionPlan.decision);
  for (const job of jobs) {
    switch (job.kind) {
      case "sequence-membership": {
        const sequenceSql = await tryEvaluateSequenceSql(input);
        if (sequenceSql.kind === "evaluated")
          return sequenceSql.matches.map((identity) => ({
            siteId: identity.siteId,
            kind: "entity" as const,
            id: identity.entityId,
          }));
        recordAdvancedFilterExecution(input.diagnostics, {
          ...executionPlan.decision,
          strategy: "bounded-core",
          reason: `sql-runtime-${sequenceSql.reason}`,
        });
        // Sufficient SQL guards may reject a supported tree. Preserve the entire
        // original Core request and its existing budget/error order on fallback.
        break;
      }
      case "count-membership": {
        const countSql = await evaluateAdvancedCountSql({
          ...input,
          support: job.support,
          coverage,
          readRange,
        });
        if (countSql.kind === "evaluated")
          return (countSql.matches.entityIds ?? []).map((identity) => ({
            siteId: identity.siteId,
            kind: "entity" as const,
            id: identity.id,
          }));
        if (input.diagnostics)
          input.diagnostics.advancedCountSqlFallbackReason =
            countSql.fallbackReason;
        recordAdvancedFilterExecution(input.diagnostics, {
          ...executionPlan.decision,
          strategy: "bounded-core",
          reason: `sql-runtime-${countSql.fallbackReason.kind}`,
        });
        break;
      }
      case "bounded-original-core": {
        const paths = payloadPaths(input.filters.root);
        const readRanges = evaluationReadRanges(input.time.range, readRange);
        const [rows, payloads] = await Promise.all([
          loadActivities(
            input.env,
            input.subject,
            input.siteIds,
            readRanges,
            input.diagnostics,
            input.signal,
          ),
          paths.paths.length || paths.wholePayload
            ? loadPayloads(
                input.env,
                input.subject,
                input.siteIds,
                readRanges,
                paths,
                input.diagnostics,
                input.signal,
              )
            : Promise.resolve(new Map<string, unknown>()),
        ]);
        const matches: QualificationMatchRow[] = [];
        const rowsBySite = new Map<unknown, RawEvaluationRow[]>();
        for (const row of rows) {
          const siteRows = rowsBySite.get(row.site_id) ?? [];
          siteRows.push(row);
          rowsBySite.set(row.site_id, siteRows);
        }
        for (const siteId of input.siteIds) {
          const createdAt = coverage.get(siteId)!;
          const siteRows = rowsBySite.get(siteId) ?? [];
          const siteReadRange = fullHistory
            ? {
                startMs: createdAt,
                endExclusiveMs: input.time.capturedAtMs + 1,
              }
            : readRange;
          const siteFilterRange = input.time.filterRange
            ? {
                startMs: input.time.filterRange.startMs ?? createdAt,
                endExclusiveMs:
                  input.time.filterRange.endExclusiveMs ??
                  input.time.capturedAtMs + 1,
              }
            : input.time.range;
          if (siteFilterRange.startMs >= siteFilterRange.endExclusiveMs)
            continue;
          const dataset = entitiesForRows(
            siteRows,
            payloads,
            {
              startMs: input.time.range.startMs,
              endExclusiveMs: input.time.range.endExclusiveMs,
            },
            siteFilterRange,
            siteReadRange,
            input.time.filterRange !== undefined,
          );
          let result;
          try {
            result = evaluateFilterDocument(
              input.filters,
              {
                ...dataset,
                coverageRange: {
                  startMs: createdAt,
                  endExclusiveMs: input.time.capturedAtMs + 1,
                },
              },
              {
                scope: input.plan.scope,
                candidateRange: input.time.range,
                ...(input.time.filterRange
                  ? { filterRange: siteFilterRange }
                  : {}),
                readRange: siteReadRange,
                filterRangeEmpty: input.time.filterRangeEmpty ?? false,
                reportingTimeZone: input.time.reportingTimeZone,
                capturedAtMs: input.time.capturedAtMs,
                ...job.bounds,
              },
            );
          } catch (error) {
            const code = error instanceof Error ? error.message : "";
            if (code === "filter_evaluation_range_unavailable")
              throw invalidInput("readRange", code);
            if (
              code === "filter_activity_limit_exceeded" ||
              code === "filter_sequence_match_limit_exceeded" ||
              code === "filter_sequence_work_limit_exceeded"
            )
              throw invalidInput("filters", code);
            throw error;
          }
          if (input.plan.scope === "event") {
            for (const id of result.matchingVisitIds)
              matches.push({ siteId, kind: "visit", id });
            for (const id of result.matchingEventIds)
              matches.push({ siteId, kind: "event", id });
          } else {
            for (const id of result.matchingScopeEntityIds)
              matches.push({ siteId, kind: "entity", id });
          }
        }
        return matches.sort(
          (left, right) =>
            left.siteId.localeCompare(right.siteId) ||
            left.kind.localeCompare(right.kind) ||
            left.id.localeCompare(right.id),
        );
      }
    }
  }
  throw new Error("whole_filter_membership_terminal_core_missing");
}
