import type { Env, IngestEnvelopePayload, SerializedRequestPayload, TrackerClientPayload } from "./types";
import { jsonCloneRecord } from "./utils";
import { IngestDurableObject } from "./ingest-do";
import { runHourlyArchive } from "./archive";
import { handlePrivateQuery, handlePublicQuery } from "./query";
import { handlePrivateAdmin } from "./admin";
import { handlePrivateArchive } from "./archive-query";
import { handleTrackerScriptRequest } from "./script-endpoint";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

function responseNotFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function responseMethodNotAllowed(): Response {
  return new Response("Method Not Allowed", { status: 405 });
}

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

async function handleScript(request: Request, env: Env): Promise<Response> {
  return handleTrackerScriptRequest(request, env);
}

async function handleCollect(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return responseMethodNotAllowed();
  }

  const url = new URL(request.url);
  const body = await request.text();
  let payload: TrackerClientPayload = {};

  if (body) {
    try {
      payload = sanitizeInputPayload(JSON.parse(body));
    } catch {
      payload = {};
    }
  }

  const siteId = pickSiteIdFromPayload(payload, url);
  const doId = env.INGEST_DO.idFromName(siteId);
  const stub = env.INGEST_DO.get(doId);

  const envelope: IngestEnvelopePayload = {
    request: serializeRequestPayload(request, body),
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
    headers: corsHeaders,
  });
}

function handleOptions(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

async function handleAdminWs(request: Request, env: Env): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const siteId = incomingUrl.searchParams.get("siteId") || "default";
  const doId = env.INGEST_DO.idFromName(siteId);
  const stub = env.INGEST_DO.get(doId);
  const forwardUrl = "https://ingest.internal/ws" + incomingUrl.search;
  const forwardRequest = new Request(forwardUrl, request);
  return stub.fetch(forwardRequest);
}

async function handleHealth(env: Env): Promise<Response> {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "insightflare-edge",
      now: new Date().toISOString(),
      bindings: {
        d1: Boolean(env.DB),
        durableObject: Boolean(env.INGEST_DO),
        r2Archive: Boolean(env.ARCHIVE_BUCKET),
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    if (url.pathname === "/script.js") {
      return handleScript(request, env);
    }

    if (url.pathname === "/collect") {
      return handleCollect(request, env, ctx);
    }

    if (url.pathname === "/admin/ws") {
      return handleAdminWs(request, env);
    }

    if (url.pathname.startsWith("/api/private/admin/")) {
      return handlePrivateAdmin(request, env, url);
    }

    if (url.pathname.startsWith("/api/private/archive/")) {
      return handlePrivateArchive(request, env, url);
    }

    if (url.pathname.startsWith("/api/private/")) {
      return handlePrivateQuery(request, env, url);
    }

    if (url.pathname.startsWith("/api/public/")) {
      return handlePublicQuery(request, env, url);
    }

    if (url.pathname === "/healthz") {
      return handleHealth(env);
    }

    return responseNotFound();
  },

  async scheduled(controller, env): Promise<void> {
    await runHourlyArchive(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;

export { IngestDurableObject };
