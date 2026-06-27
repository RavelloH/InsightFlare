import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handlePrivateQuery, handlePublicQuery } from "@/lib/edge/query";
import {
  type EdgeSessionClaims,
  requireSession,
} from "@/lib/edge/session-auth";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/session-auth", () => ({
  requireSession: vi.fn(),
}));

vi.mock("@/lib/edge/dashboard-cache", () => ({
  withDashboardCache: vi.fn(
    async (
      _ctx: ExecutionContext | undefined,
      _url: URL,
      generate: () => Promise<Response>,
    ) => generate(),
  ),
}));

vi.mock("@/lib/edge/custom-event-read", () => ({
  readCustomEventDetail: vi.fn().mockResolvedValue({
    eventData: { plan: "pro", value: 99 },
  }),
}));

const requireSessionMock = vi.mocked(requireSession);

interface MockStatement {
  sql: string;
  bindings: Array<string | number | null>;
  bind: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

interface SqlMatch {
  match: (sql: string, bindings: Array<string | number | null>) => boolean;
  all?: Record<string, unknown>[];
  first?: Record<string, unknown> | null;
  run?: Record<string, unknown>;
}

interface MockEnvOptions {
  matches?: SqlMatch[];
  fallbackAll?: Record<string, unknown>[];
}

const adminSession: EdgeSessionClaims = {
  userId: "admin-1",
  username: "admin",
  displayName: "Admin",
  systemRole: "admin",
  exp: 9_999_999_999,
};

const userSession: EdgeSessionClaims = {
  userId: "user-1",
  username: "user",
  displayName: "User",
  systemRole: "user",
  exp: 9_999_999_999,
};

const siteRow = {
  id: "site-1",
  name: "InsightFlare",
  domain: "example.com",
};

const publicSiteRow = {
  id: "site-1",
  name: "Public Insight",
  domain: "public.example",
};

const from = 1_700_000_000_000;
const to = from + 3_600_000;

function includesAll(...needles: string[]) {
  return (sql: string) => needles.every((needle) => sql.includes(needle));
}

function sqlMatch(
  needles: string[],
  output: Omit<SqlMatch, "match"> = {},
): SqlMatch {
  return {
    match: (sql) => includesAll(...needles)(sql),
    ...output,
  };
}

function firstMatch(needles: string[], first: Record<string, unknown> | null) {
  return sqlMatch(needles, { first });
}

function allMatch(needles: string[], all: Record<string, unknown>[]) {
  return sqlMatch(needles, { all });
}

function createStatement(
  sql: string,
  matches: SqlMatch[],
  fallbackAll: Record<string, unknown>[],
  statements: MockStatement[],
): MockStatement {
  const statement = {
    sql,
    bindings: [] as Array<string | number | null>,
    bind: vi.fn(function (
      this: MockStatement,
      ...bindings: Array<string | number | null>
    ) {
      this.bindings = bindings;
      return this;
    }),
    all: vi.fn(async function (this: MockStatement) {
      const match = matches.find((candidate) =>
        candidate.match(this.sql, this.bindings),
      );
      return { results: match?.all ?? fallbackAll };
    }),
    first: vi.fn(async function (this: MockStatement) {
      const match = matches.find((candidate) =>
        candidate.match(this.sql, this.bindings),
      );
      if (match && "first" in match) return match.first;
      if (match?.all) return match.all[0] ?? null;
      return fallbackAll[0] ?? null;
    }),
    run: vi.fn(async function (this: MockStatement) {
      const match = matches.find((candidate) =>
        candidate.match(this.sql, this.bindings),
      );
      return match?.run ?? { success: true };
    }),
  } satisfies MockStatement;
  statements.push(statement);
  return statement;
}

function createEnv(options: MockEnvOptions = {}) {
  const statements: MockStatement[] = [];
  const matches = options.matches ?? [];
  const fallbackAll = options.fallbackAll ?? [];
  const prepare = vi.fn((sql: string) =>
    createStatement(sql, matches, fallbackAll, statements),
  );
  const env = {
    DB: { prepare } as unknown as D1Database,
  } as Env;
  return { env, prepare, statements };
}

function authMatches(site = siteRow): SqlMatch[] {
  return [
    firstMatch(["FROM sites", "WHERE id=? LIMIT 1"], site),
    firstMatch(["FROM sites s", "INNER JOIN teams"], site),
  ];
}

function publicAuthMatches(site = publicSiteRow): SqlMatch[] {
  return [
    firstMatch(["FROM sites", "public_enabled=1", "public_slug=?"], site),
  ];
}

function request(path: string, init?: RequestInit) {
  return new Request(`https://edge.test${path}`, init);
}

async function privateQuery(
  path: string,
  env: Env,
  init?: RequestInit,
): Promise<Response> {
  const edgeRequest = request(path, init);
  return handlePrivateQuery(edgeRequest, env, new URL(edgeRequest.url));
}

async function publicQuery(
  path: string,
  env: Env,
  init?: RequestInit,
): Promise<Response> {
  const edgeRequest = request(path, init);
  return handlePublicQuery(edgeRequest, env, new URL(edgeRequest.url));
}

const windowParams = `from=${from}&to=${to}`;

function privatePath(pathname: string, params = "") {
  const suffix = params ? `&${params}` : "";
  return `/api/private/${pathname}?siteId=site-1&${windowParams}${suffix}`;
}

function publicPath(pathname: string, params = "") {
  const suffix = params ? `&${params}` : "";
  return `/api/public-sites/public-slug/${pathname}?${windowParams}${suffix}`;
}

const overviewRows = [
  {
    views: 20,
    sessions: 8,
    visitors: 6,
    bounces: 2,
    totalDuration: 16_000,
    durationViews: 7,
  },
  {
    views: 10,
    sessions: 5,
    visitors: 4,
    bounces: 1,
    totalDuration: 5_000,
    durationViews: 3,
  },
];

function overviewMatch(): SqlMatch {
  let index = 0;
  return {
    match: includesAll(
      "COALESCE((SELECT count(*) FROM session_rollup WHERE visit_count = 1), 0) AS bounces",
      "FROM filtered_visits",
    ),
    first: undefined,
    run: undefined,
    get all() {
      return [overviewRows[Math.min(index++, overviewRows.length - 1)]];
    },
  } as SqlMatch;
}

const trendRows = [
  {
    bucket: 0,
    views: 5,
    visitors: 3,
    sessions: 2,
    bounces: 1,
    totalDuration: 2_000,
    durationViews: 2,
  },
  {
    bucket: 1,
    views: 6,
    visitors: 4,
    sessions: 3,
    bounces: 0,
    totalDuration: 3_000,
    durationViews: 3,
  },
];

const dimensionRows = [
  { value: "/pricing", views: 9, sessions: 6, visitors: 5 },
  { value: "/docs", views: 4, sessions: 3, visitors: 2 },
];

const eventRecordRow = {
  eventId: "evt-1",
  eventName: "Signup",
  occurredAt: from + 500,
  receivedAt: from + 600,
  sequence: 2,
  visitId: "visit-1",
  sessionId: "session-1",
  visitorId: "visitor-1",
  pathname: "/signup",
  title: "Signup",
  hostname: "example.com",
  referrerHost: "news.example",
  country: "US",
  region: "CA",
  browser: "Chrome",
  browserVersion: "124",
  os: "Windows",
  osVersion: "11",
  deviceType: "desktop",
  nodeCount: 4,
  valueCount: 3,
};

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    visitorId: "visitor-1",
    startedAt: from,
    endedAt: from + 10_000,
    totalDurationMs: 10_000,
    active: 0,
    views: 2,
    events: 1,
    bounce: 0,
    entryPath: "/",
    exitPath: "/pricing",
    referrerHost: "news.example",
    referrerUrl: "https://news.example/post",
    country: "US",
    region: "CA",
    regionCode: "CA",
    city: "San Francisco",
    latitude: 37.77,
    longitude: -122.42,
    browser: "Chrome",
    browserVersion: "124",
    os: "Windows",
    osVersion: "11",
    deviceType: "desktop",
    screenWidth: 1440,
    screenHeight: 900,
    perfTtfbMs: 12.3456,
    perfFcpMs: 20,
    perfLcpMs: 50,
    perfCls: 0.025,
    perfInpMs: 80,
    ...overrides,
  };
}

function commonQueryMatches(): SqlMatch[] {
  return [
    overviewMatch(),
    allMatch(["visit_bucket_rollup AS", "session_bucket_rollup AS"], trendRows),
    allMatch(
      ["SELECT visitorId, sessionId, startedAt, pathname"],
      [
        {
          visitorId: "visitor-1",
          sessionId: "session-1",
          startedAt: from,
          pathname: "/pricing",
          title: "Pricing",
          hostname: "example.com",
        },
        {
          visitorId: "visitor-2",
          sessionId: "session-2",
          startedAt: from + 1,
          pathname: "/docs",
          title: "Docs",
          hostname: "docs.example.com",
        },
      ],
    ),
    allMatch(
      ["COALESCE(referrer_host, '') AS referrer"],
      [{ referrer: "news.example", views: 6, sessions: 4, visitors: 3 }],
    ),
    allMatch(
      ["COALESCE(referrer_url, '') AS referrer"],
      [
        {
          referrer: "https://news.example/post",
          views: 6,
          sessions: 4,
          visitors: 3,
        },
      ],
    ),
    allMatch(["dimension_rollup AS"], dimensionRows),
    allMatch(
      ["event_with_context AS", "event_rollup AS"],
      [{ value: "Signup", views: 8, sessions: 5, visitors: 4 }],
    ),
    allMatch(
      ["event_name AS eventName", "GROUP BY event_name", "LIMIT ?"],
      [{ eventName: "Signup", events: 7, sessions: 4, visitors: 3 }],
    ),
    allMatch(
      ["seriesName AS seriesKey"],
      [{ bucket: 0, seriesKey: "Signup", events: 2 }],
    ),
    allMatch(
      ["count(*) AS events", "count(DISTINCT event_name)"],
      [{ events: 12, eventTypes: 3, sessions: 5, visitors: 4 }],
    ),
    allMatch(
      ["event_name AS value", "FROM filtered_events"],
      [{ value: "Signup", views: 7, sessions: 4, visitors: 3 }],
    ),
    allMatch(
      ["pathname AS value", "FROM filtered_events"],
      [{ value: "/signup", views: 7, sessions: 4, visitors: 3 }],
    ),
    allMatch(
      ["title AS value", "FROM filtered_events"],
      [{ value: "Signup", views: 7, sessions: 4, visitors: 3 }],
    ),
    allMatch(
      ["hostname AS value", "FROM filtered_events"],
      [{ value: "example.com", views: 7, sessions: 4, visitors: 3 }],
    ),
    allMatch(
      ["event_id AS eventId", "ORDER BY"],
      [eventRecordRow, { ...eventRecordRow, eventId: "evt-2" }],
    ),
    allMatch(
      ["field_rows AS", "GROUP BY path, valueType"],
      [
        {
          path: "/plan",
          valueType: 1,
          events: 3,
          occurrences: 4,
          firstSeenAt: from,
          lastSeenAt: to,
          stringValue: "pro",
          numberValue: null,
          booleanValue: null,
        },
      ],
    ),
    allMatch(
      ["GROUP BY valueType, stringValue"],
      [
        {
          valueType: 1,
          events: 2,
          occurrences: 3,
          firstSeenAt: from,
          lastSeenAt: to,
          stringValue: "pro",
          numberValue: null,
          booleanValue: null,
        },
      ],
    ),
    allMatch(["LIMIT 1", "event_id AS eventId"], [eventRecordRow]),
    allMatch(
      ["fv.visitor_id AS visitorId"],
      [
        {
          visitorId: "visitor-1",
          sessionId: "session-2",
          firstSeenAt: from,
          lastSeenAt: to,
          views: 4,
          sessions: 2,
          events: 3,
          country: "US",
          region: "CA",
          regionCode: "CA",
          city: "San Francisco",
          referrerHost: "news.example",
          referrerUrl: "https://news.example/post",
          browser: "Chrome",
          browserVersion: "124",
          os: "Windows",
          osVersion: "11",
          deviceType: "desktop",
          screenWidth: 1440,
          screenHeight: 900,
        },
      ],
    ),
    allMatch(
      ["fv.session_id AS sessionId"],
      [
        sessionRow(),
        sessionRow({ sessionId: "session-2", views: 1, bounce: 1 }),
      ],
    ),
    allMatch(
      ["latitude", "longitude", "ORDER BY timestampMs"],
      [
        {
          latitude: 37.77,
          longitude: -122.42,
          timestampMs: from,
          country: "US",
          region: "CA",
          regionCode: "CA",
          city: "San Francisco",
        },
      ],
    ),
    allMatch(
      ["cohort_bucket AS cohortBucket"],
      [
        { cohortBucket: 0, visitBucket: 0, visitors: 10 },
        { cohortBucket: 0, visitBucket: 1, visitors: 4 },
      ],
    ),
    allMatch(
      ["TRIM(COALESCE(browser", "AS labelValue", "LIMIT ?"],
      [{ label: "Chrome", views: 10, visitors: 6, sessions: 5 }],
    ),
    allMatch(
      ["assigned_visits AS", "GROUP BY label"],
      [
        { label: "Chrome", views: 10, visitors: 6, sessions: 5 },
        { label: "__share_trend_other__", views: 3, visitors: 2, sessions: 2 },
      ],
    ),
    allMatch(
      ["GROUP BY bucket, label"],
      [
        { bucket: 0, label: "Chrome", views: 5, visitors: 3, sessions: 2 },
        {
          bucket: 0,
          label: "__share_trend_other__",
          views: 1,
          visitors: 1,
          sessions: 1,
        },
      ],
    ),
    allMatch(
      ["browserVersion != '' THEN browserVersion"],
      [
        {
          browser: "Chrome",
          version: "124",
          views: 6,
          visitors: 4,
          sessions: 3,
        },
        {
          browser: "Chrome",
          version: "__browser_version_unknown__",
          views: 2,
          visitors: 1,
          sessions: 1,
        },
      ],
    ),
    allMatch(
      [
        "SELECT",
        "browser,",
        "WHERE browser != ''",
        "GROUP BY browser",
        "LIMIT ?",
      ],
      [{ browser: "Chrome", views: 10, visitors: 6, sessions: 5 }],
    ),
    allMatch(
      ["dimension,", "WHERE browser != ''", "GROUP BY dimension", "LIMIT ?"],
      [{ dimension: "Windows", views: 8, visitors: 5, sessions: 4 }],
    ),
    allMatch(
      ["browserBucket AS browser", "dimensionBucket AS dimension"],
      [
        {
          browser: "Chrome",
          dimension: "Windows",
          views: 8,
          visitors: 5,
          sessions: 4,
        },
      ],
    ),
    allMatch(
      ["primaryValue,", "GROUP BY primaryValue", "LIMIT ?"],
      [{ primaryValue: "Chrome", views: 10, visitors: 6, sessions: 5 }],
    ),
    allMatch(
      ["secondaryValue,", "GROUP BY secondaryValue", "LIMIT ?"],
      [{ secondaryValue: "Windows", views: 8, visitors: 5, sessions: 4 }],
    ),
    allMatch(
      ["primaryBucket AS primaryValue", "secondaryBucket AS secondaryValue"],
      [
        {
          primaryValue: "Chrome",
          secondaryValue: "Windows",
          views: 8,
          visitors: 5,
          sessions: 4,
        },
      ],
    ),
    allMatch(
      ["bsa.browser", "trafficShare"],
      [
        {
          browser: "Chrome",
          sessions: 8,
          bounces: 2,
          avgDurationMs: 1250,
          avgDepth: 2.5,
          visitors: 6,
          returningVisitors: 3,
          avgFrequency: 1.5,
          trafficShare: 0.75,
        },
      ],
    ),
    allMatch(
      ["rsa.referrer", "trafficShare"],
      [
        {
          referrer: "news.example",
          sessions: 5,
          bounces: 1,
          avgDurationMs: 900,
          avgDepth: 1.8,
          visitors: 4,
          returningVisitors: 1,
          avgFrequency: 1.25,
          trafficShare: 0.4,
        },
      ],
    ),
    allMatch(
      ["path_rollup AS", "ORDER BY pr.views"],
      [
        {
          pathname: "/pricing",
          views: 12,
          sessions: 8,
          visitors: 6,
          bounces: 2,
          totalDuration: 16_000,
          durationViews: 0,
        },
        {
          pathname: "/docs",
          views: 4,
          sessions: 3,
          visitors: 2,
          bounces: 1,
          totalDuration: 3_000,
          durationViews: 0,
        },
        {
          pathname: "/blog",
          views: 2,
          sessions: 2,
          visitors: 2,
          bounces: 2,
          totalDuration: 1_000,
          durationViews: 0,
        },
      ],
    ),
    allMatch(
      ["ranked_titles AS"],
      [
        { pathname: "/pricing", title: "Pricing", views: 9 },
        { pathname: "/pricing", title: "Plans", views: 3 },
      ],
    ),
    allMatch(
      ["GROUP BY pathname, bucket"],
      [{ pathname: "/pricing", bucket: 0, views: 5, visitors: 4 }],
    ),
    allMatch(
      ["thresholds.pathname AS pathname"],
      [
        {
          pathname: "/pricing",
          metric: "lcp",
          views: 6,
          avgValue: 100,
          p50: 90,
          p75: 120,
          p95: 180,
          samples: 5,
        },
      ],
    ),
    allMatch(
      ["thresholds.country AS country"],
      [
        {
          country: "us",
          metric: "ttfb",
          views: 6,
          avgValue: 30,
          p50: 20,
          p75: 35,
          p95: 60,
          samples: 5,
        },
      ],
    ),
    allMatch(
      ["metric_thresholds AS", "GROUP BY thresholds.metric"],
      [
        {
          metric: "lcp",
          avgValue: 123.4567,
          p50: 100,
          p75: 140,
          p95: 200,
          samples: 8,
        },
      ],
    ),
    allMatch(
      ["thresholds.bucket AS bucket"],
      [{ bucket: 0, avgValue: 50, p50: 40, p75: 60, p95: 90, samples: 4 }],
    ),
    allMatch(
      ["SELECT sessionId, browser, os, osVersion"],
      [
        {
          sessionId: "session-1",
          browser: "Chrome",
          os: "Windows",
          osVersion: "11",
          deviceType: "desktop",
          language: "en-US",
          screenWidth: 1440,
          screenHeight: 900,
        },
      ],
    ),
    allMatch(
      ["SELECT sessionId, visitorId, country, region"],
      [
        {
          sessionId: "session-1",
          visitorId: "visitor-1",
          country: "US",
          region: "US::CA::California",
          city: "US::CA::California::San Francisco",
          continent: "NA",
          timezone: "America/Los_Angeles",
          asOrganization: "Example ISP",
        },
      ],
    ),
    allMatch(["GROUP BY country", "ORDER BY views DESC"], []),
  ];
}

describe("edge query handlers", () => {
  beforeEach(() => {
    requireSessionMock.mockReset();
    requireSessionMock.mockResolvedValue(adminSession);
    vi.spyOn(Date, "now").mockReturnValue(to + 60_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unsupported methods before authentication", async () => {
    const { env, prepare } = createEnv();

    const response = await privateQuery(privatePath("overview"), env, {
      method: "POST",
    });

    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { message: "Method Not Allowed" },
    });
    expect(requireSessionMock).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("requires a private session and site id before querying D1 aggregates", async () => {
    requireSessionMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(adminSession);
    const { env, prepare } = createEnv();

    const unauthorized = await privateQuery(privatePath("overview"), env);
    const missingSite = await privateQuery(
      `/api/private/overview?${windowParams}`,
      env,
    );

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      ok: false,
      error: { message: "Unauthorized" },
    });
    expect(missingSite.status).toBe(400);
    expect(await missingSite.json()).toMatchObject({
      ok: false,
      error: { message: "siteId is required" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("uses admin site lookup and returns not found when the site is missing", async () => {
    const { env, statements } = createEnv({
      matches: [firstMatch(["FROM sites", "WHERE id=? LIMIT 1"], null)],
    });

    const response = await privateQuery(privatePath("overview"), env);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { message: "Site not found" },
    });
    expect(statements[0].bind).toHaveBeenCalledWith("site-1");
  });

  it("uses team membership lookup for non-admin users", async () => {
    requireSessionMock.mockResolvedValue(userSession);
    const { env, statements } = createEnv({
      matches: [firstMatch(["FROM sites s", "INNER JOIN teams"], null)],
    });

    const response = await privateQuery(privatePath("overview"), env);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { message: "Site not found" },
    });
    expect(statements[0].bind).toHaveBeenCalledWith(
      "user-1",
      "site-1",
      "user-1",
    );
  });

  it("returns overview metrics, comparison, detail trend, and normalized filter bindings", async () => {
    const { env, statements } = createEnv({
      matches: [...authMatches(), ...commonQueryMatches()],
    });

    const response = await privateQuery(
      privatePath(
        "overview",
        "includeChange=1&includeDetail=yes&interval=hour&country=US&hostname=Example.COM&sourceDomain=__direct__",
      ),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBeNull();
    const payload: any = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      data: {
        views: 20,
        sessions: 8,
        visitors: 6,
        bounces: 2,
        totalDurationMs: 16_000,
        avgDurationMs: 2000,
        bounceRate: 0.25,
        approximateVisitors: false,
      },
      previousData: {
        views: 10,
        sessions: 5,
        visitors: 4,
        bounces: 1,
      },
      changeRates: {
        views: 100,
        sessions: 60,
        visitors: 50,
        bounces: 100,
      },
      detail: {
        interval: "hour",
      },
    });
    expect(payload.detail.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucket: 0,
          views: 5,
          visitors: 3,
          sessions: 2,
          avgDurationMs: 1000,
          source: "detail",
        }),
      ]),
    );
    const aggregateStatement = statements.find((statement) =>
      statement.sql.includes("session_rollup AS"),
    );
    expect(aggregateStatement?.bindings).toEqual(
      expect.arrayContaining(["us", "example.com"]),
    );
    expect(aggregateStatement?.sql).toContain(
      "TRIM(COALESCE(referrer_host, '')) = ''",
    );
  });

  it("rejects invalid private query windows after authorization", async () => {
    const { env, prepare } = createEnv({ matches: authMatches() });

    const response = await privateQuery(
      "/api/private/trend?siteId=site-1&from=20&to=10",
      env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("routes trend and falls back to day interval for invalid interval values", async () => {
    const { env } = createEnv({
      matches: [...authMatches(), ...commonQueryMatches()],
    });

    const response = await privateQuery(
      privatePath("trend", "interval=bogus"),
      env,
    );

    expect(response.status).toBe(200);
    const payload: any = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      interval: "day",
    });
    expect(payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucket: 0,
          views: 5,
          source: "detail",
        }),
      ]),
    );
  });

  it("routes dimension and filter option handlers with clamped limits", async () => {
    const { env, statements } = createEnv({
      matches: [...authMatches(), ...commonQueryMatches()],
    });

    const dimension = await privateQuery(
      privatePath("page-query", "limit=999&query=%3Fa%3D1"),
      env,
    );
    const options = await privateQuery(
      privatePath("filter-options", "filterKey=sourceLink&limit=999"),
      env,
    );
    const invalidOptions = await privateQuery(
      privatePath("filter-options", "filterKey=not-real"),
      env,
    );

    const dimensionPayload: any = await dimension.json();
    const optionsPayload: any = await options.json();
    expect(dimensionPayload).toMatchObject({ ok: true });
    expect(dimensionPayload.data).toEqual(
      expect.arrayContaining([
        { label: "/pricing", views: 9, sessions: 6, visitors: 5 },
      ]),
    );
    expect(optionsPayload).toMatchObject({ ok: true });
    expect(optionsPayload.data).toEqual(
      expect.arrayContaining([
        {
          value: "https://news.example/post",
          label: "https://news.example/post",
        },
      ]),
    );
    expect(invalidOptions.status).toBe(400);
    expect(await invalidOptions.json()).toMatchObject({
      ok: false,
      error: { message: "Invalid filter key" },
    });
    const dimensionStatement = statements.find((statement) =>
      statement.sql.includes("dimension_rollup AS"),
    );
    expect(dimensionStatement?.bindings.at(-1)).toBe(200);
  });

  it("shapes events summary, trend, records, type detail, field values, and record detail", async () => {
    const { env } = createEnv({
      matches: [...authMatches(), ...commonQueryMatches()],
    });

    const summary = await privateQuery(privatePath("events-summary"), env);
    const trend = await privateQuery(
      privatePath("events-trend", "interval=hour&eventName=Signup"),
      env,
    );
    const records = await privateQuery(
      privatePath(
        "events-records",
        "page=1&pageSize=1&sortBy=pathname&sortDir=asc&search=signup",
      ),
      env,
    );
    const detail = await privateQuery(
      privatePath("event-type-detail", "eventName=Signup&interval=hour"),
      env,
    );
    const values = await privateQuery(
      privatePath(
        "event-type-field-values",
        "eventName=Signup&fieldPath=/plan&fieldValueType=string",
      ),
      env,
    );
    const recordDetail = await privateQuery(
      privatePath("event-record-detail", "eventId=evt-1"),
      env,
    );

    expect(await summary.json()).toMatchObject({
      ok: true,
      summary: {
        events: 12,
        eventTypes: 3,
        sessions: 5,
        visitors: 4,
        avgEventsPerSession: 2.4,
      },
      cards: {
        event: { name: [{ label: "Signup", views: 7 }] },
      },
    });
    const trendPayload: any = await trend.json();
    expect(trendPayload).toMatchObject({
      ok: true,
      interval: "hour",
      series: [
        expect.objectContaining({
          eventName: "Signup",
          key: "signup",
        }),
      ],
    });
    expect(trendPayload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucket: 0,
          eventsBySeries: { signup: 2 },
        }),
      ]),
    );
    expect(await records.json()).toMatchObject({
      ok: true,
      data: [
        expect.objectContaining({
          eventId: "evt-1",
          eventName: "Signup",
          pathname: "/signup",
        }),
      ],
      meta: {
        page: 1,
        pageSize: 1,
        returned: 1,
        hasMore: true,
        nextPage: 2,
      },
    });
    expect(await detail.json()).toMatchObject({
      ok: true,
      eventName: "Signup",
      summary: {
        events: 12,
        avgEventsPerSession: 2.4,
        shareOfAllEvents: 1,
      },
      fields: [
        {
          path: "/plan",
          valueType: "string",
          exampleValue: "pro",
        },
      ],
    });
    expect(await values.json()).toMatchObject({
      ok: true,
      fieldPath: "/plan",
      fieldValueType: "string",
      data: [
        {
          value: "pro",
          events: 2,
          occurrences: 3,
        },
      ],
    });
    expect(await recordDetail.json()).toMatchObject({
      ok: true,
      data: {
        event: {
          eventId: "evt-1",
          eventName: "Signup",
        },
        context: {
          visitId: "visit-1",
          pathname: "/signup",
        },
        eventData: {
          plan: "pro",
        },
      },
    });
  });

  it("validates event detail request parameters before querying event aggregates", async () => {
    const { env, prepare } = createEnv({ matches: authMatches() });

    const missingEvent = await privateQuery(
      privatePath("event-type-detail"),
      env,
    );
    const missingField = await privateQuery(
      privatePath("event-type-field-values", "eventName=Signup"),
      env,
    );
    const missingRecord = await privateQuery(
      privatePath("event-record-detail"),
      env,
    );

    expect(missingEvent.status).toBe(400);
    expect(await missingEvent.json()).toMatchObject({
      ok: false,
      error: { message: "eventName is required" },
    });
    expect(missingField.status).toBe(400);
    expect(await missingField.json()).toMatchObject({
      ok: false,
      error: { message: "fieldPath is required" },
    });
    expect(missingRecord.status).toBe(400);
    expect(await missingRecord.json()).toMatchObject({
      ok: false,
      error: { message: "eventId is required" },
    });
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it("maps event field value variants and rejects invalid field value types", async () => {
    const fieldValueMatches: SqlMatch[] = [
      {
        match: (sql, bindings) =>
          includesAll("GROUP BY valueType, stringValue")(sql) &&
          bindings.at(-2) === 2,
        all: [
          {
            valueType: 2,
            events: 2,
            occurrences: 3,
            firstSeenAt: from,
            lastSeenAt: to,
            stringValue: null,
            numberValue: 42.5,
            booleanValue: null,
          },
        ],
      },
      {
        match: (sql, bindings) =>
          includesAll("GROUP BY valueType, stringValue")(sql) &&
          bindings.at(-2) === 3,
        all: [
          {
            valueType: 3,
            events: 1,
            occurrences: 1,
            firstSeenAt: from,
            lastSeenAt: to,
            stringValue: null,
            numberValue: null,
            booleanValue: 1,
          },
        ],
      },
      {
        match: (sql, bindings) =>
          includesAll("GROUP BY valueType, stringValue")(sql) &&
          bindings.at(-2) === 0,
        all: [
          {
            valueType: 0,
            events: 1,
            occurrences: 2,
            firstSeenAt: from,
            lastSeenAt: to,
            stringValue: null,
            numberValue: null,
            booleanValue: null,
          },
        ],
      },
    ];
    const { env } = createEnv({
      matches: [...authMatches(), ...fieldValueMatches],
    });

    const numberValues = await privateQuery(
      privatePath(
        "event-type-field-values",
        "eventName=Signup&fieldPath=/value&fieldValueType=number",
      ),
      env,
    );
    const booleanValues = await privateQuery(
      privatePath(
        "event-type-field-values",
        "eventName=Signup&fieldPath=/active&fieldValueType=boolean",
      ),
      env,
    );
    const nullValues = await privateQuery(
      privatePath(
        "event-type-field-values",
        "eventName=Signup&fieldPath=/missing&fieldValueType=null",
      ),
      env,
    );
    const invalidType = await privateQuery(
      privatePath(
        "event-type-field-values",
        "eventName=Signup&fieldPath=/value&fieldValueType=currency",
      ),
      env,
    );

    expect(await numberValues.json()).toMatchObject({
      ok: true,
      fieldValueType: "number",
      data: [{ value: 42.5 }],
    });
    expect(await booleanValues.json()).toMatchObject({
      ok: true,
      fieldValueType: "boolean",
      data: [{ value: true }],
    });
    expect(await nullValues.json()).toMatchObject({
      ok: true,
      fieldValueType: "null",
      data: [{ value: null }],
    });
    expect(invalidType.status).toBe(400);
    expect(await invalidType.json()).toMatchObject({
      ok: false,
      error: { message: "fieldValueType is required" },
    });
  });

  it("routes visitor, session, retention, and page dashboard handlers", async () => {
    const { env } = createEnv({
      matches: [...authMatches(), ...commonQueryMatches()],
    });

    const visitors = await privateQuery(
      privatePath(
        "visitors",
        "page=1&pageSize=1&sortBy=firstSeenAt&sortDir=asc&search=visitor",
      ),
      env,
    );
    const sessions = await privateQuery(
      privatePath(
        "sessions",
        "page=1&pageSize=1&sortBy=durationMs&sortDir=asc",
      ),
      env,
    );
    const retention = await privateQuery(
      privatePath("retention", "granularity=day"),
      env,
    );
    const pageDashboard = await privateQuery(
      privatePath("pages-dashboard", "page=1&pageSize=2&interval=hour"),
      env,
    );

    expect(await visitors.json()).toMatchObject({
      ok: true,
      data: [
        {
          visitorId: "visitor-1",
          sessions: 2,
          referrerHost: "news.example",
          screenWidth: 1440,
        },
      ],
      meta: {
        page: 1,
        pageSize: 1,
        returned: 1,
        hasMore: false,
      },
    });
    expect(await sessions.json()).toMatchObject({
      ok: true,
      data: [
        {
          sessionId: "session-1",
          durationMs: 10_000,
          performance: {
            ttfb: 12.346,
            cls: 0.025,
          },
        },
      ],
      meta: {
        pageSize: 1,
        hasMore: true,
        nextPage: 2,
      },
    });
    expect(await retention.json()).toMatchObject({
      ok: true,
      granularity: "day",
      cohorts: [
        {
          size: 10,
          periods: [
            { index: 0, visitors: 10, rate: 1 },
            { index: 1, visitors: 4, rate: 0.4 },
          ],
        },
      ],
    });
    expect(await pageDashboard.json()).toMatchObject({
      ok: true,
      interval: "hour",
      data: [
        expect.objectContaining({
          pathname: "/pricing",
          titles: ["Pricing", "Plans"],
          metrics: {
            views: 12,
            visitors: 6,
            sessions: 8,
            bounceRate: 0.25,
            pagesPerSession: 1.5,
            avgDurationMs: 2000,
          },
        }),
        expect.objectContaining({
          pathname: "/docs",
        }),
      ],
      meta: {
        page: 1,
        pageSize: 2,
        returned: 2,
        hasMore: true,
        nextPage: 2,
      },
    });
  });

  it("validates visitor and session detail identifiers", async () => {
    const { env } = createEnv({ matches: authMatches() });

    const missingVisitor = await privateQuery(
      privatePath("visitor-detail"),
      env,
    );
    const missingSession = await privateQuery(
      privatePath("session-detail"),
      env,
    );

    expect(missingVisitor.status).toBe(400);
    expect(await missingVisitor.json()).toMatchObject({
      ok: false,
      error: { message: "Missing visitorId" },
    });
    expect(missingSession.status).toBe(400);
    expect(await missingSession.json()).toMatchObject({
      ok: false,
      error: { message: "Missing sessionId" },
    });
  });

  it("routes browser, client, UTM, referrer, and performance analytics handlers", async () => {
    const { env } = createEnv({
      matches: [...authMatches(), ...commonQueryMatches()],
    });

    const browserTrend = await privateQuery(
      privatePath("browser-trend", "interval=hour&limit=1"),
      env,
    );
    const browserVersion = await privateQuery(
      privatePath("browser-version-breakdown", "browserLimit=1&versionLimit=1"),
      env,
    );
    const browserCross = await privateQuery(
      privatePath(
        "browser-cross-breakdown",
        "browserLimit=1&osLimit=1&deviceTypeLimit=1",
      ),
      env,
    );
    const browserRadar = await privateQuery(privatePath("browser-radar"), env);
    const referrerRadar = await privateQuery(
      privatePath("referrer-radar"),
      env,
    );
    const clientTrend = await privateQuery(
      privatePath(
        "client-dimension-trend",
        "dimension=deviceType&interval=hour",
      ),
      env,
    );
    const invalidClientTrend = await privateQuery(
      privatePath("client-dimension-trend", "dimension=bad"),
      env,
    );
    const utmTrend = await privateQuery(
      privatePath("utm-dimension-trend", "dimension=source&interval=hour"),
      env,
    );
    const invalidUtmTrend = await privateQuery(
      privatePath("utm-dimension-trend", "dimension=bad"),
      env,
    );
    const referrerTrend = await privateQuery(
      privatePath("referrer-dimension-trend", "interval=hour"),
      env,
    );
    const clientCross = await privateQuery(
      privatePath(
        "client-cross-breakdown",
        "primaryDimension=client.browser&secondaryDimension=client.deviceType",
      ),
      env,
    );
    const invalidClientCross = await privateQuery(
      privatePath(
        "client-cross-breakdown",
        "primaryDimension=client.browser&secondaryDimension=client.browser",
      ),
      env,
    );
    const performance = await privateQuery(
      privatePath("performance", "interval=hour&limit=1"),
      env,
    );

    const browserTrendPayload: any = await browserTrend.json();
    expect(browserTrendPayload).toMatchObject({
      ok: true,
      interval: "hour",
      series: [
        { key: "chrome", label: "Chrome", visitors: 6 },
        { key: "other", label: "Other", isOther: true },
      ],
    });
    expect(browserTrendPayload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          visitorsBySeries: { chrome: 3, other: 1 },
          totalVisitors: 4,
        }),
      ]),
    );
    expect(await browserVersion.json()).toMatchObject({
      ok: true,
      data: [
        {
          browser: "Chrome",
          versions: [
            { key: "124", label: "124" },
            { key: "other", label: "Other", isOther: true },
          ],
        },
      ],
    });
    expect(await browserCross.json()).toMatchObject({
      ok: true,
      operatingSystem: {
        columns: [{ key: "windows", label: "Windows" }],
        rows: [{ key: "chrome", cells: [{ key: "windows", visitors: 5 }] }],
      },
    });
    expect(await browserRadar.json()).toMatchObject({
      ok: true,
      data: [
        {
          browser: "Chrome",
          visitors: 6,
          metrics: {
            duration: 1250,
            engagement: 0.75,
            loyalty: 0.5,
          },
        },
      ],
    });
    expect(await referrerRadar.json()).toMatchObject({
      ok: true,
      data: [
        {
          referrer: "news.example",
          metrics: {
            engagement: 0.8,
            loyalty: 0.25,
          },
        },
      ],
    });
    const clientTrendPayload: any = await clientTrend.json();
    expect(clientTrendPayload).toMatchObject({ ok: true });
    expect(clientTrendPayload.series).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Chrome" })]),
    );
    expect(invalidClientTrend.status).toBe(400);
    expect(await invalidClientTrend.json()).toMatchObject({
      ok: false,
      error: { message: "Invalid client dimension" },
    });
    const utmTrendPayload: any = await utmTrend.json();
    expect(utmTrendPayload).toMatchObject({ ok: true });
    expect(utmTrendPayload.series).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Chrome" })]),
    );
    expect(invalidUtmTrend.status).toBe(400);
    expect(await invalidUtmTrend.json()).toMatchObject({
      ok: false,
      error: { message: "Invalid UTM dimension" },
    });
    const referrerTrendPayload: any = await referrerTrend.json();
    expect(referrerTrendPayload).toMatchObject({ ok: true });
    expect(referrerTrendPayload.series).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Chrome" })]),
    );
    const clientCrossPayload: any = await clientCross.json();
    expect(clientCrossPayload).toMatchObject({
      ok: true,
      data: {
        columns: expect.any(Array),
        rows: expect.any(Array),
        totalVisitors: expect.any(Number),
      },
    });
    expect(invalidClientCross.status).toBe(400);
    expect(await invalidClientCross.json()).toMatchObject({
      ok: false,
      error: { message: "Primary and secondary dimensions must differ" },
    });
    const performancePayload: any = await performance.json();
    expect(performancePayload).toMatchObject({
      ok: true,
      interval: "hour",
      summaries: {
        lcp: {
          avg: 123.457,
          p50: 100,
          samples: 8,
        },
      },
    });
    expect(performancePayload.trends.ttfb).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ avg: 50, samples: 4 }),
      ]),
    );
    const pricingRoute = (
      performancePayload.routes as Array<{
        pathname: string;
        metrics: Record<string, { avg: number | null }>;
      }>
    ).find((route) => route.pathname === "/pricing");
    expect(pricingRoute?.metrics.lcp?.avg).toBe(100);

    const usCountry = (
      performancePayload.countries as Array<{
        country: string;
        metrics: Record<string, { avg: number | null }>;
      }>
    ).find((country) => country.country === "US");
    expect(usCountry?.metrics.ttfb?.avg).toBe(30);
  });

  it("routes additional public/private dimension endpoints and empty share trends", async () => {
    const { env } = createEnv({
      matches: [...authMatches(), ...commonQueryMatches()],
    });

    const dimensionRoutes = [
      "page-hash",
      "utm-source",
      "utm-medium",
      "utm-campaign",
      "utm-term",
      "utm-content",
      "countries",
    ];
    for (const route of dimensionRoutes) {
      const response = await privateQuery(
        privatePath(route, "geo=US&limit=0"),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
    }

    const tabRoutes = [
      "overview-page-title",
      "overview-page-hostname",
      "overview-page-entry",
      "overview-page-exit",
      "overview-source-link",
      "overview-client-os-version",
      "overview-client-device-type",
      "overview-client-language",
      "overview-client-screen-size",
      "overview-geo-region",
      "overview-geo-city",
      "overview-geo-continent",
      "overview-geo-timezone",
      "overview-geo-organization",
    ];
    for (const route of tabRoutes) {
      const response = await privateQuery(privatePath(route), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
    }

    const geoOptions = await privateQuery(
      privatePath("filter-options", "filterKey=geo"),
      env,
    );
    expect(await geoOptions.json()).toMatchObject({
      ok: true,
      data: expect.arrayContaining([
        expect.objectContaining({ value: "US", group: "country" }),
        expect.objectContaining({ value: "US::CA::California" }),
        expect.objectContaining({
          value: "US::CA::California::San Francisco",
        }),
      ]),
    });

    const emptyTrend = await privateQuery(
      privatePath("browser-engine-trend", "limit=0"),
      createEnv({ matches: authMatches() }).env,
    );
    expect(await emptyTrend.json()).toMatchObject({
      ok: true,
      series: [],
      data: [],
    });
  });

  it("routes overview tab and geo point handlers", async () => {
    const { env } = createEnv({
      matches: [...authMatches(), ...commonQueryMatches()],
    });

    const pageTab = await privateQuery(privatePath("overview-page-path"), env);
    const sourceTab = await privateQuery(
      privatePath("overview-source-domain"),
      env,
    );
    const clientTab = await privateQuery(
      privatePath("overview-client-browser"),
      env,
    );
    const geoTab = await privateQuery(
      privatePath("overview-geo-country", "geo=US"),
      env,
    );
    const geoPoints = await privateQuery(
      privatePath("overview-geo-points", "applyGeoFilter=1&geo=US"),
      env,
    );

    const pageTabPayload: any = await pageTab.json();
    const sourceTabPayload: any = await sourceTab.json();
    expect(pageTabPayload).toMatchObject({ ok: true });
    expect(pageTabPayload.data).toEqual(
      expect.arrayContaining([
        { label: "/pricing", views: 1, sessions: 1, visitors: 1 },
      ]),
    );
    expect(sourceTabPayload).toMatchObject({ ok: true });
    expect(sourceTabPayload.data).toEqual(
      expect.arrayContaining([
        { label: "news.example", views: 6, sessions: 4, visitors: 3 },
      ]),
    );
    expect(await clientTab.json()).toMatchObject({
      ok: true,
      data: [{ label: "Chrome", views: 1, sessions: 1, visitors: 0 }],
    });
    expect(await geoTab.json()).toMatchObject({
      ok: true,
      data: [
        {
          value: "US",
          label: "US",
          views: 1,
          sessions: 1,
          visitors: 1,
        },
      ],
    });
    expect(await geoPoints.json()).toMatchObject({
      ok: true,
      data: [
        {
          latitude: 37.77,
          longitude: -122.42,
          city: "San Francisco",
        },
      ],
      countryCounts: [],
    });
  });

  it("validates team dashboard auth paths before running team aggregates", async () => {
    const { env: invalidWindowEnv, prepare: invalidWindowPrepare } =
      createEnv();

    const invalidWindow = await privateQuery(
      "/api/private/team-dashboard?teamId=team-1&from=-1&to=10",
      invalidWindowEnv,
    );

    expect(invalidWindow.status).toBe(400);
    expect(await invalidWindow.json()).toMatchObject({
      ok: false,
      error: { message: "Invalid time window" },
    });
    expect(requireSessionMock).not.toHaveBeenCalled();
    expect(invalidWindowPrepare).not.toHaveBeenCalled();

    requireSessionMock.mockResolvedValueOnce(null);
    const { env: unauthorizedEnv, prepare: unauthorizedPrepare } = createEnv();
    const unauthorized = await privateQuery(
      `/api/private/team-dashboard?teamId=team-1&${windowParams}`,
      unauthorizedEnv,
    );

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      ok: false,
      error: { message: "Unauthorized" },
    });
    expect(unauthorizedPrepare).not.toHaveBeenCalled();

    const { env: missingTeamEnv, prepare: missingTeamPrepare } = createEnv();
    const missingTeamId = await privateQuery(
      `/api/private/team-dashboard?${windowParams}`,
      missingTeamEnv,
    );

    expect(missingTeamId.status).toBe(400);
    expect(await missingTeamId.json()).toMatchObject({
      ok: false,
      error: { message: "teamId is required" },
    });
    expect(missingTeamPrepare).not.toHaveBeenCalled();

    requireSessionMock.mockResolvedValueOnce(userSession);
    const { env: deniedEnv, statements } = createEnv({
      matches: [firstMatch(["FROM teams t", "LEFT JOIN team_members"], null)],
    });
    const denied = await privateQuery(
      `/api/private/team-dashboard?teamId=team-1&${windowParams}`,
      deniedEnv,
    );

    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({
      ok: false,
      error: { message: "Team not found" },
    });
    expect(statements[0].bind).toHaveBeenCalledWith(
      "user-1",
      "team-1",
      "user-1",
    );
  });

  it("routes team dashboard with team auth, site summaries, trends, and empty teams", async () => {
    const { env } = createEnv({
      matches: [
        firstMatch(["SELECT id FROM teams"], { id: "team-1" }),
        allMatch(
          ["FROM sites", "WHERE team_id = ?"],
          [
            {
              id: "site-1",
              teamId: "team-1",
              name: "Main",
              domain: "example.com",
              publicEnabled: 1,
              publicSlug: "main",
              createdAt: 10,
              updatedAt: 20,
            },
          ],
        ),
        allMatch(
          ["session_rollup AS", "FROM combined", "GROUP BY siteId"],
          [
            {
              siteId: "site-1",
              views: 20,
              sessions: 8,
              visitors: 6,
              bounces: 2,
              totalDuration: 16_000,
              durationViews: 0,
            },
          ],
        ),
        allMatch(
          ["GROUP BY siteId, bucket"],
          [{ siteId: "site-1", bucket: 0, views: 5, visitors: 3 }],
        ),
      ],
    });

    const response = await privateQuery(
      `/api/private/team-dashboard?teamId=team-1&${windowParams}&interval=hour`,
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        sites: [
          {
            id: "site-1",
            overview: {
              views: 20,
              sessions: 8,
              visitors: 6,
              avgDurationMs: 2000,
            },
          },
        ],
        trend: [
          {
            sites: [{ siteId: "site-1", views: 5, visitors: 3 }],
          },
        ],
      },
    });

    const emptyEnv = createEnv({
      matches: [
        firstMatch(["SELECT id FROM teams"], { id: "team-1" }),
        allMatch(["FROM sites", "WHERE team_id = ?"], []),
      ],
    }).env;
    const emptyResponse = await privateQuery(
      `/api/private/team-dashboard?teamId=team-1&${windowParams}`,
      emptyEnv,
    );

    expect(await emptyResponse.json()).toEqual({
      ok: true,
      data: {
        sites: [],
        trend: [],
      },
    });
  });

  it("handles public query lookup, public privacy envelope, public-only route restrictions, and missing slugs", async () => {
    const { env, statements } = createEnv({
      matches: [...publicAuthMatches(), ...commonQueryMatches()],
    });

    const overview = await publicQuery(publicPath("overview"), env);
    const privateOnly = await publicQuery(publicPath("event-types"), env);
    const missingSlug = await publicQuery(
      `/api/public-sites/%20/overview?${windowParams}`,
      env,
    );
    const badMethod = await publicQuery(publicPath("overview"), env, {
      method: "POST",
    });

    expect(overview.status).toBe(200);
    expect(overview.headers.get("access-control-allow-origin")).toBeNull();
    expect(await overview.json()).toMatchObject({
      ok: true,
      data: {
        views: 20,
        sessions: 8,
      },
    });
    expect(statements[0].bind).toHaveBeenCalledWith("public-slug");
    expect(privateOnly.status).toBe(404);
    expect(await privateOnly.json()).toMatchObject({
      ok: false,
      error: { message: "Not Found" },
    });
    expect(missingSlug.status).toBe(404);
    expect(await missingSlug.json()).toMatchObject({
      ok: false,
      error: { message: "Public site not found" },
    });
    expect(badMethod.status).toBe(405);
  });

  it("allows public trend requests and handles public lookup misses", async () => {
    const { env, statements } = createEnv({
      matches: [...publicAuthMatches(), ...commonQueryMatches()],
    });

    const trend = await publicQuery(publicPath("trend", "interval=hour"), env);

    expect(trend.status).toBe(200);
    const trendPayload: any = await trend.json();
    expect(trendPayload).toMatchObject({
      ok: true,
      interval: "hour",
    });
    expect(trendPayload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucket: 0,
          views: 5,
          source: "detail",
        }),
      ]),
    );
    expect(statements[0].bind).toHaveBeenCalledWith("public-slug");

    const missingEnv = createEnv({
      matches: [firstMatch(["public_enabled=1", "public_slug=?"], null)],
    }).env;
    const missing = await publicQuery(publicPath("overview"), missingEnv);

    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      ok: false,
      error: { message: "Public site not found" },
    });
  });

  it("returns a JSON error for malformed public slugs", async () => {
    const { env, prepare } = createEnv();

    const response = await publicQuery(
      `/api/public-sites/%E0%A4%A/overview?${windowParams}`,
      env,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { message: "Public site not found" },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("serves public pages and referrers advertised by the edge client", async () => {
    const { env } = createEnv({
      matches: [...publicAuthMatches(), ...commonQueryMatches()],
    });

    const pages = await publicQuery(publicPath("pages"), env);
    const referrers = await publicQuery(publicPath("referrers"), env);

    expect(pages.status).toBe(200);
    expect(await pages.json()).toMatchObject({
      ok: true,
      data: expect.any(Array),
    });
    expect(referrers.status).toBe(200);
    expect(await referrers.json()).toMatchObject({
      ok: true,
      data: expect.any(Array),
    });
  });

  it("returns not found for unknown private paths after authorization", async () => {
    const { env } = createEnv({ matches: authMatches() });

    const response = await privateQuery(privatePath("does-not-exist"), env);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { message: "Not Found" },
    });
  });
});
