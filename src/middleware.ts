import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";
import { configuredSessionSecret, verifySessionToken } from "@/lib/session";
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  resolveLocale,
} from "@/lib/i18n/config";
import { isValidLocale } from "@/lib/i18n/config";

type AuthState = "authenticated" | "unauthenticated" | "unknown";

interface RedirectProfile {
  teams: Array<{
    slug: string;
  }>;
}

async function resolveSessionSecretForMiddleware(): Promise<string | null> {
  const fromProcess = configuredSessionSecret();
  if (fromProcess) return fromProcess;

  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = await getCloudflareContext({ async: true });
    const env = context.env as Record<string, unknown>;
    const fromCloudflare = String(
      env.DASHBOARD_SESSION_SECRET || env.SESSION_SECRET || "",
    );
    if (fromCloudflare.length > 0) {
      return fromCloudflare;
    }
  } catch {
    // No Cloudflare runtime context available.
  }

  return null;
}

async function authState(request: NextRequest): Promise<AuthState> {
  const token = request.cookies.get(SESSION_COOKIE)?.value || "";
  if (!token) return "unauthenticated";

  const secret = await resolveSessionSecretForMiddleware();
  if (!secret) return "unknown";

  const session = await verifySessionToken(token, secret);
  return session ? "authenticated" : "unauthenticated";
}

async function fetchRedirectProfile(request: NextRequest): Promise<RedirectProfile | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value || "";
  if (!token) return null;

  try {
    const url = request.nextUrl.clone();
    url.pathname = "/api/private/admin/auth/me";
    url.search = "";

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as {
      ok?: boolean;
      data?: {
        teams?: Array<{
          slug?: unknown;
        }>;
      };
    };
    if (!payload.ok) return null;

    const teams = Array.isArray(payload.data?.teams)
      ? payload.data.teams
          .map((team) => String(team?.slug || "").trim())
          .filter((slug) => slug.length > 0)
      : [];

    return {
      teams: teams.map((slug) => ({ slug })),
    };
  } catch {
    return null;
  }
}

function getLocale(request: NextRequest): string {
  const acceptLang = request.headers.get("accept-language");
  if (acceptLang) {
    const preferred = acceptLang
      .split(",")
      .map((part) => part.trim().split(";")[0].trim().toLowerCase())
      .map((tag) => {
        // Try exact match first (e.g. "zh"), then language-only prefix (e.g. "zh" from "zh-cn")
        if (isValidLocale(tag)) return tag;
        const lang = tag.slice(0, 2);
        return isValidLocale(lang) ? lang : null;
      })
      .find((code): code is string => code !== null);
    if (preferred) return preferred;
  }

  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  if (cookieLocale && isValidLocale(cookieLocale)) {
    return cookieLocale;
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

  let state: AuthState | null = null;
  let redirectProfile: RedirectProfile | null | undefined;
  const ensureAuthState = async (): Promise<AuthState> => {
    if (!state) {
      state = await authState(request);
    }
    return state;
  };
  const ensureRedirectProfile = async (): Promise<RedirectProfile | null> => {
    if (redirectProfile === undefined) {
      redirectProfile = await fetchRedirectProfile(request);
    }
    return redirectProfile;
  };
  const normalizedPathname = normalizePathname(pathname);
  const localeFromPath = pathnameHasLocale(pathname) ? pathname.split("/")[1] : null;

  if (pathname === "/admin/ws") {
    return NextResponse.next();
  }

  // API routes — no locale handling, just auth checks
  if (pathname.startsWith("/api/admin")) {
    if ((await ensureAuthState()) !== "authenticated") {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/archive")) {
    if ((await ensureAuthState()) !== "authenticated") {
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
  const normalizedRestPath = normalizePathname(restPath);

  // Protected routes under /[locale]/app/*
  if (restPath.startsWith("/app")) {
    const currentAuthState = await ensureAuthState();
    if (currentAuthState === "unauthenticated") {
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

    const appSegments = normalizedRestPath.split("/").filter((segment) => segment.length > 0);
    if (appSegments.length === 1) {
      const profile = await ensureRedirectProfile();
      if (profile && profile.teams.length === 1) {
        return redirectWithPath(
          request,
          `/${localeFromPath}/app/${profile.teams[0].slug}`,
          { preserveSearch: false },
        );
      }
    }

    if (appSegments.length === 2) {
      const legacyTab = request.nextUrl.searchParams.get("tab");
      if (legacyTab === "settings" || legacyTab === "members") {
        return redirectWithPath(
          request,
          `/${localeFromPath}/app/${appSegments[1]}/${legacyTab}`,
          { preserveSearch: false },
        );
      }
    }
  }

  if (normalizedRestPath === "/login" && (await ensureAuthState()) === "authenticated") {
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
