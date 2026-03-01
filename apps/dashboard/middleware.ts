import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";

function isAuthenticated(request: NextRequest): boolean {
  return request.cookies.get(SESSION_COOKIE)?.value === "1";
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const authenticated = isAuthenticated(request);

  if (pathname.startsWith("/api/admin")) {
    if (!authenticated) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  if (pathname.startsWith("/api/archive")) {
    if (!authenticated) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  if (pathname.startsWith("/app")) {
    if (!authenticated) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", `${pathname}${search}`);
      return NextResponse.redirect(url);
    }
  }

  if (pathname === "/login" && authenticated) {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*", "/login", "/api/admin/:path*", "/api/archive/:path*"],
};
