/**
 * Field-name rules that turn the OpenAPI response example generator's
 * placeholders (`"example"`, `0`, `false`) into realistic, internally
 * consistent values.
 *
 * `exampleForSchema()` in generate-openapi.ts walks a response schema and, for
 * every scalar property, asks `ruleExample()` for a value first. A rule value is
 * only used when it satisfies the property's schema constraints (enum, bounds,
 * length, pattern, format); otherwise the generator falls back to a
 * constraint-aware value for the type. After an object's properties are filled
 * in, `refineObject()` makes related fields agree (bounceRate = bounces /
 * sessions, change = current - reference, percentiles ascending, pagination
 * counts, labels).
 *
 * The example story: site "Marketing site" (site_8f2c41a9), analysed over the
 * seven days ending 2026-11-22 00:00 UTC, with a comparison range one week
 * earlier. Array items get different values by index.
 */

import { ANALYTICS_DIMENSIONS } from "@/lib/edge/analytics/contract/catalog";
import {
  FILTER_DSL_EXAMPLES,
  FILTER_DSL_OPERATOR_IDS,
  FILTER_DSL_SYNTAX,
} from "@/lib/filter-contract/filter-dsl";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

export type ExampleContext = {
  /** Property names from the response root down to the current property. */
  readonly path: readonly string[];
  /** Names of the array properties that enclose the current value. */
  readonly lists: readonly string[];
  /** Index of the nearest enclosing array item (0 outside arrays). */
  readonly index: number;
  readonly operationId?: string;
};

export function rootExampleContext(operationId?: string): ExampleContext {
  return { path: [], lists: [], index: 0, operationId };
}

export function childExampleContext(
  ctx: ExampleContext,
  name: string,
  array?: { index: number },
): ExampleContext {
  return {
    path: [...ctx.path, name],
    lists: array ? [...ctx.lists, name] : ctx.lists,
    index: array ? array.index : ctx.index,
    operationId: ctx.operationId,
  };
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;
const NOW_MS = Date.UTC(2026, 10, 22, 8, 30, 12);
const RANGE_TO_MS = Date.UTC(2026, 10, 22);
const RANGE_FROM_MS = RANGE_TO_MS - 7 * DAY_MS;
const SITE_ID = "site_8f2c41a9";

const TOTAL_VIEWS = 12_840;
const AVG_DURATION_MS = 48_200;

function pick<T>(values: readonly T[], index: number): T {
  return values[((index % values.length) + values.length) % values.length];
}

function hex(seed: string, length: number): string {
  let h = 0x811c9dc5;
  let out = "";
  let round = 0;
  while (out.length < length) {
    const input = `${seed}:${round++}`;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

function prefixedId(prefix: string, name: string, ctx: ExampleContext) {
  return `${prefix}_${hex(`${name}:${ctx.index}`, 8)}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/* -------------------------------------------------------------------------- */
/* Context helpers                                                            */
/* -------------------------------------------------------------------------- */

const SERIES_LISTS =
  /^(points|series|timeseries|buckets|periods|cohorts|cells|trend)$/;
const SINGLE_OPERATIONS =
  /(Detail|Search|visitorEvents|visitorSessions|sessionEvents|realtime|journey)/i;

type ScaleKind = "total" | "rank" | "point" | "single";

function scaleKind(ctx: ExampleContext): ScaleKind {
  const list = ctx.lists[ctx.lists.length - 1];
  if (list && SERIES_LISTS.test(list)) return "point";
  if (ctx.operationId && SINGLE_OPERATIONS.test(ctx.operationId)) {
    return "single";
  }
  return list ? "rank" : "total";
}

function inReference(ctx: ExampleContext): boolean {
  return ctx.path.includes("reference");
}

type Metrics = {
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  totalDurationMs: number;
  durationViews: number;
  avgDurationMs: number;
  bounceRate: number;
  viewsPerSession: number;
  events: number;
};

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function deriveMetrics(
  views: number,
  sessions: number,
  reference = false,
): Metrics {
  const visitors = Math.max(1, Math.round(sessions * 0.764));
  const bounces = Math.round(sessions * (reference ? 0.45 : 0.42));
  const durationViews = Math.max(1, Math.round(views * 0.82));
  const avgDuration = reference ? 46_900 : AVG_DURATION_MS;
  return {
    views,
    sessions,
    visitors,
    bounces,
    durationViews,
    totalDurationMs: durationViews * avgDuration,
    avgDurationMs: avgDuration,
    bounceRate: sessions > 0 ? round(bounces / sessions, 4) : 0,
    viewsPerSession: sessions > 0 ? round(views / sessions, 2) : 0,
    events: Math.round(views * 1.35),
  };
}

function metricsFor(ctx: ExampleContext): Metrics {
  const kind = scaleKind(ctx);
  const i = ctx.index;
  let views: number;
  if (kind === "single") {
    views = pick([9, 5, 2], i);
    const sessions = pick([3, 2, 1], i);
    return deriveMetrics(views, sessions);
  }
  const factor =
    kind === "point"
      ? pick([0.14, 0.16, 0.15], i)
      : kind === "rank"
        ? pick([0.42, 0.27, 0.16], i)
        : 1;
  const reference = inReference(ctx) ? 0.87 : 1;
  views = Math.round(TOTAL_VIEWS * factor * reference);
  const sessions = Math.round(views * (reference === 1 ? 0.4058 : 0.4127));
  return deriveMetrics(views, sessions, reference !== 1);
}

/* -------------------------------------------------------------------------- */
/* Rule tables                                                                */
/* -------------------------------------------------------------------------- */

type Rule = readonly unknown[] | ((ctx: ExampleContext) => unknown);

const PATHNAMES = ["/pricing", "/", "/docs/getting-started"] as const;
const DEVICE_TYPES = ["desktop", "mobile", "tablet"] as const;

function parentName(ctx: ExampleContext): string {
  const path = ctx.path;
  return path.length >= 2 ? path[path.length - 2] : "";
}

function operationFamily(ctx: ExampleContext): string {
  return ctx.operationId?.split(".")[0] ?? "";
}

const SITE_IDS = [SITE_ID, "site_41ad90c2", "site_c07e5b13"] as const;

type Entity =
  | "token"
  | "team"
  | "site"
  | "funnel"
  | "goal"
  | "savedFilter"
  | "step"
  | "event"
  | "visit"
  | "session"
  | "visitor"
  | "batch"
  | "schemaField"
  | "operation"
  | "unknown";

const PARENT_ENTITIES: Record<string, Entity> = {
  token: "token",
  team: "team",
  site: "site",
  funnel: "funnel",
  goal: "goal",
  steps: "step",
  events: "event",
  visits: "visit",
  sessions: "session",
  visitors: "visitor",
  responses: "batch",
  operations: "operation",
};

const OPERATION_ENTITIES: Array<[RegExp, Entity]> = [
  [/^core\.token/, "token"],
  [/^core\.team/, "team"],
  [/^team\.analytics\.sites$/, "site"],
  [/^sites\./, "site"],
  [/^funnels\./, "funnel"],
  [/^goals\./, "goal"],
  [/^savedFilters\./, "savedFilter"],
  [/realtimeSessions|sessionsSearch|visitorSessions/, "session"],
  [
    /realtimeEvents|eventsSearch|visitorEvents|sessionEvents|eventDetail|journeyEventDetail/,
    "event",
  ],
  [/visitorsSearch/, "visitor"],
];

/** The kind of resource an id/name/description property belongs to. */
function entityOf(ctx: ExampleContext): Entity {
  if (ctx.path.includes("filterProtocol")) return "schemaField";
  const parent = parentName(ctx);
  const byParent = PARENT_ENTITIES[parent];
  if (byParent) return byParent;
  const operationId = ctx.operationId ?? "";
  for (const [pattern, entity] of OPERATION_ENTITIES) {
    if (pattern.test(operationId)) return entity;
  }
  return "unknown";
}

const ID_PREFIXES: Partial<Record<Entity, string>> = {
  token: "key",
  team: "team",
  funnel: "fnl",
  goal: "gol",
  savedFilter: "flt",
  event: "evt",
  visit: "vst",
  session: "ses",
  visitor: "vis",
};

function idRule(ctx: ExampleContext): string {
  const entity = entityOf(ctx);
  switch (entity) {
    case "site":
      return pick(SITE_IDS, ctx.index);
    case "step":
      return pick(["pricing", "signup", "activated"], ctx.index);
    case "batch":
      return `req-${ctx.index + 1}`;
    case "schemaField":
      return pick([...analyticsFilterRegistry.keys()], ctx.index);
    case "operation":
      return pick(
        [
          "site.analytics.overview",
          "site.analytics.timeseries",
          "site.analytics.pages",
        ],
        ctx.index,
      );
    default: {
      const prefix = ID_PREFIXES[entity];
      return prefix
        ? prefixedId(prefix, prefix, ctx)
        : prefixedId("id", "id", ctx);
    }
  }
}

function nameRule(ctx: ExampleContext): string {
  switch (entityOf(ctx)) {
    case "token":
      return "Production read key";
    case "team":
      return "Acme Inc.";
    case "step":
      return pick(["Pricing", "Sign up", "Activated"], ctx.index);
    case "funnel":
      return pick(
        ["Signup funnel", "Checkout funnel", "Onboarding"],
        ctx.index,
      );
    case "goal":
      return pick(
        ["Newsletter signup", "Trial started", "Contact sales"],
        ctx.index,
      );
    case "savedFilter":
      return pick(["Blog traffic", "US visitors", "Paid campaigns"], ctx.index);
    case "event":
      return pick(
        ["signup_completed", "pricing_viewed", "cta_click"],
        ctx.index,
      );
    default:
      return pick(["Marketing site", "Docs", "Blog"], ctx.index);
  }
}

/** Web Vitals base values (p50) by metric, in milliseconds except CLS. */
const VITAL_BASE: Record<string, number> = {
  ttfb: 180,
  fcp: 1_100,
  lcp: 1_900,
  cls: 0.04,
  inp: 120,
};
const VITAL_FACTOR: Record<string, number> = {
  min: 0.35,
  p50: 1,
  avg: 1.12,
  p75: 1.4,
  p90: 1.7,
  p95: 2,
  max: 4.2,
};

function vitalValue(metric: string, stat: string, ctx: ExampleContext): number {
  const spread = pick([1, 1.15, 0.9], ctx.index);
  const raw = VITAL_BASE[metric] * VITAL_FACTOR[stat] * spread;
  return metric === "cls" ? round(raw, 3) : Math.round(raw);
}

function vitalMetric(ctx: ExampleContext): string | undefined {
  for (let i = ctx.path.length - 2; i >= 0; i -= 1) {
    if (ctx.path[i] in VITAL_BASE) return ctx.path[i];
  }
  return ctx.operationId?.includes("erformance") ? "lcp" : undefined;
}

function vitalRule(stat: string): (ctx: ExampleContext) => unknown {
  return (ctx) => {
    const metric = vitalMetric(ctx);
    return metric ? vitalValue(metric, stat, ctx) : undefined;
  };
}

function metricRule(key: keyof Metrics): (ctx: ExampleContext) => unknown {
  return (ctx) => metricsFor(ctx)[key];
}

function vitalFlat(metric: string): (ctx: ExampleContext) => unknown {
  return (ctx) => vitalValue(metric, "p50", ctx);
}

/** Session timing: start, duration and end agree for each item index. */
function sessionStart(ctx: ExampleContext): number {
  return NOW_MS - pick([26, 71, 138], ctx.index) * 60_000;
}
function sessionDuration(ctx: ExampleContext): number {
  return pick([184_200, 96_400, 38_100], ctx.index);
}

function seriesTime(ctx: ExampleContext): number {
  const base = inReference(ctx) ? RANGE_FROM_MS - 7 * DAY_MS : RANGE_FROM_MS;
  return base + ctx.index * DAY_MS;
}

function inSeries(ctx: ExampleContext): boolean {
  return ctx.lists.some((list) => SERIES_LISTS.test(list));
}

/** Time rules produce epoch milliseconds; the caller formats them. */
const TIME_RULES: Record<string, (ctx: ExampleContext) => number> = {
  generatedAt: () => NOW_MS,
  createdAt: (ctx) => Date.UTC(2026, 2, 14, 9, 21, 5) - ctx.index * 3 * DAY_MS,
  updatedAt: (ctx) =>
    Date.UTC(2026, 10, 18, 14, 2, 37) - ctx.index * 2 * DAY_MS,
  expiresAt: () => Date.UTC(2027, 2, 14, 9, 21, 5),
  lastUsedAt: () => NOW_MS - 18 * 60_000,
  lastEventAt: (ctx) => NOW_MS - (ctx.index + 1) * 4 * 60_000,
  earliestAvailableAt: () => Date.UTC(2026, 2, 14, 9, 21, 5),
  latestAvailableAt: () => NOW_MS,
  timestamp: (ctx) =>
    inSeries(ctx) ? seriesTime(ctx) : NOW_MS - (ctx.index + 1) * 5 * 60_000,
  timestampMs: (ctx) => NOW_MS - 26 * 60_000 + ctx.index * 20_000,
  bucket: (ctx) => seriesTime(ctx),
  start: (ctx) => seriesTime(ctx),
  startedAt: sessionStart,
  endedAt: (ctx) => sessionStart(ctx) + sessionDuration(ctx),
  finalizedAt: (ctx) => sessionStart(ctx) + sessionDuration(ctx) + 1_200,
  hiddenAt: (ctx) => sessionStart(ctx) + sessionDuration(ctx) - 800,
  leaveAt: (ctx) => sessionStart(ctx) + sessionDuration(ctx) - 300,
  lastActivityAt: (ctx) => sessionStart(ctx) + sessionDuration(ctx),
  lastSeenAt: (ctx) => sessionStart(ctx) + sessionDuration(ctx),
  firstSeenAt: (ctx) => NOW_MS - (40 + ctx.index * 9) * DAY_MS,
  previousVisitStartedAt: (ctx) => sessionStart(ctx) - 2 * DAY_MS,
  eventAt: (ctx) => sessionStart(ctx) + 15_000 + ctx.index * 20_000,
  occurredAt: (ctx) => sessionStart(ctx) + 15_000 + ctx.index * 20_000,
  receivedAt: (ctx) => sessionStart(ctx) + 15_450 + ctx.index * 20_000,
};

const STRING_RULES: Record<string, Rule> = {
  requestId: (ctx) => `req_${hex(`request:${ctx.operationId ?? ""}`, 12)}`,
  id: idRule,
  name: nameRule,
  siteId: (ctx) =>
    ctx.operationId?.startsWith("team.") ? pick(SITE_IDS, ctx.index) : SITE_ID,
  sessionId: (ctx) => prefixedId("ses", "session", ctx),
  visitorId: (ctx) => prefixedId("vis", "visitor", ctx),
  visitId: (ctx) => prefixedId("vst", "visit", ctx),
  previousVisitId: (ctx) => prefixedId("vst", "previous-visit", ctx),
  performanceVisitId: (ctx) => prefixedId("vst", "visit", ctx),
  eventId: (ctx) => prefixedId("evt", "event", ctx),
  traceId: (ctx) => hex(`trace:${ctx.index}`, 32),
  stepId: (ctx) => pick(["pricing", "signup", "activated"], ctx.index),
  userId: (ctx) => pick(["user_1042", "user_2210", "user_3077"], ctx.index),
  userName: ["Ada Lovelace", "Grace Hopper", "Alan Turing"],
  domain: ["example.com", "docs.example.com", "blog.example.com"],
  hostname: ["example.com", "example.com", "docs.example.com"],
  publicSlug: ["acme-marketing", "acme-docs", "acme-blog"],
  description: (ctx) =>
    operationFamily(ctx) === "savedFilters"
      ? pick(
          [
            "Visitors who read the blog",
            "Traffic from the United States",
            "Visits tagged with a campaign",
          ],
          ctx.index,
        )
      : "Tracks completed signups",
  snippet: [
    `<script defer src="https://insights.example.com/script.js" data-site-id="${SITE_ID}"></script>`,
  ],
  src: ["https://insights.example.com/script.js"],
  // Dimensions
  country: ["US", "DE", "JP"],
  region: ["California", "Berlin", "Tokyo"],
  regionCode: ["CA", "BE", "13"],
  city: ["San Francisco", "Berlin", "Tokyo"],
  continent: ["NA", "EU", "AS"],
  timezone: ["America/Los_Angeles", "Europe/Berlin", "Asia/Tokyo"],
  organization: ["Comcast Cable", "Deutsche Telekom AG", "NTT Communications"],
  language: ["en-US", "de-DE", "ja-JP"],
  postalCode: ["94107", "10115", "100-0001"],
  metroCode: ["807", "0", "0"],
  browser: ["Chrome", "Safari", "Firefox"],
  browserVersion: ["131.0.0", "18.1", "132.0"],
  os: ["Windows", "macOS", "Linux"],
  osVersion: ["11", "14.6", "6.8"],
  deviceType: DEVICE_TYPES,
  screenSize: ["1920x1080", "390x844", "1440x900"],
  uaRaw: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  ],
  userAgent: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ],
  // Pages and referrers
  pathname: PATHNAMES,
  entryPath: PATHNAMES,
  exitPath: ["/docs/getting-started", "/pricing", "/"],
  title: [
    "Pricing - Acme",
    "Acme - Privacy-friendly analytics",
    "Getting started - Acme Docs",
  ],
  queryString: ["utm_source=newsletter&utm_medium=email", "ref=hn", ""],
  hash: ["#plans", "", "#install"],
  referrerHost: ["google.com", "news.ycombinator.com", "github.com"],
  referrerUrl: [
    "https://www.google.com/",
    "https://news.ycombinator.com/item?id=41234567",
    "https://github.com/example/repo",
  ],
  referrer: ["google.com", "news.ycombinator.com", "github.com"],
  utmSource: ["google", "newsletter", "twitter"],
  utmMedium: ["cpc", "email", "social"],
  utmCampaign: ["spring_launch", "weekly_digest", "launch_thread"],
  utmTerm: ["web analytics", "privacy analytics", "open source analytics"],
  utmContent: ["hero_cta", "footer_link", "thread_reply"],
  channel: ["organic_search", "direct", "social"],
  eventName: ["signup_completed", "pageview", "pageview"],
  granularity: ["day"],
  eventType: ["custom_event", "pageview", "leave"],
  eventKind: ["custom_event", "pageview", "leave"],
  eventData: [
    '{"plan":"pro","seats":5}',
    '{"source":"pricing_table"}',
    '{"href":"https://github.com/example/repo"}',
  ],
  visibilityState: ["visible", "hidden", "visible"],
  durationSource: ["engagement", "heartbeat", "engagement"],
  exitReason: ["pagehide", "visibilitychange", "timeout"],
  status: (ctx) => (entityOf(ctx) === "token" ? "active" : "finalized"),
  // Descriptors
  dimension: ["page.path"],
  key: (ctx) => {
    if (ctx.path.includes("metrics") && ctx.operationId?.endsWith(".schema"))
      return pick(["views", "sessions", "visitors"], ctx.index);
    if (ctx.path.includes("dimensions"))
      return pick(ANALYTICS_DIMENSIONS, ctx.index);
    const paths = parentName(ctx) === "items" || ctx.lists.includes("items");
    return paths
      ? pick(PATHNAMES, ctx.index)
      : pick(["overview", "pages", "referrers"], ctx.index);
  },
  label: (ctx) => pick(PATHNAMES, ctx.index),

  value: (ctx) => pick(["/pricing", "/blog", "/docs"], ctx.index),
  field: ["page.path"],
  fieldPath: ["plan"],
  timeZone: ["UTC"],
  interval: ["day"],
  filterDsl: (ctx) => {
    if (parentName(ctx) === "steps") {
      return pick(
        [
          'page.path eq "/pricing"',
          'event.name eq "signup"',
          'event.name eq "activated"',
        ],
        ctx.index,
      );
    }
    if (operationFamily(ctx) === "goals") {
      return pick(
        [
          'event.name eq "newsletter_signup"',
          'event.name eq "trial_started"',
          'page.path eq "/contact"',
        ],
        ctx.index,
      );
    }
    return pick(
      [
        'page.path startsWith "/blog"',
        'geo.country eq "US"',
        'utm.source eq "newsletter"',
      ],
      ctx.index,
    );
  },
  semanticFingerprint: (ctx) =>
    `sha256:${hex(`fp:${ctx.path.join(".")}:${ctx.index}`, 40)}`,
  nextCursor: ["eyJvZmZzZXQiOjN9"],
  version: ["v1"],
  apiVersion: ["v1"],
  service: ["insightflare"],
  mode: ["restricted"],
  scope: ["analytics:read"],
  scopes: ["site:read", "analytics:read", "analysis:read"],
  siteIds: [SITE_ID, "site_41ad90c2", "site_c07e5b13"],
  allowedDomains: ["example.com", "docs.example.com"],
  excludedPaths: ["/admin/*", "/preview/*"],
  visitorTokenMode: ["daily"],
  visibility: ["team"],
  query: ["plan=pro", "ref=hn", ""],
  date: (ctx) => iso(seriesTime(ctx)).slice(0, 10),
  team: ["/api/v1/team"],
  sites: ["/api/v1/sites"],
  openapi: ["/.well-known/openapi.json"],
  skills: ["/.well-known/skills.json"],
  token: ["/api/v1/token"],
  capabilities: ["/api/v1/capabilities"],
  batch: ["/api/v1/batch"],
  overview: [`/api/v1/sites/${SITE_ID}/analytics/overview`],
  operator: ["eq", "startsWith", "in"],
  examples: FILTER_DSL_EXAMPLES,
  operators: FILTER_DSL_OPERATOR_IDS,
  filters: [...analyticsFilterRegistry.keys()],
  path: (ctx) =>
    parentName(ctx) === "operations"
      ? pick(
          [
            `/api/v1/sites/{siteId}/analytics/overview`,
            `/api/v1/sites/{siteId}/analytics/timeseries`,
            `/api/v1/sites/{siteId}/analytics/pages`,
          ],
          ctx.index,
        )
      : pick(["plan", "seats", "source"], ctx.index),
  exampleValue: ["pro"],
};

const NUMBER_RULES: Record<string, Rule> = {
  ...Object.fromEntries(
    (
      [
        "views",
        "sessions",
        "visitors",
        "bounces",
        "totalDurationMs",
        "durationViews",
        "avgDurationMs",
        "bounceRate",
        "viewsPerSession",
        "events",
      ] as const
    ).map((key) => [key, metricRule(key)]),
  ),
  // Web Vitals: flat values are the median, nested stats are ordered.
  ttfb: vitalFlat("ttfb"),
  fcp: vitalFlat("fcp"),
  lcp: vitalFlat("lcp"),
  cls: vitalFlat("cls"),
  inp: vitalFlat("inp"),
  min: vitalRule("min"),
  max: vitalRule("max"),
  avg: vitalRule("avg"),
  p50: vitalRule("p50"),
  p75: vitalRule("p75"),
  p90: vitalRule("p90"),
  p95: vitalRule("p95"),
  samples: (ctx) => pick([4_120, 3_870, 2_950], ctx.index),
  // Rates and ratios (0-1)
  conversionRate: [0.0731],
  stepConversionRate: (ctx) => pick([0.41, 0.58, 0.72], ctx.index),
  dropOffRate: (ctx) => pick([0.59, 0.42, 0.28], ctx.index),
  overallConversionRate: [0.0731],
  shareOfAllEvents: (ctx) => pick([0.46, 0.31, 0.23], ctx.index),
  rate: (ctx) => pick([1, 0.34, 0.21], ctx.index),
  relative: [0.0847],
  absolute: [1065],
  // Durations
  durationMs: sessionDuration,
  p90DurationMs: [412_000],
  avgTimeBetweenSessionsMs: [172_800_000],
  conversionWindowMs: [604_800_000],
  // Geo and screen
  latitude: [37.7749, 52.52, 35.6762],
  longitude: [-122.4194, 13.405, 139.6503],
  screenWidth: [1920, 390, 1440],
  screenHeight: [1080, 844, 900],
  // Pagination
  limit: [50],
  returned: [3],
  // Counts
  count: (ctx) =>
    scaleKind(ctx) === "single"
      ? pick([12, 3, 1], ctx.index)
      : pick([412, 187, 64], ctx.index),
  occurrences: (ctx) => pick([412, 187, 64], ctx.index),
  total: (ctx) => pick([5_210, 2_140, 1_020], ctx.index),
  converted: (ctx) => pick([2_140, 1_020, 381], ctx.index),
  totalProgressions: [5_210],
  convertedProgressions: [381],
  dropOffCount: (ctx) => pick([3_070, 1_120, 639], ctx.index),
  totalEvents: (ctx) => pick([1_840, 2_105, 1_960], ctx.index),
  totalVisitors: [3_980],
  activeNow: [27],
  eventTypes: [14],
  nodeCount: [12],
  valueCount: (ctx) => pick([248, 36, 9], ctx.index),
  pointCount: (ctx) => pick([3, 2, 1], ctx.index),
  size: (ctx) => pick([1_240, 980, 860], ctx.index),
  daysActive: [9],
  conversionEvents: [3],
  avgEventsPerSession: [3.2],
  sites: [3],
  sequence: (ctx) => ctx.index + 1,
  index: (ctx) => ctx.index,
  step: (ctx) => ctx.index + 1,
  version: [1],
  documentVersion: [1],
  filterDslVersion: [1],
  status: [200],
  maxLength: [4_096],
  dataRetentionDays: [365],
};

const BOOLEAN_RULES: Record<string, boolean> = {
  publicEnabled: true,
  hasMore: true,
  complete: true,
  allowed: true,
  active: false,
  bounce: false,
  isEU: false,
  isOther: false,
  approximateVisitors: false,
  partialFailure: false,
  nullable: false,
  trackPageviews: true,
  trackQuery: true,
  trackHash: false,
  trackCustomEvents: true,
  trackEngagement: true,
  trackWebVitals: true,
  autoTrackOutboundLinks: true,
  respectDoNotTrack: true,
  anonymizeIp: true,
  euMode: false,
};

function resolveRule(rule: Rule, ctx: ExampleContext): unknown {
  if (typeof rule === "function") return rule(ctx);
  return pick(rule, ctx.index);
}

/** The full range the response covers; the reference range sits one week earlier. */
function rangeTime(name: string, ctx: ExampleContext): number | undefined {
  if (name !== "from" && name !== "to") return undefined;
  if (inSeries(ctx)) {
    return seriesTime(ctx) + (name === "to" ? DAY_MS : 0);
  }
  const shift = inReference(ctx) ? 7 * DAY_MS : 0;
  return (name === "from" ? RANGE_FROM_MS : RANGE_TO_MS) - shift;
}

const GEO_NAMES = new Set([
  "country",
  "region",
  "regionCode",
  "city",
  "latitude",
  "longitude",
]);

export type LeafKind = "string" | "number" | "integer" | "boolean";

/**
 * Returns a realistic value for a scalar property, or `undefined` when no rule
 * applies. The caller must still check the value against the property schema.
 */
export function ruleExample(
  name: string,
  ctx: ExampleContext,
  kind: LeafKind,
  format?: string,
): unknown {
  if (kind === "boolean") return BOOLEAN_RULES[name];

  const range = rangeTime(name, ctx);
  const timeRule = TIME_RULES[name];
  const ms = range ?? (timeRule ? timeRule(ctx) : undefined);
  if (ms !== undefined) {
    if (kind === "string") return iso(ms);
    return ms;
  }
  if (kind === "string" && format === "date-time") return iso(NOW_MS);

  if (
    kind === "string" &&
    ctx.path.includes("syntax") &&
    name in FILTER_DSL_SYNTAX
  ) {
    return FILTER_DSL_SYNTAX[name as keyof typeof FILTER_DSL_SYNTAX];
  }
  const table = kind === "string" ? STRING_RULES : NUMBER_RULES;
  const rule = table[name];
  if (rule === undefined) return undefined;
  // Every point of one session's location trail is in the same place.
  const pinned =
    ctx.lists.includes("locationPoints") && GEO_NAMES.has(name)
      ? { ...ctx, index: 0 }
      : ctx;
  return resolveRule(rule, pinned);
}

/**
 * Whole-object rules for properties whose shape the schema leaves open (maps of
 * links, features, limits) or whose realistic form is a fixed document.
 */
export function objectRuleExample(
  name: string,
  ctx: ExampleContext,
): Record<string, unknown> | undefined {
  const operationId = ctx.operationId ?? "";
  const siteId = operationId.startsWith("sites.")
    ? pick(SITE_IDS, ctx.index)
    : SITE_ID;
  const base = `/api/v1/sites/${siteId}`;
  if (name === "links") {
    if (operationId === "core.root") {
      return {
        openapi: "/.well-known/openapi.json",
        skills: "/.well-known/skills.json",
        token: "/api/v1/token",
        capabilities: "/api/v1/capabilities",
        team: "/api/v1/team",
        sites: "/api/v1/sites",
        batch: "/api/v1/batch",
      };
    }
    if (operationId === "core.capabilities") {
      return {
        token: "/api/v1/token",
        sites: "/api/v1/sites",
        batch: "/api/v1/batch",
      };
    }
    if (operationId === "core.team.get") {
      return {
        usage: "/api/v1/team/usage",
        sites: "/api/v1/sites",
        analyticsOverview: "/api/v1/team/analytics/overview",
      };
    }
    if (operationId.startsWith("funnels.")) {
      return {
        self: `${base}/funnels/${prefixedId("fnl", "fnl", ctx)}`,
        analysis: `${base}/analytics/funnel-analysis`,
      };
    }
    if (operationId.startsWith("goals.")) {
      return {
        self: `${base}/goals/${prefixedId("gol", "gol", ctx)}`,
        summary: `${base}/analytics/goals/summary`,
        timeseries: `${base}/analytics/goals/timeseries`,
      };
    }
    if (operationId === "team.analytics.schema") {
      return { overview: "/api/v1/team/analytics/overview" };
    }
    if (operationId === "site.analytics.schema") {
      return { overview: `${base}/analytics/overview` };
    }
    if (!operationId.startsWith("sites.")) return undefined;
    return {
      self: base,
      settingsTracking: `${base}/settings/tracking`,
      settingsPrivacy: `${base}/settings/privacy`,
      settingsSharing: `${base}/settings/sharing`,
      funnels: `${base}/funnels`,
      goals: `${base}/goals`,
      analyticsOverview: `${base}/analytics/overview`,
    };
  }
  if (name === "features") {
    return {
      batch: true,
      cursorPagination: true,
      rawEvents: true,
      realtime: true,
    };
  }
  if (name === "limits") {
    return {
      maxBatchSize: 20,
      maxTimeRangeDays: 365,
      defaultPageLimit: 100,
      maxPageLimit: 1000,
    };
  }
  if (name === "eventData") return { plan: "pro", seats: 5 };
  if (name === "performance") {
    return { ttfb: 180, fcp: 1_100, lcp: 1_900, cls: 0.04, inp: 120 };
  }
  if (name === "body") {
    return {
      data: { id: SITE_ID, name: "Marketing site" },
      meta: { requestId: "req_5d1e07b2a9c4" },
    };
  }
  if (name === "eventsBySeries") {
    return { signup_completed: 412, pricing_viewed: 1_104, cta_click: 324 };
  }
  if (name === "filter" && operationFamily(ctx) === "savedFilters") {
    return {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "page.path" },
        operator: "startsWith",
        value: "/blog",
      },
    };
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Schema constraint checks                                                   */
/* -------------------------------------------------------------------------- */

type SchemaLike = Record<string, unknown>;

function leafType(schema: SchemaLike): string | undefined {
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  return typeof type === "string" ? type : undefined;
}

/** Whether a scalar example value satisfies the schema's constraints. */
export function fitsSchema(value: unknown, schema: SchemaLike): boolean {
  if ("const" in schema) return Object.is(value, schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.includes(value);
  const type = leafType(schema);
  if (typeof value === "string") {
    if (type && type !== "string") return false;
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      return false;
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern).test(value)
    )
      return false;
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value)))
      return false;
    if (schema.format === "uri" && !/^https?:\/\//.test(value)) return false;
    if (schema.format === "email" && !value.includes("@")) return false;
    return true;
  }
  if (typeof value === "number") {
    if (type && type !== "number" && type !== "integer") return false;
    if (type === "integer" && !Number.isInteger(value)) return false;
    if (!Number.isFinite(value)) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return false;
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return false;
    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    )
      return false;
    if (
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    )
      return false;
    if (
      schema.exclusiveMinimum === true &&
      typeof schema.minimum === "number" &&
      value <= schema.minimum
    )
      return false;
    if (
      schema.exclusiveMaximum === true &&
      typeof schema.maximum === "number" &&
      value >= schema.maximum
    )
      return false;
    return true;
  }
  if (typeof value === "boolean") return !type || type === "boolean";
  return false;
}

const SAFE_INTEGER_FLOOR = -9_007_199_254_740_991;

/** A constraint-respecting number when no rule applies. */
export function fallbackNumber(schema: SchemaLike): number {
  const integer = leafType(schema) === "integer";
  let min = typeof schema.minimum === "number" ? schema.minimum : undefined;
  let max = typeof schema.maximum === "number" ? schema.maximum : undefined;
  if (typeof schema.exclusiveMinimum === "number") {
    min = schema.exclusiveMinimum + (integer ? 1 : 0.5);
  } else if (schema.exclusiveMinimum === true && min !== undefined) {
    min += integer ? 1 : 0.5;
  }
  if (typeof schema.exclusiveMaximum === "number") {
    max = schema.exclusiveMaximum - (integer ? 1 : 0.5);
  } else if (schema.exclusiveMaximum === true && max !== undefined) {
    max -= integer ? 1 : 0.5;
  }
  if (min !== undefined && min <= SAFE_INTEGER_FLOOR) min = undefined;
  let value = 0;
  if (min !== undefined && value < min) value = min;
  if (max !== undefined && value > max) value = max;
  return value;
}

/** A readable string when no rule applies, honouring length and pattern. */
export function fallbackString(name: string, schema: SchemaLike): string {
  const candidates = [
    schema.format === "uuid"
      ? "550e8400-e29b-41d4-a716-446655440000"
      : schema.format === "uri"
        ? "https://example.com/docs"
        : schema.format === "email"
          ? "user@example.com"
          : schema.format === "date-time"
            ? iso(NOW_MS)
            : `${name}_1`,
    name,
    "a1",
    "a",
  ];
  const minLength = typeof schema.minLength === "number" ? schema.minLength : 0;
  const maxLength =
    typeof schema.maxLength === "number" ? schema.maxLength : Infinity;
  for (const candidate of candidates) {
    const padded =
      candidate.length < minLength
        ? candidate.padEnd(minLength, "a")
        : candidate;
    if (
      padded.length <= maxLength &&
      fitsSchema(padded, { ...schema, enum: undefined })
    ) {
      return padded;
    }
  }
  return candidates[0];
}

/* -------------------------------------------------------------------------- */
/* Cross-field coherence                                                      */
/* -------------------------------------------------------------------------- */

const METRIC_KEYS = [
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDurationMs",
  "durationViews",
  "avgDurationMs",
  "bounceRate",
  "viewsPerSession",
  "events",
] as const;

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recomputeDerived(row: Row): void {
  const num = (key: string): number | undefined =>
    typeof row[key] === "number" ? (row[key] as number) : undefined;
  const sessions = num("sessions");
  const views = num("views");
  const bounces = num("bounces");
  if (sessions && bounces !== undefined && "bounceRate" in row) {
    row.bounceRate = round(bounces / sessions, 4);
  }
  if (sessions && views !== undefined && "viewsPerSession" in row) {
    row.viewsPerSession = round(views / sessions, 2);
  }
  const durationViews = num("durationViews");
  const total = num("totalDurationMs");
  if (durationViews && total !== undefined && "avgDurationMs" in row) {
    row.avgDurationMs = Math.round(total / durationViews);
  }
}

function metricContainer(row: unknown): Row | undefined {
  if (!isRow(row)) return undefined;
  if (isRow(row.metrics)) return row.metrics;
  return row;
}

/** change = current - reference, for every metric present on both sides. */
function refineComparison(row: Row): void {
  const current = metricContainer(row.current);
  const reference = metricContainer(row.reference);
  const change = row.change;
  if (!current || !reference || !isRow(change)) return;
  for (const key of METRIC_KEYS) {
    const now = current[key];
    const before = reference[key];
    const entry = change[key];
    if (typeof now !== "number" || typeof before !== "number" || !isRow(entry))
      continue;
    entry.absolute = round(now - before, 4);
    entry.relative = before === 0 ? 0 : round((now - before) / before, 4);
  }
}

function refinePagination(row: Row): void {
  const pagination = row.pagination;
  if (!isRow(pagination) || !Array.isArray(row.items)) return;
  const returned = row.items.length;
  if ("returned" in pagination) pagination.returned = returned;
  if ("limit" in pagination) pagination.limit = Math.max(returned, 1);
  if (pagination.hasMore === true && "nextCursor" in pagination) {
    pagination.nextCursor = pagination.nextCursor ?? "eyJvZmZzZXQiOjN9";
  }
}

function refineRange(row: Row): void {
  if (typeof row.from === "string" && typeof row.to === "string") {
    if (Date.parse(row.from) > Date.parse(row.to)) {
      [row.from, row.to] = [row.to, row.from];
    }
  }
}

function refineTimes(row: Row): void {
  const started = row.startedAt;
  const ended = row.endedAt;
  if (
    typeof started === "number" &&
    typeof ended === "number" &&
    ended < started
  ) {
    row.endedAt = started;
  }
}

function refineCounts(row: Row): void {
  const num = (key: string) =>
    typeof row[key] === "number" ? (row[key] as number) : undefined;
  const views = num("views");
  const sessions = num("sessions");
  const visitors = num("visitors");
  const bounces = num("bounces");
  if (views !== undefined && sessions !== undefined && sessions > views)
    row.sessions = views;
  if (sessions !== undefined && visitors !== undefined && visitors > sessions)
    row.visitors = sessions;
  if (sessions !== undefined && bounces !== undefined && bounces > sessions)
    row.bounces = sessions;
}

/** Make related fields of one object agree after its properties are filled. */
function refineCohort(row: Row): void {
  if (typeof row.size !== "number" || !Array.isArray(row.periods)) return;
  const size = row.size;
  row.periods.forEach((period, index) => {
    if (!isRow(period)) return;
    const rate = pick([1, 0.34, 0.21, 0.15], index);
    if ("rate" in period) period.rate = rate;
    if ("visitors" in period) period.visitors = Math.round(size * rate);
  });
}

/** Funnel step counts follow the sessions/visitors that reached each step. */
function refineFunnelAnalysis(row: Row): void {
  const steps = row.steps;
  const summary = row.summary;
  if (!Array.isArray(steps) || !isRow(summary)) return;
  const key = row.progressionScope === "visitor" ? "visitors" : "sessions";
  const counts = steps.map((step) =>
    isRow(step) && typeof step[key] === "number" ? (step[key] as number) : 0,
  );
  const first = counts[0] || 1;
  let largest = 0;
  let largestDrop = -1;
  steps.forEach((step, index) => {
    if (!isRow(step) || !isRow(step.progression)) return;
    const previous = index === 0 ? counts[0] : counts[index - 1];
    const drop = Math.max(0, previous - counts[index]);
    Object.assign(step.progression, {
      count: counts[index],
      conversionRate: round(counts[index] / first, 4),
      stepConversionRate: previous ? round(counts[index] / previous, 4) : 1,
      dropOffCount: drop,
      dropOffRate: previous ? round(drop / previous, 4) : 0,
    });
    if (index > 0 && drop > largestDrop) {
      largestDrop = drop;
      largest = index;
    }
  });
  const last = counts[counts.length - 1] ?? 0;
  Object.assign(summary, {
    totalProgressions: counts[0] ?? 0,
    convertedProgressions: last,
    overallConversionRate: round(last / first, 4),
    largestDropOffStepIndex: largest,
  });
}

/** A session detail response totals its page and event lists. */
function refineSessionDetail(row: Row): void {
  if (!isRow(row.session)) return;
  const sum = (list: unknown, key: string): number | undefined =>
    Array.isArray(list)
      ? list.reduce(
          (total: number, item) =>
            total +
            (isRow(item) && typeof item[key] === "number"
              ? (item[key] as number)
              : 0),
          0,
        )
      : undefined;
  const views = sum(row.visitedPages, "views");
  const events = sum(row.eventDistribution, "count");
  if (views !== undefined && "views" in row.session) row.session.views = views;
  if (events !== undefined && "events" in row.session)
    row.session.events = events;
}

export function refineObject(row: Row, ctx: ExampleContext): void {
  // Funnel progression counts shrink step by step; labels follow their key.
  if (typeof row.key === "string" && typeof row.label === "string") {
    row.label = row.key;
  }
  if (
    typeof row.key === "string" &&
    typeof row.description === "string" &&
    ctx.operationId?.endsWith(".schema")
  ) {
    row.description = `Analytics ${ctx.path.includes("metrics") ? "metric" : "dimension"}: ${row.key}.`;
  }
  refineCohort(row);
  refineFunnelAnalysis(row);
  refineSessionDetail(row);
  refineRange(row);
  refineTimes(row);
  refineCounts(row);
  recomputeDerived(row);
  refineComparison(row);
  refinePagination(row);
}
