import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";
import { verifySessionToken } from "@/lib/session";
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
} from "@/lib/i18n/config";
import { isValidLocale } from "@/lib/i18n/config";

async function isAuthenticated(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE)?.value || "";
  const session = await verifySessionToken(token);
  return Boolean(session);
}

function getLocale(request: NextRequest): string {
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  if (cookieLocale && isValidLocale(cookieLocale)) {
    return cookieLocale;
  }

  const acceptLang = request.headers.get("accept-language");
  if (acceptLang) {
    const preferred = acceptLang
      .split(",")
      .map((part) => part.trim().split(";")[0].trim().toLowerCase().slice(0, 2))
      .find((code) => isValidLocale(code));
    if (preferred) return preferred;
  }

  return DEFAULT_LOCALE;
}

function pathnameHasLocale(pathname: string): boolean {
  return SUPPORTED_LOCALES.some(
    (locale) => pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`,
  );
}

function normalizePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function toLocalizedPath(pathname: string, locale: string): string {
  const normalized = normalizePathname(pathname);

  if (normalized === "/") {
    return `/${locale}/app`;
  }

  // Legacy shortcuts.
  if (normalized === "/app/config" || normalized === "/app/account") {
    return `/${locale}/app/settings`;
  }
  // Legacy flat routes that no longer exist — redirect to /app root
  if (
    normalized === "/app/teams" ||
    normalized === "/app/pages" ||
    normalized === "/app/realtime" ||
    normalized === "/app/sessions" ||
    normalized === "/app/precision"
  ) {
    return `/${locale}/app`;
  }
  if (
    normalized === "/app" ||
    normalized === "/app/teams" ||
    normalized === "/app/settings" ||
    normalized === "/app/precision" ||
    normalized === "/login"
  ) {
    return `/${locale}${normalized}`;
  }

  return `/${locale}${normalized}`;
}

function redirectWithPath(
  request: NextRequest,
  pathname: string,
  options?: { preserveSearch?: boolean },
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  if (!options?.preserveSearch) {
    url.search = "";
  }
  const response = NextResponse.redirect(url);
  response.headers.set("x-pathname", url.pathname);
  return response;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const authenticated = await isAuthenticated(request);
  const normalizedPathname = normalizePathname(pathname);
  const localeFromPath = pathnameHasLocale(pathname) ? pathname.split("/")[1] : null;

  // API routes — no locale handling, just auth checks
  if (pathname.startsWith("/api/admin")) {
    if (!authenticated) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/archive")) {
    if (!authenticated) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Non-locale path: unify all redirects here.
  if (!pathnameHasLocale(pathname)) {
    const locale = getLocale(request);
    return redirectWithPath(request, toLocalizedPath(pathname, locale), { preserveSearch: true });
  }

  if (localeFromPath && normalizedPathname === `/${localeFromPath}`) {
    return redirectWithPath(request, `/${localeFromPath}/app`, { preserveSearch: true });
  }

  const restPath = pathname.replace(/^\/[^/]+/, "") || "/";

  // Protected routes under /[locale]/app/*
  if (restPath.startsWith("/app")) {
    if (!authenticated) {
      const url = request.nextUrl.clone();
      url.pathname = `/${localeFromPath}/login`;
      url.searchParams.set("next", `${pathname}${search}`);
      return NextResponse.redirect(url);
    }
  }

  if (restPath === "/login" && authenticated) {
    return redirectWithPath(request, `/${localeFromPath}/app`, { preserveSearch: false });
  }

  const response = NextResponse.next();
  response.headers.set("x-pathname", pathname);
  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|collect|script\\.js|healthz|favicon\\.ico).*)",
  ],
};
