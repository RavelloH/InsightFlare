import { NextResponse } from "next/server";
import { createAdminUser, updateAdminUser } from "@/lib/edge-client";
import { safeRedirectPath, parseRequestBody, bodyStr } from "@/lib/form-helpers";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await parseRequestBody(request);
  const isJson = (request.headers.get("content-type") || "").includes("application/json");
  const returnTo = safeRedirectPath(body.returnTo as string | undefined, "/app/account");
  const intent = bodyStr(body, "intent") || "create";

  try {
    if (intent === "update") {
      const userId = bodyStr(body, "userId");
      if (!userId) {
        if (isJson) return NextResponse.json({ ok: false, error: "missing_user_id" }, { status: 400 });
        const url = new URL(returnTo, request.url);
        url.searchParams.set("error", "missing_user_id");
        return NextResponse.redirect(url, { status: 303 });
      }

      const result = await updateAdminUser({
        userId,
        username: bodyStr(body, "username") || undefined,
        email: bodyStr(body, "email") || undefined,
        name: bodyStr(body, "name") || undefined,
        password: bodyStr(body, "password") || undefined,
        systemRole: bodyStr(body, "systemRole").toLowerCase() === "admin" ? "admin" : "user",
      });
      if (isJson) return NextResponse.json({ ok: true, data: result });
      return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
    }

    const username = bodyStr(body, "username");
    const email = bodyStr(body, "email");
    const password = String(body.password ?? "");
    const name = bodyStr(body, "name");
    const systemRole = bodyStr(body, "systemRole").toLowerCase() === "admin" ? "admin" : "user";

    if (!username || !email || password.length < 8) {
      if (isJson) return NextResponse.json({ ok: false, error: "invalid_user_input" }, { status: 400 });
      const url = new URL(returnTo, request.url);
      url.searchParams.set("error", "invalid_user_input");
      return NextResponse.redirect(url, { status: 303 });
    }

    const result = await createAdminUser({
      username,
      email,
      password,
      name: name || undefined,
      systemRole,
    });
    if (isJson) return NextResponse.json({ ok: true, data: result });
    return NextResponse.redirect(new URL(returnTo, request.url), { status: 303 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (isJson) return NextResponse.json({ ok: false, error: "user_mutation_failed", message: msg }, { status: 500 });
    const url = new URL(returnTo, request.url);
    url.searchParams.set("error", "user_mutation_failed");
    url.searchParams.set("message", msg);
    return NextResponse.redirect(url, { status: 303 });
  }
}
