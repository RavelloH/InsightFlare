"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapViewState } from "@deck.gl/core";
import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import isoCountries from "i18n-iso-countries";
import type { Feature, GeoJSON, Geometry } from "geojson";
import { AnimatePresence, animate, motion } from "motion/react";
import { RiCopyrightLine } from "@remixicon/react";
import { useTheme } from "next-themes";
import type { StyleSpecification } from "maplibre-gl";
import Map, { type MapRef, useControl } from "react-map-gl/maplibre";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  emptyOverviewGeoPointsData,
  fetchOverviewGeoPoints,
} from "@/lib/dashboard/client-data";
import { numberFormat } from "@/lib/dashboard/format";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import { resolveCountryLabel } from "@/lib/i18n/code-labels";
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

interface GeoPoint {
  latitude: number;
  longitude: number;
  country: string;
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
const MAP_HEIGHT_CLASS = "h-[460px]";
const MAP_ACCENT_RGB: [number, number, number] = [34, 197, 154];
const MAP_POINT_ALPHA_VISIBLE = 112;
const CLUSTER_RADIUS_PX = 26;
const CLUSTER_ZOOM_STEP = 0.25;
const CLUSTER_CROSSFADE_DURATION_S = 0.22;
const EMPTY_COUNTRY_FEATURES = {
  type: "FeatureCollection",
  features: [],
} as const satisfies GeoJSON;

type CountryFeature = Feature<Geometry, Record<string, unknown>>;

function buildRasterStyle(theme: EffectiveMapTheme): StyleSpecification {
  const sourceId = `insightflare-raster-source-${theme}`;
  const layerId = `insightflare-raster-layer-${theme}`;
  const endpoint = `/api/map-tiles/{z}/{x}/{y}.png?theme=${theme}`;

  return {
    version: 8,
    name: `insightflare-raster-${theme}`,
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

const DEFAULT_VIEW_STATE: MapViewState = {
  longitude: 0,
  latitude: 20,
  zoom: 1,
  minZoom: 0.3,
  maxZoom: 19,
  pitch: 0,
  bearing: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

  // Cross-continent/global traffic is easier to read from a neutral world center.
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
    longitude: Number.isFinite(centerLon) ? centerLon : DEFAULT_VIEW_STATE.longitude,
    zoom: Number.isFinite(zoom) ? zoom : DEFAULT_VIEW_STATE.zoom,
  };
}

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

function resolveCountryFeatureKey(feature: CountryFeature | null | undefined): string {
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

function resolveCountryCodeFromFeature(feature: CountryFeature | null | undefined): string | null {
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

function withAlpha(
  rgb: [number, number, number],
  alpha: number,
): [number, number, number, number] {
  return [rgb[0], rgb[1], rgb[2], alpha];
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
    (0.5 - Math.log((1 + Math.sin(rad)) / (1 - Math.sin(rad))) / (4 * Math.PI)) * scale
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
  clusters.sort((a, b) => a.id.localeCompare(b.id));
  return clusters;
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

export function OverviewGeoPointsMapCard({
  locale,
  messages,
  siteId,
  window,
  filters,
  selectedCountryCode,
  onCountrySelect,
}: OverviewGeoPointsMapCardProps) {
  const { resolvedTheme } = useTheme();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(true);
  const [geoPointsData, setGeoPointsData] = useState(emptyOverviewGeoPointsData());
  const [mounted, setMounted] = useState(false);
  const [countryGeoJson, setCountryGeoJson] = useState<GeoJSON | null>(null);
  const [hoveredCountryKey, setHoveredCountryKey] = useState<string | null>(null);
  const [hoveredCountryCode, setHoveredCountryCode] = useState<string | null>(null);
  const [hoveredCountryName, setHoveredCountryName] = useState("");
  const [currentZoom, setCurrentZoom] = useState(
    normalizeClusterZoom(DEFAULT_VIEW_STATE.zoom),
  );
  const hasClusterCrossfadeInitialized = useRef(false);
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

  const points = useMemo<GeoPoint[]>(
    () =>
      geoPointsData.data
        .map((item) => ({
          latitude: Number(item.latitude),
          longitude: Number(item.longitude),
          country: String(item.country ?? ""),
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

  const initialViewState = useMemo(() => computeInitialViewState(points), [points]);
  const mobileMinZoom = initialViewState.minZoom ?? DEFAULT_VIEW_STATE.minZoom ?? 0;
  const mapInitialViewState = useMemo(
    () =>
      isMobile
        ? {
            ...initialViewState,
            zoom: mobileMinZoom,
          }
        : initialViewState,
    [initialViewState, isMobile, mobileMinZoom],
  );

  useEffect(() => {
    setCurrentZoom(
      normalizeClusterZoom(mapInitialViewState.zoom ?? DEFAULT_VIEW_STATE.zoom),
    );
  }, [mapInitialViewState.zoom]);

  const clusteredPoints = useMemo(
    () => clusterGeoPoints(points, currentZoom),
    [currentZoom, points],
  );
  const [incomingClusters, setIncomingClusters] = useState<ClusteredGeoPoint[]>(
    () => clusteredPoints,
  );
  const [outgoingClusters, setOutgoingClusters] = useState<ClusteredGeoPoint[]>([]);
  const [clusterFadeProgress, setClusterFadeProgress] = useState(1);
  const incomingClustersRef = useRef<ClusteredGeoPoint[]>(clusteredPoints);
  const mapRef = useRef<MapRef | null>(null);
  useEffect(() => {
    if (!hasClusterCrossfadeInitialized.current) {
      hasClusterCrossfadeInitialized.current = true;
      incomingClustersRef.current = clusteredPoints;
      setIncomingClusters(clusteredPoints);
      setOutgoingClusters([]);
      setClusterFadeProgress(1);
      return;
    }

    const previousIncoming = incomingClustersRef.current;
    incomingClustersRef.current = clusteredPoints;

    setOutgoingClusters(previousIncoming);
    setIncomingClusters(clusteredPoints);
    setClusterFadeProgress(0);

    const controls = animate(0, 1, {
      duration: CLUSTER_CROSSFADE_DURATION_S,
      ease: "easeInOut",
      onUpdate: (value) => {
        setClusterFadeProgress(value);
      },
      onComplete: () => {
        setOutgoingClusters([]);
      },
    });

    return () => {
      controls.stop();
    };
  }, [clusteredPoints]);

  const incomingAlpha = Math.round(MAP_POINT_ALPHA_VISIBLE * clusterFadeProgress);
  const outgoingAlpha = Math.round(MAP_POINT_ALPHA_VISIBLE * (1 - clusterFadeProgress));

  const effectiveMapTheme: EffectiveMapTheme =
    mounted && resolvedTheme === "dark" ? "dark" : "light";
  const mapStyle = useMemo(
    () => buildRasterStyle(effectiveMapTheme),
    [effectiveMapTheme],
  );
  const normalizedSelectedCountryCode = useMemo(
    () => normalizeCountryCode(selectedCountryCode),
    [selectedCountryCode],
  );
  const handleCountryClick = useCallback(
    (feature: CountryFeature | null) => {
      if (!onCountrySelect) return;
      const nextCode = resolveCountryCodeFromFeature(feature);
      if (!nextCode) return;
      onCountrySelect(nextCode);
    },
    [onCountrySelect],
  );

  const layers = useMemo(() => {
    const result: Array<
      ScatterplotLayer<ClusteredGeoPoint> | GeoJsonLayer<Record<string, unknown>>
    > = [];

    const createPointLayer = (
      id: string,
      data: ClusteredGeoPoint[],
      alpha: number,
    ): ScatterplotLayer<ClusteredGeoPoint> =>
      new ScatterplotLayer<ClusteredGeoPoint>({
        id,
        data,
        getFillColor: withAlpha(MAP_ACCENT_RGB, alpha),
        getPosition: (item) => [item.longitude, item.latitude],
        getRadius: (item) => computeClusterPointRadius(item.count, currentZoom),
        radiusUnits: "pixels",
        radiusMinPixels: 2,
        radiusMaxPixels: 32,
        pickable: false,
      });

    if (outgoingClusters.length > 0 && outgoingAlpha > 0) {
      result.push(
        createPointLayer(
          "overview-geo-points-clustered-outgoing",
          outgoingClusters,
          outgoingAlpha,
        ),
      );
    }

    if (incomingClusters.length > 0 && incomingAlpha > 0) {
      result.push(
        createPointLayer(
          "overview-geo-points-clustered-incoming",
          incomingClusters,
          incomingAlpha,
        ),
      );
    }

    result.push(new GeoJsonLayer<Record<string, unknown>>({
        id: "overview-country-outline-hover",
        data: countryGeoJson ?? EMPTY_COUNTRY_FEATURES,
        filled: true,
        stroked: true,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 0,
        getFillColor: (feature) =>
          normalizedSelectedCountryCode &&
          resolveCountryCodeFromFeature(feature) === normalizedSelectedCountryCode
            ? withAlpha(MAP_ACCENT_RGB, 80)
            : [0, 0, 0, 0],
        getLineColor: (feature) =>
          normalizedSelectedCountryCode &&
          resolveCountryCodeFromFeature(feature) === normalizedSelectedCountryCode
            ? withAlpha(MAP_ACCENT_RGB, 255)
            : resolveCountryFeatureKey(feature) === hoveredCountryKey
              ? withAlpha(MAP_ACCENT_RGB, 240)
              : [0, 0, 0, 0],
        getLineWidth: (feature) =>
          normalizedSelectedCountryCode &&
          resolveCountryCodeFromFeature(feature) === normalizedSelectedCountryCode
            ? 3
            : resolveCountryFeatureKey(feature) === hoveredCountryKey
              ? 2.5
              : 0,
        pickable: true,
        onHover: (info) => {
          const feature = (info.object as CountryFeature | undefined) ?? null;
          const nextKey = resolveCountryFeatureKey(feature);
          const nextCode = resolveCountryCodeFromFeature(feature);
          const nextName = resolveCountryDisplayNameFromFeature(feature);
          setHoveredCountryKey((prev) => {
            const normalized = nextKey.length > 0 ? nextKey : null;
            return prev === normalized ? prev : normalized;
          });
          setHoveredCountryCode((prev) => (prev === nextCode ? prev : nextCode));
          setHoveredCountryName((prev) => (prev === nextName ? prev : nextName));
        },
        onClick: (info) => {
          const feature = (info.object as CountryFeature | undefined) ?? null;
          handleCountryClick(feature);
        },
        updateTriggers: {
          getFillColor: normalizedSelectedCountryCode,
          getLineColor: [hoveredCountryKey, normalizedSelectedCountryCode],
          getLineWidth: [hoveredCountryKey, normalizedSelectedCountryCode],
        },
      }));

    return result;
  }, [
    countryGeoJson,
    currentZoom,
    handleCountryClick,
    hoveredCountryKey,
    incomingAlpha,
    incomingClusters,
    normalizedSelectedCountryCode,
    outgoingAlpha,
    outgoingClusters,
  ]);

  const title = locale === "zh" ? "请求地理分布" : "Request Geo Distribution";
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
  const hoveredViews = hoveredCountryCounts?.views ?? 0;
  const hoveredVisitors = hoveredCountryCounts?.visitors ?? 0;
  const hoveredSessions = hoveredCountryCounts?.sessions ?? 0;
  const hoveredViewsText = numberFormat(locale, hoveredViews);
  const hoveredVisitorsText = numberFormat(locale, hoveredVisitors);
  const hoveredSessionsText = numberFormat(locale, hoveredSessions);
  const showCountryToolbar = Boolean(hoveredCountryKey);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !isMobile) return;
    map.jumpTo({ zoom: mobileMinZoom });
    setCurrentZoom(normalizeClusterZoom(mobileMinZoom));
  }, [isMobile, mobileMinZoom]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
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
        {loading ? (
          <div className={`flex ${MAP_HEIGHT_CLASS} items-center justify-center`}>
            <Spinner className="size-6" />
          </div>
        ) : points.length === 0 ? (
          <div
            className={`flex ${MAP_HEIGHT_CLASS} items-center justify-center text-sm text-muted-foreground`}
          >
            {messages.common.noData}
          </div>
        ) : (
          <div
            className={`relative ${MAP_HEIGHT_CLASS} w-full overflow-hidden rounded-md border border-border/70`}
          >
            <Map
              ref={mapRef}
              initialViewState={mapInitialViewState}
              mapStyle={mapStyle}
              attributionControl={false}
              scrollZoom
              maxPitch={0}
              dragRotate={false}
              pitchWithRotate={false}
              onZoom={(event) => {
                const nextZoom = normalizeClusterZoom(event.viewState.zoom);
                setCurrentZoom((prev) =>
                  Math.abs(prev - nextZoom) > 0.0001 ? nextZoom : prev,
                );
              }}
            >
              <DeckOverlay interleaved={false} layers={layers} />
            </Map>
            <AnimatePresence>
              {showCountryToolbar ? (
                <motion.div
                  key="overview-country-toolbar"
                  className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3"
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}
