"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import NumberFlow, { continuous } from "@number-flow/react";
import type { StyleSpecification } from "maplibre-gl";
import Map, { type MapRef } from "react-map-gl/maplibre";
import { useTheme } from "next-themes";
import { useRealtimeChannel } from "@/hooks/use-realtime-channel";
import {
  RealtimeStatusDot,
  realtimeStatusText,
} from "@/components/dashboard/realtime-status-indicator";
import {
  RealtimeSummaryCardsSection,
  parseRealtimeCardFilters,
} from "@/components/dashboard/site-pages/realtime-summary-cards-section";
import { RealtimeLogStreamCard } from "@/components/dashboard/realtime-log-stream-card";
import { RealtimeTrafficTrendCard } from "@/components/dashboard/realtime-traffic-trend-card";
import { AutoTransition } from "@/components/ui/auto-transition";
import { useLiveSearchParams } from "@/lib/client-history";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface RealtimeClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
}

type EffectiveMapTheme = "light" | "dark";

const NUMBER_FLOW_BASELINE_STYLE = {
  lineHeight: 1,
  "--number-flow-mask-height": "0px",
  "--number-flow-mask-width": "0px",
} as const;
const CONTINUOUS_NUMBER_FLOW_PLUGINS = [continuous];

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

interface PositionedAnimatedPoint {
  visitorId: string;
  x: number;
  y: number;
  progress: number;
}

interface PositionedRipplePoint {
  id: string;
  x: number;
  y: number;
  progress: number;
}

function buildRasterStyle(theme: EffectiveMapTheme): StyleSpecification {
  const sourceId = `insightflare-realtime-map-source-${theme}`;
  const layerId = `insightflare-realtime-map-layer-${theme}`;
  const endpoint = `/api/map-tiles/{z}/{x}/{y}.png?theme=${theme}`;

  return {
    version: 8,
    name: `insightflare-realtime-map-${theme}`,
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

function hasPointRelocated(
  previous: Pick<AnimatedPoint, "latitude" | "longitude">,
  next: Pick<AnimatedPoint, "latitude" | "longitude">,
): boolean {
  return (
    Math.abs(previous.latitude - next.latitude) > 0.0001 ||
    Math.abs(previous.longitude - next.longitude) > 0.0001
  );
}

function projectToScreen(
  mapRef: MapRef | null,
  longitude: number,
  latitude: number,
): { x: number; y: number } | null {
  const map = mapRef?.getMap();
  if (!map) return null;
  const projected = map.project({ lng: longitude, lat: latitude });
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y))
    return null;
  return { x: projected.x, y: projected.y };
}

export function RealtimeClientPage({
  locale,
  messages,
  siteId,
  siteDomain,
}: RealtimeClientPageProps) {
  const searchParams = useLiveSearchParams();
  const realtime = useRealtimeChannel(siteId, {
    enabled: Boolean(siteId),
  });
  const { resolvedTheme } = useTheme();
  const searchParamsKey = searchParams.toString();

  const effectiveTheme: EffectiveMapTheme =
    resolvedTheme === "dark" ? "dark" : "light";
  const mapStyle = useMemo(
    () => buildRasterStyle(effectiveTheme),
    [effectiveTheme],
  );
  const requestFilters = useMemo(
    () => parseRealtimeCardFilters(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
  const [enableRollingNumber, setEnableRollingNumber] = useState(false);
  const [animatedPoints, setAnimatedPoints] = useState<AnimatedPoint[]>([]);
  const [ripples, setRipples] = useState<RealtimeRipplePoint[]>([]);
  const [animationNow, setAnimationNow] = useState(() => Date.now());
  const [mapViewVersion, setMapViewVersion] = useState(0);
  const mapRef = useRef<MapRef | null>(null);
  const hasInitializedPointStreamRef = useRef(false);
  const animatedPointsRef = useRef<AnimatedPoint[]>([]);

  useEffect(() => {
    if (!realtime.hasConnected) {
      setEnableRollingNumber(false);
      return;
    }

    const frame = requestAnimationFrame(() => {
      setEnableRollingNumber(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [realtime.hasConnected]);

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
    const incoming = realtime.points
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
  }, [realtime.points]);

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

  const positionedPoints = useMemo<PositionedAnimatedPoint[]>(() => {
    if (!mapRef.current) return [];
    const next: PositionedAnimatedPoint[] = [];
    for (const point of animatedPoints) {
      const progress = resolvePointProgress(point, animationNow);
      if (progress <= 0) continue;
      const projected = projectToScreen(
        mapRef.current,
        point.longitude,
        point.latitude,
      );
      if (!projected) continue;
      next.push({
        visitorId: point.visitorId,
        x: projected.x,
        y: projected.y,
        progress,
      });
      if (next.length >= MAX_RENDERED_OVERLAY_POINTS) break;
    }
    return next;
  }, [animatedPoints, animationNow, mapViewVersion]);
  const positionedRipples = useMemo<PositionedRipplePoint[]>(() => {
    if (!mapRef.current) return [];
    const next: PositionedRipplePoint[] = [];
    for (const ripple of ripples) {
      const progress = resolveRippleProgress(ripple, animationNow);
      if (progress <= 0 || progress >= 1) continue;
      const projected = projectToScreen(
        mapRef.current,
        ripple.longitude,
        ripple.latitude,
      );
      if (!projected) continue;
      next.push({
        id: ripple.id,
        x: projected.x,
        y: projected.y,
        progress,
      });
    }
    return next;
  }, [animationNow, mapViewVersion, ripples]);

  useEffect(() => {
    if (!mapRef.current) return;
    setMapViewVersion((value) => value + 1);
  }, [realtime.points.length]);

  const handleMapViewUpdate = () => {
    setMapViewVersion((value) => value + 1);
  };

  const showRealtimeMetrics = realtime.hasConnected;
  const statusLabel = realtimeStatusText(messages, realtime.status);

  return (
    <div className="space-y-6 pb-6">
      <div className="relative h-[min(72svh,calc(100svh-10.5rem))] min-h-[18rem] sm:min-h-[22rem] overflow-hidden">
        <Map
          ref={mapRef}
          initialViewState={DEFAULT_VIEW_STATE}
          mapStyle={mapStyle}
          reuseMaps
          attributionControl={false}
          onLoad={handleMapViewUpdate}
          onMove={handleMapViewUpdate}
          onResize={handleMapViewUpdate}
        />

        <div className="pointer-events-none absolute inset-0">
          {positionedRipples.map((ripple) => {
            const scale = 0.03 + ripple.progress * 0.97;
            return (
              <div
                key={ripple.id}
                className="absolute rounded-full"
                style={{
                  left: ripple.x,
                  top: ripple.y,
                  width: 68,
                  height: 68,
                  transform: `translate(-50%, -50%) scale(${scale})`,
                  transformOrigin: "center",
                  opacity: resolveRippleOpacity(ripple.progress),
                  backgroundColor: "#34d399",
                  willChange: "transform, opacity",
                }}
              />
            );
          })}
          {positionedPoints.map((point) => {
            const scale = 0.1 + point.progress * 0.9;
            return (
              <div
                key={point.visitorId}
                className="absolute rounded-full"
                style={{
                  left: point.x,
                  top: point.y,
                  width: 9.6,
                  height: 9.6,
                  transform: `translate(-50%, -50%) scale(${scale})`,
                  transformOrigin: "center",
                  opacity: point.progress * 0.56,
                  backgroundColor: "#34d399",
                  willChange: "transform, opacity",
                }}
              />
            );
          })}
        </div>

        <div className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-background via-background/65 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-background via-background/60 to-transparent" />

        <div className="pointer-events-none absolute left-4 top-4 z-10 md:left-6 md:top-6">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {messages.realtime.title}
            </h1>
            <p className="text-sm text-foreground/75">
              {messages.realtime.subtitle}
            </p>
          </div>
        </div>

        <div className="absolute bottom-4 left-4 z-10 inline-flex w-auto max-w-[calc(100vw-2rem)] md:left-6 md:max-w-[calc(100vw-3rem)]">
          <div className="w-auto max-w-full">
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {messages.realtime.liveMetrics}
              </p>
              <div className="min-w-0">
                <AutoTransition
                  type="fade"
                  duration={0.16}
                  initial={false}
                  presenceMode="wait"
                  className="inline-flex max-w-full items-end"
                >
                  {showRealtimeMetrics ? (
                    <div
                      key="realtime-metrics-value"
                      className="inline-flex max-w-full items-end gap-2 font-semibold text-foreground"
                    >
                      <NumberFlow
                        value={realtime.activeNow}
                        plugins={enableRollingNumber ? CONTINUOUS_NUMBER_FLOW_PLUGINS : undefined}
                        className="font-mono text-3xl leading-none tabular-nums md:text-4xl"
                        style={NUMBER_FLOW_BASELINE_STYLE}
                      />
                      <span className="pb-0.5 font-mono text-xl leading-none text-muted-foreground/70 md:text-2xl">
                        /
                      </span>
                      <NumberFlow
                        value={realtime.visitorsLast30m}
                        plugins={enableRollingNumber ? CONTINUOUS_NUMBER_FLOW_PLUGINS : undefined}
                        className="font-mono text-3xl leading-none tabular-nums md:text-4xl"
                        style={NUMBER_FLOW_BASELINE_STYLE}
                      />
                      <span className="pb-0.5 font-mono text-xl leading-none text-muted-foreground/70 md:text-2xl">
                        /
                      </span>
                      <NumberFlow
                        value={realtime.viewsLast30m}
                        plugins={enableRollingNumber ? CONTINUOUS_NUMBER_FLOW_PLUGINS : undefined}
                        className="font-mono text-3xl leading-none tabular-nums md:text-4xl"
                        style={NUMBER_FLOW_BASELINE_STYLE}
                      />
                    </div>
                  ) : (
                    <span
                      key="realtime-metrics-empty"
                      className="inline-flex items-end font-mono text-3xl font-semibold leading-none text-foreground tabular-nums md:text-4xl"
                    >
                      -- / -- / --
                    </span>
                  )}
                </AutoTransition>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <AutoTransition
                  type="fade"
                  duration={0.16}
                  initial={false}
                  presenceMode="wait"
                  className="inline-flex items-center gap-2"
                >
                  <span
                    key={`realtime-status-${realtime.status}`}
                    className="inline-flex items-center gap-2"
                  >
                    <RealtimeStatusDot status={realtime.status} />
                    <span>{statusLabel}</span>
                  </span>
                </AutoTransition>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[1400px] px-4 md:px-6">
        <div className="space-y-6">
          <RealtimeTrafficTrendCard
            locale={locale}
            messages={messages}
            hasConnected={realtime.hasConnected}
            events={realtime.events}
          />
          <RealtimeLogStreamCard
            locale={locale}
            messages={messages}
            hasConnected={realtime.hasConnected}
            events={realtime.events}
          />
          <RealtimeSummaryCardsSection
            locale={locale}
            messages={messages}
            siteId={siteId}
            siteDomain={siteDomain}
            visits={realtime.visits}
            filters={requestFilters}
          />
        </div>
      </div>
    </div>
  );
}
