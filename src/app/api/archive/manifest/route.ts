import { NextResponse } from "next/server";
import { fetchEdgeForServer } from "@/lib/edge-proxy";

export async function GET(request: Request): Promise<NextResponse> {
  const incomingUrl = new URL(request.url);
  const siteId = incomingUrl.searchParams.get("siteId") || "";
  const from = incomingUrl.searchParams.get("from") || "";
  const to = incomingUrl.searchParams.get("to") || "";

  if (siteId.length === 0) {
    return NextResponse.json({ ok: false, error: "Missing siteId" }, { status: 400 });
  }

  const edgeRes = await fetchEdgeForServer({
    baseUrl: incomingUrl.origin,
    pathname: "/api/private/archive/manifest",
    params: {
      siteId,
      from,
      to,
    },
  });

  const text = await edgeRes.text();
  if (!edgeRes.ok) {
    return NextResponse.json(
      { ok: false, error: "Failed to fetch archive manifest", detail: text },
      { status: edgeRes.status },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Archive manifest payload is invalid JSON" },
      { status: 502 },
    );
  }

  const files = (
    payload &&
    typeof payload === "object" &&
    "files" in payload &&
    Array.isArray((payload as { files: unknown }).files)
  )
    ? ((payload as { files: Array<Record<string, unknown>> }).files)
    : [];

  const normalizedFiles = files.map((file) => ({
    ...file,
    fetchUrl:
      typeof file.archiveKey === "string"
        ? `/api/archive/file?key=${encodeURIComponent(file.archiveKey)}`
        : undefined,
  }));

  return NextResponse.json({
    ...(payload && typeof payload === "object" ? payload : {}),
    files: normalizedFiles,
  });
}
