import { memo, useEffect, useMemo, useRef, useState } from "react";
import Map, { useControl } from "react-map-gl/maplibre";
import { ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";

import {
  applyVectorBasemapColorOverrides,
  getVectorBasemapStyleUrl,
} from "@/lib/dashboard/map-basemap";
import type { Locale } from "@/lib/i18n/config";
import type { RealtimeVisitorPoint } from "@/lib/realtime/types";

type EffectiveMapTheme = "light" | "dark";

export interface RealtimeMapStageProps {
  locale: Locale;
  siteId: string;
  theme: EffectiveMapTheme;
  points: RealtimeVisitorPoint[];
}

const DEFAULT_VIEW_STATE = {
  longitude: 0,
  latitude: 20,
  zoom: 1.15,
  minZoom: 0.3,
  maxZoom: 7,
  pitch: 0,
  bearing: 0,
} as const;

const POINT_TRANSITION_DURATION_MS = 900;
const RIPPLE_DURATION_MS = 1800;
const MAX_RIPPLE_QUEUE = 220;
const MAX_RENDERED_OVERLAY_POINTS = 320;
const REALTIME_POINT_RGB = [52, 211, 153] as const;
const REALTIME_POINT_BASE_RADIUS_PX = 4.8;
const REALTIME_RIPPLE_BASE_RADIUS_PX = 34;

type AnimatedPointPhase = "enter" | "steady" | "exit";

interface AnimatedPoint {
  visitorId: string;
  latitude: number;
  longitude: number;
  lastEventAt: number;
  phase: AnimatedPointPhase;
  phaseStartedAt: number;
}

interface RealtimeRipplePoint {
  id: string;
  latitude: number;
  longitude: number;
  startedAt: number;
}

interface RenderedRealtimePoint {
  id: string;
  latitude: number;
  longitude: number;
  radius: number;
  fillColor: [number, number, number, number];
}

function hasValidCoordinate(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  return true;
}

function resolvePointProgress(point: AnimatedPoint, now: number): number {
  const elapsed = now - point.phaseStartedAt;
  const normalized = Math.max(
    0,
    Math.min(1, elapsed / POINT_TRANSITION_DURATION_MS),
  );
  if (point.phase === "enter") return normalized;
  if (point.phase === "exit") return 1 - normalized;
  return 1;
}

function resolveRippleProgress(
  ripple: RealtimeRipplePoint,
  now: number,
): number {
  return Math.max(
    0,
    Math.min(1, (now - ripple.startedAt) / RIPPLE_DURATION_MS),
  );
}

function resolveRippleOpacity(progress: number): number {
  if (progress <= 0 || progress >= 1) return 0;
  if (progress <= 0.25) {
    return 0.34 * (progress / 0.25);
  }
  return 0.34 * ((1 - progress) / 0.75);
}

function resolveRealtimeFillColor(
  opacity: number,
): [number, number, number, number] {
  return [
    REALTIME_POINT_RGB[0],
    REALTIME_POINT_RGB[1],
    REALTIME_POINT_RGB[2],
    Math.round(Math.max(0, Math.min(1, opacity)) * 255),
  ];
}

function getRenderedPointPosition(
  point: Pick<RenderedRealtimePoint, "longitude" | "latitude">,
): [number, number] {
  return [point.longitude, point.latitude];
}

function hasPointRelocated(
  previous: Pick<AnimatedPoint, "latitude" | "longitude">,
  next: Pick<AnimatedPoint, "latitude" | "longitude">,
): boolean {
  return (
    Math.abs(previous.latitude - next.latitude) > 0.0001 ||
    Math.abs(previous.longitude - next.longitude) > 0.0001
  );
}

const DeckOverlay = memo(function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
});

type RealtimeMapAnimationOverlayProps = Pick<
  RealtimeMapStageProps,
  "siteId" | "points"
>;

const RealtimeMapAnimationOverlay = memo(function RealtimeMapAnimationOverlay({
  siteId,
  points,
}: RealtimeMapAnimationOverlayProps) {
  const [animatedPoints, setAnimatedPoints] = useState<AnimatedPoint[]>([]);
  const [ripples, setRipples] = useState<RealtimeRipplePoint[]>([]);
  const [animationNow, setAnimationNow] = useState(() => Date.now());
  const hasInitializedPointStreamRef = useRef(false);
  const animatedPointsRef = useRef<AnimatedPoint[]>([]);

  useEffect(() => {
    hasInitializedPointStreamRef.current = false;
    animatedPointsRef.current = [];
    setAnimatedPoints([]);
    setRipples([]);
  }, [siteId]);

  useEffect(() => {
    animatedPointsRef.current = animatedPoints;
  }, [animatedPoints]);

  useEffect(() => {
    const isInitial = !hasInitializedPointStreamRef.current;
    const now = Date.now();
    const incoming = points
      .filter((point) => hasValidCoordinate(point.latitude, point.longitude))
      .map((point) => ({
        visitorId: point.visitorId,
        latitude: point.latitude,
        longitude: point.longitude,
        eventAt: point.eventAt,
      }));
    const rippleCandidates: RealtimeRipplePoint[] = [];
    const nextByVisitor = new globalThis.Map(
      animatedPointsRef.current.map(
        (point) => [point.visitorId, point] as const,
      ),
    );
    const incomingIds = new Set<string>();

    for (const point of incoming) {
      incomingIds.add(point.visitorId);
      const existing = nextByVisitor.get(point.visitorId);
      if (!existing) {
        nextByVisitor.set(point.visitorId, {
          visitorId: point.visitorId,
          latitude: point.latitude,
          longitude: point.longitude,
          lastEventAt: point.eventAt,
          phase: "enter",
          phaseStartedAt: now,
        });
        if (!isInitial) {
          rippleCandidates.push({
            id: `${point.visitorId}:${point.eventAt}:${now}`,
            latitude: point.latitude,
            longitude: point.longitude,
            startedAt: now,
          });
        }
        continue;
      }

      const isReturning = existing.phase === "exit";
      const isRelocated = hasPointRelocated(existing, point);
      const hasFreshActivity = point.eventAt > existing.lastEventAt;
      const shouldRestartEnter = isReturning || isRelocated;
      nextByVisitor.set(point.visitorId, {
        visitorId: point.visitorId,
        latitude: point.latitude,
        longitude: point.longitude,
        lastEventAt: Math.max(existing.lastEventAt, point.eventAt),
        phase: shouldRestartEnter ? "enter" : existing.phase,
        phaseStartedAt: shouldRestartEnter ? now : existing.phaseStartedAt,
      });
      if (!isInitial && (shouldRestartEnter || hasFreshActivity)) {
        rippleCandidates.push({
          id: `${point.visitorId}:${point.eventAt}:${now}`,
          latitude: point.latitude,
          longitude: point.longitude,
          startedAt: now,
        });
      }
    }

    for (const [visitorId, point] of nextByVisitor.entries()) {
      if (incomingIds.has(visitorId)) continue;
      if (point.phase === "exit") continue;
      nextByVisitor.set(visitorId, {
        ...point,
        phase: "exit",
        phaseStartedAt: now,
      });
    }

    const nextPoints = Array.from(nextByVisitor.values());
    animatedPointsRef.current = nextPoints;
    setAnimationNow(now);
    setAnimatedPoints(nextPoints);

    hasInitializedPointStreamRef.current = true;
    if (rippleCandidates.length > 0) {
      setRipples((previous) =>
        [...previous, ...rippleCandidates].slice(-MAX_RIPPLE_QUEUE),
      );
    }
  }, [points]);

  const hasPointTransition = useMemo(
    () => animatedPoints.some((point) => point.phase !== "steady"),
    [animatedPoints],
  );
  const hasActiveAnimations = hasPointTransition || ripples.length > 0;
  useEffect(() => {
    if (!hasActiveAnimations) return;
    let stopped = false;
    let rafId = 0;
    const tick = () => {
      if (stopped) return;
      const now = Date.now();
      setAnimationNow(now);
      setAnimatedPoints((previous) => {
        let changed = false;
        const next: AnimatedPoint[] = [];
        for (const point of previous) {
          if (point.phase === "steady") {
            next.push(point);
            continue;
          }

          const elapsed = now - point.phaseStartedAt;
          if (point.phase === "enter") {
            if (elapsed >= POINT_TRANSITION_DURATION_MS) {
              changed = true;
              next.push({
                ...point,
                phase: "steady",
                phaseStartedAt: now,
              });
              continue;
            }
            next.push(point);
            continue;
          }

          if (elapsed >= POINT_TRANSITION_DURATION_MS) {
            changed = true;
            continue;
          }
          next.push(point);
        }
        return changed ? next : previous;
      });
      setRipples((previous) => {
        const next = previous.filter(
          (ripple) => now - ripple.startedAt <= RIPPLE_DURATION_MS,
        );
        return next.length === previous.length ? previous : next;
      });
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [hasActiveAnimations]);

  const renderedPoints = useMemo<RenderedRealtimePoint[]>(() => {
    const next: RenderedRealtimePoint[] = [];
    for (const point of animatedPoints) {
      const progress = resolvePointProgress(point, animationNow);
      if (progress <= 0) continue;
      const scale = 0.1 + progress * 0.9;
      next.push({
        id: point.visitorId,
        latitude: point.latitude,
        longitude: point.longitude,
        radius: REALTIME_POINT_BASE_RADIUS_PX * scale,
        fillColor: resolveRealtimeFillColor(progress * 0.56),
      });
      if (next.length >= MAX_RENDERED_OVERLAY_POINTS) break;
    }
    return next;
  }, [animatedPoints, animationNow]);
  const renderedRipples = useMemo<RenderedRealtimePoint[]>(() => {
    const next: RenderedRealtimePoint[] = [];
    for (const ripple of ripples) {
      const progress = resolveRippleProgress(ripple, animationNow);
      if (progress <= 0 || progress >= 1) continue;
      const scale = 0.03 + progress * 0.97;
      next.push({
        id: ripple.id,
        latitude: ripple.latitude,
        longitude: ripple.longitude,
        radius: REALTIME_RIPPLE_BASE_RADIUS_PX * scale,
        fillColor: resolveRealtimeFillColor(resolveRippleOpacity(progress)),
      });
    }
    return next;
  }, [animationNow, ripples]);

  const layers = useMemo(
    () => [
      new ScatterplotLayer<RenderedRealtimePoint>({
        id: "realtime-map-ripples",
        data: renderedRipples,
        getFillColor: (point) => point.fillColor,
        getPosition: getRenderedPointPosition,
        getRadius: (point) => point.radius,
        radiusUnits: "pixels",
        radiusMinPixels: 0,
        radiusMaxPixels: REALTIME_RIPPLE_BASE_RADIUS_PX,
        pickable: false,
      }),
      new ScatterplotLayer<RenderedRealtimePoint>({
        id: "realtime-map-points",
        data: renderedPoints,
        getFillColor: (point) => point.fillColor,
        getPosition: getRenderedPointPosition,
        getRadius: (point) => point.radius,
        radiusUnits: "pixels",
        radiusMinPixels: 0,
        radiusMaxPixels: REALTIME_POINT_BASE_RADIUS_PX,
        pickable: false,
      }),
    ],
    [renderedPoints, renderedRipples],
  );
  return <DeckOverlay interleaved={false} layers={layers} />;
});

export const RealtimeMapStage = memo(function RealtimeMapStage({
  locale,
  siteId,
  theme,
  points,
}: RealtimeMapStageProps) {
  const mapStyle = useMemo(
    () => getVectorBasemapStyleUrl(theme, locale),
    [locale, theme],
  );

  return (
    <Map
      initialViewState={DEFAULT_VIEW_STATE}
      mapStyle={mapStyle}
      reuseMaps
      attributionControl={false}
      onStyleData={(event) =>
        applyVectorBasemapColorOverrides(event.target, theme)
      }
    >
      <RealtimeMapAnimationOverlay siteId={siteId} points={points} />
    </Map>
  );
});
