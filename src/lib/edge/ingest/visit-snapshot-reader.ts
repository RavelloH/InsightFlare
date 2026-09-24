import type { TrafficVisitSnapshot } from "@/lib/edge/analytics-engine/index";

import type { IngestSqlAccess } from "./sql-access";

export function readTrafficVisitSnapshot(
  sql: IngestSqlAccess,
  siteId: string,
  visitId: string,
): TrafficVisitSnapshot | null {
  return sql.sqlOne<TrafficVisitSnapshot>(
    `
        SELECT
          site_id AS siteId,
          visit_id AS visitId,
          visitor_id AS visitorId,
          session_id AS sessionId,
          started_at AS startedAt,
          pathname,
          query_string AS queryString,
          hash_fragment AS hashFragment,
          title,
          hostname,
          referrer_url AS referrerUrl,
          referrer_host AS referrerHost,
          utm_source AS utmSource,
          utm_medium AS utmMedium,
          utm_campaign AS utmCampaign,
          utm_term AS utmTerm,
          utm_content AS utmContent,
          region,
          city,
          continent,
          country,
          region_code AS regionCode,
          postal_code AS postalCode,
          metro_code AS metroCode,
          timezone,
          as_organization AS asOrganization,
          browser,
          browser_version AS browserVersion,
          os,
          os_version AS osVersion,
          device_type AS deviceType,
          language,
          latitude,
          longitude,
          screen_width AS screenWidth,
          screen_height AS screenHeight,
          perf_ttfb_ms AS perfTtfbMs,
          perf_fcp_ms AS perfFcpMs,
          perf_lcp_ms AS perfLcpMs,
          perf_cls AS perfCls,
          perf_inp_ms AS perfInpMs
        FROM buffered_visits
        WHERE site_id = ? AND visit_id = ?
        LIMIT 1
      `,
    siteId,
    visitId,
  );
}
