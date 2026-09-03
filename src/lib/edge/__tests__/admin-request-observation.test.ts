import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REQUEST_ANALYTICS_DATASET,
  SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY,
} from "@/lib/analytics-engine-config";
import { handleAnalyticsEngineConfigAdmin } from "@/lib/edge/admin-analytics-engine-config";
import { requireActor } from "@/lib/edge/admin-auth";
import { handleRequestObservationAdmin } from "@/lib/edge/admin-request-observation";
import {
  REQUEST_ANALYTICS_FLAGS,
  REQUEST_ANALYTICS_SCHEMA_VERSION,
} from "@/lib/edge/analytics-engine/request-schema";
import {
  encryptAnalyticsEngineSecret,
  encryptSecret,
} from "@/lib/edge/secret-encryption";
import type { Env } from "@/lib/edge/types";
import { SECRET_PURPOSES } from "@/lib/secrets";

vi.mock("@/lib/edge/admin-auth", () => ({
  requireActor: vi.fn(),
}));

interface MockStatement {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
}

const actor = {
  user: { id: "admin-1" },
  isAdmin: true,
};

function statement(options: { first?: unknown; all?: unknown[] } = {}) {
  const stmt: MockStatement = {
    bind: vi.fn((..._args: unknown[]) => stmt),
    first: vi.fn().mockResolvedValue(options.first ?? null),
    run: vi.fn().mockResolvedValue({ success: true }),
    all: vi.fn().mockResolvedValue({ results: options.all ?? [] }),
  };
  return stmt;
}

function createEnv(statements: MockStatement[], configured = true) {
  let index = 0;
  return {
    MAIN_SECRET: "main-secret",
    DB: {
      prepare: vi.fn(() => {
        const stmt = statements[index++];
        if (!stmt) throw new Error("Unexpected SQL statement");
        return stmt;
      }),
    } as unknown as D1Database,
    ...(configured
      ? {
          INSIGHTFLARE_E2E: "1",
          INSIGHTFLARE_E2E_CLOUDFLARE_API_URL: "https://cf.test",
        }
      : {}),
  } as Env;
}

function configRow(encrypted: string) {
  return {
    value_json: JSON.stringify({
      accountId: "442fe5198bff93bdf60d4223d9618033",
      apiTokenEncrypted: encrypted,
      apiTokenHint: "••••oken",
      configured: true,
      updatedAt: 1,
    }),
  };
}

function jsonEachRow(rows: Record<string, unknown>[]) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function analyticsResponse(rows: Record<string, unknown>[] = []) {
  return new Response(jsonEachRow(rows), {
    headers: { "content-type": "application/x-ndjson" },
    status: 200,
  });
}

const dispositionBlockedFlag = Number(
  (REQUEST_ANALYTICS_FLAGS as Record<string, unknown>).dispositionBlocked ??
    1 << 7,
);
const metricFlags = 127;

function blockedAnalyticsRow(overrides: Record<string, unknown> = {}) {
  return {
    asOrganization: "E2E Bot Network",
    asn: 64512,
    botScore: 7,
    category: "bot",
    city: "Shanghai",
    continent: "AS",
    country: "CN",
    edgeLatencyMs: 12,
    eventAt: 1_800_000_000_000,
    disposition: "blocked",
    flags: metricFlags | dispositionBlockedFlag,
    hostname: "app.example.test",
    httpProtocol: "HTTP/3",
    ip: "203.0.113.10",
    kind: "request",
    latitude: 31.23,
    longitude: 121.47,
    metadataJson: '{"eventId":"event-1"}',
    origin: "https://app.example.test",
    pathname: "/blocked",
    rayId: "ray-abnormal",
    receivedAt: 1_800_000_000_000,
    reasons: "ua_isbot,low_bot_score",
    region: "Shanghai",
    requestMethod: "GET",
    schemaVersion: REQUEST_ANALYTICS_SCHEMA_VERSION,
    siteId: "site-1",
    timestamp: "2026-09-02 00:00:00",
    traceId: "trace-blocked",
    userAgent: "E2E Bot",
    userAgentLength: 8,
    verifiedBotCategory: "Crawler",
    ...overrides,
  };
}

function normalAnalyticsRow(overrides: Record<string, unknown> = {}) {
  return {
    asOrganization: "E2E Normal Network",
    asn: 64513,
    city: "Shanghai",
    continent: "AS",
    country: "CN",
    edgeLatencyMs: 42,
    eventAt: 1_800_000_000_000,
    category: "normal",
    disposition: "included",
    flags: metricFlags,
    hostname: "app.example.test",
    httpProtocol: "HTTP/3",
    kind: "pageview",
    latitude: 31.23,
    longitude: 121.47,
    metadataJson: '{"visitId":"visit-1"}',
    origin: "https://app.example.test",
    pathname: "/home",
    rayId: "ray-normal",
    receivedAt: 1_800_000_000_000,
    region: "Shanghai",
    requestMethod: "POST",
    schemaVersion: REQUEST_ANALYTICS_SCHEMA_VERSION,
    siteId: "site-1",
    timestamp: "2026-09-02 00:00:00",
    userAgent: "Mozilla/5.0 (compatible; InsightFlare E2E)",
    traceId: "trace-normal",
    userAgentLength: 12,
    ...overrides,
  };
}

function request(path: string) {
  return new Request(`https://app.test${path}`);
}

function jsonRequest(path: string, body: unknown, method = "PATCH") {
  return new Request(`https://app.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("request observation admin reader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.mocked(requireActor).mockResolvedValue(actor as never);
  });

  it("stores the reader under the new key and never accepts dataset input", async () => {
    const select = statement();
    const upsert = statement();
    const env = createEnv([select, upsert], false);
    const response = await handleAnalyticsEngineConfigAdmin(
      jsonRequest("/api/private/admin/analytics-engine-config", {
        accountId: "442fe5198bff93bdf60d4223d9618033",
        dataset: "client-controlled",
        [["normal", "Dataset"].join("")]: "client-controlled",
        apiToken: "cf-token",
      }),
      env,
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.data.apiTokenConfigured).toBe(true);
    expect(body.data.requestDataset).toBe(REQUEST_ANALYTICS_DATASET);
    expect(JSON.parse(upsert.bind.mock.calls[0][1])).not.toHaveProperty(
      "dataset",
    );
    expect(upsert.bind.mock.calls[0][0]).toBe(
      SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY,
    );
  });

  it("returns the unconfigured response without querying Analytics Engine", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation"),
      createEnv([statement({ first: null })], false),
      new URL("https://app.test/api/private/admin/request-observation"),
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.events).toEqual([]);
    expect(body.overview.totalRequests).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads every request observation query from the fixed dataset and schema slots", async () => {
    const encrypted = await encryptAnalyticsEngineSecret(
      { MAIN_SECRET: "main-secret" },
      "cf-token",
    );
    const config = statement({ first: configRow(encrypted) });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("", { status: 200 }));

    const response = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation?from=0&to=3600000"),
      createEnv([config]),
      new URL(
        "https://app.test/api/private/admin/request-observation?from=0&to=3600000",
      ),
    );

    expect(response.status).toBe(200);
    const sql = fetchSpy.mock.calls
      .map(([, init]) => String((init as RequestInit).body || ""))
      .join("\n");
    const legacyNormalDataset = ["insightflare", "_normal_events"].join("");
    const legacyAbnormalDataset = ["insightflare", "_bot_events"].join("");
    expect(sql).toContain(`FROM ${REQUEST_ANALYTICS_DATASET}`);
    expect(sql).not.toContain(legacyNormalDataset);
    expect(sql).not.toContain(legacyAbnormalDataset);
    expect(sql).toContain("blob1 AS kind");
    expect(sql).toContain("blob20 AS metadataJson");
    expect(sql).toContain("double19 AS flags");
    expect(sql).toContain("double20 AS schemaVersion");
    expect(sql).toContain("ORDER BY timestamp DESC, receivedAt DESC");
    expect(sql).not.toContain("ORDER BY timestamp DESC, double1 DESC");
    expect(sql).toContain("blob2 = 'normal'");
    expect(sql).toContain("blob2 = 'suspected_bot'");
    expect(sql).toContain("blob2 = 'bot'");
    expect(sql).toContain("blob2 = 'custom_block'");
    expect(sql).toContain(
      `intDiv(double19, ${dispositionBlockedFlag}) % 2 != 0`,
    );
    expect(sql).toContain(
      `intDiv(double19, ${dispositionBlockedFlag}) % 2 = 0`,
    );
    expect(sql).toContain("sum(_sample_interval)");
    expect(sql).toContain("quantileExactWeighted(0.95)");
    expect(sql).not.toMatch(/count\s*\(\s*\*\s*\)/i);
    expect(sql).toContain("count(DISTINCT index1)");
    expect(sql).toContain("count(DISTINCT double4)");
    expect(sql).toContain("count(DISTINCT blob9)");
    expect(sql).toContain("intDiv(double19");
    expect(sql).not.toContain("toInt64");
    expect(sql).toContain("GROUP BY double5, double6, blob9");
  });

  it("reads tokens encrypted with the legacy bot analytics purpose", async () => {
    const encrypted = await encryptSecret(
      { MAIN_SECRET: "main-secret" },
      "cf-token",
      SECRET_PURPOSES.legacyBotAnalyticsSecretEncryption,
    );
    const config = statement({ first: configRow(encrypted) });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => analyticsResponse([]));

    const response = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation?from=0&to=3600000"),
      createEnv([config]),
      new URL(
        "https://app.test/api/private/admin/request-observation?from=0&to=3600000",
      ),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    expect(
      new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer cf-token");
  });

  it("returns detail identity and metadata from the new blob slots", async () => {
    const encrypted = await encryptAnalyticsEngineSecret(
      { MAIN_SECRET: "main-secret" },
      "cf-token",
    );
    const config = statement({ first: configRow(encrypted) });
    const sites = statement({
      all: [{ id: "site-1", name: "Site", domain: "site.test" }],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        jsonEachRow([
          {
            timestamp: "2026-09-02 00:00:00",
            sampleWeight: 1,
            siteId: "site-1",
            kind: "request",
            category: "suspected_bot",
            disposition: "blocked",
            reasons: "ua_isbot",
            rayId: "ray-new",
            traceId: "trace-new",
            requestMethod: "GET",
            httpProtocol: "HTTP/3",
            metadataJson: '{"eventId":"event-1"}',
            receivedAt: 1_800_000_000_000,
            eventAt: 1_800_000_000_000,
            edgeLatencyMs: 12,
            asn: 13335,
            latitude: 0,
            longitude: 0,
            botScore: 7,
            userAgentLength: 10,
            flags: 12 | dispositionBlockedFlag,
            schemaVersion: 2,
          },
        ]),
        { status: 200 },
      ),
    );

    const response = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?detail=1&traceId=trace-new",
      ),
      createEnv([config, sites]),
      new URL(
        "https://app.test/api/private/admin/request-observation?detail=1&traceId=trace-new",
      ),
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.detail).toMatchObject({
      rayId: "ray-new",
      traceId: "trace-new",
      category: "suspected_bot",
      disposition: "blocked",
      httpProtocol: "HTTP/3",
      metadataJson: '{"eventId":"event-1"}',
      latitude: 0,
      longitude: 0,
    });
    expect(config.bind).toHaveBeenCalledWith(
      SYSTEM_ANALYTICS_ENGINE_CONFIG_KEY,
    );
  });

  it("assembles weighted overview, trend, map, and dimensions from one dataset", async () => {
    const encrypted = await encryptAnalyticsEngineSecret(
      { MAIN_SECRET: "main-secret" },
      "cf-token",
    );
    const config = statement({ first: configRow(encrypted) });
    const sites = statement({
      all: [{ id: "site-1", name: "Site", domain: "site.test" }],
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const sql = String((init as RequestInit | undefined)?.body || "");
        if (sql.includes("blob1 AS kind")) {
          return analyticsResponse(
            sql.includes(
              `AND intDiv(double19, ${dispositionBlockedFlag}) % 2 = 0`,
            )
              ? [
                  normalAnalyticsRow(),
                  normalAnalyticsRow({
                    pathname: "/pricing",
                    traceId: "trace-normal-2",
                  }),
                  normalAnalyticsRow({
                    category: "suspected_bot",
                    pathname: "/suspected",
                    traceId: "trace-suspected-included",
                  }),
                  normalAnalyticsRow({
                    category: "bot",
                    pathname: "/allowed-bot",
                    traceId: "trace-bot-included",
                  }),
                ]
              : [
                  blockedAnalyticsRow(),
                  blockedAnalyticsRow({
                    category: "suspected_bot",
                    pathname: "/managed-bot",
                    traceId: "trace-suspected-blocked",
                  }),
                  blockedAnalyticsRow({
                    category: "custom_block",
                    pathname: "/custom-block",
                    traceId: "trace-custom-block",
                  }),
                ],
          );
        }
        if (sql.includes("timestampMs")) {
          return analyticsResponse([
            sql.includes("latencyWeightedSumMs")
              ? {
                  blockedCount: 0,
                  botCount: 0,
                  customBlockedCount: 0,
                  customEventCount: 1,
                  customEvents: 1,
                  includedCount: 3,
                  latencySampleWeight: 2,
                  latencyWeightedSumMs: 84,
                  normalCount: 2,
                  p50LatencyMs: "invalid",
                  p75LatencyMs: 42,
                  p95LatencyMs: 42,
                  p99LatencyMs: 42,
                  pageviewCount: 1,
                  pageviews: 1,
                  suspectedBotCount: 1,
                  timestampMs: 3_600_000,
                  totalCount: 3,
                  weightedRequestCount: 3,
                }
              : {
                  blockedCount: 4,
                  botCount: 2,
                  customBlockedCount: 1,
                  includedCount: 0,
                  normalCount: 0,
                  suspectedBotCount: 1,
                  timestampMs: 3_600_000,
                  totalCount: 4,
                  weightedRequestCount: 4,
                },
          ]);
        }
        if (sql.includes("pointCount")) {
          return analyticsResponse([
            {
              country: "CN",
              latitude: 31.23,
              longitude: 121.47,
              pointCount: 2,
            },
          ]);
        }
        if (sql.includes("blob3 AS reasons")) {
          return analyticsResponse([
            {
              maxSampleInterval: 2,
              reasons: "ua_isbot,low_bot_score",
              weight: 2,
            },
          ]);
        }
        if (sql.includes("double4 AS asn") && !sql.includes("AS label")) {
          return analyticsResponse([
            {
              asOrganization: "E2E Bot Network",
              asn: 64512,
              botCount: 2,
              count: 2,
              maxSampleInterval: 2,
            },
            {
              asOrganization: "E2E Other Network",
              asn: 64511,
              botCount: 0,
              count: 1,
              maxSampleInterval: 1,
            },
          ]);
        }
        if (sql.includes("sum(_sample_interval) AS total")) {
          return analyticsResponse([
            sql.includes(
              `AND intDiv(double19, ${dispositionBlockedFlag}) % 2 = 0`,
            )
              ? {
                  affectedSites: 1,
                  avgLatencyMs: 42,
                  blockedRequests: 0,
                  botRequests: 0,
                  customBlockedRequests: 0,
                  customEvents: 1,
                  includedRequests: 3,
                  latencySampleWeight: 2,
                  latencyWeightedSumMs: 84,
                  maxSampleInterval: 2,
                  normalRequests: 2,
                  p50LatencyMs: -1,
                  p75LatencyMs: 42,
                  p95LatencyMs: 42,
                  p99LatencyMs: 42,
                  pageviews: 1,
                  suspectedBotRequests: 1,
                  total: 3,
                  uniqueAsns: 1,
                  uniqueCountries: 1,
                }
              : {
                  affectedSites: 1,
                  blockedRequests: 4,
                  botRequests: 2,
                  customBlockedRequests: 1,
                  customEvents: 0,
                  includedRequests: 0,
                  maxSampleInterval: 2,
                  normalRequests: 0,
                  pageviews: 0,
                  suspectedBotRequests: 1,
                  total: 4,
                  uniqueAsns: 1,
                  uniqueCountries: 1,
                },
          ]);
        }
        if (sql.includes("AS label")) {
          return analyticsResponse([
            {
              country: "CN",
              botCount: 2,
              label: "E2E Bot Network",
              maxSampleInterval: 2,
              region: "Shanghai",
              count: 2,
            },
          ]);
        }
        return analyticsResponse();
      });

    const response = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?from=0&to=3600000&interval=hour",
      ),
      createEnv([config, sites]),
      new URL(
        "https://app.test/api/private/admin/request-observation?from=0&to=3600000&interval=hour",
      ),
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.overview).toMatchObject({
      totalRequests: 7,
      includedRequests: 3,
      blockedRequests: 4,
      normalRequests: 2,
      suspectedBotRequests: 2,
      botRequests: 2,
      customBlockedRequests: 1,
      botRequestRatio: 2 / 7,
      blockedRequestRatio: 4 / 7,
      normalRequestRatio: 2 / 7,
      avgLatencyMs: 42,
      pageviews: 1,
    });
    expect(body.sampling).toMatchObject({
      aggregatesWeighted: true,
      detailsAreSampled: true,
      distinctAreApproximate: true,
    });
    expect(body.blocked.events[0]).toMatchObject({
      category: "bot",
      disposition: "blocked",
      siteName: "Site",
      traceId: "trace-blocked",
    });
    expect(
      body.blocked.events.map(
        (event: Record<string, unknown>) => event.category,
      ),
    ).toEqual(["bot", "suspected_bot", "custom_block"]);
    expect(body.included.events[0]).toMatchObject({
      category: "normal",
      disposition: "included",
      edgeLatencyMs: 42,
      siteName: "Site",
    });
    expect(
      body.included.events.map(
        (event: Record<string, unknown>) => event.category,
      ),
    ).toEqual(["normal", "normal", "suspected_bot", "bot"]);
    expect(
      body.trend.find(
        (point: Record<string, unknown>) => Number(point.totalCount) > 0,
      ),
    ).toMatchObject({
      blockedCount: 4,
      botCount: 2,
      customBlockedCount: 1,
      includedCount: 3,
      normalCount: 2,
      suspectedBotCount: 2,
      totalCount: 7,
    });
    expect(body.mapPoints).toEqual([
      { country: "CN", latitude: 31.23, longitude: 121.47, pointCount: 2 },
    ]);
    expect(body.reasons[0]).toMatchObject({ count: 2, reason: "ua_isbot" });
    expect(body.asns[0]).toMatchObject({
      asOrganization: "E2E Bot Network",
      asn: 64512,
      count: 2,
    });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("supports paginated lists, site dimensions, and input validation", async () => {
    const encrypted = await encryptAnalyticsEngineSecret(
      { MAIN_SECRET: "main-secret" },
      "cf-token",
    );
    const config = statement({ first: configRow(encrypted) });
    const sites = statement({
      all: [{ id: "site-1", name: "Site", domain: "site.test" }],
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const sql = String((init as RequestInit | undefined)?.body || "");
      if (sql.includes("blob2 AS label")) {
        return analyticsResponse([
          { count: 2, label: "normal", maxSampleInterval: 1 },
          { count: 1, label: "suspected_bot", maxSampleInterval: 1 },
        ]);
      }
      if (sql.includes("index1 AS label")) {
        return analyticsResponse([
          { count: 3, label: "site-1", maxSampleInterval: 3 },
        ]);
      }
      if (sql.includes("blob1 AS kind")) {
        return sql.includes(
          `AND intDiv(double19, ${dispositionBlockedFlag}) % 2 != 0`,
        )
          ? analyticsResponse([blockedAnalyticsRow()])
          : analyticsResponse([
              normalAnalyticsRow({ pathname: "/first" }),
              normalAnalyticsRow({ pathname: "/second" }),
            ]);
      }
      return analyticsResponse([
        normalAnalyticsRow({ pathname: "/first" }),
        normalAnalyticsRow({ pathname: "/second" }),
      ]);
    });

    const pageResponse = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?page=included&limit=1&cursor=" +
          encodeURIComponent(
            JSON.stringify({ receivedAt: 1, timestamp: "2026-09-01 00:00:00" }),
          ),
      ),
      createEnv([config, sites]),
      new URL(
        "https://app.test/api/private/admin/request-observation?page=included&limit=1&cursor=" +
          encodeURIComponent(
            JSON.stringify({ receivedAt: 1, timestamp: "2026-09-01 00:00:00" }),
          ),
      ),
    );
    const pageBody = (await pageResponse.json()) as Record<string, any>;
    expect(pageResponse.status).toBe(200);
    expect(pageBody.page).toMatchObject({ hasMore: true, source: "included" });
    expect(pageBody.page.events[0]).toMatchObject({
      category: "normal",
      disposition: "included",
    });
    expect(pageBody.page.events[0]).toMatchObject({
      pathname: "/first",
      siteName: "Site",
      requestMethod: "POST",
      metadataJson: '{"visitId":"visit-1"}',
      userAgent: "Mozilla/5.0 (compatible; InsightFlare E2E)",
    });
    expect(pageBody.page.nextCursor).toMatchObject({
      receivedAt: 1_800_000_000_000,
    });

    const blockedPageResponse = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation?page=blocked"),
      createEnv([statement({ first: configRow(encrypted) }), sites]),
      new URL(
        "https://app.test/api/private/admin/request-observation?page=blocked",
      ),
    );
    const blockedPageBody = (await blockedPageResponse.json()) as Record<
      string,
      any
    >;
    expect(blockedPageResponse.status).toBe(200);
    expect(blockedPageBody.page).toMatchObject({ source: "blocked" });
    expect(blockedPageBody.page.events[0]).toMatchObject({
      category: "bot",
      disposition: "blocked",
    });

    const dimensionResponse = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?dimensionGroup=target&dimensionTab=site&dimensionSource=included",
      ),
      createEnv([statement({ first: configRow(encrypted) }), sites]),
      new URL(
        "https://app.test/api/private/admin/request-observation?dimensionGroup=target&dimensionTab=site&dimensionSource=included",
      ),
    );
    const dimensionBody = (await dimensionResponse.json()) as Record<
      string,
      any
    >;
    expect(dimensionResponse.status).toBe(200);
    expect(dimensionBody.dimension.rows[0]).toMatchObject({
      botCount: 0,
      iconLabel: "site.test",
      label: "Site",
    });

    const regionResponse = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?dimensionGroup=network&dimensionTab=region&dimensionSource=blocked",
      ),
      createEnv([statement({ first: configRow(encrypted) })]),
      new URL(
        "https://app.test/api/private/admin/request-observation?dimensionGroup=network&dimensionTab=region&dimensionSource=blocked",
      ),
    );
    const regionBody = (await regionResponse.json()) as Record<string, any>;
    expect(regionResponse.status).toBe(200);
    expect(regionBody.dimension.rows[0].region).toBe(
      regionBody.dimension.rows[0].label,
    );

    const includedDetection = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?dimensionGroup=detection&dimensionTab=category&dimensionSource=included",
      ),
      createEnv([statement({ first: configRow(encrypted) })]),
      new URL(
        "https://app.test/api/private/admin/request-observation?dimensionGroup=detection&dimensionTab=category&dimensionSource=included",
      ),
    );
    const includedDetectionBody = (await includedDetection.json()) as Record<
      string,
      any
    >;
    expect(includedDetection.status).toBe(200);
    expect(includedDetectionBody.dimension.rows).toHaveLength(2);

    const invalidDimension = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?dimensionGroup=target&dimensionTab=invalid&dimensionSource=included",
      ),
      createEnv([statement({ first: configRow(encrypted) })]),
      new URL(
        "https://app.test/api/private/admin/request-observation?dimensionGroup=target&dimensionTab=invalid&dimensionSource=included",
      ),
    );
    expect(invalidDimension.status).toBe(400);

    const invalidCursor = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?page=blocked&cursor=invalid",
      ),
      createEnv([statement({ first: configRow(encrypted) })]),
      new URL(
        "https://app.test/api/private/admin/request-observation?page=blocked&cursor=invalid",
      ),
    );
    expect(invalidCursor.status).toBe(400);
  });

  it("normalizes sparse observations and missing site metadata safely", async () => {
    const encrypted = await encryptAnalyticsEngineSecret(
      { MAIN_SECRET: "main-secret" },
      "cf-token",
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const sql = String((init as RequestInit | undefined)?.body || "");
        return analyticsResponse([
          sql.includes(`intDiv(double19, ${dispositionBlockedFlag}) % 2 = 0`)
            ? {
                siteId: "missing-site",
                category: "normal",
                disposition: "included",
                flags: metricFlags,
              }
            : {
                siteId: "missing-site",
                category: "custom_block",
                disposition: "blocked",
                flags: metricFlags | dispositionBlockedFlag,
              },
          {},
        ]);
      });

    const normalResponse = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation?page=included"),
      createEnv([
        statement({ first: configRow(encrypted) }),
        statement({ all: [{}] }),
      ]),
      new URL(
        "https://app.test/api/private/admin/request-observation?page=included",
      ),
    );
    const normalBody = (await normalResponse.json()) as Record<string, any>;
    expect(normalResponse.status).toBe(200);
    expect(normalBody.page.events[0]).toMatchObject({
      siteName: "missing-site",
      siteDomain: "",
      edgeLatencyMs: null,
      latitude: null,
      longitude: null,
    });
    expect(normalBody.page.events[1].siteName).toBe("Unknown site");

    const abnormalResponse = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation?page=blocked"),
      createEnv([
        statement({ first: configRow(encrypted) }),
        statement({ all: [{}] }),
      ]),
      new URL(
        "https://app.test/api/private/admin/request-observation?page=blocked",
      ),
    );
    const abnormalBody = (await abnormalResponse.json()) as Record<string, any>;
    expect(abnormalResponse.status).toBe(200);
    expect(abnormalBody.page.events[0]).toMatchObject({
      category: "custom_block",
      disposition: "blocked",
      siteName: "missing-site",
      siteDomain: "",
      botScore: null,
      latitude: null,
      longitude: null,
    });
    expect(abnormalBody.page.events[1].siteName).toBe("Unknown site");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps sparse aggregate rows and out-of-window trend rows safe", async () => {
    const encrypted = await encryptAnalyticsEngineSecret(
      { MAIN_SECRET: "main-secret" },
      "cf-token",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const sql = String((init as RequestInit | undefined)?.body || "");
      if (sql.includes("blob1 AS kind")) return analyticsResponse();
      if (sql.includes("timestampMs")) {
        return analyticsResponse([
          sql.includes("latencyWeightedSumMs")
            ? {
                timestampMs: 0,
                count: -1,
                p50LatencyMs: "invalid",
                p75LatencyMs: "invalid",
                p95LatencyMs: "invalid",
                p99LatencyMs: "invalid",
              }
            : { timestampMs: 0, count: -1 },
          { timestampMs: 999_999_999, count: 1 },
        ]);
      }
      if (sql.includes("pointCount")) return analyticsResponse([{}]);
      if (sql.includes("blob3 AS reasons")) return analyticsResponse([{}]);
      if (sql.includes("double4 AS asn") && !sql.includes("AS label")) {
        return analyticsResponse([
          { label: "0", count: 10 },
          { label: "64512", count: -1 },
          { label: "64513", count: 1 },
          { label: "64512", asOrganization: "Sparse ASN", count: 1 },
        ]);
      }
      if (sql.includes("sum(_sample_interval) AS total")) {
        return analyticsResponse([{}]);
      }
      if (sql.includes("AS label")) return analyticsResponse([{}]);
      return analyticsResponse();
    });

    const response = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?from=0&to=3600000&interval=hour",
      ),
      createEnv([statement({ first: configRow(encrypted) })]),
      new URL(
        "https://app.test/api/private/admin/request-observation?from=0&to=3600000&interval=hour",
      ),
    );
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.mapPoints).toEqual([]);
    expect(body.reasons).toEqual([]);
    expect(body.asns).toEqual([
      { asn: 64512, asOrganization: "Sparse ASN", botCount: 0, count: 1 },
      { asn: 64513, asOrganization: "", botCount: 0, count: 1 },
    ]);
    expect(body.overview).toMatchObject({
      blockedRequests: 0,
      includedRequests: 0,
      normalRequests: 0,
      avgLatencyMs: null,
      p50LatencyMs: null,
    });
  });

  it("surfaces failures from each aggregate query stage", async () => {
    const encrypted = await encryptAnalyticsEngineSecret(
      { MAIN_SECRET: "main-secret" },
      "cf-token",
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const failureMatchers: Array<[string, (sql: string) => boolean]> = [
      [
        "blocked trend",
        (sql) =>
          sql.includes("timestampMs") && !sql.includes("latencyWeightedSumMs"),
      ],
      [
        "included trend",
        (sql) =>
          sql.includes("timestampMs") && sql.includes("latencyWeightedSumMs"),
      ],
      [
        "blocked map",
        (sql) =>
          sql.includes("pointCount") &&
          sql.includes(`intDiv(double19, ${dispositionBlockedFlag}) % 2 != 0`),
      ],
      [
        "included map",
        (sql) =>
          sql.includes("pointCount") &&
          sql.includes(`intDiv(double19, ${dispositionBlockedFlag}) % 2 = 0`),
      ],
      [
        "blocked summary",
        (sql) =>
          sql.includes("sum(_sample_interval) AS total") &&
          sql.includes(`intDiv(double19, ${dispositionBlockedFlag}) % 2 != 0`),
      ],
      [
        "included summary",
        (sql) =>
          sql.includes("sum(_sample_interval) AS total") &&
          sql.includes(`intDiv(double19, ${dispositionBlockedFlag}) % 2 = 0`),
      ],
      ["reason summary", (sql) => sql.includes("blob3 AS reasons")],
      [
        "asn summary",
        (sql) =>
          sql.includes("double4 AS asn") &&
          sql.includes("sumIf(_sample_interval, blob2 = 'bot') AS botCount"),
      ],
      ["network dimensions", (sql) => sql.includes("AS label")],
    ];

    for (const [stage, matches] of failureMatchers) {
      let failed = false;
      fetchSpy.mockReset().mockImplementation(async (_input, init) => {
        const sql = String((init as RequestInit | undefined)?.body || "");
        if (!failed && matches(sql)) {
          failed = true;
          return new Response("stage unavailable", { status: 503 });
        }
        return analyticsResponse();
      });

      const response = await handleRequestObservationAdmin(
        request("/api/private/admin/request-observation?from=0&to=3600000"),
        createEnv([statement({ first: configRow(encrypted) })]),
        new URL(
          "https://app.test/api/private/admin/request-observation?from=0&to=3600000",
        ),
      );

      expect(failed, stage).toBe(true);
      expect(response.status, stage).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "request_observation_query_failed" },
      });
    }
  });

  it("handles empty details, site fallbacks, and the production endpoint", async () => {
    const encrypted = await encryptAnalyticsEngineSecret(
      { MAIN_SECRET: "main-secret" },
      "cf-token",
    );
    const configured = () => statement({ first: configRow(encrypted) });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(analyticsResponse());

    const emptyDetail = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?detail=1&traceId=trace-missing",
      ),
      createEnv([configured()]),
      new URL(
        "https://app.test/api/private/admin/request-observation?detail=1&traceId=trace-missing",
      ),
    );
    expect(emptyDetail.status).toBe(200);
    expect(await emptyDetail.json()).toMatchObject({ detail: null });

    fetchSpy.mockImplementation(async () => new Response("", { status: 503 }));
    const detailFailure = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?detail=1&traceId=trace-failed",
      ),
      createEnv([configured()]),
      new URL(
        "https://app.test/api/private/admin/request-observation?detail=1&traceId=trace-failed",
      ),
    );
    expect(detailFailure.status).toBe(400);

    const pageFailure = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation?page=included"),
      createEnv([configured()]),
      new URL(
        "https://app.test/api/private/admin/request-observation?page=included",
      ),
    );
    expect(pageFailure.status).toBe(400);

    const dimensionFailure = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?dimensionGroup=target&dimensionTab=site&dimensionSource=included",
      ),
      createEnv([configured()]),
      new URL(
        "https://app.test/api/private/admin/request-observation?dimensionGroup=target&dimensionTab=site&dimensionSource=included",
      ),
    );
    expect(dimensionFailure.status).toBe(400);

    fetchSpy.mockImplementation(async (_input, init) => {
      const sql = String((init as RequestInit | undefined)?.body || "");
      return sql.includes("index1 AS label")
        ? analyticsResponse([{ label: "unknown-site" }])
        : analyticsResponse();
    });
    const siteFallback = await handleRequestObservationAdmin(
      request(
        "/api/private/admin/request-observation?dimensionGroup=target&dimensionTab=site&dimensionSource=included",
      ),
      createEnv([configured(), statement({ all: [] })]),
      new URL(
        "https://app.test/api/private/admin/request-observation?dimensionGroup=target&dimensionTab=site&dimensionSource=included",
      ),
    );
    expect(siteFallback.status).toBe(200);
    expect(await siteFallback.json()).toMatchObject({
      dimension: {
        rows: [{ label: "unknown-site" }],
      },
    });

    const productionEnv = createEnv([configured()]);
    delete (productionEnv as unknown as Record<string, unknown>)[
      "INSIGHTFLARE_E2E"
    ];
    const productionResponse = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation?from=0&to=3600000"),
      productionEnv,
      new URL(
        "https://app.test/api/private/admin/request-observation?from=0&to=3600000",
      ),
    );
    expect(productionResponse.status).toBe(200);
  });

  it("keeps authorization, disabled, and provider failures explicit", async () => {
    const encrypted = await encryptAnalyticsEngineSecret(
      { MAIN_SECRET: "main-secret" },
      "cf-token",
    );
    const configuredStatement = () =>
      statement({ first: configRow(encrypted) });

    vi.mocked(requireActor).mockResolvedValue({
      isAdmin: false,
      user: { id: "member-1" },
    } as never);
    const forbidden = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation"),
      createEnv([]),
      new URL("https://app.test/api/private/admin/request-observation"),
    );
    expect(forbidden.status).toBe(403);

    vi.mocked(requireActor).mockResolvedValue(actor as never);
    const methodNotAllowed = await handleRequestObservationAdmin(
      new Request("https://app.test/api/private/admin/request-observation", {
        method: "POST",
      }),
      createEnv([]),
      new URL("https://app.test/api/private/admin/request-observation"),
    );
    expect(methodNotAllowed.status).toBe(405);

    const disabledEnv = createEnv([statement({ first: null })]);
    (disabledEnv as unknown as Record<string, unknown>)[
      "INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED"
    ] = "1";
    const disabled = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation"),
      disabledEnv,
      new URL("https://app.test/api/private/admin/request-observation"),
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      configured: false,
      error: "analytics_engine_disabled",
    });

    const missingMockUrlEnv = createEnv([configuredStatement()]);
    delete (missingMockUrlEnv as unknown as Record<string, unknown>)[
      "INSIGHTFLARE_E2E_CLOUDFLARE_API_URL"
    ];
    const missingMockUrl = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation"),
      missingMockUrlEnv,
      new URL("https://app.test/api/private/admin/request-observation"),
    );
    expect(missingMockUrl.status).toBe(400);

    const missingDetailId = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation?detail=1"),
      createEnv([configuredStatement()]),
      new URL(
        "https://app.test/api/private/admin/request-observation?detail=1",
      ),
    );
    expect(missingDetailId.status).toBe(400);

    const decryptFailure = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation"),
      createEnv([
        statement({
          first: {
            value_json: JSON.stringify({
              accountId: "442fe5198bff93bdf60d4223d9618033",
              apiTokenEncrypted: "invalid-token",
              apiTokenHint: "••••oken",
              configured: true,
              updatedAt: 1,
            }),
          },
        }),
      ]),
      new URL("https://app.test/api/private/admin/request-observation"),
    );
    expect(decryptFailure.status).toBe(400);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("provider unavailable", { status: 503 }),
    );
    const providerFailure = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation"),
      createEnv([configuredStatement()]),
      new URL("https://app.test/api/private/admin/request-observation"),
    );
    expect(providerFailure.status).toBe(400);
    expect(await providerFailure.json()).toMatchObject({
      error: { code: "request_observation_query_failed" },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json\n", { status: 200 }),
    );
    const invalidJsonPage = await handleRequestObservationAdmin(
      request("/api/private/admin/request-observation?page=included"),
      createEnv([configuredStatement()]),
      new URL(
        "https://app.test/api/private/admin/request-observation?page=included",
      ),
    );
    expect(invalidJsonPage.status).toBe(400);
  });
});
