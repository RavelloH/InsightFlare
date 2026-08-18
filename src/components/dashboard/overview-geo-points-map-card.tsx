import { useMemo } from "react";
import { RiCopyrightLine, RiMapPin2Line } from "@remixicon/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  type GeoPointsMapCountryCount,
  GeoPointsMapIsland,
  type GeoPointsMapPoint,
} from "@/components/dashboard/geo-points-map-island";
import { CardTitle } from "@/components/ui/card";
import {
  emptyOverviewGeoPointsData,
  fetchOverviewGeoPoints,
} from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface OverviewGeoPointsMapCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  selectedCountryCode?: string | null;
  onCountrySelect?: (countryCode: string | null) => void;
}

function dashboardFilterSignature(filters: FilterDocument): string {
  const entries = Object.entries(filters)
    .map(([key, value]) => [key, String(value ?? "").trim()] as const)
    .filter(([, value]) => value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

export function OverviewGeoPointsMapCard({
  locale,
  messages,
  siteId,
  window,
  filters,
  selectedCountryCode,
  onCountrySelect,
}: OverviewGeoPointsMapCardProps) {
  const emptyGeoPointsData = useMemo(() => emptyOverviewGeoPointsData(), []);
  const requestFilters = useMemo<FilterDocument>(
    () => ({
      ...filters,
      country: undefined,
      geo: undefined,
      geoContinent: undefined,
      geoTimezone: undefined,
      geoOrganization: undefined,
    }),
    [filters],
  );
  const requestFiltersKey = useMemo(
    () => dashboardFilterSignature(requestFilters),
    [requestFilters],
  );

  const {
    data: geoPointsData = emptyGeoPointsData,
    isFetching,
    isPending,
  } = useQuery({
    queryKey: [
      "dashboard",
      "overview-geo-points",
      siteId,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      requestFiltersKey,
    ],
    queryFn: ({ signal }) =>
      fetchOverviewGeoPoints(siteId, window, requestFilters, {
        limit: 5000,
        signal,
      }),
    enabled: typeof window !== "undefined",
    placeholderData: keepPreviousData,
  });

  const points = useMemo<GeoPointsMapPoint[]>(
    () =>
      geoPointsData.data.map((item) => ({
        latitude: Number(item.latitude),
        longitude: Number(item.longitude),
        country: String(item.country ?? ""),
        pointCount: Math.max(1, Number(item.pointCount ?? 1)),
      })),
    [geoPointsData.data],
  );
  const countryCounts = useMemo<GeoPointsMapCountryCount[]>(
    () =>
      geoPointsData.countryCounts.map((row) => ({
        country: String(row.country ?? ""),
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      })),
    [geoPointsData.countryCounts],
  );

  return (
    <div className="relative h-[460px] overflow-hidden bg-card ring-1 ring-foreground/10">
      <div className="absolute inset-0">
        <GeoPointsMapIsland
          locale={locale}
          messages={messages}
          loading={isPending || isFetching}
          points={points}
          countryCounts={countryCounts}
          selectedCountryCode={selectedCountryCode}
          onCountrySelect={onCountrySelect}
          heightClassName="h-full"
          bordered={false}
        />
      </div>

      <div className="absolute inset-x-4 top-4 z-10 flex items-start justify-between gap-2 md:inset-x-6 md:top-6">
        <CardTitle className="inline-flex items-center gap-2 text-foreground">
          <RiMapPin2Line className="size-4" />
          {messages.geo.mapTitle}
        </CardTitle>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <RiCopyrightLine aria-hidden="true" size="1em" />
          <span>OpenStreetMap contributors</span>
          <span aria-hidden="true">·</span>
          <RiCopyrightLine aria-hidden="true" size="1em" />
          <span>CARTO</span>
        </div>
      </div>
    </div>
  );
}
