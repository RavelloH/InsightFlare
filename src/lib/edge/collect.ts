import { isBot } from "ua-parser-js/bot-detection";

import { normalizeTrackerUaClientHints } from "@/lib/edge/client-hints";
import { expandCustomEventData } from "@/lib/edge/custom-event-json";
import {
  normalizeSiteSettingsKey,
  readSiteTrackingConfig,
} from "@/lib/edge/site-settings-store";
import type { Env } from "@/lib/edge/types";
import type {
  IngestEnvelopePayload,
  IngestTracePayload,
  SerializedRequestPayload,
  TrackerClientPayload,
} from "@/lib/edge/types";
import type { TrackerPayloadKind } from "@/lib/edge/types";
import { jsonCloneRecord } from "@/lib/edge/utils";
import { assertContentSize, BODY_SIZE_LIMITS } from "@/lib/form-helpers";
import { jsonResponse } from "@/lib/response";
import type { SiteTrackingConfig } from "@/lib/site-settings";

const CORS_BASE_HEADERS = {
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

const SUPPORTED_KINDS = new Set<TrackerPayloadKind>([
  "pageview",
  "leave",
  "visibility",
  "custom_event",
  "identify",
]);

function pickSiteIdFromPayload(
  payload: TrackerClientPayload,
  requestUrl: URL,
): string {
  if (typeof payload.siteId === "string" && payload.siteId.length > 0) {
    return payload.siteId;
  }
  const fromQuery = requestUrl.searchParams.get("siteId");
  if (fromQuery && fromQuery.length > 0) {
    return fromQuery;
  }
  return "default";
}

function sanitizeInputPayload(payload: unknown): TrackerClientPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as TrackerClientPayload;
}

function coerceTrimmedString(input: unknown, maxLength: number): string {
  if (typeof input !== "string") return "";
  return input.trim().slice(0, maxLength);
}

function isSupportedKind(input: unknown): input is TrackerPayloadKind {
  return (
    typeof input === "string" &&
    SUPPORTED_KINDS.has(input as TrackerPayloadKind)
  );
}

function normalizeClientHostname(input: unknown): string {
  const value = coerceTrimmedString(input, 255)
    .toLowerCase()
    .replace(/\.+$/, "");
  if (!value || value.includes("/") || value.includes(":")) return "";
  return value;
}

function normalizePayloadPathname(input: unknown): string {
  let value = coerceTrimmedString(input, 4096);
  if (!value) value = "/";

  if (value.includes("://")) {
    try {
      value = new URL(value).pathname || "/";
    } catch {
      return "";
    }
  }

  value = value.split(/[?#]/)[0] ?? value;
  value = value.trim().replace(/\s+/g, "");
  if (!value) value = "/";
  if (!value.startsWith("/")) value = `/${value.replace(/^\/+/, "")}`;
  value = value.replace(/\/{2,}/g, "/");
  return value.slice(0, 2048);
}

function matchesBlockedPath(pathname: string, blockedPaths: string[]): boolean {
  for (const blockedPath of blockedPaths) {
    if (!blockedPath) continue;
    if (pathname === blockedPath || pathname.startsWith(`${blockedPath}/`)) {
      return true;
    }
  }
  return false;
}

function serializeHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function serializeRequestPayload(
  request: Request,
  body: string,
): SerializedRequestPayload {
  return {
    method: request.method,
    url: request.url,
    headers: serializeHeaders(request),
    cf: jsonCloneRecord((request as Request & { cf?: unknown }).cf),
    body,
    receivedAt: Date.now(),
  };
}

function parseOrigin(request: Request): string | null {
  const raw = (request.headers.get("origin") || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function parseOriginHostname(origin: string | null): string {
  if (!origin) return "";
  try {
    return new URL(origin).hostname.trim().toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

function toCorsHeaders(origin: string | null): Record<string, string> {
  if (!origin) {
    return {
      ...CORS_BASE_HEADERS,
      vary: "Origin",
    };
  }
  return {
    ...CORS_BASE_HEADERS,
    "access-control-allow-origin": origin,
    vary: "Origin",
  };
}

function isBotRequest(request: Request): boolean {
  const ua = request.headers.get("user-agent") || "";
  if (!ua || !isBot(ua)) return false;
  console.log(`[Bot] UA: ${ua}`);
  return true;
}

type CollectionDecision =
  | {
      shouldForward: false;
      allowOrigin: string | null;
      siteId: string;
      payload: null;
      reason: string;
      detail?: Record<string, unknown>;
    }
  | {
      shouldForward: true;
      allowOrigin: string | null;
      siteId: string;
      payload: TrackerClientPayload;
    };

async function decideCollectionPolicy(
  request: Request,
  env: Env,
  payload: TrackerClientPayload | null,
  requestUrl: URL,
): Promise<CollectionDecision> {
  const origin = parseOrigin(request);
  const originHostname = parseOriginHostname(origin);
  if (!payload) {
    return {
      shouldForward: false,
      allowOrigin: origin,
      siteId: "",
      payload: null,
      reason: "missing_payload",
    };
  }

  const kind = payload.kind;
  if (!isSupportedKind(kind)) {
    return {
      shouldForward: false,
      allowOrigin: origin,
      siteId: "",
      payload: null,
      reason: "unsupported_kind",
      detail: { kind: String(kind || "") },
    };
  }

  const siteId = normalizeSiteSettingsKey(
    pickSiteIdFromPayload(payload, requestUrl),
  );
  if (!siteId) {
    return {
      shouldForward: false,
      allowOrigin: origin,
      siteId: "",
      payload: null,
      reason: "missing_site_id",
    };
  }

  let settings = null;
  try {
    // `readSiteTrackingConfig` already caches KV results for 1 hour.
    settings = await readSiteTrackingConfig(env, siteId);
  } catch (error) {
    logIngestTrace("collect_settings_read_failed", {
      siteId,
      error: errorToMessage(error),
    });
    settings = null;
  }

  if (!settings?.siteDomain) {
    return {
      shouldForward: false,
      allowOrigin: origin,
      siteId,
      payload: null,
      reason: "missing_site_settings",
    };
  }

  const hasWhitelist =
    Array.isArray(settings.domainWhitelist) &&
    settings.domainWhitelist.length > 0;
  if (
    hasWhitelist &&
    !settings.allowedHostnames.some(
      (hostname) => hostname.trim().toLowerCase() === originHostname,
    )
  ) {
    return {
      shouldForward: false,
      allowOrigin: origin,
      siteId,
      payload: null,
      reason: "origin_not_allowed",
      detail: {
        origin,
        originHostname,
        allowedHostnames: settings.allowedHostnames,
      },
    };
  }

  const normalizedPayloadResult = normalizeForwardPayload(
    payload,
    siteId,
    kind,
    settings,
  );
  if (!normalizedPayloadResult.payload) {
    return {
      shouldForward: false,
      allowOrigin: origin,
      siteId,
      payload: null,
      reason: normalizedPayloadResult.reason,
      detail: normalizedPayloadResult.detail,
    };
  }

  return {
    shouldForward: true,
    allowOrigin: origin,
    siteId,
    payload: normalizedPayloadResult.payload,
  };
}

function normalizeForwardPayload(
  payload: TrackerClientPayload,
  siteId: string,
  kind: TrackerPayloadKind,
  settings: SiteTrackingConfig,
): {
  payload: TrackerClientPayload | null;
  reason: string;
  detail?: Record<string, unknown>;
} {
  const visitId = coerceTrimmedString(payload.visitId, 128);
  if (!visitId) return { payload: null, reason: "missing_visit_id" };

  const normalizedPayload: TrackerClientPayload = {
    ...payload,
    siteId,
    kind,
    visitId,
  };
  const uaClientHints = normalizeTrackerUaClientHints(payload.uaClientHints);
  if (uaClientHints) {
    normalizedPayload.uaClientHints = uaClientHints;
  } else {
    delete normalizedPayload.uaClientHints;
  }

  const canCheckPath =
    kind === "pageview" ||
    kind === "custom_event" ||
    kind === "visibility" ||
    (kind === "leave" &&
      coerceTrimmedString(payload.pathname, 4096).length > 0);

  if (canCheckPath) {
    const pathname = normalizePayloadPathname(payload.pathname);
    if (!pathname) {
      return {
        payload: null,
        reason: "invalid_pathname",
        detail: { pathname: String(payload.pathname || "") },
      };
    }
    if (matchesBlockedPath(pathname, settings.pathBlacklist)) {
      return {
        payload: null,
        reason: "blocked_pathname",
        detail: { pathname },
      };
    }
    normalizedPayload.pathname = pathname;
  }

  if (kind === "pageview") {
    const hostname = normalizeClientHostname(payload.hostname);
    if (!hostname) {
      return {
        payload: null,
        reason: "missing_hostname",
        detail: { hostname: String(payload.hostname || "") },
      };
    }
    normalizedPayload.hostname = hostname;
  }

  if (kind === "custom_event") {
    const eventName = coerceTrimmedString(payload.eventName, 120);
    if (!eventName) return { payload: null, reason: "missing_event_name" };
    normalizedPayload.eventName = eventName;
  }

  if (kind === "visibility") {
    const visibilityState = coerceTrimmedString(payload.visibilityState, 20);
    if (visibilityState !== "hidden" && visibilityState !== "visible") {
      return {
        payload: null,
        reason: "invalid_visibility_state",
        detail: { visibilityState },
      };
    }
    normalizedPayload.visibilityState = visibilityState;
  }

  return { payload: normalizedPayload, reason: "" };
}

function createTraceId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function errorToMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

function logIngestTrace(
  event: string,
  fields: Record<string, unknown> = {},
  level: "info" | "warn" | "error" = "info",
): void {
  const payload = {
    event,
    at: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function compactPayloadForLog(
  payload: TrackerClientPayload | null,
): Record<string, unknown> {
  if (!payload) return {};
  return {
    kind: payload.kind || "",
    siteId: payload.siteId || "",
    visitId: payload.visitId || "",
    previousVisitId: payload.previousVisitId || "",
    eventId: payload.eventId || "",
    eventName: payload.eventName || "",
    visibilityState: payload.visibilityState || "",
    pathname: payload.pathname || "",
    hostname: payload.hostname || "",
    timestamp: payload.timestamp ?? null,
  };
}

function noContent(origin: string | null): Response {
  return new Response(null, { status: 204, headers: toCorsHeaders(origin) });
}

function jsonError(
  origin: string | null,
  message: string,
  status: 400 | 413 | 422 = 400,
): Response {
  return jsonResponse(
    { ok: false, error: message },
    status,
    toCorsHeaders(origin),
  );
}

export async function handleCollectOptionsRequest(
  request: Request,
): Promise<Response> {
  return noContent(parseOrigin(request));
}

export async function handleCollectRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url = new URL(request.url),
): Promise<Response> {
  // Body 大小限制检查
  const sizeError = assertContentSize(request, BODY_SIZE_LIMITS.COLLECT);
  if (sizeError) return sizeError;

  const requestWithCf = request;
  const origin = parseOrigin(requestWithCf);
  const trace: IngestTracePayload = {
    id: createTraceId(),
    source: "collect",
    acceptedAt: Date.now(),
  };

  if (isBotRequest(requestWithCf)) {
    logIngestTrace("collect_rejected", {
      traceId: trace.id,
      reason: "bot",
      origin,
      userAgent: requestWithCf.headers.get("user-agent") || "",
    });
    return noContent(origin);
  }

  const body = await requestWithCf.text();
  let payload: TrackerClientPayload | null = null;
  if (body) {
    try {
      payload = sanitizeInputPayload(JSON.parse(body));
    } catch (error) {
      logIngestTrace(
        "collect_rejected",
        {
          traceId: trace.id,
          reason: "invalid_json",
          origin,
          bodyBytes: body.length,
          error: errorToMessage(error),
        },
        "warn",
      );
      return jsonError(origin, "Invalid JSON payload", 400);
    }
  }

  if (payload?.kind === "custom_event") {
    const eventDataResult = expandCustomEventData(payload.eventData);
    if (!eventDataResult.ok) {
      logIngestTrace(
        "collect_rejected",
        {
          traceId: trace.id,
          reason: "invalid_custom_event_data",
          ...compactPayloadForLog(payload),
          error: eventDataResult.error,
        },
        "warn",
      );
      return jsonError(origin, eventDataResult.error, eventDataResult.status);
    }
  }

  const decision = await decideCollectionPolicy(
    requestWithCf,
    env,
    payload,
    url,
  );
  if (!decision.shouldForward) {
    logIngestTrace("collect_rejected", {
      traceId: trace.id,
      reason: decision.reason,
      origin,
      siteId: decision.siteId,
      ...compactPayloadForLog(payload),
      ...(decision.detail || {}),
    });
    return noContent(decision.allowOrigin);
  }

  const doId = env.INGEST_DO.idFromName(decision.siteId);
  const stub = env.INGEST_DO.get(doId);

  const envelope: IngestEnvelopePayload = {
    request: serializeRequestPayload(requestWithCf, body),
    client: decision.payload,
    trace,
  };

  logIngestTrace("collect_forward_queued", {
    traceId: trace.id,
    origin,
    ...compactPayloadForLog(decision.payload),
  });

  ctx.waitUntil(
    stub
      .fetch("https://ingest.internal/ingest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(envelope),
      })
      .then(async (response) => {
        const bodyText = await response.text().catch(() => "");
        logIngestTrace(
          response.ok ? "collect_forward_result" : "collect_forward_failed",
          {
            traceId: trace.id,
            siteId: decision.siteId,
            kind: decision.payload.kind || "",
            visitId: decision.payload.visitId || "",
            status: response.status,
            response: bodyText.slice(0, 200),
          },
          response.ok ? "info" : "error",
        );
      })
      .catch((error: unknown) => {
        logIngestTrace(
          "collect_forward_failed",
          {
            traceId: trace.id,
            siteId: decision.siteId,
            kind: decision.payload.kind || "",
            visitId: decision.payload.visitId || "",
            error: errorToMessage(error),
          },
          "error",
        );
      }),
  );

  return noContent(decision.allowOrigin);
}
