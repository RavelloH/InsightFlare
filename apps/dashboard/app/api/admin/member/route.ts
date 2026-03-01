import { NextResponse } from "next/server";
import { addAdminMember } from "@/lib/edge-client";
import { safeRedirectPath } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const formData = await request.formData();
  const returnTo = safeRedirectPath(formData.get("returnTo"), "/app/teams");

  const teamId = String(formData.get("teamId") || "").trim();
  const email = String(formData.get("email") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const role = String(formData.get("role") || "member").trim();

  if (teamId.length === 0 || email.length < 3) {
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "invalid_member_input");
    return NextResponse.redirect(url);
  }

  try {
    await addAdminMember({
      teamId,
      email,
      name: name || undefined,
      role: role || "member",
    });
  } catch (error) {
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "add_member_failed");
    url.searchParams.set("message", error instanceof Error ? error.message : String(error));
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL(returnTo, request.url));
}

