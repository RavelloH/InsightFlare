import { NextResponse } from "next/server";
import { updateMyProfile } from "@/lib/edge-client";
import { safeRedirectPath, parseRequestBody, bodyStr } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await parseRequestBody(request);
  const isJson = (request.headers.get("content-type") || "").includes("application/json");
  const returnTo = safeRedirectPath(body.returnTo as string | undefined, "/app/account");

  try {
    const result = await updateMyProfile({
      username: bodyStr(body, "username") || undefined,
      email: bodyStr(body, "email") || undefined,
      name: bodyStr(body, "name") || undefined,
      password: bodyStr(body, "password") || undefined,
    });
    if (isJson) return NextResponse.json({ ok: true, data: result });
    return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (isJson) return NextResponse.json({ ok: false, error: "profile_update_failed", message: msg }, { status: 500 });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "profile_update_failed");
    url.searchParams.set("message", msg);
    return NextResponse.redirect(url, { status: 303 });
  }
}
