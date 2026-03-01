import { NextResponse } from "next/server";
import { createAdminTeam } from "@/lib/edge-client";
import { safeRedirectPath } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const formData = await request.formData();
  const returnTo = safeRedirectPath(formData.get("returnTo"), "/app/teams");

  const name = String(formData.get("name") || "").trim();
  const slug = String(formData.get("slug") || "").trim();

  if (name.length < 2) {
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "invalid_team_name");
    return NextResponse.redirect(url);
  }

  try {
    const created = await createAdminTeam({
      name,
      slug: slug || undefined,
    });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("teamId", created.id);
    return NextResponse.redirect(url);
  } catch (error) {
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "create_team_failed");
    url.searchParams.set("message", error instanceof Error ? error.message : String(error));
    return NextResponse.redirect(url);
  }
}
