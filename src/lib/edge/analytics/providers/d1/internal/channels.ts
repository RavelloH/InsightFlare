import type { TrafficChannelId } from "@/lib/analytics/traffic-channel-rules";
import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  QueryAudience,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import { OVERVIEW_CHANNELS_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import { buildOverviewChannelsPlan } from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import {
  type DeferredChannelListQualification,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  type ChannelListQualificationReportQuery,
  type EventSummaryQualificationCompilationEvidence,
  executeChannelListQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import type { FilterDocument, QueryWindow } from "./core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";

export interface ChannelAggregateRow {
  readonly channel: TrafficChannelId;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}

function mapChannelRows(
  rows: readonly Record<string, unknown>[],
): ChannelAggregateRow[] {
  return rows.map((row) => ({
    channel: String(row.channel ?? "other") as TrafficChannelId,
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

export async function queryChannelsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
): Promise<ChannelAggregateRow[]> {
  const metadata = scopedFilterMetadata(filters);
  const plan = buildOverviewChannelsPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    limit,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "overview-channels",
  );
  return mapChannelRows(rows);
}

export async function queryQualifiedChannelListFromD1(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly mode: "list";
  readonly limit: number;
  readonly sourceLimit: number | undefined;
  readonly audience: QueryAudience;
  readonly hasComparison: boolean;
  readonly hasCurrent: boolean;
  readonly hasReference: boolean;
  readonly deferred: DeferredChannelListQualification;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<
  | {
      readonly kind: "executed";
      readonly rows: readonly ChannelAggregateRow[];
      readonly evidence: EventSummaryQualificationCompilationEvidence;
    }
  | {
      readonly kind: "legacy";
      readonly rows: readonly ChannelAggregateRow[];
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    }
> {
  const query: ChannelListQualificationReportQuery = {
    env: input.env,
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    mode: input.mode,
    limit: input.limit,
    sourceLimit: input.sourceLimit,
    audience: input.audience,
    hasComparison: input.hasComparison,
    hasCurrent: input.hasCurrent,
    hasReference: input.hasReference,
  };
  const execution = await executeChannelListQualificationProgram({
    env: input.env,
    deferred: input.deferred,
    query,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  if (execution.kind === "executed")
    return {
      kind: "executed",
      rows: mapChannelRows(
        execution.rows.filter(
          (row) =>
            row.rowKind === "report" &&
            row.outputId === OVERVIEW_CHANNELS_REPORT_OUTPUT,
        ),
      ),
      evidence: execution.evidence,
    };

  const fallbackFilters = await prepareDeferredEventQualificationFallback(
    input.deferred,
  );
  const rows = await queryChannelsFromD1(
    input.env,
    input.siteId,
    input.window,
    fallbackFilters,
    input.limit,
  );
  return {
    kind: "legacy",
    rows,
    fallbackReason: execution.fallbackReason,
  };
}

/** Naming aligned with the existing page/referrer aggregate adapters. */
export const queryChannelAggregate = queryChannelsFromD1;
