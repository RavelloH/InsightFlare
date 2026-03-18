"use client";

import { memo, useEffect, useMemo, useState } from "react";
import type { MapViewState } from "@deck.gl/core";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";
import isoCountries from "i18n-iso-countries";
import type { Feature, GeoJSON, Geometry } from "geojson";
import { AnimatePresence, motion } from "motion/react";
import { useTheme } from "next-themes";
import type { StyleSpecification } from "maplibre-gl";
import Map, { useControl } from "react-map-gl/maplibre";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Spinner } from "@/components/ui/spinner";
import { GeoCountryStatsPanel } from "@/components/dashboard/geo-country-stats-panel";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { fetchOverviewGeoPoints } from "@/lib/dashboard/client-data";
import { numberFormat } from "@/lib/dashboard/format";
import type { DashboardFilters } from "@/lib/dashboard/query-state";
import type { OverviewGeoPointsData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { AppMessages } from "@/lib/i18n/messages";

interface GeoClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
}

interface GeoPoint {
  latitude: number;
  longitude: number;
}

interface ClusteredGeoPoint {
  id: string;
  latitude: number;
  longitude: number;
  count: number;
}

interface CountryCount {
  country: string;
  views: number;
  sessions: number;
  visitors: number;
}

type EffectiveMapTheme = "light" | "dark";
type CountryFeature = Feature<Geometry, Record<string, unknown>>;

const DEFAULT_VIEW_STATE: MapViewState = {
  longitude: 0,
  latitude: 20,
  zoom: 1,
  minZoom: 0.3,
  maxZoom: 19,
  pitch: 0,
  bearing: 0,
};
const MAP_ACCENT_RGB: [number, number, number] = [34, 197, 154];
const MAP_POINT_ALPHA_VISIBLE = 112;
const CLUSTER_RADIUS_PX = 26;
const CLUSTER_ZOOM_STEP = 0.25;
const EMPTY_COUNTRY_FEATURES = {
  type: "FeatureCollection",
  features: [],
} as const satisfies GeoJSON;
const MAP_VIEWPORT_RENDER_ISOLATION_STYLE = {
  contain: "layout paint",
  transform: "translateZ(0)",
  willChange: "transform",
} as const;

function emptyOverviewGeoPoints(): OverviewGeoPointsData {
  return {
    ok: true,
    data: [],
    countryCounts: [],
  };
}

function buildRasterStyle(theme: EffectiveMapTheme): StyleSpecification {
  const sourceId = `insightflare-geo-map-source-${theme}`;
  const layerId = `insightflare-geo-map-layer-${theme}`;
  const endpoint = `/api/map-tiles/{z}/{x}/{y}.png?theme=${theme}`;

  return {
    version: 8,
    name: `insightflare-geo-map-${theme}`,
    sources: {
      [sourceId]: {
        type: "raster",
        tiles: [endpoint],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors © CARTO",
      },
    },
    layers: [
      {
        id: layerId,
        type: "raster",
        source: sourceId,
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function withAlpha(
  rgb: [number, number, number],
  alpha: number,
): [number, number, number, number] {
  return [rgb[0], rgb[1], rgb[2], alpha];
}

function computeInitialViewState(points: GeoPoint[]): MapViewState {
  if (points.length === 0) return DEFAULT_VIEW_STATE;

  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;

  for (const point of points) {
    minLat = Math.min(minLat, point.latitude);
    maxLat = Math.max(maxLat, point.latitude);
    minLon = Math.min(minLon, point.longitude);
    maxLon = Math.max(maxLon, point.longitude);
  }

  const latSpan = Math.max(0.01, maxLat - minLat);
  const lonSpan = Math.max(0.01, maxLon - minLon);

  if (lonSpan >= 210 || latSpan >= 110) {
    return DEFAULT_VIEW_STATE;
  }

  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;
  const zoomFromLat = Math.log2(170 / Math.max(4, latSpan));
  const zoomFromLon = Math.log2(360 / Math.max(4, lonSpan));
  const zoom = clamp(Math.min(zoomFromLat, zoomFromLon) + 0.02, 0.95, 6.2);

  return {
    ...DEFAULT_VIEW_STATE,
    latitude: Number.isFinite(centerLat) ? centerLat : DEFAULT_VIEW_STATE.latitude,
    longitude: Number.isFinite(centerLon)
      ? centerLon
      : DEFAULT_VIEW_STATE.longitude,
    zoom: Number.isFinite(zoom) ? zoom : DEFAULT_VIEW_STATE.zoom,
  };
}

function resolveCountryFeatureKey(
  feature: CountryFeature | null | undefined,
): string {
  if (!feature) return "";
  if (typeof feature.id === "string" || typeof feature.id === "number") {
    return String(feature.id);
  }

  const props = feature.properties ?? {};
  const fallbackKeys = [
    "ISO_A3",
    "iso_a3",
    "ADM0_A3",
    "adm0_a3",
    "ISO_A2",
    "iso_a2",
    "NAME",
    "name",
    "ADMIN",
    "admin",
  ] as const;

  for (const key of fallbackKeys) {
    const value = props[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return "";
}

function normalizeCountryCode(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  return normalized;
}

function resolveCountryCodeFromFeature(
  feature: CountryFeature | null | undefined,
): string | null {
  if (!feature) return null;
  const props = feature.properties ?? {};
  const alpha2Candidates = [
    props.ISO_A2,
    props.iso_a2,
    props.ADM0_A2,
    props.adm0_a2,
    props.WB_A2,
    props.wb_a2,
    props.country,
  ];

  for (const candidate of alpha2Candidates) {
    const code = normalizeCountryCode(String(candidate ?? ""));
    if (code) return code;
  }

  const alpha3Candidates = [
    props.ISO_A3,
    props.iso_a3,
    props.ADM0_A3,
    props.adm0_a3,
    props.WB_A3,
    props.wb_a3,
    props.SOV_A3,
    props.sov_a3,
    props.GU_A3,
    props.gu_a3,
    props.SU_A3,
    props.su_a3,
    props.BRK_A3,
    props.brk_a3,
    typeof feature.id === "string" ? feature.id : null,
    resolveCountryFeatureKey(feature),
  ];

  for (const candidate of alpha3Candidates) {
    const normalizedAlpha3 = String(candidate ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalizedAlpha3)) continue;
    const alpha2 = isoCountries.alpha3ToAlpha2(normalizedAlpha3);
    const code = normalizeCountryCode(alpha2 ?? "");
    if (code) return code;
  }

  const nameCandidates = [
    props.name,
    props.NAME,
    props.NAME_LONG,
    props.ADMIN,
    props.admin,
    props.FORMAL_EN,
    resolveCountryDisplayNameFromFeature(feature),
  ];
  for (const candidate of nameCandidates) {
    const normalizedName = String(candidate ?? "").trim();
    if (!normalizedName) continue;
    const alpha2 = isoCountries.getAlpha2Code(normalizedName, "en");
    const code = normalizeCountryCode(alpha2 ?? "");
    if (code) return code;
  }

  return null;
}

function resolveCountryDisplayNameFromFeature(
  feature: CountryFeature | null | undefined,
): string {
  if (!feature) return "";
  const props = feature.properties ?? {};
  const nameCandidates = [props.name, props.NAME, props.admin, props.ADMIN];
  for (const candidate of nameCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
}

function projectLongitudeToWorldX(longitude: number, zoom: number): number {
  const scale = 256 * 2 ** zoom;
  return ((longitude + 180) / 360) * scale;
}

function projectLatitudeToWorldY(latitude: number, zoom: number): number {
  const lat = Math.max(-85, Math.min(85, latitude));
  const rad = (lat * Math.PI) / 180;
  const scale = 256 * 2 ** zoom;
  return (
    (0.5 - Math.log((1 + Math.sin(rad)) / (1 - Math.sin(rad))) / (4 * Math.PI)) *
    scale
  );
}

function normalizeClusterZoom(zoom: number): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : DEFAULT_VIEW_STATE.zoom;
  const snapped = Math.round(safeZoom / CLUSTER_ZOOM_STEP) * CLUSTER_ZOOM_STEP;
  return clamp(
    snapped,
    DEFAULT_VIEW_STATE.minZoom ?? 0,
    DEFAULT_VIEW_STATE.maxZoom ?? 22,
  );
}

function clusterGeoPoints(points: GeoPoint[], zoom: number): ClusteredGeoPoint[] {
  if (points.length === 0) return [];

  const buckets = new globalThis.Map<
    string,
    { count: number; sumLatitude: number; sumLongitude: number }
  >();

  for (const point of points) {
    const x = projectLongitudeToWorldX(point.longitude, zoom);
    const y = projectLatitudeToWorldY(point.latitude, zoom);
    const cellX = Math.floor(x / CLUSTER_RADIUS_PX);
    const cellY = Math.floor(y / CLUSTER_RADIUS_PX);
    const key = `${cellX}:${cellY}`;

    const bucket = buckets.get(key) ?? {
      count: 0,
      sumLatitude: 0,
      sumLongitude: 0,
    };
    bucket.count += 1;
    bucket.sumLatitude += point.latitude;
    bucket.sumLongitude += point.longitude;
    buckets.set(key, bucket);
  }

  const clusters: ClusteredGeoPoint[] = [];
  for (const [id, bucket] of buckets.entries()) {
    clusters.push({
      id,
      latitude: bucket.sumLatitude / bucket.count,
      longitude: bucket.sumLongitude / bucket.count,
      count: bucket.count,
    });
  }
  return clusters;
}

function computeClusterPointRadius(count: number, zoom: number): number {
  const safeCount = Number.isFinite(count) ? Math.max(1, count) : 1;
  const safeZoom = normalizeClusterZoom(zoom);
  const baseRadius = 2.8 + Math.log2(safeCount + 1) * 2.15;
  const zoomScale = clamp(0.62 + safeZoom * 0.18, 0.74, 1.28);
  return clamp(baseRadius * zoomScale, 2.2, 32);
}

function dashboardFilterSignature(filters: DashboardFilters): string {
  const entries = Object.entries(filters)
    .map(([key, value]) => [key, String(value ?? "").trim()] as const)
    .filter(([, value]) => value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

const DeckOverlay = memo(function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
});

export function GeoClientPage({
  locale,
  messages,
  siteId,
}: GeoClientPageProps) {
  const { window, filters } = useDashboardQuery();
  const { resolvedTheme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [geoPointsData, setGeoPointsData] = useState<OverviewGeoPointsData>(
    emptyOverviewGeoPoints(),
  );
  const [countryGeoJson, setCountryGeoJson] = useState<GeoJSON | null>(null);
  const [hoveredCountryKey, setHoveredCountryKey] = useState<string | null>(null);
  const [hoveredCountryCode, setHoveredCountryCode] = useState<string | null>(null);
  const [hoveredCountryName, setHoveredCountryName] = useState("");
  const [currentZoom, setCurrentZoom] = useState(
    normalizeClusterZoom(DEFAULT_VIEW_STATE.zoom),
  );
  const filterKey = useMemo(() => dashboardFilterSignature(filters), [filters]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let active = true;

    fetch("/api/world-countries", { cache: "force-cache" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!active) return;
        const isFeatureCollection =
          payload &&
          typeof payload === "object" &&
          "type" in payload &&
          (payload as { type?: unknown }).type === "FeatureCollection";
        setCountryGeoJson(isFeatureCollection ? (payload as GeoJSON) : null);
      })
      .catch(() => {
        if (!active) return;
        setCountryGeoJson(null);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);

    fetchOverviewGeoPoints(siteId, window, filters, { limit: 5000 })
      .then((next) => {
        if (!active) return;
        setGeoPointsData(next);
      })
      .catch(() => {
        if (!active) return;
        setGeoPointsData(emptyOverviewGeoPoints());
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [filterKey, siteId, window.from, window.interval, window.to, filters]);

  const points = useMemo<GeoPoint[]>(
    () =>
      geoPointsData.data
        .map((item) => ({
          latitude: Number(item.latitude),
          longitude: Number(item.longitude),
        }))
        .filter(
          (item) =>
            Number.isFinite(item.latitude) &&
            Number.isFinite(item.longitude) &&
            Math.abs(item.latitude) <= 90 &&
            Math.abs(item.longitude) <= 180,
        ),
    [geoPointsData.data],
  );
  const initialViewState = useMemo(() => computeInitialViewState(points), [points]);
  const effectiveMapTheme: EffectiveMapTheme =
    mounted && resolvedTheme === "dark" ? "dark" : "light";
  const mapStyle = useMemo(
    () => buildRasterStyle(effectiveMapTheme),
    [effectiveMapTheme],
  );

  useEffect(() => {
    setCurrentZoom(
      normalizeClusterZoom(initialViewState.zoom ?? DEFAULT_VIEW_STATE.zoom),
    );
  }, [initialViewState.zoom]);

  const clusteredPoints = useMemo(
    () => clusterGeoPoints(points, currentZoom),
    [currentZoom, points],
  );
  const countryCountMap = useMemo(() => {
    const map = new globalThis.Map<string, CountryCount>();
    for (const row of geoPointsData.countryCounts) {
      const code = normalizeCountryCode(row.country);
      if (!code) continue;
      map.set(code, {
        country: code,
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      });
    }
    return map;
  }, [geoPointsData.countryCounts]);
  const layers = useMemo(
    () => [
      new ScatterplotLayer<ClusteredGeoPoint>({
        id: "geo-page-clustered-points",
        data: clusteredPoints,
        getFillColor: withAlpha(MAP_ACCENT_RGB, MAP_POINT_ALPHA_VISIBLE),
        getPosition: (item) => [item.longitude, item.latitude],
        getRadius: (item) => computeClusterPointRadius(item.count, currentZoom),
        radiusUnits: "pixels",
        radiusMinPixels: 2,
        radiusMaxPixels: 32,
        pickable: false,
      }),
      new GeoJsonLayer<Record<string, unknown>>({
        id: "geo-page-country-outline-hover",
        data: countryGeoJson ?? EMPTY_COUNTRY_FEATURES,
        filled: true,
        stroked: true,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 0,
        getFillColor: () => [0, 0, 0, 0],
        getLineColor: (feature) =>
          resolveCountryFeatureKey(feature) === hoveredCountryKey
            ? withAlpha(MAP_ACCENT_RGB, 240)
            : [0, 0, 0, 0],
        getLineWidth: (feature) =>
          resolveCountryFeatureKey(feature) === hoveredCountryKey ? 2.5 : 0,
        pickable: true,
        onHover: (info) => {
          const feature = (info.object as CountryFeature | undefined) ?? null;
          const nextKey = resolveCountryFeatureKey(feature);
          const nextCode = resolveCountryCodeFromFeature(feature);
          const nextName = resolveCountryDisplayNameFromFeature(feature);
          setHoveredCountryKey((previous) => {
            const normalized = nextKey.length > 0 ? nextKey : null;
            return previous === normalized ? previous : normalized;
          });
          setHoveredCountryCode((previous) =>
            previous === nextCode ? previous : nextCode,
          );
          setHoveredCountryName((previous) =>
            previous === nextName ? previous : nextName,
          );
        },
        updateTriggers: {
          getLineColor: hoveredCountryKey,
          getLineWidth: hoveredCountryKey,
        },
      }),
    ],
    [clusteredPoints, countryGeoJson, currentZoom, hoveredCountryKey],
  );
  const mapKey = useMemo(
    () => `${siteId}:${window.from}:${window.to}:${window.interval}:${filterKey}`,
    [filterKey, siteId, window.from, window.interval, window.to],
  );
  const noData = !loading && points.length === 0;
  const hoveredCountryLabel = useMemo(() => {
    if (hoveredCountryCode) {
      return resolveCountryLabel(
        hoveredCountryCode,
        locale,
        messages.common.unknown,
      ).label;
    }
    return hoveredCountryName.trim() || messages.common.unknown;
  }, [hoveredCountryCode, hoveredCountryName, locale, messages.common.unknown]);
  const hoveredCountryCounts =
    hoveredCountryCode ? countryCountMap.get(hoveredCountryCode) : null;
  const hoveredViewsText = numberFormat(
    locale,
    hoveredCountryCounts?.views ?? 0,
  );
  const hoveredVisitorsText = numberFormat(
    locale,
    hoveredCountryCounts?.visitors ?? 0,
  );
  const hoveredSessionsText = numberFormat(
    locale,
    hoveredCountryCounts?.sessions ?? 0,
  );
  const showCountryToolbar = Boolean(hoveredCountryKey);

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden"
      style={MAP_VIEWPORT_RENDER_ISOLATION_STYLE}
    >
      {!loading && points.length > 0 ? (
        <Map
          key={mapKey}
          initialViewState={initialViewState}
          mapStyle={mapStyle}
          attributionControl={false}
          scrollZoom
          maxPitch={0}
          dragRotate={false}
          pitchWithRotate={false}
          onMove={(event) => {
            const nextZoom = normalizeClusterZoom(event.viewState.zoom);
            setCurrentZoom((previous) =>
              Math.abs(previous - nextZoom) > 0.0001 ? nextZoom : previous,
            );
          }}
        >
          <DeckOverlay interleaved={false} layers={layers} />
        </Map>
      ) : (
        <div className="absolute inset-0 bg-muted/20" />
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-background via-background/60 to-transparent" />

      <div className="pointer-events-none absolute left-4 top-4 z-10 max-w-[min(26rem,calc(100%-2rem))] sm:max-w-[calc(100%-25.5rem)] md:left-6 md:top-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {messages.geo.title}
          </h1>
          <p className="text-sm text-foreground/75">{messages.geo.subtitle}</p>
        </div>
      </div>

      <GeoCountryStatsPanel
        locale={locale}
        messages={messages}
        loading={loading}
        countryCounts={geoPointsData.countryCounts}
        highlightCountryCode={hoveredCountryCode}
      />

      <AnimatePresence>
        {showCountryToolbar ? (
          <motion.div
            key="geo-country-toolbar"
            className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3 sm:pr-[25rem]"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="inline-flex items-center gap-4 rounded-md border border-border/70 bg-background/92 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
              <AutoResizer
                initial
                animateWidth
                animateHeight={false}
                className="inline-flex shrink-0 items-center"
              >
                <AutoTransition
                  className="inline-block"
                  duration={0.2}
                  type="fade"
                  initial={false}
                  presenceMode="wait"
                  customVariants={{
                    initial: { opacity: 0 },
                    animate: { opacity: 1 },
                    exit: { opacity: 0 },
                  }}
                >
                  <span
                    key={`country-${hoveredCountryCode ?? "unknown"}-${hoveredCountryLabel}`}
                    className="whitespace-nowrap font-medium"
                  >
                    {hoveredCountryLabel}
                  </span>
                </AutoTransition>
              </AutoResizer>
              <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                <span>{messages.common.views}:</span>
                <AutoResizer
                  initial
                  animateWidth
                  animateHeight={false}
                  className="inline-flex shrink-0 items-center"
                >
                  <AutoTransition
                    className="inline-block"
                    duration={0.2}
                    type="fade"
                    initial={false}
                    presenceMode="wait"
                    customVariants={{
                      initial: { opacity: 0 },
                      animate: { opacity: 1 },
                      exit: { opacity: 0 },
                    }}
                  >
                    <span key={`views-${hoveredViewsText}`}>{hoveredViewsText}</span>
                  </AutoTransition>
                </AutoResizer>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                <span>{messages.common.visitors}:</span>
                <AutoResizer
                  initial
                  animateWidth
                  animateHeight={false}
                  className="inline-flex shrink-0 items-center"
                >
                  <AutoTransition
                    className="inline-block"
                    duration={0.2}
                    type="fade"
                    initial={false}
                    presenceMode="wait"
                    customVariants={{
                      initial: { opacity: 0 },
                      animate: { opacity: 1 },
                      exit: { opacity: 0 },
                    }}
                  >
                    <span key={`visitors-${hoveredVisitorsText}`}>
                      {hoveredVisitorsText}
                    </span>
                  </AutoTransition>
                </AutoResizer>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                <span>{messages.common.sessions}:</span>
                <AutoResizer
                  initial
                  animateWidth
                  animateHeight={false}
                  className="inline-flex shrink-0 items-center"
                >
                  <AutoTransition
                    className="inline-block"
                    duration={0.2}
                    type="fade"
                    initial={false}
                    presenceMode="wait"
                    customVariants={{
                      initial: { opacity: 0 },
                      animate: { opacity: 1 },
                      exit: { opacity: 0 },
                    }}
                  >
                    <span key={`sessions-${hoveredSessionsText}`}>
                      {hoveredSessionsText}
                    </span>
                  </AutoTransition>
                </AutoResizer>
              </span>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {loading ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-background/90 px-3 py-2 text-sm text-muted-foreground shadow-sm backdrop-blur-sm">
            <Spinner className="size-4" />
            <span>{messages.common.loading}</span>
          </div>
        </div>
      ) : null}

      {noData ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
          <div className="rounded-md border border-border/70 bg-background/90 px-4 py-3 text-sm text-muted-foreground shadow-sm backdrop-blur-sm">
            {messages.common.noData}
          </div>
        </div>
      ) : null}
    </div>
  );
}
