import { NextResponse } from "next/server";
import { addAdminMember, removeAdminMember } from "@/lib/edge-client";
import { safeRedirectPath } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const formData = await request.formData();
  const returnTo = safeRedirectPath(formData.get("returnTo"), "/app/teams");
  const intent = String(formData.get("intent") || "add").trim().toLowerCase();

  const teamId = String(formData.get("teamId") || "").trim();
  if (intent === "remove") {
    const userId = String(formData.get("userId") || "").trim();
    if (teamId.length === 0 || userId.length === 0) {
      const url = new URL(returnTo, request.url);
      url.searchParams.set("error", "invalid_member_remove_input");
      return NextResponse.redirect(url);
    }

    try {
      await removeAdminMember({ teamId, userId });
    } catch (error) {
      const url = new URL(returnTo, request.url);
      url.searchParams.set("error", "remove_member_failed");
      url.searchParams.set("message", error instanceof Error ? error.message : String(error));
      return NextResponse.redirect(url);
    }

    return NextResponse.redirect(new URL(returnTo, request.url));
  }

  const identifier = String(formData.get("identifier") || "").trim();
  if (teamId.length === 0 || identifier.length < 2) {
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "invalid_member_input");
    return NextResponse.redirect(url);
  }

  try {
    await addAdminMember({
      teamId,
      identifier,
    });
  } catch (error) {
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "add_member_failed");
    url.searchParams.set("message", error instanceof Error ? error.message : String(error));
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL(returnTo, request.url));
}
