import type { QueryTime } from "@/lib/edge/analytics/contract";
import type { buildBrowserVersionBreakdownPlan } from "@/lib/edge/analytics/engine/browser-version-breakdown-report-plan";
import { BROWSER_VERSION_BREAKDOWN_OUTPUT } from "@/lib/edge/analytics/engine/browser-version-breakdown-report-plan";
import type {
  buildOverviewChannelsPlan,
  buildOverviewClientDimensionsPlan,
  buildOverviewGeoDimensionsPlan,
} from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import {
  OVERVIEW_CHANNELS_REPORT_OUTPUT,
  OVERVIEW_CLIENT_DIMENSION_OUTPUTS,
  OVERVIEW_GEO_DIMENSION_OUTPUTS,
} from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import type { buildDimensionPagePlan } from "@/lib/edge/analytics/engine/dimension-report-plan";
import type { buildJourneyGeoPageVisitCompatibilityPlan } from "@/lib/edge/analytics/engine/journey-geo-report-plan";
import {
  JOURNEY_GEO_PAGE_COMPATIBILITY_POINTS_OUTPUT,
  JOURNEY_GEO_PAGE_COMPATIBILITY_SUMMARY_OUTPUT,
  JOURNEY_GEO_POINTS_OUTPUT,
} from "@/lib/edge/analytics/engine/journey-geo-report-plan";
import type {
  buildPageCardDetailsPlan,
  buildPageCardTitlesPlan,
  buildPageCardTrendPlan,
} from "@/lib/edge/analytics/engine/page-card-details-report-plan";
import {
  PAGE_CARD_DETAILS_MULTI_OUTPUT_IDS,
  PAGE_CARD_DETAILS_OUTPUT_IDS,
} from "@/lib/edge/analytics/engine/page-card-details-report-plan";
import type {
  buildPageCardMetricsPlan,
  buildPageCardMetricsRollupPlan,
} from "@/lib/edge/analytics/engine/page-card-metrics-report-plan";
import {
  PAGE_CARD_METRICS_OUTPUT_ID,
  PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID,
} from "@/lib/edge/analytics/engine/page-card-metrics-report-plan";
import type { PageChannelMembershipReader } from "@/lib/edge/analytics/engine/page-channel-membership-dependency-plan";
import { pageMembershipDimensionContract } from "@/lib/edge/analytics/engine/page-channel-membership-reader-contract";
import type {
  buildPagesPagePlan,
  buildTopPagesPlan,
} from "@/lib/edge/analytics/engine/page-report-plan";
import type { buildPageTabsPlan } from "@/lib/edge/analytics/engine/page-tabs-report-plan";
import { PAGE_TAB_OUTPUT_IDS } from "@/lib/edge/analytics/engine/page-tabs-report-plan";
import type { buildPagesWithTabsPlan } from "@/lib/edge/analytics/engine/pages-with-tabs-report-plan";
import { PAGES_WITH_TABS_OUTPUT_IDS } from "@/lib/edge/analytics/engine/pages-with-tabs-report-plan";
import type {
  buildPerformanceAllTrendsPlan,
  buildPerformanceCountriesPlan,
  buildPerformanceDashboardPlan,
  buildPerformanceRoutesPlan,
  buildPerformanceSummariesPlan,
  buildPerformanceTrendPlan,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import {
  PERFORMANCE_ALL_TRENDS_OUTPUT_IDS,
  PERFORMANCE_COUNTRIES_OUTPUT_IDS,
  PERFORMANCE_DASHBOARD_OUTPUT_IDS,
  PERFORMANCE_ROUTES_OUTPUT_IDS,
  PERFORMANCE_SUMMARY_OUTPUT_ID,
  PERFORMANCE_TREND_OUTPUT_ID,
} from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
import type {
  buildReferrersPagePlan,
  buildReferrerSummaryPlan,
  buildTopReferrersPlan,
} from "@/lib/edge/analytics/engine/referrer-report-plan";
import { REFERRERS_PAGE_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/referrer-report-plan";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type {
  buildSessionPathPagePlan,
  buildSessionPathTopPlan,
} from "@/lib/edge/analytics/engine/session-path-report-plan";
import {
  SESSION_PATH_PAGE_REPORT_OUTPUT,
  SESSION_PATH_TOP_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/session-path-report-plan";
import type {
  buildTechnologyBrowserCrossBreakdownPlan,
  buildTechnologyCrossBreakdownPlan,
} from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import {
  TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS,
  TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS,
} from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import type { buildTechnologyRadarPlan } from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import { TECHNOLOGY_RADAR_OUTPUTS } from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import type {
  buildTechnologyReferrerChannelTrendPlan,
  buildTechnologyShareTrendPlan,
} from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import {
  TECHNOLOGY_SHARE_TREND_DIMENSIONS,
  TECHNOLOGY_SHARE_TREND_OUTPUTS,
} from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import type {
  ExactOutputDescriptor,
  WholeFilterPreparationKey,
} from "@/lib/edge/analytics/engine/whole-filter-reader-contract";

type SharedBuilderFields =
  | "siteId"
  | "queryTime"
  | "filters"
  | "scopePlan"
  | "qualificationDependencyRefs"
  | "preparedTimePolicy"
  | "pageVisitQualification"
  | "qualificationSemantics"
  | "membershipOutput";
type Options<F extends (input: never) => unknown> = Omit<
  Parameters<F>[0],
  SharedBuilderFields
>;
type Reader<K extends string, F extends (input: never) => unknown> = {
  readonly kind: K;
  readonly configuration: Options<F>;
};

/** Configurations already normalized by their existing provider. This is a
 * closed description of output shape, never audience/strategy authorization.
 * In particular, no arbitrary readers[], outputIds or binding limits enter it. */
export type PageReaderConsumer =
  | {
      readonly kind: "technology-browser-version";
      readonly configuration: Options<
        typeof buildBrowserVersionBreakdownPlan
      > & { readonly versionLimit: number };
    }
  | Reader<"pages-top", typeof buildTopPagesPlan>
  | Reader<"pages-page", typeof buildPagesPagePlan>
  | Reader<"pages-with-tabs", typeof buildPagesWithTabsPlan>
  | Reader<"page-tabs", typeof buildPageTabsPlan>
  | Reader<"page-card-metrics", typeof buildPageCardMetricsPlan>
  | Reader<"page-card-rollup", typeof buildPageCardMetricsRollupPlan>
  | Reader<"page-card-titles", typeof buildPageCardTitlesPlan>
  | Reader<"page-card-trend", typeof buildPageCardTrendPlan>
  | Reader<"page-card-details", typeof buildPageCardDetailsPlan>
  | Reader<"performance-summary", typeof buildPerformanceSummariesPlan>
  | Reader<"performance-trend", typeof buildPerformanceTrendPlan>
  | Reader<"performance-all-trends", typeof buildPerformanceAllTrendsPlan>
  | Reader<"performance-routes", typeof buildPerformanceRoutesPlan>
  | Reader<"performance-countries", typeof buildPerformanceCountriesPlan>
  | Reader<"performance-dashboard", typeof buildPerformanceDashboardPlan>
  | Reader<"client-cards", typeof buildOverviewClientDimensionsPlan>
  | Reader<"geo-cards", typeof buildOverviewGeoDimensionsPlan>
  | Reader<
      "geo-page-compatibility",
      typeof buildJourneyGeoPageVisitCompatibilityPlan
    >
  | Reader<"technology-radar", typeof buildTechnologyRadarPlan>
  | Reader<"technology-share", typeof buildTechnologyShareTrendPlan>
  | Reader<
      "technology-referrer-channel",
      typeof buildTechnologyReferrerChannelTrendPlan
    >
  | {
      readonly kind: "technology-client-cross";
      readonly configuration: Omit<
        Options<typeof buildTechnologyCrossBreakdownPlan>,
        "outputIds" | "family"
      > & { readonly family: "client" };
    }
  | Reader<
      "technology-browser-cross",
      typeof buildTechnologyBrowserCrossBreakdownPlan
    >
  | Reader<"boundary-top", typeof buildSessionPathTopPlan>
  | Reader<"boundary-page", typeof buildSessionPathPagePlan>
  | Reader<"referrers-top", typeof buildTopReferrersPlan>
  | Reader<"referrers-page", typeof buildReferrersPagePlan>
  | Reader<"referrers-summary", typeof buildReferrerSummaryPlan>
  | {
      readonly kind: "dimension-page";
      readonly configuration: Extract<
        PageChannelMembershipReader,
        { kind: "dimension-page" }
      > &
        Pick<Parameters<typeof buildDimensionPagePlan>[0], "cursor">;
    }
  | Reader<"channels-list", typeof buildOverviewChannelsPlan>;

export interface PageReaderProfile {
  readonly readerKey: PageReaderConsumer["kind"];
  readonly outputIds: readonly string[];
  readonly planOutputIds: readonly string[];
  /** One Source occurrence in the prepared canonical plan, shared by outputs. */
  readonly sourceRoles: readonly ["page"];
  /** Post-selection inputs are supplied only after the real upstream result. */
  readonly stage: "request" | "selected-page-paths";
}

function profile(
  consumer: PageReaderConsumer,
  ids: readonly string[],
  stage: PageReaderProfile["stage"] = "request",
  planIds: readonly string[] = ids,
): PageReaderProfile {
  return Object.freeze({
    readerKey: consumer.kind,
    outputIds: Object.freeze([...ids]),
    planOutputIds: Object.freeze([...planIds]),
    sourceRoles: Object.freeze(["page"] as const),
    stage,
  });
}
const values = (record: Readonly<Record<string, string>>) =>
  Object.values(record);
const owns = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);

/** A descriptor is not an executable capability. All existing eligibility,
 * preparation, frozen-plan identity and request snapshots remain mandatory. */
export function pageReaderProfile(
  consumer: PageReaderConsumer,
): PageReaderProfile | undefined {
  switch (consumer.kind) {
    case "technology-browser-version":
      return profile(consumer, [BROWSER_VERSION_BREAKDOWN_OUTPUT]);
    case "pages-top":
      return profile(consumer, ["top-pages"], "request", ["top-pages"]);
    case "pages-page":
      return profile(consumer, ["pages-page"]);
    case "pages-with-tabs":
      return profile(consumer, PAGES_WITH_TABS_OUTPUT_IDS);
    case "page-tabs":
      return profile(consumer, PAGE_TAB_OUTPUT_IDS);
    case "page-card-metrics":
      return profile(consumer, [PAGE_CARD_METRICS_OUTPUT_ID]);
    case "page-card-rollup":
      return profile(consumer, [PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID]);
    case "page-card-titles":
      return profile(
        consumer,
        [PAGE_CARD_DETAILS_OUTPUT_IDS.titles],
        "selected-page-paths",
      );
    case "page-card-trend":
      return profile(
        consumer,
        [PAGE_CARD_DETAILS_OUTPUT_IDS.trend],
        "selected-page-paths",
      );
    case "page-card-details":
      return profile(
        consumer,
        PAGE_CARD_DETAILS_MULTI_OUTPUT_IDS,
        "selected-page-paths",
      );
    case "performance-summary":
      return profile(consumer, [PERFORMANCE_SUMMARY_OUTPUT_ID]);
    case "performance-trend":
      return profile(consumer, [PERFORMANCE_TREND_OUTPUT_ID]);
    case "performance-all-trends":
      return profile(consumer, PERFORMANCE_ALL_TRENDS_OUTPUT_IDS);
    case "performance-routes":
      return profile(consumer, PERFORMANCE_ROUTES_OUTPUT_IDS);
    case "performance-countries":
      return profile(consumer, PERFORMANCE_COUNTRIES_OUTPUT_IDS);
    case "performance-dashboard":
      return profile(consumer, PERFORMANCE_DASHBOARD_OUTPUT_IDS);
    case "client-cards":
      return profile(
        consumer,
        OVERVIEW_CLIENT_DIMENSION_OUTPUTS,
        "request",
        OVERVIEW_CLIENT_DIMENSION_OUTPUTS,
      );
    case "geo-cards":
      return profile(
        consumer,
        OVERVIEW_GEO_DIMENSION_OUTPUTS,
        "request",
        OVERVIEW_GEO_DIMENSION_OUTPUTS,
      );
    case "geo-page-compatibility":
      return ["country", "region", "city"].includes(
        consumer.configuration.level,
      )
        ? profile(
            consumer,
            [
              JOURNEY_GEO_PAGE_COMPATIBILITY_POINTS_OUTPUT,
              JOURNEY_GEO_PAGE_COMPATIBILITY_SUMMARY_OUTPUT,
            ],
            "request",
            [
              JOURNEY_GEO_POINTS_OUTPUT,
              `journey-geo-${consumer.configuration.level}-summary`,
              JOURNEY_GEO_PAGE_COMPATIBILITY_POINTS_OUTPUT,
              JOURNEY_GEO_PAGE_COMPATIBILITY_SUMMARY_OUTPUT,
            ],
          )
        : undefined;
    case "technology-radar":
      return owns(TECHNOLOGY_RADAR_OUTPUTS, consumer.configuration.dimension)
        ? profile(consumer, [
            TECHNOLOGY_RADAR_OUTPUTS[consumer.configuration.dimension],
          ])
        : undefined;
    case "technology-share":
      return owns(
        TECHNOLOGY_SHARE_TREND_DIMENSIONS,
        consumer.configuration.dimension,
      )
        ? profile(consumer, values(TECHNOLOGY_SHARE_TREND_OUTPUTS.single))
        : undefined;
    case "technology-referrer-channel":
      return profile(consumer, [
        ...values(TECHNOLOGY_SHARE_TREND_OUTPUTS.source),
        ...values(TECHNOLOGY_SHARE_TREND_OUTPUTS.channel),
      ]);
    case "technology-client-cross":
      return consumer.configuration.family === "client" &&
        !owns(consumer.configuration, "outputIds")
        ? profile(consumer, values(TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS))
        : undefined;
    case "technology-browser-cross":
      return profile(consumer, [
        ...values(TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.operatingSystem),
        ...values(TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.deviceType),
      ]);
    case "boundary-top":
      return consumer.configuration.kind === "entry" ||
        consumer.configuration.kind === "exit"
        ? profile(consumer, [SESSION_PATH_TOP_REPORT_OUTPUT])
        : undefined;
    case "boundary-page":
      return consumer.configuration.kind === "entry" ||
        consumer.configuration.kind === "exit"
        ? profile(consumer, [SESSION_PATH_PAGE_REPORT_OUTPUT])
        : undefined;
    case "referrers-top":
      return profile(consumer, ["referrers-top"], "request", ["referrers-top"]);
    case "referrers-page":
      return profile(consumer, [REFERRERS_PAGE_REPORT_OUTPUT]);
    case "referrers-summary":
      return profile(consumer, ["referrer-summary", "referrer-top-sources"]);
    case "dimension-page":
      return pageMembershipDimensionContract(consumer.configuration.dimension)
        ? profile(consumer, ["dimension-page"])
        : undefined;
    case "channels-list":
      return profile(consumer, [OVERVIEW_CHANNELS_REPORT_OUTPUT]);
    default:
      return undefined;
  }
}

/** Builds only the closed expected output descriptions. The dependencyRef is
 * selected from the already admitted preparation by the shared binder; these
 * data records do not prove the ref is authorized for a request/reader. */
export function describePageReaderOutputs(input: {
  readonly consumer: PageReaderConsumer;
  readonly queryTime: QueryTime;
  readonly preparationKey: WholeFilterPreparationKey;
  readonly dependencyRef: QualificationDependencyRef;
}): readonly ExactOutputDescriptor[] | undefined {
  const selected = pageReaderProfile(input.consumer);
  if (!selected || input.dependencyRef === "event-filter-event-membership-v1")
    return undefined;
  const sources = Object.freeze([
    Object.freeze({
      entity: "page" as const,
      dependencyRef: input.dependencyRef,
    }),
  ]);
  const readerKey = `${input.preparationKey}:${selected.readerKey}`;
  return Object.freeze(
    selected.outputIds.map((outputId) =>
      Object.freeze({
        key: `${readerKey}:${outputId}`,
        readerKey,
        preparationKey: input.preparationKey,
        outputId,
        queryTime: input.queryTime,
        sources,
      }),
    ),
  );
}
