import { NextResponse } from "next/server";
import { updateMyProfile } from "@/lib/edge-client";
import { safeRedirectPath } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const formData = await request.formData();
  const returnTo = safeRedirectPath(formData.get("returnTo"), "/app/account");

  try {
    await updateMyProfile({
      username: String(formData.get("username") || "").trim() || undefined,
      email: String(formData.get("email") || "").trim() || undefined,
      name: String(formData.get("name") || "").trim() || undefined,
      password: String(formData.get("password") || "").trim() || undefined,
    });
    return NextResponse.redirect(new URL(returnTo, request.url));
  } catch (error) {
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "profile_update_failed");
    url.searchParams.set("message", error instanceof Error ? error.message : String(error));
    return NextResponse.redirect(url);
  }
}
