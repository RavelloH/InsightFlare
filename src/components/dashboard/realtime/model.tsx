import {
  memo,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PartialOptions } from "overlayscrollbars";
import { OverlayScrollbars } from "overlayscrollbars";

import { formatPathWithHash } from "@/components/dashboard/journeys/journey-display";
import { prepareNativeScrollbarHost } from "@/components/ui/overlay-scrollbar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import { parseGeoLocationValue } from "@/lib/analytics/geo-location";
import { intlLocale } from "@/lib/dashboard/format";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type { RealtimeEvent, RealtimeVisit } from "@/lib/realtime/types";
import { cn } from "@/lib/utils";
export interface RealtimeLogStreamCardProps {
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
export const INITIAL_VISIBLE_EVENTS = 24;
export const LOAD_MORE_STEP = 24;
const LOAD_MORE_THRESHOLD_PX = 160;
export const VISITOR_AVATAR_COLORS = [
  "#0f172a",
  "#1d4ed8",
  "#0f766e",
  "#f59e0b",
  "#e11d48",
];
export const BROWSER_ICON_DIR = "/images/browser";
export const OS_ICON_DIR = "/images/os";
export const UNKNOWN_ICON_KEY = "unknown";
export const BROWSER_APPLE_ICON_KEYS = new Set(["ios", "ios-webview"]);
export const OS_APPLE_ICON_KEYS = new Set(["ios", "mac-os"]);
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
export type RealtimeNestedJourneyDetail = {
  kind: "visitor" | "session";
  id: string;
  stackKey: string;
  open: boolean;
};
export type RealtimeNestedEventDetail = {
  event: RealtimeEvent;
  stackKey: string;
  open: boolean;
};
export const NESTED_DRAWER_EXIT_DURATION_MS = 420;
export const LOG_STREAM_ITEM_LAYOUT_TRANSITION = {
  layout: {
    duration: 0.34,
    ease: [0.22, 1, 0.36, 1],
  },
  opacity: {
    duration: 0.18,
    ease: [0.22, 1, 0.36, 1],
  },
} as const;
export function hasValidCoordinate(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  const lat = Number(latitude);
  const lon = Number(longitude);
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}
export function classifyRealtimeLogEvent(
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
export function formatLogTitle(
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
export function LogoIcon({
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
export function DomainOrUrlIcon({
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
export function MetaItem({
  icon,
  label,
  hideLabelOnMobile = false,
}: {
  icon: ReactNode;
  label: string;
  hideLabelOnMobile?: boolean;
}) {
  const metaItem = (
    <span
      className="inline-flex max-w-full items-center gap-1.5 text-[11px] text-muted-foreground"
      aria-label={hideLabelOnMobile ? label : undefined}
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

  return hideLabelOnMobile ? (
    <Tooltip>
      <TooltipTrigger asChild>{metaItem}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  ) : (
    metaItem
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
export function LogStreamScrollbar({
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
export function formatRelativeTime(
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
export function useRealtimeClock(enabled = true) {
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
export const RealtimeRelativeTime = memo(function RealtimeRelativeTime({
  locale,
  timestamp,
}: {
  locale: Locale;
  timestamp: number;
}) {
  const now = useRealtimeClock();
  return formatRelativeTime(locale, timestamp, now);
});
export function formatDetailDateTime(
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
export function formatTimelineTime(
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
export function formatCoordinateValue(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return value.toFixed(4);
}
export function formatOptionalDetailDateTime(
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
export function formatDetailBoolean(
  value: boolean | null | undefined,
  unknownLabel: string,
  trueLabel: string,
  falseLabel: string,
): string {
  if (typeof value !== "boolean") return unknownLabel;
  return value ? trueLabel : falseLabel;
}
export function resolveLocalizedDetailValue(
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
export function formatRealtimePerformanceMetric(
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
export function formatDetailDuration(
  value: number | null | undefined,
  unknownLabel: string,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value} ms`
    : unknownLabel;
}
export function getRealtimeEventIntegrationRemainingSeconds(
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
export function resolveRealtimeRegionLabel(
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
export function resolveRealtimeCityLabel(
  rawValue: string,
  messages: AppMessages,
): string {
  const parsed = parseGeoLocationValue(rawValue);
  if (!parsed?.localityName) {
    return normalizeDetailLabel(rawValue.trim(), messages.common.unknown);
  }
  return normalizeDetailLabel(parsed.localityName, messages.common.unknown);
}
export function resolveRealtimeEventDisplayData(
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
export interface RealtimeLogStreamItemProps {
  event: RealtimeEvent;
  locale: Locale;
  messages: AppMessages;
  timeZone: string;
}
export function areRealtimeLogStreamItemPropsEqual(
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
export interface RealtimeLogStreamItemMotionProps extends RealtimeLogStreamItemProps {
  onSelect: (event: RealtimeEvent) => void;
  reduceMotion: boolean;
}
