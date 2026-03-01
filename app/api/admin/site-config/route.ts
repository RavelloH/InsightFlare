import { NextResponse } from "next/server";
import { updateAdminSite, upsertAdminSiteConfig } from "@/lib/edge-client";
import { parseFormBool, safeRedirectPath } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const formData = await request.formData();
  const returnTo = safeRedirectPath(formData.get("returnTo"), "/app/config");

  const siteId = String(formData.get("siteId") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const domain = String(formData.get("domain") || "").trim();
  const publicEnabled = parseFormBool(formData.get("publicEnabled"));
  const publicSlug = String(formData.get("publicSlug") || "").trim();

  if (siteId.length === 0) {
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "missing_site_id");
    return NextResponse.redirect(url, { status: 303 });
  }

  const privacyConfig = {
    maskQueryHashDetails: parseFormBool(formData.get("maskQueryHashDetails"), true),
    maskVisitorTrajectory: parseFormBool(formData.get("maskVisitorTrajectory"), true),
    maskDetailedReferrerUrl: parseFormBool(formData.get("maskDetailedReferrerUrl"), true),
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
      config: {
        privacy: privacyConfig,
      },
    });
  } catch (error) {
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "save_site_config_failed");
    url.searchParams.set("message", error instanceof Error ? error.message : String(error));
    return NextResponse.redirect(url, { status: 303 });
  }

  return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
}
