import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_DURATION_SECONDS } from "@/lib/constants";
import { loginAdminAccount } from "@/lib/edge-client";
import { bodyStr, parseRequestBody } from "@/lib/form-helpers";
import { createSessionToken } from "@/lib/session";
import { isValidLocale } from "@/lib/i18n/config";

function localeFromPath(pathname: string): string | null {
  const segment = pathname.split("/")[1];
  if (isValidLocale(segment)) {
    return segment;
  }
  return null;
}

function loginPathFor(nextPath: string): string {
  const locale = localeFromPath(nextPath);
  if (!locale) return "/login";
  return `/${locale}/login`;
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await parseRequestBody(request);
  const isJson = (request.headers.get("content-type") || "").includes("application/json");
  const username = bodyStr(body, "username");
  const password = String(body.password ?? "");
  const nextPathRaw = bodyStr(body, "next") || "/app";
  const nextPath = nextPathRaw.startsWith("/") ? nextPathRaw : "/app";

  if (username.length < 2 || password.length < 1) {
    if (isJson) {
      return NextResponse.json(
        { ok: false, error: "invalid_credentials" },
        { status: 400 },
      );
    }
    const url = new URL(loginPathFor(nextPath), request.url);
    url.searchParams.set("error", "invalid_credentials");
    url.searchParams.set("next", nextPath);
    return NextResponse.redirect(url, { status: 303 });
  }

  try {
    const loginData = await loginAdminAccount({ username, password });
    const token = await createSessionToken(
      {
        userId: loginData.user.id,
        username: loginData.user.username,
        displayName: loginData.user.name || loginData.user.username,
        systemRole: loginData.user.systemRole,
      },
      SESSION_DURATION_SECONDS,
    );

    const response = isJson
      ? NextResponse.json({
          ok: true,
          data: {
            next: nextPath,
          },
        })
      : NextResponse.redirect(new URL(nextPath, request.url), { status: 303 });
    response.cookies.set({
      name: SESSION_COOKIE,
      value: token,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_DURATION_SECONDS,
    });
    return response;
  } catch {
    if (isJson) {
      return NextResponse.json(
        { ok: false, error: "invalid_credentials" },
        { status: 401 },
      );
    }
    const url = new URL(loginPathFor(nextPath), request.url);
    url.searchParams.set("error", "invalid_credentials");
    url.searchParams.set("next", nextPath);
    return NextResponse.redirect(url, { status: 303 });
  }
}
