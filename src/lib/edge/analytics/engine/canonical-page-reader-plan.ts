import { buildBrowserVersionBreakdownPlan } from "@/lib/edge/analytics/engine/browser-version-breakdown-report-plan";
import {
  buildOverviewChannelsPlan,
  buildOverviewClientDimensionsPlan,
  buildOverviewGeoDimensionsPlan,
} from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import {
  buildDimensionPagePlan,
  dimensionPageSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import { buildJourneyGeoPageVisitCompatibilityPlan } from "@/lib/edge/analytics/engine/journey-geo-report-plan";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  buildPageCardDetailsPlan,
  buildPageCardTitlesPlan,
  buildPageCardTrendPlan,
} from "@/lib/edge/analytics/engine/page-card-details-report-plan";
import {
  buildPageCardMetricsPlan,
  buildPageCardMetricsRollupPlan,
} from "@/lib/edge/analytics/engine/page-card-metrics-report-plan";
import {
  type PageReaderConsumer,
  pageReaderProfile,
} from "@/lib/edge/analytics/engine/page-membership-reader-catalog";
import {
  buildPagesPagePlan,
  buildTopPagesPlan,
} from "@/lib/edge/analytics/engine/page-report-plan";
import { buildPageTabsPlan } from "@/lib/edge/analytics/engine/page-tabs-report-plan";
import { buildPagesWithTabsPlan } from "@/lib/edge/analytics/engine/pages-with-tabs-report-plan";
import {
  buildPerformanceAllTrendsPlan,
  buildPerformanceCountriesPlan,
  buildPerformanceDashboardPlan,
  buildPerformanceRoutesPlan,
  buildPerformanceSummariesPlan,
  buildPerformanceTrendPlan,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import {
  buildReferrersPagePlan,
  buildReferrerSummaryPlan,
  buildTopReferrersPlan,
} from "@/lib/edge/analytics/engine/referrer-report-plan";
import {
  buildSessionPathPagePlan,
  buildSessionPathTopPlan,
} from "@/lib/edge/analytics/engine/session-path-report-plan";
import {
  buildTechnologyBrowserCrossBreakdownPlan,
  buildTechnologyCrossBreakdownPlan,
} from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import { buildTechnologyRadarPlan } from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import {
  buildTechnologyReferrerChannelTrendPlan,
  buildTechnologyShareTrendPlan,
} from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";

export type CanonicalPageReaderInput = Required<
  Pick<
    Parameters<typeof buildTopPagesPlan>[0],
    | "siteId"
    | "queryTime"
    | "filters"
    | "scopePlan"
    | "qualificationDependencyRefs"
  >
> &
  Pick<Parameters<typeof buildTopPagesPlan>[0], "qualificationSemantics">;

/** Pure finite canonical construction, not admission or an execution capability. */
export function buildCanonicalPageReaderPlan(
  consumer: PageReaderConsumer,
  common: CanonicalPageReaderInput,
): ValidatedLogicalPlan {
  if (!pageReaderProfile(consumer))
    throw new Error("whole_filter_reader_consumer_invalid");
  switch (consumer.kind) {
    case "technology-browser-version":
      return buildBrowserVersionBreakdownPlan({
        ...common,
        pageVisitQualification: true,
        ...consumer.configuration,
      });
    case "pages-top":
      return buildTopPagesPlan({ ...common, ...consumer.configuration });
    case "pages-page":
      return buildPagesPagePlan({ ...common, ...consumer.configuration });
    case "pages-with-tabs":
      return buildPagesWithTabsPlan({ ...common, ...consumer.configuration });
    case "page-tabs":
      return buildPageTabsPlan({ ...common, ...consumer.configuration });
    case "page-card-metrics":
      return buildPageCardMetricsPlan({ ...common, ...consumer.configuration });
    case "page-card-rollup":
      return buildPageCardMetricsRollupPlan({
        ...common,
        ...consumer.configuration,
      });
    case "page-card-titles":
      return buildPageCardTitlesPlan({ ...common, ...consumer.configuration });
    case "page-card-trend":
      return buildPageCardTrendPlan({ ...common, ...consumer.configuration });
    case "page-card-details":
      return buildPageCardDetailsPlan({ ...common, ...consumer.configuration });
    case "performance-summary":
      return buildPerformanceSummariesPlan({
        ...common,
        ...consumer.configuration,
      });
    case "performance-trend":
      return buildPerformanceTrendPlan({
        ...common,
        ...consumer.configuration,
      });
    case "performance-all-trends":
      return buildPerformanceAllTrendsPlan({
        ...common,
        ...consumer.configuration,
      });
    case "performance-routes":
      return buildPerformanceRoutesPlan({
        ...common,
        ...consumer.configuration,
      });
    case "performance-countries":
      return buildPerformanceCountriesPlan({
        ...common,
        ...consumer.configuration,
      });
    case "performance-dashboard":
      return buildPerformanceDashboardPlan({
        ...common,
        ...consumer.configuration,
      });
    case "client-cards":
      return buildOverviewClientDimensionsPlan({
        ...common,
        ...consumer.configuration,
      });
    case "geo-cards":
      return buildOverviewGeoDimensionsPlan({
        ...common,
        ...consumer.configuration,
      });
    case "geo-page-compatibility":
      return buildJourneyGeoPageVisitCompatibilityPlan({
        ...common,
        ...consumer.configuration,
      });
    case "technology-radar":
      return buildTechnologyRadarPlan({
        ...common,
        pageVisitQualification: true,
        ...consumer.configuration,
      });
    case "technology-share":
      return buildTechnologyShareTrendPlan({
        ...common,
        pageVisitQualification: true,
        ...consumer.configuration,
      });
    case "technology-referrer-channel":
      return buildTechnologyReferrerChannelTrendPlan({
        ...common,
        pageVisitQualification: true,
        ...consumer.configuration,
      });
    case "technology-client-cross":
      return buildTechnologyCrossBreakdownPlan({
        ...common,
        pageVisitQualification: true,
        ...consumer.configuration,
      });
    case "technology-browser-cross":
      return buildTechnologyBrowserCrossBreakdownPlan({
        ...common,
        pageVisitQualification: true,
        ...consumer.configuration,
      });
    case "boundary-top":
      return buildSessionPathTopPlan({ ...common, ...consumer.configuration });
    case "boundary-page":
      return buildSessionPathPagePlan({ ...common, ...consumer.configuration });
    case "referrers-top":
      return buildTopReferrersPlan({ ...common, ...consumer.configuration });
    case "referrers-page":
      return buildReferrersPagePlan({ ...common, ...consumer.configuration });
    case "referrers-summary":
      return buildReferrerSummaryPlan({ ...common, ...consumer.configuration });
    case "dimension-page": {
      const selection = dimensionPageSelection(
        consumer.configuration.dimension,
      );
      if (!selection) throw Error("missing canonical dimension selection");
      return buildDimensionPagePlan({
        ...common,
        ...consumer.configuration,
        selection,
      });
    }
    case "channels-list":
      return buildOverviewChannelsPlan({
        ...common,
        ...consumer.configuration,
      });
  }
}
