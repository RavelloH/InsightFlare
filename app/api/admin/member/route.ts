import { NextResponse } from "next/server";
import { addAdminMember, removeAdminMember } from "@/lib/edge-client";
import { safeRedirectPath, parseRequestBody, bodyStr } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await parseRequestBody(request);
  const isJson = (request.headers.get("content-type") || "").includes("application/json");
  const returnTo = safeRedirectPath(body.returnTo as string | undefined, "/app/teams");
  const intent = bodyStr(body, "intent") || "add";

  const teamId = bodyStr(body, "teamId");
  if (intent === "remove") {
    const userId = bodyStr(body, "userId");
    if (teamId.length === 0 || userId.length === 0) {
      if (isJson) return NextResponse.json({ ok: false, error: "invalid_member_remove_input" }, { status: 400 });
      const url = new URL(returnTo, request.url);
      url.searchParams.set("error", "invalid_member_remove_input");
      return NextResponse.redirect(url, { status: 303 });
    }

    try {
      const result = await removeAdminMember({ teamId, userId });
      if (isJson) return NextResponse.json({ ok: true, data: result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (isJson) return NextResponse.json({ ok: false, error: "remove_member_failed", message: msg }, { status: 500 });
      const url = new URL(returnTo, request.url);
      url.searchParams.set("error", "remove_member_failed");
      url.searchParams.set("message", msg);
      return NextResponse.redirect(url, { status: 303 });
    }

    return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
  }

  const identifier = bodyStr(body, "identifier");
  if (teamId.length === 0 || identifier.length < 2) {
    if (isJson) return NextResponse.json({ ok: false, error: "invalid_member_input" }, { status: 400 });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "invalid_member_input");
    return NextResponse.redirect(url, { status: 303 });
  }

  try {
    const result = await addAdminMember({ teamId, identifier });
    if (isJson) return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (isJson) return NextResponse.json({ ok: false, error: "add_member_failed", message: msg }, { status: 500 });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "add_member_failed");
    url.searchParams.set("message", msg);
    return NextResponse.redirect(url, { status: 303 });
  }

  return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
}
