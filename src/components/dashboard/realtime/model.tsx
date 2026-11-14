import { UNKNOWN_ICON_KEY } from "@insightflare/product-ui/realtime";

import { formatPathWithHash } from "@/components/dashboard/journeys/journey-display";
import { parseGeoLocationValue } from "@/lib/analytics/geo-location";
import { intlLocale } from "@/lib/dashboard/format";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type { RealtimeEvent, RealtimeVisit } from "@/lib/realtime/types";
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
const EVENT_INTEGRATION_WINDOW_MS = 60_000;
export const INITIAL_VISIBLE_EVENTS = 24;
export const LOAD_MORE_STEP = 24;
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
