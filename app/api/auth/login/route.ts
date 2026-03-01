import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_DURATION_SECONDS } from "@/lib/constants";
import { loginAdminAccount } from "@/lib/edge-client";
import { createSessionToken } from "@/lib/session";

export async function POST(request: Request): Promise<NextResponse> {
  const formData = await request.formData();
  const username = String(formData.get("username") || "").trim();
  const password = String(formData.get("password") || "");
  const nextPathRaw = String(formData.get("next") || "/app");
  const nextPath = nextPathRaw.startsWith("/") ? nextPathRaw : "/app";

  if (username.length < 2 || password.length < 1) {
    const url = new URL("/login", request.url);
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

    const url = new URL(nextPath, request.url);
    const response = NextResponse.redirect(url, { status: 303 });
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
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "invalid_credentials");
    url.searchParams.set("next", nextPath);
    return NextResponse.redirect(url, { status: 303 });
  }
}
