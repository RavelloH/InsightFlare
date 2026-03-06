import { NextResponse } from "next/server";
import { upsertAdminSiteConfig } from "@/lib/edge-client";
import { parseFormBool, safeRedirectPath, parseRequestBody, bodyStr } from "@/lib/form-helpers";

function normalizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const jsonStart = raw.lastIndexOf("{");
  if (jsonStart >= 0) {
    const maybeJson = raw.slice(jsonStart).trim();
    try {
      const parsed = JSON.parse(maybeJson) as { message?: unknown; error?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    } catch {
      // fall through to raw
    }
  }
  return raw;
}

function buildLegacyConfig(body: Record<string, unknown>): Record<string, unknown> {
  return {
    privacy: {
      maskQueryHashDetails: parseFormBool(body.maskQueryHashDetails, true),
      maskVisitorTrajectory: parseFormBool(body.maskVisitorTrajectory, true),
      maskDetailedReferrerUrl: parseFormBool(body.maskDetailedReferrerUrl, true),
    },
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await parseRequestBody(request);
  const isJson = (request.headers.get("content-type") || "").includes("application/json");
  const returnTo = safeRedirectPath(body.returnTo as string | undefined, "/app/config");
  const siteId = bodyStr(body, "siteId");

  if (siteId.length === 0) {
    if (isJson) return NextResponse.json({ ok: false, error: "missing_site_id" }, { status: 400 });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "missing_site_id");
    return NextResponse.redirect(url, { status: 303 });
  }

  const config =
    body.config && typeof body.config === "object"
      ? (body.config as Record<string, unknown>)
      : buildLegacyConfig(body);

  try {
    const saved = await upsertAdminSiteConfig({
      siteId,
      config,
    });
    if (isJson) return NextResponse.json({ ok: true, data: saved });
  } catch (error) {
    const msg = normalizeErrorMessage(error);
    if (isJson) return NextResponse.json({ ok: false, error: "save_site_config_failed", message: msg }, { status: 500 });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "save_site_config_failed");
    url.searchParams.set("message", msg);
    return NextResponse.redirect(url, { status: 303 });
  }

  return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
}
