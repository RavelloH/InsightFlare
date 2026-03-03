import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";
import { verifySessionToken } from "@/lib/session";
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  resolveLocale,
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
  return `/${locale}${normalized}`;
}

function localeFromPathname(pathname: string): string | null {
  const segment = pathname.split("/")[1];
  if (isValidLocale(segment)) {
    return segment;
  }
  return null;
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

  const locale = localeFromPathname(url.pathname);
  if (locale) {
    response.cookies.set({
      name: LOCALE_COOKIE,
      value: locale,
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return response;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const authenticated = await isAuthenticated(request);
  const normalizedPathname = normalizePathname(pathname);
  const localeFromPath = pathnameHasLocale(pathname) ? pathname.split("/")[1] : null;

  if (pathname === "/admin/ws") {
    return NextResponse.next();
  }

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
      const response = NextResponse.redirect(url);
      response.cookies.set({
        name: LOCALE_COOKIE,
        value: resolveLocale(localeFromPath),
        path: "/",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
      });
      return response;
    }
  }

  if (restPath === "/login" && authenticated) {
    return redirectWithPath(request, `/${localeFromPath}/app`, { preserveSearch: false });
  }

  const response = NextResponse.next();
  response.headers.set("x-pathname", pathname);
  if (localeFromPath) {
    response.cookies.set({
      name: LOCALE_COOKIE,
      value: resolveLocale(localeFromPath),
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|collect|script\\.js|healthz|favicon\\.ico|admin/ws).*)",
  ],
};
