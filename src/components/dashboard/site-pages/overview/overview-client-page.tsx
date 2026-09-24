import { useCallback, useMemo } from "react";

import { PageHeading } from "@/components/dashboard/common/page-heading";
import { OverviewGeoPointsMapCard } from "@/components/dashboard/geo/overview-geo-points-map-card";
import { useDashboardQuery } from "@/components/dashboard/shell/dashboard-query-provider";
import {
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/dashboard/client/history";
import {
  dashboardFilterValue,
  serializeDashboardSearchParams,
  setDashboardFilterValue,
  withDashboardFilterSearchParams,
} from "@/lib/dashboard/filter-state";
import { resolveFilterScope } from "@/lib/edge/analytics/contract/scoped-filter";
import { attachFilterScopePreference } from "@/lib/filter-contract";
import { usePathname } from "@/lib/router";

import { OverviewMetricsSection, OverviewTrendSection } from "./metrics";
import {
  extractGeoCountryCodeFromFilterValue,
  parseOverviewCardFilters,
} from "./overview-filter-model";
import { OverviewPagesSection } from "./pages-section";
import { type OverviewClientPageProps } from "./types";
export function OverviewClientPage({
  locale,
  messages,
  siteId,
  siteDomain,
  pathname,
  showSourceLinkTab,
}: OverviewClientPageProps) {
  const searchParams = useLiveSearchParams();
  const livePathname = usePathname() || pathname;
  const { window, scopePreference } = useDashboardQuery();
  const resolvedScope = useMemo(
    () => resolveFilterScope("overview", scopePreference),
    [scopePreference],
  );
  const searchParamsKey = searchParams.toString();
  const requestFilters = useMemo(
    () => parseOverviewCardFilters(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
  // Overview's Auto scope is resolved once by the parent operation (event)
  // and passed to every dashboard child request. The URL remains Auto.
  const resolvedRequestFilters = useMemo(
    () =>
      resolvedScope
        ? attachFilterScopePreference(requestFilters, resolvedScope)
        : requestFilters,
    [requestFilters, resolvedScope],
  );
  const selectedGeoValue = dashboardFilterValue(requestFilters, "geo") ?? null;
  const selectedGeoCountry = useMemo(() => {
    return extractGeoCountryCodeFromFilterValue(selectedGeoValue);
  }, [selectedGeoValue]);
  const handleMapCountrySelect = useCallback(
    (countryCode: string | null) => {
      const normalizedCurrent = String(selectedGeoCountry ?? "")
        .trim()
        .toUpperCase();
      const normalizedNext = String(countryCode ?? "")
        .trim()
        .toUpperCase();
      const nextCountry =
        normalizedNext.length > 0 && normalizedNext !== normalizedCurrent
          ? normalizedNext
          : undefined;
      const nextDocument = setDashboardFilterValue(
        requestFilters,
        "geo",
        nextCountry,
      );
      const params = withDashboardFilterSearchParams(
        searchParams,
        nextDocument,
      );
      const nextQuery = serializeDashboardSearchParams(params);
      const target = nextQuery ? `${livePathname}?${nextQuery}` : livePathname;
      const current = serializeDashboardSearchParams(searchParams);
      if (nextQuery !== current) {
        replaceUrlWithoutNavigation(target);
      }
    },
    [livePathname, requestFilters, searchParams, selectedGeoCountry],
  );

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.overview.title}
        subtitle={messages.overview.subtitle}
      />
      <OverviewMetricsSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={resolvedRequestFilters}
      />
      <OverviewTrendSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={resolvedRequestFilters}
      />
      <OverviewPagesSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        pathname={pathname}
        filters={resolvedRequestFilters}
        resolvedScope={resolvedScope ?? undefined}
        showSourceLinkTab={showSourceLinkTab}
      />
      <OverviewGeoPointsMapCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={resolvedRequestFilters}
        resolvedScope={resolvedScope ?? undefined}
        selectedCountryCode={selectedGeoCountry}
        onCountrySelect={handleMapCountrySelect}
      />
    </div>
  );
}
