import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_DURATION_SECONDS } from "@/lib/constants";

function expectedPassword(): string {
  return process.env.DASHBOARD_PASSWORD || "insightflare";
}

export async function POST(request: Request): Promise<NextResponse> {
  const formData = await request.formData();
  const password = String(formData.get("password") || "");
  const nextPathRaw = String(formData.get("next") || "/app");
  const nextPath = nextPathRaw.startsWith("/") ? nextPathRaw : "/app";

  if (password !== expectedPassword()) {
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "invalid_credentials");
    url.searchParams.set("next", nextPath);
    return NextResponse.redirect(url);
  }

  const url = new URL(nextPath, request.url);
  const response = NextResponse.redirect(url);
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "1",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DURATION_SECONDS,
  });
  return response;
}

