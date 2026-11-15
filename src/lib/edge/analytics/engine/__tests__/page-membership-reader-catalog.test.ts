// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { buildBrowserVersionBreakdownPlan } from "@/lib/edge/analytics/engine/browser-version-breakdown-report-plan";
import {
  buildOverviewChannelsPlan,
  buildOverviewClientDimensionsPlan,
  buildOverviewGeoDimensionsPlan,
} from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import {
  buildDimensionPagePlan,
  dimensionPageSelection,
  PAGE_DIMENSION_SELECTIONS,
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
  describePageReaderOutputs,
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
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  pageRoleDependencyRefs,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import {
  buildSessionPathPagePlan,
  buildSessionPathTopPlan,
} from "@/lib/edge/analytics/engine/session-path-report-plan";
import {
  buildTechnologyBrowserCrossBreakdownPlan,
  buildTechnologyCrossBreakdownPlan,
  TECHNOLOGY_CROSS_CLIENT_OTHER_PRIMARY_TOKEN,
  TECHNOLOGY_CROSS_CLIENT_OTHER_SECONDARY_TOKEN,
  TECHNOLOGY_CROSS_CLIENT_UNKNOWN_TOKEN,
} from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import { buildTechnologyRadarPlan } from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import {
  buildTechnologyReferrerChannelTrendPlan,
  buildTechnologyShareTrendPlan,
} from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const time = createQueryTime(100, 200, "UTC", 300);
const prepared = prepareScopedQuery("pages", {
  context: siteQueryContext("catalog-site", "private-dashboard"),
  time,
  filters: parseFilterDsl("count(page) gt 0", analyticsFilterRegistry),
  scopePreference: "session",
});
const metadata = scopedFilterMetadata(prepared.filters!);
if (!metadata) throw Error("missing actual prepared metadata");
const common = {
  siteId: "catalog-site",
  queryTime: time,
  filters: prepared.filters!,
  scopePlan: metadata.plan,
  qualificationDependencyRefs: pageRoleDependencyRefs(metadata.plan),
};
const cases: readonly PageReaderConsumer[] = [
  {
    kind: "technology-browser-version",
    configuration: { browserLimit: 3, versionLimit: 4 },
  },
  { kind: "pages-top", configuration: { limit: 3, includeDetails: false } },
  { kind: "pages-page", configuration: { limit: 3, includeDetails: true } },
  {
    kind: "pages-with-tabs",
    configuration: { limit: 3, includeDetails: true },
  },
  { kind: "page-tabs", configuration: { limit: 3 } },
  { kind: "page-card-metrics", configuration: { limit: 3 } },
  { kind: "page-card-rollup", configuration: {} },
  {
    kind: "page-card-titles",
    configuration: { pathnames: ["/real-selected-path"], titleLimit: 3 },
  },
  {
    kind: "page-card-trend",
    configuration: { pathnames: ["/real-selected-path"], interval: "day" },
  },
  {
    kind: "page-card-details",
    configuration: {
      pathnames: ["/real-selected-path"],
      titleLimit: 3,
      interval: "day",
    },
  },
  { kind: "performance-summary", configuration: {} },
  {
    kind: "performance-trend",
    configuration: { metric: "lcp", interval: "day" },
  },
  { kind: "performance-all-trends", configuration: { interval: "day" } },
  { kind: "performance-routes", configuration: { limit: 3 } },
  { kind: "performance-countries", configuration: {} },
  {
    kind: "performance-dashboard",
    configuration: { routeLimit: 3, interval: "day" },
  },
  { kind: "client-cards", configuration: { limit: 3 } },
  { kind: "geo-cards", configuration: { limit: 3 } },
  {
    kind: "geo-page-compatibility",
    configuration: { level: "country", limit: 3 },
  },
  {
    kind: "geo-page-compatibility",
    configuration: { level: "region", limit: 3 },
  },
  {
    kind: "geo-page-compatibility",
    configuration: { level: "city", limit: 3 },
  },
  { kind: "technology-radar", configuration: { dimension: "browser" } },
  {
    kind: "technology-radar",
    configuration: { dimension: "referrer", limit: 3 },
  },
  {
    kind: "technology-share",
    configuration: { dimension: "browser", limit: 3, interval: "day" },
  },
  {
    kind: "technology-referrer-channel",
    configuration: { limit: 3, interval: "day" },
  },
  {
    kind: "technology-client-cross",
    configuration: {
      family: "client",
      primarySelection: PAGE_DIMENSION_SELECTIONS.operatingSystem,
      secondarySelection: PAGE_DIMENSION_SELECTIONS.deviceType,
      primaryLimit: 3,
      secondaryLimit: 3,
      tokens: {
        unknown: TECHNOLOGY_CROSS_CLIENT_UNKNOWN_TOKEN,
        otherPrimary: TECHNOLOGY_CROSS_CLIENT_OTHER_PRIMARY_TOKEN,
        otherSecondary: TECHNOLOGY_CROSS_CLIENT_OTHER_SECONDARY_TOKEN,
      },
    },
  },
  {
    kind: "technology-browser-cross",
    configuration: {
      browserLimit: 3,
      operatingSystemLimit: 3,
      deviceTypeLimit: 3,
    },
  },
  {
    kind: "boundary-top",
    configuration: {
      kind: "entry",
      limit: 3,
      sortBy: "views",
      sortDirection: "desc",
    },
  },
  {
    kind: "boundary-page",
    configuration: {
      kind: "exit",
      limit: 3,
      sortBy: "views",
      sortDirection: "desc",
    },
  },
  { kind: "referrers-top", configuration: { includeFullUrl: false, limit: 3 } },
  {
    kind: "referrers-page",
    configuration: {
      includeFullUrl: true,
      limit: 3,
      sortBy: "views",
      sortDirection: "desc",
    },
  },
  { kind: "referrers-summary", configuration: { topN: 3 } },
  {
    kind: "dimension-page",
    configuration: {
      kind: "dimension-page",
      dimension: "client.browser",
      limit: 3,
      cursorText: null,
      excludeEmpty: false,
      sortBy: "views",
      sortDirection: "desc",
      audience: "private-dashboard",
    },
  },
  { kind: "channels-list", configuration: { limit: 3 } },
];
function build(consumer: PageReaderConsumer): ValidatedLogicalPlan {
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
describe("closed Page output shape against existing actual canonical builders", () => {
  it.each(
    cases.map((consumer, index) => ({
      consumer,
      label: `${index}-${consumer.kind}`,
    })),
  )("$label", ({ consumer }) => {
    const profile = pageReaderProfile(consumer)!;
    const plan = build(consumer);
    expect(plan.outputs.map((o) => o.id)).toEqual(profile.planOutputIds);
    const sources = plan.nodes.filter((n) => n.kind === "source");
    expect(sources.map((s) => s.entity)).toEqual(profile.sourceRoles);
    for (const source of sources)
      expect(source.selection?.qualificationDependencyRefs).toEqual(
        common.qualificationDependencyRefs,
      );
    expect(plan.context.time).toEqual(
      semanticTemporalDomainsFromQueryTime(time),
    );
    const descriptions = describePageReaderOutputs({
      consumer,
      queryTime: time,
      preparationKey: "original",
      dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
    });
    expect(descriptions).toBeDefined();
    expect(descriptions!.map((d) => d.outputId)).toEqual(profile.outputIds);
    expect(new Set(descriptions!.map((d) => d.readerKey)).size).toBe(1);
    expect(new Set(descriptions!.map((d) => d.sources)).size).toBe(1);
    expect(descriptions![0]?.sources).toEqual([
      {
        entity: "page",
        dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
      },
    ]);
    expect(Object.isFrozen(descriptions)).toBe(true);
  });
  it("does not accept arbitrary dimensions or caller output override", () => {
    expect(
      pageReaderProfile({
        kind: "dimension-page",
        configuration: {
          ...cases.find((c) => c.kind === "dimension-page")!.configuration,
          dimension: "event.name",
        },
      } as PageReaderConsumer),
    ).toBeUndefined();
    expect(
      pageReaderProfile({
        kind: "technology-share",
        configuration: { dimension: "__proto__" },
      } as unknown as PageReaderConsumer),
    ).toBeUndefined();
    expect(
      pageReaderProfile({
        kind: "technology-client-cross",
        configuration: { family: "client", outputIds: { primary: "injected" } },
      } as unknown as PageReaderConsumer),
    ).toBeUndefined();
    expect(
      pageReaderProfile({
        kind: "unknown",
        configuration: {},
      } as unknown as PageReaderConsumer),
    ).toBeUndefined();
  });
  it("keeps selected-path stages late and request outputs immediate", () => {
    for (const c of cases)
      expect(pageReaderProfile(c)?.stage).toBe(
        ["page-card-titles", "page-card-trend", "page-card-details"].includes(
          c.kind,
        )
          ? "selected-page-paths"
          : "request",
      );
  });
  it("separates preparation-side groups and refuses Event-row roles for Page outputs", () => {
    const consumer = cases.find((c) => c.kind === "performance-dashboard")!;
    const describe = (preparationKey: "current" | "reference") =>
      describePageReaderOutputs({
        consumer,
        queryTime: time,
        preparationKey,
        dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
      })!;
    const current = describe("current");
    const reference = describe("reference");
    expect(current).toHaveLength(20);
    expect(
      new Set([...current, ...reference].map((d) => d.readerKey)).size,
    ).toBe(2);
    expect(current.map((d) => d.outputId)).toEqual(
      reference.map((d) => d.outputId),
    );
    expect(
      describePageReaderOutputs({
        consumer,
        queryTime: time,
        preparationKey: "original",
        dependencyRef: "event-filter-event-membership-v1",
      }),
    ).toBeUndefined();
  });
});
