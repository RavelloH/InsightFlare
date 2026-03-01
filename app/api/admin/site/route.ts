import { NextResponse } from "next/server";
import { createAdminSite, updateAdminSite } from "@/lib/edge-client";
import { parseFormBool, safeRedirectPath } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const formData = await request.formData();
  const returnTo = safeRedirectPath(formData.get("returnTo"), "/app/teams");
  const intent = String(formData.get("intent") || "create").trim().toLowerCase();

  const teamId = String(formData.get("teamId") || "").trim();
  const siteId = String(formData.get("siteId") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const domain = String(formData.get("domain") || "").trim();
  const publicEnabled = parseFormBool(formData.get("publicEnabled"));
  const publicSlug = String(formData.get("publicSlug") || "").trim();

  try {
    if (intent === "update") {
      if (siteId.length === 0) {
        const url = new URL(returnTo, request.url);
        url.searchParams.set("error", "missing_site_id");
        return NextResponse.redirect(url);
      }
      await updateAdminSite({
        siteId,
        name: name || undefined,
        domain: domain || undefined,
        publicEnabled,
        publicSlug: publicSlug || undefined,
      });
    } else {
      if (teamId.length === 0 || name.length === 0 || domain.length === 0) {
        const url = new URL(returnTo, request.url);
        url.searchParams.set("error", "invalid_site_input");
        return NextResponse.redirect(url);
      }
      const created = await createAdminSite({
        teamId,
        name,
        domain,
        publicEnabled,
        publicSlug: publicSlug || undefined,
      });
      const url = new URL(returnTo, request.url);
      url.searchParams.set("siteId", created.id);
      url.searchParams.set("teamId", created.teamId);
      return NextResponse.redirect(url);
    }
  } catch (error) {
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "site_mutation_failed");
    url.searchParams.set("message", error instanceof Error ? error.message : String(error));
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL(returnTo, request.url));
}

