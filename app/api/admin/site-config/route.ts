import { NextResponse } from "next/server";
import { updateAdminSite, upsertAdminSiteConfig } from "@/lib/edge-client";
import { parseFormBool, safeRedirectPath, parseRequestBody, bodyStr } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await parseRequestBody(request);
  const isJson = (request.headers.get("content-type") || "").includes("application/json");
  const returnTo = safeRedirectPath(body.returnTo as string | undefined, "/app/config");

  const siteId = bodyStr(body, "siteId");
  const name = bodyStr(body, "name");
  const domain = bodyStr(body, "domain");
  const publicEnabled = parseFormBool(body.publicEnabled);
  const publicSlug = bodyStr(body, "publicSlug");

  if (siteId.length === 0) {
    if (isJson) return NextResponse.json({ ok: false, error: "missing_site_id" }, { status: 400 });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "missing_site_id");
    return NextResponse.redirect(url, { status: 303 });
  }

  const privacyConfig = {
    maskQueryHashDetails: parseFormBool(body.maskQueryHashDetails, true),
    maskVisitorTrajectory: parseFormBool(body.maskVisitorTrajectory, true),
    maskDetailedReferrerUrl: parseFormBool(body.maskDetailedReferrerUrl, true),
  };

  try {
    await updateAdminSite({
      siteId,
      name: name || undefined,
      domain: domain || undefined,
      publicEnabled,
      publicSlug: publicSlug || undefined,
    });
    await upsertAdminSiteConfig({
      siteId,
      config: { privacy: privacyConfig },
    });
    if (isJson) return NextResponse.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (isJson) return NextResponse.json({ ok: false, error: "save_site_config_failed", message: msg }, { status: 500 });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "save_site_config_failed");
    url.searchParams.set("message", msg);
    return NextResponse.redirect(url, { status: 303 });
  }

  return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
}
