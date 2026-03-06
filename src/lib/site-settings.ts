export type TrackingStrength = "strong" | "smart" | "weak";

export interface SiteScriptSettings {
  trackingStrength: TrackingStrength;
  trackQueryParams: boolean;
  trackHash: boolean;
  domainWhitelist: string[];
  pathBlacklist: string[];
  ignoreDoNotTrack: boolean;
}

export const DEFAULT_SITE_SCRIPT_SETTINGS: SiteScriptSettings = {
  trackingStrength: "smart",
  trackQueryParams: true,
  trackHash: true,
  domainWhitelist: [],
  pathBlacklist: [],
  ignoreDoNotTrack: true,
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const MAX_LIST_ITEMS = 200;
const MAX_LIST_ITEM_LENGTH = 255;

function normalizeBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
  }
  return fallback;
}

function normalizeTrackingStrength(input: unknown): TrackingStrength {
  const normalized = String(input ?? "").trim().toLowerCase();
  if (normalized === "strong") return "strong";
  if (normalized === "weak") return "weak";
  return "smart";
}

function splitListInput(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0);
  }
  if (typeof input === "string") {
    return input
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function uniqueNonEmpty(values: string[]): string[] {
  const deduped = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (deduped.has(value)) continue;
    deduped.add(value);
    out.push(value);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

function sanitizeDomainEntry(input: string): string {
  let value = input.trim().toLowerCase();
  if (!value) return "";

  if (value.includes("://")) {
    try {
      value = new URL(value).hostname.toLowerCase();
    } catch {
      return "";
    }
  } else {
    value = value.split("/")[0] ?? value;
  }

  value = value.replace(/^\.+|\.+$/g, "");
  if (!value) return "";
  if (value.includes("*")) return "";
  if (value.length > MAX_LIST_ITEM_LENGTH) return "";
  if (!/^[a-z0-9.-]+$/.test(value)) return "";
  if (!/[a-z0-9]/.test(value)) return "";
  return value;
}

function sanitizePathEntry(input: string): string {
  let value = input.trim();
  if (!value) return "";

  if (value.includes("://")) {
    try {
      value = new URL(value).pathname || "/";
    } catch {
      return "";
    }
  }

  value = value.split(/[?#]/)[0] ?? value;
  value = value.trim().replace(/\s+/g, "");
  if (!value) return "";
  if (!value.startsWith("/")) value = `/${value.replace(/^\/+/, "")}`;
  value = value.replace(/\/{2,}/g, "/");

  if (value.length > MAX_LIST_ITEM_LENGTH) return "";
  if (!/^\/[A-Za-z0-9\-._~%!$&'()+,;=:@/]*$/.test(value)) return "";
  return value;
}

export function parseDomainWhitelist(input: unknown): string[] {
  return uniqueNonEmpty(
    splitListInput(input)
      .map(sanitizeDomainEntry)
      .filter((item) => item.length > 0),
  );
}

export function parsePathBlacklist(input: unknown): string[] {
  return uniqueNonEmpty(
    splitListInput(input)
      .map(sanitizePathEntry)
      .filter((item) => item.length > 0),
  );
}

export function formatListInput(values: string[]): string {
  return values.join("\n");
}

export function normalizeSiteScriptSettings(input: unknown): SiteScriptSettings {
  const source =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const nestedTracking =
    source.tracking && typeof source.tracking === "object"
      ? (source.tracking as Record<string, unknown>)
      : {};
  const record = { ...source, ...nestedTracking };

  return {
    trackingStrength: normalizeTrackingStrength(
      record.trackingStrength ?? record.trackingMode,
    ),
    trackQueryParams: normalizeBoolean(
      record.trackQueryParams,
      DEFAULT_SITE_SCRIPT_SETTINGS.trackQueryParams,
    ),
    trackHash: normalizeBoolean(
      record.trackHash,
      DEFAULT_SITE_SCRIPT_SETTINGS.trackHash,
    ),
    domainWhitelist: parseDomainWhitelist(record.domainWhitelist),
    pathBlacklist: parsePathBlacklist(record.pathBlacklist),
    ignoreDoNotTrack: normalizeBoolean(
      record.ignoreDoNotTrack ?? record.ignoreDnt,
      DEFAULT_SITE_SCRIPT_SETTINGS.ignoreDoNotTrack,
    ),
  };
}
