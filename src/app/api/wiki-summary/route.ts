import { resolveLocale } from "@/lib/i18n/config";

const WIKIDATA_API_ENDPOINT = "https://www.wikidata.org/w/api.php";
const DEFAULT_WIKI_LANGUAGE = "en";
const CACHE_CONTROL_HEADER =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

interface WikidataTerm {
  value?: string;
}

interface WikidataSitelink {
  title?: string;
  url?: string;
}

interface WikidataEntity {
  id?: string;
  labels?: Record<string, WikidataTerm>;
  descriptions?: Record<string, WikidataTerm>;
  sitelinks?: Record<string, WikidataSitelink>;
}

interface WikidataEntityResponse {
  entities?: Record<string, WikidataEntity>;
}

interface WikipediaSummaryResponse {
  title?: string;
  description?: string;
  extract?: string;
  extract_html?: string;
  thumbnail?: {
    source?: string;
  };
  content_urls?: {
    desktop?: {
      page?: string;
    };
    mobile?: {
      page?: string;
    };
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": CACHE_CONTROL_HEADER,
    },
  });
}

function isValidWikidataId(value: string): boolean {
  return /^Q\d+$/i.test(value);
}

function normalizeWikiLanguage(
  rawLanguage: string | null | undefined,
): string {
  const normalized = String(rawLanguage ?? "").trim().toLowerCase();
  if (!normalized) return DEFAULT_WIKI_LANGUAGE;
  const [base] = normalized.split("-");
  return /^[a-z]{2,12}$/.test(base) ? base : DEFAULT_WIKI_LANGUAGE;
}

function resolveWikipediaAcceptLanguage(request: Request): string | null {
  const url = new URL(request.url);
  const explicitLanguage = String(url.searchParams.get("lang") ?? "").trim();
  if (/^zh[-_](cn|hans)$/i.test(explicitLanguage)) {
    return "zh-CN,zh;q=0.9,en;q=0.8";
  }
  if (/^zh[-_](tw|hk|hant)$/i.test(explicitLanguage)) {
    return "zh-TW,zh;q=0.9,en;q=0.8";
  }

  const locale = resolveLocale(url.searchParams.get("locale"));
  return locale === "zh" ? "zh-CN,zh;q=0.9,en;q=0.8" : null;
}

function applyWikipediaVariantToUrl(
  pageUrl: string | null,
  acceptLanguage: string | null,
): string | null {
  if (!pageUrl || !acceptLanguage) return pageUrl;
  if (!pageUrl.startsWith("https://zh.wikipedia.org/")) return pageUrl;

  const variant = acceptLanguage.startsWith("zh-TW") ? "zh-tw" : "zh-cn";
  try {
    const url = new URL(pageUrl);
    url.searchParams.set("variant", variant);
    return url.toString();
  } catch {
    return pageUrl;
  }
}

function resolveRequestedWikiLanguage(request: Request): string {
  const url = new URL(request.url);
  const explicitLanguage = url.searchParams.get("lang");
  if (explicitLanguage) {
    return normalizeWikiLanguage(explicitLanguage);
  }
  const locale = resolveLocale(url.searchParams.get("locale"));
  return locale === "zh" ? "zh" : DEFAULT_WIKI_LANGUAGE;
}

function pickPreferredValue(
  values: Record<string, WikidataTerm> | undefined,
  languages: readonly string[],
): string | null {
  if (!values) return null;
  for (const language of languages) {
    const candidate = String(values[language]?.value ?? "").trim();
    if (candidate) return candidate;
  }
  return null;
}

function resolvePreferredSitelink(
  sitelinks: Record<string, WikidataSitelink> | undefined,
  languages: readonly string[],
): {
  language: string;
  title: string;
  url: string | null;
} | null {
  if (!sitelinks) return null;

  for (const language of languages) {
    const sitelink = sitelinks[`${language}wiki`];
    const title = String(sitelink?.title ?? "").trim();
    if (!title) continue;

    const url = String(sitelink?.url ?? "").trim() || null;
    return {
      language,
      title,
      url,
    };
  }

  return null;
}

async function fetchWikidataEntity(
  wikidataId: string,
): Promise<WikidataEntity | null> {
  const url = new URL(WIKIDATA_API_ENDPOINT);
  url.searchParams.set("action", "wbgetentities");
  url.searchParams.set("ids", wikidataId);
  url.searchParams.set("props", "labels|descriptions|sitelinks/urls");
  url.searchParams.set("format", "json");

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
    next: {
      revalidate: 60 * 60 * 24,
    },
  });

  if (!response.ok) {
    throw new Error(`Wikidata upstream failed with ${response.status}`);
  }

  const payload = (await response.json()) as WikidataEntityResponse;
  const entity = payload.entities?.[wikidataId];
  return entity ?? null;
}

async function fetchWikipediaSummary(
  language: string,
  title: string,
  acceptLanguage: string | null,
): Promise<WikipediaSummaryResponse | null> {
  const endpoint = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
      ...(acceptLanguage ? { "accept-language": acceptLanguage } : {}),
    },
    next: {
      revalidate: 60 * 60 * 24,
    },
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Wikipedia upstream failed with ${response.status}`);
  }

  return (await response.json()) as WikipediaSummaryResponse;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const wikidataId = String(url.searchParams.get("wikidataId") ?? "")
    .trim()
    .toUpperCase();

  if (!isValidWikidataId(wikidataId)) {
    return jsonResponse(
      {
        ok: false,
        error: "Invalid or missing wikidataId",
      },
      400,
    );
  }

  const requestedLanguage = resolveRequestedWikiLanguage(request);
  const acceptLanguage = resolveWikipediaAcceptLanguage(request);
  const preferredLanguages = Array.from(
    new Set([requestedLanguage, DEFAULT_WIKI_LANGUAGE]),
  );

  try {
    const entity = await fetchWikidataEntity(wikidataId);
    if (!entity) {
      return jsonResponse(
        {
          ok: false,
          error: "Wikidata entity not found",
        },
        404,
      );
    }

    const label =
      pickPreferredValue(entity.labels, preferredLanguages) ?? wikidataId;
    const description = pickPreferredValue(
      entity.descriptions,
      preferredLanguages,
    );
    const sitelink = resolvePreferredSitelink(
      entity.sitelinks,
      preferredLanguages,
    );

    let wikipedia:
      | {
          language: string;
          title: string;
          description: string | null;
          extract: string | null;
          extractHtml: string | null;
          thumbnailUrl: string | null;
          pageUrl: string | null;
        }
      | null = null;

    if (sitelink) {
      const summary = await fetchWikipediaSummary(
        sitelink.language,
        sitelink.title,
        acceptLanguage,
      );

      const resolvedPageUrl =
        String(summary?.content_urls?.desktop?.page ?? "").trim() ||
        sitelink.url ||
        null;

      wikipedia = {
        language: sitelink.language,
        title: String(summary?.title ?? sitelink.title).trim() || sitelink.title,
        description:
          String(summary?.description ?? "").trim() ||
          description ||
          null,
        extract: String(summary?.extract ?? "").trim() || null,
        extractHtml: String(summary?.extract_html ?? "").trim() || null,
        thumbnailUrl:
          String(summary?.thumbnail?.source ?? "").trim() || null,
        pageUrl: applyWikipediaVariantToUrl(resolvedPageUrl, acceptLanguage),
      };
    }

    return jsonResponse({
      ok: true,
      wikidataId,
      requestedLanguage,
      resolvedLanguage: wikipedia?.language ?? sitelink?.language ?? null,
      fallback:
        Boolean(wikipedia?.language || sitelink?.language) &&
        (wikipedia?.language ?? sitelink?.language) !== requestedLanguage,
      wikidata: {
        id: entity.id ?? wikidataId,
        label,
        description,
      },
      wikipedia,
    });
  } catch {
    return jsonResponse(
      {
        ok: false,
        error: "Wiki upstream unavailable",
      },
      502,
    );
  }
}
