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

  // Preserve historical shortcuts after removing non-locale shim pages.
  if (normalized === "/app/config" || normalized === "/app/account") {
    return `/${locale}/app/settings`;
  }

  return `/${locale}${normalized}`;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const authenticated = await isAuthenticated(request);

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

  // If no locale prefix, redirect to locale-prefixed path
  if (!pathnameHasLocale(pathname)) {
    const locale = getLocale(request);
    const url = request.nextUrl.clone();
    url.pathname = toLocalizedPath(pathname, locale);
    return NextResponse.redirect(url);
  }

  // Extract locale from pathname
  const segments = pathname.split("/");
  const locale = segments[1];
  const restPath = "/" + segments.slice(2).join("/");

  // Protected routes under /[locale]/app/*
  if (restPath.startsWith("/app")) {
    if (!authenticated) {
      const url = request.nextUrl.clone();
      url.pathname = `/${locale}/login`;
      url.searchParams.set("next", `${pathname}${search}`);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|collect|script\\.js|healthz|favicon\\.ico).*)",
  ],
};
