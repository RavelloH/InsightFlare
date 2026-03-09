import { resolveEdgeRuntime } from "@/lib/edge/runtime";
import { normalizeSiteSettingsKey, readSiteTrackingConfig } from "@/lib/edge/site-settings-store";
import type { IngestEnvelopePayload, SerializedRequestPayload, TrackerClientPayload } from "@/lib/edge/types";
import { jsonCloneRecord } from "@/lib/edge/utils";

const CORS_BASE_HEADERS = {
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

function sanitizeInputPayload(payload: unknown): TrackerClientPayload {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  return payload as TrackerClientPayload;
}

function pickSiteIdFromPayload(payload: TrackerClientPayload, requestUrl: URL): string {
  if (typeof payload.siteId === "string" && payload.siteId.length > 0) {
    return payload.siteId;
  }
  const fromQuery = requestUrl.searchParams.get("siteId");
  if (fromQuery && fromQuery.length > 0) {
    return fromQuery;
  }
  return "default";
}

function serializeHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

function serializeRequestPayload(request: Request, body: string): SerializedRequestPayload {
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
    return new URL(origin).hostname.trim().toLowerCase();
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
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

interface CorsDecision {
  allowRequest: boolean;
  allowOrigin: string | null;
}

async function decideCorsPolicy(
  request: Request,
  env: Awaited<ReturnType<typeof resolveEdgeRuntime>>["env"],
  siteIdInput: unknown,
): Promise<CorsDecision> {
  const origin = parseOrigin(request);
  if (!origin) {
    return {
      allowRequest: true,
      allowOrigin: null,
    };
  }

  const originHostname = parseOriginHostname(origin);
  if (!originHostname) {
    return {
      allowRequest: false,
      allowOrigin: null,
    };
  }

  const siteId = normalizeSiteSettingsKey(siteIdInput);
  if (!siteId) {
    return {
      allowRequest: true,
      allowOrigin: origin,
    };
  }

  let settings = null;
  try {
    // `readSiteTrackingConfig` already caches KV results for 1 hour.
    settings = await readSiteTrackingConfig(env, siteId);
  } catch {
    settings = null;
  }

  if (!settings) {
    return {
      allowRequest: true,
      allowOrigin: origin,
    };
  }

  const hasWhitelist = Array.isArray(settings.domainWhitelist) && settings.domainWhitelist.length > 0;
  if (!hasWhitelist) {
    return {
      allowRequest: true,
      allowOrigin: origin,
    };
  }

  const allowed = settings.allowedHostnames.some(
    (hostname) => hostname.trim().toLowerCase() === originHostname,
  );
  if (!allowed) {
    return {
      allowRequest: false,
      allowOrigin: null,
    };
  }

  return {
    allowRequest: true,
    allowOrigin: origin,
  };
}

export async function OPTIONS(request: Request): Promise<Response> {
  const { env, url } = await resolveEdgeRuntime(request);
  const siteIdFromQuery = url.searchParams.get("siteId") || "";
  const cors = await decideCorsPolicy(request, env, siteIdFromQuery);
  if (!cors.allowRequest) {
    return new Response(null, { status: 403, headers: toCorsHeaders(cors.allowOrigin) });
  }
  return new Response(null, { status: 204, headers: toCorsHeaders(cors.allowOrigin) });
}

export async function POST(request: Request): Promise<Response> {
  const { env, ctx, request: requestWithCf, url } = await resolveEdgeRuntime(request);

  const body = await requestWithCf.text();
  let payload: TrackerClientPayload = {};
  if (body) {
    try {
      payload = sanitizeInputPayload(JSON.parse(body));
    } catch {
      payload = {};
    }
  }

  const siteId = pickSiteIdFromPayload(payload, url);
  const cors = await decideCorsPolicy(requestWithCf, env, siteId);
  if (!cors.allowRequest) {
    return new Response(null, {
      status: 403,
      headers: toCorsHeaders(cors.allowOrigin),
    });
  }

  const doId = env.INGEST_DO.idFromName(siteId);
  const stub = env.INGEST_DO.get(doId);

  const envelope: IngestEnvelopePayload = {
    request: serializeRequestPayload(requestWithCf, body),
    client: payload,
  };

  ctx.waitUntil(
    stub
      .fetch("https://ingest.internal/ingest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(envelope),
      })
      .catch((error: unknown) => {
        console.error("forward_to_do_failed", error);
      }),
  );

  return new Response(null, {
    status: 204,
    headers: toCorsHeaders(cors.allowOrigin),
  });
}
