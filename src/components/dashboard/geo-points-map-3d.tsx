import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map, { type MapRef, useControl } from "react-map-gl/maplibre";
import type { MapViewState } from "@deck.gl/core";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";
import type { Feature, GeoJSON, Geometry } from "geojson";
import isoCountries from "i18n-iso-countries";
import type { Map as MaplibreMap, StyleSpecification } from "maplibre-gl";
import { animate, AnimatePresence, motion } from "motion/react";

import { useTheme } from "@/components/theme-provider";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Spinner } from "@/components/ui/spinner";
import { useIsMobile } from "@/hooks/use-mobile";
import { numberFormat } from "@/lib/dashboard/format";
import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

export interface GeoPointsMapPoint {
  latitude: number;
  longitude: number;
  country: string;
  pointCount?: number;
  color?: [number, number, number];
}

export interface GeoPointsMapCountryCount {
  country: string;
  views: number;
  sessions: number;
  visitors: number;
}

interface GeoPointsMap3DProps {
  locale: Locale;
  messages: AppMessages;
  points: GeoPointsMapPoint[];
  countryCounts?: GeoPointsMapCountryCount[];
  loading?: boolean;
  emptyLabel?: string;
  heightClassName?: string;
  countryHoverEnabled?: boolean;
  pointColor?: [number, number, number];
  autoRotate?: boolean;
  bordered?: boolean;
  selectedCountryCode?: string | null;
  onCountrySelect?: (countryCode: string | null) => void;
  collapseOverlappingPointColors?: boolean;
  pointCrossfadeEnabled?: boolean;
}

interface ClusteredGeoPoint {
  id: string;
  latitude: number;
  longitude: number;
  count: number;
  color?: [number, number, number];
  priority: number;
}

type EffectiveMapTheme = "light" | "dark";
const DEFAULT_MAP_HEIGHT_CLASS = "h-[460px]";
const MAP_ACCENT_RGB: [number, number, number] = [34, 197, 154];
const MAP_POINT_ALPHA_VISIBLE = 112;
const CLUSTER_RADIUS_PX = 26;
const CLUSTER_ZOOM_STEP = 0.25;
const CLUSTER_CROSSFADE_DURATION_S = 0.22;
const GLOBE_VIEW_STATE: MapViewState = {
  longitude: 0,
  latitude: 30,
  zoom: 2.25,
  minZoom: 2,
  maxZoom: 5,
  pitch: 0,
  bearing: 0,
};
const GLOBE_MOBILE_VIEW_STATE: MapViewState = {
  ...GLOBE_VIEW_STATE,
  zoom: 1.75,
  minZoom: 1,
};
const GLOBE_ROTATION_DEGREES_PER_SECOND = 10;
const GLOBE_USER_INTERACTION_PAUSE_MS = 5000;
const GLOBE_RECOVERY_DURATION_MS = 1200;
const GLOBE_ROTATION_ACCELERATION_MS = 1600;
const EMPTY_COUNTRY_FEATURES = {
  type: "FeatureCollection",
  features: [],
} as const satisfies GeoJSON;

type CountryFeature = Feature<Geometry, Record<string, unknown>>;

function buildRasterStyle(
  theme: EffectiveMapTheme,
  projectionMode: "mercator" | "globe",
): StyleSpecification {
  const sourceId = `insightflare-raster-source-${theme}`;
  const layerId = `insightflare-raster-layer-${theme}`;
  const endpoint = `/api/public/resources/map-tiles/{z}/{x}/{y}.png?theme=${theme}`;
  const isGlobe = projectionMode === "globe";
  const backgroundColor =
    theme === "dark" ? "rgb(10, 10, 10)" : "rgb(255, 255, 255)";

  return {
    version: 8,
    name: `insightflare-raster-${theme}`,
    projection: {
      type: projectionMode,
    },
    ...(isGlobe
      ? {
          sky: {
            "sky-color": backgroundColor,
            "horizon-color": backgroundColor,
            "fog-color": backgroundColor,
            "atmosphere-blend": 0.18,
          },
        }
      : {}),
    sources: {
      [sourceId]: {
        type: "raster",
        tiles: [endpoint],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors © CARTO",
      },
    },
    layers: [
      ...(isGlobe
        ? [
            {
              id: "insightflare-globe-ocean",
              type: "background" as const,
              paint: {
                "background-color": backgroundColor,
                "background-opacity": 1,
              },
            },
          ]
        : []),
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

function normalizeLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function smoothstep(progress: number): number {
  const normalized = clamp(progress, 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function computeInitialViewState(points: GeoPointsMapPoint[]): MapViewState {
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
    latitude: Number.isFinite(centerLat)
      ? centerLat
      : DEFAULT_VIEW_STATE.latitude,
    longitude: Number.isFinite(centerLon)
      ? centerLon
      : DEFAULT_VIEW_STATE.longitude,
    zoom: Number.isFinite(zoom) ? zoom : DEFAULT_VIEW_STATE.zoom,
  };
}

const MAP_VIEWPORT_RENDER_ISOLATION_STYLE = {
  contain: "layout paint",
  transform: "translateZ(0)",
  willChange: "transform",
} as const;

const DeckOverlay = memo(function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
});

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
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
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
    const normalizedAlpha3 = String(candidate ?? "")
      .trim()
      .toUpperCase();
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
    (0.5 -
      Math.log((1 + Math.sin(rad)) / (1 - Math.sin(rad))) / (4 * Math.PI)) *
    scale
  );
}

function clusterGeoPoints(
  points: GeoPointsMapPoint[],
  zoom: number,
  collapseOverlappingPointColors = false,
): ClusteredGeoPoint[] {
  if (points.length === 0) return [];

  const buckets = new globalThis.Map<
    string,
    {
      count: number;
      sumLatitude: number;
      sumLongitude: number;
      sumRed: number;
      sumGreen: number;
      sumBlue: number;
      hasColor: boolean;
      priority: number;
      colorWeights: globalThis.Map<
        string,
        {
          color: [number, number, number];
          count: number;
          priority: number;
        }
      >;
    }
  >();

  for (const point of points) {
    const color = point.color;
    const x = projectLongitudeToWorldX(point.longitude, zoom);
    const y = projectLatitudeToWorldY(point.latitude, zoom);
    const cellX = Math.floor(x / CLUSTER_RADIUS_PX);
    const cellY = Math.floor(y / CLUSTER_RADIUS_PX);
    const colorKey = color ? color.join(",") : "default";
    const key = collapseOverlappingPointColors
      ? `${cellX}:${cellY}`
      : `${cellX}:${cellY}:${colorKey}`;

    const bucket = buckets.get(key) ?? {
      count: 0,
      sumLatitude: 0,
      sumLongitude: 0,
      sumRed: 0,
      sumGreen: 0,
      sumBlue: 0,
      hasColor: false,
      priority: color ? colorPriority(color) : 0,
      colorWeights: new globalThis.Map(),
    };
    // Use pointCount if available, otherwise count as 1
    const pointWeight = point.pointCount ?? 1;
    bucket.count += pointWeight;
    bucket.sumLatitude += point.latitude * pointWeight;
    bucket.sumLongitude += point.longitude * pointWeight;
    if (color) {
      bucket.hasColor = true;
      bucket.sumRed += color[0] * pointWeight;
      bucket.sumGreen += color[1] * pointWeight;
      bucket.sumBlue += color[2] * pointWeight;
      if (collapseOverlappingPointColors) {
        const current = bucket.colorWeights.get(colorKey) ?? {
          color,
          count: 0,
          priority: colorPriority(color),
        };
        current.count += pointWeight;
        bucket.colorWeights.set(colorKey, current);
      }
    }
    buckets.set(key, bucket);
  }

  const clusters: ClusteredGeoPoint[] = [];
  for (const [id, bucket] of buckets.entries()) {
    const dominantColor = collapseOverlappingPointColors
      ? [...bucket.colorWeights.values()].sort(
          (a, b) => b.count - a.count || b.priority - a.priority,
        )[0]
      : undefined;
    clusters.push({
      id,
      latitude: bucket.sumLatitude / bucket.count,
      longitude: bucket.sumLongitude / bucket.count,
      count: bucket.count,
      color: dominantColor
        ? dominantColor.color
        : bucket.hasColor
          ? [
              Math.round(bucket.sumRed / bucket.count),
              Math.round(bucket.sumGreen / bucket.count),
              Math.round(bucket.sumBlue / bucket.count),
            ]
          : undefined,
      priority: dominantColor?.priority ?? bucket.priority,
    });
  }
  clusters.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return clusters;
}

function colorPriority(color: [number, number, number]): number {
  const [red, green, blue] = color;
  if (red >= 200 && green <= 120 && blue <= 140) return 3;
  if (green >= 150 && red <= 120) return 1;
  return 2;
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

export function GeoPointsMap3D({
  locale,
  messages,
  points,
  countryCounts = [],
  loading = false,
  emptyLabel,
  heightClassName = DEFAULT_MAP_HEIGHT_CLASS,
  countryHoverEnabled = true,
  pointColor = MAP_ACCENT_RGB,
  autoRotate = false,
  bordered = true,
  selectedCountryCode,
  onCountrySelect,
  collapseOverlappingPointColors = false,
  pointCrossfadeEnabled = true,
}: GeoPointsMap3DProps) {
  const { resolvedTheme } = useTheme();
  const isMobile = useIsMobile();
  const [mounted, setMounted] = useState(false);
  const [countryGeoJson, setCountryGeoJson] = useState<GeoJSON | null>(null);
  const [hoveredCountryKey, setHoveredCountryKey] = useState<string | null>(
    null,
  );
  const [hoveredCountryCode, setHoveredCountryCode] = useState<string | null>(
    null,
  );
  const [hoveredCountryName, setHoveredCountryName] = useState("");
  const [mapSettled, setMapSettled] = useState(false);
  const [currentZoom, setCurrentZoom] = useState(
    normalizeClusterZoom(DEFAULT_VIEW_STATE.zoom),
  );
  const hasClusterCrossfadeInitialized = useRef(false);
  const isGlobe = true;
  const autoRotateEnabled = autoRotate;
  const rotationPauseUntilRef = useRef(0);
  const rotationFrameRef = useRef<number | null>(null);
  const rotationPreviousTimeRef = useRef<number | null>(null);
  const rotationAccelerationStartRef = useRef<number | null>(null);
  const rotationRecoveryStartRef = useRef<number | null>(null);
  const rotationRecoveryFromRef = useRef<{
    longitude: number;
    latitude: number;
    zoom: number;
  } | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let active = true;

    fetch("/api/public/resources/world-countries", { cache: "force-cache" })
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

  const normalizedPoints = useMemo<GeoPointsMapPoint[]>(
    () =>
      points.filter(
        (item) =>
          Number.isFinite(item.latitude) &&
          Number.isFinite(item.longitude) &&
          Math.abs(item.latitude) <= 90 &&
          Math.abs(item.longitude) <= 180,
      ),
    [points],
  );

  const countryCountMap = useMemo(() => {
    const map = new globalThis.Map<string, GeoPointsMapCountryCount>();
    for (const row of countryCounts) {
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
  }, [countryCounts]);

  const initialViewState = useMemo(
    () =>
      isGlobe
        ? isMobile
          ? GLOBE_MOBILE_VIEW_STATE
          : GLOBE_VIEW_STATE
        : computeInitialViewState(normalizedPoints),
    [isGlobe, isMobile, normalizedPoints],
  );
  const mobileMinZoom =
    initialViewState.minZoom ?? DEFAULT_VIEW_STATE.minZoom ?? 0;
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
    () =>
      clusterGeoPoints(
        normalizedPoints,
        currentZoom,
        collapseOverlappingPointColors,
      ),
    [collapseOverlappingPointColors, currentZoom, normalizedPoints],
  );
  const [incomingClusters, setIncomingClusters] = useState<ClusteredGeoPoint[]>(
    () => clusteredPoints,
  );
  const [outgoingClusters, setOutgoingClusters] = useState<ClusteredGeoPoint[]>(
    [],
  );
  const [clusterFadeProgress, setClusterFadeProgress] = useState(1);
  const incomingClustersRef = useRef<ClusteredGeoPoint[]>(clusteredPoints);
  const mapRef = useRef<MapRef | null>(null);

  useEffect(() => {
    if (!pointCrossfadeEnabled) {
      hasClusterCrossfadeInitialized.current = true;
      incomingClustersRef.current = clusteredPoints;
      setIncomingClusters(clusteredPoints);
      setOutgoingClusters([]);
      setClusterFadeProgress(1);
      return;
    }

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
  }, [clusteredPoints, pointCrossfadeEnabled]);

  const incomingAlpha = Math.round(
    MAP_POINT_ALPHA_VISIBLE * clusterFadeProgress,
  );
  const outgoingAlpha = Math.round(
    MAP_POINT_ALPHA_VISIBLE * (1 - clusterFadeProgress),
  );

  const effectiveMapTheme: EffectiveMapTheme =
    mounted && resolvedTheme === "dark" ? "dark" : "light";
  const mapStyle = useMemo(
    () => buildRasterStyle(effectiveMapTheme, "globe"),
    [effectiveMapTheme],
  );

  useEffect(() => {
    setMapSettled(false);
  }, [mapInitialViewState, mapStyle]);
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
  const updateClusterZoom = useCallback((zoom: number) => {
    const nextZoom = normalizeClusterZoom(zoom);
    setCurrentZoom((prev) =>
      Math.abs(prev - nextZoom) > 0.0001 ? nextZoom : prev,
    );
  }, []);

  const layers = useMemo(() => {
    const result: Array<
      | ScatterplotLayer<ClusteredGeoPoint>
      | GeoJsonLayer<Record<string, unknown>>
    > = [];

    const createPointLayer = (
      id: string,
      data: ClusteredGeoPoint[],
      alpha: number,
    ): ScatterplotLayer<ClusteredGeoPoint> =>
      new ScatterplotLayer<ClusteredGeoPoint>({
        id,
        data,
        getFillColor: (item) => withAlpha(item.color ?? pointColor, alpha),
        getPosition: (item) => [item.longitude, item.latitude],
        getRadius: (item) => computeClusterPointRadius(item.count, currentZoom),
        radiusUnits: "pixels",
        radiusMinPixels: 2,
        radiusMaxPixels: 32,
        pickable: false,
        parameters: {
          depthCompare: "always",
          depthWriteEnabled: false,
        },
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

    result.push(
      new GeoJsonLayer<Record<string, unknown>>({
        id: "overview-country-outline-hover",
        data: countryGeoJson ?? EMPTY_COUNTRY_FEATURES,
        filled: true,
        stroked: true,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 0,
        getFillColor: (feature) =>
          countryHoverEnabled &&
          normalizedSelectedCountryCode &&
          resolveCountryCodeFromFeature(feature) ===
            normalizedSelectedCountryCode
            ? withAlpha(MAP_ACCENT_RGB, 80)
            : [0, 0, 0, 0],
        getLineColor: (feature) =>
          countryHoverEnabled &&
          normalizedSelectedCountryCode &&
          resolveCountryCodeFromFeature(feature) ===
            normalizedSelectedCountryCode
            ? withAlpha(MAP_ACCENT_RGB, 255)
            : countryHoverEnabled &&
                resolveCountryFeatureKey(feature) === hoveredCountryKey
              ? withAlpha(MAP_ACCENT_RGB, 240)
              : [0, 0, 0, 0],
        getLineWidth: (feature) =>
          countryHoverEnabled &&
          normalizedSelectedCountryCode &&
          resolveCountryCodeFromFeature(feature) ===
            normalizedSelectedCountryCode
            ? 3
            : countryHoverEnabled &&
                resolveCountryFeatureKey(feature) === hoveredCountryKey
              ? 2.5
              : 0,
        pickable: countryHoverEnabled,
        onHover: (info) => {
          if (!countryHoverEnabled) return;
          const feature = (info.object as CountryFeature | undefined) ?? null;
          const nextKey = resolveCountryFeatureKey(feature);
          const nextCode = resolveCountryCodeFromFeature(feature);
          const nextName = resolveCountryDisplayNameFromFeature(feature);
          setHoveredCountryKey((prev) => {
            const normalized = nextKey.length > 0 ? nextKey : null;
            return prev === normalized ? prev : normalized;
          });
          setHoveredCountryCode((prev) =>
            prev === nextCode ? prev : nextCode,
          );
          setHoveredCountryName((prev) =>
            prev === nextName ? prev : nextName,
          );
        },
        onClick: (info) => {
          if (!countryHoverEnabled) return;
          const feature = (info.object as CountryFeature | undefined) ?? null;
          handleCountryClick(feature);
        },
        updateTriggers: {
          getFillColor: normalizedSelectedCountryCode,
          getLineColor: [hoveredCountryKey, normalizedSelectedCountryCode],
          getLineWidth: [hoveredCountryKey, normalizedSelectedCountryCode],
        },
      }),
    );

    return result;
  }, [
    countryGeoJson,
    countryHoverEnabled,
    currentZoom,
    handleCountryClick,
    hoveredCountryKey,
    incomingAlpha,
    incomingClusters,
    normalizedSelectedCountryCode,
    outgoingAlpha,
    outgoingClusters,
    pointColor,
  ]);

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
  const hoveredCountryCounts = hoveredCountryCode
    ? countryCountMap.get(hoveredCountryCode)
    : null;
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
  const showCountryToolbar = countryHoverEnabled && Boolean(hoveredCountryKey);

  const pauseAutoRotate = useCallback(() => {
    rotationPauseUntilRef.current =
      performance.now() + GLOBE_USER_INTERACTION_PAUSE_MS;
    rotationPreviousTimeRef.current = null;
    rotationAccelerationStartRef.current = null;
    rotationRecoveryStartRef.current = null;
    rotationRecoveryFromRef.current = null;
  }, []);

  const markMapSettled = useCallback((map: MaplibreMap) => {
    if (!map.isStyleLoaded() || !map.areTilesLoaded()) return;
    setMapSettled(true);
  }, []);

  const applyProjectionMode = useCallback(
    (map: MaplibreMap) => {
      if (!map.isStyleLoaded()) return false;
      map.setProjection({ type: isGlobe ? "globe" : "mercator" });
      if (isGlobe) {
        map.jumpTo({
          center: [initialViewState.longitude, initialViewState.latitude],
          zoom: initialViewState.zoom,
          bearing: 0,
          pitch: 0,
        });
        setCurrentZoom(
          normalizeClusterZoom(initialViewState.zoom ?? GLOBE_VIEW_STATE.zoom),
        );
      }
      return true;
    },
    [initialViewState, isGlobe],
  );

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !isMobile) return;
    map.jumpTo({
      center: [initialViewState.longitude, initialViewState.latitude],
      zoom: initialViewState.zoom,
      bearing: 0,
      pitch: 0,
    });
    setCurrentZoom(
      normalizeClusterZoom(initialViewState.zoom ?? DEFAULT_VIEW_STATE.zoom),
    );
  }, [initialViewState, isMobile]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !mapLoaded || applyProjectionMode(map)) return;

    const handleStyleReady = () => {
      applyProjectionMode(map);
    };
    map.once("styledata", handleStyleReady);
    return () => {
      map.off("styledata", handleStyleReady);
    };
  }, [applyProjectionMode, mapLoaded]);

  useEffect(() => {
    if (!autoRotateEnabled || !mapSettled) return;

    const rotate = (timestamp: number) => {
      const map = mapRef.current?.getMap();
      if (!map) {
        rotationFrameRef.current = window.requestAnimationFrame(rotate);
        return;
      }

      const previous = rotationPreviousTimeRef.current ?? timestamp;
      rotationPreviousTimeRef.current = timestamp;
      if (timestamp < rotationPauseUntilRef.current) {
        rotationPreviousTimeRef.current = null;
        rotationRecoveryStartRef.current = null;
        rotationRecoveryFromRef.current = null;
      } else {
        const deltaSeconds = Math.min(0.08, (timestamp - previous) / 1000);
        const center = map.getCenter();
        const paused = rotationPauseUntilRef.current > 0;
        const recoveryStart =
          rotationRecoveryStartRef.current ?? (paused ? timestamp : null);
        if (paused && rotationRecoveryStartRef.current === null) {
          rotationRecoveryStartRef.current = recoveryStart;
          rotationRecoveryFromRef.current = {
            longitude: center.lng,
            latitude: center.lat,
            zoom: map.getZoom(),
          };
        }

        const recoveryElapsed = recoveryStart ? timestamp - recoveryStart : 0;
        const recoveryProgress = smoothstep(
          recoveryElapsed / GLOBE_RECOVERY_DURATION_MS,
        );
        if (!paused && rotationAccelerationStartRef.current === null) {
          rotationAccelerationStartRef.current = timestamp;
        }
        const accelerationElapsed = paused
          ? recoveryElapsed
          : timestamp - (rotationAccelerationStartRef.current ?? timestamp);
        const speedProgress = clamp(
          accelerationElapsed / GLOBE_ROTATION_ACCELERATION_MS,
          0,
          1,
        );
        const recoveryFrom = rotationRecoveryFromRef.current;
        const nextLatitude = recoveryFrom
          ? recoveryFrom.latitude +
            ((initialViewState.latitude ?? GLOBE_VIEW_STATE.latitude) -
              recoveryFrom.latitude) *
              recoveryProgress
          : (initialViewState.latitude ?? GLOBE_VIEW_STATE.latitude);
        const nextZoom = recoveryFrom
          ? recoveryFrom.zoom +
            ((initialViewState.zoom ?? GLOBE_VIEW_STATE.zoom) -
              recoveryFrom.zoom) *
              recoveryProgress
          : (initialViewState.zoom ?? GLOBE_VIEW_STATE.zoom);
        const nextLongitude = normalizeLongitude(
          center.lng +
            deltaSeconds * GLOBE_ROTATION_DEGREES_PER_SECOND * speedProgress,
        );

        map.jumpTo({
          center: [nextLongitude, nextLatitude],
          zoom: nextZoom,
          bearing: 0,
          pitch: 0,
        });

        if (
          paused &&
          recoveryElapsed >=
            Math.max(GLOBE_RECOVERY_DURATION_MS, GLOBE_ROTATION_ACCELERATION_MS)
        ) {
          rotationPauseUntilRef.current = 0;
          rotationAccelerationStartRef.current =
            timestamp - GLOBE_ROTATION_ACCELERATION_MS;
          rotationRecoveryStartRef.current = null;
          rotationRecoveryFromRef.current = null;
        }
      }

      rotationFrameRef.current = window.requestAnimationFrame(rotate);
    };

    rotationPreviousTimeRef.current = null;
    rotationAccelerationStartRef.current = null;
    rotationFrameRef.current = window.requestAnimationFrame(rotate);
    return () => {
      if (rotationFrameRef.current !== null) {
        window.cancelAnimationFrame(rotationFrameRef.current);
        rotationFrameRef.current = null;
      }
    };
  }, [autoRotateEnabled, initialViewState, mapSettled]);

  if (loading) {
    return (
      <div className={`flex ${heightClassName} items-center justify-center`}>
        <Spinner className="size-6" />
      </div>
    );
  }

  if (normalizedPoints.length === 0) {
    return (
      <div
        className={`flex ${heightClassName} items-center justify-center text-sm text-muted-foreground`}
      >
        {emptyLabel ?? messages.common.noData}
      </div>
    );
  }

  return (
    <div
      data-geo-map-mode="3d"
      className={`relative ${heightClassName} w-full overflow-hidden ${
        isGlobe ? "bg-background" : bordered ? "border border-border/70" : ""
      }`}
      style={MAP_VIEWPORT_RENDER_ISOLATION_STYLE}
    >
      {!mapSettled ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background">
          <Spinner className="size-6" />
        </div>
      ) : null}
      <motion.div
        className="absolute inset-0"
        initial={false}
        animate={{
          opacity: mapSettled ? 1 : 0,
          scale: mapSettled ? 1 : 0.5,
          y: mapSettled ? 0 : "50%",
        }}
        transition={{
          duration: 3,
          ease: [0.16, 1.45, 0.34, 1],
        }}
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
          renderWorldCopies={!isGlobe}
          onDragStart={(event) => {
            if (event.originalEvent) pauseAutoRotate();
          }}
          onDrag={(event) => {
            if (event.originalEvent) pauseAutoRotate();
          }}
          onZoomStart={(event) => {
            if (event.originalEvent) pauseAutoRotate();
          }}
          onMove={(event) => {
            if (event.originalEvent) pauseAutoRotate();
          }}
          onMoveEnd={(event) => {
            if (event.originalEvent) pauseAutoRotate();
          }}
          onZoom={(event) => {
            if (event.originalEvent) pauseAutoRotate();
            if (!isGlobe) updateClusterZoom(event.viewState.zoom);
          }}
          onMouseDown={pauseAutoRotate}
          onTouchStart={pauseAutoRotate}
          onLoad={(event) => {
            setMapLoaded(true);
            applyProjectionMode(event.target);
            markMapSettled(event.target);
          }}
          onIdle={(event) => markMapSettled(event.target)}
        >
          <DeckOverlay interleaved={false} layers={layers} />
        </Map>
      </motion.div>
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
            <div className="inline-flex items-center gap-4 border border-border/70 bg-background/92 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
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
                    <span key={`views-${hoveredViewsText}`}>
                      {hoveredViewsText}
                    </span>
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
  );
}
