import { resolveEdgeRuntime } from "@/lib/edge/runtime";
import type { IngestEnvelopePayload, SerializedRequestPayload, TrackerClientPayload } from "@/lib/edge/types";
import { jsonCloneRecord } from "@/lib/edge/utils";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
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

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
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
    headers: CORS_HEADERS,
  });
}
