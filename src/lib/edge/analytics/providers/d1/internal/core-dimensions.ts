import { browserEngineCaseSql } from "@/lib/browser-engine";

import {
  type ClientDimensionKey,
  DIRECT_REFERRER_FILTER_VALUE,
  type UtmDimensionKey,
} from "./core-types";

export function shareTrendSeriesKey(
  label: string,
  usedKeys: Set<string>,
  fallbackBase: string,
): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = normalized || fallbackBase;
  let candidate = base;
  let suffix = 2;

  while (usedKeys.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  usedKeys.add(candidate);
  return candidate;
}

export function normalizePathname(pathname: string): string {
  const normalized = String(pathname || "").trim();
  return normalized.length > 0 ? normalized : "/";
}

export function formatPageLabel(
  pathname: string,
  query = "",
  hash = "",
  includeDetails = false,
): string {
  const base = normalizePathname(pathname);
  if (!includeDetails) return base;
  return `${base}${query || ""}${hash || ""}`;
}

export function osVersionExpr(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `trim(CASE WHEN ${prefix}os != '' AND ${prefix}os_version != '' THEN ${prefix}os || ' ' || ${prefix}os_version WHEN ${prefix}os != '' THEN ${prefix}os WHEN ${prefix}os_version != '' THEN ${prefix}os_version ELSE '' END)`;
}

export function browserMajorVersionExpr(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `trim(CASE WHEN ${prefix}browser_version = '' THEN '' WHEN instr(${prefix}browser_version, '.') > 0 THEN substr(${prefix}browser_version, 1, instr(${prefix}browser_version, '.') - 1) ELSE ${prefix}browser_version END)`;
}

export function screenSizeExpr(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `CASE WHEN ${prefix}screen_width > 0 AND ${prefix}screen_height > 0 THEN CAST(${prefix}screen_width AS TEXT) || 'x' || CAST(${prefix}screen_height AS TEXT) ELSE '' END`;
}

export function clientDimensionDefinition(
  dimension: ClientDimensionKey,
  alias = "",
): { labelExpr: string; fallbackKeyBase: string } {
  if (dimension === "browser") {
    return {
      labelExpr: `TRIM(COALESCE(${alias ? `${alias}.` : ""}browser, ''))`,
      fallbackKeyBase: "browser",
    };
  }
  if (dimension === "operatingSystem") {
    return {
      labelExpr: `TRIM(COALESCE(${alias ? `${alias}.` : ""}os, ''))`,
      fallbackKeyBase: "os",
    };
  }
  if (dimension === "osVersion") {
    return {
      labelExpr: osVersionExpr(alias),
      fallbackKeyBase: "os-version",
    };
  }
  if (dimension === "deviceType") {
    return {
      labelExpr: `TRIM(COALESCE(${alias ? `${alias}.` : ""}device_type, ''))`,
      fallbackKeyBase: "device",
    };
  }
  if (dimension === "language") {
    return {
      labelExpr: `TRIM(COALESCE(${alias ? `${alias}.` : ""}language, ''))`,
      fallbackKeyBase: "language",
    };
  }
  return {
    labelExpr: screenSizeExpr(alias),
    fallbackKeyBase: "screen",
  };
}

export function utmDimensionDefinition(
  dimension: UtmDimensionKey,
  alias = "",
): { labelExpr: string; fallbackKeyBase: string } {
  const prefix = alias ? `${alias}.` : "";

  if (dimension === "source") {
    return {
      labelExpr: `TRIM(COALESCE(${prefix}utm_source, ''))`,
      fallbackKeyBase: "utm-source",
    };
  }
  if (dimension === "medium") {
    return {
      labelExpr: `TRIM(COALESCE(${prefix}utm_medium, ''))`,
      fallbackKeyBase: "utm-medium",
    };
  }
  if (dimension === "campaign") {
    return {
      labelExpr: `TRIM(COALESCE(${prefix}utm_campaign, ''))`,
      fallbackKeyBase: "utm-campaign",
    };
  }
  if (dimension === "term") {
    return {
      labelExpr: `TRIM(COALESCE(${prefix}utm_term, ''))`,
      fallbackKeyBase: "utm-term",
    };
  }

  return {
    labelExpr: `TRIM(COALESCE(${prefix}utm_content, ''))`,
    fallbackKeyBase: "utm-content",
  };
}

export function referrerDomainDimensionDefinition(alias = ""): {
  labelExpr: string;
  fallbackKeyBase: string;
} {
  const prefix = alias ? `${alias}.` : "";

  return {
    labelExpr: `CASE WHEN TRIM(COALESCE(${prefix}referrer_host, '')) != '' THEN TRIM(COALESCE(${prefix}referrer_host, '')) ELSE '${DIRECT_REFERRER_FILTER_VALUE}' END`,
    fallbackKeyBase: "referrer-domain",
  };
}

export function regionValueExpr(): string {
  return "CASE WHEN TRIM(country) = '' AND TRIM(region_code) = '' AND TRIM(region) = '' THEN '' ELSE TRIM(country) || '::' || CASE WHEN TRIM(region_code) != '' THEN TRIM(region_code) ELSE TRIM(region) END || '::' || TRIM(region) END";
}

export function cityValueExpr(): string {
  return "CASE WHEN TRIM(country) = '' AND TRIM(region_code) = '' AND TRIM(region) = '' AND TRIM(city) = '' THEN '' ELSE TRIM(country) || '::' || CASE WHEN TRIM(region_code) != '' THEN TRIM(region_code) ELSE TRIM(region) END || '::' || TRIM(region) || '::' || TRIM(city) END";
}

export function resolveCrossBreakdownDimension(
  dimension: string,
): { labelExpr: string; fallbackKeyBase: string } | null {
  // ── page ──────────────────────────────────────────────────────────────
  if (dimension === "page.path")
    return {
      labelExpr: "TRIM(COALESCE(pathname, ''))",
      fallbackKeyBase: "page",
    };
  if (dimension === "page.title")
    return { labelExpr: "TRIM(COALESCE(title, ''))", fallbackKeyBase: "title" };
  if (dimension === "page.hostname")
    return {
      labelExpr: "TRIM(COALESCE(hostname, ''))",
      fallbackKeyBase: "hostname",
    };
  if (dimension === "page.query")
    return {
      labelExpr: "TRIM(COALESCE(query_string, ''))",
      fallbackKeyBase: "query",
    };
  if (dimension === "page.hash")
    return {
      labelExpr: "TRIM(COALESCE(hash_fragment, ''))",
      fallbackKeyBase: "hash",
    };

  // ── session (requires session-level aggregation, not supported) ───────
  if (dimension === "session.entryPath" || dimension === "session.exitPath")
    return null;

  // ── referrer ──────────────────────────────────────────────────────────
  if (dimension === "referrer.domain")
    return referrerDomainDimensionDefinition();
  if (dimension === "referrer.url")
    return {
      labelExpr: "TRIM(COALESCE(referrer_url, ''))",
      fallbackKeyBase: "referrer-url",
    };

  // ── utm ───────────────────────────────────────────────────────────────
  if (dimension === "utm.source") return utmDimensionDefinition("source");
  if (dimension === "utm.medium") return utmDimensionDefinition("medium");
  if (dimension === "utm.campaign") return utmDimensionDefinition("campaign");
  if (dimension === "utm.term") return utmDimensionDefinition("term");
  if (dimension === "utm.content") return utmDimensionDefinition("content");

  // ── client ────────────────────────────────────────────────────────────
  if (dimension === "client.browser" || dimension === "browser")
    return clientDimensionDefinition("browser");
  if (dimension === "client.browserVersion")
    return {
      labelExpr: "TRIM(COALESCE(browser_version, ''))",
      fallbackKeyBase: "browser-version",
    };
  if (dimension === "client.browserEngine")
    return {
      labelExpr: browserEngineCaseSql("browser", "os"),
      fallbackKeyBase: "engine",
    };
  if (dimension === "client.os" || dimension === "operatingSystem")
    return clientDimensionDefinition("operatingSystem");
  if (dimension === "client.osVersion" || dimension === "osVersion")
    return clientDimensionDefinition("osVersion");
  if (dimension === "client.deviceType" || dimension === "deviceType")
    return clientDimensionDefinition("deviceType");
  if (dimension === "client.language" || dimension === "language")
    return clientDimensionDefinition("language");
  if (dimension === "client.screenSize" || dimension === "screenSize")
    return clientDimensionDefinition("screenSize");

  // ── geo ───────────────────────────────────────────────────────────────
  if (dimension === "geo.country")
    return {
      labelExpr: "TRIM(COALESCE(country, ''))",
      fallbackKeyBase: "country",
    };
  if (dimension === "geo.region")
    return { labelExpr: regionValueExpr(), fallbackKeyBase: "region" };
  if (dimension === "geo.city")
    return { labelExpr: cityValueExpr(), fallbackKeyBase: "city" };
  if (dimension === "geo.continent")
    return {
      labelExpr: "TRIM(COALESCE(continent, ''))",
      fallbackKeyBase: "continent",
    };
  if (dimension === "geo.timeZone")
    return {
      labelExpr: "TRIM(COALESCE(timezone, ''))",
      fallbackKeyBase: "timezone",
    };
  if (dimension === "geo.organization")
    return {
      labelExpr: "TRIM(COALESCE(as_organization, ''))",
      fallbackKeyBase: "organization",
    };

  // ── event (requires events table join, not supported) ─────────────────
  return null;
}
