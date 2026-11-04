import type {
  EpochMs,
  ReportingTimeZone,
} from "@/lib/edge/analytics/contract/types";
import {
  LogicalPlanBuilder,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

export const ADVANCED_FILTER_ACTIVITY_OUTPUT_ID = "advanced-filter-activity";
export const ADVANCED_FILTER_MAX_ACTIVITIES = 20_000;
if (
  !Number.isSafeInteger(ADVANCED_FILTER_MAX_ACTIVITIES) ||
  ADVANCED_FILTER_MAX_ACTIVITIES <= 0
)
  throw new Error("advanced_filter_activity_cap_must_be_positive_safe_integer");

export const ADVANCED_FILTER_EXACT_AGGREGATE_VALUE_LIMIT = Math.floor(
  Number.MAX_SAFE_INTEGER / ADVANCED_FILTER_MAX_ACTIVITIES,
);
export const ADVANCED_FILTER_ACTIVITY_LIMIT =
  ADVANCED_FILTER_MAX_ACTIVITIES + 1;

/** Keep Page / same-site Event eligibility shared by full-row and SQL paths. */
export function eligibleAdvancedFilterActivities(
  builder: LogicalPlanBuilder,
  activities: LogicalRelationHandle,
): LogicalRelationHandle {
  const isPage = builder.compare(
    "eq",
    builder.slot(activities, "attribute:observation.kind"),
    builder.literal("page", { kind: "scalar", scalar: "string" }),
  );
  const hasSameSiteEventName = builder.isNull(
    builder.slot(activities, "attribute:observation.sameSiteEventName"),
    true,
  );
  return builder.filter(activities, builder.or(isPage, hasSameSiteEventName));
}

const ADVANCED_FILTER_ACTIVITY_CONTEXT_FIELDS = [
  ["started_at", "observation.contextPageStartedAt"],
  ["status", "observation.contextPageStatus"],
  ["last_activity_at", "observation.contextPageLastActivityAt"],
  ["ended_at", "observation.contextPageEndedAt"],
  ["finalized_at", "observation.contextPageFinalizedAt"],
  ["duration_ms", "observation.contextPageDurationMs"],
  ["duration_source", "observation.contextPageDurationSource"],
  ["exit_reason", "observation.contextPageExitReason"],
  ["pathname", "observation.contextPagePathname"],
  ["query_string", "observation.contextPageQueryString"],
  ["hash_fragment", "observation.contextPageHash"],
  ["hostname", "observation.contextPageHostname"],
  ["title", "observation.contextPageTitle"],
  ["referrer_url", "observation.contextPageReferrerUrl"],
  ["referrer_host", "observation.contextPageReferrerHost"],
  ["utm_source", "observation.contextPageUtmSource"],
  ["utm_medium", "observation.contextPageUtmMedium"],
  ["utm_campaign", "observation.contextPageUtmCampaign"],
  ["utm_term", "observation.contextPageUtmTerm"],
  ["utm_content", "observation.contextPageUtmContent"],
  ["is_eu", "observation.contextPageIsEU"],
  ["country", "observation.contextPageCountry"],
  ["region", "observation.contextPageRegion"],
  ["region_code", "observation.contextPageRegionCode"],
  ["city", "observation.contextPageCity"],
  ["continent", "observation.contextPageContinent"],
  ["latitude", "observation.contextPageLatitude"],
  ["longitude", "observation.contextPageLongitude"],
  ["postal_code", "observation.contextPagePostalCode"],
  ["metro_code", "observation.contextPageMetroCode"],
  ["timezone", "observation.contextPageTimezone"],
  ["as_organization", "observation.contextPageOrganization"],
  ["ua_raw", "observation.contextPageUserAgent"],
  ["browser", "observation.contextPageBrowser"],
  ["browser_version", "observation.contextPageBrowserVersion"],
  ["os", "observation.contextPageOs"],
  ["os_version", "observation.contextPageOsVersion"],
  ["device_type", "observation.contextPageDeviceType"],
  ["screen_width", "observation.contextPageScreenWidth"],
  ["screen_height", "observation.contextPageScreenHeight"],
  ["language", "observation.contextPageLanguage"],
  ["user_id", "observation.contextPageUserId"],
  ["user_name", "observation.contextPageUserName"],
  ["perf_ttfb_ms", "observation.contextPagePerfTtfbMs"],
  ["perf_fcp_ms", "observation.contextPagePerfFcpMs"],
  ["perf_lcp_ms", "observation.contextPagePerfLcpMs"],
  ["perf_cls", "observation.contextPagePerfCls"],
  ["perf_inp_ms", "observation.contextPagePerfInpMs"],
] as const;

export interface AdvancedFilterActivityRange {
  readonly startMs: number;
  readonly endExclusiveMs: number;
}

export function buildAdvancedFilterActivityPlan(input: {
  readonly subject: SemanticSubjectDomain;
  readonly range: AdvancedFilterActivityRange;
}): ValidatedLogicalPlan {
  if (
    !Number.isSafeInteger(input.range.startMs) ||
    !Number.isSafeInteger(input.range.endExclusiveMs) ||
    input.range.startMs >= input.range.endExclusiveMs
  )
    throw new Error("advanced_filter_activity_invalid_range");

  const range = {
    startMs: input.range.startMs as EpochMs,
    endExclusiveMs: input.range.endExclusiveMs as EpochMs,
  };
  const builder = new LogicalPlanBuilder({
    subject: input.subject,
    time: createSemanticTemporalDomains({
      candidate: range,
      read: { kind: "bounded", range },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: (input.range.endExclusiveMs - 1) as EpochMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });

  const attributes = [
    "observation.id",
    "observation.kind",
    "observation.rawSiteId",
    "observation.sameSiteEventName",
    "observation.sessionId",
    "observation.visitId",
    "observation.visitorId",
    ...ADVANCED_FILTER_ACTIVITY_CONTEXT_FIELDS.map(
      ([, attribute]) => attribute,
    ),
  ];
  const activities = builder.source("observation", {
    temporalDomain: "candidate",
    attributes,
    includeOccurrenceTime: true,
  });
  const eligibleActivities = eligibleAdvancedFilterActivities(
    builder,
    activities,
  );

  const projections = Object.fromEntries([
    ["kind", builder.slot(eligibleActivities, "attribute:observation.kind")],
    ["id", builder.slot(eligibleActivities, "attribute:observation.id")],
    [
      "site_id",
      builder.slot(eligibleActivities, "attribute:observation.rawSiteId"),
    ],
    [
      "visit_id",
      builder.slot(eligibleActivities, "attribute:observation.visitId"),
    ],
    [
      "session_id",
      builder.slot(eligibleActivities, "attribute:observation.sessionId"),
    ],
    [
      "visitor_id",
      builder.slot(eligibleActivities, "attribute:observation.visitorId"),
    ],
    ["time", builder.slot(eligibleActivities, "time")],
    [
      "event_name",
      builder.slot(
        eligibleActivities,
        "attribute:observation.sameSiteEventName",
      ),
    ],
    ...ADVANCED_FILTER_ACTIVITY_CONTEXT_FIELDS.map(([name, attributeId]) => [
      name,
      builder.slot(eligibleActivities, `attribute:${attributeId}`),
    ]),
  ]);
  const projected = builder.project(eligibleActivities, projections);
  const sorted = builder.sort(projected, [
    { slot: "time", direction: "asc", nulls: "first" },
    { slot: "kind", direction: "desc", nulls: "first" },
    { slot: "id", direction: "asc", nulls: "first" },
  ]);
  const limited = builder.limit(sorted, ADVANCED_FILTER_ACTIVITY_LIMIT);
  const outputFields = Object.keys(projections).map((name) => ({
    name,
    slot: name,
  }));
  builder.output(ADVANCED_FILTER_ACTIVITY_OUTPUT_ID, limited, outputFields);
  return builder.finish();
}
