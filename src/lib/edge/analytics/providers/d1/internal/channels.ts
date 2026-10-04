import type { TrafficChannelId } from "@/lib/analytics/traffic-channel-rules";
import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import { buildOverviewChannelsPlan } from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import type { FilterDocument, QueryWindow } from "./core";

export interface ChannelAggregateRow {
  readonly channel: TrafficChannelId;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
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
  return rows.map((row) => ({
    channel: String(row.channel ?? "other") as TrafficChannelId,
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

/** Naming aligned with the existing page/referrer aggregate adapters. */
export const queryChannelAggregate = queryChannelsFromD1;
