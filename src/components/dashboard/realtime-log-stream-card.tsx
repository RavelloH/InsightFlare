"use client";

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "motion/react";
import { Icon } from "@iconify/react";
import Avatar from "boring-avatars";
import { RiGlobalLine } from "@remixicon/react";
import { useTheme } from "next-themes";
import { OverlayScrollbars } from "overlayscrollbars";
import type { PartialOptions } from "overlayscrollbars";
import type { StyleSpecification } from "maplibre-gl";
import MapView, { type MapRef } from "react-map-gl/maplibre";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Clickable } from "@/components/ui/clickable";
import { Spinner } from "@/components/ui/spinner";
import { intlLocale, shortDateTime } from "@/lib/dashboard/format";
import { parseGeoLocationValue } from "@/lib/dashboard/geo-location";
import {
  resolveContinentLabel,
  resolveCountryFlagCode,
  resolveCountryLabel,
  resolveLanguageLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type { RealtimeEvent, RealtimeVisit } from "@/lib/realtime/types";
import { cn } from "@/lib/utils";

interface RealtimeLogStreamCardProps {
  locale: Locale;
  messages: AppMessages;
  hasConnected: boolean;
  events: RealtimeEvent[];
  visits: RealtimeVisit[];
}

const PRESENCE_LEAVE_EVENT = "__presence_leave";
const RELATIVE_TIME_REFRESH_MS = 1_000;
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
const GEO_TRANSLATION_API_BASE_URL = "https://locale.ravelloh.com";
const GEO_TRANSLATION_API_LOCALE_BY_APP_LOCALE: Record<Locale, string | null> = {
  en: null,
  zh: "zh-CN",
};
const GEO_STATE_CODE_PATTERN = /^[A-Z0-9-]{1,16}$/;
const DETAIL_MAP_HEIGHT_CLASS = "h-56 sm:h-64";
const DETAIL_MAP_MIN_ZOOM = 1.5;
const DETAIL_MAP_MAX_ZOOM = 14;
const DETAIL_MAP_DEFAULT_ZOOM = DETAIL_MAP_MIN_ZOOM;

type EffectiveMapTheme = "light" | "dark";

type RealtimeLogEventKind = "enter" | "exit" | "view" | "custom";
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
type RealtimeVisitorVisitHistory = {
  visitId: string;
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  pathname: string;
  title: string;
  hostname: string;
  events: RealtimeEvent[];
};
type GeoTranslationCity = {
  name: string;
  nameDefault: string;
  nativeName: string;
};
type GeoStateTranslationBundle = {
  stateName: string;
  cities: GeoTranslationCity[];
};

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

const geoStateTranslationCache = new Map<
  string,
  Promise<GeoStateTranslationBundle | null>
>();

function buildDetailRasterStyle(theme: EffectiveMapTheme): StyleSpecification {
  const sourceId = `insightflare-realtime-detail-map-source-${theme}`;
  const layerId = `insightflare-realtime-detail-map-layer-${theme}`;
  const endpoint = `/api/map-tiles/{z}/{x}/{y}.png?theme=${theme}`;

  return {
    version: 8,
    name: `insightflare-realtime-detail-map-${theme}`,
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
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function classifyRealtimeLogEvent(eventType: string): RealtimeLogEventKind {
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
  locale: Locale,
  messages: AppMessages,
  event: RealtimeEvent,
  kind: RealtimeLogEventKind,
): string {
  const separator = locale === "zh" ? "：" : ":";
  const prefix = eventTitlePrefix(messages, kind);
  const pathname = event.pathname.trim() || "/";
  const content = kind === "custom"
    ? event.eventType.trim() || messages.common.unknown
    : pathname;
  return `${prefix}${separator}${content}`;
}

function resolveBrowserIconKey(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return UNKNOWN_ICON_KEY;
  if (normalized.includes("android webview") || normalized.includes("android-webview")) {
    return "android-webview";
  }
  if (normalized.includes("chromium-webview")) return "chromium-webview";
  if (normalized.includes("edge ios")) return "edge-ios";
  if (normalized.includes("edge")) return "edge-chromium";
  if (normalized.includes("chrome ios") || normalized.includes("crios")) return "crios";
  if (normalized.includes("firefox ios") || normalized.includes("fxios")) return "fxios";
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
  if (normalized.includes("qqbrowser") || normalized.includes("qq browser") || normalized === "qq") {
    return "qq";
  }
  if (normalized.includes("ucbrowser") || normalized.includes("uc browser")) return "uc";
  if (normalized.includes("brave")) return "brave";
  if (normalized.includes("miui")) return "miui";
  if (normalized.includes("firefox")) return "firefox";
  if (normalized.includes("safari")) return "safari";
  if (normalized.includes("chrome") || normalized.includes("chromium")) return "chrome";
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
    normalized.startsWith("mac")
    || normalized.startsWith("os x")
    || normalized.startsWith("darwin")
  ) {
    return "mac-os";
  }
  if (normalized.startsWith("ios")) return "ios";
  if (normalized.startsWith("android")) return "android-os";
  if (normalized.startsWith("chrome os") || normalized.startsWith("chromium os")) {
    return "chrome-os";
  }
  if (
    normalized.includes("linux")
    || normalized.startsWith("ubuntu")
    || normalized.startsWith("debian")
    || normalized.startsWith("fedora")
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
      <span className={cn(hideLabelOnMobile ? "hidden sm:inline sm:truncate" : "truncate")}>
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
  const scrollElement = instance.elements().scrollOffsetElement;
  const remaining =
    scrollElement.scrollHeight
    - scrollElement.clientHeight
    - scrollElement.scrollTop;
  if (remaining <= LOAD_MORE_THRESHOLD_PX) {
    onReachEnd();
  }
}

function LogStreamScrollbar({
  children,
  className,
  syncKey,
  onReachEnd,
}: {
  children: ReactNode;
  className?: string;
  syncKey?: string | number | boolean | null;
  onReachEnd?: (() => void) | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(null);
  const onReachEndRef = useRef<(() => void) | null>(onReachEnd ?? null);

  useEffect(() => {
    onReachEndRef.current = onReachEnd ?? null;
  }, [onReachEnd]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, PANEL_SCROLLBAR_OPTIONS);
    if (existing) {
      existing.options(PANEL_SCROLLBAR_OPTIONS);
    }
    scrollbarRef.current = instance;
    instance.update(true);

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
    if (!instance) return;
    instance.update(true);
    requestAnimationFrame(() => {
      maybeReachScrollEnd(instance, onReachEndRef.current);
    });
  }, [syncKey]);

  return (
    <div
      ref={hostRef}
      className={cn("overflow-hidden", className)}
      data-overlayscrollbars-initialize
    >
      {children}
    </div>
  );
}

function formatRelativeTime(locale: Locale, timestamp: number, now: number): string {
  const formatter = new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: "auto",
  });
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

function formatDetailDateTime(locale: Locale, value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatCoordinateValue(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return value.toFixed(4);
}

function normalizeDetailLabel(value: string, unknownLabel: string): string {
  const normalized = value.trim();
  return normalized || unknownLabel;
}

function resolveGeoTranslationApiLocale(locale: Locale): string | null {
  return GEO_TRANSLATION_API_LOCALE_BY_APP_LOCALE[locale] ?? null;
}

function normalizeGeoTranslationLookupValue(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function isSameGeoLabel(left: string, right: string): boolean {
  const normalizedLeft = normalizeGeoTranslationLookupValue(left);
  const normalizedRight = normalizeGeoTranslationLookupValue(right);
  return Boolean(
    normalizedLeft && normalizedRight && normalizedLeft === normalizedRight,
  );
}

function parseGeoStateTranslationBundle(
  payload: unknown,
): GeoStateTranslationBundle | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as {
    state?: unknown;
    cities?: unknown;
  };

  const state =
    record.state && typeof record.state === "object"
      ? (record.state as Record<string, unknown>)
      : null;
  const stateName = typeof state?.name === "string" ? state.name.trim() : "";

  const cities = Array.isArray(record.cities)
    ? record.cities.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const city = entry as Record<string, unknown>;
        const name = typeof city.name === "string" ? city.name.trim() : "";
        const nameDefault =
          typeof city.name_default === "string" ? city.name_default.trim() : "";
        const nativeName =
          typeof city.native === "string" ? city.native.trim() : "";
        if (!name && !nameDefault && !nativeName) return [];
        return [{ name, nameDefault, nativeName }];
      })
    : [];

  return {
    stateName,
    cities,
  };
}

async function fetchGeoStateTranslationBundle(
  apiLocale: string,
  countryCode: string,
  stateCode: string,
): Promise<GeoStateTranslationBundle | null> {
  const normalizedCountry = countryCode.trim().toUpperCase();
  const normalizedState = stateCode.trim().toUpperCase();
  if (
    !normalizedCountry ||
    !normalizedState ||
    !GEO_STATE_CODE_PATTERN.test(normalizedState)
  ) {
    return null;
  }

  const cacheKey = `${apiLocale}::${normalizedCountry}::${normalizedState}`;
  const cached = geoStateTranslationCache.get(cacheKey);
  if (cached) return cached;

  const request = fetch(
    `${GEO_TRANSLATION_API_BASE_URL}/${encodeURIComponent(apiLocale)}/${encodeURIComponent(normalizedCountry)}/${encodeURIComponent(normalizedState)}/`,
    {
      method: "GET",
      cache: "force-cache",
    },
  )
    .then(async (response) => {
      if (!response.ok) return null;
      const payload = (await response.json()) as unknown;
      return parseGeoStateTranslationBundle(payload);
    })
    .catch(() => null);

  geoStateTranslationCache.set(cacheKey, request);
  return request;
}

function resolveLocalizedCityName(
  bundle: GeoStateTranslationBundle | null,
  cityNameDefault: string,
): string | null {
  if (!bundle) return null;
  const target = normalizeGeoTranslationLookupValue(cityNameDefault);
  if (!target) return null;

  for (const city of bundle.cities) {
    const localized = normalizeGeoTranslationLookupValue(city.name);
    const fallback = normalizeGeoTranslationLookupValue(city.nameDefault);
    const nativeName = normalizeGeoTranslationLookupValue(city.nativeName);
    if (target === fallback || target === localized || target === nativeName) {
      return city.name || city.nameDefault || city.nativeName || null;
    }
  }

  return null;
}

function useGeoStateTranslationBundle({
  locale,
  countryCode,
  stateCode,
  enabled,
}: {
  locale: Locale;
  countryCode: string;
  stateCode: string;
  enabled: boolean;
}): GeoStateTranslationBundle | null {
  const [bundle, setBundle] = useState<GeoStateTranslationBundle | null>(null);

  useEffect(() => {
    if (!enabled) {
      setBundle(null);
      return;
    }

    const apiLocale = resolveGeoTranslationApiLocale(locale);
    if (!apiLocale) {
      setBundle(null);
      return;
    }

    const normalizedCountry = countryCode.trim().toUpperCase();
    const normalizedState = stateCode.trim().toUpperCase();
    if (
      !normalizedCountry ||
      !normalizedState ||
      !GEO_STATE_CODE_PATTERN.test(normalizedState)
    ) {
      setBundle(null);
      return;
    }

    let active = true;
    fetchGeoStateTranslationBundle(
      apiLocale,
      normalizedCountry,
      normalizedState,
    ).then((nextBundle) => {
      if (!active) return;
      setBundle(nextBundle);
    });

    return () => {
      active = false;
    };
  }, [countryCode, enabled, locale, stateCode]);

  return bundle;
}

function formatLocalizedGeoValue(
  localizedValue: string,
  rawValue: string,
  unknownLabel: string,
): string {
  const normalizedLocalized = normalizeDetailLabel(localizedValue, unknownLabel);
  const normalizedRaw = normalizeDetailLabel(rawValue, unknownLabel);
  if (
    normalizedRaw === unknownLabel ||
    isSameGeoLabel(normalizedLocalized, normalizedRaw)
  ) {
    return normalizedLocalized;
  }
  return `${normalizedLocalized} (${normalizedRaw})`;
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
  const kind = classifyRealtimeLogEvent(event.eventType.trim());
  const { label: countryLabel, code: countryCode } = resolveCountryLabel(
    event.country,
    locale,
    messages.common.unknown,
  );

  return {
    kind,
    title: formatLogTitle(locale, messages, event, kind),
    avatarSeed: event.visitorId.trim() || event.sessionId.trim() || event.id,
    browserLabel: event.browser.trim() || messages.common.unknown,
    browserIconKey: resolveBrowserIconKey(event.browser),
    osLabel: event.osVersion.trim() || messages.common.unknown,
    osIconKey: resolveOsIconKey(event.osVersion),
    countryLabel,
    countryFlagCode: resolveCountryFlagCode(countryCode, locale),
    sourceLabel: event.referrerHost.trim() || messages.overview.direct,
  };
}

function buildRealtimeVisitorVisitHistory(
  selectedEvent: RealtimeEvent,
  events: RealtimeEvent[],
  visits: RealtimeVisit[],
): RealtimeVisitorVisitHistory[] {
  const visitorId = selectedEvent.visitorId.trim();
  if (!visitorId) return [];

  const visitById = new Map(
    visits
      .filter((visit) => visit.visitorId.trim() === visitorId)
      .map((visit) => [visit.visitId, visit] as const),
  );
  const eventGroups = new Map<string, RealtimeEvent[]>();

  for (const event of events) {
    if (event.visitorId.trim() !== visitorId) continue;
    const group = eventGroups.get(event.visitId) ?? [];
    group.push(event);
    eventGroups.set(event.visitId, group);
  }

  const visitIds = new Set<string>([
    ...eventGroups.keys(),
    ...visitById.keys(),
  ]);

  return [...visitIds]
    .map((visitId) => {
      const visit = visitById.get(visitId);
      const visitEvents = [...(eventGroups.get(visitId) ?? [])].sort(
        (left, right) => right.eventAt - left.eventAt,
      );
      const mostRecentEvent = visitEvents[0] ?? selectedEvent;
      const oldestEvent = visitEvents[visitEvents.length - 1] ?? selectedEvent;

      return {
        visitId,
        sessionId:
          visit?.sessionId.trim()
          || mostRecentEvent.sessionId.trim()
          || selectedEvent.sessionId.trim(),
        startedAt: visit?.startedAt ?? oldestEvent.eventAt,
        lastActivityAt: visit?.lastActivityAt ?? mostRecentEvent.eventAt,
        pathname:
          visit?.pathname.trim()
          || mostRecentEvent.pathname.trim()
          || "/",
        title:
          visit?.title.trim()
          || mostRecentEvent.title.trim()
          || mostRecentEvent.pathname.trim()
          || "/",
        hostname:
          visit?.hostname.trim()
          || mostRecentEvent.hostname.trim()
          || "",
        events: visitEvents,
      };
    })
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}

interface RealtimeLogStreamItemProps {
  event: RealtimeEvent;
  locale: Locale;
  messages: AppMessages;
  now: number;
}

function areRealtimeLogStreamItemPropsEqual(
  previousProps: RealtimeLogStreamItemProps,
  nextProps: RealtimeLogStreamItemProps,
) {
  return previousProps.locale === nextProps.locale
    && previousProps.messages === nextProps.messages
    && previousProps.now === nextProps.now
    && previousProps.event.id === nextProps.event.id
    && previousProps.event.eventType === nextProps.event.eventType
    && previousProps.event.eventAt === nextProps.event.eventAt
    && previousProps.event.pathname === nextProps.event.pathname
    && previousProps.event.visitorId === nextProps.event.visitorId
    && previousProps.event.sessionId === nextProps.event.sessionId
    && previousProps.event.browser === nextProps.event.browser
    && previousProps.event.osVersion === nextProps.event.osVersion
    && previousProps.event.country === nextProps.event.country
    && previousProps.event.referrerHost === nextProps.event.referrerHost;
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
    <span className={cn(
      "inline-flex max-w-full items-center gap-2 break-words text-[11px] text-foreground sm:justify-end",
      mono && "font-mono",
    )}
    >
      {icon ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 break-all sm:text-right">{value}</span>
    </span>
  );
}

function RealtimeEventDetailRow({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="grid items-start gap-1 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <div className="min-w-0 text-left text-[11px] text-foreground sm:self-center sm:text-right">
        {value}
      </div>
    </div>
  );
}

const RealtimeLogStreamItemCard = memo(
  function RealtimeLogStreamItemCard({
    event,
    locale,
    messages,
    now,
  }: RealtimeLogStreamItemProps) {
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
    } = resolveRealtimeEventDisplayData(locale, messages, event);

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
                    icon={(
                      <LogoIcon
                        src={`${BROWSER_ICON_DIR}/${browserIconKey}.svg`}
                        fallbackSrc={`${BROWSER_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
                        invertInDark={BROWSER_APPLE_ICON_KEYS.has(browserIconKey)}
                      />
                    )}
                    label={browserLabel}
                    hideLabelOnMobile
                  />
                  <MetaItem
                    icon={(
                      <LogoIcon
                        src={`${OS_ICON_DIR}/${osIconKey}.svg`}
                        fallbackSrc={`${OS_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
                        invertInDark={OS_APPLE_ICON_KEYS.has(osIconKey)}
                      />
                    )}
                    label={osLabel}
                    hideLabelOnMobile
                  />
                  <MetaItem
                    icon={countryFlagCode ? (
                      <Icon
                        icon={`flagpack:${countryFlagCode.toLowerCase()}`}
                        style={{ width: 16, height: 12 }}
                        className="block shrink-0"
                      />
                    ) : (
                        <RiGlobalLine className="size-3.5 text-muted-foreground" />
                      )}
                    label={countryLabel}
                    hideLabelOnMobile
                  />
                  <MetaItem
                    icon={(
                      <DomainOrUrlIcon
                        label={sourceLabel}
                        unknownLabel={messages.overview.direct}
                      />
                    )}
                    label={sourceLabel}
                  />
                </div>
              </div>
              <div className="shrink-0 self-stretch">
                <div className="flex h-full min-w-[7.5rem] flex-col items-end justify-between text-right">
                  <p className="font-mono text-[11px] text-foreground">
                    {formatRelativeTime(locale, event.eventAt, now)}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {shortDateTime(locale, event.eventAt)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  },
  areRealtimeLogStreamItemPropsEqual,
);

function RealtimeLogStreamItem({
  event,
  locale,
  messages,
  now,
  onSelect,
  reduceMotion,
}: RealtimeLogStreamItemProps & {
  onSelect: (event: RealtimeEvent) => void;
  reduceMotion: boolean;
}) {
  const title = formatLogTitle(
    locale,
    messages,
    event,
    classifyRealtimeLogEvent(event.eventType.trim()),
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
          now={now}
        />
      </Clickable>
    </motion.li>
  );
}

function RealtimeVisitorHistorySection({
  locale,
  messages,
  now,
  event,
  events,
  visits,
}: {
  locale: Locale;
  messages: AppMessages;
  now: number;
  event: RealtimeEvent;
  events: RealtimeEvent[];
  visits: RealtimeVisit[];
}) {
  const visitHistory = useMemo(
    () => buildRealtimeVisitorVisitHistory(event, events, visits),
    [event, events, visits],
  );
  const totalEventCount = visitHistory.reduce(
    (sum, visit) => sum + visit.events.length,
    0,
  );

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
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center rounded-sm border border-border px-2 py-1">
            {visitHistory.length} {messages.common.sessions}
          </span>
          <span className="inline-flex items-center rounded-sm border border-border px-2 py-1">
            {totalEventCount} {messages.common.event}
          </span>
        </div>
      </div>
      {visitHistory.length === 0 ? (
        <div className="flex min-h-24 items-center justify-center rounded-sm border border-dashed border-border text-[11px] text-muted-foreground">
          {messages.realtime.visitorHistoryEmpty}
        </div>
      ) : (
        <div className="space-y-2">
          {visitHistory.map((visit) => (
            <Card key={visit.visitId} size="sm">
              <CardContent className="space-y-3 px-3 sm:px-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {visit.title}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="truncate">
                        {messages.common.path}: {visit.pathname}
                      </span>
                      <span className="truncate">
                        {messages.common.hostname}: {visit.hostname || messages.common.unknown}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-mono text-[11px] text-foreground">
                      {formatRelativeTime(locale, visit.lastActivityAt, now)}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {shortDateTime(locale, visit.lastActivityAt)}
                    </p>
                  </div>
                </div>
                <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
                  <span>
                    {messages.common.startedAt}: {formatDetailDateTime(locale, visit.startedAt)}
                  </span>
                  <span>
                    {messages.realtime.visitId}: {visit.visitId}
                  </span>
                  <span>
                    {messages.realtime.sessionId}: {visit.sessionId || messages.common.unknown}
                  </span>
                </div>
                <div className="space-y-1.5 border-t border-border/70 pt-3">
                  {visit.events.map((visitEvent) => (
                    <div
                      key={visitEvent.id}
                      className="flex items-center justify-between gap-3 rounded-sm bg-muted/25 px-2 py-1.5"
                    >
                      <p className="min-w-0 truncate text-[11px] text-foreground">
                        {formatLogTitle(
                          locale,
                          messages,
                          visitEvent,
                          classifyRealtimeLogEvent(visitEvent.eventType.trim()),
                        )}
                      </p>
                      <p className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {shortDateTime(locale, visitEvent.eventAt)}
                      </p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function RealtimeVisitorLocationMapSection({
  messages,
  event,
}: {
  messages: AppMessages;
  event: RealtimeEvent;
}) {
  const mapRef = useRef<MapRef | null>(null);
  const { resolvedTheme } = useTheme();
  const effectiveMapTheme: EffectiveMapTheme =
    resolvedTheme === "dark" ? "dark" : "light";
  const mapStyle = useMemo(
    () => buildDetailRasterStyle(effectiveMapTheme),
    [effectiveMapTheme],
  );
  const hasLocation = hasValidCoordinate(event.latitude, event.longitude);

  return (
    <section className="space-y-2">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">
          {messages.realtime.visitorMapSection}
        </h3>
        <p className="text-[11px] text-muted-foreground">
          {messages.realtime.visitorMapSubtitle}
        </p>
      </div>
      {hasLocation ? (
        <div className="relative overflow-hidden rounded-sm border border-border/70">
          <div className={DETAIL_MAP_HEIGHT_CLASS}>
            <MapView
              ref={mapRef}
              key={`${effectiveMapTheme}:${event.latitude}:${event.longitude}`}
              initialViewState={{
                longitude: event.longitude as number,
                latitude: event.latitude as number,
                zoom: DETAIL_MAP_DEFAULT_ZOOM,
                pitch: 0,
                bearing: 0,
              }}
              minZoom={DETAIL_MAP_MIN_ZOOM}
              maxZoom={DETAIL_MAP_MAX_ZOOM}
              mapStyle={mapStyle}
              attributionControl={false}
              reuseMaps
              interactive
              dragPan={false}
              dragRotate={false}
              touchPitch={false}
              keyboard={false}
              scrollZoom
              doubleClickZoom
              touchZoomRotate
              style={{ width: "100%", height: "100%" }}
            />
          </div>
          <div className="absolute right-3 top-3 z-10 flex flex-col overflow-hidden rounded-sm border border-border/70 bg-background/92 shadow-sm backdrop-blur">
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center text-sm text-foreground transition-colors hover:bg-muted"
              onClick={() => {
                mapRef.current?.getMap().zoomIn({ duration: 180 });
              }}
              aria-label={messages.realtime.mapZoomIn}
              title={messages.realtime.mapZoomIn}
            >
              +
            </button>
            <div className="h-px bg-border/70" />
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center text-sm text-foreground transition-colors hover:bg-muted"
              onClick={() => {
                mapRef.current?.getMap().zoomOut({ duration: 180 });
              }}
              aria-label={messages.realtime.mapZoomOut}
              title={messages.realtime.mapZoomOut}
            >
              -
            </button>
          </div>
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex size-6 items-center justify-center rounded-full border border-background/80 bg-foreground/95 shadow-lg shadow-foreground/15">
              <div className="size-2.5 rounded-full bg-background" />
            </div>
          </div>
        </div>
      ) : (
        <div className={cn(
          "flex items-center justify-center rounded-sm border border-dashed border-border text-[11px] text-muted-foreground",
          DETAIL_MAP_HEIGHT_CLASS,
        )}
        >
          {messages.realtime.visitorMapUnavailable}
        </div>
      )}
    </section>
  );
}

function RealtimeLogEventDetailsDialog({
  locale,
  messages,
  now,
  event,
  open,
  onOpenChange,
  events,
  visits,
}: {
  locale: Locale;
  messages: AppMessages;
  now: number;
  event: RealtimeEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: RealtimeEvent[];
  visits: RealtimeVisit[];
}) {
  const translationBundle = useGeoStateTranslationBundle({
    locale,
    countryCode: event?.country ?? "",
    stateCode: event?.regionCode ?? "",
    enabled: open && Boolean(event),
  });

  if (!event) return null;

  const {
    browserIconKey,
    browserLabel,
    countryFlagCode,
    countryLabel,
    osIconKey,
    osLabel,
    sourceLabel,
  } = resolveRealtimeEventDisplayData(locale, messages, event);
  const continentLabel = resolveContinentLabel(
    event.continent,
    messages.common.unknown,
    messages.common.continentLabels,
  );
  const regionLabel = resolveRealtimeRegionLabel(event.region, messages);
  const cityLabel = resolveRealtimeCityLabel(event.city, messages);
  const localizedRegionLabel =
    translationBundle?.stateName.trim() || regionLabel;
  const localizedCityLabel =
    resolveLocalizedCityName(translationBundle, cityLabel) || cityLabel;
  const languageLabel = resolveLanguageLabel(
    event.language,
    locale,
    messages.common.unknown,
  ).label;
  const detailRows = [
    {
      label: messages.common.id,
      value: <RealtimeEventDetailValue value={event.id.trim() || messages.common.unknown} mono />,
    },
    {
      label: messages.realtime.visitorId,
      value: <RealtimeEventDetailValue value={event.visitorId.trim() || messages.common.unknown} mono />,
    },
    {
      label: messages.realtime.sessionId,
      value: <RealtimeEventDetailValue value={event.sessionId.trim() || messages.common.unknown} mono />,
    },
    {
      label: messages.realtime.visitId,
      value: <RealtimeEventDetailValue value={event.visitId.trim() || messages.common.unknown} mono />,
    },
    {
      label: messages.realtime.eventType,
      value: <RealtimeEventDetailValue value={event.eventType.trim() || messages.common.unknown} mono />,
    },
    {
      label: messages.realtime.eventTime,
      value: <RealtimeEventDetailValue value={formatDetailDateTime(locale, event.eventAt)} mono />,
    },
    {
      label: messages.common.title,
      value: <RealtimeEventDetailValue value={event.title.trim() || messages.common.unknown} />,
    },
    {
      label: messages.common.path,
      value: <RealtimeEventDetailValue value={event.pathname.trim() || "/"} mono />,
    },
    {
      label: messages.common.hostname,
      value: <RealtimeEventDetailValue value={event.hostname.trim() || messages.common.unknown} mono />,
    },
    {
      label: messages.common.browser,
      value: (
        <RealtimeEventDetailValue
          icon={(
            <LogoIcon
              src={`${BROWSER_ICON_DIR}/${browserIconKey}.svg`}
              fallbackSrc={`${BROWSER_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
              invertInDark={BROWSER_APPLE_ICON_KEYS.has(browserIconKey)}
            />
          )}
          value={browserLabel}
        />
      ),
    },
    {
      label: messages.common.operatingSystem,
      value: (
        <RealtimeEventDetailValue
          icon={(
            <LogoIcon
              src={`${OS_ICON_DIR}/${osIconKey}.svg`}
              fallbackSrc={`${OS_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
              invertInDark={OS_APPLE_ICON_KEYS.has(osIconKey)}
            />
          )}
          value={osLabel}
        />
      ),
    },
    {
      label: messages.common.deviceType,
      value: <RealtimeEventDetailValue value={event.deviceType.trim() || messages.common.unknown} />,
    },
    {
      label: messages.common.country,
      value: (
        <RealtimeEventDetailValue
          icon={countryFlagCode ? (
            <Icon
              icon={`flagpack:${countryFlagCode.toLowerCase()}`}
              style={{ width: 16, height: 12 }}
              className="block shrink-0"
            />
          ) : (
            <RiGlobalLine className="size-3.5 text-muted-foreground" />
          )}
          value={
            event.country.trim() && event.country.trim() !== countryLabel
              ? `${countryLabel} (${event.country.trim()})`
              : countryLabel
          }
        />
      ),
    },
    {
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
      label: messages.common.regionCode,
      value: <RealtimeEventDetailValue value={event.regionCode.trim() || messages.common.unknown} mono />,
    },
    {
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
      label: messages.common.timezone,
      value: <RealtimeEventDetailValue value={event.timezone.trim() || messages.common.unknown} mono />,
    },
    {
      label: messages.common.referrerHost,
      value: <RealtimeEventDetailValue value={event.referrerHost.trim() || messages.overview.direct} mono />,
    },
    {
      label: messages.common.referrer,
      value: (
        <RealtimeEventDetailValue
          icon={(
            <DomainOrUrlIcon
              label={sourceLabel}
              unknownLabel={messages.overview.direct}
            />
          )}
          value={event.referrerUrl.trim() || sourceLabel}
          mono
        />
      ),
    },
    {
      label: messages.common.screenSize,
      value: <RealtimeEventDetailValue value={event.screenSize.trim() || messages.common.unknown} mono />,
    },
    {
      label: messages.common.language,
      value: <RealtimeEventDetailValue value={languageLabel} mono />,
    },
    {
      label: messages.common.organization,
      value: <RealtimeEventDetailValue value={event.organization.trim() || messages.common.unknown} />,
    },
    {
      label: messages.common.latitude,
      value: <RealtimeEventDetailValue value={formatCoordinateValue(event.latitude)} mono />,
    },
    {
      label: messages.common.longitude,
      value: <RealtimeEventDetailValue value={formatCoordinateValue(event.longitude)} mono />,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 p-0">
        <DialogHeader className="border-b px-4 py-4 sm:px-5">
          <DialogTitle>{messages.realtime.detailsTitle}</DialogTitle>
        </DialogHeader>
        <LogStreamScrollbar
          className="max-h-[min(78vh,44rem)]"
          syncKey={event.id}
        >
          <div className="space-y-4 p-4 sm:p-5">
            <RealtimeLogStreamItemCard
              event={event}
              locale={locale}
              messages={messages}
              now={now}
            />
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">
                {messages.realtime.detailsSection}
              </h3>
              <div className="divide-y divide-border/70 ring-1 ring-foreground/10">
                {detailRows.map((row) => (
                  <RealtimeEventDetailRow
                    key={row.label}
                    label={row.label}
                    value={row.value}
                  />
                ))}
              </div>
            </section>
            <RealtimeVisitorHistorySection
              locale={locale}
              messages={messages}
              now={now}
              event={event}
              events={events}
              visits={visits}
            />
            <RealtimeVisitorLocationMapSection
              messages={messages}
              event={event}
            />
          </div>
        </LogStreamScrollbar>
      </DialogContent>
    </Dialog>
  );
}

export function RealtimeLogStreamCard({
  locale,
  messages,
  hasConnected,
  events,
  visits,
}: RealtimeLogStreamCardProps) {
  const reduceLogItemMotion = useReducedMotion() ?? false;
  const [now, setNow] = useState(() => Date.now());
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_EVENTS);
  const [selectedEvent, setSelectedEvent] = useState<RealtimeEvent | null>(null);

  const visibleEvents = events.slice(0, visibleCount);
  const hasMoreEvents = visibleCount < events.length;
  const isInitialLoading = !hasConnected && visibleEvents.length === 0;

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, RELATIVE_TIME_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    setVisibleCount((previous) => {
      if (events.length <= 0) return INITIAL_VISIBLE_EVENTS;
      return Math.min(events.length, Math.max(previous, INITIAL_VISIBLE_EVENTS));
    });
  }, [events.length]);

  const loadMoreEvents = () => {
    if (!hasMoreEvents) return;
    setVisibleCount((previous) =>
      Math.min(events.length, previous + LOAD_MORE_STEP),
    );
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{messages.realtime.recentEvents}</CardTitle>
        </CardHeader>
        <CardContent>
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
                        now={now}
                        onSelect={setSelectedEvent}
                        reduceMotion={reduceLogItemMotion}
                      />
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            </LogStreamScrollbar>
          )}
        </CardContent>
      </Card>
      <RealtimeLogEventDetailsDialog
        event={selectedEvent}
        locale={locale}
        messages={messages}
        now={now}
        events={events}
        visits={visits}
        open={selectedEvent !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedEvent(null);
          }
        }}
      />
    </>
  );
}
