import {
  buildTrafficChannelSqlExpression,
  type TrafficChannelId,
} from "@/lib/analytics/traffic-channel-rules";
import type { Env } from "@/lib/edge/types";

import type { FilterDocument, QueryWindow } from "./core";
import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  visitSourceBindings,
} from "./core";
import { scopedDatasetFor } from "./scoped-dataset";

export interface ChannelAggregateRow {
  readonly channel: TrafficChannelId;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}

/**
 * Keep acquisition classification in SQL so channel metrics use the same
 * visit/filter source and distinct-identity semantics as other aggregates.
 * Domain discovery predicates and UTM medium mappings are imported from the
 * shared traffic-channel rules module; do not duplicate those lists here.
 */
export function buildTrafficChannelCaseSql(): string {
  return buildTrafficChannelSqlExpression();
}

export async function queryChannelsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
): Promise<ChannelAggregateRow[]> {
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = scopedDataset ? null : buildVisitFilterSql(filters);
  const channelExpression = buildTrafficChannelCaseSql();
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM ${scopedDataset?.visitRelation ?? "visit_source"}
  ${filter?.clause ?? ""}
),
channel_rollup AS (
  SELECT
    ${channelExpression} AS channel,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_visits
  GROUP BY channel
)
SELECT channel, views, sessions, visitors
FROM channel_rollup
ORDER BY views DESC, sessions DESC, channel ASC
LIMIT ?
`;

  return (
    await queryD1All<Record<string, unknown>>(env, sql, [
      ...(scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [
            ...visitSourceBindings(siteId, window),
            ...(filter?.bindings ?? []),
          ]),
      limit,
    ])
  ).map((row) => ({
    channel: String(row.channel ?? "other") as TrafficChannelId,
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

/** Naming aligned with the existing page/referrer aggregate adapters. */
export const queryChannelAggregate = queryChannelsFromD1;
