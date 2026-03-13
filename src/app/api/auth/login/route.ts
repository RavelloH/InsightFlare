import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_DURATION_SECONDS } from "@/lib/constants";
import { loginAdminAccount } from "@/lib/edge-client";
import { bodyStr, parseRequestBody } from "@/lib/form-helpers";
import { createSessionToken } from "@/lib/session";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await parseRequestBody(request);
  const username = bodyStr(body, "username");
  const password = String(body.password ?? "");
  const nextPathRaw = bodyStr(body, "next") || "/app";
  const nextPathClean = nextPathRaw.split("?")[0].replace(/\/+$/, "");
  const isUnsafe = !nextPathRaw.startsWith("/") || nextPathRaw.startsWith("//") || nextPathClean === "/login" || nextPathClean.endsWith("/login");
  const nextPath = isUnsafe ? "/app" : nextPathRaw;

  if (username.length < 2 || password.length < 1) {
    return NextResponse.json(
      { ok: false, error: "invalid_credentials" },
      { status: 400 },
    );
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

    const response = NextResponse.json({
      ok: true,
      data: {
        next: nextPath,
      },
    });
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
    return NextResponse.json(
      { ok: false, error: "invalid_credentials" },
      { status: 401 },
    );
  }
}
