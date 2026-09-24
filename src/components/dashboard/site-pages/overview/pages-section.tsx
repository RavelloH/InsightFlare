import { type MouseEvent, useCallback, useMemo, useState } from "react";
import { RiArrowRightUpLine, RiSearchLine } from "@remixicon/react";

import {
  TabbedDataTableCard,
  type TabbedDataTableColumn,
  type TabbedDataTableLoader,
  type TabbedDataTableRowAdapter,
  type TabbedDataTableTab,
} from "@/components/dashboard/common/tabbed-data-table-card";
import { TrafficChannelIcon } from "@/components/dashboard/common/traffic-channel-icon";
import {
  LazyGeoCityBreadcrumbLabel,
  LazyGeoRegionBreadcrumbLabel,
} from "@/components/dashboard/geo/lazy-geo-location-label";
import {
  DeviceMeta,
  InlineMeta,
} from "@/components/dashboard/journeys/journey-display";
import { useDashboardQuery } from "@/components/dashboard/shell/dashboard-query-provider";
import { PageDetailDrawer } from "@/components/dashboard/site-pages/pages/page-detail-drawer";
import { Clickable } from "@/components/ui/clickable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  fetchOverviewClientDimensionTab,
  fetchOverviewGeoDimensionTabPage,
  fetchOverviewPageCardTab,
  fetchOverviewSourceCardTab,
} from "@/lib/dashboard/client/data/index";
import {
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/dashboard/client/history";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import {
  dashboardFilterValue,
  serializeDashboardSearchParams,
  setDashboardFilterValue,
  withDashboardFilterSearchParams,
} from "@/lib/dashboard/filter-state";
import { numberFormat } from "@/lib/dashboard/format";
import { normalizePagePath } from "@/lib/dashboard/page-detail";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  type FilterScope,
  filterScopePreferenceFromDocument,
} from "@/lib/filter-contract/index";
import { type FilterDocument } from "@/lib/filter-contract/index";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { usePathname, useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";

import {
  comparisonLabelForQuery,
  useOverviewComparisonQuery,
} from "./metrics-data";
import {
  buildClientDimensionRows,
  buildGeoDimensionRows,
  buildPageCardExportRows,
  buildSourceCardExportRows,
  ComparisonMetricToggle,
  createOverviewComparisonColumns,
  loadLocalOverviewTablePage,
  overviewTabData,
} from "./overview-card-data";
import {
  buildGeoPagePath,
  buildPagesPagePath,
  canonicalizeGeoFilterValue,
  CLIENT_DIMENSION_CARD_FILTER_CONTROL_BY_TAB,
  CLIENT_DIMENSION_CARD_TABS,
  GEO_AUX_FILTER_CONTROL_BY_TAB,
  GEO_DIMENSION_CARD_TABS,
  isGeoLocationTab,
  isPageCardDetailTab,
  PAGE_CARD_DETAIL_TAB_LIST,
  PAGE_CARD_FILTER_CONTROL_BY_TAB,
  PAGE_CARD_NAVIGABLE_TAB_LIST,
  PAGE_CARD_TABS,
  resolveGeoLocationHighlightValue,
  resolveGeoLocationQueryValue,
  resolvePageCardDetailPath,
  SOURCE_CARD_FILTER_CONTROL_BY_TAB,
  SOURCE_CARD_TABS,
} from "./overview-filter-model";
import {
  LabelWithLeadingIcon,
  LabelWithOptionalIcon,
  resolvePageCardTargetUrl,
} from "./overview-labels";
import { sanitizeHostname } from "./overview-url";
import {
  type ClientDimensionCardTab,
  type GeoDimensionCardTab,
  type OverviewComparisonMetric,
  type OverviewPagesSectionCardKind,
  type OverviewPagesSectionProps,
  type PageCardDetailClickResolver,
  type PageCardDetailTab,
  type PageCardNavigableTab,
  type PageCardRow,
  type PageCardSortKey,
  type PageCardTab,
  type PageCardTabMeta,
  type SourceCardRow,
  type SourceCardTab,
} from "./types";
export function OverviewPagesSection({
  locale,
  messages,
  siteId,
  siteDomain,
  pathname,
  filters,
  resolvedScope,
  cardDataOverride,
  comparisonEnabled = true,
  tableContentTransitionKey,
  visibleCards,
  showSourceLinkTab = true,
  pageCardTabs,
  pageCardTabMetaOverride,
  pageCardFilterEnabledOverride,
  pageCardNavigableTabs,
  pageCardDetailTabs,
  pageCardFetchers,
  sourceCardFetchers,
  clientCardFetchers,
  geoCardFetchers,
  pageCardTargetUrlResolvers,
  pageCardDetailPathResolvers,
  pageCardDetailClickResolvers,
  pageCardShowVisitors = true,
  primaryMetricLabel,
  geoPageBasePathname,
  sectionClassName,
}: OverviewPagesSectionProps) {
  const router = useRouter();
  const searchParams = useLiveSearchParams();
  const livePathname = usePathname() || pathname;
  const [pageDetailPath, setPageDetailPath] = useState<string | null>(null);
  const { window } = useDashboardQuery();
  const comparisonQuery = useOverviewComparisonQuery(
    window,
    filters,
    comparisonEnabled,
  );
  const resolvedPageCardTabs = useMemo(
    () => pageCardTabs ?? PAGE_CARD_TABS,
    [pageCardTabs],
  );
  const resolvedVisibleCards = useMemo(
    () =>
      new Set<OverviewPagesSectionCardKind>(
        visibleCards ?? ["page", "source", "client", "geo"],
      ),
    [visibleCards],
  );
  const timezoneReferenceTimestampMs = useMemo(() => {
    const from = Number(window.from ?? 0);
    const to = Number(window.to ?? 0);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return Date.now();
    if (to <= from) return Math.max(0, Math.floor(from));
    return Math.floor(from + (to - from) / 2);
  }, [window.from, window.to]);
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonKey = useMemo(
    () =>
      comparisonQuery
        ? `${comparisonQuery.mode}:${comparisonQuery.window.from}:${comparisonQuery.window.to}:${filterQueryKey(comparisonQuery.filters)}`
        : "none",
    [comparisonQuery],
  );
  const entityScopedOutput =
    resolvedScope === "session" ||
    resolvedScope === "visitor" ||
    (resolvedScope === undefined &&
      (filterScopePreferenceFromDocument(filters) === "session" ||
        filterScopePreferenceFromDocument(filters) === "visitor"));
  const hasCardDataOverride = Boolean(cardDataOverride);
  const cardDataOverrideKey = useMemo(
    () => (cardDataOverride ? JSON.stringify(cardDataOverride) : "remote"),
    [cardDataOverride],
  );
  const resolvedSourceCardTabs = useMemo(() => {
    const hasChannelData =
      cardDataOverride?.source.channel !== undefined ||
      Boolean(sourceCardFetchers?.channel) ||
      (!hasCardDataOverride && !sourceCardFetchers);
    const tabs = hasChannelData
      ? SOURCE_CARD_TABS
      : SOURCE_CARD_TABS.filter((tab) => tab !== "channel");
    return showSourceLinkTab ? tabs : tabs.filter((tab) => tab !== "link");
  }, [
    cardDataOverride?.source.channel,
    hasCardDataOverride,
    showSourceLinkTab,
    sourceCardFetchers,
  ]);
  const resolvedPageCardNavigableTabs = useMemo(
    () =>
      new Set<PageCardNavigableTab>(
        pageCardNavigableTabs ?? PAGE_CARD_NAVIGABLE_TAB_LIST,
      ),
    [pageCardNavigableTabs],
  );
  const resolvedPageCardDetailTabs = useMemo(
    () =>
      new Set<PageCardDetailTab>(
        pageCardDetailTabs ?? PAGE_CARD_DETAIL_TAB_LIST,
      ),
    [pageCardDetailTabs],
  );
  const pageCardFilterEnabledByTab = useMemo<Record<PageCardTab, boolean>>(
    () => ({
      path: true,
      query: true,
      title: true,
      hostname: true,
      entry: true,
      exit: true,
      ...(pageCardFilterEnabledOverride ?? {}),
    }),
    [pageCardFilterEnabledOverride],
  );

  const noDataText = messages.common.noData;

  const pageCardTabMeta = useMemo<Record<PageCardTab, PageCardTabMeta>>(
    () => ({
      path: {
        label: messages.common.path,
        columnLabel: messages.common.path,
        mono: true,
        showIcon: false,
        ...(pageCardTabMetaOverride?.path ?? {}),
      },
      query: {
        label: messages.pages.queryTab,
        columnLabel: messages.pages.queryTab,
        mono: true,
        showIcon: false,
        ...(pageCardTabMetaOverride?.query ?? {}),
      },
      title: {
        label: messages.common.title,
        columnLabel: messages.common.title,
        mono: false,
        showIcon: false,
        ...(pageCardTabMetaOverride?.title ?? {}),
      },
      hostname: {
        label: messages.common.hostname,
        columnLabel: messages.common.hostname,
        mono: true,
        showIcon: true,
        ...(pageCardTabMetaOverride?.hostname ?? {}),
      },
      entry: {
        label: messages.common.entryPage,
        columnLabel: messages.common.entryPage,
        mono: true,
        showIcon: false,
        ...(pageCardTabMetaOverride?.entry ?? {}),
      },
      exit: {
        label: messages.common.exitPage,
        columnLabel: messages.common.exitPage,
        mono: true,
        showIcon: false,
        ...(pageCardTabMetaOverride?.exit ?? {}),
      },
    }),
    [
      messages.common.entryPage,
      messages.common.exitPage,
      messages.common.hostname,
      messages.common.path,
      messages.common.title,
      messages.pages.queryTab,
      pageCardTabMetaOverride,
    ],
  );
  const pageCardFilterValue = useCallback(
    (tab: PageCardTab) =>
      dashboardFilterValue(filters, PAGE_CARD_FILTER_CONTROL_BY_TAB[tab]) ??
      null,
    [filters],
  );
  const pageCardDefaultHostname = useMemo(() => {
    const filteredHostname = sanitizeHostname(
      dashboardFilterValue(filters, "hostname") ?? "",
    );
    if (filteredHostname.length > 0) return filteredHostname;

    const configuredHostname = sanitizeHostname(siteDomain);
    if (configuredHostname.length > 0) return configuredHostname;

    return "";
  }, [filters, siteDomain]);
  const pageDetailBasePath = useMemo(
    () => buildPagesPagePath(pathname),
    [pathname],
  );
  const pageDetailContentPathname = useMemo(
    () => pageDetailBasePath.replace(/\/pages$/, "") || pathname,
    [pageDetailBasePath, pathname],
  );
  const sourceCardTabMeta = useMemo<
    Record<
      SourceCardTab,
      { label: string; columnLabel: string; mono: boolean; showIcon: boolean }
    >
  >(
    () => ({
      domain: {
        label: messages.overview.sourceTab,
        columnLabel: messages.overview.sourceDomainColumn,
        mono: true,
        showIcon: true,
      },
      link: {
        label: messages.overview.sourceLinkTab,
        columnLabel: messages.overview.sourceLinkColumn,
        mono: true,
        showIcon: true,
      },
      channel: {
        label: messages.overview.channelTab,
        columnLabel: messages.overview.channelColumn,
        mono: false,
        showIcon: true,
      },
    }),
    [
      messages.overview.channelColumn,
      messages.overview.channelTab,
      messages.overview.sourceDomainColumn,
      messages.overview.sourceLinkColumn,
      messages.overview.sourceLinkTab,
      messages.overview.sourceTab,
    ],
  );
  const sourceCardFilterValue = useCallback(
    (tab: SourceCardTab) =>
      dashboardFilterValue(filters, SOURCE_CARD_FILTER_CONTROL_BY_TAB[tab]) ??
      null,
    [filters],
  );
  const clientDimensionCardTabMeta = useMemo<
    Record<
      ClientDimensionCardTab,
      { label: string; columnLabel: string; mono: boolean }
    >
  >(
    () => ({
      browser: {
        label: messages.common.browser,
        columnLabel: messages.common.browser,
        mono: false,
      },
      osVersion: {
        label: messages.common.operatingSystem,
        columnLabel: messages.common.operatingSystem,
        mono: false,
      },
      deviceType: {
        label: messages.common.deviceType,
        columnLabel: messages.common.deviceType,
        mono: false,
      },
      language: {
        label: messages.common.language,
        columnLabel: messages.common.language,
        mono: false,
      },
      screenSize: {
        label: messages.common.screenSize,
        columnLabel: messages.common.screenSize,
        mono: true,
      },
    }),
    [
      messages.common.browser,
      messages.common.deviceType,
      messages.common.language,
      messages.common.operatingSystem,
      messages.common.screenSize,
    ],
  );
  const geoDimensionCardTabMeta = useMemo<
    Record<
      GeoDimensionCardTab,
      { label: string; columnLabel: string; mono: boolean }
    >
  >(
    () => ({
      country: {
        label: messages.geo.countryLabel,
        columnLabel: messages.geo.countryLabel,
        mono: false,
      },
      region: {
        label: messages.geo.regionLabel,
        columnLabel: messages.geo.regionLabel,
        mono: false,
      },
      city: {
        label: messages.geo.cityLabel,
        columnLabel: messages.geo.cityLabel,
        mono: false,
      },
      continent: {
        label: messages.common.continent,
        columnLabel: messages.common.continent,
        mono: false,
      },
      timezone: {
        label: messages.common.timezone,
        columnLabel: messages.common.timezone,
        mono: false,
      },
      organization: {
        label: messages.common.organization,
        columnLabel: messages.common.organization,
        mono: false,
      },
    }),
    [
      messages.common.continent,
      messages.common.organization,
      messages.common.timezone,
      messages.geo.cityLabel,
      messages.geo.countryLabel,
      messages.geo.regionLabel,
    ],
  );
  const resolvedPrimaryMetricLabel =
    primaryMetricLabel ?? messages.common.views;
  const clientDimensionCardFilterValue = useCallback(
    (tab: ClientDimensionCardTab) =>
      dashboardFilterValue(
        filters,
        CLIENT_DIMENSION_CARD_FILTER_CONTROL_BY_TAB[tab],
      ) ?? null,
    [filters],
  );
  const geoDimensionCardFilterValue = useCallback(
    (tab: GeoDimensionCardTab) => {
      if (isGeoLocationTab(tab)) {
        return canonicalizeGeoFilterValue(dashboardFilterValue(filters, "geo"));
      }
      return (
        dashboardFilterValue(filters, GEO_AUX_FILTER_CONTROL_BY_TAB[tab]) ??
        null
      );
    },
    [filters],
  );

  const setPageCardFilter = useCallback(
    (tab: PageCardTab, value: string | null) => {
      if (!pageCardFilterEnabledByTab[tab]) return;
      const nextFilters = setDashboardFilterValue(
        filters,
        PAGE_CARD_FILTER_CONTROL_BY_TAB[tab],
        value,
      );
      const params = withDashboardFilterSearchParams(searchParams, nextFilters);
      const current = serializeDashboardSearchParams(searchParams);
      const updated = serializeDashboardSearchParams(params);
      if (updated === current) return;
      const target = updated ? `${livePathname}?${updated}` : livePathname;
      replaceUrlWithoutNavigation(target);
    },
    [filters, livePathname, pageCardFilterEnabledByTab, searchParams],
  );
  const setSourceCardFilter = useCallback(
    (tab: SourceCardTab, value: string | null) => {
      const nextFilters = setDashboardFilterValue(
        filters,
        SOURCE_CARD_FILTER_CONTROL_BY_TAB[tab],
        value,
      );
      const params = withDashboardFilterSearchParams(searchParams, nextFilters);
      const current = serializeDashboardSearchParams(searchParams);
      const updated = serializeDashboardSearchParams(params);
      if (updated === current) return;
      const target = updated ? `${livePathname}?${updated}` : livePathname;
      replaceUrlWithoutNavigation(target);
    },
    [filters, livePathname, searchParams],
  );
  const setClientDimensionCardFilter = useCallback(
    (tab: ClientDimensionCardTab, value: string | null) => {
      const nextFilters = setDashboardFilterValue(
        filters,
        CLIENT_DIMENSION_CARD_FILTER_CONTROL_BY_TAB[tab],
        value,
      );
      const params = withDashboardFilterSearchParams(searchParams, nextFilters);
      const current = serializeDashboardSearchParams(searchParams);
      const updated = serializeDashboardSearchParams(params);
      if (updated === current) return;
      const target = updated ? `${livePathname}?${updated}` : livePathname;
      replaceUrlWithoutNavigation(target);
    },
    [filters, livePathname, searchParams],
  );
  const setGeoDimensionCardFilter = useCallback(
    (tab: GeoDimensionCardTab, value: string | null) => {
      const filterControl = isGeoLocationTab(tab)
        ? "geo"
        : GEO_AUX_FILTER_CONTROL_BY_TAB[tab];
      const filterValue =
        value !== null && isGeoLocationTab(tab)
          ? canonicalizeGeoFilterValue(value)
          : value;
      const nextFilters = setDashboardFilterValue(
        filters,
        filterControl,
        filterValue,
      );
      const params = withDashboardFilterSearchParams(searchParams, nextFilters);
      const current = serializeDashboardSearchParams(searchParams);
      const updated = serializeDashboardSearchParams(params);
      if (updated === current) return;
      const target = updated ? `${livePathname}?${updated}` : livePathname;
      replaceUrlWithoutNavigation(target);
    },
    [filters, livePathname, searchParams],
  );
  const openPageCardRowTarget = useCallback(
    (targetUrl: string, event: MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      globalThis.window.open(targetUrl, "_blank", "noopener,noreferrer");
    },
    [],
  );
  const openPageCardRowDetail = useCallback(
    (detailPath: string, event: MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      setPageDetailPath(normalizePagePath(detailPath));
    },
    [],
  );
  const openPageCardRowDetailAction = useCallback(
    (
      detailAction: PageCardDetailClickResolver,
      detailParams: Parameters<PageCardDetailClickResolver>[0],
      event: MouseEvent<HTMLElement>,
    ) => {
      event.stopPropagation();
      detailAction(detailParams);
    },
    [],
  );
  const openGeoDimensionLocationTarget = useCallback(
    (targetUrl: string, event: MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      router.push(targetUrl);
    },
    [router],
  );
  const [pageComparisonMetric, setPageComparisonMetric] =
    useState<OverviewComparisonMetric>("views");
  const [sourceComparisonMetric, setSourceComparisonMetric] =
    useState<OverviewComparisonMetric>("views");
  const [clientComparisonMetric, setClientComparisonMetric] =
    useState<OverviewComparisonMetric>("views");
  const [geoComparisonMetric, setGeoComparisonMetric] =
    useState<OverviewComparisonMetric>("views");
  const comparisonLabel = comparisonLabelForQuery(messages, comparisonQuery);
  const pageComparisonColumns = useMemo(
    () =>
      createOverviewComparisonColumns(
        pageComparisonMetric,
        comparisonLabel,
        locale,
        messages,
      ),
    [comparisonLabel, locale, messages, pageComparisonMetric],
  );
  const sourceComparisonColumns = useMemo(
    () =>
      createOverviewComparisonColumns(
        sourceComparisonMetric,
        comparisonLabel,
        locale,
        messages,
      ),
    [comparisonLabel, locale, messages, sourceComparisonMetric],
  );
  const clientComparisonColumns = useMemo(
    () =>
      createOverviewComparisonColumns(
        clientComparisonMetric,
        comparisonLabel,
        locale,
        messages,
      ),
    [clientComparisonMetric, comparisonLabel, locale, messages],
  );
  const geoComparisonColumns = useMemo(
    () =>
      createOverviewComparisonColumns(
        geoComparisonMetric,
        comparisonLabel,
        locale,
        messages,
      ),
    [comparisonLabel, geoComparisonMetric, locale, messages],
  );
  const overviewMetricColumns = useMemo<
    readonly TabbedDataTableColumn<PageCardRow, PageCardSortKey, string>[]
  >(
    () => [
      {
        key: "views",
        label: resolvedPrimaryMetricLabel,
        getValue: (row) => row.views,
        format: (value) => numberFormat(locale, value),
      },
      {
        key: "visitors",
        label: messages.common.visitors,
        getValue: (row) => row.visitors,
        format: (value) => numberFormat(locale, value),
      },
    ],
    [locale, messages.common.visitors, resolvedPrimaryMetricLabel],
  );
  const pageCardMetricColumns = useMemo<
    (
      tab: PageCardTab,
    ) => readonly TabbedDataTableColumn<
      PageCardRow,
      PageCardSortKey,
      PageCardTab
    >[]
  >(
    () => (tab) => {
      if (comparisonQuery) return pageComparisonColumns;
      const viewsColumn = {
        key: "views" as const,
        label:
          pageCardTabMeta[tab].primaryMetricLabel ?? resolvedPrimaryMetricLabel,
        getValue: (row: PageCardRow) => row.views,
        format: (value: number) => numberFormat(locale, value),
      };
      if (!pageCardShowVisitors) return [viewsColumn];
      return [
        viewsColumn,
        {
          key: "visitors",
          label: messages.common.visitors,
          getValue: (row) => row.visitors,
          format: (value) => numberFormat(locale, value),
        },
      ];
    },
    [
      comparisonQuery,
      locale,
      messages.common.visitors,
      pageCardShowVisitors,
      pageCardTabMeta,
      pageComparisonColumns,
      resolvedPrimaryMetricLabel,
    ],
  );
  const pageCardTableTabs = useMemo(
    () =>
      (resolvedPageCardTabs.length > 0
        ? resolvedPageCardTabs
        : (["path"] as PageCardTab[])
      ).map((tab) => ({
        value: tab,
        label: pageCardTabMeta[tab].label,
        columnLabel: pageCardTabMeta[tab].columnLabel,
      })) as [
        TabbedDataTableTab<PageCardTab>,
        ...TabbedDataTableTab<PageCardTab>[],
      ],
    [pageCardTabMeta, resolvedPageCardTabs],
  );
  const sourceCardTableTabs = useMemo(
    () =>
      resolvedSourceCardTabs.map((tab) => ({
        value: tab,
        label: sourceCardTabMeta[tab].label,
        columnLabel: sourceCardTabMeta[tab].columnLabel,
      })) as [
        TabbedDataTableTab<SourceCardTab>,
        ...TabbedDataTableTab<SourceCardTab>[],
      ],
    [resolvedSourceCardTabs, sourceCardTabMeta],
  );
  const clientDimensionCardTableTabs = useMemo(
    () =>
      CLIENT_DIMENSION_CARD_TABS.map((tab) => ({
        value: tab,
        label: clientDimensionCardTabMeta[tab].label,
        columnLabel: clientDimensionCardTabMeta[tab].columnLabel,
      })) as [
        TabbedDataTableTab<ClientDimensionCardTab>,
        ...TabbedDataTableTab<ClientDimensionCardTab>[],
      ],
    [clientDimensionCardTabMeta],
  );
  const geoDimensionCardTableTabs = useMemo(
    () =>
      GEO_DIMENSION_CARD_TABS.map((tab) => ({
        value: tab,
        label: geoDimensionCardTabMeta[tab].label,
        columnLabel: geoDimensionCardTabMeta[tab].columnLabel,
      })) as [
        TabbedDataTableTab<GeoDimensionCardTab>,
        ...TabbedDataTableTab<GeoDimensionCardTab>[],
      ],
    [geoDimensionCardTabMeta],
  );
  const sourceCardDirectLabel = messages.overview.direct;
  const pageCardLoader = useCallback<
    TabbedDataTableLoader<PageCardTab, PageCardRow, PageCardSortKey>
  >(
    async ({ tab, cursor, limit, search, sort, signal }) => {
      const requestMetric = comparisonQuery
        ? pageComparisonMetric
        : sort.key === "visitors"
          ? "visitors"
          : "views";
      const comparisonSortBy =
        comparisonQuery &&
        (sort.key === "current" ||
          sort.key === "reference" ||
          sort.key === "change")
          ? sort.key
          : undefined;
      const rawPage =
        cardDataOverride && !comparisonQuery
          ? loadLocalOverviewTablePage(
              cardDataOverride.page[tab],
              sort,
              tab,
              limit,
              cursor,
              search,
            )
          : await (
              pageCardFetchers?.[tab] ??
              ((
                requestedSiteId: string,
                requestedWindow: TimeWindow,
                requestedFilters: FilterDocument,
                scope?: FilterScope,
                options?: {
                  limit?: number;
                  cursor?: string | null;
                  search?: string;
                  sort?: "views" | "visitors" | "sessions";
                  direction?: "asc" | "desc";
                  comparisonMetric?: "views" | "visitors";
                  comparisonSortBy?: "current" | "reference" | "change";
                  comparison?: {
                    mode: "same" | "previous";
                    window: TimeWindow;
                    filters: FilterDocument;
                  } | null;
                  signal?: AbortSignal;
                },
              ) =>
                fetchOverviewPageCardTab(
                  requestedSiteId,
                  requestedWindow,
                  tab,
                  requestedFilters,
                  { ...options, resolvedScope: scope },
                ))
            )(siteId, window, filters, resolvedScope, {
              limit,
              cursor,
              search,
              sort: requestMetric,
              direction: sort.direction,
              comparison: comparisonQuery,
              comparisonMetric: comparisonQuery
                ? pageComparisonMetric
                : undefined,
              comparisonSortBy,
              signal,
            });
      const page = overviewTabData(rawPage);
      const fallbackLabel =
        pageCardTabMeta[tab].label === messages.pages.hashTab
          ? messages.pages.noHash
          : undefined;
      return {
        items: buildPageCardExportRows(
          tab,
          page.items,
          messages,
          fallbackLabel,
        ),
        pagination: page.pagination,
      };
    },
    [
      cardDataOverride,
      filters,
      messages,
      pageCardFetchers,
      pageCardTabMeta,
      comparisonQuery,
      pageComparisonMetric,
      resolvedScope,
      siteId,
      window,
    ],
  );
  const sourceCardLoader = useCallback<
    TabbedDataTableLoader<SourceCardTab, SourceCardRow, PageCardSortKey>
  >(
    async ({ tab, cursor, limit, search, sort, signal }) => {
      const requestMetric = comparisonQuery
        ? sourceComparisonMetric
        : sort.key === "visitors"
          ? "visitors"
          : "views";
      const comparisonSortBy =
        comparisonQuery &&
        (sort.key === "current" ||
          sort.key === "reference" ||
          sort.key === "change")
          ? sort.key
          : undefined;
      const rawPage =
        cardDataOverride && !comparisonQuery
          ? loadLocalOverviewTablePage(
              cardDataOverride.source[tab] ?? [],
              sort,
              tab,
              limit,
              cursor,
              search,
            )
          : await (
              sourceCardFetchers?.[tab] ??
              ((
                requestedSiteId: string,
                requestedWindow: TimeWindow,
                requestedFilters: FilterDocument,
                scope?: FilterScope,
                options?: {
                  limit?: number;
                  cursor?: string | null;
                  search?: string;
                  sort?: "views" | "visitors" | "sessions";
                  direction?: "asc" | "desc";
                  comparisonMetric?: "views" | "visitors";
                  comparisonSortBy?: "current" | "reference" | "change";
                  comparison?: {
                    mode: "same" | "previous";
                    window: TimeWindow;
                    filters: FilterDocument;
                  } | null;
                  signal?: AbortSignal;
                },
              ) =>
                fetchOverviewSourceCardTab(
                  requestedSiteId,
                  requestedWindow,
                  tab,
                  requestedFilters,
                  { ...options, resolvedScope: scope },
                ))
            )(siteId, window, filters, resolvedScope, {
              limit,
              cursor,
              search,
              sort: requestMetric,
              direction: sort.direction,
              comparison: comparisonQuery,
              comparisonMetric: comparisonQuery
                ? sourceComparisonMetric
                : undefined,
              comparisonSortBy,
              signal,
            });
      const page = overviewTabData(rawPage);
      return {
        items: buildSourceCardExportRows(
          tab,
          page.items,
          sourceCardDirectLabel,
          messages.overview.channelLabels,
        ),
        pagination: page.pagination,
      };
    },
    [
      cardDataOverride,
      filters,
      messages.overview.channelLabels,
      comparisonQuery,
      sourceComparisonMetric,
      resolvedScope,
      siteId,
      sourceCardDirectLabel,
      sourceCardFetchers,
      window,
    ],
  );
  const clientDimensionCardLoader = useCallback<
    TabbedDataTableLoader<ClientDimensionCardTab, PageCardRow, PageCardSortKey>
  >(
    async ({ tab, cursor, limit, search, sort, signal }) => {
      const requestMetric = comparisonQuery
        ? clientComparisonMetric
        : sort.key === "visitors"
          ? "visitors"
          : "views";
      const comparisonSortBy =
        comparisonQuery &&
        (sort.key === "current" ||
          sort.key === "reference" ||
          sort.key === "change")
          ? sort.key
          : undefined;
      const rawPage =
        cardDataOverride && !comparisonQuery
          ? loadLocalOverviewTablePage(
              cardDataOverride.client[tab],
              sort,
              tab,
              limit,
              cursor,
              search,
            )
          : await (
              clientCardFetchers?.[tab] ??
              ((
                requestedSiteId: string,
                requestedWindow: TimeWindow,
                requestedFilters: FilterDocument,
                scope?: FilterScope,
                options?: {
                  limit?: number;
                  cursor?: string | null;
                  search?: string;
                  sort?: "views" | "visitors" | "sessions";
                  direction?: "asc" | "desc";
                  comparisonMetric?: "views" | "visitors";
                  comparisonSortBy?: "current" | "reference" | "change";
                  comparison?: {
                    mode: "same" | "previous";
                    window: TimeWindow;
                    filters: FilterDocument;
                  } | null;
                  signal?: AbortSignal;
                },
              ) =>
                fetchOverviewClientDimensionTab(
                  requestedSiteId,
                  requestedWindow,
                  tab,
                  requestedFilters,
                  { ...options, resolvedScope: scope },
                ))
            )(siteId, window, filters, resolvedScope, {
              limit,
              cursor,
              search,
              sort: requestMetric,
              direction: sort.direction,
              comparison: comparisonQuery,
              comparisonMetric: comparisonQuery
                ? clientComparisonMetric
                : undefined,
              comparisonSortBy,
              signal,
            });
      const page = overviewTabData(rawPage);
      return {
        items: buildClientDimensionRows(tab, page.items, locale, messages),
        pagination: page.pagination,
      };
    },
    [
      cardDataOverride,
      clientCardFetchers,
      filters,
      locale,
      messages,
      comparisonQuery,
      clientComparisonMetric,
      resolvedScope,
      siteId,
      window,
    ],
  );
  const geoDimensionCardLoader = useCallback<
    TabbedDataTableLoader<GeoDimensionCardTab, PageCardRow, PageCardSortKey>
  >(
    async ({ tab, cursor, limit, search, sort, signal }) => {
      const requestMetric = comparisonQuery
        ? geoComparisonMetric
        : sort.key === "visitors"
          ? "visitors"
          : "views";
      const comparisonSortBy =
        comparisonQuery &&
        (sort.key === "current" ||
          sort.key === "reference" ||
          sort.key === "change")
          ? sort.key
          : undefined;
      const rawPage =
        cardDataOverride && !comparisonQuery
          ? loadLocalOverviewTablePage(
              cardDataOverride.geo[tab],
              sort,
              tab,
              limit,
              cursor,
              search,
            )
          : await (
              geoCardFetchers?.[tab] ??
              ((
                requestedSiteId: string,
                requestedWindow: TimeWindow,
                requestedFilters: FilterDocument,
                scope?: FilterScope,
                options?: {
                  limit?: number;
                  cursor?: string | null;
                  search?: string;
                  sort?: "views" | "visitors" | "sessions";
                  direction?: "asc" | "desc";
                  comparisonMetric?: "views" | "visitors";
                  comparisonSortBy?: "current" | "reference" | "change";
                  comparison?: {
                    mode: "same" | "previous";
                    window: TimeWindow;
                    filters: FilterDocument;
                  } | null;
                  signal?: AbortSignal;
                },
              ) =>
                fetchOverviewGeoDimensionTabPage(
                  requestedSiteId,
                  requestedWindow,
                  tab,
                  requestedFilters,
                  { ...options, resolvedScope: scope },
                ))
            )(siteId, window, filters, resolvedScope, {
              limit,
              cursor,
              search,
              sort: requestMetric,
              direction: sort.direction,
              comparison: comparisonQuery,
              comparisonMetric: comparisonQuery
                ? geoComparisonMetric
                : undefined,
              comparisonSortBy,
              signal,
            });
      const page = overviewTabData(rawPage);
      return {
        items: buildGeoDimensionRows(
          tab,
          page.items,
          locale,
          messages,
          timezoneReferenceTimestampMs,
        ),
        pagination: page.pagination,
      };
    },
    [
      cardDataOverride,
      comparisonQuery,
      geoComparisonMetric,
      filters,
      geoCardFetchers,
      locale,
      messages,
      resolvedScope,
      siteId,
      timezoneReferenceTimestampMs,
      window,
    ],
  );
  const searchConfig = useMemo(
    () => ({
      actionLabel: messages.common.search,
      placeholder: (tab: { label: string }) =>
        formatI18nTemplate(messages.overview.searchInTab, { tab: tab.label }),
    }),
    [messages.common.search, messages.overview.searchInTab],
  );
  const pageCardLabel = useCallback(
    (item: PageCardRow, tab: PageCardTab) => {
      const displayLabel = item.displayLabel ?? item.label;
      const rowTargetUrl = resolvedPageCardNavigableTabs.has(
        tab as PageCardNavigableTab,
      )
        ? (pageCardTargetUrlResolvers?.[tab] ?? resolvePageCardTargetUrl)({
            tab,
            value: item.label,
            unknownLabel: messages.common.unknown,
            fallbackHostname: pageCardDefaultHostname,
          })
        : null;
      const rowDetailAction =
        isPageCardDetailTab(tab) && resolvedPageCardDetailTabs.has(tab)
          ? (pageCardDetailClickResolvers?.[tab] ?? null)
          : null;
      const rowDetailPath =
        !rowDetailAction &&
        isPageCardDetailTab(tab) &&
        resolvedPageCardDetailTabs.has(tab)
          ? (pageCardDetailPathResolvers?.[tab] ?? resolvePageCardDetailPath)({
              tab,
              basePath: pageDetailBasePath,
              value: item.label,
              unknownLabel: messages.common.unknown,
            })
          : null;
      const rowDetailParams =
        rowDetailAction && isPageCardDetailTab(tab)
          ? {
              tab: tab as PageCardDetailTab,
              basePath: pageDetailBasePath,
              value: item.label,
              unknownLabel: messages.common.unknown,
            }
          : null;
      const meta = pageCardTabMeta[tab];

      return (
        <span
          className={cn(
            "inline-flex items-center gap-2 break-words",
            meta.mono && "font-mono",
          )}
        >
          <LabelWithOptionalIcon
            label={displayLabel}
            showIcon={meta.showIcon}
            unknownLabel={messages.common.unknown}
          />
          {rowTargetUrl ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Clickable
                  className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                  onClick={(event) =>
                    openPageCardRowTarget(rowTargetUrl, event)
                  }
                  aria-label={`${messages.common.open}: ${displayLabel}`}
                >
                  <RiArrowRightUpLine size="1.4em" />
                </Clickable>
              </TooltipTrigger>
              <TooltipContent>
                {`${messages.common.open}: ${displayLabel}`}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {rowDetailAction && rowDetailParams ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Clickable
                  className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                  onClick={(event) =>
                    openPageCardRowDetailAction(
                      rowDetailAction,
                      rowDetailParams,
                      event,
                    )
                  }
                  aria-label={messages.common.search}
                >
                  <RiSearchLine size="1.2em" />
                </Clickable>
              </TooltipTrigger>
              <TooltipContent>{messages.common.search}</TooltipContent>
            </Tooltip>
          ) : rowDetailPath ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Clickable
                  className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                  onClick={(event) =>
                    openPageCardRowDetail(rowDetailPath, event)
                  }
                  aria-label={messages.common.search}
                >
                  <RiSearchLine size="1.2em" />
                </Clickable>
              </TooltipTrigger>
              <TooltipContent>{messages.common.search}</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      );
    },
    [
      messages.common.search,
      messages.common.unknown,
      pageCardDefaultHostname,
      pageCardDetailClickResolvers,
      pageCardDetailPathResolvers,
      pageCardTabMeta,
      pageCardTargetUrlResolvers,
      pageDetailBasePath,
      openPageCardRowDetail,
      resolvedPageCardDetailTabs,
      resolvedPageCardNavigableTabs,
    ],
  );
  const geoDimensionRowLocationTarget = useCallback(
    (tab: GeoDimensionCardTab, item: PageCardRow) => {
      const rowLocationValue = resolveGeoLocationQueryValue(
        tab,
        item,
        messages.common.unknown,
      );
      return rowLocationValue
        ? `${buildGeoPagePath(geoPageBasePathname ?? livePathname)}?${new URLSearchParams(
            { location: rowLocationValue },
          ).toString()}`
        : null;
    },
    [geoPageBasePathname, livePathname, messages.common.unknown],
  );
  const filterPageCardRows = useCallback(
    (rows: readonly PageCardRow[], tab: PageCardTab) => {
      const filterValue = pageCardFilterValue(tab);
      return !entityScopedOutput &&
        pageCardFilterEnabledByTab[tab] &&
        filterValue
        ? rows.filter((row) => (row.filterValue ?? row.label) === filterValue)
        : [...rows];
    },
    [entityScopedOutput, pageCardFilterEnabledByTab, pageCardFilterValue],
  );
  const filterSourceCardRows = useCallback(
    (rows: readonly SourceCardRow[], tab: SourceCardTab) => {
      const filterValue = sourceCardFilterValue(tab);
      return !entityScopedOutput && filterValue
        ? rows.filter((row) => row.filterValue === filterValue)
        : [...rows];
    },
    [entityScopedOutput, sourceCardFilterValue],
  );
  const filterClientDimensionCardRows = useCallback(
    (rows: readonly PageCardRow[], tab: ClientDimensionCardTab) => {
      const filterValue = clientDimensionCardFilterValue(tab);
      return !entityScopedOutput && filterValue
        ? rows.filter((row) => (row.filterValue ?? row.label) === filterValue)
        : [...rows];
    },
    [clientDimensionCardFilterValue, entityScopedOutput],
  );
  const filterGeoDimensionCardRows = useCallback(
    (rows: readonly PageCardRow[], tab: GeoDimensionCardTab) => {
      const filterValue = geoDimensionCardFilterValue(tab);
      if (entityScopedOutput || !filterValue) {
        return [...rows];
      }
      const activeGeoFilterValue = isGeoLocationTab(tab)
        ? resolveGeoLocationHighlightValue(tab, filterValue)
        : filterValue;
      if (!activeGeoFilterValue) return [...rows];
      return rows.filter(
        (row) => (row.filterValue ?? row.label) === activeGeoFilterValue,
      );
    },
    [entityScopedOutput, geoDimensionCardFilterValue],
  );
  const tableExport = useMemo(
    () => ({ labels: messages.common.tableExport }),
    [messages.common.tableExport],
  );
  const pageCardRowAdapter = useMemo<
    TabbedDataTableRowAdapter<PageCardRow, PageCardTab, PageCardSortKey>
  >(
    () => ({
      renderLabel: (row, { tab, source }) =>
        source === "search" ? (
          <span
            className={cn(
              "inline-flex items-center gap-2 break-words",
              pageCardTabMeta[tab].mono && "font-mono",
            )}
          >
            <LabelWithOptionalIcon
              label={row.label}
              showIcon={pageCardTabMeta[tab].showIcon}
              unknownLabel={messages.common.unknown}
            />
          </span>
        ) : (
          pageCardLabel(row, tab)
        ),
      getSearchText: (row) => row.label,
      getExportLabel: (row) => row.label,
      getActive: (row, tab) =>
        pageCardFilterValue(tab) === (row.filterValue ?? row.label),
      getInteractive: (row, tab) =>
        pageCardFilterEnabledByTab[tab] ||
        Boolean(
          resolvedPageCardNavigableTabs.has(tab as PageCardNavigableTab)
            ? (pageCardTargetUrlResolvers?.[tab] ?? resolvePageCardTargetUrl)({
                tab,
                value: row.label,
                unknownLabel: messages.common.unknown,
                fallbackHostname: pageCardDefaultHostname,
              })
            : null,
        ) ||
        (isPageCardDetailTab(tab) && resolvedPageCardDetailTabs.has(tab)),
      onClick: (row, { tab }) => {
        const rowFilterValue = row.filterValue ?? row.label;
        if (pageCardFilterEnabledByTab[tab]) {
          const normalized = rowFilterValue.trim();
          setPageCardFilter(
            tab,
            pageCardFilterValue(tab) === normalized ? null : normalized,
          );
          return;
        }

        const rowTargetUrl = resolvedPageCardNavigableTabs.has(
          tab as PageCardNavigableTab,
        )
          ? (pageCardTargetUrlResolvers?.[tab] ?? resolvePageCardTargetUrl)({
              tab,
              value: row.label,
              unknownLabel: messages.common.unknown,
              fallbackHostname: pageCardDefaultHostname,
            })
          : null;
        if (rowTargetUrl) {
          globalThis.window.open(rowTargetUrl, "_blank", "noopener,noreferrer");
          return;
        }

        const rowDetailAction =
          isPageCardDetailTab(tab) && resolvedPageCardDetailTabs.has(tab)
            ? (pageCardDetailClickResolvers?.[tab] ?? null)
            : null;
        if (rowDetailAction && isPageCardDetailTab(tab)) {
          rowDetailAction({
            tab,
            basePath: pageDetailBasePath,
            value: row.label,
            unknownLabel: messages.common.unknown,
          });
          return;
        }

        const rowDetailPath =
          isPageCardDetailTab(tab) && resolvedPageCardDetailTabs.has(tab)
            ? (pageCardDetailPathResolvers?.[tab] ?? resolvePageCardDetailPath)(
                {
                  tab,
                  basePath: pageDetailBasePath,
                  value: row.label,
                  unknownLabel: messages.common.unknown,
                },
              )
            : null;
        if (rowDetailPath) {
          setPageDetailPath(normalizePagePath(rowDetailPath));
        }
      },
    }),
    [
      messages.common.unknown,
      pageCardDefaultHostname,
      pageCardDetailClickResolvers,
      pageCardDetailPathResolvers,
      pageCardFilterEnabledByTab,
      pageCardLabel,
      pageCardTabMeta,
      pageCardTargetUrlResolvers,
      pageDetailBasePath,
      pageCardFilterValue,
      resolvedPageCardDetailTabs,
      resolvedPageCardNavigableTabs,
      router,
      setPageCardFilter,
    ],
  );
  const sourceCardRowAdapter = useMemo<
    TabbedDataTableRowAdapter<SourceCardRow, SourceCardTab, PageCardSortKey>
  >(
    () => ({
      renderLabel: (row, { tab, source }) => {
        const displayLabel =
          source === "search" ? row.label : (row.displayLabel ?? row.label);
        if (tab === "channel" && row.channelId) {
          return (
            <InlineMeta
              icon={<TrafficChannelIcon channel={row.channelId} />}
              label={displayLabel}
            />
          );
        }
        return (
          <span
            className={cn(
              "inline-flex items-center gap-2 break-words",
              row.mono && "font-mono",
            )}
          >
            <LabelWithOptionalIcon
              label={displayLabel}
              showIcon={sourceCardTabMeta[tab].showIcon}
              unknownLabel={sourceCardDirectLabel}
            />
            {source !== "search" && row.targetUrl ? (
              <Clickable
                className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                onClick={(event) =>
                  openPageCardRowTarget(row.targetUrl!, event)
                }
                aria-label={`${messages.common.open}: ${displayLabel}`}
              >
                <RiArrowRightUpLine size="1.4em" />
              </Clickable>
            ) : null}
          </span>
        );
      },
      getSearchText: (row) => row.label,
      getExportLabel: (row) => row.label,
      getActive: (row, tab) =>
        sourceCardFilterValue(tab) !== null &&
        sourceCardFilterValue(tab) === row.filterValue,
      getInteractive: () => true,
      onClick: (row, { tab }) => {
        const normalized = row.filterValue.trim();
        setSourceCardFilter(
          tab,
          sourceCardFilterValue(tab) === normalized ? null : normalized,
        );
      },
    }),
    [
      openPageCardRowTarget,
      setSourceCardFilter,
      sourceCardFilterValue,
      sourceCardDirectLabel,
      sourceCardTabMeta,
    ],
  );
  const clientDimensionCardRowAdapter = useMemo<
    TabbedDataTableRowAdapter<
      PageCardRow,
      ClientDimensionCardTab,
      PageCardSortKey
    >
  >(
    () => ({
      renderLabel: (row, { tab, source }) =>
        tab === "deviceType" ? (
          <DeviceMeta
            deviceType={row.rawLabel ?? row.label}
            deviceLabels={messages.common.deviceLabels}
            unknownLabel={messages.common.unknown}
          />
        ) : (
          <span className={cn(row.mono && "font-mono")}>
            <LabelWithLeadingIcon
              label={
                source === "search"
                  ? row.rawLabel?.trim() || row.label
                  : row.label
              }
              iconName={row.iconName}
            />
          </span>
        ),
      getSearchText: (row) => row.rawLabel?.trim() || row.label,
      getExportLabel: (row) => row.rawLabel?.trim() || row.label,
      getActive: (row, tab) =>
        clientDimensionCardFilterValue(tab) === (row.filterValue ?? row.label),
      getInteractive: () => true,
      onClick: (row, { tab }) => {
        const normalized = (row.filterValue ?? row.label).trim();
        setClientDimensionCardFilter(
          tab,
          clientDimensionCardFilterValue(tab) === normalized
            ? null
            : normalized,
        );
      },
    }),
    [
      clientDimensionCardFilterValue,
      messages.common.deviceLabels,
      messages.common.unknown,
      setClientDimensionCardFilter,
    ],
  );
  const geoDimensionCardRowAdapter = useMemo<
    TabbedDataTableRowAdapter<PageCardRow, GeoDimensionCardTab, PageCardSortKey>
  >(
    () => ({
      renderLabel: (row, { tab, source }) => {
        const rowLocationTarget =
          source === "search" ? null : geoDimensionRowLocationTarget(tab, row);
        return (
          <span
            className={cn(
              "inline-flex items-center gap-2 break-words",
              row.mono && "font-mono",
            )}
          >
            {source === "search" ? (
              <LabelWithLeadingIcon
                label={row.rawLabel?.trim() || row.label}
                iconName={row.iconName}
              />
            ) : tab === "region" && row.regionBreadcrumb ? (
              <LazyGeoRegionBreadcrumbLabel
                locale={locale}
                countryLabel={row.regionBreadcrumb.countryLabel}
                countryIconName={row.regionBreadcrumb.countryIconName}
                regionLabel={row.regionBreadcrumb.regionLabel}
                countryCode={row.regionBreadcrumb.countryCode}
                stateCode={row.regionBreadcrumb.stateCode}
                hideRegion={row.regionBreadcrumb.hideRegion}
              />
            ) : tab === "city" && row.cityBreadcrumb ? (
              <LazyGeoCityBreadcrumbLabel
                locale={locale}
                countryLabel={row.cityBreadcrumb.countryLabel}
                countryIconName={row.cityBreadcrumb.countryIconName}
                regionLabel={row.cityBreadcrumb.regionLabel}
                cityLabel={row.cityBreadcrumb.cityLabel}
                countryCode={row.cityBreadcrumb.countryCode}
                stateCode={row.cityBreadcrumb.stateCode}
                cityNameDefault={row.cityBreadcrumb.cityNameDefault}
                hideRegion={row.cityBreadcrumb.hideRegion}
                hideCity={row.cityBreadcrumb.hideCity}
              />
            ) : (
              <LabelWithLeadingIcon label={row.label} iconName={row.iconName} />
            )}
            {rowLocationTarget ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Clickable
                    className="inline-flex text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                    onClick={(event) =>
                      openGeoDimensionLocationTarget(rowLocationTarget, event)
                    }
                    aria-label={messages.common.search}
                  >
                    <RiSearchLine size="1.2em" />
                  </Clickable>
                </TooltipTrigger>
                <TooltipContent>{messages.common.search}</TooltipContent>
              </Tooltip>
            ) : null}
          </span>
        );
      },
      getSearchText: (row) => row.rawLabel?.trim() || row.label,
      getExportLabel: (row) => row.rawLabel?.trim() || row.label,
      getActive: (row, tab) => {
        const filterValue = geoDimensionCardFilterValue(tab);
        const activeGeoHighlightValue = isGeoLocationTab(tab)
          ? resolveGeoLocationHighlightValue(tab, filterValue)
          : filterValue;
        return activeGeoHighlightValue === (row.filterValue ?? row.label);
      },
      getInteractive: () => true,
      onClick: (row, { tab }) => {
        const normalized = (row.filterValue ?? row.label).trim();
        setGeoDimensionCardFilter(
          tab,
          geoDimensionCardFilterValue(tab) === normalized ? null : normalized,
        );
      },
    }),
    [
      geoDimensionRowLocationTarget,
      geoDimensionCardFilterValue,
      locale,
      messages.common.search,
      openGeoDimensionLocationTarget,
      setGeoDimensionCardFilter,
    ],
  );
  return (
    <>
      <section
        className={cn(
          "grid items-stretch gap-6 xl:grid-cols-2",
          sectionClassName,
        )}
      >
        {resolvedVisibleCards.has("page") ? (
          <div className="min-w-0">
            <TabbedDataTableCard<PageCardTab, PageCardRow, PageCardSortKey>
              tabs={pageCardTableTabs}
              loader={pageCardLoader}
              contentTransitionKey={tableContentTransitionKey}
              defaultSort={
                comparisonQuery
                  ? { key: "current", direction: "desc" }
                  : undefined
              }
              requestKey={`${siteId}:${window.from}:${window.to}:${window.interval}:${window.timeZone}:${filtersKey}:${comparisonKey}:${locale}:page:${pageComparisonMetric}:${hasCardDataOverride ? cardDataOverrideKey : "remote"}`}
              columns={pageCardMetricColumns}
              rowAdapter={pageCardRowAdapter}
              filterRows={filterPageCardRows}
              sortActionLabel={(label) =>
                formatI18nTemplate(messages.common.sortBy, { label })
              }
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              search={searchConfig}
              export={tableExport}
              headerRight={
                comparisonQuery ? (
                  <ComparisonMetricToggle
                    metric={pageComparisonMetric}
                    messages={messages}
                    onMetricChange={setPageComparisonMetric}
                  />
                ) : null
              }
              className="h-full"
            />
          </div>
        ) : null}

        {resolvedVisibleCards.has("source") ? (
          <div className="min-w-0">
            <TabbedDataTableCard<SourceCardTab, SourceCardRow, PageCardSortKey>
              tabs={sourceCardTableTabs}
              loader={sourceCardLoader}
              contentTransitionKey={tableContentTransitionKey}
              defaultSort={
                comparisonQuery
                  ? { key: "current", direction: "desc" }
                  : undefined
              }
              requestKey={`${siteId}:${window.from}:${window.to}:${window.interval}:${window.timeZone}:${filtersKey}:${comparisonKey}:${locale}:source:${sourceComparisonMetric}:${hasCardDataOverride ? cardDataOverrideKey : "remote"}`}
              columns={
                comparisonQuery
                  ? sourceComparisonColumns
                  : overviewMetricColumns
              }
              rowAdapter={sourceCardRowAdapter}
              filterRows={filterSourceCardRows}
              sortActionLabel={(label) =>
                formatI18nTemplate(messages.common.sortBy, { label })
              }
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              search={searchConfig}
              export={tableExport}
              headerRight={
                comparisonQuery ? (
                  <ComparisonMetricToggle
                    metric={sourceComparisonMetric}
                    messages={messages}
                    onMetricChange={setSourceComparisonMetric}
                  />
                ) : null
              }
              className="h-full"
            />
          </div>
        ) : null}

        {resolvedVisibleCards.has("client") ? (
          <div className="min-w-0">
            <TabbedDataTableCard<
              ClientDimensionCardTab,
              PageCardRow,
              PageCardSortKey
            >
              tabs={clientDimensionCardTableTabs}
              loader={clientDimensionCardLoader}
              contentTransitionKey={tableContentTransitionKey}
              defaultSort={
                comparisonQuery
                  ? { key: "current", direction: "desc" }
                  : undefined
              }
              requestKey={`${siteId}:${window.from}:${window.to}:${window.interval}:${window.timeZone}:${filtersKey}:${comparisonKey}:${locale}:client:${clientComparisonMetric}:${hasCardDataOverride ? cardDataOverrideKey : "remote"}`}
              columns={
                comparisonQuery
                  ? clientComparisonColumns
                  : overviewMetricColumns
              }
              rowAdapter={clientDimensionCardRowAdapter}
              filterRows={filterClientDimensionCardRows}
              sortActionLabel={(label) =>
                formatI18nTemplate(messages.common.sortBy, { label })
              }
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              search={searchConfig}
              export={tableExport}
              headerRight={
                comparisonQuery ? (
                  <ComparisonMetricToggle
                    metric={clientComparisonMetric}
                    messages={messages}
                    onMetricChange={setClientComparisonMetric}
                  />
                ) : null
              }
              className="h-full"
            />
          </div>
        ) : null}

        {resolvedVisibleCards.has("geo") ? (
          <div className="min-w-0">
            <TabbedDataTableCard<
              GeoDimensionCardTab,
              PageCardRow,
              PageCardSortKey
            >
              tabs={geoDimensionCardTableTabs}
              loader={geoDimensionCardLoader}
              contentTransitionKey={tableContentTransitionKey}
              defaultSort={
                comparisonQuery
                  ? { key: "current", direction: "desc" }
                  : undefined
              }
              requestKey={`${siteId}:${window.from}:${window.to}:${window.interval}:${window.timeZone}:${filtersKey}:${comparisonKey}:${locale}:geo:${geoComparisonMetric}:${hasCardDataOverride ? cardDataOverrideKey : "remote"}`}
              columns={
                comparisonQuery ? geoComparisonColumns : overviewMetricColumns
              }
              rowAdapter={geoDimensionCardRowAdapter}
              filterRows={filterGeoDimensionCardRows}
              sortActionLabel={(label) =>
                formatI18nTemplate(messages.common.sortBy, { label })
              }
              loadingLabel={messages.common.loading}
              emptyLabel={noDataText}
              search={searchConfig}
              export={tableExport}
              headerRight={
                comparisonQuery ? (
                  <ComparisonMetricToggle
                    metric={geoComparisonMetric}
                    messages={messages}
                    onMetricChange={setGeoComparisonMetric}
                  />
                ) : null
              }
              className="h-full"
            />
          </div>
        ) : null}
      </section>

      {pageDetailPath ? (
        <PageDetailDrawer
          locale={locale}
          messages={messages}
          siteId={siteId}
          siteDomain={siteDomain}
          pathname={pageDetailContentPathname}
          pagePath={pageDetailPath}
          onOpenChange={(open) => {
            if (!open) setPageDetailPath(null);
          }}
        />
      ) : null}
    </>
  );
}
