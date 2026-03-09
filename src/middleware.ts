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
  if (!token) return false;

  const session = await verifySessionToken(token);
  if (!session) return false;

  const url = request.nextUrl.clone();
  url.pathname = "/api/private/admin/auth/me";
  url.search = "";

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
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

  // Demo mode: skip all auth checks
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") {
    if (pathname === "/admin/ws") return NextResponse.next();
    if (pathname.startsWith("/api/admin") || pathname.startsWith("/api/archive")) {
      return NextResponse.next();
    }
    if (!pathnameHasLocale(pathname)) {
      const locale = getLocale(request);
      return redirectWithPath(request, toLocalizedPath(pathname, locale), { preserveSearch: true });
    }
    const demoLocale = pathname.split("/")[1];
    const demoNormalized = normalizePathname(pathname);
    if (demoLocale && demoNormalized === `/${demoLocale}`) {
      return redirectWithPath(request, `/${demoLocale}/app`, { preserveSearch: true });
    }
    const demoRest = pathname.replace(/^\/[^/]+/, "") || "/";
    if (demoRest === "/login") {
      return redirectWithPath(request, `/${demoLocale}/app`, { preserveSearch: false });
    }
    const demoResponse = NextResponse.next();
    demoResponse.headers.set("x-pathname", pathname);
    if (demoLocale && isValidLocale(demoLocale)) {
      demoResponse.cookies.set({
        name: LOCALE_COOKIE,
        value: resolveLocale(demoLocale),
        path: "/",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 365,
      });
    }
    return demoResponse;
  }

  let authenticated: boolean | null = null;
  const ensureAuthenticated = async (): Promise<boolean> => {
    if (authenticated === null) {
      authenticated = await isAuthenticated(request);
    }
    return authenticated;
  };
  const normalizedPathname = normalizePathname(pathname);
  const localeFromPath = pathnameHasLocale(pathname) ? pathname.split("/")[1] : null;

  if (pathname === "/admin/ws") {
    return NextResponse.next();
  }

  // API routes — no locale handling, just auth checks
  if (pathname.startsWith("/api/admin")) {
    if (!(await ensureAuthenticated())) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/archive")) {
    if (!(await ensureAuthenticated())) {
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
    if (!(await ensureAuthenticated())) {
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

  if (restPath === "/login" && (await ensureAuthenticated())) {
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
    "/((?!api|_next/static|_next/image|collect|script\\.js|healthz|favicon\\.ico|admin/ws|.*\\..*).*)",
  ],
};
