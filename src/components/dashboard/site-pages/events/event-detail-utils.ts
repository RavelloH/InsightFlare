import {
  formatPath,
  formatScreen,
  formatShortDateTime,
} from "@/components/dashboard/journeys/journey-display";
import { parseGeoLocationValue } from "@/lib/analytics/geo-location";
import { numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
export function formatEventDetailDateTime(
  locale: Locale,
  value: number | null | undefined,
  unknownLabel: string,
  missingLabel = unknownLabel,
): string {
  if (value === null || value === undefined) return missingLabel;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? formatShortDateTime(locale, value, undefined)
    : unknownLabel;
}
export function formatEventDetailDateTimeOrAbsent(
  locale: Locale,
  value: number | null | undefined,
  hasValue: boolean,
  unknownLabel: string,
  absentLabel: string,
): string {
  return hasValue
    ? formatEventDetailDateTime(locale, value, unknownLabel)
    : absentLabel;
}
export function formatEventDetailBoolean(
  value: boolean | undefined,
  messages: AppMessages,
): string {
  if (value === undefined) return messages.common.noData;
  if (typeof value !== "boolean") return messages.common.unknown;
  return value ? messages.sessionDetail.yes : messages.sessionDetail.no;
}
export function formatEventDetailStatus(
  value: string | undefined,
  messages: AppMessages,
): string {
  const normalized = value?.trim() || "";
  if (!normalized) return messages.common.noData;
  const key = normalized as keyof AppMessages["realtime"]["statusLabels"];
  return key && messages.realtime.statusLabels[key]
    ? messages.realtime.statusLabels[key]
    : messages.common.unknown;
}
export function formatEventDetailText(
  value: string | null | undefined,
  missingLabel: string,
  unknownLabel = missingLabel,
) {
  const normalized = value?.trim() || "";
  if (!normalized) return missingLabel;
  return ["unknown", "undefined", "null"].includes(
    normalized.toLocaleLowerCase(),
  )
    ? unknownLabel
    : normalized;
}
export function formatEventDetailPath(
  value: string | null | undefined,
  missingLabel: string,
  unknownLabel: string,
): string {
  const normalized = value?.trim() || "";
  if (!normalized) return missingLabel;
  if (["unknown", "undefined", "null"].includes(normalized.toLowerCase())) {
    return unknownLabel;
  }
  return formatPath(normalized);
}
export function formatEventDetailCity(
  value: string | null | undefined,
  missingLabel: string,
  unknownLabel: string,
): string {
  const normalized = value?.trim() || "";
  const parsed = parseGeoLocationValue(normalized);
  return formatEventDetailText(
    parsed?.localityName || parsed?.regionName || normalized,
    missingLabel,
    unknownLabel,
  );
}
export function formatEventDetailScreen(
  width: number | null | undefined,
  height: number | null | undefined,
  unknownLabel: string,
  missingLabel = unknownLabel,
): string {
  if (width === null || width === undefined) {
    return height === null || height === undefined
      ? missingLabel
      : unknownLabel;
  }
  if (height === null || height === undefined) return unknownLabel;
  const screen = formatScreen(width, height);
  return screen === "/" ? unknownLabel : screen;
}
export function formatEventDetailPerformance(
  locale: Locale,
  value: number | null | undefined,
  metric: "ttfb" | "fcp" | "lcp" | "cls" | "inp",
  unknownLabel: string,
  missingLabel = unknownLabel,
): string {
  if (value === null || value === undefined) return missingLabel;
  if (typeof value !== "number" || !Number.isFinite(value)) return unknownLabel;
  const formatted = numberFormat(locale, value);
  return metric === "cls" ? formatted : `${formatted} ms`;
}
export function hasValidEventCoordinate(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  const lat = Number(latitude);
  const lon = Number(longitude);
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}
export function isInsideDetailDrawer(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest("[data-detail-drawer-root]") !== null
  );
}
