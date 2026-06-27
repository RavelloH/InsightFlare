"use client";

import {
  memo,
  type MutableRefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Map, { type MapRef, useControl } from "react-map-gl/maplibre";
import { useTheme } from "next-themes";
import type { MapViewState } from "@deck.gl/core";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";
import type { Feature, GeoJSON, Geometry } from "geojson";
import isoCountries from "i18n-iso-countries";
import type { StyleSpecification } from "maplibre-gl";
import { animate, AnimatePresence, motion } from "motion/react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { numberFormat } from "@/lib/dashboard/format";
import type { ParsedGeoLocation } from "@/lib/dashboard/geo-location";
import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";

export interface GeoClientMapPoint {
  latitude: number;
  longitude: number;
  country: string;
  region?: string;
  regionCode?: string;
  city?: string;
  pointCount?: number;
}

export interface GeoClientMapCountryCount {
  country: string;
  views: number;
  sessions: number;
  visitors: number;
}

export interface GeoClientMapViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  minZoom?: number;
  maxZoom?: number;
  pitch?: number;
  bearing?: number;
}

export interface GeoClientMapStageProps {
  locale: Locale;
  isMobile: boolean;
  points: GeoClientMapPoint[];
  countryCounts: GeoClientMapCountryCount[];
  activeLocation: ParsedGeoLocation | null;
  viewState: GeoClientMapViewState;
  unknownLabel: string;
  viewsLabel: string;
  visitorsLabel: string;
  sessionsLabel: string;
  onSelectLocation: (nextLocation: string) => void;
}

interface ClusteredGeoPoint {
  id: string;
  latitude: number;
  longitude: number;
  count: number;
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
const CLUSTER_CROSSFADE_DURATION_S = 0.22;
const GEO_MAP_EDGE_PADDING_PX = 24;
const GEO_MAP_DESKTOP_PANEL_WIDTH_PX = 376;
const EMPTY_COUNTRY_FEATURES = {
  type: "FeatureCollection",
  features: [],
} as const satisfies GeoJSON;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function withAlpha(
  rgb: [number, number, number],
  alpha: number,
): [number, number, number, number] {
  return [rgb[0], rgb[1], rgb[2], alpha];
}

function resolveGeoMapPadding(isMobile: boolean): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (isMobile) {
    return {
      top: GEO_MAP_EDGE_PADDING_PX,
      right: GEO_MAP_EDGE_PADDING_PX,
      bottom: GEO_MAP_EDGE_PADDING_PX,
      left: GEO_MAP_EDGE_PADDING_PX,
    };
  }

  return {
    top: GEO_MAP_EDGE_PADDING_PX,
    right: GEO_MAP_DESKTOP_PANEL_WIDTH_PX + GEO_MAP_EDGE_PADDING_PX,
    bottom: GEO_MAP_EDGE_PADDING_PX,
    left: GEO_MAP_EDGE_PADDING_PX,
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

function normalizeCountryCode(value: string | null | undefined): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  return normalized;
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

function normalizeClusterZoom(zoom: number): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : DEFAULT_VIEW_STATE.zoom;
  const snapped = Math.round(safeZoom / CLUSTER_ZOOM_STEP) * CLUSTER_ZOOM_STEP;
  return clamp(
    snapped,
    DEFAULT_VIEW_STATE.minZoom ?? 0,
    DEFAULT_VIEW_STATE.maxZoom ?? 22,
  );
}

function clusterGeoPoints(
  points: GeoClientMapPoint[],
  zoom: number,
): ClusteredGeoPoint[] {
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
    // Use pointCount if available, otherwise count as 1
    const pointWeight = point.pointCount ?? 1;
    bucket.count += pointWeight;
    bucket.sumLatitude += point.latitude * pointWeight;
    bucket.sumLongitude += point.longitude * pointWeight;
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

function computeClusterPointRadius(count: number, zoom: number): number {
  const safeCount = Number.isFinite(count) ? Math.max(1, count) : 1;
  const safeZoom = normalizeClusterZoom(zoom);
  const baseRadius = 2.8 + Math.log2(safeCount + 1) * 2.15;
  const zoomScale = clamp(0.62 + safeZoom * 0.18, 0.74, 1.28);
  return clamp(baseRadius * zoomScale, 2.2, 32);
}

function animateMapTransition(
  map: MapRef,
  targetViewState: GeoClientMapViewState,
  targetLocation: ParsedGeoLocation | null,
  animationKeyRef: MutableRefObject<number>,
  onStart: () => void,
  onComplete: (zoom: number) => void,
) {
  const animationKey = ++animationKeyRef.current;
  const minimumZoom = 0.75;
  const targetZoom = Number(targetViewState.zoom ?? DEFAULT_VIEW_STATE.zoom);
  const targetCenter: [number, number] = [
    Number(targetViewState.longitude ?? DEFAULT_VIEW_STATE.longitude),
    Number(targetViewState.latitude ?? DEFAULT_VIEW_STATE.latitude),
  ];

  const runStep = (step: () => void) => {
    if (animationKeyRef.current !== animationKey) return;
    step();
  };

  if (!Number.isFinite(targetCenter[0]) || !Number.isFinite(targetCenter[1])) {
    return;
  }

  map.stop();
  onStart();
  if (targetLocation) {
    map.easeTo({
      center: targetCenter,
      zoom: targetZoom,
      duration: 950,
      essential: true,
    });
    map.once("moveend", () =>
      runStep(() => {
        onComplete(targetZoom);
      }),
    );
    return;
  }

  map.easeTo({
    zoom: minimumZoom,
    duration: 450,
    essential: true,
  });

  map.once("moveend", () =>
    runStep(() => {
      map.easeTo({
        center: targetCenter,
        zoom: minimumZoom,
        duration: 700,
        essential: true,
      });

      map.once("moveend", () =>
        runStep(() => {
          map.easeTo({
            center: targetCenter,
            zoom: targetZoom,
            duration: 850,
            essential: true,
          });
          map.once("moveend", () =>
            runStep(() => {
              onComplete(targetZoom);
            }),
          );
        }),
      );
    }),
  );
}

const DeckOverlay = memo(function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
});

export function GeoClientMapStage({
  locale,
  isMobile,
  points,
  countryCounts,
  activeLocation,
  viewState,
  unknownLabel,
  viewsLabel,
  visitorsLabel,
  sessionsLabel,
  onSelectLocation,
}: GeoClientMapStageProps) {
  const { resolvedTheme } = useTheme();
  const [countryGeoJson, setCountryGeoJson] = useState<GeoJSON | null>(null);
  const [hoveredCountryKey, setHoveredCountryKey] = useState<string | null>(
    null,
  );
  const [hoveredCountryCode, setHoveredCountryCode] = useState<string | null>(
    null,
  );
  const [currentZoom, setCurrentZoom] = useState(
    normalizeClusterZoom(viewState.zoom ?? DEFAULT_VIEW_STATE.zoom),
  );
  const [isMapMoving, setIsMapMoving] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const mapRef = useRef<MapRef | null>(null);
  const mapAnimationKeyRef = useRef(0);
  const transitionKeyRef = useRef("");
  const hasClusterCrossfadeInitialized = useRef(false);

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
    const applyPadding = () => {
      const map = mapRef.current?.getMap();
      if (!map) return;
      map.setPadding(resolveGeoMapPadding(isMobile));
    };

    applyPadding();
    globalThis.window.addEventListener("resize", applyPadding);
    return () => {
      globalThis.window.removeEventListener("resize", applyPadding);
    };
  }, [isMobile]);

  useEffect(() => {
    if (activeLocation) {
      setHoveredCountryKey(null);
      setHoveredCountryCode(null);
    }
  }, [activeLocation]);

  const transitionKey = [
    activeLocation?.canonical ?? "world",
    viewState.latitude,
    viewState.longitude,
    viewState.zoom,
  ].join(":");

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    if (transitionKeyRef.current === transitionKey) return;
    transitionKeyRef.current = transitionKey;

    animateMapTransition(
      map,
      viewState,
      activeLocation,
      mapAnimationKeyRef,
      () => {
        setIsMapMoving(true);
      },
      (zoom) => {
        setCurrentZoom(normalizeClusterZoom(zoom));
        setIsMapMoving(false);
      },
    );
  }, [activeLocation, mapLoaded, transitionKey, viewState]);

  const effectiveMapTheme: EffectiveMapTheme =
    resolvedTheme === "dark" ? "dark" : "light";
  const mapStyle = useMemo(
    () => buildRasterStyle(effectiveMapTheme),
    [effectiveMapTheme],
  );
  const clusteredPoints = useMemo(
    () => clusterGeoPoints(points, currentZoom),
    [currentZoom, points],
  );
  const [incomingClusters, setIncomingClusters] = useState<ClusteredGeoPoint[]>(
    () => clusteredPoints,
  );
  const [outgoingClusters, setOutgoingClusters] = useState<ClusteredGeoPoint[]>(
    [],
  );
  const [clusterFadeProgress, setClusterFadeProgress] = useState(1);
  const incomingClustersRef = useRef<ClusteredGeoPoint[]>(clusteredPoints);

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

  const countryCountMap = useMemo(() => {
    const map = new globalThis.Map<string, GeoClientMapCountryCount>();
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

  const incomingAlpha = Math.round(
    MAP_POINT_ALPHA_VISIBLE * clusterFadeProgress,
  );
  const outgoingAlpha = Math.round(
    MAP_POINT_ALPHA_VISIBLE * (1 - clusterFadeProgress),
  );
  const showCountryHover = !activeLocation && !isMapMoving;
  const layers = useMemo(() => {
    const nextLayers: Array<
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
        getFillColor: withAlpha(MAP_ACCENT_RGB, alpha),
        getPosition: (item) => [item.longitude, item.latitude],
        getRadius: (item) => computeClusterPointRadius(item.count, currentZoom),
        radiusUnits: "pixels",
        radiusMinPixels: 2,
        radiusMaxPixels: 32,
        pickable: false,
      });

    if (outgoingClusters.length > 0 && outgoingAlpha > 0) {
      nextLayers.push(
        createPointLayer(
          "geo-page-clustered-points-outgoing",
          outgoingClusters,
          outgoingAlpha,
        ),
      );
    }

    if (incomingClusters.length > 0 && incomingAlpha > 0) {
      nextLayers.push(
        createPointLayer(
          "geo-page-clustered-points-incoming",
          incomingClusters,
          incomingAlpha,
        ),
      );
    }

    if (showCountryHover) {
      nextLayers.push(
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
            setHoveredCountryKey((previous) => {
              const normalized = nextKey.length > 0 ? nextKey : null;
              return previous === normalized ? previous : normalized;
            });
            setHoveredCountryCode((previous) =>
              previous === nextCode ? previous : nextCode,
            );
          },
          onClick: (info) => {
            const feature = (info.object as CountryFeature | undefined) ?? null;
            const nextCode = resolveCountryCodeFromFeature(feature);
            if (!nextCode) return;
            onSelectLocation(nextCode);
          },
          updateTriggers: {
            getLineColor: hoveredCountryKey,
            getLineWidth: hoveredCountryKey,
          },
        }),
      );
    }

    return nextLayers;
  }, [
    countryGeoJson,
    currentZoom,
    hoveredCountryKey,
    incomingAlpha,
    incomingClusters,
    onSelectLocation,
    outgoingAlpha,
    outgoingClusters,
    showCountryHover,
  ]);

  const hoveredCountryLabel = useMemo(() => {
    if (hoveredCountryCode) {
      return resolveCountryLabel(hoveredCountryCode, locale, unknownLabel)
        .label;
    }
    return unknownLabel;
  }, [hoveredCountryCode, locale, unknownLabel]);
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
  const showCountryToolbar = Boolean(hoveredCountryKey) && !activeLocation;

  return (
    <>
      <Map
        ref={mapRef}
        initialViewState={viewState}
        mapStyle={mapStyle}
        attributionControl={false}
        scrollZoom
        maxPitch={0}
        dragRotate={false}
        pitchWithRotate={false}
        onLoad={(event) => {
          event.target.setPadding(resolveGeoMapPadding(isMobile));
          transitionKeyRef.current = transitionKey;
          setCurrentZoom(
            normalizeClusterZoom(
              event.target.getZoom() ?? DEFAULT_VIEW_STATE.zoom,
            ),
          );
          setIsMapMoving(false);
          setMapLoaded(true);
        }}
        onZoom={(event) => {
          const nextZoom = normalizeClusterZoom(event.viewState.zoom);
          setCurrentZoom((previous) =>
            Math.abs(previous - nextZoom) > 0.0001 ? nextZoom : previous,
          );
        }}
      >
        <DeckOverlay interleaved={false} layers={layers} />
      </Map>

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
                <span>{viewsLabel}:</span>
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
                <span>{visitorsLabel}:</span>
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
                <span>{sessionsLabel}:</span>
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
    </>
  );
}
