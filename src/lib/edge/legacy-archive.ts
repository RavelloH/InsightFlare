import {
  handlePrivateArchiveFile,
  handlePrivateArchiveManifest,
} from "@/lib/edge/archive-query";
import type { Env } from "@/lib/edge/types";
import { bad, errorResponse, jsonResponseFor } from "@/lib/response";

export async function handleLegacyArchiveManifest(
  request: Request,
  env: Env,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const siteId = incomingUrl.searchParams.get("siteId") || "";
  const from = incomingUrl.searchParams.get("from") || "";
  const to = incomingUrl.searchParams.get("to") || "";

  if (siteId.length === 0) {
    return bad("Missing siteId", "missing_site_id", request);
  }

  const privateUrl = new URL("/api/private/archive/manifest", request.url);
  privateUrl.searchParams.set("siteId", siteId);
  privateUrl.searchParams.set("from", from);
  privateUrl.searchParams.set("to", to);
  const privateRequest = new Request(privateUrl, {
    method: "GET",
    headers: request.headers,
  });
  const edgeRes = await handlePrivateArchiveManifest(
    privateRequest,
    env,
    privateUrl,
  );

  const text = await edgeRes.text();
  if (!edgeRes.ok) {
    return errorResponse(
      request,
      edgeRes.status,
      "fetch_archive_manifest_failed",
      text,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return errorResponse(
      request,
      502,
      "invalid_manifest_json",
      "Archive manifest payload is invalid JSON",
    );
  }

  const files =
    payload &&
    typeof payload === "object" &&
    "files" in payload &&
    Array.isArray((payload as { files: unknown }).files)
      ? (payload as { files: Array<Record<string, unknown>> }).files
      : [];

  const normalizedFiles = files.map((file) => ({
    ...file,
    fetchUrl:
      typeof file.archiveKey === "string"
        ? `/api/archive/file?key=${encodeURIComponent(file.archiveKey)}`
        : undefined,
  }));

  return jsonResponseFor(request, {
    ...(payload && typeof payload === "object" ? payload : {}),
    files: normalizedFiles,
  });
}

export async function handleLegacyArchiveFile(
  request: Request,
  env: Env,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const key = incomingUrl.searchParams.get("key") || "";
  if (key.length === 0) {
    return bad("Missing key", "missing_key", request);
  }

  const privateUrl = new URL("/api/private/archive/file", request.url);
  privateUrl.searchParams.set("key", key);
  const headers = new Headers(request.headers);
  const privateRequest = new Request(privateUrl, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
  });
  const edgeRes = await handlePrivateArchiveFile(
    privateRequest,
    env,
    privateUrl,
  );
  if (!edgeRes.ok && edgeRes.status !== 206) {
    const text = await edgeRes.text();
    return errorResponse(
      request,
      edgeRes.status,
      "fetch_archive_file_failed",
      text,
    );
  }

  const responseHeaders = new Headers();
  const passthrough = [
    "content-type",
    "cache-control",
    "accept-ranges",
    "content-range",
    "content-length",
    "etag",
    "last-modified",
  ];
  for (const name of passthrough) {
    const value = edgeRes.headers.get(name);
    if (value) {
      responseHeaders.set(name, value);
    }
  }

  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/vnd.apache.parquet");
  }

  return new Response(request.method === "HEAD" ? null : edgeRes.body, {
    status: edgeRes.status,
    headers: responseHeaders,
  });
}
