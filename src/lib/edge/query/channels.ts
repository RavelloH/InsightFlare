import {
  buildDomainDiscoverySqlPredicate,
  buildTaggedCampaignSqlPredicate,
  buildUtmMediumSqlPredicate,
  type TrafficChannelId,
  UTM_CHANNEL_MEDIUMS,
} from "@/lib/analytics/traffic-channel-rules";
import type { Env } from "@/lib/edge/types";

import type { FilterDocument, QueryWindow } from "./core";
import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  visitSourceBindings,
} from "./core";

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
  const mappedMediums = (
    Object.keys(UTM_CHANNEL_MEDIUMS) as Array<keyof typeof UTM_CHANNEL_MEDIUMS>
  )
    .map(
      (channel) =>
        `WHEN ${buildUtmMediumSqlPredicate(channel)} THEN '${channel}'`,
    )
    .join("\n    ");

  return `CASE
    WHEN ${buildDomainDiscoverySqlPredicate("organic_search")} THEN 'organic_search'
    WHEN ${buildDomainDiscoverySqlPredicate("social")} THEN 'social'
    ${mappedMediums}
    WHEN ${buildTaggedCampaignSqlPredicate()} THEN 'campaign'
    WHEN TRIM(COALESCE(referrer_host, '')) != '' THEN 'referral'
    WHEN TRIM(COALESCE(utm_source, '')) = ''
      AND TRIM(COALESCE(utm_medium, '')) = ''
      AND TRIM(COALESCE(utm_campaign, '')) = ''
      AND TRIM(COALESCE(referrer_host, '')) = '' THEN 'direct'
    ELSE 'other'
  END`;
}

export async function queryChannelsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
): Promise<ChannelAggregateRow[]> {
  const filter = buildVisitFilterSql(filters);
  const channelExpression = buildTrafficChannelCaseSql();
  const sql = `
WITH
${buildVisitSourceCte()},
filtered_visits AS (
  SELECT *
  FROM visit_source
  ${filter.clause}
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
      ...visitSourceBindings(siteId, window),
      ...filter.bindings,
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
