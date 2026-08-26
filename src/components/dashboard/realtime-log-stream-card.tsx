import {
  memo,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Icon } from "@iconify/react";
import {
  RiExternalLinkLine,
  RiGlobalLine,
  RiPulseLine,
} from "@remixicon/react";
import Avatar from "boring-avatars";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { PartialOptions } from "overlayscrollbars";
import { OverlayScrollbars } from "overlayscrollbars";

import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import {
  GeoPointsMapIsland,
  type GeoPointsMapPoint,
} from "@/components/dashboard/geo-points-map-island";
import {
  formatPathWithHash,
  resolveDeviceTypeMeta,
} from "@/components/dashboard/journey-display";
import { JsonTreePanel } from "@/components/dashboard/json-tree";
import { useGeoStateTranslationBundle } from "@/components/dashboard/lazy-geo-location-label";
import { DetailDrawer } from "@/components/dashboard/site-pages/detail-drawer";
import { SessionDetailClientPage } from "@/components/dashboard/site-pages/session-detail-client-page";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
} from "@/components/ui/drawer";
import { prepareNativeScrollbarHost } from "@/components/ui/overlay-scrollbar";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import { intlLocale, shortDateTime } from "@/lib/dashboard/format";
import { parseGeoLocationValue } from "@/lib/dashboard/geo-location";
import {
  formatLocalizedGeoValue,
  resolveLocalizedCityName,
} from "@/lib/dashboard/geo-translation";
import dynamic from "@/lib/dynamic";
import {
  resolveContinentLabel,
  resolveCountryFlagCode,
  resolveCountryLabel,
  resolveLanguageLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import type { RealtimeEvent, RealtimeVisit } from "@/lib/realtime/types";
import { cn } from "@/lib/utils";

interface RealtimeLogStreamCardProps {
  locale: Locale;
  messages: AppMessages;
  hasConnected: boolean;
  events: RealtimeEvent[];
  visits: RealtimeVisit[];
  siteId?: string;
  pathname?: string;
}

const PRESENCE_LEAVE_EVENT = "__presence_leave";
const RELATIVE_TIME_REFRESH_MS = 1_000;
const EVENT_INTEGRATION_WINDOW_MS = 60_000;
const INITIAL_VISIBLE_EVENTS = 24;
const LOAD_MORE_STEP = 24;
const LOAD_MORE_THRESHOLD_PX = 160;
const VISITOR_AVATAR_COLORS = [
  "#0f172a",
  "#1d4ed8",
  "#0f766e",
  "#f59e0b",
  "#e11d48",
];
const BROWSER_ICON_DIR = "/images/browser";
const OS_ICON_DIR = "/images/os";
const UNKNOWN_ICON_KEY = "unknown";
const BROWSER_APPLE_ICON_KEYS = new Set(["ios", "ios-webview"]);
const OS_APPLE_ICON_KEYS = new Set(["ios", "mac-os"]);
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;
const PANEL_SCROLLBAR_OPTIONS = {
  update: {
    // Realtime list/detail content updates already call instance.update via syncKey.
    // Avoid scanning every mutation for image load listeners on each refresh.
    elementEvents: null,
  },
  overflow: {
    x: "hidden",
    y: "scroll",
  },
  scrollbars: {
    theme: "os-theme-insightflare",
    autoHide: "move",
    autoHideDelay: 420,
    autoHideSuspend: false,
  },
} satisfies PartialOptions;

const VisitorDetailClientPage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/visitor-detail-client-page").then(
      (module) => module.VisitorDetailClientPage,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="p-6 text-sm text-muted-foreground">Loading...</div>
    ),
  },
);

type RealtimeLogEventKind = "enter" | "exit" | "view" | "visibility" | "custom";
type RealtimeEventDisplayData = {
  kind: RealtimeLogEventKind;
  title: string;
  avatarSeed: string;
  browserLabel: string;
  browserIconKey: string;
  osLabel: string;
  osIconKey: string;
  countryLabel: string;
  countryFlagCode: string | null;
  sourceLabel: string;
};
type RealtimeNestedJourneyDetail = {
  kind: "visitor" | "session";
  id: string;
  stackKey: string;
  open: boolean;
};
type RealtimeNestedEventDetail = {
  event: RealtimeEvent;
  stackKey: string;
  open: boolean;
};
const NESTED_DRAWER_EXIT_DURATION_MS = 420;
const LOG_STREAM_ITEM_LAYOUT_TRANSITION = {
  layout: {
    duration: 0.34,
    ease: [0.22, 1, 0.36, 1],
  },
  opacity: {
    duration: 0.18,
    ease: [0.22, 1, 0.36, 1],
  },
} as const;

function hasValidCoordinate(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  const lat = Number(latitude);
  const lon = Number(longitude);
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function classifyRealtimeLogEvent(
  event: Pick<RealtimeEvent, "eventType" | "eventKind">,
): RealtimeLogEventKind {
  if (
    event.eventKind === "visibility" ||
    event.eventType.trim() === "visibility"
  ) {
    return "visibility";
  }
  const eventType = event.eventType.trim();
  if (eventType === "visit") return "enter";
  if (eventType === PRESENCE_LEAVE_EVENT) return "exit";
  if (eventType === "pageview") return "view";
  return "custom";
}

function eventTitlePrefix(
  messages: AppMessages,
  kind: RealtimeLogEventKind,
): string {
  if (kind === "enter") return messages.realtime.enterPage;
  if (kind === "exit") return messages.realtime.leavePage;
  if (kind === "view") return messages.realtime.viewPage;
  return messages.realtime.customEvent;
}

function formatLogTitle(
  messages: AppMessages,
  event: RealtimeEvent,
  kind: RealtimeLogEventKind,
): string {
  const separator = messages.realtime.logTitleSeparator;
  if (kind === "visibility") {
    const visibilityTitle =
      event.visibilityState?.trim() === "visible"
        ? messages.realtime.visibilityVisible
        : event.visibilityState?.trim() === "hidden"
          ? messages.realtime.visibilityHidden
          : messages.realtime.visibilityChange;
    const path = event.pathname.trim()
      ? formatPathWithHash(event.pathname, event.hash)
      : messages.common.unknown;
    return `${visibilityTitle}${separator}${path}`;
  }
  const prefix = eventTitlePrefix(messages, kind);
  const content =
    kind === "custom"
      ? event.eventType.trim() || messages.common.unknown
      : formatPathWithHash(event.pathname, event.hash);
  return `${prefix}${separator}${content}`;
}

function resolveBrowserIconKey(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return UNKNOWN_ICON_KEY;
  if (
    normalized.includes("android webview") ||
    normalized.includes("android-webview")
  ) {
    return "android-webview";
  }
  if (normalized.includes("chromium-webview")) return "chromium-webview";
  if (normalized.includes("edge ios")) return "edge-ios";
  if (normalized.includes("edge")) return "edge-chromium";
  if (normalized.includes("chrome ios") || normalized.includes("crios"))
    return "crios";
  if (normalized.includes("firefox ios") || normalized.includes("fxios"))
    return "fxios";
  if (normalized.includes("ios webview")) return "ios-webview";
  if (normalized === "ios") return "ios";
  if (normalized.includes("arc")) return "arc";
  if (normalized.includes("opera mini")) return "opera-mini";
  if (normalized.includes("opera gx")) return "opera-gx";
  if (normalized.includes("opera")) return "opera";
  if (normalized.includes("samsung")) return "samsung";
  if (normalized.includes("wechat")) return "wechat";
  if (normalized.includes("duckduckgo")) return "duckduckgo";
  if (normalized.includes("instagram")) return "instagram";
  if (normalized.includes("facebook")) return "facebook";
  if (normalized.includes("huawei")) return "huawei";
  if (
    normalized.includes("qqbrowser") ||
    normalized.includes("qq browser") ||
    normalized === "qq"
  ) {
    return "qq";
  }
  if (normalized.includes("ucbrowser") || normalized.includes("uc browser"))
    return "uc";
  if (normalized.includes("brave")) return "brave";
  if (normalized.includes("miui")) return "miui";
  if (normalized.includes("firefox")) return "firefox";
  if (normalized.includes("safari")) return "safari";
  if (normalized.includes("chrome") || normalized.includes("chromium"))
    return "chrome";
  if (normalized.includes("android")) return "android";
  return UNKNOWN_ICON_KEY;
}

function resolveOsIconKey(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return UNKNOWN_ICON_KEY;
  if (normalized.includes("windows 11")) return "windows-11";
  if (normalized.includes("windows 10")) return "windows-10";
  if (normalized.startsWith("windows")) return "windows-10";
  if (
    normalized.startsWith("mac") ||
    normalized.startsWith("os x") ||
    normalized.startsWith("darwin")
  ) {
    return "mac-os";
  }
  if (normalized.startsWith("ios")) return "ios";
  if (normalized.startsWith("android")) return "android-os";
  if (
    normalized.startsWith("chrome os") ||
    normalized.startsWith("chromium os")
  ) {
    return "chrome-os";
  }
  if (
    normalized.includes("linux") ||
    normalized.startsWith("ubuntu") ||
    normalized.startsWith("debian") ||
    normalized.startsWith("fedora")
  ) {
    return "linux";
  }
  return UNKNOWN_ICON_KEY;
}

function sanitizeHostname(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z\d+\-.]*:\/\//i, "")
    .replace(/\/+.*$/, "");
}

function resolveFaviconUrlForLabel(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0 || raw.startsWith("/")) return null;
  try {
    if (ABSOLUTE_URL_PATTERN.test(raw)) {
      const parsed = new URL(raw);
      return `${parsed.origin}/favicon.ico`;
    }
    if (raw.startsWith("//")) {
      const parsed = new URL(`https:${raw}`);
      return `${parsed.origin}/favicon.ico`;
    }
    const hostname = sanitizeHostname(raw);
    if (!hostname) return null;
    const parsed = new URL(`https://${hostname}`);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function leadingLabelLetter(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "?";
  return normalized.slice(0, 1).toUpperCase();
}

function handleImageFallback(
  event: SyntheticEvent<HTMLImageElement>,
  fallbackSrc: string,
): void {
  const target = event.currentTarget;
  if (target.dataset.fallbackApplied === "true") return;
  target.dataset.fallbackApplied = "true";
  target.src = fallbackSrc;
}

function LogoIcon({
  src,
  fallbackSrc,
  invertInDark = false,
}: {
  src: string;
  fallbackSrc: string;
  invertInDark?: boolean;
}) {
  return (
    <img
      src={src}
      alt=""
      width={16}
      height={16}
      className={`block h-4 w-4 shrink-0 ${invertInDark ? "dark:invert" : ""}`}
      loading="lazy"
      decoding="async"
      onError={(event) => {
        handleImageFallback(event, fallbackSrc);
      }}
    />
  );
}

function DomainOrUrlIcon({
  label,
  unknownLabel,
}: {
  label: string;
  unknownLabel: string;
}) {
  const normalized = label.trim();
  const src =
    normalized.length === 0 || normalized === unknownLabel
      ? null
      : resolveFaviconUrlForLabel(normalized);
  const [iconLoaded, setIconLoaded] = useState(false);
  const [iconFailed, setIconFailed] = useState(false);

  useEffect(() => {
    setIconLoaded(false);
    setIconFailed(false);

    if (!src) return;

    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      setIconLoaded(true);
    };
    image.onerror = () => {
      if (!active) return;
      setIconFailed(true);
    };
    image.src = src;

    return () => {
      active = false;
    };
  }, [src]);

  const showFavicon = Boolean(src) && iconLoaded && !iconFailed;
  const fallbackValue = normalized === unknownLabel ? "" : normalized;

  return showFavicon ? (
    <img
      src={src!}
      alt=""
      width={16}
      height={16}
      className="block size-4 shrink-0 object-contain"
      loading="lazy"
      decoding="async"
    />
  ) : (
    <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] bg-card text-[10px] font-medium leading-none text-muted-foreground">
      {leadingLabelLetter(fallbackValue)}
    </span>
  );
}

function MetaItem({
  icon,
  label,
  hideLabelOnMobile = false,
}: {
  icon: ReactNode;
  label: string;
  hideLabelOnMobile?: boolean;
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 text-[11px] text-muted-foreground"
      aria-label={hideLabelOnMobile ? label : undefined}
      title={hideLabelOnMobile ? label : undefined}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span
        className={cn(
          hideLabelOnMobile ? "hidden sm:inline sm:truncate" : "truncate",
        )}
      >
        {label}
      </span>
    </span>
  );
}

function maybeReachScrollEnd(
  instance: ReturnType<typeof OverlayScrollbars> | null,
  onReachEnd?: (() => void) | null,
): void {
  if (!instance || !onReachEnd) return;
  maybeReachScrollElementEnd(
    instance.elements().scrollOffsetElement,
    onReachEnd,
  );
}

function maybeReachScrollElementEnd(
  scrollElement: HTMLElement | null,
  onReachEnd?: (() => void) | null,
): void {
  if (!scrollElement || !onReachEnd) return;
  const remaining =
    scrollElement.scrollHeight -
    scrollElement.clientHeight -
    scrollElement.scrollTop;
  if (remaining <= LOAD_MORE_THRESHOLD_PX) {
    onReachEnd();
  }
}

function LogStreamScrollbar({
  children,
  className,
  maskClassName,
  syncKey,
  onReachEnd,
}: {
  children: ReactNode;
  className?: string;
  maskClassName?: string;
  syncKey?: string | number | boolean | null;
  onReachEnd?: (() => void) | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(
    null,
  );
  const onReachEndRef = useRef<(() => void) | null>(onReachEnd ?? null);
  useEffect(() => {
    onReachEndRef.current = onReachEnd ?? null;
  }, [onReachEnd]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (prepareNativeScrollbarHost(host)) {
      const handleScroll = () => {
        maybeReachScrollElementEnd(host, onReachEndRef.current);
      };

      host.addEventListener("scroll", handleScroll, { passive: true });
      requestAnimationFrame(() => {
        maybeReachScrollElementEnd(host, onReachEndRef.current);
      });

      return () => {
        host.removeEventListener("scroll", handleScroll);
      };
    }

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, PANEL_SCROLLBAR_OPTIONS);
    if (existing) {
      existing.options(PANEL_SCROLLBAR_OPTIONS);
    }
    scrollbarRef.current = instance;
    instance.update();

    const removeScrollListener = instance.on("scroll", () => {
      maybeReachScrollEnd(instance, onReachEndRef.current);
    });
    requestAnimationFrame(() => {
      maybeReachScrollEnd(instance, onReachEndRef.current);
    });

    return () => {
      removeScrollListener();
      if (!existing) {
        instance.destroy();
      }
      if (scrollbarRef.current === instance) {
        scrollbarRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const instance = scrollbarRef.current;
    if (!instance) {
      requestAnimationFrame(() => {
        maybeReachScrollElementEnd(hostRef.current, onReachEndRef.current);
      });
      return;
    }
    instance.update();
    requestAnimationFrame(() => {
      maybeReachScrollEnd(instance, onReachEndRef.current);
    });
  }, [syncKey]);

  return (
    <VerticalScrollMask
      hostRef={hostRef}
      className={className}
      maskClassName={maskClassName}
      scrollbarOptions={PANEL_SCROLLBAR_OPTIONS}
      syncKey={syncKey}
    >
      {children}
    </VerticalScrollMask>
  );
}

function formatRelativeTime(
  locale: Locale,
  timestamp: number,
  now: number,
): string {
  const formatter = getRelativeTimeFormatter(locale);
  const diffSeconds = Math.round((timestamp - now) / 1000);
  const absoluteSeconds = Math.abs(diffSeconds);

  if (absoluteSeconds < 60) {
    return formatter.format(diffSeconds, "second");
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
}

const relativeTimeFormatterCache = new Map<Locale, Intl.RelativeTimeFormat>();

let realtimeClockNow = Date.now();
let realtimeClockTimer: number | null = null;
const realtimeClockSubscribers = new Set<() => void>();

function subscribeRealtimeClock(
  onStoreChange: () => void,
  enabled = true,
): () => void {
  if (!enabled || typeof window === "undefined") return () => undefined;

  realtimeClockSubscribers.add(onStoreChange);
  if (realtimeClockTimer === null) {
    realtimeClockNow = Date.now();
    realtimeClockTimer = window.setInterval(() => {
      realtimeClockNow = Date.now();
      realtimeClockSubscribers.forEach((subscriber) => subscriber());
    }, RELATIVE_TIME_REFRESH_MS);
  }

  return () => {
    realtimeClockSubscribers.delete(onStoreChange);
    if (realtimeClockSubscribers.size === 0 && realtimeClockTimer !== null) {
      window.clearInterval(realtimeClockTimer);
      realtimeClockTimer = null;
    }
  };
}

function getRealtimeClockSnapshot() {
  return realtimeClockNow;
}

function useRealtimeClock(enabled = true) {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeRealtimeClock(onStoreChange, enabled),
    [enabled],
  );

  return useSyncExternalStore(
    subscribe,
    getRealtimeClockSnapshot,
    getRealtimeClockSnapshot,
  );
}

function getRelativeTimeFormatter(locale: Locale): Intl.RelativeTimeFormat {
  const cached = relativeTimeFormatterCache.get(locale);
  if (cached) return cached;

  const formatter = new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: "auto",
  });
  relativeTimeFormatterCache.set(locale, formatter);
  return formatter;
}

const RealtimeRelativeTime = memo(function RealtimeRelativeTime({
  locale,
  timestamp,
}: {
  locale: Locale;
  timestamp: number;
}) {
  const now = useRealtimeClock();
  return formatRelativeTime(locale, timestamp, now);
});

function formatDetailDateTime(
  locale: Locale,
  value: number,
  timeZone: string,
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatTimelineTime(
  locale: Locale,
  value: number,
  timeZone: string,
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatCoordinateValue(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return value.toFixed(4);
}

function formatOptionalDetailDateTime(
  locale: Locale,
  value: number | null | undefined,
  timeZone: string,
  unknownLabel: string,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return unknownLabel;
  }
  return formatDetailDateTime(locale, value, timeZone);
}

function formatDetailBoolean(
  value: boolean | null | undefined,
  unknownLabel: string,
  trueLabel: string,
  falseLabel: string,
): string {
  if (typeof value !== "boolean") return unknownLabel;
  return value ? trueLabel : falseLabel;
}

function resolveLocalizedDetailValue(
  value: string | undefined,
  labels: Record<string, string>,
  unknownLabel: string,
): string {
  const normalized = value?.trim().toLowerCase() || "";
  if (!normalized) return unknownLabel;
  return labels[normalized] || value?.trim() || unknownLabel;
}

function readRealtimePerformanceMetric(
  performance: unknown,
  key: "ttfb" | "fcp" | "lcp" | "cls" | "inp",
): number | null {
  if (
    !performance ||
    typeof performance !== "object" ||
    Array.isArray(performance)
  ) {
    return null;
  }
  const value = (performance as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatRealtimePerformanceMetric(
  performance: unknown,
  key: "ttfb" | "fcp" | "lcp" | "cls" | "inp",
  messages: AppMessages,
  unknownLabel: string,
): string {
  const value = readRealtimePerformanceMetric(performance, key);
  if (value === null) return unknownLabel;
  const unit =
    key === "cls" ? messages.performance.clsUnit : messages.performance.msUnit;
  return `${value} ${unit}`;
}

function formatDetailDuration(
  value: number | null | undefined,
  unknownLabel: string,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value} ms`
    : unknownLabel;
}

function getRealtimeEventIntegrationRemainingSeconds(
  event: Pick<RealtimeEvent, "eventAt" | "receivedAt">,
  now: number,
): number {
  const sentAt = event.receivedAt ?? event.eventAt;
  if (!Number.isFinite(sentAt)) return 0;

  const elapsedMs = Math.max(0, now - sentAt);
  if (elapsedMs >= EVENT_INTEGRATION_WINDOW_MS) return 0;

  return Math.ceil((EVENT_INTEGRATION_WINDOW_MS - elapsedMs) / 1_000);
}

function normalizeDetailLabel(value: string, unknownLabel: string): string {
  const normalized = value.trim();
  return normalized || unknownLabel;
}

function resolveRealtimeRegionLabel(
  rawValue: string,
  messages: AppMessages,
): string {
  const parsed = parseGeoLocationValue(rawValue);
  if (!parsed?.regionName && !parsed?.regionCode) {
    return normalizeDetailLabel(rawValue.trim(), messages.common.unknown);
  }
  return normalizeDetailLabel(
    parsed.regionName || parsed.regionCode || "",
    messages.common.unknown,
  );
}

function resolveRealtimeCityLabel(
  rawValue: string,
  messages: AppMessages,
): string {
  const parsed = parseGeoLocationValue(rawValue);
  if (!parsed?.localityName) {
    return normalizeDetailLabel(rawValue.trim(), messages.common.unknown);
  }
  return normalizeDetailLabel(parsed.localityName, messages.common.unknown);
}

function resolveRealtimeEventDisplayData(
  locale: Locale,
  messages: AppMessages,
  event: RealtimeEvent,
): RealtimeEventDisplayData {
  const kind = classifyRealtimeLogEvent(event);
  const { label: countryLabel, code: countryCode } = resolveCountryLabel(
    event.country,
    locale,
    messages.common.unknown,
  );

  return {
    kind,
    title: formatLogTitle(messages, event, kind),
    avatarSeed: event.visitorId.trim() || event.sessionId.trim() || event.id,
    browserLabel: event.browser.trim() || messages.common.unknown,
    browserIconKey: resolveBrowserIconKey(event.browser),
    osLabel: event.os?.trim() || messages.common.unknown,
    osIconKey: resolveOsIconKey(event.os ?? ""),
    countryLabel,
    countryFlagCode: resolveCountryFlagCode(countryCode, locale),
    sourceLabel: event.referrerHost.trim() || messages.overview.direct,
  };
}

interface RealtimeLogStreamItemProps {
  event: RealtimeEvent;
  locale: Locale;
  messages: AppMessages;
  timeZone: string;
}

function areRealtimeLogStreamItemPropsEqual(
  previousProps: RealtimeLogStreamItemProps,
  nextProps: RealtimeLogStreamItemProps,
) {
  return (
    previousProps.locale === nextProps.locale &&
    previousProps.messages === nextProps.messages &&
    previousProps.timeZone === nextProps.timeZone &&
    previousProps.event.id === nextProps.event.id &&
    previousProps.event.eventType === nextProps.event.eventType &&
    previousProps.event.eventKind === nextProps.event.eventKind &&
    previousProps.event.eventAt === nextProps.event.eventAt &&
    previousProps.event.visibilityState === nextProps.event.visibilityState &&
    previousProps.event.pathname === nextProps.event.pathname &&
    previousProps.event.hash === nextProps.event.hash &&
    previousProps.event.visitorId === nextProps.event.visitorId &&
    previousProps.event.sessionId === nextProps.event.sessionId &&
    previousProps.event.browser === nextProps.event.browser &&
    previousProps.event.os === nextProps.event.os &&
    previousProps.event.osVersion === nextProps.event.osVersion &&
    previousProps.event.country === nextProps.event.country &&
    previousProps.event.referrerHost === nextProps.event.referrerHost
  );
}

function RealtimeEventDetailValue({
  icon,
  value,
  mono = false,
}: {
  icon?: ReactNode;
  value: string;
  mono?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-2 break-words text-[11px] text-foreground",
        mono && "font-mono",
      )}
    >
      {icon ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 break-all">{value}</span>
    </span>
  );
}

function RealtimeDetailItem({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn("space-y-1", wide && "sm:col-span-2")}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{value}</dd>
    </div>
  );
}

const RealtimeLogStreamItemCard = memo(function RealtimeLogStreamItemCard({
  event,
  locale,
  messages,
  timeZone,
}: RealtimeLogStreamItemProps) {
  const displayData = useMemo(
    () => resolveRealtimeEventDisplayData(locale, messages, event),
    [event, locale, messages],
  );
  const {
    avatarSeed,
    browserLabel,
    browserIconKey,
    countryFlagCode,
    countryLabel,
    osIconKey,
    osLabel,
    sourceLabel,
    title,
  } = displayData;
  const eventDateTime = useMemo(
    () => shortDateTime(locale, event.eventAt, timeZone),
    [event.eventAt, locale, timeZone],
  );

  return (
    <Card size="sm" className="w-full">
      <CardContent className="px-3">
        <div className="flex items-start gap-3">
          <div className="shrink-0 self-center">
            <Avatar
              size={34}
              name={avatarSeed}
              variant="ring"
              colors={VISITOR_AVATAR_COLORS}
              aria-hidden="true"
            />
          </div>
          <div className="flex min-w-0 flex-1 items-stretch justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <p className="min-w-0 truncate text-sm font-medium text-foreground">
                {title}
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <MetaItem
                  icon={
                    <LogoIcon
                      src={`${BROWSER_ICON_DIR}/${browserIconKey}.svg`}
                      fallbackSrc={`${BROWSER_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
                      invertInDark={BROWSER_APPLE_ICON_KEYS.has(browserIconKey)}
                    />
                  }
                  label={browserLabel}
                  hideLabelOnMobile
                />
                <MetaItem
                  icon={
                    <LogoIcon
                      src={`${OS_ICON_DIR}/${osIconKey}.svg`}
                      fallbackSrc={`${OS_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
                      invertInDark={OS_APPLE_ICON_KEYS.has(osIconKey)}
                    />
                  }
                  label={osLabel}
                  hideLabelOnMobile
                />
                <MetaItem
                  icon={
                    countryFlagCode ? (
                      <Icon
                        icon={`flagpack:${countryFlagCode.toLowerCase()}`}
                        style={{ width: 16, height: 12 }}
                        className="block shrink-0"
                      />
                    ) : (
                      <RiGlobalLine className="size-3.5 text-muted-foreground" />
                    )
                  }
                  label={countryLabel}
                  hideLabelOnMobile
                />
                <MetaItem
                  icon={
                    <DomainOrUrlIcon
                      label={sourceLabel}
                      unknownLabel={messages.overview.direct}
                    />
                  }
                  label={sourceLabel}
                />
              </div>
            </div>
            <div className="shrink-0 self-stretch">
              <div className="flex h-full min-w-[7.5rem] flex-col items-end justify-between text-right">
                <p className="font-mono text-[11px] text-foreground">
                  <RealtimeRelativeTime
                    locale={locale}
                    timestamp={event.eventAt}
                  />
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {eventDateTime}
                </p>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}, areRealtimeLogStreamItemPropsEqual);

interface RealtimeLogStreamItemMotionProps extends RealtimeLogStreamItemProps {
  onSelect: (event: RealtimeEvent) => void;
  reduceMotion: boolean;
}

function areRealtimeLogStreamItemMotionPropsEqual(
  previousProps: RealtimeLogStreamItemMotionProps,
  nextProps: RealtimeLogStreamItemMotionProps,
): boolean {
  return (
    areRealtimeLogStreamItemPropsEqual(previousProps, nextProps) &&
    previousProps.onSelect === nextProps.onSelect &&
    previousProps.reduceMotion === nextProps.reduceMotion
  );
}

const RealtimeLogStreamItem = memo(function RealtimeLogStreamItem({
  event,
  locale,
  messages,
  timeZone,
  onSelect,
  reduceMotion,
}: RealtimeLogStreamItemMotionProps) {
  const title = formatLogTitle(
    messages,
    event,
    classifyRealtimeLogEvent(event),
  );

  return (
    <motion.li
      layout={reduceMotion ? false : "position"}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
      transition={LOG_STREAM_ITEM_LAYOUT_TRANSITION}
      className="list-none"
    >
      <Clickable
        className="block w-full rounded-none text-left focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          onSelect(event);
        }}
        enableHoverScale={false}
        tapScale={0.985}
        duration={0.14}
        aria-label={title}
        title={title}
      >
        <RealtimeLogStreamItemCard
          event={event}
          locale={locale}
          messages={messages}
          timeZone={timeZone}
        />
      </Clickable>
    </motion.li>
  );
}, areRealtimeLogStreamItemMotionPropsEqual);

function RealtimeVisitorHistorySection({
  locale,
  messages,
  now,
  timeZone,
  event,
  events,
  onSelect,
}: {
  locale: Locale;
  messages: AppMessages;
  now: number;
  timeZone: string;
  event: RealtimeEvent;
  events: RealtimeEvent[];
  onSelect: (event: RealtimeEvent) => void;
}) {
  const timelineEvents = useMemo(() => {
    const visitorId = event.visitorId.trim();
    if (!visitorId) return [];

    const dedupedEvents = new Map<string, RealtimeEvent>();
    for (const candidate of events) {
      if (candidate.visitorId.trim() !== visitorId || !candidate.id) {
        continue;
      }
      dedupedEvents.set(candidate.id, candidate);
    }

    return Array.from(dedupedEvents.values()).sort(
      (left, right) => left.eventAt - right.eventAt,
    );
  }, [event.visitorId, events]);
  const firstTimelineEvent = timelineEvents[0] ?? null;
  const lastTimelineEvent = timelineEvents[timelineEvents.length - 1] ?? null;
  const historyStateKey = timelineEvents.length === 0 ? "empty" : "history";

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">
            {messages.realtime.visitorHistorySection}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            {messages.realtime.visitorHistorySubtitle}
          </p>
        </div>
        {firstTimelineEvent && lastTimelineEvent ? (
          <div className="min-w-0 text-right text-[10px] text-muted-foreground">
            <p>{messages.realtime.visitorHistoryRange}</p>
            <p className="font-mono text-foreground">
              {shortDateTime(locale, firstTimelineEvent.eventAt, timeZone)}
              {" – "}
              {shortDateTime(locale, lastTimelineEvent.eventAt, timeZone)}
            </p>
          </div>
        ) : null}
      </div>
      <AutoResizer initial duration={0.22}>
        <AutoTransition
          initial={false}
          duration={0.2}
          transitionKey={historyStateKey}
        >
          {timelineEvents.length === 0 ? (
            <div className="flex min-h-24 items-center justify-center border border-dashed border-foreground/25 text-[11px] text-muted-foreground">
              {messages.realtime.visitorHistoryEmpty}
            </div>
          ) : (
            <div className="space-y-0">
              {timelineEvents.map((timelineEvent, index) => {
                const isCurrentEvent = timelineEvent.id === event.id;
                const timelineEventTitle = formatLogTitle(
                  messages,
                  timelineEvent,
                  classifyRealtimeLogEvent(timelineEvent),
                );
                const timelineEventRowClassName =
                  "!grid !w-full grid-cols-[4.5rem_1.25rem_minmax(0,1fr)] items-stretch gap-3 pb-4 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring last:pb-0 sm:grid-cols-[5.5rem_1.25rem_minmax(0,1fr)]";
                const timelineEventContent = (
                  <>
                    <div className="min-w-0 pt-0.5 text-right">
                      <p className="font-mono text-[10px] text-foreground">
                        {formatTimelineTime(
                          locale,
                          timelineEvent.eventAt,
                          timeZone,
                        )}
                      </p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {formatRelativeTime(locale, timelineEvent.eventAt, now)}
                      </p>
                    </div>
                    <div className="relative flex h-full justify-center">
                      {index < timelineEvents.length - 1 ? (
                        <span className="pointer-events-none absolute left-1/2 top-5 -bottom-4 w-px -translate-x-1/2 bg-foreground/30" />
                      ) : null}
                      <span
                        className={cn(
                          "relative z-10 inline-flex size-5 shrink-0 items-center justify-center border font-mono text-[10px]",
                          isCurrentEvent
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-foreground/35 bg-card text-foreground/80",
                        )}
                      >
                        {index + 1}
                      </span>
                    </div>
                    <div className="min-w-0 w-full border-b border-foreground/15 pb-3 last:border-b-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {timelineEventTitle}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {formatDetailDuration(
                          timelineEvent.durationMs,
                          messages.common.unknown,
                        )}
                        {" · "}
                        {timelineEvent.title.trim() || messages.common.unknown}
                      </p>
                    </div>
                  </>
                );

                if (isCurrentEvent) {
                  return (
                    <div
                      key={timelineEvent.id}
                      className={timelineEventRowClassName}
                    >
                      {timelineEventContent}
                    </div>
                  );
                }

                return (
                  <Clickable
                    key={timelineEvent.id}
                    className={timelineEventRowClassName}
                    onClick={() => onSelect(timelineEvent)}
                    enableHoverScale
                    hoverScale={1.01}
                    tapScale={0.985}
                    duration={0.14}
                    aria-label={timelineEventTitle}
                    title={timelineEventTitle}
                  >
                    {timelineEventContent}
                  </Clickable>
                );
              })}
            </div>
          )}
        </AutoTransition>
      </AutoResizer>
    </section>
  );
}

function RealtimeVisitorLocationMapSection({
  locale,
  messages,
  event,
}: {
  locale: Locale;
  messages: AppMessages;
  event: RealtimeEvent;
}) {
  const hasLocation = hasValidCoordinate(event.latitude, event.longitude);
  const points = useMemo<GeoPointsMapPoint[]>(
    () =>
      hasLocation
        ? [
            {
              latitude: Number(event.latitude),
              longitude: Number(event.longitude),
              country: String(event.country ?? ""),
            },
          ]
        : [],
    [event.country, event.latitude, event.longitude, hasLocation],
  );
  return (
    <GeoPointsMapIsland
      locale={locale}
      messages={messages}
      points={points}
      emptyLabel={messages.realtime.visitorMapUnavailable}
      heightClassName="h-[11rem] sm:h-[13rem]"
      initialZoom={0.3}
      countryHoverEnabled={false}
    />
  );
}

function RealtimeLogEventDetailsDrawer({
  locale,
  messages,
  timeZone,
  event,
  open,
  onOpenChange,
  events,
  onSelect,
  onOpenVisitor,
  onOpenSession,
}: {
  locale: Locale;
  messages: AppMessages;
  timeZone: string;
  event: RealtimeEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: RealtimeEvent[];
  onSelect: (event: RealtimeEvent) => void;
  onOpenVisitor?: (visitorId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const now = useRealtimeClock(open && Boolean(event));
  const displayData = event
    ? resolveRealtimeEventDisplayData(locale, messages, event)
    : null;
  const regionLabel = event
    ? resolveRealtimeRegionLabel(event.region, messages)
    : "";
  const cityLabel = event ? resolveRealtimeCityLabel(event.city, messages) : "";
  const translationBundle = useGeoStateTranslationBundle({
    locale,
    countryCode: event?.country ?? "",
    stateCode: event?.regionCode ?? "",
    countryLabel: displayData?.countryLabel ?? "",
    regionLabel,
    localityLabel: cityLabel,
    enabled: open && Boolean(event),
  });

  if (!event || !displayData) return null;

  const integrationRemainingSeconds =
    getRealtimeEventIntegrationRemainingSeconds(event, now);
  const isIntegratingEvent = integrationRemainingSeconds > 0;
  const integratingEventLabel = formatI18nTemplate(
    messages.events.integratingEvent,
    { seconds: integrationRemainingSeconds },
  );

  const {
    browserIconKey,
    browserLabel,
    countryFlagCode,
    countryLabel,
    osIconKey,
    osLabel,
    sourceLabel,
  } = displayData;
  const continentLabel = resolveContinentLabel(
    event.continent,
    messages.common.unknown,
    messages.common.continentLabels,
  );
  const localizedRegionLabel =
    translationBundle?.stateName.trim() || regionLabel;
  const localizedCityLabel =
    resolveLocalizedCityName(translationBundle, cityLabel) || cityLabel;
  const languageLabel = resolveLanguageLabel(
    event.language,
    locale,
    messages.common.unknown,
  ).label;
  const deviceTypeMeta = resolveDeviceTypeMeta(
    event.deviceType,
    messages.common.deviceLabels,
    messages.common.unknown,
  );
  const DeviceTypeIcon = deviceTypeMeta.Icon;
  const unknownLabel = messages.common.unknown;
  const localizedStatus = resolveLocalizedDetailValue(
    event.status,
    messages.realtime.statusLabels,
    unknownLabel,
  );
  const localizedVisibilityState = resolveLocalizedDetailValue(
    event.visibilityState,
    messages.realtime.visibilityStateLabels,
    unknownLabel,
  );
  const eventNameLabel =
    event.eventName?.trim() ||
    (event.eventKind === "custom_event"
      ? unknownLabel
      : messages.campaigns.notSet);
  const visibilityStateLabel = event.visibilityState?.trim()
    ? localizedVisibilityState
    : messages.campaigns.notSet;
  const previousVisitStartedLabel = event.previousVisitId?.trim()
    ? formatOptionalDetailDateTime(
        locale,
        event.previousVisitStartedAt,
        timeZone,
        unknownLabel,
      )
    : messages.campaigns.notSet;
  const detailRows = [
    {
      section: "event",
      priority: 1,
      label: messages.common.id,
      value: (
        <RealtimeEventDetailValue
          value={event.id.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "event",
      priority: 2,
      label: messages.realtime.eventName,
      value: <RealtimeEventDetailValue value={eventNameLabel} />,
    },
    {
      section: "event",
      priority: 3,
      label: messages.realtime.eventTime,
      value: (
        <RealtimeEventDetailValue
          value={formatDetailDateTime(locale, event.eventAt, timeZone)}
          mono
        />
      ),
    },
    {
      section: "event",
      priority: 4,
      label: messages.realtime.receivedAt,
      value: (
        <RealtimeEventDetailValue
          value={formatOptionalDetailDateTime(
            locale,
            event.receivedAt,
            timeZone,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      section: "event",
      priority: 5,
      label: messages.realtime.eventKind,
      value: (
        <RealtimeEventDetailValue
          value={event.eventKind?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "event",
      priority: 6,
      label: messages.realtime.traceId,
      value: (
        <RealtimeEventDetailValue
          value={event.traceId?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 1,
      wide: true,
      label: messages.realtime.visitorId,
      value: (
        <RealtimeEventDetailValue
          value={event.visitorId.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "session",
      priority: 1,
      wide: true,
      label: messages.realtime.sessionId,
      value: (
        <RealtimeEventDetailValue
          value={event.sessionId.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "session",
      priority: 2,
      wide: true,
      label: messages.realtime.visitId,
      value: (
        <RealtimeEventDetailValue
          value={event.visitId.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "session",
      priority: 5,
      label: messages.realtime.startedAt,
      value: (
        <RealtimeEventDetailValue
          value={formatOptionalDetailDateTime(
            locale,
            event.startedAt,
            timeZone,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      section: "session",
      priority: 6,
      label: messages.realtime.previousVisitStartedAt,
      value: (
        <RealtimeEventDetailValue value={previousVisitStartedLabel} mono />
      ),
    },
    {
      section: "visitor",
      priority: 3,
      label: messages.realtime.userId,
      value: (
        <RealtimeEventDetailValue
          value={event.userId?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 2,
      label: messages.realtime.userName,
      value: (
        <RealtimeEventDetailValue
          value={event.userName?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "visitor",
      priority: 10,
      label: messages.realtime.isEU,
      value: (
        <RealtimeEventDetailValue
          value={formatDetailBoolean(
            event.isEU,
            unknownLabel,
            messages.sessionDetail.yes,
            messages.sessionDetail.no,
          )}
        />
      ),
    },
    {
      section: "browsing",
      priority: 1,
      label: messages.common.title,
      value: (
        <RealtimeEventDetailValue
          value={event.title.trim() || messages.common.unknown}
        />
      ),
    },
    {
      section: "browsing",
      priority: 2,
      label: messages.common.hostname,
      value: (
        <RealtimeEventDetailValue
          value={event.hostname.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "browsing",
      priority: 3,
      wide: true,
      label: messages.common.path,
      value: (
        <RealtimeEventDetailValue
          value={formatPathWithHash(event.pathname, event.hash)}
          mono
        />
      ),
    },
    {
      section: "browsing",
      priority: 4,
      wide: true,
      label: messages.realtime.queryString,
      value: (
        <RealtimeEventDetailValue
          value={event.queryString?.trim() || messages.pages.noQuery}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 4,
      label: messages.common.browser,
      value: (
        <RealtimeEventDetailValue
          icon={
            <LogoIcon
              src={`${BROWSER_ICON_DIR}/${browserIconKey}.svg`}
              fallbackSrc={`${BROWSER_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
              invertInDark={BROWSER_APPLE_ICON_KEYS.has(browserIconKey)}
            />
          }
          value={browserLabel}
        />
      ),
    },
    {
      section: "visitor",
      priority: 5,
      label: messages.realtime.browserVersion,
      value: (
        <RealtimeEventDetailValue
          value={event.browserVersion?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 6,
      label: messages.common.operatingSystem,
      value: (
        <RealtimeEventDetailValue
          icon={
            <LogoIcon
              src={`${OS_ICON_DIR}/${osIconKey}.svg`}
              fallbackSrc={`${OS_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
              invertInDark={OS_APPLE_ICON_KEYS.has(osIconKey)}
            />
          }
          value={osLabel}
        />
      ),
    },
    {
      section: "visitor",
      priority: 7,
      label: messages.realtime.osVersion,
      value: (
        <RealtimeEventDetailValue
          value={event.osVersion.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 8,
      label: messages.common.deviceType,
      value: (
        <RealtimeEventDetailValue
          icon={<DeviceTypeIcon className="size-3.5 text-muted-foreground" />}
          value={deviceTypeMeta.label}
        />
      ),
    },
    {
      section: "visitor",
      priority: 9,
      wide: true,
      label: messages.realtime.userAgent,
      value: (
        <RealtimeEventDetailValue
          value={event.uaRaw?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 1,
      label: messages.common.country,
      value: (
        <RealtimeEventDetailValue
          icon={
            countryFlagCode ? (
              <Icon
                icon={`flagpack:${countryFlagCode.toLowerCase()}`}
                style={{ width: 16, height: 12 }}
                className="block shrink-0"
              />
            ) : (
              <RiGlobalLine className="size-3.5 text-muted-foreground" />
            )
          }
          value={
            event.country.trim() && event.country.trim() !== countryLabel
              ? `${countryLabel} (${event.country.trim()})`
              : countryLabel
          }
        />
      ),
    },
    {
      section: "geography",
      priority: 2,
      label: messages.common.region,
      value: (
        <RealtimeEventDetailValue
          value={formatLocalizedGeoValue(
            localizedRegionLabel,
            regionLabel,
            messages.common.unknown,
          )}
        />
      ),
    },
    {
      section: "geography",
      priority: 3,
      label: messages.common.regionCode,
      value: (
        <RealtimeEventDetailValue
          value={event.regionCode.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 7,
      label: messages.realtime.postalCode,
      value: (
        <RealtimeEventDetailValue
          value={event.postalCode?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 8,
      label: messages.realtime.metroCode,
      value: (
        <RealtimeEventDetailValue
          value={event.metroCode?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 4,
      label: messages.common.city,
      value: (
        <RealtimeEventDetailValue
          value={formatLocalizedGeoValue(
            localizedCityLabel,
            cityLabel,
            messages.common.unknown,
          )}
        />
      ),
    },
    {
      section: "geography",
      priority: 5,
      label: messages.common.continent,
      value: (
        <RealtimeEventDetailValue
          value={
            event.continent.trim() && event.continent.trim() !== continentLabel
              ? `${continentLabel} (${event.continent.trim()})`
              : continentLabel
          }
        />
      ),
    },
    {
      section: "geography",
      priority: 6,
      label: messages.common.timezone,
      value: (
        <RealtimeEventDetailValue
          value={event.timezone.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "source",
      priority: 1,
      label: messages.common.referrerHost,
      value: (
        <RealtimeEventDetailValue
          value={event.referrerHost.trim() || messages.overview.direct}
          mono
        />
      ),
    },
    {
      section: "source",
      priority: 2,
      label: messages.common.referrer,
      value: (
        <RealtimeEventDetailValue
          icon={
            <DomainOrUrlIcon
              label={sourceLabel}
              unknownLabel={messages.overview.direct}
            />
          }
          value={event.referrerUrl.trim() || sourceLabel}
          mono
        />
      ),
    },
    {
      section: "source",
      priority: 3,
      label: messages.realtime.utmSource,
      value: (
        <RealtimeEventDetailValue
          value={event.utmSource?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "source",
      priority: 4,
      label: messages.realtime.utmMedium,
      value: (
        <RealtimeEventDetailValue
          value={event.utmMedium?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "source",
      priority: 5,
      label: messages.realtime.utmCampaign,
      value: (
        <RealtimeEventDetailValue
          value={event.utmCampaign?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "source",
      priority: 6,
      label: messages.realtime.utmTerm,
      value: (
        <RealtimeEventDetailValue
          value={event.utmTerm?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "source",
      priority: 7,
      label: messages.realtime.utmContent,
      value: (
        <RealtimeEventDetailValue
          value={event.utmContent?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "visitor",
      priority: 11,
      label: messages.common.screenSize,
      value: (
        <RealtimeEventDetailValue
          value={event.screenSize.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 12,
      label: messages.common.language,
      value: <RealtimeEventDetailValue value={languageLabel} mono />,
    },
    {
      section: "visitor",
      priority: 13,
      wide: true,
      label: messages.common.organization,
      value: (
        <RealtimeEventDetailValue
          value={event.organization.trim() || messages.common.unknown}
        />
      ),
    },
    {
      section: "session",
      priority: 4,
      label: messages.realtime.status,
      value: <RealtimeEventDetailValue value={localizedStatus} />,
    },
    {
      section: "session",
      priority: 3,
      label: messages.realtime.visibilityState,
      value: <RealtimeEventDetailValue value={visibilityStateLabel} />,
    },
    {
      section: "session",
      priority: 7,
      label: messages.realtime.duration,
      value: (
        <RealtimeEventDetailValue
          value={formatDetailDuration(event.durationMs, unknownLabel)}
          mono
        />
      ),
    },
    {
      section: "session",
      priority: 8,
      label: messages.realtime.durationSource,
      value: (
        <RealtimeEventDetailValue
          value={event.durationSource?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "session",
      priority: 10,
      label: messages.realtime.exitReason,
      value: (
        <RealtimeEventDetailValue
          value={event.exitReason?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "session",
      priority: 9,
      label: messages.realtime.leaveAt,
      value: (
        <RealtimeEventDetailValue
          value={formatOptionalDetailDateTime(
            locale,
            event.leaveAt,
            timeZone,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 9,
      label: messages.common.latitude,
      value: (
        <RealtimeEventDetailValue
          value={formatCoordinateValue(event.latitude)}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 10,
      label: messages.common.longitude,
      value: (
        <RealtimeEventDetailValue
          value={formatCoordinateValue(event.longitude)}
          mono
        />
      ),
    },
  ];
  const performanceDetailRows = [
    {
      label: messages.performance.ttfb,
      value: (
        <RealtimeEventDetailValue
          value={formatRealtimePerformanceMetric(
            event.performance,
            "ttfb",
            messages,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      label: messages.performance.fcp,
      value: (
        <RealtimeEventDetailValue
          value={formatRealtimePerformanceMetric(
            event.performance,
            "fcp",
            messages,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      label: messages.performance.lcp,
      value: (
        <RealtimeEventDetailValue
          value={formatRealtimePerformanceMetric(
            event.performance,
            "lcp",
            messages,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      label: messages.performance.cls,
      value: (
        <RealtimeEventDetailValue
          value={formatRealtimePerformanceMetric(
            event.performance,
            "cls",
            messages,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      label: messages.performance.inp,
      value: (
        <RealtimeEventDetailValue
          value={formatRealtimePerformanceMetric(
            event.performance,
            "inp",
            messages,
            unknownLabel,
          )}
          mono
        />
      ),
    },
  ];
  const sortDetailRows = (rows: typeof detailRows) =>
    rows.sort((left, right) => {
      const leftPriority = "priority" in left ? left.priority : 0;
      const rightPriority = "priority" in right ? right.priority : 0;
      return leftPriority - rightPriority;
    });
  const eventDetailRows = sortDetailRows(
    detailRows.filter((row) => "section" in row && row.section === "event"),
  );
  const browsingDetailRows = sortDetailRows(
    detailRows.filter((row) => "section" in row && row.section === "browsing"),
  );
  const visitorDetailRows = sortDetailRows(
    detailRows
      .filter((row) => "section" in row && row.section === "visitor")
      .filter(
        (row) =>
          row.label !== messages.realtime.userId ||
          Boolean(event.userId?.trim()),
      ),
  );
  const sessionDetailRows = sortDetailRows(
    detailRows.filter((row) => "section" in row && row.section === "session"),
  );
  const geographyDetailRows = sortDetailRows(
    detailRows.filter((row) => "section" in row && row.section === "geography"),
  );
  const sourceDetailRows = sortDetailRows(
    detailRows.filter((row) => "section" in row && row.section === "source"),
  );
  return (
    <Drawer direction="right" open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="!w-full !max-w-none sm:!w-[min(58vw,34rem)]">
        <DrawerHeader className="border-b">
          <div className="flex min-w-0 items-center gap-2">
            <RiPulseLine className="size-4 shrink-0 text-muted-foreground" />
            <DrawerTitle>{messages.realtime.detailsTitle}</DrawerTitle>
          </div>
          <DrawerDescription>{displayData.title}</DrawerDescription>
        </DrawerHeader>
        <DrawerScrollArea
          className="min-h-0"
          contentClassName="space-y-4 p-4 sm:p-5"
          syncKey={event.id}
        >
          <div className="space-y-5">
            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.realtime.detailsTitle}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {eventDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                  />
                ))}
              </dl>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">{messages.events.payload}</h3>
              <JsonTreePanel
                value={event.eventData ?? {}}
                labels={messages.events}
              />
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.realtime.browsingSection}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {browsingDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                    wide={"wide" in row ? row.wide : false}
                  />
                ))}
              </dl>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.navigation.visitors}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {visitorDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                    wide={"wide" in row ? row.wide : false}
                  />
                ))}
              </dl>
              {onOpenVisitor ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={isIntegratingEvent || !event.visitorId.trim()}
                    onClick={() => onOpenVisitor(event.visitorId)}
                  >
                    <AutoTransition
                      as="span"
                      initial={false}
                      className="inline-flex items-center gap-2"
                      duration={0.16}
                      transitionKey={
                        isIntegratingEvent ? "integrating" : "open"
                      }
                    >
                      {isIntegratingEvent ? (
                        integratingEventLabel
                      ) : (
                        <>
                          <RiExternalLinkLine data-icon="inline-start" />
                          {messages.events.openVisitor}
                        </>
                      )}
                    </AutoTransition>
                  </Button>
                </div>
              ) : null}
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.navigation.sessions}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {sessionDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                    wide={"wide" in row ? row.wide : false}
                  />
                ))}
              </dl>
              {onOpenSession ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={isIntegratingEvent || !event.sessionId.trim()}
                    onClick={() => onOpenSession(event.sessionId)}
                  >
                    <AutoTransition
                      as="span"
                      initial={false}
                      className="inline-flex items-center gap-2"
                      duration={0.16}
                      transitionKey={
                        isIntegratingEvent ? "integrating" : "open"
                      }
                    >
                      {isIntegratingEvent ? (
                        integratingEventLabel
                      ) : (
                        <>
                          <RiExternalLinkLine data-icon="inline-start" />
                          {messages.events.openSession}
                        </>
                      )}
                    </AutoTransition>
                  </Button>
                </div>
              ) : null}
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.realtime.geographySection}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {geographyDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                  />
                ))}
              </dl>
            </section>

            <RealtimeVisitorLocationMapSection
              locale={locale}
              messages={messages}
              event={event}
            />

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.realtime.sourceSection}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {sourceDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                  />
                ))}
              </dl>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.sessionDetail.performanceTitle}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {performanceDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                  />
                ))}
              </dl>
            </section>

            <Separator />

            <RealtimeVisitorHistorySection
              locale={locale}
              messages={messages}
              now={now}
              event={event}
              events={events}
              onSelect={onSelect}
              timeZone={timeZone}
            />
          </div>
        </DrawerScrollArea>
      </DrawerContent>
    </Drawer>
  );
}

export function RealtimeLogStreamCard({
  locale,
  messages,
  hasConnected,
  events,
  siteId,
  pathname,
}: RealtimeLogStreamCardProps) {
  const { timeZone } = useDashboardQueryControls();
  const reduceLogItemMotion = useReducedMotion() ?? false;
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_EVENTS);
  const [selectedEvent, setSelectedEvent] = useState<RealtimeEvent | null>(
    null,
  );
  const [isEventDetailsOpen, setIsEventDetailsOpen] = useState(false);
  const [nestedEventDetails, setNestedEventDetails] = useState<
    RealtimeNestedEventDetail[]
  >([]);
  const [nestedJourneyDetails, setNestedJourneyDetails] = useState<
    RealtimeNestedJourneyDetail[]
  >([]);
  const nestedEventDetailKeyRef = useRef(0);
  const nestedJourneyDetailKeyRef = useRef(0);
  const nestedEventDetailCloseTimersRef = useRef(new Map<string, number>());
  const nestedEventDetailsClearTimerRef = useRef<number | null>(null);
  const nestedJourneyDetailsClearTimerRef = useRef<number | null>(null);
  const selectedEventClearTimerRef = useRef<number | null>(null);

  const visibleEvents = useMemo(
    () => events.slice(0, visibleCount),
    [events, visibleCount],
  );
  const hasMoreEvents = visibleCount < events.length;
  const isInitialLoading = !hasConnected && visibleEvents.length === 0;
  const logStateKey = isInitialLoading
    ? "loading"
    : visibleEvents.length === 0
      ? "empty"
      : "events";

  useEffect(() => {
    setVisibleCount((previous) => {
      if (events.length <= 0) return INITIAL_VISIBLE_EVENTS;
      return Math.min(
        events.length,
        Math.max(previous, INITIAL_VISIBLE_EVENTS),
      );
    });
  }, [events.length]);

  const loadMoreEvents = useCallback(() => {
    if (!hasMoreEvents) return;
    setVisibleCount((previous) =>
      Math.min(events.length, previous + LOAD_MORE_STEP),
    );
  }, [events.length, hasMoreEvents]);
  const clearSelectedEventTimer = useCallback(() => {
    if (selectedEventClearTimerRef.current === null) return;
    window.clearTimeout(selectedEventClearTimerRef.current);
    selectedEventClearTimerRef.current = null;
  }, []);
  const handleEventSelect = useCallback(
    (event: RealtimeEvent) => {
      clearSelectedEventTimer();
      setSelectedEvent(event);
      setIsEventDetailsOpen(true);
    },
    [clearSelectedEventTimer],
  );
  const openNestedEventDetail = useCallback((event: RealtimeEvent) => {
    nestedEventDetailKeyRef.current += 1;
    setNestedEventDetails((current) => [
      ...current,
      {
        event,
        open: true,
        stackKey: `event:${event.id}:${nestedEventDetailKeyRef.current}`,
      },
    ]);
  }, []);
  const closeNestedEventDetail = useCallback((stackKey: string) => {
    setNestedEventDetails((current) => {
      const index = current.findIndex((item) => item.stackKey === stackKey);
      if (index < 0) return current;

      return current.map((item, itemIndex) =>
        itemIndex >= index ? { ...item, open: false } : item,
      );
    });

    if (nestedEventDetailCloseTimersRef.current.has(stackKey)) return;
    const timerId = window.setTimeout(() => {
      nestedEventDetailCloseTimersRef.current.delete(stackKey);
      setNestedEventDetails((current) => {
        const index = current.findIndex((item) => item.stackKey === stackKey);
        return index < 0 ? current : current.slice(0, index);
      });
    }, NESTED_DRAWER_EXIT_DURATION_MS);
    nestedEventDetailCloseTimersRef.current.set(stackKey, timerId);
  }, []);
  const openNestedJourneyDetail = useCallback(
    (kind: RealtimeNestedJourneyDetail["kind"], id: string) => {
      const normalizedId = id.trim();
      if (!normalizedId) return;

      setNestedJourneyDetails((current) => {
        const topDetail = current.at(-1);
        if (topDetail?.kind === kind && topDetail.id === normalizedId) {
          return current;
        }

        nestedJourneyDetailKeyRef.current += 1;
        return [
          ...current,
          {
            kind,
            id: normalizedId,
            open: true,
            stackKey: `${kind}:${normalizedId}:${nestedJourneyDetailKeyRef.current}`,
          },
        ];
      });
    },
    [],
  );
  const closeNestedJourneyDetail = useCallback((stackKey: string) => {
    setNestedJourneyDetails((current) => {
      const index = current.findIndex((item) => item.stackKey === stackKey);
      return index < 0 ? current : current.slice(0, index);
    });
  }, []);
  const handleEventDetailsOpenChange = useCallback(
    (open: boolean) => {
      clearSelectedEventTimer();
      setIsEventDetailsOpen(open);
      if (!open) {
        selectedEventClearTimerRef.current = window.setTimeout(() => {
          selectedEventClearTimerRef.current = null;
          setSelectedEvent(null);
        }, NESTED_DRAWER_EXIT_DURATION_MS);
        setNestedEventDetails((current) =>
          current.map((item) => ({ ...item, open: false })),
        );
        if (nestedEventDetailsClearTimerRef.current !== null) {
          window.clearTimeout(nestedEventDetailsClearTimerRef.current);
        }
        nestedEventDetailsClearTimerRef.current = window.setTimeout(() => {
          nestedEventDetailsClearTimerRef.current = null;
          setNestedEventDetails([]);
        }, NESTED_DRAWER_EXIT_DURATION_MS);
        setNestedJourneyDetails((current) =>
          current.map((item) => ({ ...item, open: false })),
        );
        if (nestedJourneyDetailsClearTimerRef.current !== null) {
          window.clearTimeout(nestedJourneyDetailsClearTimerRef.current);
        }
        nestedJourneyDetailsClearTimerRef.current = window.setTimeout(() => {
          nestedJourneyDetailsClearTimerRef.current = null;
          setNestedJourneyDetails([]);
        }, NESTED_DRAWER_EXIT_DURATION_MS);
      }
    },
    [clearSelectedEventTimer],
  );

  useEffect(() => {
    return () => {
      clearSelectedEventTimer();
      nestedEventDetailCloseTimersRef.current.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      nestedEventDetailCloseTimersRef.current.clear();
      if (nestedEventDetailsClearTimerRef.current !== null) {
        window.clearTimeout(nestedEventDetailsClearTimerRef.current);
      }
      if (nestedJourneyDetailsClearTimerRef.current !== null) {
        window.clearTimeout(nestedJourneyDetailsClearTimerRef.current);
      }
    };
  }, [clearSelectedEventTimer]);
  const journeyDetailContext =
    siteId && pathname
      ? {
          siteId,
          visitorsPathname: pathname.replace(
            /\/realtime(?:\/detail)?$/,
            "/visitors",
          ),
          sessionsPathname: pathname.replace(
            /\/realtime(?:\/detail)?$/,
            "/sessions",
          ),
        }
      : null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiPulseLine className="size-4" />
            {messages.realtime.recentEvents}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AutoResizer initial duration={0.22}>
            <AutoTransition
              initial={false}
              duration={0.2}
              transitionKey={logStateKey}
            >
              {isInitialLoading ? (
                <div className="flex min-h-56 items-center justify-center text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Spinner className="size-3.5" />
                    {messages.common.loading}
                  </span>
                </div>
              ) : visibleEvents.length === 0 ? (
                <div className="flex min-h-56 items-center justify-center text-muted-foreground">
                  {messages.common.noData}
                </div>
              ) : (
                <LogStreamScrollbar
                  className="max-h-[30rem]"
                  maskClassName="from-card via-card/80 to-transparent"
                  syncKey={`${visibleEvents.length}:${events.length}`}
                  onReachEnd={hasMoreEvents ? loadMoreEvents : null}
                >
                  <div className="p-1">
                    <ul className="m-0 list-none space-y-2 p-0">
                      <AnimatePresence initial={false} mode="popLayout">
                        {visibleEvents.map((event) => (
                          <RealtimeLogStreamItem
                            key={event.id}
                            event={event}
                            locale={locale}
                            messages={messages}
                            timeZone={timeZone}
                            onSelect={handleEventSelect}
                            reduceMotion={reduceLogItemMotion}
                          />
                        ))}
                      </AnimatePresence>
                    </ul>
                  </div>
                </LogStreamScrollbar>
              )}
            </AutoTransition>
          </AutoResizer>
        </CardContent>
      </Card>
      <RealtimeLogEventDetailsDrawer
        event={selectedEvent}
        locale={locale}
        messages={messages}
        timeZone={timeZone}
        events={events}
        onSelect={openNestedEventDetail}
        onOpenVisitor={
          journeyDetailContext
            ? (visitorId) => openNestedJourneyDetail("visitor", visitorId)
            : undefined
        }
        onOpenSession={
          journeyDetailContext
            ? (sessionId) => openNestedJourneyDetail("session", sessionId)
            : undefined
        }
        open={isEventDetailsOpen}
        onOpenChange={handleEventDetailsOpenChange}
      />
      {nestedEventDetails.map((nestedDetail) => (
        <RealtimeLogEventDetailsDrawer
          key={nestedDetail.stackKey}
          event={nestedDetail.event}
          locale={locale}
          messages={messages}
          timeZone={timeZone}
          events={events}
          onSelect={openNestedEventDetail}
          onOpenVisitor={
            journeyDetailContext
              ? (visitorId) => openNestedJourneyDetail("visitor", visitorId)
              : undefined
          }
          onOpenSession={
            journeyDetailContext
              ? (sessionId) => openNestedJourneyDetail("session", sessionId)
              : undefined
          }
          open={nestedDetail.open}
          onOpenChange={(open) => {
            if (!open) closeNestedEventDetail(nestedDetail.stackKey);
          }}
        />
      ))}
      {journeyDetailContext
        ? nestedJourneyDetails.map((nestedDetail) => (
            <DetailDrawer
              key={nestedDetail.stackKey}
              ariaLabel={
                nestedDetail.kind === "visitor"
                  ? messages.visitors.title
                  : messages.sessionDetail.visitDetailsTitle
              }
              drawerKey={nestedDetail.stackKey}
              open={nestedDetail.open}
              onOpenChange={(nextOpen) => {
                if (!nextOpen) closeNestedJourneyDetail(nestedDetail.stackKey);
              }}
            >
              {nestedDetail.kind === "visitor" ? (
                <VisitorDetailClientPage
                  locale={locale}
                  messages={messages}
                  siteId={journeyDetailContext.siteId}
                  pathname={journeyDetailContext.visitorsPathname}
                  visitorId={nestedDetail.id}
                  onOpenSession={(sessionId) =>
                    openNestedJourneyDetail("session", sessionId)
                  }
                />
              ) : (
                <SessionDetailClientPage
                  locale={locale}
                  messages={messages}
                  siteId={journeyDetailContext.siteId}
                  pathname={journeyDetailContext.sessionsPathname}
                  sessionId={nestedDetail.id}
                  onOpenVisitor={(visitorId) =>
                    openNestedJourneyDetail("visitor", visitorId)
                  }
                />
              )}
            </DetailDrawer>
          ))
        : null}
    </>
  );
}
