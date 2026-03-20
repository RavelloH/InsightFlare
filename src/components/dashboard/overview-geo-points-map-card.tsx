"use client";

import { useEffect, useMemo, useState } from "react";
import { RiCopyrightLine } from "@remixicon/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  GeoPointsMap,
  type GeoPointsMapCountryCount,
  type GeoPointsMapPoint,
} from "@/components/dashboard/geo-points-map";
import {
  emptyOverviewGeoPointsData,
  fetchOverviewGeoPoints,
} from "@/lib/dashboard/client-data";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface OverviewGeoPointsMapCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
  selectedCountryCode?: string | null;
  onCountrySelect?: (countryCode: string | null) => void;
}

function dashboardFilterSignature(filters: DashboardFilters): string {
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
  const [loading, setLoading] = useState(true);
  const [geoPointsData, setGeoPointsData] = useState(emptyOverviewGeoPointsData());
  const requestFilters = useMemo<DashboardFilters>(
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

  useEffect(() => {
    let active = true;
    setLoading(true);

    fetchOverviewGeoPoints(
      siteId,
      window,
      requestFilters,
      { limit: 5000 },
    )
      .then((next) => {
        if (!active) return;
        setGeoPointsData(next);
      })
      .catch(() => {
        if (!active) return;
        setGeoPointsData(emptyOverviewGeoPointsData());
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    requestFiltersKey,
    siteId,
    window.from,
    window.interval,
    window.to,
  ]);

  const points = useMemo<GeoPointsMapPoint[]>(
    () =>
      geoPointsData.data.map((item) => ({
        latitude: Number(item.latitude),
        longitude: Number(item.longitude),
        country: String(item.country ?? ""),
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
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <CardTitle>{messages.geo.mapTitle}</CardTitle>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <RiCopyrightLine aria-hidden="true" size="1em" />
          <span>OpenStreetMap contributors</span>
          <span aria-hidden="true">·</span>
          <RiCopyrightLine aria-hidden="true" size="1em" />
          <span>CARTO</span>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <GeoPointsMap
          locale={locale}
          messages={messages}
          loading={loading}
          points={points}
          countryCounts={countryCounts}
          selectedCountryCode={selectedCountryCode}
          onCountrySelect={onCountrySelect}
        />
      </CardContent>
    </Card>
  );
}
