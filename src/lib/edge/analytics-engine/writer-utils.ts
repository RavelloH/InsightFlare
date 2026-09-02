import type { TrackerClientPayload } from "@/lib/edge/types";

export const MAX_REQUEST_METADATA_JSON_LENGTH = 8192 as const;

const MAX_SAFE_JSON_DEPTH = 8;
const MAX_SAFE_JSON_ENTRIES = 64;
const MAX_SAFE_JSON_STRING_LENGTH = 2_048;

export type RequestCfMetadata = Record<string, unknown>;

export function requestCf(request: Request): RequestCfMetadata {
  return ((request as Request & { cf?: RequestCfMetadata }).cf ??
    {}) as RequestCfMetadata;
}

export function clampString(input: string, maxLength: number): string {
  return input.length <= maxLength ? input : input.slice(0, maxLength);
}

export function stringValue(input: unknown, maxLength: number): string {
  return typeof input === "string" ? clampString(input.trim(), maxLength) : "";
}

export function finiteNumber(input: unknown): number | null {
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : null;
  }
  if (typeof input === "string" && input.trim()) {
    const value = Number(input);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

export function nonNegativeNumber(input: unknown): number | null {
  const value = finiteNumber(input);
  return value !== null && value >= 0 ? value : null;
}

export function requestHeader(
  request: Request,
  name: string,
  maxLength: number,
): string {
  return stringValue(request.headers.get(name), maxLength);
}

export function requestIp(request: Request): string {
  const cfIp = requestHeader(request, "cf-connecting-ip", 80);
  if (cfIp) return cfIp;
  return (
    requestHeader(request, "x-forwarded-for", 255).split(",", 1)[0]?.trim() ??
    ""
  );
}

export function payloadHostname(payload: TrackerClientPayload): string {
  return clampString(stringValue(payload.hostname, 255).toLowerCase(), 255);
}

export function payloadPathname(payload: TrackerClientPayload): string {
  const rawPathname = stringValue(payload.pathname, 4096);
  if (!rawPathname) return "";
  if (rawPathname.includes("://")) {
    try {
      return clampString(new URL(rawPathname).pathname || "/", 2_048);
    } catch {
      return "";
    }
  }
  return clampString(rawPathname.split(/[?#]/, 1)[0] ?? rawPathname, 2_048);
}

export function requestPathname(request: Request): string {
  try {
    return clampString(new URL(request.url).pathname, 2_048);
  } catch {
    return "";
  }
}

export function requestOrigin(input: string | null): string {
  return stringValue(input, 2_048);
}

export function cfString(
  cf: RequestCfMetadata,
  key: string,
  maxLength: number,
): string {
  return stringValue(cf[key], maxLength);
}

export function cfBotManagement(
  cf: RequestCfMetadata,
): Record<string, unknown> | null {
  const value = cf.botManagement;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function cfBotScore(cf: RequestCfMetadata): number | null {
  return nonNegativeNumber(cfBotManagement(cf)?.score);
}

export function cfCoordinates(
  cf: RequestCfMetadata,
): { latitude: number; longitude: number } | null {
  const latitude = finiteNumber(cf.latitude);
  const longitude = finiteNumber(cf.longitude);
  if (
    latitude === null ||
    longitude === null ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

export function cfAsn(cf: RequestCfMetadata): number {
  const asn = nonNegativeNumber(cf.asn);
  return asn === null ? 0 : Math.trunc(asn);
}

export function resolveEventAt(
  payload: TrackerClientPayload,
  receivedAt: number,
): { value: number; present: boolean } {
  const candidates =
    payload.kind === "pageview"
      ? [payload.startedAt, payload.timestamp]
      : [payload.timestamp, payload.startedAt];
  for (const candidate of candidates) {
    const value = finiteNumber(candidate);
    if (value !== null && value > 0) return { value, present: true };
  }
  return { value: receivedAt, present: false };
}

export function resolveEdgeLatency(
  receivedAt: number,
  now = Date.now(),
): { value: number; present: boolean } {
  if (!Number.isFinite(receivedAt) || !Number.isFinite(now)) {
    return { value: 0, present: false };
  }
  return { value: Math.max(0, now - receivedAt), present: true };
}

interface SafeJsonOptions {
  depth: number;
  entries: number;
  stringLength: number;
}

function safeJsonValue(
  value: unknown,
  seen: WeakSet<object>,
  options: SafeJsonOptions,
): unknown {
  if (value === null) return null;
  if (typeof value === "string") {
    return clampString(value, options.stringLength);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return null;
  if (options.depth >= MAX_SAFE_JSON_DEPTH) return "[MaxDepth]";
  if (seen.has(value)) return "[Circular]";

  seen.add(value);
  try {
    const nextOptions = {
      ...options,
      depth: options.depth + 1,
    };
    if (Array.isArray(value)) {
      return value
        .slice(0, options.entries)
        .map((item) => safeJsonValue(item, seen, nextOptions));
    }

    const result: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(value)) {
      if (count >= options.entries) break;
      try {
        result[clampString(key, 128)] = safeJsonValue(
          (value as Record<string, unknown>)[key],
          seen,
          nextOptions,
        );
        count += 1;
      } catch {
        result[clampString(key, 128)] = "[Unserializable]";
        count += 1;
      }
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function stringifySafeValue(value: unknown, options: SafeJsonOptions): string {
  try {
    return (
      JSON.stringify(safeJsonValue(value, new WeakSet<object>(), options)) ??
      "{}"
    );
  } catch {
    return "{}";
  }
}

/**
 * Serialize metadata without allowing cycles, hostile objects, or a large
 * Cloudflare metadata object to break a best-effort Analytics Engine write.
 */
export function safeStringify(
  value: unknown,
  maxLength = MAX_REQUEST_METADATA_JSON_LENGTH,
): string {
  if (!Number.isFinite(maxLength) || maxLength < 2) return "{}";
  const limit = Math.floor(maxLength);
  const attempts = [
    {
      stringLength: MAX_SAFE_JSON_STRING_LENGTH,
      entries: MAX_SAFE_JSON_ENTRIES,
    },
    { stringLength: 512, entries: 48 },
    { stringLength: 128, entries: 32 },
    { stringLength: 32, entries: 16 },
    { stringLength: 0, entries: 8 },
  ];
  for (const attempt of attempts) {
    const serialized = stringifySafeValue(value, {
      depth: 0,
      entries: attempt.entries,
      stringLength: attempt.stringLength,
    });
    if (serialized.length <= limit) return serialized;
  }
  return "{}";
}

export const safeJson = safeStringify;

export function requestMetadata(
  request: Request,
  payload: TrackerClientPayload,
  cf: RequestCfMetadata,
): Record<string, unknown> {
  const requestPriority =
    cfString(cf, "requestPriority", 160) ||
    requestHeader(request, "priority", 160);
  return {
    requestUrl: clampString(request.url, 4_096),
    requestPathname: requestPathname(request),
    referer: requestHeader(request, "referer", 2_048),
    secFetchSite: requestHeader(request, "sec-fetch-site", 40),
    secFetchMode: requestHeader(request, "sec-fetch-mode", 40),
    secFetchDest: requestHeader(request, "sec-fetch-dest", 40),
    tlsVersion: cfString(cf, "tlsVersion", 40),
    tlsCipher: cfString(cf, "tlsCipher", 120),
    tlsClientExtensionsSha1: cfString(cf, "tlsClientExtensionsSha1", 160),
    requestPriority,
    botManagement: cfBotManagement(cf),
    eventId: stringValue(payload.eventId, 128),
    visitId: stringValue(payload.visitId, 128),
    previousVisitId: stringValue(payload.previousVisitId, 128),
    visibilityState: stringValue(payload.visibilityState, 20),
    eventName: stringValue(payload.eventName, 120),
    requestMethod: clampString(request.method, 16),
    httpProtocol: cfString(cf, "httpProtocol", 40),
    tlsClientHelloLength: nonNegativeNumber(cf.tlsClientHelloLength),
    clientTcpRtt: nonNegativeNumber(cf.clientTcpRtt),
    clientQuicRtt: nonNegativeNumber(cf.clientQuicRtt),
  };
}
