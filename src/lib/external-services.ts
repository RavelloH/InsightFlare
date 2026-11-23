/**
 * Browser-side external services used by the dashboard. All of them are open
 * source and can be self-hosted; each base URL can be overridden with an
 * environment variable (HTTPS only, invalid values fall back to the default):
 *
 * - CANIUSE_API_BASE_URL     https://github.com/RavelloH/can-i-use-api
 * - GEO_LOCALE_API_BASE_URL  https://github.com/RavelloH/iso-3166-2-locale
 * - SITE_META_API_BASE_URL   referrer site metadata (titles / icons)
 *
 * The map tile relay is fetched server-side and is configured separately with
 * MAP_RELAY_BASE_URL (see src/lib/edge/resources/map-relay.ts).
 *
 * The server resolves the values once per request (root route loader), they are
 * dehydrated with the SSR payload, and `setExternalServices` stores them for the
 * client code that builds request URLs.
 */
export interface ExternalServices {
  readonly caniuseBaseUrl: string;
  readonly geoLocaleBaseUrl: string;
  readonly siteMetaBaseUrl: string;
}

export const DEFAULT_EXTERNAL_SERVICES: ExternalServices = {
  caniuseBaseUrl: "https://caniuse.ravelloh.com",
  geoLocaleBaseUrl: "https://locale.ravelloh.com",
  siteMetaBaseUrl: "https://meta.ravelloh.com",
};

export interface ExternalServicesEnv {
  CANIUSE_API_BASE_URL?: string;
  GEO_LOCALE_API_BASE_URL?: string;
  SITE_META_API_BASE_URL?: string;
}

/** Accepts an absolute HTTPS URL; keeps its path (sub-path deployments) without a trailing slash. */
export function normalizeServiceBaseUrl(
  value: string | undefined,
  fallback: string,
): string {
  const configured = value?.trim();
  if (!configured) return fallback;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.search || url.hash) return fallback;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return fallback;
  }
}

export function resolveExternalServices(
  env: ExternalServicesEnv | undefined,
): ExternalServices {
  return {
    caniuseBaseUrl: normalizeServiceBaseUrl(
      env?.CANIUSE_API_BASE_URL,
      DEFAULT_EXTERNAL_SERVICES.caniuseBaseUrl,
    ),
    geoLocaleBaseUrl: normalizeServiceBaseUrl(
      env?.GEO_LOCALE_API_BASE_URL,
      DEFAULT_EXTERNAL_SERVICES.geoLocaleBaseUrl,
    ),
    siteMetaBaseUrl: normalizeServiceBaseUrl(
      env?.SITE_META_API_BASE_URL,
      DEFAULT_EXTERNAL_SERVICES.siteMetaBaseUrl,
    ),
  };
}

let current: ExternalServices = DEFAULT_EXTERNAL_SERVICES;

/** Stores the resolved services (called while rendering the root document). */
export function setExternalServices(services: ExternalServices | undefined) {
  if (services) current = services;
}

/** The base URLs to use when building requests. */
export function externalServices(): ExternalServices {
  return current;
}
