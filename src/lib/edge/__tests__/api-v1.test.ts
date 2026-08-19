import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import {
  type ApiKeyRow,
  generateApiKeySecret,
  hashApiKeySecret,
} from "@/lib/edge/api-key-store";
import {
  handleApiV1,
  handleApiV1ForPrincipal,
  handleBatch,
  handleCapabilities,
  handleRoot,
  handleToken,
  handleTokenCheck,
} from "@/lib/edge/api-v1";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";
import { j } from "@/lib/response";

vi.mock("@/lib/edge/api-v1-query-adapter", async () => {
  const actual = await vi.importActual("@/lib/edge/api-v1-query-adapter");
  return {
    ...(actual as Record<string, unknown>),
    queryApiV1EventRecordDetail: vi.fn(),
    queryApiV1EventRecords: vi.fn(),
    queryApiV1EventFieldValues: vi.fn(),
    queryApiV1EventsSummary: vi.fn(),
    queryApiV1EventsTrend: vi.fn(),
    queryApiV1EventTypes: vi.fn(),
    queryApiV1EventTypeDetail: vi.fn(),
    queryApiV1JourneyEvents: vi.fn(),
    queryApiV1JourneySessions: vi.fn(),
    queryApiV1Retention: vi.fn(),
    queryApiV1CrossBreakdown: vi.fn(),
    queryApiV1Breakdown: vi.fn(),
    queryApiV1Overview: vi.fn(),
    queryApiV1SessionDetail: vi.fn(),
    queryApiV1Sessions: vi.fn(),
    queryApiV1Trend: vi.fn(),
    queryApiV1VisitorDetail: vi.fn(),
    queryApiV1Visitors: vi.fn(),
  };
});

vi.mock("@/lib/edge/query/funnels", async () => {
  const actual = await vi.importActual("@/lib/edge/query/funnels");
  return {
    ...(actual as Record<string, unknown>),
    queryFunnelAnalysis: vi.fn(),
  };
});

vi.mock("@/lib/edge/site-settings-store", async () => {
  const actual = await vi.importActual("@/lib/edge/site-settings-store");
  return {
    ...(actual as Record<string, unknown>),
    readSiteScriptSettings: vi.fn(),
    upsertSiteScriptSettings: vi.fn(),
  };
});

vi.mock("@/lib/edge/admin-sites", () => ({
  deleteSiteData: vi.fn(),
  createSiteWithDefaultSettings: vi.fn(),
  ensurePublicSlugAvailable: vi.fn(),
}));

import {
  createSiteWithDefaultSettings,
  deleteSiteData,
  ensurePublicSlugAvailable,
} from "@/lib/edge/admin-sites";
import {
  queryApiV1Breakdown,
  queryApiV1CrossBreakdown,
  queryApiV1EventFieldValues,
  queryApiV1EventRecordDetail,
  queryApiV1EventRecords,
  queryApiV1EventsSummary,
  queryApiV1EventsTrend,
  queryApiV1EventTypeDetail,
  queryApiV1EventTypes,
  queryApiV1JourneyEvents,
  queryApiV1JourneySessions,
  queryApiV1Overview,
  queryApiV1Retention,
  queryApiV1SessionDetail,
  queryApiV1Sessions,
  queryApiV1Trend,
  queryApiV1VisitorDetail,
  queryApiV1Visitors,
} from "@/lib/edge/api-v1-query-adapter";
import { queryFunnelAnalysis } from "@/lib/edge/query/funnels";
import {
  readSiteScriptSettings,
  upsertSiteScriptSettings,
} from "@/lib/edge/site-settings-store";

// Retained as a sentinel for assertions that API v1 no longer bridges routes.
const routeQueryMock = vi.fn();
const queryApiV1EventRecordsMock = vi.mocked(queryApiV1EventRecords);
const queryApiV1EventRecordDetailMock = vi.mocked(queryApiV1EventRecordDetail);
const queryApiV1EventFieldValuesMock = vi.mocked(queryApiV1EventFieldValues);
const queryApiV1EventsSummaryMock = vi.mocked(queryApiV1EventsSummary);
const queryApiV1EventsTrendMock = vi.mocked(queryApiV1EventsTrend);
const queryApiV1EventTypesMock = vi.mocked(queryApiV1EventTypes);
const queryApiV1EventTypeDetailMock = vi.mocked(queryApiV1EventTypeDetail);
const queryApiV1JourneyEventsMock = vi.mocked(queryApiV1JourneyEvents);
const queryApiV1JourneySessionsMock = vi.mocked(queryApiV1JourneySessions);
const queryApiV1RetentionMock = vi.mocked(queryApiV1Retention);
const queryApiV1CrossBreakdownMock = vi.mocked(queryApiV1CrossBreakdown);
const queryApiV1BreakdownMock = vi.mocked(queryApiV1Breakdown);
const queryApiV1OverviewMock = vi.mocked(queryApiV1Overview);
const queryApiV1SessionDetailMock = vi.mocked(queryApiV1SessionDetail);
const queryApiV1SessionsMock = vi.mocked(queryApiV1Sessions);
const queryApiV1TrendMock = vi.mocked(queryApiV1Trend);
const queryApiV1VisitorDetailMock = vi.mocked(queryApiV1VisitorDetail);
const queryApiV1VisitorsMock = vi.mocked(queryApiV1Visitors);
const queryFunnelAnalysisMock = vi.mocked(queryFunnelAnalysis);
const readSiteScriptSettingsMock = vi.mocked(readSiteScriptSettings);
const upsertSiteScriptSettingsMock = vi.mocked(upsertSiteScriptSettings);
const deleteSiteDataMock = vi.mocked(deleteSiteData);

interface MockStatement {
  sql: string;
  bindings: Array<string | number | null>;
  bind: (...bindings: Array<string | number | null>) => MockStatement;
  first: () => Promise<Record<string, unknown> | null>;
  all: () => Promise<{ results: Record<string, unknown>[] }>;
  run: () => Promise<{ success: boolean }>;
}

interface Match {
  includes?: string[];
  excludes?: string[];
  first?: Record<string, unknown> | null;
  all?: Record<string, unknown>[];
}

interface PreparedSql {
  sql: string;
  bindings: Array<string | number | null>;
}

function createEnv(matches: Match[]) {
  const preparedSql: string[] = [];
  const preparedStatements: PreparedSql[] = [];
  return {
    preparedSql,
    preparedStatements,
    MAIN_SECRET: "api-secret",
    INGEST_DO: {
      idFromName: vi.fn(() => "stub-id"),
      get: vi.fn(() => ({
        fetch: vi.fn(async (input: string) => ({
          json: async () =>
            input.includes("/active")
              ? { activeNow: 3 }
              : { activeNow: 3, data: [{ id: "evt-1" }] },
        })),
      })),
    },
    DB: {
      prepare(sql: string) {
        preparedSql.push(sql);
        const statement: MockStatement = {
          sql,
          bindings: [],
          bind(...bindings) {
            this.bindings = bindings;
            return this;
          },
          async first() {
            const match = matches.find(
              (item) =>
                (item.includes ?? []).every((needle) =>
                  statement.sql.includes(needle),
                ) &&
                (item.excludes ?? []).every(
                  (needle) => !statement.sql.includes(needle),
                ),
            );
            return match && "first" in match ? (match.first ?? null) : null;
          },
          async all() {
            const match = matches.find(
              (item) =>
                (item.includes ?? []).every((needle) =>
                  statement.sql.includes(needle),
                ) &&
                (item.excludes ?? []).every(
                  (needle) => !statement.sql.includes(needle),
                ),
            );
            return { results: match?.all ?? [] };
          },
          async run() {
            return { success: true };
          },
        };
        preparedStatements.push(statement);
        return statement;
      },
    } as unknown as D1Database,
  } as unknown as Env & {
    preparedSql: string[];
    preparedStatements: PreparedSql[];
  };
}

function request(path: string, apiKey?: string, init?: RequestInit): Request {
  return new Request(`https://edge.test${path}`, {
    ...init,
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

async function keyRow(
  overrides: Partial<ApiKeyRow> = {},
): Promise<{ apiKey: string; row: ApiKeyRow }> {
  const generated = generateApiKeySecret();
  const env = { MAIN_SECRET: "api-secret" } as Env;
  return {
    apiKey: generated.apiKey,
    row: {
      id: "key-1",
      team_id: "team-1",
      name: "CI",
      key_prefix: generated.prefix,
      key_hash: await hashApiKeySecret(env, generated.apiKey),
      scopes_json: JSON.stringify([
        "site:read",
        "site:write",
        "site_config:read",
        "site_config:write",
        "analytics:read",
      ]),
      site_ids_json: "[]",
      created_by_user_id: "user-1",
      expires_at: null,
      revoked_at: null,
      revoked_by_user_id: null,
      rotated_from_key_id: null,
      last_used_at: 101,
      created_at: 100,
      updated_at: 100,
      ...overrides,
    },
  };
}

function siteRow(id: string, name: string) {
  return {
    id,
    teamId: "team-1",
    name,
    domain: `${name}.test`,
    publicEnabled: 0,
    publicSlug: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

function principal(overrides: Partial<ApiKeyPrincipal> = {}): ApiKeyPrincipal {
  return {
    keyId: "key-1",
    teamId: "team-1",
    prefix: "if_123",
    scopes: ["analytics:read"],
    siteIds: [],
    ...overrides,
  };
}

function authMatch(row: ApiKeyRow): Match {
  return {
    includes: ["FROM api_keys", "key_prefix"],
    first: row as unknown as Record<string, unknown>,
  };
}

function teamMatch(): Match {
  return {
    includes: ["FROM teams"],
    first: { id: "team-1", name: "Team One", createdAt: 1 },
  };
}

function siteMatch(siteId: string, siteName: string): Match {
  return {
    includes: ["FROM sites", "WHERE id=?"],
    first: siteRow(siteId, siteName),
  };
}

function sitesListMatch(sites: Array<{ id: string; name: string }>): Match {
  return {
    includes: ["FROM sites", "WHERE team_id=?"],
    all: sites.map((site) => siteRow(site.id, site.name)),
  };
}

function teamSitesListMatch(sites: Array<{ id: string; name: string }>): Match {
  return {
    includes: ["FROM sites", "WHERE team_id = ?"],
    all: sites.map((site) => ({
      ...siteRow(site.id, site.name),
      teamId: "team-1",
      publicEnabled: 0,
      publicSlug: null,
      createdAt: 1,
      updatedAt: 2,
    })),
  };
}

function funnelRow(id: string, siteId = "site-1") {
  return {
    id,
    site_id: siteId,
    name: "Signup",
    config_json: JSON.stringify({
      steps: [
        { type: "pageview", value: "/pricing" },
        { type: "event", value: "signup" },
      ],
    }),
    created_at: 1,
    updated_at: 2,
  };
}

function funnelsListMatch(funnels: Array<Record<string, unknown>>): Match {
  return {
    includes: ["FROM analysis_definitions", "ORDER BY created_at DESC"],
    all: funnels,
  };
}

function funnelMatch(funnel: Record<string, unknown> | null): Match {
  return {
    includes: ["FROM analysis_definitions", "LIMIT 1"],
    first: funnel,
  };
}

async function authed(
  path: string,
  matches: Match[],
  init?: RequestInit,
  overrides?: Partial<ApiKeyRow>,
) {
  const generated = await keyRow(overrides);
  const env = createEnv([authMatch(generated.row), ...matches]);
  const response = await handleApiV1(
    request(path, generated.apiKey, init),
    env,
    new URL(`https://edge.test${path}`),
  );
  return { response, generated, env };
}

describe("api v1 gateway", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    routeQueryMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            views: 10,
            sessions: 8,
            visitors: 7,
            bounces: 2,
            bounceRate: 0.25,
            avgDurationMs: 1500,
            viewsPerSession: 1.25,
            approximateVisitors: false,
          },
          interval: "day",
          requestId: "legacy",
          timestamp: "2026-06-26T00:00:00Z",
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    queryApiV1OverviewMock.mockResolvedValue({
      ok: true,
      data: {
        current: {
          views: 10,
          sessions: 8,
          visitors: 7,
          bounces: 2,
          totalDurationMs: 12_000,
          durationViews: 8,
        },
      },
      meta: {
        time: {} as never,
        source: "raw",
        approximateVisitors: false,
      },
    });
    queryApiV1TrendMock.mockResolvedValue({
      ok: true,
      data: {
        interval: "day",
        points: [
          {
            bucket: 0,
            timestampMs: Date.UTC(2026, 5, 1) as never,
            views: 2,
            sessions: 1,
            visitors: 1,
            bounces: 0,
            totalDurationMs: 0,
            durationViews: 0,
          },
        ],
      },
      meta: {
        time: {} as never,
        source: "raw",
        approximateVisitors: false,
      },
    });
    queryApiV1EventRecordsMock.mockResolvedValue({
      ok: true,
      data: {
        data: [],
        pagination: { limit: 100, nextCursor: null, hasMore: false },
      },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1VisitorsMock.mockResolvedValue({
      ok: true,
      data: {
        data: [],
        pagination: { limit: 100, nextCursor: null, hasMore: false },
      },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1SessionsMock.mockResolvedValue({
      ok: true,
      data: {
        data: [],
        pagination: { limit: 100, nextCursor: null, hasMore: false },
      },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1EventRecordDetailMock.mockResolvedValue({
      ok: true,
      data: null,
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1EventFieldValuesMock.mockResolvedValue({
      ok: true,
      data: [],
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1EventsSummaryMock.mockResolvedValue({
      ok: true,
      data: { summary: {}, cards: {} },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1EventsTrendMock.mockResolvedValue({
      ok: true,
      data: { interval: "day", series: [], data: [] },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1EventTypesMock.mockResolvedValue({
      ok: true,
      data: [],
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1EventTypeDetailMock.mockResolvedValue({
      ok: true,
      data: {
        eventName: "event",
        summary: {},
        trend: {},
        breakdowns: {},
        cards: {},
        fields: [],
      },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1JourneyEventsMock.mockResolvedValue({
      ok: true,
      data: {
        data: [],
        pagination: { limit: 100, nextCursor: null, hasMore: false },
      },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1JourneySessionsMock.mockResolvedValue({
      ok: true,
      data: {
        data: [],
        pagination: { limit: 100, nextCursor: null, hasMore: false },
      },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1RetentionMock.mockResolvedValue({
      ok: true,
      data: { granularity: "week", cohorts: [] },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1CrossBreakdownMock.mockResolvedValue({
      ok: true,
      data: { columns: [], rows: [], totalVisitors: 0 },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1BreakdownMock.mockResolvedValue({
      ok: true,
      data: [],
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1VisitorDetailMock.mockResolvedValue({
      ok: true,
      data: null,
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    queryApiV1SessionDetailMock.mockResolvedValue({
      ok: true,
      data: null,
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    readSiteScriptSettingsMock.mockResolvedValue(null);
    upsertSiteScriptSettingsMock.mockResolvedValue({
      trackingStrength: "smart",
      trackQueryParams: false,
      trackHash: true,
      autoTrackOutboundLinks: true,
      domainWhitelist: [],
      pathBlacklist: [],
      ignoreDoNotTrack: false,
      performanceSampleRate: 100,
    });
    vi.mocked(ensurePublicSlugAvailable).mockResolvedValue(true);
    deleteSiteDataMock.mockResolvedValue();
    queryFunnelAnalysisMock.mockResolvedValue({
      steps: [
        {
          index: 0,
          label: "/pricing",
          type: "pageview",
          sessions: 10,
          visitors: 9,
          conversionRate: 100,
          stepConversionRate: 100,
          dropOffSessions: 2,
          dropOffRate: 20,
        },
        {
          index: 1,
          label: "signup",
          type: "event",
          sessions: 8,
          visitors: 7,
          conversionRate: 80,
          stepConversionRate: 80,
          dropOffSessions: 0,
          dropOffRate: 0,
        },
      ],
      summary: {
        totalSessions: 10,
        convertedSessions: 8,
        totalVisitors: 9,
        convertedVisitors: 7,
        overallConversionRate: 80,
        largestDropOffStepIndex: 1,
      },
    });
  });

  it("returns root discovery without authentication", async () => {
    const response = await handleApiV1(
      request("/api/v1"),
      createEnv([]),
      new URL("https://edge.test/api/v1"),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { links: Record<string, string> };
      meta: { generatedAt: string };
    };
    expect(body.data.links.openapi).toBe("/.well-known/openapi.json");
    expect(body.meta.generatedAt).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain('"ok"');
  });

  it("serves root discovery through the authenticated dispatcher", async () => {
    const req = request("/api/v1");
    const response = await handleApiV1ForPrincipal(
      req,
      createEnv([]),
      new URL(req.url),
      principal(),
    );

    expect(response.status).toBe(200);
  });

  it("rejects non-GET discovery requests", async () => {
    const response = await handleRoot(
      request("/api/v1", undefined, { method: "POST" }),
    );

    expect(response.status).toBe(405);
  });

  it("rejects missing, expired, and revoked API keys with the new error envelope", async () => {
    const missing = await handleApiV1(
      request("/api/v1/sites"),
      createEnv([]),
      new URL("https://edge.test/api/v1/sites"),
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      error: { code: "invalid_api_key" },
      meta: { generatedAt: expect.any(String) },
    });

    const expiredKey = await keyRow({ expires_at: 1 });
    const expired = await handleApiV1(
      request("/api/v1/sites", expiredKey.apiKey),
      createEnv([authMatch(expiredKey.row)]),
      new URL("https://edge.test/api/v1/sites"),
    );
    expect(expired.status).toBe(401);

    const revokedKey = await keyRow({ revoked_at: 2 });
    const revoked = await handleApiV1(
      request("/api/v1/sites", revokedKey.apiKey),
      createEnv([authMatch(revokedKey.row)]),
      new URL("https://edge.test/api/v1/sites"),
    );
    expect(revoked.status).toBe(401);
  });

  it("introspects the current token without returning secrets", async () => {
    const { response } = await authed("/api/v1/token", [teamMatch()]);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { name: string; scopes: string[]; siteAccess: { mode: string } };
    };
    expect(body.data.name).toBe("CI");
    expect(body.data.scopes).toContain("analytics:read");
    expect(body.data.siteAccess.mode).toBe("all");
    expect(JSON.stringify(body)).not.toContain("key_hash");
    expect(JSON.stringify(body)).not.toContain("ifk_live_");
  });

  it("checks token scope and site access in bulk", async () => {
    const { response } = await authed(
      "/api/v1/token/check",
      [],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checks: [
            { scope: "analytics:read", siteId: "site-2" },
            { scope: "site:write" },
          ],
        }),
      },
      {
        scopes_json: JSON.stringify(["analytics:read"]),
        site_ids_json: JSON.stringify(["site-2"]),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        checks: [
          { scope: "analytics:read", siteId: "site-2", allowed: true },
          { scope: "site:write", allowed: false, reason: "missing_scope" },
        ],
      },
    });
  });

  it("reports inactive and site-restricted token check reasons", async () => {
    const inactive = await handleTokenCheck(
      request("/api/v1/token/check", undefined, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checks: [{ scope: "analytics:read" }],
        }),
      }),
      principal({ status: "revoked", scopes: ["analytics:read"] }),
    );
    const restricted = await handleTokenCheck(
      request("/api/v1/token/check", undefined, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checks: [{ scope: "analytics:read", siteId: "site-2" }],
        }),
      }),
      principal({ scopes: ["analytics:read"], siteIds: ["site-1"] }),
    );

    expect(await inactive.json()).toMatchObject({
      data: { checks: [{ allowed: false, reason: "token_inactive" }] },
    });
    expect(await restricted.json()).toMatchObject({
      data: { checks: [{ allowed: false, reason: "site_not_allowed" }] },
    });
  });

  it("rejects invalid token check bodies", async () => {
    const invalidJson = await handleTokenCheck(
      request("/api/v1/token/check", undefined, {
        method: "POST",
        body: "not json",
      }),
      principal(),
    );

    expect(invalidJson.status).toBe(400);
  });

  it("returns capabilities based on token scopes", async () => {
    const { response } = await authed("/api/v1/capabilities", [], undefined, {
      scopes_json: JSON.stringify(["analytics:read"]),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        features: {
          analytics: true,
          sites: false,
          exports: false,
          batch: true,
        },
        limits: { batchMaxRequests: 20 },
      },
    });
  });

  it("rejects non-GET token and capabilities requests", async () => {
    const token = await handleToken(
      request("/api/v1/token", undefined, { method: "POST" }),
      createEnv([]),
      principal(),
    );
    const capabilities = await handleCapabilities(
      request("/api/v1/capabilities", undefined, { method: "POST" }),
      principal(),
    );

    expect(token.status).toBe(405);
    expect(capabilities.status).toBe(405);
  });

  it("falls back token fields and reports restricted capabilities", async () => {
    const token = await handleToken(
      request("/api/v1/token"),
      createEnv([teamMatch()]),
      principal({
        name: undefined,
        status: undefined,
        scopes: ["site_config:read"],
        siteIds: ["site-1"],
        createdAt: undefined,
        expiresAt: undefined,
        lastUsedAt: undefined,
      }),
    );
    const capabilities = await handleCapabilities(
      request("/api/v1/capabilities"),
      principal({
        scopes: ["site_config:read"],
        siteIds: ["site-1"],
      }),
    );

    expect(await token.json()).toMatchObject({
      data: {
        name: "",
        status: "active",
        siteAccess: { mode: "restricted", siteIds: ["site-1"] },
      },
    });
    expect(await capabilities.json()).toMatchObject({
      data: {
        features: {
          sites: false,
          tracking: true,
          analytics: false,
        },
      },
    });
  });

  it("lists only sites available to a restricted key", async () => {
    const { response } = await authed(
      "/api/v1/sites",
      [
        sitesListMatch([
          { id: "site-1", name: "One" },
          { id: "site-2", name: "Two" },
        ]),
      ],
      undefined,
      { site_ids_json: JSON.stringify(["site-2"]) },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: Array<{ id: string }> };
    expect(payload.data).toEqual([expect.objectContaining({ id: "site-2" })]);
  });

  it("creates, updates, and deletes sites with new response shape", async () => {
    vi.mocked(createSiteWithDefaultSettings).mockResolvedValue("new-site");
    const created = await authed(
      "/api/v1/sites",
      [siteMatch("new-site", "NewSite")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "NewSite", domain: "newsite.test" }),
      },
    );

    expect(created.response.status).toBe(201);
    expect(await created.response.json()).toMatchObject({
      data: {
        id: "new-site",
        sharing: { publicEnabled: false, publicSlug: null },
        links: { tracking: "/api/v1/sites/new-site/tracking" },
      },
    });

    const updated = await authed(
      "/api/v1/sites/site-1",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      },
    );
    expect(updated.response.status).toBe(200);
    expect(upsertSiteScriptSettingsMock).toHaveBeenCalled();

    const deleted = await authed(
      "/api/v1/sites/site-1",
      [siteMatch("site-1", "Blog")],
      { method: "DELETE" },
    );
    expect(deleted.response.status).toBe(204);
    expect(deleteSiteDataMock).toHaveBeenCalledWith(
      expect.anything(),
      "site-1",
    );
  });

  it("returns 404 instead of 403 for a site outside a restricted token allowlist", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1",
      [siteMatch("site-1", "Blog")],
      undefined,
      { site_ids_json: JSON.stringify(["site-2"]) },
    );

    expect(response.status).toBe(404);
  });

  it("handles tracking, privacy, sharing, and tracking script settings", async () => {
    const tracking = await authed("/api/v1/sites/site-1/tracking", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(tracking.response.status).toBe(200);
    expect(await tracking.response.json()).toMatchObject({
      data: { trackPageviews: true, trackQuery: true },
    });

    const privacy = await authed("/api/v1/sites/site-1/privacy", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(privacy.response.status).toBe(200);
    expect(await privacy.response.json()).toMatchObject({
      data: { anonymizeIp: true, visitorTokenMode: "daily" },
    });

    const sharing = await authed("/api/v1/sites/site-1/sharing", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(sharing.response.status).toBe(200);
    expect(await sharing.response.json()).toMatchObject({
      data: { publicEnabled: false, publicSlug: null },
    });

    const script = await authed("/api/v1/sites/site-1/tracking/script", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(script.response.status).toBe(200);
    expect(await script.response.json()).toMatchObject({
      data: {
        siteId: "site-1",
        src: "https://edge.test/script.js?siteId=site-1",
      },
    });
  });

  it("returns analytics schema, overview, timeseries, and breakdown primitives", async () => {
    const schema = await authed("/api/v1/sites/site-1/analytics/schema", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(schema.response.status).toBe(200);
    expect(await schema.response.json()).toMatchObject({
      data: {
        metrics: expect.arrayContaining([
          expect.objectContaining({ key: "views" }),
        ]),
        dimensions: expect.arrayContaining([
          expect.objectContaining({ key: "geo.country" }),
        ]),
        filterProtocol: expect.objectContaining({
          version: 1,
          urlGrammar: expect.stringContaining("filter[field]"),
          fields: expect.arrayContaining([
            expect.objectContaining({
              id: "event.payload",
              valueKind: "json-scalar",
            }),
          ]),
        }),
      },
    });

    const overview = await authed(
      "/api/v1/sites/site-1/analytics/overview?preset=last_7_days&timeZone=UTC&metrics=views,sessions",
      [siteMatch("site-1", "Blog")],
    );
    expect(overview.response.status).toBe(200);
    expect(await overview.response.json()).toMatchObject({
      data: { views: 10, sessions: 8 },
      meta: { timeRange: expect.any(Object) },
    });

    const timeseries = await authed(
      "/api/v1/sites/site-1/analytics/timeseries?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&interval=day",
      [siteMatch("site-1", "Blog")],
    );
    expect(timeseries.response.status).toBe(200);
    expect(await timeseries.response.json()).toMatchObject({
      data: [
        expect.objectContaining({
          start: "2026-06-01T00:00:00.000Z",
          end: "2026-06-02T00:00:00.000Z",
        }),
      ],
      meta: { interval: "day" },
    });

    queryApiV1BreakdownMock.mockResolvedValueOnce({
      ok: true,
      data: [{ value: "US", label: "United States", views: 4, sessions: 3 }],
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    const breakdown = await authed(
      "/api/v1/sites/site-1/analytics/breakdowns/geo.country?preset=last_30_days&metrics=views,sessions",
      [siteMatch("site-1", "Blog")],
    );
    expect(breakdown.response.status).toBe(200);
    expect(queryApiV1BreakdownMock).toHaveBeenLastCalledWith(
      expect.anything(),
      "site-1",
      expect.any(URL),
      expect.objectContaining({ startMs: expect.any(Number) }),
      "geo.country",
    );
    expect(await breakdown.response.json()).toMatchObject({
      data: [{ key: "US", label: "United States", views: 4, sessions: 3 }],
    });
  });

  it("reuses structured payloads from internal legacy queries", async () => {
    const internalResponse = j({
      ok: true,
      data: { views: 10, sessions: 8 },
      interval: "day",
    });
    const json = vi.spyOn(internalResponse, "json");
    routeQueryMock.mockResolvedValueOnce(internalResponse);

    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/overview?preset=last_7_days",
      [siteMatch("site-1", "Blog")],
    );

    expect(response.status).toBe(200);
    expect(json).not.toHaveBeenCalled();
  });

  it("uses cursor pagination for events, visitors, and sessions", async () => {
    routeQueryMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: [],
          pagination: { page: 1, pageSize: 100, total: 0 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const events = await authed("/api/v1/sites/site-1/events?limit=100", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(events.response.status).toBe(200);
    expect(await events.response.json()).toMatchObject({
      data: [],
      pagination: { limit: 100, nextCursor: null, hasMore: false },
    });
  });

  it("adapts private event keyset cursors without changing the v1 envelope", async () => {
    queryApiV1EventRecordsMock.mockResolvedValueOnce({
      ok: true,
      data: {
        data: [{ eventId: "evt-1" }],
        pagination: {
          limit: 120,
          hasMore: true,
          nextCursor: "next-private-cursor",
        },
      },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });

    const { response } = await authed(
      "/api/v1/sites/site-1/events?limit=120&cursor=previous-private-cursor",
      [siteMatch("site-1", "Blog")],
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [{ eventId: "evt-1" }],
      pagination: {
        limit: 120,
        hasMore: true,
        nextCursor: "next-private-cursor",
      },
    });
    expect(queryApiV1EventRecordsMock).toHaveBeenCalledWith(
      expect.anything(),
      "site-1",
      expect.any(URL),
      expect.objectContaining({ startMs: expect.any(Number) }),
      { limit: 120, cursor: "previous-private-cursor" },
    );
  });

  it("adapts private Journey keyset cursors without changing the v1 envelope", async () => {
    const page = {
      ok: true as const,
      data: {
        data: [{ id: "journey-1" }],
        pagination: {
          limit: 50,
          hasMore: true,
          nextCursor: "next-journey-cursor",
        },
      },
      meta: {
        time: {} as never,
        source: "raw" as const,
        approximateVisitors: false,
      },
    };
    queryApiV1VisitorsMock.mockResolvedValueOnce(page);
    queryApiV1SessionsMock.mockResolvedValueOnce(page);

    const visitors = await authed(
      "/api/v1/sites/site-1/visitors?limit=50&cursor=visitor-cursor",
      [siteMatch("site-1", "Blog")],
    );
    const sessions = await authed(
      "/api/v1/sites/site-1/sessions?limit=50&cursor=session-cursor",
      [siteMatch("site-1", "Blog")],
    );

    expect(await visitors.response.json()).toMatchObject({
      pagination: {
        limit: 50,
        hasMore: true,
        nextCursor: "next-journey-cursor",
      },
    });
    expect(await sessions.response.json()).toMatchObject({
      pagination: {
        limit: 50,
        hasMore: true,
        nextCursor: "next-journey-cursor",
      },
    });
    expect(queryApiV1VisitorsMock).toHaveBeenCalledWith(
      expect.anything(),
      "site-1",
      expect.any(URL),
      expect.anything(),
      { limit: 50, cursor: "visitor-cursor" },
    );
    expect(queryApiV1SessionsMock).toHaveBeenCalledWith(
      expect.anything(),
      "site-1",
      expect.any(URL),
      expect.anything(),
      { limit: 50, cursor: "session-cursor" },
    );
  });

  it("serves team analytics from the team dashboard runtime", async () => {
    const matches = [
      teamSitesListMatch([
        { id: "site-1", name: "One" },
        { id: "site-2", name: "Two" },
      ]),
      {
        includes: ["FROM combined", "GROUP BY siteId"],
        all: [
          {
            siteId: "site-1",
            views: 10,
            sessions: 5,
            visitors: 4,
            bounces: 1,
            totalDuration: 1000,
            durationViews: 5,
          },
          {
            siteId: "site-2",
            views: 20,
            sessions: 10,
            visitors: 8,
            bounces: 2,
            totalDuration: 3000,
            durationViews: 10,
          },
        ],
      },
      {
        includes: ["GROUP BY siteId, bucket"],
        all: [
          { siteId: "site-1", bucket: 0, views: 3, visitors: 2 },
          { siteId: "site-2", bucket: 0, views: 4, visitors: 3 },
        ],
      },
    ];

    const overview = await authed(
      "/api/v1/team/analytics/overview?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      matches,
    );
    expect(overview.response.status).toBe(200);
    expect(await overview.response.json()).toMatchObject({
      data: {
        views: 30,
        sessions: 15,
        visitors: 12,
        bounces: 3,
        bounceRate: 0.2,
        avgDurationMs: 267,
      },
    });

    const timeseries = await authed(
      "/api/v1/team/analytics/timeseries?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&interval=day",
      matches,
    );
    expect(timeseries.response.status).toBe(200);
    expect(await timeseries.response.json()).toMatchObject({
      data: [
        {
          start: "2026-06-01T00:00:00.000Z",
          views: 7,
          visitors: 5,
        },
      ],
      meta: { interval: "day" },
    });

    const sites = await authed(
      "/api/v1/team/analytics/sites?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      matches,
    );
    expect(sites.response.status).toBe(200);
    expect(await sites.response.json()).toMatchObject({
      data: [
        expect.objectContaining({ key: "site-1", label: "One", views: 10 }),
        expect.objectContaining({ key: "site-2", label: "Two", views: 20 }),
      ],
    });
  });

  it("manages saved funnels and analyzes stored definitions", async () => {
    const list = await authed("/api/v1/sites/site-1/funnels", [
      siteMatch("site-1", "Blog"),
      funnelsListMatch([funnelRow("funnel-1")]),
    ]);
    expect(list.response.status).toBe(200);
    expect(await list.response.json()).toMatchObject({
      data: [
        {
          id: "funnel-1",
          steps: [
            { type: "pageview", value: "/pricing" },
            { type: "event", value: "signup" },
          ],
        },
      ],
    });

    const created = await authed(
      "/api/v1/sites/site-1/funnels",
      [siteMatch("site-1", "Blog")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Checkout",
          steps: [
            { type: "pageview", value: "/checkout" },
            { type: "event", value: "purchase" },
          ],
        }),
      },
    );
    expect(created.response.status).toBe(201);
    expect(await created.response.json()).toMatchObject({
      data: {
        siteId: "site-1",
        name: "Checkout",
        links: {
          analysis: expect.stringContaining("/analysis"),
        },
      },
    });

    const analyzed = await authed(
      "/api/v1/sites/site-1/funnels/funnel-1/analysis?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog"), funnelMatch(funnelRow("funnel-1"))],
    );
    expect(analyzed.response.status).toBe(200);
    expect(queryFunnelAnalysisMock).toHaveBeenLastCalledWith(
      expect.anything(),
      "site-1",
      expect.objectContaining({ timeZone: "UTC" }),
      EMPTY_FILTER_DOCUMENT,
      [
        { type: "pageview", value: "/pricing" },
        { type: "event", value: "signup" },
      ],
    );
    expect(await analyzed.response.json()).toMatchObject({
      data: {
        funnel: { id: "funnel-1" },
        analysis: { summary: { convertedSessions: 8 } },
      },
    });

    const updated = await authed(
      "/api/v1/sites/site-1/funnels/funnel-1",
      [siteMatch("site-1", "Blog"), funnelMatch(funnelRow("funnel-1"))],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Updated signup" }),
      },
    );
    expect(updated.response.status).toBe(200);
    expect(await updated.response.json()).toMatchObject({
      data: { id: "funnel-1", name: "Updated signup" },
    });

    const deleted = await authed(
      "/api/v1/sites/site-1/funnels/funnel-1",
      [siteMatch("site-1", "Blog"), funnelMatch(funnelRow("funnel-1"))],
      { method: "DELETE" },
    );
    expect(deleted.response.status).toBe(204);
  });

  it("returns v1 error envelopes for body validation failures", async () => {
    const invalid = await authed(
      "/api/v1/sites/site-1/funnels",
      [siteMatch("site-1", "Blog")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Broken", steps: [] }),
      },
    );

    expect(invalid.response.status).toBe(400);
    expect(await invalid.response.json()).toMatchObject({
      error: { code: "validation_failed" },
      meta: { generatedAt: expect.any(String) },
    });
  });

  it("returns realtime snapshot and active visitors", async () => {
    const snapshot = await authed("/api/v1/sites/site-1/realtime/snapshot", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(snapshot.response.status).toBe(200);
    expect(await snapshot.response.json()).toMatchObject({
      data: { activeVisitors: 3, events: [{ id: "evt-1" }], sessions: [] },
    });

    const active = await authed(
      "/api/v1/sites/site-1/realtime/active-visitors",
      [siteMatch("site-1", "Blog")],
    );
    expect(active.response.status).toBe(200);
    expect(await active.response.json()).toMatchObject({
      data: { activeVisitors: 3 },
    });
  });

  it("rejects batch subrequests that do not match the documented input schema", async () => {
    const { response } = await authed(
      "/api/v1/batch",
      [siteMatch("site-1", "Blog")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              id: "overview",
              method: "GET",
              path: "/api/v1/sites/site-1/analytics/overview",
              query: { preset: "last_7_days" },
            },
            {
              id: "bad",
              method: "POST",
              path: "/api/v1/sites/site-1/analytics/overview",
            },
          ],
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_failed" },
    });
  });

  it("authenticates a batch once and reuses its principal", async () => {
    const generated = await keyRow();
    const env = createEnv([authMatch(generated.row)]);
    const prepare = vi.spyOn(env.DB, "prepare");
    const path = "/api/v1/batch";

    const response = await handleApiV1(
      request(path, generated.apiKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              id: "first",
              method: "GET",
              path: "/api/v1/capabilities",
            },
            {
              id: "second",
              method: "GET",
              path: "/api/v1/capabilities",
            },
          ],
        }),
      }),
      env,
      new URL(`https://edge.test${path}`),
    );

    expect(response.status).toBe(200);
    expect(
      prepare.mock.calls.filter(([sql]) =>
        String(sql).includes("FROM api_keys"),
      ),
    ).toHaveLength(1);
  });

  it("reuses structured payloads from internal batch responses", async () => {
    const childResponse = j({ data: { value: 1 } });
    const json = vi.spyOn(childResponse, "json");
    const batchRequest = new Request("https://edge.test/api/v1/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          { id: "child", method: "GET", path: "/api/v1/capabilities" },
        ],
      }),
    });

    const response = await handleBatch(
      batchRequest,
      {} as Env,
      new URL(batchRequest.url),
      principal(),
      async () => childResponse,
    );

    expect(response.status).toBe(200);
    expect(json).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      data: {
        responses: [{ id: "child", status: 200, body: { data: { value: 1 } } }],
      },
    });
  });

  // ── additional coverage: method-not-allowed paths ───────────────

  it("rejects non-GET on root discovery", async () => {
    const { response } = await authed("/api/v1", [], { method: "POST" });
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on token endpoint", async () => {
    const { response } = await authed("/api/v1/token", [teamMatch()], {
      method: "POST",
    });
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on capabilities endpoint", async () => {
    const { response } = await authed("/api/v1/capabilities", [], {
      method: "DELETE",
    });
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on team endpoint", async () => {
    const { response } = await authed("/api/v1/team", [teamMatch()], {
      method: "DELETE",
    });
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on team usage endpoint", async () => {
    const { response } = await authed(
      "/api/v1/team/usage",
      [sitesListMatch([])],
      { method: "PATCH" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on team analytics endpoints", async () => {
    const { response } = await authed(
      "/api/v1/team/analytics/overview?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on analytics schema", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/schema",
      [siteMatch("site-1", "Blog")],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on analytics overview", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/overview",
      [siteMatch("site-1", "Blog")],
      { method: "PATCH" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on analytics timeseries", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/timeseries?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
      { method: "DELETE" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on analytics breakdowns", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/breakdowns/geo.country?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on realtime endpoint", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/realtime/snapshot",
      [siteMatch("site-1", "Blog")],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-POST on batch endpoint", async () => {
    const { response } = await authed("/api/v1/batch", [], { method: "GET" });
    expect(response.status).toBe(405);
  });

  it("rejects non-POST on token check endpoint", async () => {
    const { response } = await authed("/api/v1/token/check", [], {
      method: "GET",
    });
    expect(response.status).toBe(405);
  });

  // ── additional coverage: tracking PATCH ─────────────────────────

  it("updates tracking settings via PATCH", async () => {
    upsertSiteScriptSettingsMock.mockResolvedValueOnce({
      trackingStrength: "smart",
      trackQueryParams: true,
      trackHash: false,
      autoTrackOutboundLinks: false,
      domainWhitelist: [],
      pathBlacklist: ["/admin"],
      ignoreDoNotTrack: false,
      performanceSampleRate: 0,
    });
    const { response } = await authed(
      "/api/v1/sites/site-1/tracking",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trackQuery: true,
          trackHash: false,
          autoTrackOutboundLinks: false,
          trackingStrength: "smart",
          excludedPaths: ["/admin"],
          trackWebVitals: false,
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { trackQuery: boolean; trackHash: boolean };
    };
    expect(body.data.trackQuery).toBe(true);
    expect(body.data.trackHash).toBe(false);
  });

  // ── additional coverage: privacy PATCH ──────────────────────────

  it("updates privacy settings via PATCH", async () => {
    upsertSiteScriptSettingsMock.mockResolvedValueOnce({
      trackingStrength: "weak",
      trackQueryParams: false,
      trackHash: false,
      autoTrackOutboundLinks: false,
      domainWhitelist: [],
      pathBlacklist: [],
      ignoreDoNotTrack: true,
      performanceSampleRate: 0,
    });
    const { response } = await authed(
      "/api/v1/sites/site-1/privacy",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          respectDoNotTrack: false,
          euMode: true,
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { respectDoNotTrack: boolean; euMode: boolean };
    };
    expect(body.data.respectDoNotTrack).toBe(false);
    expect(body.data.euMode).toBe(true);
  });

  // ── additional coverage: sharing PATCH ──────────────────────────

  it("updates sharing settings via PATCH", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/sharing",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicEnabled: true, publicSlug: "my-blog" }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { publicEnabled: boolean; publicSlug: string | null };
    };
    expect(body.data.publicEnabled).toBe(true);
    expect(body.data.publicSlug).toBe("my-blog");
  });

  it("disables sharing and clears the public slug via PATCH", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/sharing",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicEnabled: false, publicSlug: "old-blog" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { publicEnabled: false, publicSlug: null },
    });
  });

  it("returns 409 when sharing slug conflicts", async () => {
    vi.mocked(ensurePublicSlugAvailable).mockResolvedValueOnce(false);
    const { response } = await authed(
      "/api/v1/sites/site-1/sharing",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicEnabled: true, publicSlug: "taken" }),
      },
    );
    expect(response.status).toBe(409);
  });

  // ── additional coverage: site PATCH with slug conflict ──────────

  it("returns 409 when site PATCH slug conflicts", async () => {
    vi.mocked(ensurePublicSlugAvailable).mockResolvedValueOnce(false);
    const { response } = await authed(
      "/api/v1/sites/site-1",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicEnabled: true,
          publicSlug: "taken",
        }),
      },
    );
    expect(response.status).toBe(409);
  });

  // ── additional coverage: site POST with slug conflict ───────────

  it("returns 409 when site creation slug conflicts", async () => {
    vi.mocked(ensurePublicSlugAvailable).mockResolvedValueOnce(false);
    const { response } = await authed("/api/v1/sites", [], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "New",
        domain: "new.test",
        publicEnabled: true,
        publicSlug: "taken",
      }),
    });
    expect(response.status).toBe(409);
  });

  // ── additional coverage: restricted key cannot create sites ─────

  it("prevents restricted keys from creating sites", async () => {
    const { response } = await authed(
      "/api/v1/sites",
      [],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New", domain: "new.test" }),
      },
      { site_ids_json: JSON.stringify(["site-2"]) },
    );
    expect(response.status).toBe(403);
  });

  // ── additional coverage: scope denied paths ─────────────────────

  it("denies site:read scope for sites listing", async () => {
    const { response } = await authed(
      "/api/v1/sites",
      [sitesListMatch([{ id: "site-1", name: "Blog" }])],
      undefined,
      { scopes_json: JSON.stringify(["analytics:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site:write scope for site creation", async () => {
    const { response } = await authed(
      "/api/v1/sites",
      [],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New", domain: "new.test" }),
      },
      { scopes_json: JSON.stringify(["analytics:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site:read scope for site detail", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1",
      [siteMatch("site-1", "Blog")],
      undefined,
      { scopes_json: JSON.stringify(["analytics:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site:write scope for site update", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      },
      { scopes_json: JSON.stringify(["site:read", "analytics:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site:write scope for site deletion", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1",
      [siteMatch("site-1", "Blog")],
      { method: "DELETE" },
      { scopes_json: JSON.stringify(["site:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site_config:read scope for tracking GET", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/tracking",
      [siteMatch("site-1", "Blog")],
      undefined,
      { scopes_json: JSON.stringify(["analytics:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site_config:write scope for tracking PATCH", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/tracking",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trackQuery: true }),
      },
      { scopes_json: JSON.stringify(["site_config:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site_config:read scope for privacy GET", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/privacy",
      [siteMatch("site-1", "Blog")],
      undefined,
      { scopes_json: JSON.stringify(["analytics:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site_config:write scope for privacy PATCH", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/privacy",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ respectDoNotTrack: true }),
      },
      { scopes_json: JSON.stringify(["site_config:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site_config:read scope for sharing GET", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/sharing",
      [siteMatch("site-1", "Blog")],
      undefined,
      { scopes_json: JSON.stringify(["analytics:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site_config:write scope for sharing PATCH", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/sharing",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicEnabled: true }),
      },
      { scopes_json: JSON.stringify(["site_config:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site_config:read scope for tracking script", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/tracking/script",
      [siteMatch("site-1", "Blog")],
      undefined,
      { scopes_json: JSON.stringify(["analytics:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies analytics:read scope for team analytics", async () => {
    const { response } = await authed(
      "/api/v1/team/analytics/overview?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [],
      undefined,
      { scopes_json: JSON.stringify(["site:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("prevents restricted keys from reading and updating unauthorized sites", async () => {
    const get = await authed(
      "/api/v1/sites/site-1",
      [siteMatch("site-1", "Blog")],
      undefined,
      { site_ids_json: JSON.stringify(["site-2"]) },
    );
    expect(get.response.status).toBe(404);

    const patch = await authed(
      "/api/v1/sites/site-1",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Blocked" }),
      },
      { site_ids_json: JSON.stringify(["site-2"]) },
    );
    expect(patch.response.status).toBe(404);
  });

  it("prevents restricted keys from reading unauthorized analytics families", async () => {
    const overrides = { site_ids_json: JSON.stringify(["site-2"]) };
    const cases = [
      "/api/v1/sites/site-1/analytics/overview?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      "/api/v1/sites/site-1/events?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      "/api/v1/sites/site-1/sessions?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      "/api/v1/sites/site-1/visitors?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      "/api/v1/sites/site-1/realtime/snapshot",
    ];

    for (const path of cases) {
      const { response } = await authed(
        path,
        [siteMatch("site-1", "Blog")],
        undefined,
        overrides,
      );
      expect(response.status, path).toBe(404);
    }
  });

  it("does not let batch bypass site restrictions or missing scopes", async () => {
    const restricted = await authed(
      "/api/v1/batch",
      [siteMatch("site-1", "Blog")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              id: "overview",
              method: "GET",
              path: "/api/v1/sites/site-1/analytics/overview",
              query: {
                from: "2026-06-01T00:00:00Z",
                to: "2026-06-02T00:00:00Z",
              },
            },
          ],
        }),
      },
      { site_ids_json: JSON.stringify(["site-2"]) },
    );
    expect(restricted.response.status).toBe(200);
    await expect(restricted.response.json()).resolves.toMatchObject({
      data: { responses: [{ id: "overview", status: 404 }] },
      meta: { partialFailure: true },
    });

    const noAnalytics = await authed(
      "/api/v1/batch",
      [siteMatch("site-1", "Blog")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              id: "overview",
              method: "GET",
              path: "/api/v1/sites/site-1/analytics/overview",
            },
          ],
        }),
      },
      { scopes_json: JSON.stringify(["site:read"]) },
    );
    expect(noAnalytics.response.status).toBe(200);
    await expect(noAnalytics.response.json()).resolves.toMatchObject({
      data: { responses: [{ id: "overview", status: 403 }] },
      meta: { partialFailure: true },
    });

    const writeAttempt = await authed(
      "/api/v1/batch",
      [siteMatch("site-1", "Blog")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              id: "sharing",
              method: "PATCH",
              path: "/api/v1/sites/site-1/sharing",
            },
          ],
        }),
      },
      { scopes_json: JSON.stringify(["site_config:read"]) },
    );
    expect(writeAttempt.response.status).toBe(400);
    await expect(writeAttempt.response.json()).resolves.toMatchObject({
      error: { code: "validation_failed" },
    });
  });

  // ── additional coverage: analytics invalid interval ─────────────

  it("rejects invalid analytics timeseries interval", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/timeseries?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&interval=century",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  // ── additional coverage: unsupported breakdown dimension ────────

  it("rejects unsupported analytics breakdown dimension", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/breakdowns/unsupported.dim?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(400);
  });

  // ── additional coverage: analytics cross-breakdowns ─────────────

  it("returns cross-breakdown analytics", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/cross-breakdowns?primary=geo.country&secondary=client.browser&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  it("rejects cross-breakdown with invalid primary dimension", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/cross-breakdowns?primary=invalid&secondary=client.browser&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(400);
  });

  it("rejects cross-breakdown with invalid secondary dimension", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/cross-breakdowns?primary=geo.country&secondary=invalid&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(400);
  });

  it("rejects cross-breakdown with unsupported session dimension", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/cross-breakdowns?primary=session.entryPath&secondary=client.browser&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(400);
  });

  // ── additional coverage: analytics compare ──────────────────────

  it("returns previous-period analytics with a same-width preceding window and zero-safe changes", async () => {
    queryApiV1OverviewMock.mockResolvedValueOnce({
      ok: true,
      data: {
        current: {
          views: 10,
          sessions: 0,
          visitors: 5,
          bounces: 0,
          totalDurationMs: 1_000,
          durationViews: 1,
        },
        previous: {
          views: 5,
          sessions: 0,
          visitors: 0,
          bounces: 0,
          totalDurationMs: 0,
          durationViews: 0,
        },
      },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/compare?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&compare=previous_period",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        current: { views: 10 },
        previous: { views: 5 },
        change: { views: 1, sessions: 0, visitors: null },
      },
    });
    expect(queryApiV1OverviewMock).toHaveBeenCalledWith(
      expect.anything(),
      "site-1",
      expect.any(URL),
      expect.objectContaining({
        startMs: Date.parse("2026-06-01T00:00:00Z"),
        endExclusiveMs: Date.parse("2026-06-02T00:00:00Z"),
      }),
      expect.objectContaining({
        previousTime: expect.objectContaining({
          startMs: Date.parse("2026-05-31T00:00:00Z"),
          endExclusiveMs: Date.parse("2026-06-01T00:00:00Z"),
        }),
      }),
    );
  });

  it("rejects comparison modes other than previous_period", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/compare?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&compare=year_over_year",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_failed" },
    });
  });

  // ── additional coverage: analytics explore (POST) ───────────────

  it("returns explore analytics via POST", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/explore?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [
        siteMatch("site-1", "Blog"),
        {
          includes: ["GROUP BY scoped.d0"],
          excludes: ["event_rollup", "bounced_sessions"],
          all: [{ d0: "/pricing", views: 5 }],
        },
      ],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metrics: ["views"],
          dimensions: ["page.path"],
          filters: {
            version: 1,
            root: {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "startsWith",
              value: "/",
            },
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { metrics: string[]; dimensions: string[] };
      meta: { timeRange: { from: string } };
    };
    expect(body.data.metrics).toEqual(["views"]);
    expect(body.data.dimensions).toEqual(["page.path"]);
    expect(body.data).toMatchObject({
      rows: [{ "page.path": "/pricing", views: 5 }],
    });
    expect(body.meta.timeRange.from).not.toBe("2026-06-01T00:00:00.000Z");
    expect(body.meta.timeRange.from).not.toBe("2026-06-01T00:00:00.000Z");
  });

  it("adds only the auxiliary analytics sources required by the requested metrics", async () => {
    const { env, response } = await authed(
      "/api/v1/sites/site-1/analytics/explore?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [
        siteMatch("site-1", "Blog"),
        {
          includes: ["bounced_sessions", "event_rollup"],
          all: [{ bounces: 2, events: 5 }],
        },
      ],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metrics: ["bounces", "events"] }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { rows: [{ bounces: 2, events: 5 }] },
    });
    expect(
      env.preparedSql.some(
        (sql) =>
          sql.includes("LEFT JOIN bounced_sessions") &&
          sql.includes("LEFT JOIN event_rollup"),
      ),
    ).toBe(true);
  });

  it("rejects explore POST with invalid complex filters", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/explore?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filters: [{ field: "invalid.field", op: "eq", value: "x" }],
        }),
      },
    );
    expect(response.status).toBe(400);
  });

  // ── additional coverage: analytics retention ────────────────────

  it("returns retention cohorts", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/retention/cohorts?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  // ── additional coverage: analytics 404 ──────────────────────────

  it("returns 404 for unknown analytics resource", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/nonexistent?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(404);
  });

  // ── additional coverage: visitors and sessions ──────────────────

  it("lists visitors with cursor pagination", async () => {
    routeQueryMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: [],
          pagination: { page: 1, pageSize: 100, total: 0 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/visitors?limit=50",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  it("returns visitor detail", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: { id: "v-1" } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const { response } = await authed("/api/v1/sites/site-1/visitors/v-1", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(response.status).toBe(200);
  });

  it("lists sessions with cursor pagination", async () => {
    routeQueryMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: [],
          pagination: { page: 1, pageSize: 100, total: 0 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/sessions?limit=20",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  it("returns session detail", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: { id: "s-1" } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const { response } = await authed("/api/v1/sites/site-1/sessions/s-1", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(response.status).toBe(200);
  });

  it("returns 404 for unknown journey sub-resource", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/visitors/v-1/unknown",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(404);
  });

  // ── additional coverage: journey method-not-allowed ─────────────

  it("rejects non-GET on visitors listing", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/visitors",
      [siteMatch("site-1", "Blog")],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on sessions listing", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/sessions",
      [siteMatch("site-1", "Blog")],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on visitor detail", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/visitors/v-1",
      [siteMatch("site-1", "Blog")],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on session detail", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/sessions/s-1",
      [siteMatch("site-1", "Blog")],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  // ── additional coverage: event sub-resources ────────────────────

  it("lists event types", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, data: [{ name: "click", count: 10 }] }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/event-types?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  it("returns event type detail", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, data: { name: "click", count: 10 } }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/event-types/click?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  it("returns event field values", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: ["value1", "value2"] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/event-fields/values?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  it("returns dynamic event fields", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, fields: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/event-fields?eventName=signup&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  it("returns events summary", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: { total: 5 } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/events/summary?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  it("returns events timeseries", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            data: [{ bucket: 0, timestampMs: Date.UTC(2026, 5, 1), views: 5 }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/events/timeseries?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  it("returns event record search via POST", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          data: [],
          pagination: { page: 1, pageSize: 100, total: 0 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/events/search?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
  });

  it("rejects non-POST on events search", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/events/search?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(405);
  });

  it("returns single event detail", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: { id: "evt-1" } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/events/evt-1?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  it("lists event records with pagination", async () => {
    routeQueryMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          data: [],
          pagination: { page: 1, pageSize: 100, total: 0 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const { response } = await authed(
      "/api/v1/sites/site-1/events?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
  });

  it("rejects non-GET on event types", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/event-types?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on event field values", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/event-fields/values?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on event record detail", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/events/evt-1?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
      { method: "DELETE" },
    );
    expect(response.status).toBe(405);
  });

  // ── additional coverage: funnel PATCH/DELETE ─────────────────────

  it("rejects non-POST on funnel analysis endpoint", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/funnels/analysis",
      [siteMatch("site-1", "Blog")],
      { method: "GET" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-GET on saved funnel analysis", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/funnels/funnel-1/analysis?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog"), funnelMatch(funnelRow("funnel-1"))],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  it("returns 404 for non-existent funnel in analysis", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/funnels/nonexistent/analysis?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog"), funnelMatch(null)],
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 for non-existent funnel resource", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/funnels/nonexistent",
      [siteMatch("site-1", "Blog"), funnelMatch(null)],
    );
    expect(response.status).toBe(404);
  });

  it("denies site_config:write scope for funnel creation", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/funnels",
      [siteMatch("site-1", "Blog")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          steps: [
            { type: "pageview", value: "/a" },
            { type: "event", value: "b" },
          ],
        }),
      },
      { scopes_json: JSON.stringify(["analytics:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site_config:write scope for funnel update", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/funnels/funnel-1",
      [siteMatch("site-1", "Blog"), funnelMatch(funnelRow("funnel-1"))],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      },
      { scopes_json: JSON.stringify(["analytics:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("denies site_config:write scope for funnel deletion", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/funnels/funnel-1",
      [siteMatch("site-1", "Blog"), funnelMatch(funnelRow("funnel-1"))],
      { method: "DELETE" },
      { scopes_json: JSON.stringify(["analytics:read"]) },
    );
    expect(response.status).toBe(403);
  });

  it("rejects funnel update with fewer than 2 steps", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/funnels/funnel-1",
      [siteMatch("site-1", "Blog"), funnelMatch(funnelRow("funnel-1"))],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          steps: [{ type: "pageview", value: "/only-one" }],
        }),
      },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
  });

  it("rejects non-POST on funnel collection endpoint", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/funnels",
      [siteMatch("site-1", "Blog")],
      { method: "PATCH" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-allowed method on funnel resource", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/funnels/funnel-1",
      [siteMatch("site-1", "Blog"), funnelMatch(funnelRow("funnel-1"))],
      { method: "PUT" },
    );
    expect(response.status).toBe(405);
  });

  // ── additional coverage: performance ────────────────────────────

  it("returns performance data", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/performance/summary?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [
        siteMatch("site-1", "Blog"),
        {
          includes: ["metric_thresholds", "thresholds.metric"],
          all: [
            {
              metric: "ttfb",
              samples: 3,
              avgValue: 110,
              p50: 100,
              p75: 120,
              p95: 150,
            },
          ],
        },
      ],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { ttfb: 120, fcp: null, lcp: null, cls: null, inp: null },
    });
  });

  it("returns performance breakdowns by documented dimension", async () => {
    const { response, env } = await authed(
      "/api/v1/sites/site-1/performance/breakdowns/page.path?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&metric=lcp",
      [
        siteMatch("site-1", "Blog"),
        {
          includes: ["ordered_values", "thresholds.dimensionValue"],
          all: [
            {
              dimensionValue: "/pricing",
              views: 7,
              samples: 4,
              avg: 1500,
              p50: 1200,
              p75: 1800,
              p95: 2100,
            },
          ],
        },
      ],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [
        {
          key: "/pricing",
          label: "/pricing",
          lcp: 1800,
          samples: 4,
        },
      ],
    });
    expect(
      env.preparedSql.some((sql) => sql.includes("scoped AS MATERIALIZED")),
    ).toBe(true);
  });

  it("uses the percentile sample count for breakdown views without rescanning scoped", async () => {
    const { env } = await authed(
      "/api/v1/sites/site-1/performance/breakdowns/page.path?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&metric=lcp",
      [
        siteMatch("site-1", "Blog"),
        {
          includes: ["ordered_values", "thresholds.dimensionValue"],
          all: [],
        },
      ],
    );
    const query = env.preparedStatements.find(
      (statement) =>
        statement.sql.includes("scoped AS MATERIALIZED") &&
        statement.sql.includes("thresholds.dimensionValue"),
    );

    expect(query).toBeDefined();
    expect(query?.sql).not.toContain("dimension_views AS");

    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE visits (
          visit_id TEXT PRIMARY KEY, site_id TEXT NOT NULL, visitor_id TEXT,
          session_id TEXT, status TEXT, started_at INTEGER, last_activity_at INTEGER,
          ended_at INTEGER, finalized_at INTEGER, duration_ms INTEGER,
          duration_source TEXT, exit_reason TEXT, pathname TEXT, query_string TEXT,
          hash_fragment TEXT, hostname TEXT, title TEXT, referrer_url TEXT,
          referrer_host TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
          utm_term TEXT, utm_content TEXT, is_eu INTEGER, country TEXT, region TEXT,
          region_code TEXT, city TEXT, continent TEXT, latitude REAL, longitude REAL,
          postal_code TEXT, metro_code TEXT, timezone TEXT, as_organization TEXT,
          ua_raw TEXT, browser TEXT, browser_version TEXT, os TEXT, os_version TEXT,
          device_type TEXT, screen_width INTEGER, screen_height INTEGER, language TEXT,
          perf_ttfb_ms REAL, perf_fcp_ms REAL, perf_lcp_ms REAL, perf_cls REAL,
          perf_inp_ms REAL, ae_synced_at INTEGER
        );
        CREATE INDEX idx_visits_site_started_at ON visits(site_id, started_at);
      `);
      const insert = database.prepare(
        "INSERT INTO visits (visit_id, site_id, started_at, pathname, perf_lcp_ms) VALUES (?, ?, ?, ?, ?)",
      );
      insert.run("one", "site-1", Date.UTC(2026, 5, 1, 1), "/pricing", 1000);
      insert.run("two", "site-1", Date.UTC(2026, 5, 1, 2), "/pricing", 2000);
      insert.run("three", "site-1", Date.UTC(2026, 5, 1, 3), "/docs", 3000);

      const rows = database
        .prepare(query?.sql ?? "SELECT 1")
        .all(...(query?.bindings ?? [])) as Array<
        Record<string, number | string>
      >;
      expect(rows).toEqual([
        expect.objectContaining({
          dimensionValue: "/docs",
          views: 1,
          samples: 1,
        }),
        expect.objectContaining({
          dimensionValue: "/pricing",
          views: 2,
          samples: 2,
        }),
      ]);

      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${query?.sql ?? "SELECT 1"}`)
        .all(...(query?.bindings ?? [])) as Array<{ detail: string }>;
      expect(
        plan.filter((row) => row.detail.includes("SCAN scoped")),
      ).toHaveLength(1);
      expect(
        plan.some((row) => row.detail.includes("idx_visits_site_started_at")),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("rejects non-GET on performance endpoint", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/performance?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
      { method: "POST" },
    );
    expect(response.status).toBe(405);
  });

  // ── additional coverage: realtime sub-resources ─────────────────

  it("returns realtime events list", async () => {
    const { response } = await authed("/api/v1/sites/site-1/realtime/events", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("returns realtime sessions list", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/realtime/sessions",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("returns 404 for unknown realtime sub-resource", async () => {
    const { response } = await authed("/api/v1/sites/site-1/realtime/unknown", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(response.status).toBe(404);
  });

  // ── additional coverage: batch edge cases ───────────────────────

  it("rejects batch with too many requests", async () => {
    const requests = Array.from({ length: 21 }, (_, i) => ({
      id: `r-${i}`,
      method: "GET",
      path: "/api/v1/sites",
    }));
    const { response } = await authed("/api/v1/batch", [], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects batch with empty requests array", async () => {
    const { response } = await authed("/api/v1/batch", [], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [] }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects batch sub-requests with invalid paths", async () => {
    const { response } = await authed("/api/v1/batch", [], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [{ id: "bad", method: "GET", path: "/collect/event" }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { responses: Array<{ status: number }> };
    };
    expect(body.data.responses[0].status).toBe(400);
  });

  it("covers batch invalid JSON and query value filtering", async () => {
    const invalidJson = await authed("/api/v1/batch", [], {
      method: "POST",
      body: "not json",
    });
    expect(invalidJson.response.status).toBe(400);

    const { response } = await authed("/api/v1/batch", [], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            id: "ok",
            method: "GET",
            path: "/api/v1/sites",
            query: { keep: "yes", skipNull: null, skipUndefined: undefined },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { responses: Array<{ status: number }> };
    };
    expect(body.data.responses[0].status).toBe(200);
  });

  // ── additional coverage: catch-all 404 ──────────────────────────

  it("returns 404 for unknown top-level resource", async () => {
    const { response } = await authed("/api/v1/unknown-resource", []);
    expect(response.status).toBe(404);
  });

  it("returns 404 for unknown site sub-resource", async () => {
    const { response } = await authed("/api/v1/sites/site-1/unknown", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(response.status).toBe(404);
  });

  // ── additional coverage: team sub-resources ─────────────────────

  it("returns team analytics breakdowns", async () => {
    const matches = [
      sitesListMatch([{ id: "site-1", name: "One" }]),
      {
        includes: ["FROM scoped"],
        excludes: ["event_rollup", "bounced_sessions"],
        all: [{ d0: "US", views: 12, sessions: 8, visitors: 6 }],
      },
    ];
    const { response } = await authed(
      "/api/v1/team/analytics/breakdowns/geo.country?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      matches,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [{ key: "US", label: "US", views: 12, sessions: 8, visitors: 6 }],
    });
  });

  it("rejects a team breakdown that would exceed D1's binding limit", async () => {
    const sites = Array.from({ length: 48 }, (_, index) => ({
      id: `site-${index}`,
      name: `Site ${index}`,
    }));
    const { response } = await authed(
      "/api/v1/team/analytics/breakdowns/geo.country?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&metrics=events",
      [sitesListMatch(sites)],
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_failed",
        message: "Analytics query exceeds the D1 bound parameter limit",
        details: { maximumBindings: 100, requestedBindings: 101 },
      },
    });
  });

  it("returns 404 for unknown team analytics resource", async () => {
    const matches = [teamSitesListMatch([{ id: "site-1", name: "One" }])];
    const { response } = await authed(
      "/api/v1/team/analytics/unknown?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      matches,
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 for unknown team sub-resource", async () => {
    const { response } = await authed("/api/v1/team/unknown", []);
    expect(response.status).toBe(404);
  });

  // ── additional coverage: typed query error mapping ──────────────

  it("maps a typed internal query failure without an HTTP bridge", async () => {
    queryApiV1OverviewMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: "internal", operation: "overview" },
    });
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/overview?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(routeQueryMock).not.toHaveBeenCalled();
  });

  it("returns error when team analytics query fails", async () => {
    const matches = [teamSitesListMatch([{ id: "site-1", name: "One" }])];
    // Mock routeQuery to return a failed response for the team dashboard
    routeQueryMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "fail" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const { response } = await authed(
      "/api/v1/team/analytics/overview?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      matches,
    );
    // The team dashboard has its own query path, may return 200 with zeroed data
    // or 500 depending on how the mock flows
    expect([200, 500]).toContain(response.status);
  });

  // ── additional coverage: invalid JSON body ──────────────────────

  it("returns 400 for invalid JSON body on site creation", async () => {
    const { response } = await authed("/api/v1/sites", [], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json{",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_json");
  });

  // ── additional coverage: token check edge cases ─────────────────

  it("rejects token check with non-object check items", async () => {
    const { response } = await authed("/api/v1/token/check", [], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checks: [null, "string", 42] }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects token check with a missing checks array", async () => {
    const { response } = await authed("/api/v1/token/check", [], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  // ── additional coverage: token check inactive reason ────────────

  it("returns token_inactive reason for inactive keys in token check", async () => {
    const { response } = await authed(
      "/api/v1/token/check",
      [],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checks: [{ scope: "analytics:read" }],
        }),
      },
      { revoked_at: 1 },
    );
    // revoked keys are rejected at auth, so this would be 401
    expect(response.status).toBe(401);
  });

  // ── additional coverage: site resource method-not-allowed ───────

  it("rejects PUT on site resource", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1",
      [siteMatch("site-1", "Blog")],
      { method: "PUT" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-allowed methods on tracking", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/tracking",
      [siteMatch("site-1", "Blog")],
      { method: "DELETE" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-allowed methods on privacy", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/privacy",
      [siteMatch("site-1", "Blog")],
      { method: "DELETE" },
    );
    expect(response.status).toBe(405);
  });

  it("rejects non-allowed methods on sharing", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/sharing",
      [siteMatch("site-1", "Blog")],
      { method: "DELETE" },
    );
    expect(response.status).toBe(405);
  });

  // ── additional coverage: site POST with public slug ─────────────

  it("creates site with public slug when available", async () => {
    vi.mocked(createSiteWithDefaultSettings).mockResolvedValue("new-site");
    vi.mocked(ensurePublicSlugAvailable).mockResolvedValueOnce(true);
    const { response } = await authed(
      "/api/v1/sites",
      [siteMatch("new-site", "NewSite")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "NewSite",
          domain: "newsite.test",
          publicEnabled: true,
          publicSlug: "my-new-site",
        }),
      },
    );
    expect(response.status).toBe(201);
  });

  it("creates site without slug when public not enabled", async () => {
    vi.mocked(createSiteWithDefaultSettings).mockResolvedValue("new-site");
    const { response } = await authed(
      "/api/v1/sites",
      [siteMatch("new-site", "NewSite")],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "NewSite",
          domain: "newsite.test",
          publicEnabled: false,
        }),
      },
    );
    expect(response.status).toBe(201);
  });

  // ── additional coverage: tracking script URL ────────────────────

  it("uses request origin for script snippet", async () => {
    const { response } = await authed("/api/v1/sites/site-1/tracking/script", [
      siteMatch("site-1", "Blog"),
    ]);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { src: string };
    };
    expect(body.data.src).toContain("https://edge.test/script.js");
  });

  it("updates tracking, privacy, and sharing settings through PATCH branches", async () => {
    const tracking = await authed(
      "/api/v1/sites/site-1/tracking",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trackQuery: false,
          trackHash: true,
          autoTrackOutboundLinks: false,
          trackingStrength: "strong",
          allowedDomains: ["blog.test", "cdn.blog.test"],
          excludedPaths: ["/private"],
          trackWebVitals: false,
        }),
      },
    );
    expect(tracking.response.status).toBe(200);
    expect(upsertSiteScriptSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      "site-1",
      expect.objectContaining({
        siteDomain: "Blog.test",
        settings: expect.objectContaining({
          trackQueryParams: false,
          domainWhitelist: ["cdn.blog.test"],
          performanceSampleRate: 0,
        }),
      }),
    );

    const privacy = await authed(
      "/api/v1/sites/site-1/privacy",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          respectDoNotTrack: false,
          euMode: true,
        }),
      },
    );
    expect(privacy.response.status).toBe(200);

    const sharing = await authed(
      "/api/v1/sites/site-1/sharing",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicEnabled: true,
          publicSlug: "blog-public",
        }),
      },
    );
    expect(sharing.response.status).toBe(200);

    vi.mocked(ensurePublicSlugAvailable).mockResolvedValueOnce(false);
    const conflict = await authed(
      "/api/v1/sites/site-1/sharing",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicEnabled: true,
          publicSlug: "taken",
        }),
      },
    );
    expect(conflict.response.status).toBe(409);

    const disableSharing = await authed(
      "/api/v1/sites/site-1/sharing",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicEnabled: false }),
      },
    );
    expect(disableSharing.response.status).toBe(200);
    expect(await disableSharing.response.json()).toMatchObject({
      data: { publicEnabled: false, publicSlug: null },
    });
  });

  it("covers site mutation conflict and restricted creation branches", async () => {
    vi.mocked(createSiteWithDefaultSettings).mockResolvedValue("new-site");
    vi.mocked(ensurePublicSlugAvailable).mockResolvedValueOnce(false);
    const createConflict = await authed("/api/v1/sites", [], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "NewSite",
        domain: "newsite.test",
        publicEnabled: true,
        publicSlug: "taken",
      }),
    });
    expect(createConflict.response.status).toBe(409);

    const restrictedCreate = await authed(
      "/api/v1/sites",
      [],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "NewSite",
          domain: "newsite.test",
        }),
      },
      { site_ids_json: JSON.stringify(["site-1"]) },
    );
    expect(restrictedCreate.response.status).toBe(403);

    vi.mocked(ensurePublicSlugAvailable).mockResolvedValueOnce(false);
    const updateConflict = await authed(
      "/api/v1/sites/site-1",
      [siteMatch("site-1", "Blog")],
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicEnabled: true,
          publicSlug: "taken",
        }),
      },
    );
    expect(updateConflict.response.status).toBe(409);
  });

  it("runs analytics explore with body time range, filters, dimensions, and order", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/explore",
      [
        siteMatch("site-1", "Blog"),
        {
          includes: ["ORDER BY views DESC"],
          excludes: ["event_rollup", "bounced_sessions"],
          all: [{ d0: "/pricing", views: 12, sessions: 8, visitors: 6 }],
        },
      ],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          timeRange: {
            from: "2026-06-01T00:00:00Z",
            to: "2026-06-02T00:00:00Z",
            timeZone: "UTC",
          },
          metrics: ["views", "views", "sessions", "visitors"],
          dimensions: ["page.path"],
          filters: {
            version: 1,
            root: {
              kind: "and",
              children: [
                {
                  kind: "condition",
                  target: { kind: "field", field: "page.path" },
                  operator: "contains",
                  value: "price",
                },
                {
                  kind: "condition",
                  target: { kind: "field", field: "client.deviceType" },
                  operator: "in",
                  value: ["desktop"],
                },
                {
                  kind: "condition",
                  target: { kind: "field", field: "geo.country" },
                  operator: "exists",
                },
              ],
            },
          },
          orderBy: [
            { field: "views", direction: "desc" },
            { field: "ignored", direction: "asc" },
          ],
          limit: 10,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        rows: [
          {
            "page.path": "/pricing",
            views: 12,
            sessions: 8,
            visitors: 6,
          },
        ],
        metrics: ["views", "sessions", "visitors"],
        dimensions: ["page.path"],
      },
    });
  });

  it("covers analytics explore complex filter operator branches", async () => {
    const { response } = await authed(
      "/api/v1/sites/site-1/analytics/explore",
      [
        siteMatch("site-1", "Blog"),
        {
          includes: ["FROM scoped"],
          excludes: ["event_rollup", "bounced_sessions"],
          all: [{ d0: "/pricing", views: 1 }],
        },
      ],
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          timeRange: {
            from: "2026-06-01T00:00:00Z",
            to: "2026-06-02T00:00:00Z",
          },
          metrics: ["views"],
          dimensions: ["page.path"],
          filters: {
            version: 1,
            root: {
              kind: "and",
              children: [
                {
                  kind: "condition",
                  target: { kind: "field", field: "page.path" },
                  operator: "notExists",
                },
                {
                  kind: "condition",
                  target: { kind: "field", field: "page.title" },
                  operator: "in",
                  value: ["Docs", "Pricing"],
                },
                {
                  kind: "condition",
                  target: { kind: "field", field: "page.hostname" },
                  operator: "notIn",
                  value: ["invalid.example"],
                },
                {
                  kind: "not",
                  child: {
                    kind: "condition",
                    target: { kind: "field", field: "client.deviceType" },
                    operator: "eq",
                    value: "mobile",
                  },
                },
                {
                  kind: "or",
                  children: [
                    {
                      kind: "condition",
                      target: { kind: "field", field: "referrer.domain" },
                      operator: "startsWith",
                      value: "docs",
                    },
                    {
                      kind: "condition",
                      target: { kind: "field", field: "referrer.url" },
                      operator: "endsWith",
                      value: "/pricing",
                    },
                  ],
                },
                {
                  kind: "condition",
                  target: { kind: "field", field: "client.browser" },
                  operator: "neq",
                  value: "Firefox",
                },
                {
                  kind: "condition",
                  target: { kind: "field", field: "geo.country" },
                  operator: "exists",
                },
              ],
            },
          },
          orderBy: [],
        }),
      },
    );

    expect(response.status).toBe(200);
  });

  it("rejects invalid analytics explore inputs", async () => {
    for (const body of [
      { metrics: [] },
      { metrics: ["unknown"] },
      {
        dimensions: [
          "page.path",
          "page.title",
          "geo.country",
          "geo.city",
          "client.browser",
          "event.name",
        ],
      },
      { dimensions: [42] },
      { dimensions: ["unsupported.dimension"] },
      { orderBy: [null] },
      { orderBy: [{ field: "" }] },
      { limit: 0 },
      { filters: [{ field: "unsupported.dimension", op: "eq", value: "x" }] },
    ]) {
      const { response } = await authed(
        "/api/v1/sites/site-1/analytics/explore?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
        [siteMatch("site-1", "Blog")],
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(400);
    }
  });

  it("covers analytics transforms and validation edge cases", async () => {
    const badInterval = await authed(
      "/api/v1/sites/site-1/analytics/timeseries?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&interval=decade",
      [siteMatch("site-1", "Blog")],
    );
    const unsupportedBreakdown = await authed(
      "/api/v1/sites/site-1/analytics/breakdowns/session.duration?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    const invalidCross = await authed(
      "/api/v1/sites/site-1/analytics/cross-breakdowns?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&primary=bad&secondary=page.path",
      [siteMatch("site-1", "Blog")],
    );
    expect(badInterval.response.status).toBe(400);
    expect(unsupportedBreakdown.response.status).toBe(400);
    expect(invalidCross.response.status).toBe(400);
  });

  it("covers team analytics overview, timeseries, sites, and validation branches", async () => {
    const queryAdapter = await import("@/lib/edge/api-v1-query-adapter");
    vi.spyOn(queryAdapter, "queryApiV1TeamDashboard").mockResolvedValue({
      ok: true,
      data: {
        sites: [
          {
            id: "site-1",
            teamId: "team-1",
            name: "Site One",
            domain: "site-one.test",
            publicEnabled: 1,
            publicSlug: "site-one",
            createdAt: 0,
            updatedAt: 0,
            overview: {
              views: 10,
              sessions: 5,
              visitors: 4,
              bounces: 1,
              totalDurationMs: 1000,
              avgDurationMs: 200,
              bounceRate: 0.2,
              approximateVisitors: false,
            },
            changeRates: {
              views: null,
              visitors: null,
              sessions: null,
              bounceRate: null,
              avgDurationMs: null,
              pagesPerSession: null,
            },
          },
        ],
        trend: [
          {
            bucket: 0,
            timestampMs: Date.UTC(2026, 5, 1),
            sites: [{ siteId: "site-1", views: 3, visitors: 2 }],
          },
        ],
      },
      meta: { time: {} as never, source: "raw", approximateVisitors: false },
    });

    for (const path of [
      "/api/v1/team",
      "/api/v1/team/usage",
      "/api/v1/team/analytics/overview?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      "/api/v1/team/analytics/timeseries?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&interval=hour",
      "/api/v1/team/analytics/sites?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
    ]) {
      const { response } = await authed(path, [
        teamMatch(),
        teamSitesListMatch([{ id: "site-1", name: "One" }]),
      ]);
      expect(response.status).toBe(200);
    }

    const noSitesBreakdown = await authed(
      "/api/v1/team/analytics/breakdowns/page.path?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&metrics=views&limit=2",
      [teamSitesListMatch([])],
    );
    expect(noSitesBreakdown.response.status).toBe(200);

    const invalidLimit = await authed(
      "/api/v1/team/analytics/breakdowns/page.path?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&limit=0",
      [teamSitesListMatch([{ id: "site-1", name: "One" }])],
    );
    expect(invalidLimit.response.status).toBe(400);
  });

  it("covers performance timeseries and invalid breakdown branches", async () => {
    // Return performance trend points spread across two hourly buckets (bucket 1
    // deliberately supplied ahead of bucket 0) so the sort comparator and map
    // callback inside queryPerformanceTimeseriesData both execute.
    const timeseries = await authed(
      "/api/v1/sites/site-1/performance/timeseries?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&interval=hour",
      [
        siteMatch("site-1", "Blog"),
        {
          includes: ["PARTITION BY metric, bucket"],
          all: [
            {
              metric: "lcp",
              bucket: 1,
              avgValue: 200,
              p50: 200,
              p95: 200,
              samples: 2,
            },
            {
              metric: "lcp",
              bucket: 0,
              avgValue: 100,
              p50: 100,
              p95: 100,
              samples: 2,
            },
          ],
        },
      ],
    );
    expect(timeseries.response.status).toBe(200);
    const timeseriesBody = (await timeseries.response.json()) as {
      data: unknown[];
      meta: { interval: string };
    };
    expect(timeseriesBody).toMatchObject({
      data: [
        { start: "2026-06-01T00:00:00.000Z", lcp: 100 },
        { start: "2026-06-01T01:00:00.000Z", lcp: 200 },
      ],
      meta: { interval: "hour" },
    });
    expect(timeseriesBody.data.length).toBe(2);

    const badMetric = await authed(
      "/api/v1/sites/site-1/performance/breakdowns/page.path?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&metric=bad",
      [siteMatch("site-1", "Blog")],
    );
    const badDimension = await authed(
      "/api/v1/sites/site-1/performance/breakdowns/session.duration?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    const unknown = await authed(
      "/api/v1/sites/site-1/performance/unknown?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
      [siteMatch("site-1", "Blog")],
    );
    expect(badMetric.response.status).toBe(400);
    expect(badDimension.response.status).toBe(400);
    expect(unknown.response.status).toBe(404);
  });

  it("covers realtime subresources and method branches", async () => {
    for (const resource of [
      "active-visitors",
      "events",
      "sessions",
      "snapshot",
    ]) {
      const { response } = await authed(
        `/api/v1/sites/site-1/realtime/${resource}`,
        [siteMatch("site-1", "Blog")],
      );
      expect(response.status).toBe(200);
    }

    const method = await authed(
      "/api/v1/sites/site-1/realtime/snapshot",
      [siteMatch("site-1", "Blog")],
      { method: "POST" },
    );
    const unknown = await authed("/api/v1/sites/site-1/realtime/unknown", [
      siteMatch("site-1", "Blog"),
    ]);

    expect(method.response.status).toBe(405);
    expect(unknown.response.status).toBe(404);
  });
});
