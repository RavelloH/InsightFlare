// @vitest-environment node
import { expect, it } from "vitest";

import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
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
import { type ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
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
  createPageReportSource,
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
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
  pageRoleDependencyRefs,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { validateSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
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
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  bindPageVisitQualificationPreparation,
  createPageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import { projectWholeOriginalMembership } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-projection";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
const queryTime = createQueryTime(100, 200, "UTC", 300);
function prepared(
  root: "advanced" | "native" | "empty" = "advanced",
  scope: "session" | "visitor" = "session",
) {
  const q = prepareScopedQuery("pages", {
    context: siteQueryContext("catalog-site", "private-dashboard"),
    time: queryTime,
    filters: parseFilterDsl("count(page) gt 0", analyticsFilterRegistry),
    scopePreference: scope,
  });
  const filters = q.filters!;
  if (root !== "advanced")
    Object.assign(filters, {
      root:
        root === "empty"
          ? null
          : parseFilterDsl('page.path eq "/a"', analyticsFilterRegistry).root,
    });
  const meta = scopedFilterMetadata(filters);
  if (!meta) throw Error("missing_actual_metadata");
  return {
    siteId: "catalog-site",
    queryTime,
    filters,
    scopePlan: meta.plan,
    qualificationDependencyRefs: pageRoleDependencyRefs(meta.plan),
  };
}
function compileBound(
  plan: ValidatedLogicalPlan,
  input: ReturnType<typeof prepared>,
  whole = false,
) {
  const frozen = snapshotPageVisitQualificationPlan(plan),
    consumerKey = { kind: "scratch-closed-page-shape" };
  const projection = projectWholeOriginalMembership({
    siteIds: [input.siteId],
    mode: "entity",
    matches: [],
  });
  const preparation = createPageVisitQualificationPreparation({
    ...input,
    consumerKey,
    relation: projection.relations.entity!,
    dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
    ...(whole ? { qualificationSemantics: "whole-original" as const } : {}),
  });
  const executionInputs = bindPageVisitQualificationPreparation({
    ...input,
    consumerKey,
    preparation,
    plan: frozen,
    ...(whole ||
    plan.nodes.some(
      (n) =>
        n.kind === "source" && n.selection?.profile !== "prepared-scoped-v1",
    )
      ? { readerQueryTime: input.queryTime }
      : {}),
  });
  const lowerer = new AnalyticsLogicalToDbLowerer(
    frozen,
    { siteIds: [input.siteId], time: frozen.context.time },
    { qualificationExecutionInputs: executionInputs },
  );
  return frozen.outputs.map((output) => {
    const relation = lowerer.projectOutput(
      lowerer.lower(output),
      output.fields.map(({ name, slot }) => ({ name, slot })),
    );
    const sql = compileD1Query(lowerLogicalPlan(relation));
    return { id: output.id, sql: sql.sql, params: sql.bindings ?? [] };
  });
}

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
function build(
  consumer: PageReaderConsumer,
  common: ReturnType<typeof prepared> & {
    readonly qualificationSemantics?: "whole-original";
  },
): ValidatedLogicalPlan {
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

type Leaks = PageReaderConsumer extends infer P
  ? P extends { configuration: infer C }
    ? "qualificationSemantics" extends keyof C
      ? P
      : never
    : never
  : never;
const noConfigurationLeak: [Leaks] extends [never] ? true : never = true;
it.each(
  cases.map((consumer, index) => ({
    consumer,
    label: index + "-" + consumer.kind,
  })),
)(
  "$label explicitly forwards whole-original for each prepared tree and entity scope",
  ({ consumer }) => {
    for (const root of ["advanced", "native", "empty"] as const)
      for (const scope of ["session", "visitor"] as const) {
        const input = prepared(root, scope),
          plan = build(consumer, {
            ...input,
            qualificationSemantics: "whole-original",
          });
        const sources = plan.nodes.filter((n) => n.kind === "source");
        expect(sources).toHaveLength(1);
        expect(sources[0]?.entity).toBe("page");
        expect(sources[0]?.selection?.profile).toBe(
          "prepared-whole-filter-reader-window-v1",
        );
        expect(sources[0]?.selection?.qualificationDependencyRefs).toEqual(
          input.qualificationDependencyRefs,
        );
        expect(sources[0]?.selection?.scope).toBe(scope);
        for (const s of sources)
          validateSemanticScopedSourceSelection(s.selection!, {
            subject: plan.context.subject,
            time: plan.context.time,
          });
        expect(
          () =>
            new AnalyticsLogicalToDbLowerer(plan, {
              siteIds: [input.siteId],
              time: plan.context.time,
            }),
        ).toThrow("qualification_execution_dependency_unbound");
        expect(plan.outputs.map((o) => o.id)).toEqual(
          pageReaderProfile(consumer)!.planOutputIds,
        );
      }
  },
);
it.each(
  cases.map((consumer, index) => ({
    consumer,
    label: `${index}-${consumer.kind}`,
  })),
)("$label explicit whole cannot bypass prepared scope", ({ consumer }) => {
  const input = prepared();
  expect(() =>
    build(consumer, {
      ...input,
      scopePlan: undefined,
      qualificationSemantics: "whole-original",
    } as unknown as Parameters<typeof build>[1]),
  ).toThrow();
});
it("closed configuration excludes common semantics and technology requires the real pageVisitQualification path", () => {
  expect(noConfigurationLeak).toBe(true);
  const input = prepared("empty");
  expect(() =>
    buildTechnologyRadarPlan({
      ...input,
      dimension: "browser",
      qualificationSemantics: "whole-original",
    }),
  ).toThrow("whole_original_dependency_required");
  expect(
    buildTechnologyRadarPlan({
      ...input,
      dimension: "browser",
      pageVisitQualification: true,
      qualificationSemantics: "whole-original",
    }).nodes.filter((n) => n.kind === "source")[0]?.selection
      ?.qualificationDependencyRefs,
  ).toEqual(input.qualificationDependencyRefs);
});
it("common source requires refs, rejects wrong/duplicate roles and an unprepared or alternate source override", () => {
  const input = prepared("empty");
  const base = {
    ...input,
    qualificationSemantics: "whole-original" as const,
    attributes: ["page.report.pathname"],
  };
  for (const refs of [
    undefined,
    [],
    [EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY],
    [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
    [
      ...input.qualificationDependencyRefs,
      ...input.qualificationDependencyRefs,
    ],
  ])
    expect(() =>
      createPageReportSource({ ...base, qualificationDependencyRefs: refs }),
    ).toThrow();
  expect(() =>
    createPageReportSource({ ...base, scopePlan: undefined }),
  ).toThrow("whole_original_requires_prepared_scope_plan");
  const direct = createPageReportSource({
    siteId: input.siteId,
    queryTime,
    filters: { version: 1, root: null },
    attributes: base.attributes,
  }).selection;
  expect(() =>
    createPageReportSource({ ...base, sourceSelection: direct }),
  ).toThrow("whole_original_disallows_selection_override");
  expect(() =>
    createPageReportSource({ ...base, filters: { version: 1, root: null } }),
  ).toThrow();
});
it("omitted flag retains the original advanced-only restriction for prepared native and empty roots", () => {
  for (const root of ["native", "empty"] as const) {
    const input = prepared(root);
    expect(() =>
      createPageReportSource({
        ...input,
        attributes: ["page.report.pathname"],
      }),
    ).toThrow("qualification_dependency_semantics_mismatch");
  }
});

it("existing opaque binder accepts the exact new profile but the flag alone gives no execution authority", () => {
  for (const root of ["advanced", "native", "empty"] as const)
    for (const scope of ["session", "visitor"] as const) {
      const input = prepared(root, scope);
      const plan = buildTopPagesPlan({
        ...input,
        limit: 3,
        includeDetails: false,
        qualificationSemantics: "whole-original",
      });
      expect(compileBound(plan, input, true)).toHaveLength(1);
    }
});
