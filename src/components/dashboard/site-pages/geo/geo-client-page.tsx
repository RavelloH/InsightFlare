import { useCallback, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/comparison/use-dashboard-comparison-query";
import { GeoCountryStatsPanel } from "@/components/dashboard/geo/geo-country-stats-panel";
import { useDashboardQuery } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import type { GeoClientMapStageProps } from "@/components/dashboard/site-pages/geo/geo-client-map-stage";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  parentGeoLocationValue,
  parseGeoLocationValue,
} from "@/lib/analytics/geo-location";
import {
  fetchOverviewGeoDimensionTab,
  fetchOverviewGeoPoints,
  type OverviewGeoDimensionTab,
  type OverviewGeoTabRows,
} from "@/lib/dashboard/client/data/index";
import {
  pushUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/dashboard/client/history";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import {
  serializeDashboardSearchParams,
  setDashboardFilterValue,
} from "@/lib/dashboard/filter-state";
import dynamic from "@/lib/dynamic";
import type { FilterDocument } from "@/lib/filter-contract/index";
import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
const GeoClientMapStage = dynamic<GeoClientMapStageProps>(
  () =>
    import("@/components/dashboard/site-pages/geo/geo-client-map-stage").then(
      (module) => module.GeoClientMapStage,
    ),
  {
    ssr: false,
    loading: () => <div className="absolute inset-0 bg-muted/20" />,
  },
);
import {
  buildGeoInvestigationRow,
  buildGeoMarketPenetrationLabel,
  emptyOverviewGeoPoints,
  fetchGeoLocaleBundle,
  fetchGeoWikiSummary,
  formatGeoMarketPenetration,
  type GeoDimensionCount,
  type GeoStatsEntry,
  MAP_VIEWPORT_RENDER_ISOLATION_STYLE,
  normalizeCountryCode,
  resolveFocusedViewState,
  resolveGeoPoints,
  resolveWindowDayCount,
} from "./geo-client-model";
interface GeoClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
}
// World Bank, World, GDP per capita (current US$), most recent value for 2024.

export function GeoClientPage({
  locale,
  messages,
  siteId,
}: GeoClientPageProps) {
  const isMobile = useIsMobile();
  const { window, filters } = useDashboardQuery();
  const comparisonQuery = useDashboardComparisonQuery(window, filters);
  const searchParams = useLiveSearchParams();
  const geoMessages = messages.geo;
  const geoInvestigationMessages = geoMessages.investigation;
  const requestedLocation = useMemo(
    () => parseGeoLocationValue(searchParams.get("location")),
    [searchParams],
  );
  const requestFilters = useMemo<FilterDocument>(
    () =>
      requestedLocation?.canonical
        ? setDashboardFilterValue(filters, "geo", requestedLocation.canonical)
        : filters,
    [filters, requestedLocation?.canonical],
  );
  const requestFiltersKey = useMemo(
    () => filterQueryKey(requestFilters),
    [requestFilters],
  );
  const statsTab: OverviewGeoDimensionTab = requestedLocation
    ? requestedLocation.level === "country"
      ? "region"
      : "city"
    : "country";
  const comparisonRequest = useMemo(() => {
    if (!comparisonQuery) return null;
    const comparisonFilters = requestedLocation?.canonical
      ? setDashboardFilterValue(
          comparisonQuery.filters,
          "geo",
          requestedLocation.canonical,
        )
      : comparisonQuery.filters;
    return {
      ...comparisonQuery,
      filters: comparisonFilters,
    };
  }, [comparisonQuery, requestedLocation?.canonical]);
  const comparisonFiltersKey = useMemo(
    () =>
      comparisonRequest ? filterQueryKey(comparisonRequest.filters) : "none",
    [comparisonRequest],
  );
  const { data: geoData, isFetching: loading } = useQuery({
    queryKey: [
      "dashboard",
      "geo",
      siteId,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      locale,
      requestedLocation?.canonical ?? "",
      requestFiltersKey,
      statsTab,
      comparisonRequest?.mode ?? "none",
      comparisonRequest?.window.from ?? "none",
      comparisonRequest?.window.to ?? "none",
      comparisonRequest?.window.interval ?? "none",
      comparisonRequest?.window.timeZone ?? "none",
      comparisonFiltersKey,
    ],
    queryFn: async ({ signal }) => {
      const [geoPointsData, geoTabRows, geoLocaleBundle] = await Promise.all([
        fetchOverviewGeoPoints(siteId, window, requestFilters, {
          limit: 5000,
          applyGeoFilter: Boolean(requestedLocation?.canonical),
          signal,
        }),
        fetchOverviewGeoDimensionTab(siteId, window, statsTab, requestFilters, {
          limit: statsTab === "city" ? 600 : 400,
          comparison: comparisonRequest,
          comparisonMetric: "views",
          comparisonSortBy: "current",
          signal,
        }),
        fetchGeoLocaleBundle(
          requestedLocation,
          locale,
          messages.common.unknown,
          geoMessages,
        ),
      ]);
      return {
        geoPointsData,
        geoTabRows,
        activeLocation: requestedLocation,
        locationFocus: geoLocaleBundle.focus,
        geoInvestigation: geoLocaleBundle.investigation,
        geoDirectoryEntries: geoLocaleBundle.directoryEntries,
      };
    },
    placeholderData: keepPreviousData,
    enabled: typeof window !== "undefined",
  });
  const geoPointsData = geoData?.geoPointsData ?? emptyOverviewGeoPoints();
  const geoTabRows = geoData?.geoTabRows ?? [];
  const activeLocation = geoData?.activeLocation ?? null;
  const locationFocus = geoData?.locationFocus ?? null;
  const geoInvestigation = geoData?.geoInvestigation ?? null;
  const geoDirectoryEntries = geoData?.geoDirectoryEntries ?? null;
  const wikidataId = geoInvestigation?.wikidataId ?? "";
  const { data: geoWikiSummary } = useQuery({
    queryKey: ["dashboard", "geo-wiki-summary", locale, wikidataId],
    queryFn: () => fetchGeoWikiSummary(wikidataId, locale),
    enabled:
      typeof window !== "undefined" &&
      Boolean(wikidataId) &&
      activeLocation?.level !== "country",
  });

  const points = useMemo(
    () => resolveGeoPoints(geoPointsData, activeLocation),
    [activeLocation, geoPointsData],
  );

  const initialViewState = useMemo(
    () =>
      resolveFocusedViewState(
        points,
        activeLocation,
        locationFocus,
        geoDirectoryEntries?.length ?? 0,
      ),
    [activeLocation, geoDirectoryEntries?.length, locationFocus, points],
  );

  const statsEntries = useMemo<GeoStatsEntry[]>(() => {
    const fallbackRows: GeoDimensionCount[] =
      activeLocation?.level === "country"
        ? geoPointsData.regionCounts
        : geoPointsData.cityCounts;
    const fallbackMap = new globalThis.Map(
      fallbackRows.map((row) => [String(row.value ?? "").trim(), row] as const),
    );
    const sourceMap = new globalThis.Map<string, GeoStatsEntry>();

    for (const row of geoPointsData.countryCounts) {
      const country = normalizeCountryCode(row.country);
      if (!country) continue;
      sourceMap.set(country, {
        key: country,
        label: resolveCountryLabel(country, locale, messages.common.unknown)
          .label,
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      });
    }

    const dimensionSourceRows =
      geoTabRows.length > 0 ? geoTabRows : fallbackRows;
    for (const row of dimensionSourceRows) {
      const key = String(row.value ?? "").trim();
      if (!key) continue;
      const fallback = fallbackMap.get(key);
      sourceMap.set(key, {
        key,
        label: String(row.label ?? "").trim() || messages.common.unknown,
        views: Number(row.views ?? 0) || Number(fallback?.views ?? 0),
        sessions: Number(row.sessions ?? 0) || Number(fallback?.sessions ?? 0),
        visitors:
          Number((row as { visitors?: unknown }).visitors ?? 0) ||
          Number(fallback?.visitors ?? 0),
        reference: (row as OverviewGeoTabRows[number]).reference,
        change: (row as OverviewGeoTabRows[number]).change,
      });
    }

    if (geoDirectoryEntries && geoDirectoryEntries.length > 0) {
      return geoDirectoryEntries.map((entry) => {
        const source = sourceMap.get(entry.key);
        const fallback = fallbackMap.get(entry.key);
        return {
          key: entry.key,
          label: entry.label || messages.common.unknown,
          views: Number(source?.views ?? fallback?.views ?? 0),
          sessions: Number(source?.sessions ?? fallback?.sessions ?? 0),
          visitors: Number(source?.visitors ?? fallback?.visitors ?? 0),
          reference: source?.reference,
          change: source?.change,
        };
      });
    }

    if (!activeLocation) {
      return [...sourceMap.values()].filter(
        (row) => row.key.length > 0 && row.label.length > 0,
      );
    }

    return dimensionSourceRows
      .map((row) => sourceMap.get(String(row.value ?? "").trim()) ?? null)
      .filter((row): row is GeoStatsEntry => Boolean(row))
      .filter((row) => row.key.length > 0 && row.label.length > 0);
  }, [
    geoDirectoryEntries,
    geoPointsData.cityCounts,
    geoPointsData.countryCounts,
    geoPointsData.regionCounts,
    geoTabRows,
    locale,
    activeLocation,
    messages.common.unknown,
  ]);

  const selectedEntryKey =
    activeLocation?.level === "locality" ? activeLocation.canonical : null;
  const investigationRows = useMemo(() => {
    if (!geoInvestigation) return null;

    const derivedRows = [...geoInvestigation.rows];
    const marketPenetrationVisitors =
      activeLocation?.level === "locality"
        ? Math.max(
            0,
            Number(
              statsEntries.find(
                (entry) => entry.key === activeLocation.canonical,
              )?.visitors ?? 0,
            ),
          )
        : statsEntries.reduce(
            (sum, entry) => sum + Math.max(0, Number(entry.visitors ?? 0)),
            0,
          );

    derivedRows.push(
      buildGeoInvestigationRow(
        buildGeoMarketPenetrationLabel(
          geoInvestigationMessages,
          resolveWindowDayCount(window.from, window.to),
        ),
        formatGeoMarketPenetration(
          locale,
          marketPenetrationVisitors,
          geoInvestigation.population,
          geoInvestigationMessages,
        ),
        true,
      ),
    );

    return derivedRows;
  }, [
    geoInvestigation,
    locale,
    activeLocation?.canonical,
    activeLocation?.level,
    statsEntries,
    window.from,
    window.to,
    geoInvestigationMessages,
  ]);
  const currentLocationInfo = useMemo(() => {
    if (!activeLocation) return null;

    const lines = [
      locationFocus?.country?.label ||
        resolveCountryLabel(
          activeLocation.countryCode,
          locale,
          messages.common.unknown,
        ).label,
      activeLocation.level !== "country"
        ? locationFocus?.region?.label || messages.common.unknown
        : null,
      activeLocation.level === "locality"
        ? locationFocus?.locality?.label || messages.common.unknown
        : null,
    ].filter((value, index, array): value is string => {
      const normalized = String(value ?? "").trim();
      if (!normalized) return false;
      return (
        array.findIndex((item) => String(item ?? "").trim() === normalized) ===
        index
      );
    });

    return {
      lines,
    };
  }, [
    locale,
    activeLocation,
    locationFocus?.country?.label,
    locationFocus?.locality?.label,
    locationFocus?.region?.label,
    messages.common.unknown,
  ]);
  const statsColumnLabel = activeLocation
    ? activeLocation.level === "country"
      ? geoMessages.regionLabel
      : geoMessages.cityLabel
    : geoMessages.countryLabel;
  const comparisonLabel = comparisonQuery
    ? dashboardComparisonLabel(messages, comparisonQuery)
    : undefined;

  const updateLocation = useCallback(
    (nextLocation: string | null) => {
      if (typeof globalThis.window === "undefined") return;
      const nextParams = new URLSearchParams(searchParams.toString());
      if (nextLocation) {
        nextParams.set("location", nextLocation);
      } else {
        nextParams.delete("location");
      }
      const query = serializeDashboardSearchParams(nextParams);
      const nextTarget = `${globalThis.window.location.pathname}${query ? `?${query}` : ""}${globalThis.window.location.hash}`;
      pushUrlWithoutNavigation(nextTarget);
    },
    [searchParams],
  );

  const handleBack = useMemo(
    () =>
      activeLocation
        ? () => updateLocation(parentGeoLocationValue(activeLocation))
        : undefined,
    [activeLocation, updateLocation],
  );
  const handleSelectEntry = useMemo(
    () =>
      statsEntries.length > 0
        ? (key: string) => updateLocation(key)
        : undefined,
    [statsEntries.length, updateLocation],
  );

  const statsPanel = (
    <GeoCountryStatsPanel
      locale={locale}
      messages={messages}
      loading={loading}
      comparisonLabel={comparisonLabel}
      stacked={isMobile}
      columnLabel={statsColumnLabel}
      currentLocationInfo={currentLocationInfo}
      investigationRows={investigationRows}
      wikiSummary={geoWikiSummary}
      entries={statsEntries}
      selectedEntryKey={selectedEntryKey}
      onSelectEntry={handleSelectEntry}
      onBack={handleBack}
    />
  );
  const mapViewport = (
    <>
      <GeoClientMapStage
        locale={locale}
        isMobile={isMobile}
        points={points}
        countryCounts={geoPointsData.countryCounts}
        activeLocation={activeLocation}
        viewState={initialViewState}
        unknownLabel={messages.common.unknown}
        viewsLabel={messages.common.views}
        visitorsLabel={messages.common.visitors}
        sessionsLabel={messages.common.sessions}
        onSelectLocation={updateLocation}
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-background via-background/60 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-background via-background/70 to-transparent sm:h-40" />

      <div className="pointer-events-none absolute left-4 top-4 z-10 max-w-[min(26rem,calc(100%-2rem))] sm:max-w-[calc(100%-25.5rem)] md:left-6 md:top-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {messages.geo.title}
          </h1>
          <p className="text-sm text-foreground/75">{messages.geo.subtitle}</p>
        </div>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <div className="space-y-6 pb-6">
        <div className="relative h-[min(68svh,calc(100svh-10.5rem))] min-h-[19rem] overflow-hidden">
          {mapViewport}
        </div>

        <div className="mx-auto w-full max-w-[1400px] px-4 md:px-6">
          {statsPanel}
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden"
      style={MAP_VIEWPORT_RENDER_ISOLATION_STYLE}
    >
      {mapViewport}
      {statsPanel}
    </div>
  );
}
