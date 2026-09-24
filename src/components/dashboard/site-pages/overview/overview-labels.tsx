import { memo, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { AutoTransition } from "@/components/ui/auto-transition";
import { intlLocale } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import { formatI18nTemplate } from "@/lib/i18n/template";

import {
  leadingLabelLetter,
  resolveFaviconUrlForLabel,
  sanitizeHostname,
  toAbsoluteHttpsUrl,
} from "./overview-url";
import { type PageCardTab } from "./types";
const UMAMI_BROWSER_ICON_PREFIX = "umami-browser:";
const UMAMI_OS_ICON_PREFIX = "umami-os:";
const UMAMI_BROWSER_ICON_DIR = "/images/browser";
const UMAMI_OS_ICON_DIR = "/images/os";
const UMAMI_ICON_FALLBACK = "unknown";
const UMAMI_BROWSER_APPLE_ICON_KEYS = new Set(["ios", "ios-webview"]);
const UMAMI_OS_APPLE_ICON_KEYS = new Set(["ios", "mac-os"]);
export function resolveBrowserLogoIconName(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return null;

  let iconKey = UMAMI_ICON_FALLBACK;

  if (
    normalized.includes("android webview") ||
    normalized.includes("android-webview")
  ) {
    iconKey = "android-webview";
  } else if (normalized.includes("chromium-webview")) {
    iconKey = "chromium-webview";
  } else if (normalized.includes("edge chromium")) {
    iconKey = "edge-chromium";
  } else if (normalized.includes("edge ios")) {
    iconKey = "edge-ios";
  } else if (normalized.includes("edge")) {
    iconKey = "edge-chromium";
  } else if (
    normalized.includes("chrome ios") ||
    normalized.includes("crios")
  ) {
    iconKey = "crios";
  } else if (
    normalized.includes("firefox ios") ||
    normalized.includes("fxios")
  ) {
    iconKey = "fxios";
  } else if (normalized.includes("ios webview")) {
    iconKey = "ios-webview";
  } else if (normalized === "ios") {
    iconKey = "ios";
  } else if (normalized.includes("internet explorer") || normalized === "ie") {
    iconKey = "ie";
  } else if (normalized.includes("arc")) {
    iconKey = "arc";
  } else if (normalized.includes("opera mini")) {
    iconKey = "opera-mini";
  } else if (normalized.includes("opera gx")) {
    iconKey = "opera-gx";
  } else if (normalized.includes("opera")) {
    iconKey = "opera";
  } else if (normalized.includes("samsung")) {
    iconKey = "samsung";
  } else if (
    normalized.includes("ucbrowser") ||
    normalized.includes("uc browser")
  ) {
    iconKey = "uc";
  } else if (
    normalized.includes("qqbrowser") ||
    normalized.includes("qq browser") ||
    normalized === "qq"
  ) {
    iconKey = "qq";
  } else if (normalized.includes("duckduckgo")) {
    iconKey = "duckduckgo";
  } else if (normalized.includes("wechat")) {
    iconKey = "wechat";
  } else if (normalized.includes("vivaldi")) {
    iconKey = "vivaldi";
  } else if (normalized.includes("huawei browser") || normalized === "huawei") {
    iconKey = "huawei";
  } else if (
    normalized.includes("honor") ||
    normalized.includes("vivo browser") ||
    normalized.includes("heytap")
  ) {
    iconKey = "android";
  } else if (normalized.includes("android")) {
    iconKey = "android";
  } else if (normalized.includes("miui")) {
    iconKey = "miui";
  } else if (
    normalized.includes("waterfox") ||
    normalized.includes("librewolf") ||
    normalized.includes("iceweasel") ||
    normalized.includes("icecat") ||
    normalized.includes("icedragon") ||
    normalized.includes("fennec") ||
    normalized.includes("seamonkey") ||
    normalized.includes("pale moon")
  ) {
    iconKey = "firefox";
  } else if (normalized.includes("firefox")) {
    iconKey = "firefox";
  } else if (normalized.includes("safari")) {
    iconKey = "safari";
  } else if (
    normalized.includes("bing") ||
    normalized.includes("ecosia") ||
    normalized === "gsa" ||
    normalized.includes("coc coc") ||
    normalized.includes("coccoc") ||
    normalized.includes("whale") ||
    normalized.includes("naver") ||
    normalized.includes("sogou") ||
    normalized.includes("maxthon") ||
    normalized.includes("puffin") ||
    normalized.includes("quark")
  ) {
    iconKey = "chrome";
  } else if (normalized.includes("chrome") || normalized.includes("chromium")) {
    iconKey = "chrome";
  } else if (normalized.includes("brave")) {
    iconKey = "brave";
  } else if (normalized.includes("facebook")) {
    iconKey = "facebook";
  } else if (normalized.includes("instagram")) {
    iconKey = "instagram";
  } else if (normalized.includes("kakao")) {
    iconKey = "kakaotalk";
  } else if (normalized.includes("yandex")) {
    iconKey = "yandexbrowser";
  } else if (normalized.includes("silk")) {
    iconKey = "silk";
  } else if (normalized.includes("searchbot")) {
    iconKey = "searchbot";
  } else if (normalized.includes("curl")) {
    iconKey = "curl";
  } else if (normalized.includes("aol")) {
    iconKey = "aol";
  } else if (normalized.includes("beaker")) {
    iconKey = "beaker";
  } else if (normalized.includes("blackberry") || normalized.includes("bb10")) {
    iconKey = "blackberry";
  }

  return `${UMAMI_BROWSER_ICON_PREFIX}${iconKey}`;
}
export function resolveOsLogoIconName(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return null;

  let iconKey = UMAMI_ICON_FALLBACK;

  if (normalized.includes("windows 11")) {
    iconKey = "windows-11";
  } else if (normalized.includes("windows 10")) {
    iconKey = "windows-10";
  } else if (normalized.includes("windows 8.1")) {
    iconKey = "windows-8-1";
  } else if (normalized.includes("windows 8")) {
    iconKey = "windows-8";
  } else if (normalized.includes("windows 7")) {
    iconKey = "windows-7";
  } else if (normalized.includes("windows vista")) {
    iconKey = "windows-vista";
  } else if (normalized.includes("windows xp")) {
    iconKey = "windows-xp";
  } else if (normalized.includes("windows 2000")) {
    iconKey = "windows-2000";
  } else if (normalized.includes("windows 98")) {
    iconKey = "windows-98";
  } else if (normalized.includes("windows 95")) {
    iconKey = "windows-95";
  } else if (normalized.includes("windows me")) {
    iconKey = "windows-me";
  } else if (normalized.includes("windows mobile")) {
    iconKey = "windows-mobile";
  } else if (normalized.includes("windows server 2003")) {
    iconKey = "windows-server-2003";
  } else if (normalized.startsWith("windows")) {
    iconKey = "windows-10";
  } else if (
    normalized.startsWith("mac") ||
    normalized.startsWith("os x") ||
    normalized.startsWith("darwin")
  ) {
    iconKey = "mac-os";
  } else if (normalized.startsWith("ios")) {
    iconKey = "ios";
  } else if (normalized.startsWith("android")) {
    iconKey = "android-os";
  } else if (
    normalized.startsWith("chrome os") ||
    normalized.startsWith("chromium os")
  ) {
    iconKey = "chrome-os";
  } else if (normalized.startsWith("amazon os")) {
    iconKey = "amazon-os";
  } else if (normalized.startsWith("blackberry")) {
    iconKey = "blackberry-os";
  } else if (normalized.includes("openbsd")) {
    iconKey = "open-bsd";
  } else if (normalized.includes("qnx")) {
    iconKey = "qnx";
  } else if (normalized.includes("os/2") || normalized.includes("os 2")) {
    iconKey = "os-2";
  } else if (normalized.includes("beos")) {
    iconKey = "beos";
  } else if (normalized.includes("sun os") || normalized.includes("sunos")) {
    iconKey = "sun-os";
  } else if (
    normalized.includes("linux") ||
    normalized.startsWith("ubuntu") ||
    normalized.startsWith("debian") ||
    normalized.startsWith("fedora") ||
    normalized.startsWith("centos")
  ) {
    iconKey = "linux";
  }

  return `${UMAMI_OS_ICON_PREFIX}${iconKey}`;
}
function resolveUmamiIconSource(
  iconName: string,
): { src: string; fallbackSrc: string; isAppleGlyph?: boolean } | null {
  if (iconName.startsWith(UMAMI_BROWSER_ICON_PREFIX)) {
    const iconKey = iconName.slice(UMAMI_BROWSER_ICON_PREFIX.length);
    return {
      src: `${UMAMI_BROWSER_ICON_DIR}/${iconKey}.svg`,
      fallbackSrc: `${UMAMI_BROWSER_ICON_DIR}/${UMAMI_ICON_FALLBACK}.svg`,
      isAppleGlyph: UMAMI_BROWSER_APPLE_ICON_KEYS.has(iconKey),
    };
  }

  if (iconName.startsWith(UMAMI_OS_ICON_PREFIX)) {
    const iconKey = iconName.slice(UMAMI_OS_ICON_PREFIX.length);
    return {
      src: `${UMAMI_OS_ICON_DIR}/${iconKey}.svg`,
      fallbackSrc: `${UMAMI_OS_ICON_DIR}/${UMAMI_ICON_FALLBACK}.svg`,
      isAppleGlyph: UMAMI_OS_APPLE_ICON_KEYS.has(iconKey),
    };
  }

  return null;
}
export const LabelWithLeadingIcon = memo(function LabelWithLeadingIcon({
  label,
  iconName,
}: {
  label: string;
  iconName?: string | null;
}) {
  if (!iconName) {
    return <span className="break-words">{label}</span>;
  }

  const isFlag = iconName.startsWith("flagpack:");
  const umamiIcon = resolveUmamiIconSource(iconName);

  return (
    <span className="relative inline-block max-w-full break-words pl-6">
      <span className="pointer-events-none absolute inset-y-0 left-0 inline-flex w-4 items-center justify-center">
        <span className="inline-flex size-4 items-center justify-center">
          {isFlag ? (
            <Icon
              icon={iconName}
              style={{
                width: 16,
                height: 12,
              }}
              className="block shrink-0"
            />
          ) : umamiIcon ? (
            <img
              src={umamiIcon.src}
              alt=""
              width={16}
              height={16}
              className={`block h-4 w-4 shrink-0 ${umamiIcon.isAppleGlyph ? "dark:invert" : ""}`}
              loading="lazy"
              decoding="async"
              onError={(event) => {
                const target = event.currentTarget;
                if (target.dataset.fallbackApplied === "true") return;
                target.dataset.fallbackApplied = "true";
                target.src = umamiIcon.fallbackSrc;
              }}
            />
          ) : null}
        </span>
      </span>
      <span className="break-words">{label}</span>
    </span>
  );
});
export function normalizeDimensionLabel(
  value: string,
  unknownLabel: string,
  options?: { screenSize?: boolean },
): string {
  const normalized = value.trim();
  if (!normalized) return unknownLabel;
  if (options?.screenSize && (normalized === "0x0" || normalized === "0X0")) {
    return unknownLabel;
  }
  return normalized;
}
const timezoneNameFormatterCache = new Map<string, Intl.DateTimeFormat>();
const timezonePartsFormatterCache = new Map<string, Intl.DateTimeFormat>();
function getTimezoneNameFormatter(
  locale: Locale,
  timeZone: string,
): Intl.DateTimeFormat | null {
  const cacheKey = `${locale}::${timeZone}`;
  const cached = timezoneNameFormatterCache.get(cacheKey);
  if (cached) return cached;

  try {
    const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone,
      timeZoneName: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    timezoneNameFormatterCache.set(cacheKey, formatter);
    return formatter;
  } catch {
    return null;
  }
}
function getTimezonePartsFormatter(
  timeZone: string,
): Intl.DateTimeFormat | null {
  const cached = timezonePartsFormatterCache.get(timeZone);
  if (cached) return cached;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    timezonePartsFormatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    return null;
  }
}
function resolveTimezoneOffsetMinutes(
  timeZone: string,
  timestampMs: number,
): number | null {
  const formatter = getTimezonePartsFormatter(timeZone);
  if (!formatter) return null;

  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) return null;

  const parts = formatter.formatToParts(date);
  let year = NaN;
  let month = NaN;
  let day = NaN;
  let hour = NaN;
  let minute = NaN;
  let second = NaN;

  for (const part of parts) {
    const value = Number(part.value);
    if (!Number.isFinite(value)) continue;
    if (part.type === "year") year = value;
    else if (part.type === "month") month = value;
    else if (part.type === "day") day = value;
    else if (part.type === "hour") hour = value;
    else if (part.type === "minute") minute = value;
    else if (part.type === "second") second = value;
  }

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null;
  }

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((asUtc - timestampMs) / 60000);
}
function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}
function formatLocalTimeDeltaLabel(
  deltaMinutes: number,
  template: string,
): string {
  const sign = deltaMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(deltaMinutes);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  const delta = `${sign}${hours}:${minutes}`;
  return formatI18nTemplate(template, { delta });
}
export function resolveTimezoneDisplayLabel(params: {
  value: string;
  locale: Locale;
  unknownLabel: string;
  timestampMs: number;
  timezoneDeltaVsLocal: string;
}): string {
  const normalized = normalizeDimensionLabel(params.value, params.unknownLabel);
  if (normalized === params.unknownLabel) return normalized;

  const baseTimestamp =
    Number.isFinite(params.timestampMs) && params.timestampMs > 0
      ? params.timestampMs
      : Date.now();
  const date = new Date(baseTimestamp);
  if (!Number.isFinite(date.getTime())) return normalized;

  const nameFormatter = getTimezoneNameFormatter(params.locale, normalized);
  const localizedName =
    nameFormatter
      ?.formatToParts(date)
      .find((part) => part.type === "timeZoneName")
      ?.value.trim() || null;
  const offsetMinutes = resolveTimezoneOffsetMinutes(
    normalized,
    date.getTime(),
  );

  if (!localizedName && offsetMinutes === null) return normalized;
  if (offsetMinutes !== null) {
    const localOffsetMinutes = -date.getTimezoneOffset();
    const localDelta = offsetMinutes - localOffsetMinutes;
    const prefix = localizedName || normalized;
    return `${prefix} (${formatUtcOffset(offsetMinutes)}, ${formatLocalTimeDeltaLabel(localDelta, params.timezoneDeltaVsLocal)})`;
  }
  if (localizedName) return localizedName;
  return normalized;
}
const DomainOrUrlIcon = memo(function DomainOrUrlIcon({
  label,
  unknownLabel,
}: {
  label: string;
  unknownLabel: string;
}) {
  const src = useMemo(() => {
    const normalized = label.trim();
    if (normalized.length === 0 || normalized === unknownLabel) return null;
    return resolveFaviconUrlForLabel(normalized);
  }, [label, unknownLabel]);
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
  const fallbackValue = label === unknownLabel ? "" : label;

  return (
    <AutoTransition
      type="fade"
      duration={0.18}
      initial={false}
      className="inline-flex size-4 shrink-0 items-center justify-center"
    >
      {showFavicon ? (
        <img
          key="favicon"
          src={src!}
          alt=""
          width={16}
          height={16}
          className="block size-4 shrink-0 object-contain"
        />
      ) : (
        <span
          key="fallback"
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] bg-card text-[10px] leading-none font-medium text-muted-foreground"
        >
          {leadingLabelLetter(fallbackValue)}
        </span>
      )}
    </AutoTransition>
  );
});
export const LabelWithOptionalIcon = memo(function LabelWithOptionalIcon({
  label,
  showIcon,
  unknownLabel,
}: {
  label: string;
  showIcon: boolean;
  unknownLabel: string;
}) {
  if (!showIcon) {
    return <span className="break-words">{label}</span>;
  }

  return (
    <span className="relative inline-block max-w-full break-words pl-6">
      <span className="pointer-events-none absolute inset-y-0 left-0 inline-flex w-4 items-center">
        <DomainOrUrlIcon label={label} unknownLabel={unknownLabel} />
      </span>
      <span className="break-words">{label}</span>
    </span>
  );
});
export function resolvePageCardTargetUrl(params: {
  tab: PageCardTab;
  value: string;
  unknownLabel: string;
  fallbackHostname: string;
}): string | null {
  const { tab, value, unknownLabel, fallbackHostname } = params;
  const raw = value.trim();
  if (raw.length === 0 || raw === unknownLabel) {
    return null;
  }

  if (tab === "hostname") {
    return toAbsoluteHttpsUrl(raw);
  }

  if (tab === "path" || tab === "entry" || tab === "exit") {
    if (raw.startsWith("/")) {
      const host = sanitizeHostname(fallbackHostname);
      if (host.length === 0) return null;
      try {
        return new URL(raw, `https://${host}`).toString();
      } catch {
        return null;
      }
    }
    return toAbsoluteHttpsUrl(raw);
  }

  return null;
}
