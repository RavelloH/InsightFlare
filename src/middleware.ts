import { SESSION_COOKIE } from "@/lib/constants";
import { appNow, initializeE2eClock } from "@/lib/edge/e2e-clock";
import type { Env } from "@/lib/edge/types";
import {
  DEFAULT_LOCALE,
  isValidLocale,
  LOCALE_COOKIE,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "@/lib/i18n/config";
import { dashboardSessionSecret } from "@/lib/secrets";
import { verifySessionToken } from "@/lib/session";

type AuthState = "authenticated" | "unauthenticated" | "unknown";
type InternalFetch = (request: Request) => Promise<Response>;

const DEMO_DEFAULT_TEAM_SLUG = "xeoos-team";
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

interface RedirectProfile {
  teams: Array<{ slug: string }>;
}

export interface PageRequestDecision {
  locale: string | null;
  pathname: string;
  response: Response | null;
}

function cookieValue(request: Request, name: string): string {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return value.join("=");
      }
    }
  }
  return "";
}

function hasRootSecret(env: Env): boolean {
  return Boolean(
    String(env.MAIN_SECRET || "").trim() ||
    String(env.DAILY_SALT_SECRET || "").trim(),
  );
}

async function authState(request: Request, env: Env): Promise<AuthState> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return "unauthenticated";
  const secret = await dashboardSessionSecret(env);
  if (!secret) return "unknown";
  return (await verifySessionToken(token, secret, appNow()))
    ? "authenticated"
    : "unauthenticated";
}

async function fetchRedirectProfile(
  request: Request,
  internalFetch: InternalFetch,
): Promise<RedirectProfile | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;

  try {
    const url = new URL("/api/private/session", request.url);
    const response = await internalFetch(
      new Request(url, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      ok?: boolean;
      data?: { teams?: Array<{ slug?: unknown }> };
    };
    if (!payload.ok) return null;
    const teams = Array.isArray(payload.data?.teams)
      ? payload.data.teams
          .map((team) => String(team.slug || "").trim())
          .filter(Boolean)
          .map((slug) => ({ slug }))
      : [];
    return { teams };
  } catch {
    return null;
  }
}

function requestLocale(request: Request): string {
  const acceptLanguage = request.headers.get("accept-language");
  if (acceptLanguage) {
    const preferred = acceptLanguage
      .split(",")
      .map((part) => part.trim().split(";")[0].trim().toLowerCase())
      .map((tag) => (isValidLocale(tag) ? tag : tag.slice(0, 2)))
      .find(isValidLocale);
    if (preferred) return preferred;
  }
  const locale = cookieValue(request, LOCALE_COOKIE);
  return isValidLocale(locale) ? locale : DEFAULT_LOCALE;
}

function pathnameHasLocale(pathname: string): boolean {
  return SUPPORTED_LOCALES.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
}

function normalizePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function localizedPath(pathname: string, locale: string): string {
  const normalized = normalizePathname(pathname);
  return normalized === "/" ? `/${locale}/app` : `/${locale}${normalized}`;
}

function localeFromPathname(pathname: string): string | null {
  const segment = pathname.split("/")[1];
  return isValidLocale(segment) ? segment : null;
}

export function localeCookie(locale: string): string {
  return `${LOCALE_COOKIE}=${encodeURIComponent(resolveLocale(locale))}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

function redirectResponse(
  request: Request,
  pathname: string,
  preserveSearch = false,
): Response {
  const url = new URL(request.url);
  url.pathname = normalizePathname(pathname);
  if (!preserveSearch) url.search = "";
  const headers = new Headers({
    location: url.toString(),
    "x-pathname": url.pathname,
  });
  const locale = localeFromPathname(url.pathname);
  if (locale) headers.append("set-cookie", localeCookie(locale));
  return new Response(null, { status: 307, headers });
}

export async function resolvePageRequest(
  request: Request,
  env: Env,
  internalFetch: InternalFetch,
): Promise<PageRequestDecision> {
  const url = new URL(request.url);
  const { pathname } = url;
  const normalizedPathname = normalizePathname(pathname);
  const localeFromPath = localeFromPathname(pathname);
  const localeForRequest = localeFromPath || requestLocale(request);
  const demoMode = env.DEMO_MODE === "1";

  if (demoMode) {
    if (!pathnameHasLocale(pathname)) {
      return {
        locale: localeForRequest,
        pathname,
        response: redirectResponse(
          request,
          localizedPath(pathname, localeForRequest),
          true,
        ),
      };
    }
    if (normalizedPathname === `/${localeFromPath}`) {
      return {
        locale: localeFromPath,
        pathname,
        response: redirectResponse(request, `/${localeFromPath}/app`, true),
      };
    }
    const rest = normalizePathname(pathname.replace(/^\/[^/]+/, "") || "/");
    if (rest === "/app") {
      return {
        locale: localeFromPath,
        pathname,
        response: redirectResponse(
          request,
          `/${localeFromPath}/app/${DEMO_DEFAULT_TEAM_SLUG}`,
        ),
      };
    }
    if (rest === "/login") {
      return {
        locale: localeFromPath,
        pathname,
        response: redirectResponse(request, `/${localeFromPath}/app`),
      };
    }
    return { locale: localeFromPath, pathname, response: null };
  }

  if (
    normalizedPathname !== `/${localeForRequest}/runtime-config-error` &&
    !hasRootSecret(env)
  ) {
    return {
      locale: localeForRequest,
      pathname,
      response: redirectResponse(
        request,
        `/${resolveLocale(localeForRequest)}/runtime-config-error`,
      ),
    };
  }

  if (!pathnameHasLocale(pathname)) {
    return {
      locale: localeForRequest,
      pathname,
      response: redirectResponse(
        request,
        localizedPath(pathname, localeForRequest),
        true,
      ),
    };
  }
  if (normalizedPathname === `/${localeFromPath}`) {
    return {
      locale: localeFromPath,
      pathname,
      response: redirectResponse(request, `/${localeFromPath}/app`, true),
    };
  }

  let state: AuthState | null = null;
  const ensureAuthState = async () => {
    state ??= await authState(request, env);
    return state;
  };
  const restPath = pathname.replace(/^\/[^/]+/, "") || "/";
  const normalizedRestPath = normalizePathname(restPath);

  if (restPath.startsWith("/app")) {
    if ((await ensureAuthState()) === "unauthenticated") {
      const loginUrl = new URL(`/${localeFromPath}/login`, request.url);
      loginUrl.searchParams.set("next", `${pathname}${url.search}`);
      const headers = new Headers({
        location: loginUrl.toString(),
        "x-pathname": loginUrl.pathname,
      });
      headers.append(
        "set-cookie",
        localeCookie(localeFromPath || DEFAULT_LOCALE),
      );
      return {
        locale: localeFromPath,
        pathname,
        response: new Response(null, { status: 307, headers }),
      };
    }

    const segments = normalizedRestPath.split("/").filter(Boolean);
    if (segments.length === 1) {
      const profile = await fetchRedirectProfile(request, internalFetch);
      if (profile?.teams.length === 1) {
        return {
          locale: localeFromPath,
          pathname,
          response: redirectResponse(
            request,
            `/${localeFromPath}/app/${profile.teams[0].slug}`,
          ),
        };
      }
    }
    if (segments.length === 2) {
      const tab = url.searchParams.get("tab");
      if (tab === "settings" || tab === "members") {
        return {
          locale: localeFromPath,
          pathname,
          response: redirectResponse(
            request,
            `/${localeFromPath}/app/${segments[1]}/${tab}`,
          ),
        };
      }
    }
  }

  if (
    normalizedRestPath === "/login" &&
    (await ensureAuthState()) === "authenticated"
  ) {
    return {
      locale: localeFromPath,
      pathname,
      response: redirectResponse(request, `/${localeFromPath}/app`),
    };
  }

  return { locale: localeFromPath, pathname, response: null };
}

export async function middleware(
  request: Request,
  env?: Env,
  internalFetch: InternalFetch = fetch,
): Promise<Response> {
  const runtimeEnv =
    env ??
    ({
      ...process.env,
      DEMO_MODE: process.env.VITE_DEMO_MODE,
    } as unknown as Env);
  initializeE2eClock(runtimeEnv);
  const decision = await resolvePageRequest(request, runtimeEnv, internalFetch);
  if (decision.response) return decision.response;
  const headers = new Headers({ "x-pathname": decision.pathname });
  if (decision.locale) {
    headers.append("set-cookie", localeCookie(decision.locale));
  }
  return new Response(null, { status: 200, headers });
}
