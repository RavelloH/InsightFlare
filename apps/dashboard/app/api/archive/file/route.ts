import { NextResponse } from "next/server";
import { fetchEdgeForServer } from "@/lib/edge-proxy";

async function proxyArchiveFile(request: Request): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const key = incomingUrl.searchParams.get("key") || "";
  if (key.length === 0) {
    return NextResponse.json({ ok: false, error: "Missing key" }, { status: 400 });
  }

  const rangeHeader = request.headers.get("range") || undefined;

  const edgeRes = await fetchEdgeForServer({
    baseUrl: incomingUrl.origin,
    pathname: "/api/private/archive/file",
    method: request.method === "HEAD" ? "HEAD" : "GET",
    params: { key },
    headers: {
      range: rangeHeader,
    },
  });
  if (!edgeRes.ok && edgeRes.status !== 206) {
    const text = await edgeRes.text();
    return NextResponse.json(
      { ok: false, error: "Failed to fetch archive file", detail: text },
      { status: edgeRes.status },
    );
  }

  const headers = new Headers();
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
      headers.set(name, value);
    }
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/vnd.apache.parquet");
  }

  return new Response(request.method === "HEAD" ? null : edgeRes.body, {
    status: edgeRes.status,
    headers,
  });
}

export async function GET(request: Request): Promise<Response> {
  return proxyArchiveFile(request);
}

export async function HEAD(request: Request): Promise<Response> {
  return proxyArchiveFile(request);
}
