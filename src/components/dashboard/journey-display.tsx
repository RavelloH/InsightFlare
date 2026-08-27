import {
  type ComponentType,
  memo,
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useState,
} from "react";
import { Icon } from "@iconify/react";
import {
  RiCellphoneLine,
  RiComputerLine,
  RiDeviceLine,
  RiGlobalLine,
  RiTabletLine,
} from "@remixicon/react";
import Avatar from "boring-avatars";

import {
  LazyGeoCityBreadcrumbLabel,
  LazyGeoRegionBreadcrumbLabel,
} from "@/components/dashboard/lazy-geo-location-label";
import {
  durationFormat,
  intlLocale,
  shortDateTime,
} from "@/lib/dashboard/format";
import { parseGeoLocationValue } from "@/lib/dashboard/geo-location";
import { normalizeGeoDisplayLabel } from "@/lib/dashboard/geo-translation";
import { decodeUrlDisplayValue } from "@/lib/dashboard/url-display";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

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
const RELATIVE_TIME_FORMATTERS = new Map<string, Intl.RelativeTimeFormat>();

function getRelativeTimeFormatter(locale: Locale): Intl.RelativeTimeFormat {
  const key = intlLocale(locale);
  const cached = RELATIVE_TIME_FORMATTERS.get(key);
  if (cached) return cached;

  const formatter = new Intl.RelativeTimeFormat(key, { numeric: "auto" });
  RELATIVE_TIME_FORMATTERS.set(key, formatter);
  return formatter;
}

export type DeviceTypeIcon = ComponentType<{ className?: string }>;

export function resolveDeviceTypeMeta(
  deviceType: string,
  deviceLabels: { desktop: string; mobile: string; tablet: string },
  unknownLabel: string,
  missingLabel = unknownLabel,
): { label: string; Icon: DeviceTypeIcon } {
  const normalized = deviceType.trim();
  const lowered = normalized.toLocaleLowerCase();
  const isMissing = normalized.length === 0;
  const isUnknown =
    lowered === "unknown" || lowered === "undefined" || lowered === "null";
  const isTablet = lowered.includes("tablet");
  const isMobile =
    lowered.includes("mobile") ||
    lowered.includes("phone") ||
    lowered.includes("cellphone");
  const isDesktop =
    lowered.includes("desktop") ||
    lowered.includes("computer") ||
    lowered === "pc";
  const Icon = isTablet
    ? RiTabletLine
    : isMobile
      ? RiCellphoneLine
      : isDesktop
        ? RiComputerLine
        : RiDeviceLine;
  const label = isMissing
    ? missingLabel
    : isUnknown
      ? unknownLabel
      : isTablet
        ? deviceLabels.tablet
        : isMobile
          ? deviceLabels.mobile
          : isDesktop
            ? deviceLabels.desktop
            : normalized;

  return { label, Icon };
}

export const VisitorAvatar = memo(function VisitorAvatar({
  seed,
  className,
}: {
  seed: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex size-[34px] shrink-0 items-center justify-center overflow-hidden rounded-full",
        className,
      )}
    >
      <Avatar
        size="100%"
        name={seed || "anonymous"}
        variant="ring"
        colors={VISITOR_AVATAR_COLORS}
        className="block size-full"
        aria-hidden="true"
      />
    </span>
  );
});

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
  className,
}: {
  src: string;
  fallbackSrc: string;
  invertInDark?: boolean;
  className?: string;
}) {
  return (
    <img
      src={src}
      alt=""
      width={16}
      height={16}
      className={cn(
        "block size-4 shrink-0 object-contain",
        invertInDark && "dark:invert",
        className,
      )}
      loading="lazy"
      decoding="async"
      onError={(event) => {
        handleImageFallback(event, fallbackSrc);
      }}
    />
  );
}

function resolveBrowserIconKey(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return UNKNOWN_ICON_KEY;
  if (
    normalized.includes("android webview") ||
    normalized.includes("android-webview")
  )
    return "android-webview";
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
  )
    return "qq";
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
  )
    return "mac-os";
  if (normalized.startsWith("ios")) return "ios";
  if (normalized.startsWith("android")) return "android-os";
  if (
    normalized.startsWith("chrome os") ||
    normalized.startsWith("chromium os")
  )
    return "chrome-os";
  if (
    normalized.includes("linux") ||
    normalized.startsWith("ubuntu") ||
    normalized.startsWith("debian") ||
    normalized.startsWith("fedora")
  )
    return "linux";
  return UNKNOWN_ICON_KEY;
}

function browserLabel(browser: string, version?: string | null): string {
  const base = browser.trim();
  const suffix = String(version || "").trim();
  return suffix && !base.includes(suffix) ? `${base} ${suffix}` : base;
}

function osLabel(os: string, version?: string | null): string {
  const base = os.trim();
  const suffix = String(version || "").trim();
  if (!base) return suffix;
  if (!suffix || base.includes(suffix)) return base;
  if (suffix.toLocaleLowerCase().startsWith(base.toLocaleLowerCase())) {
    return suffix;
  }
  return `${base} ${suffix}`;
}

export const BrowserMeta = memo(function BrowserMeta({
  browser,
  version,
  unknownLabel,
  missingLabel = unknownLabel,
  className,
}: {
  browser: string;
  version?: string | null;
  unknownLabel: string;
  missingLabel?: string;
  className?: string;
}) {
  const normalizedBrowser = browser.trim().toLocaleLowerCase();
  const isUnknown = ["unknown", "undefined", "null"].includes(
    normalizedBrowser,
  );
  const label = isUnknown
    ? unknownLabel
    : browserLabel(browser, version) || missingLabel;
  const iconKey = resolveBrowserIconKey(label);
  return (
    <InlineMeta
      icon={
        <LogoIcon
          src={`${BROWSER_ICON_DIR}/${iconKey}.svg`}
          fallbackSrc={`${BROWSER_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
          invertInDark={BROWSER_APPLE_ICON_KEYS.has(iconKey)}
        />
      }
      label={label}
      className={className}
    />
  );
});

export const OsMeta = memo(function OsMeta({
  os,
  version,
  unknownLabel,
  missingLabel = unknownLabel,
  className,
}: {
  os: string;
  version?: string | null;
  unknownLabel: string;
  missingLabel?: string;
  className?: string;
}) {
  const normalizedOs = os.trim().toLocaleLowerCase();
  const isUnknown = ["unknown", "undefined", "null"].includes(normalizedOs);
  const label = isUnknown ? unknownLabel : osLabel(os, version) || missingLabel;
  const iconKey = resolveOsIconKey(label);
  return (
    <InlineMeta
      icon={
        <LogoIcon
          src={`${OS_ICON_DIR}/${iconKey}.svg`}
          fallbackSrc={`${OS_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
          invertInDark={OS_APPLE_ICON_KEYS.has(iconKey)}
        />
      }
      label={label}
      className={className}
    />
  );
});

export const DeviceMeta = memo(function DeviceMeta({
  deviceType,
  deviceLabels,
  unknownLabel,
  missingLabel = unknownLabel,
  className,
}: {
  deviceType: string;
  deviceLabels: { desktop: string; mobile: string; tablet: string };
  unknownLabel: string;
  missingLabel?: string;
  className?: string;
}) {
  const { Icon: DeviceIcon, label } = resolveDeviceTypeMeta(
    deviceType,
    deviceLabels,
    unknownLabel,
    missingLabel,
  );
  return (
    <InlineMeta
      icon={<DeviceIcon className="size-4 text-muted-foreground" />}
      label={label}
      className={className}
    />
  );
});

export const LocationMeta = memo(function LocationMeta({
  locale,
  messages,
  country,
  city,
  region,
  className,
}: {
  locale: Locale;
  messages: AppMessages;
  country: string;
  city?: string | null;
  region?: string | null;
  className?: string;
}) {
  const resolved = resolveCountryLabel(
    country || "",
    locale,
    messages.common.unknown,
  );
  const flagCode = resolveCountryFlagCode(resolved.code, locale);
  const locality = String(city || region || "").trim();
  const label = locality
    ? `${locality}${resolved.label !== messages.common.unknown ? `, ${resolved.label}` : ""}`
    : resolved.label;
  return (
    <InlineMeta
      icon={
        flagCode ? (
          <Icon
            icon={`flagpack:${flagCode.toLowerCase()}`}
            style={{ width: 16, height: 12 }}
            className="block shrink-0"
          />
        ) : (
          <RiGlobalLine className="size-4 text-muted-foreground" />
        )
      }
      label={label}
      className={className}
    />
  );
});

function resolveCountryRegionBreadcrumbData({
  locale,
  unknownLabel,
  missingLabel,
  country,
  region,
  regionCode,
  city,
}: {
  locale: Locale;
  unknownLabel: string;
  missingLabel: string;
  country: string;
  region?: string | null;
  regionCode?: string | null;
  city?: string | null;
}) {
  const parsedRegion = parseGeoLocationValue(region || "");
  const countryValue = parsedRegion?.countryCode || country.trim() || "";
  const resolved = resolveCountryLabel(
    countryValue,
    locale,
    countryValue ? unknownLabel : missingLabel,
  );
  const flagCode = resolveCountryFlagCode(resolved.code, locale);
  const countryIconName = flagCode
    ? `flagpack:${flagCode.toLowerCase()}`
    : null;
  const countryCode = (
    parsedRegion?.countryCode ||
    resolved.code ||
    countryValue
  )
    .trim()
    .toUpperCase();
  const stateCode = (regionCode || parsedRegion?.regionCode || "")
    .trim()
    .toUpperCase();
  const rawRegionLabel =
    parsedRegion?.regionName ||
    (parsedRegion?.level === "locality" ? parsedRegion.localityName : "") ||
    String(region || "").trim();
  const regionLabel = normalizeGeoDisplayLabel(
    rawRegionLabel,
    rawRegionLabel ? unknownLabel : missingLabel,
  );
  const rawCityLabel =
    String(city || "").trim() ||
    (parsedRegion?.level === "locality"
      ? (parsedRegion.localityName ?? "")
      : "");
  const parsedCity = parseGeoLocationValue(rawCityLabel);
  const cityDisplayLabel =
    parsedCity?.localityName || parsedCity?.regionName || rawCityLabel;
  const cityLabel = normalizeGeoDisplayLabel(
    cityDisplayLabel,
    cityDisplayLabel ? unknownLabel : missingLabel,
  );
  const hideRegion = !String(stateCode || rawRegionLabel).trim();
  const hideCity = !cityDisplayLabel;

  return {
    countryLabel: resolved.label,
    countryIconName,
    regionLabel,
    countryCode,
    stateCode,
    hideRegion,
    cityLabel,
    cityNameDefault: cityDisplayLabel,
    hideCity,
  };
}

export const CountryRegionMeta = memo(function CountryRegionMeta({
  locale,
  messages,
  country,
  region,
  regionCode,
  city,
  missingLabel = messages.common.unknown,
  className,
}: {
  locale: Locale;
  messages: AppMessages;
  country: string;
  region?: string | null;
  regionCode?: string | null;
  city?: string | null;
  missingLabel?: string;
  className?: string;
}) {
  const breadcrumb = resolveCountryRegionBreadcrumbData({
    locale,
    unknownLabel: messages.common.unknown,
    missingLabel,
    country,
    region,
    regionCode,
    city,
  });

  return (
    <span className={cn("block max-w-full", className)}>
      {breadcrumb.hideCity ? (
        <LazyGeoRegionBreadcrumbLabel
          locale={locale}
          countryLabel={breadcrumb.countryLabel}
          countryIconName={breadcrumb.countryIconName}
          regionLabel={breadcrumb.regionLabel}
          countryCode={breadcrumb.countryCode}
          stateCode={breadcrumb.stateCode}
          hideRegion={breadcrumb.hideRegion}
        />
      ) : (
        <LazyGeoCityBreadcrumbLabel
          locale={locale}
          countryLabel={breadcrumb.countryLabel}
          countryIconName={breadcrumb.countryIconName}
          regionLabel={breadcrumb.regionLabel}
          cityLabel={breadcrumb.cityLabel}
          cityNameDefault={breadcrumb.cityNameDefault}
          countryCode={breadcrumb.countryCode}
          stateCode={breadcrumb.stateCode}
          hideRegion={breadcrumb.hideRegion}
          hideCity={breadcrumb.hideCity}
        />
      )}
    </span>
  );
});

function sanitizeHostname(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z\d+\-.]*:\/\//i, "")
    .replace(/\/+.*$/, "");
}

function faviconUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.startsWith("/")) return null;
  try {
    if (ABSOLUTE_URL_PATTERN.test(raw))
      return `${new URL(raw).origin}/favicon.ico`;
    if (raw.startsWith("//"))
      return `${new URL(`https:${raw}`).origin}/favicon.ico`;
    const hostname = sanitizeHostname(raw);
    return hostname
      ? `${new URL(`https://${hostname}`).origin}/favicon.ico`
      : null;
  } catch {
    return null;
  }
}

export const ReferrerMeta = memo(function ReferrerMeta({
  referrerHost,
  referrerUrl,
  directLabel,
  className,
}: {
  referrerHost: string;
  referrerUrl?: string | null;
  directLabel: string;
  className?: string;
}) {
  const label =
    referrerHost.trim() || String(referrerUrl || "").trim() || directLabel;
  const src = label === directLabel ? null : faviconUrl(label);
  return (
    <InlineMeta
      icon={<ReferrerIcon src={src} label={label} directLabel={directLabel} />}
      label={label}
      className={className}
    />
  );
});

function ReferrerIcon({
  src,
  label,
  directLabel,
}: {
  src: string | null;
  label: string;
  directLabel: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    if (!src) return;
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (active) setLoaded(true);
    };
    image.onerror = () => {
      if (active) setFailed(true);
    };
    image.src = src;
    return () => {
      active = false;
    };
  }, [src]);

  if (src && loaded && !failed) {
    return (
      <img
        src={src}
        alt=""
        width={16}
        height={16}
        className="block size-4 shrink-0 object-contain"
        loading="lazy"
        decoding="async"
      />
    );
  }

  return (
    <span className="inline-flex size-4 items-center justify-center rounded-[2px] bg-muted text-[10px] text-muted-foreground">
      {label === directLabel ? "/" : label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export const InlineMeta = memo(function InlineMeta({
  icon,
  label,
  className,
}: {
  icon: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-h-5 min-w-0 max-w-full items-center gap-1.5 align-middle leading-5",
        className,
      )}
      title={label}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center self-center [&>svg]:block">
        {icon}
      </span>
      <span className="truncate leading-5">{label}</span>
    </span>
  );
});

export function formatRelativeTime(
  locale: Locale,
  timestamp: number,
  now: number,
): string {
  const formatter = getRelativeTimeFormatter(locale);
  const diffSeconds = Math.round((timestamp - now) / 1000);
  const absoluteSeconds = Math.abs(diffSeconds);
  if (absoluteSeconds < 60) return formatter.format(diffSeconds, "second");
  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60)
    return formatter.format(diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return formatter.format(diffHours, "hour");
  return formatter.format(Math.round(diffHours / 24), "day");
}

export function formatShortDateTime(
  locale: Locale,
  timestamp: number,
  timeZone?: string,
): string {
  return shortDateTime(locale, timestamp, timeZone);
}

export function formatDuration(locale: Locale, durationMs: number): string {
  return durationFormat(locale, durationMs);
}

export function formatPath(pathname: string): string {
  return decodeUrlDisplayValue(pathname.trim() || "/");
}

export function formatPathWithHash(
  pathname: string,
  hash: string | null | undefined,
): string {
  const path = formatPath(pathname);
  const trimmedHash = (hash ?? "").trim();
  if (!trimmedHash) return path;
  const normalized = trimmedHash.startsWith("#")
    ? trimmedHash
    : `#${trimmedHash}`;
  return `${path}${decodeUrlDisplayValue(normalized)}`;
}

export function formatScreen(
  screenWidth: number | null | undefined,
  screenHeight: number | null | undefined,
): string {
  if (!screenWidth || !screenHeight) return "/";
  return `${Math.trunc(screenWidth)}x${Math.trunc(screenHeight)}`;
}
