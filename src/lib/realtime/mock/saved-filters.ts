import {
  analyticsFilterRegistry,
  assertFilterAudience,
  FILTER_DSL_MAX_LENGTH,
  parseFilterDsl,
} from "@/lib/filter-contract";
import {
  SAVED_FILTER_DSL_VERSION,
  SAVED_FILTER_SCOPE_PREFERENCES,
  SAVED_FILTER_VISIBILITIES,
  type SavedFilter,
  type SavedFilterInput,
  type SavedFilterScopePreference,
  type SavedFilterVisibility,
} from "@/lib/saved-filters";

import { demoBadRequest, demoNotFound } from "./envelope";

const DEMO_USER_ID = "demo-user-001";
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;

interface SavedFilterPreset {
  readonly name: string;
  readonly description: string;
  readonly visibility: SavedFilterVisibility;
  readonly scopePreference?: SavedFilterScopePreference;
  readonly filterDsl: string;
  readonly ownerUserId?: string;
  readonly authorName?: string;
}

const FILTER_PRESETS: Readonly<Record<string, readonly SavedFilterPreset[]>> = {
  "demo-site-001": [
    {
      name: "Pricing and demo intent",
      description:
        "High-intent visitors researching products, pricing, and contact options.",
      visibility: "private",
      filterDsl:
        '(page.path eq "/pricing" OR page.path eq "/products" OR page.path eq "/contact") AND referrer.domain in ["google.com", "linkedin.com", "bing.com"] AND geo.country in ["US", "GB", "DE"]',
    },
    {
      name: "Partner research traffic",
      description:
        "Partner and solutions research from professional referral channels.",
      visibility: "team",
      filterDsl:
        '(page.path eq "/partners" OR page.path eq "/solutions") AND referrer.domain in ["linkedin.com", "google.com"] AND NOT client.deviceType eq "mobile"',
    },
    {
      name: "Recruiting audience",
      description: "Career candidates exploring roles and company information.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        '(page.path eq "/careers" OR page.path eq "/about") AND referrer.domain in ["linkedin.com", "google.com"] AND geo.country in ["US", "GB", "CA"]',
    },
  ],
  "demo-site-002": [
    {
      name: "Checkout recovery audience",
      description:
        "Cart and checkout visitors from high-value acquisition sources.",
      visibility: "private",
      filterDsl:
        '(page.path eq "/cart" OR page.path eq "/checkout") AND referrer.domain in ["google.com", "instagram.com", "facebook.com"] AND client.deviceType in ["mobile", "desktop"]',
    },
    {
      name: "Sale discovery traffic",
      description:
        "Visitors finding the sale and new-arrivals collection through search and social.",
      visibility: "team",
      filterDsl:
        '(page.path eq "/sale" OR page.path eq "/collections/new-arrivals") AND referrer.domain in ["google.com", "pinterest.com", "instagram.com"] AND geo.country in ["US", "GB", "DE"]',
    },
    {
      name: "Mobile social shoppers",
      description:
        "Mobile visitors arriving from visual social shopping channels.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        'client.deviceType eq "mobile" AND referrer.domain in ["instagram.com", "facebook.com", "tiktok.com"] AND page.path startsWith "/products"',
    },
  ],
  "demo-site-003": [
    {
      name: "Politics and tech referrals",
      description:
        "News discovery traffic for political and technology coverage.",
      visibility: "private",
      filterDsl:
        '(page.path eq "/politics" OR page.path eq "/tech") AND referrer.domain in ["news.google.com", "google.com", "twitter.com"] AND geo.country in ["US", "GB", "CA"]',
    },
    {
      name: "Returning direct readers",
      description:
        "Direct readership of core editorial sections on desktop and tablet.",
      visibility: "team",
      filterDsl:
        'referrer.domain eq "__direct__" AND page.path in ["/world", "/business", "/opinion"] AND client.deviceType in ["desktop", "tablet"]',
    },
    {
      name: "Newsletter discovery audience",
      description:
        "Article discovery traffic from major news aggregation sources.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        'referrer.domain in ["news.google.com", "apple.news", "flipboard.com"] AND page.path in ["/politics", "/science", "/health"] AND NOT geo.country eq "US"',
    },
  ],
  "demo-site-004": [
    {
      name: "Paid and social launch traffic",
      description:
        "Campaign landing traffic from paid and social acquisition channels.",
      visibility: "private",
      filterDsl:
        '(utm.source exists OR utm.medium exists) AND referrer.domain in ["facebook.com", "instagram.com", "tiktok.com"] AND page.path in ["/", "/features", "/pricing"]',
    },
    {
      name: "Pricing to get-started intent",
      description:
        "Visitors moving between pricing and the primary conversion page.",
      visibility: "team",
      filterDsl:
        '(page.path eq "/pricing" OR page.path eq "/get-started") AND referrer.domain in ["google.com", "linkedin.com", "producthunt.com"] AND geo.country in ["US", "CA", "GB"]',
    },
    {
      name: "Desktop B2B referrals",
      description:
        "Desktop prospects arriving through professional and launch communities.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        'client.deviceType eq "desktop" AND referrer.domain in ["linkedin.com", "producthunt.com", "google.com"] AND page.path in ["/features", "/testimonials", "/get-started"]',
    },
  ],
  "demo-site-005": [
    {
      name: "Authentication and webhook setup",
      description:
        "Developers working through authentication and webhook integration guides.",
      visibility: "private",
      filterDsl:
        '(page.path eq "/guides/authentication" OR page.path eq "/guides/webhooks") AND referrer.domain in ["google.com", "github.com", "stackoverflow.com"] AND client.deviceType eq "desktop"',
    },
    {
      name: "SDK discovery traffic",
      description: "SDK readers from developer communities and organic search.",
      visibility: "team",
      filterDsl:
        'page.path startsWith "/sdk" AND referrer.domain in ["github.com", "google.com", "dev.to"] AND geo.country in ["US", "IN", "DE", "CN"]',
    },
    {
      name: "Troubleshooting search readers",
      description:
        "Developers troubleshooting integrations through search and Q&A referrals.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        'page.path in ["/troubleshooting", "/migration-guide", "/api-reference"] AND referrer.domain in ["google.com", "stackoverflow.com", "bing.com"] AND NOT client.deviceType eq "mobile"',
    },
  ],
  "demo-site-006": [
    {
      name: "Billing and integrations power users",
      description:
        "Engaged account administrators working on billing and integrations.",
      visibility: "private",
      filterDsl:
        '(page.path eq "/billing" OR page.path eq "/integrations" OR page.path eq "/api-keys") AND referrer.domain eq "__direct__" AND client.deviceType eq "desktop"',
    },
    {
      name: "Reports and alerts workflow",
      description:
        "Operations users exploring reports, alerts, and analytics workflows.",
      visibility: "team",
      filterDsl:
        'page.path in ["/reports", "/alerts", "/analytics"] AND client.deviceType in ["desktop", "tablet"] AND geo.country in ["US", "DE", "GB", "CA"]',
    },
    {
      name: "Product-led acquisition",
      description:
        "New product interest from search, launch, and professional networks.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        'referrer.domain in ["google.com", "producthunt.com", "linkedin.com"] AND page.path in ["/", "/dashboard", "/analytics"] AND NOT geo.country eq "US"',
    },
  ],
  "demo-site-007": [
    {
      name: "Installation and configuration contributors",
      description:
        "Developers setting up the project from core technical sources.",
      visibility: "private",
      filterDsl:
        '(page.path eq "/docs/installation" OR page.path eq "/docs/configuration") AND referrer.domain in ["github.com", "google.com", "stackoverflow.com"] AND client.deviceType eq "desktop"',
    },
    {
      name: "Examples and playground engagement",
      description:
        "Visitors evaluating examples and interactive project workflows.",
      visibility: "team",
      filterDsl:
        'page.path in ["/examples", "/playground", "/docs/plugins"] AND referrer.domain in ["github.com", "dev.to", "hackernews.com"] AND geo.country in ["US", "IN", "DE", "BR"]',
    },
    {
      name: "Community referral traffic",
      description:
        "Community-minded visitors from project and developer discussion channels.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        'referrer.domain in ["github.com", "reddit.com", "hackernews.com"] AND page.path in ["/community", "/blog", "/sponsors"] AND NOT client.deviceType eq "mobile"',
    },
  ],
  "demo-site-008": [
    {
      name: "Authentication and rate-limit users",
      description:
        "API consumers researching access control and request limits.",
      visibility: "private",
      filterDsl:
        '(page.path eq "/v2/authentication" OR page.path eq "/v2/rate-limits") AND referrer.domain in ["google.com", "github.com", "stackoverflow.com"] AND client.deviceType eq "desktop"',
    },
    {
      name: "SDK adopter traffic",
      description:
        "Developers discovering SDK documentation from technical channels.",
      visibility: "team",
      filterDsl:
        'page.path startsWith "/sdks" AND referrer.domain in ["github.com", "dev.to", "google.com"] AND geo.country in ["US", "IN", "DE", "GB"]',
    },
    {
      name: "Webhook error troubleshooting",
      description:
        "Integration debugging traffic focused on webhooks and API errors.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        '(page.path eq "/v2/webhooks" OR page.path eq "/v2/errors") AND referrer.domain in ["google.com", "stackoverflow.com", "bing.com"] AND NOT client.deviceType eq "mobile"',
    },
  ],
  "demo-site-009": [
    {
      name: "Deep technical readership",
      description:
        "Readers exploring technical essays from search and developer channels.",
      visibility: "private",
      filterDsl:
        'page.path in ["/posts/rust-vs-go", "/posts/side-project-lessons", "/posts/building-in-public"] AND referrer.domain in ["google.com", "github.com", "reddit.com"] AND geo.country in ["US", "CN", "JP", "SG"]',
    },
    {
      name: "Newsletter-ready readers",
      description:
        "Engaged readers arriving directly or through recurring social sources.",
      visibility: "team",
      filterDsl:
        '(referrer.domain eq "__direct__" OR referrer.domain in ["twitter.com", "weibo.com"]) AND page.path startsWith "/posts" AND client.deviceType in ["desktop", "mobile"]',
    },
    {
      name: "Chinese social discovery",
      description:
        "Chinese-language discovery traffic from regional search and social sources.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        'geo.country in ["CN", "TW", "SG"] AND referrer.domain in ["baidu.com", "weibo.com", "zhihu.com"] AND page.path startsWith "/posts"',
    },
  ],
  "demo-site-010": [
    {
      name: "Help and category participants",
      description:
        "Community members navigating support and general discussion categories.",
      visibility: "private",
      filterDsl:
        '(page.path eq "/categories/help" OR page.path eq "/categories/general") AND (referrer.domain eq "__direct__" OR referrer.domain in ["google.com", "github.com"]) AND client.deviceType in ["desktop", "tablet"]',
    },
    {
      name: "Showcase and challenge traffic",
      description:
        "Creative community traffic around showcases and challenges.",
      visibility: "team",
      filterDsl:
        '(page.path eq "/categories/showcase" OR page.path eq "/t/monthly-challenge") AND referrer.domain in ["twitter.com", "reddit.com", "discord.com"] AND geo.country in ["US", "DE", "GB", "FR"]',
    },
    {
      name: "Direct returning members",
      description:
        "Returning community members arriving directly to active discussion areas.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        'referrer.domain eq "__direct__" AND page.path in ["/latest", "/categories/general", "/categories/help"] AND NOT client.deviceType eq "mobile"',
    },
  ],
  "demo-site-011": [
    {
      name: "Case-study leads",
      description: "Potential clients exploring portfolio work and services.",
      visibility: "private",
      filterDsl:
        '(page.path eq "/work/brand-identity" OR page.path eq "/work/web-design" OR page.path eq "/services") AND referrer.domain in ["google.com", "linkedin.com", "dribbble.com"] AND geo.country in ["US", "GB", "DE"]',
    },
    {
      name: "Design network referrals",
      description: "Portfolio discovery through design networks and galleries.",
      visibility: "team",
      filterDsl:
        'referrer.domain in ["dribbble.com", "behance.net", "pinterest.com"] AND page.path startsWith "/work" AND client.deviceType in ["desktop", "tablet"]',
    },
    {
      name: "Contact and services intent",
      description:
        "Visitors approaching contact and service information through professional sources.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        '(page.path eq "/contact" OR page.path eq "/services") AND referrer.domain in ["linkedin.com", "google.com", "instagram.com"] AND NOT geo.country eq "US"',
    },
  ],
  "demo-site-012": [
    {
      name: "Course progression learners",
      description: "Learners moving through core programming course content.",
      visibility: "private",
      filterDsl:
        'page.path in ["/courses/javascript-fundamentals", "/courses/python-data-science", "/courses/react-masterclass"] AND (referrer.domain eq "__direct__" OR referrer.domain in ["google.com", "youtube.com"]) AND client.deviceType in ["desktop", "mobile"]',
    },
    {
      name: "Certificate and pricing intent",
      description:
        "Learners evaluating certificates and paid learning options.",
      visibility: "team",
      filterDsl:
        '(page.path eq "/certificates" OR page.path eq "/pricing") AND referrer.domain in ["google.com", "linkedin.com", "quora.com"] AND geo.country in ["US", "IN", "BR", "GB"]',
    },
    {
      name: "Mobile global learners",
      description:
        "Mobile course discovery traffic across the platform's global learner base.",
      visibility: "team",
      ownerUserId: "demo-user-002",
      authorName: "Alex Rivera",
      filterDsl:
        'client.deviceType eq "mobile" AND geo.country in ["IN", "BR", "NG", "US"] AND referrer.domain in ["youtube.com", "google.com", "facebook.com"]',
    },
  ],
};

const filtersBySite = new Map<string, SavedFilter[]>();
let nextFilterId = 1;

function now(): number {
  return Math.floor(Date.now() / 1_000);
}

function seedFilters(siteId: string): SavedFilter[] {
  const seededAt = now();
  return (FILTER_PRESETS[siteId] ?? []).map((preset, index) => {
    const ownerUserId = preset.ownerUserId ?? DEMO_USER_ID;
    return {
      id: `demo-saved-filter-${siteId}-${index + 1}`,
      siteId,
      ownerUserId,
      authorName: preset.authorName ?? "Demo User",
      isOwner: ownerUserId === DEMO_USER_ID,
      visibility: preset.visibility,
      scopePreference: preset.scopePreference ?? "auto",
      name: preset.name,
      description: preset.description,
      filterDsl: preset.filterDsl,
      filterDslVersion: SAVED_FILTER_DSL_VERSION,
      createdAt: seededAt - (index + 1) * 3_600,
      updatedAt: seededAt - (index + 1) * 3_600,
    };
  });
}

function filtersForSite(siteId: string): SavedFilter[] {
  let filters = filtersBySite.get(siteId);
  if (!filters) {
    filters = seedFilters(siteId);
    filtersBySite.set(siteId, filters);
  }
  return filters;
}

function parseInput(
  body: unknown,
): SavedFilterInput | ReturnType<typeof demoBadRequest> {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description =
    typeof record.description === "string" ? record.description : null;
  const filterDsl =
    typeof record.filterDsl === "string" ? record.filterDsl : null;
  const visibility = record.visibility;
  const scopePreference =
    record.scopePreference === undefined ? "auto" : record.scopePreference;
  if (!name || name.length > MAX_NAME_LENGTH)
    return demoBadRequest("name is required");
  if (description === null || description.length > MAX_DESCRIPTION_LENGTH)
    return demoBadRequest("description is invalid");
  if (filterDsl === null || filterDsl.length > FILTER_DSL_MAX_LENGTH)
    return demoBadRequest("filterDsl is invalid");
  if (
    typeof visibility !== "string" ||
    !SAVED_FILTER_VISIBILITIES.includes(visibility as SavedFilterVisibility)
  ) {
    return demoBadRequest("visibility is invalid");
  }
  if (
    typeof scopePreference !== "string" ||
    !SAVED_FILTER_SCOPE_PREFERENCES.includes(
      scopePreference as SavedFilterScopePreference,
    )
  ) {
    return demoBadRequest("scopePreference is invalid");
  }
  try {
    const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
    if (!document.root)
      return demoBadRequest("filterDsl must contain a filter");
    assertFilterAudience(
      document,
      analyticsFilterRegistry,
      "private-dashboard",
    );
  } catch {
    return demoBadRequest("filterDsl is invalid");
  }
  return {
    name,
    description,
    visibility: visibility as SavedFilterVisibility,
    scopePreference: scopePreference as SavedFilterScopePreference,
    filterDsl,
  };
}

function inputIsError(
  input: SavedFilterInput | ReturnType<typeof demoBadRequest>,
): input is ReturnType<typeof demoBadRequest> {
  return "ok" in input && input.ok === false;
}

function routeFilterId(path: string): string | null {
  const matched = path.match(/^\/api\/private\/saved-filters\/([^/]+)$/);
  return matched ? decodeURIComponent(matched[1] ?? "") : null;
}

export function handleDemoSavedFilters(input: {
  readonly path: string;
  readonly method: string;
  readonly siteId: string;
  readonly body?: unknown;
}): unknown {
  const { path, method, siteId, body } = input;
  const filterId = routeFilterId(path);
  const filters = filtersForSite(siteId);

  if (method === "GET" && !filterId) return { filters: [...filters] };

  if (method === "POST" && !filterId) {
    const parsed = parseInput(body);
    if (inputIsError(parsed)) return parsed;
    if (
      filters.some(
        (filter) =>
          filter.ownerUserId === DEMO_USER_ID &&
          filter.filterDsl === parsed.filterDsl &&
          filter.scopePreference === parsed.scopePreference,
      )
    ) {
      return demoBadRequest("An identical saved filter already exists");
    }
    const timestamp = now();
    const filter: SavedFilter = {
      id: `demo-saved-filter-created-${nextFilterId++}`,
      siteId,
      ownerUserId: DEMO_USER_ID,
      authorName: "Demo User",
      isOwner: true,
      ...parsed,
      scopePreference: parsed.scopePreference ?? "auto",
      filterDslVersion: SAVED_FILTER_DSL_VERSION,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    filters.unshift(filter);
    return { filter };
  }

  if (!filterId) return demoNotFound("Saved filter not found");
  const index = filters.findIndex((filter) => filter.id === filterId);
  if (index < 0) return demoNotFound("Saved filter not found");
  const existing = filters[index]!;

  if (method === "GET") return { filter: existing };
  if (!existing.isOwner) return demoNotFound("Saved filter not found");

  if (method === "PUT") {
    const parsed = parseInput(body);
    if (inputIsError(parsed)) return parsed;
    if (
      filters.some(
        (filter) =>
          filter.id !== existing.id &&
          filter.ownerUserId === DEMO_USER_ID &&
          filter.filterDsl === parsed.filterDsl &&
          filter.scopePreference === parsed.scopePreference,
      )
    ) {
      return demoBadRequest("An identical saved filter already exists");
    }
    const updated: SavedFilter = { ...existing, ...parsed, updatedAt: now() };
    filters[index] = updated;
    return { filter: updated };
  }

  if (method === "DELETE") {
    filters.splice(index, 1);
    return { deletedId: existing.id };
  }
  return demoNotFound("Saved filter not found");
}
