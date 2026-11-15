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
import { pageRoleDependencyRefs } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import {
  bindDeferredChannelMembershipSuccessor,
  type DeferredChannelListQualification,
  hasDeferredChannelMembershipProgram,
  prepareDeferredChannelMembershipFallback,
  prepareDeferredEventQualificationFallback,
  prepareDeferredPageVisitQualification,
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
import type { D1ExecutionOptions } from "./execution-options";
import {
  bindPageVisitQualificationPreparation,
  pageVisitQualificationConsumerKey,
  type PageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "./page-visit-qualification-execution";
import { bindWholeOriginalReader } from "./whole-filter-reader-preparation";

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

interface ChannelsPageQualification {
  readonly kind?: never;
  readonly preparation: PageVisitQualificationPreparation;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly sourceLimit: number | undefined;
  readonly audience: QueryAudience;
  readonly hasComparison: boolean;
  readonly hasCurrent: boolean;
  readonly hasReference: boolean;
}

interface ChannelsStagedQualification {
  readonly kind: "channels-whole-logical-stages";
  readonly deferred: DeferredChannelListQualification;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
}

export async function queryChannelsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  qualification?: ChannelsPageQualification | ChannelsStagedQualification,
  wholeOriginalOwner?: object,
  execution?: D1ExecutionOptions,
): Promise<ChannelAggregateRow[]> {
  const metadata = scopedFilterMetadata(filters);
  const queryTime =
    qualification?.queryTime ?? metadata?.time ?? queryWindowToTime(window);
  const scopePlan = qualification?.scopePlan ?? metadata?.plan;
  const stagedQualification =
    qualification?.kind === "channels-whole-logical-stages"
      ? qualification
      : undefined;
  const pageQualification =
    qualification?.kind === "channels-whole-logical-stages"
      ? undefined
      : qualification;
  const staged = stagedQualification
    ? bindDeferredChannelMembershipSuccessor({
        deferred: stagedQualification.deferred,
        siteId,
        filters,
        queryTime,
        scopePlan: stagedQualification.scopePlan,
        limit,
      })
    : undefined;
  const wholeOriginal =
    !qualification && wholeOriginalOwner
      ? bindWholeOriginalReader({
          owner: wholeOriginalOwner,
          consumer: {
            kind: "page",
            family: "channels",
            reader: { kind: "channels-list", configuration: { limit } },
          },
          siteId,
          filters,
          queryTime: metadata?.time ?? queryWindowToTime(window),
          scopePlan: metadata?.plan,
          readerQueryTime: queryTime,
          ...(execution ? { execution } : {}),
        })
      : undefined;
  // Existing qualification and whole-reader bindings retain priority.
  const membershipOutputs =
    !qualification && !wholeOriginalOwner
      ? (execution?.program?.completedWholeOutputs ?? [])
      : [];
  const membershipOutput = membershipOutputs[0];
  const builtPlan =
    staged?.plan ??
    wholeOriginal?.plan ??
    buildOverviewChannelsPlan({
      siteId,
      queryTime,
      filters,
      ...(scopePlan ? { scopePlan } : {}),
      ...(membershipOutput ? { membershipOutput } : {}),
      ...(pageQualification
        ? {
            qualificationDependencyRefs: pageRoleDependencyRefs(scopePlan),
          }
        : {}),
      limit,
    });
  // Preserve the original integer-limit and Source checks before ambiguity.
  if (membershipOutputs.length > 1)
    throw new Error("channels_program_membership_producer_ambiguous");
  const plan = pageQualification
    ? snapshotPageVisitQualificationPlan(builtPlan)
    : builtPlan;
  const qualificationExecutionInputs =
    staged?.executionInputs ??
    wholeOriginal?.executionInputs ??
    (pageQualification
      ? bindPageVisitQualificationPreparation({
          preparation: pageQualification.preparation,
          siteId,
          filters,
          queryTime,
          scopePlan: pageQualification.scopePlan,
          consumerKey: channelListQualificationConsumerKey({
            limit,
            sourceLimit: pageQualification.sourceLimit,
            audience: pageQualification.audience,
            hasComparison: pageQualification.hasComparison,
            hasCurrent: pageQualification.hasCurrent,
            hasReference: pageQualification.hasReference,
          }),
          plan,
        })
      : undefined);
  const rows = await (membershipOutput || wholeOriginal?.execution
    ? queryAnalyticsReportOutputRowsFromD1(
        env,
        plan,
        "overview-channels",
        undefined,
        undefined,
        qualificationExecutionInputs,
        wholeOriginal?.execution ?? execution,
      )
    : queryAnalyticsReportOutputRowsFromD1(
        env,
        plan,
        "overview-channels",
        undefined,
        undefined,
        qualificationExecutionInputs,
      ));
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

  const consumerKey = channelListQualificationConsumerKey({
    limit: input.limit,
    sourceLimit: input.sourceLimit,
    audience: input.audience,
    hasComparison: input.hasComparison,
    hasCurrent: input.hasCurrent,
    hasReference: input.hasReference,
  });
  const preparation = await prepareDeferredPageVisitQualification(
    input.deferred,
    consumerKey,
  );
  const staged =
    !preparation && hasDeferredChannelMembershipProgram(input.deferred);
  const fallbackFilters = preparation
    ? input.filters
    : await (staged
        ? prepareDeferredChannelMembershipFallback(input.deferred)
        : prepareDeferredEventQualificationFallback(input.deferred));
  const rows = await queryChannelsFromD1(
    input.env,
    input.siteId,
    input.window,
    fallbackFilters,
    input.limit,
    preparation
      ? {
          preparation,
          queryTime: input.queryTime,
          scopePlan: input.scopePlan ?? input.deferred.metadata.plan,
          sourceLimit: input.sourceLimit,
          audience: input.audience,
          hasComparison: input.hasComparison,
          hasCurrent: input.hasCurrent,
          hasReference: input.hasReference,
        }
      : staged
        ? {
            kind: "channels-whole-logical-stages",
            deferred: input.deferred,
            queryTime:
              scopedFilterMetadata(fallbackFilters)?.time ?? input.queryTime,
            scopePlan:
              scopedFilterMetadata(fallbackFilters)?.plan ??
              input.deferred.metadata.plan,
          }
        : undefined,
  );
  return {
    kind: "legacy",
    rows,
    fallbackReason: execution.fallbackReason,
  };
}

export function channelListQualificationConsumerKey(input: {
  readonly limit: number;
  readonly sourceLimit: number | undefined;
  readonly audience: QueryAudience;
  readonly hasComparison: boolean;
  readonly hasCurrent: boolean;
  readonly hasReference: boolean;
}) {
  return pageVisitQualificationConsumerKey("channel-list", input);
}

/** Naming aligned with the existing page/referrer aggregate adapters. */
export const queryChannelAggregate = queryChannelsFromD1;
