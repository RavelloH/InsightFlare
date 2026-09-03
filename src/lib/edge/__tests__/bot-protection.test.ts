import { classifyASN } from "asn-blocklist";
import { describe, expect, it, vi } from "vitest";

import {
  REQUEST_ANALYTICS_BLOBS,
  REQUEST_ANALYTICS_DOUBLES,
  writeRequestAnalyticsPoint,
} from "@/lib/edge/analytics-engine/index";
import { classifyCollectBotTraffic } from "@/lib/edge/bot-protection";
import type { Env, TrackerClientPayload } from "@/lib/edge/types";

vi.mock("asn-blocklist", () => ({
  classifyASN: vi.fn((asn: unknown) => {
    if (Number(asn) === 13335) return "hosting";
    if (Number(asn) === 9009) return "network_service";
    if (Number(asn) === 4134) return "transit";
    if (Number(asn) === 7922) return "access";
    return "unknown";
  }),
}));

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function request(headers: HeadersInit, cf?: Record<string, unknown>): Request {
  const inputHeaders = new Headers(headers);
  const req = new Request("https://collector.test/collect", {
    method: "POST",
    headers: inputHeaders,
  });
  vi.spyOn(req.headers, "get").mockImplementation((name) =>
    inputHeaders.get(name),
  );
  if (cf) {
    Object.defineProperty(req, "cf", {
      value: cf,
      configurable: true,
    });
  }
  return req;
}

const payload: TrackerClientPayload = {
  siteId: "site-1",
  kind: "pageview",
  visitId: "visit-1",
  pathname: "/pricing",
  hostname: "example.com",
};

describe("bot protection", () => {
  it("keeps the Analytics Engine schema within data point limits", () => {
    expect(REQUEST_ANALYTICS_BLOBS).toHaveLength(20);
    expect(REQUEST_ANALYTICS_DOUBLES).toHaveLength(20);
  });

  it("classifies known bot user agents as bot traffic", () => {
    const result = classifyCollectBotTraffic({
      request: request({
        "user-agent": "Googlebot/2.1",
        origin: "https://example.com",
      }),
      payload,
      origin: "https://example.com",
    });

    expect(result).toMatchObject({
      category: "bot",
    });
    expect(result.reasons).toContain("ua_isbot");
  });

  it("classifies script user agents as bot traffic", () => {
    const result = classifyCollectBotTraffic({
      request: request({
        "user-agent": "curl/8.14.1",
        origin: "https://example.com",
      }),
      payload,
      origin: "https://example.com",
    });

    expect(result).toMatchObject({
      category: "bot",
    });
    expect(result.reasons).toContain("script_ua");
  });

  it("classifies verified bot categories as bot traffic", () => {
    const result = classifyCollectBotTraffic({
      request: request(
        {
          "user-agent": CHROME_UA,
          origin: "https://example.com",
        },
        { verifiedBotCategory: "Search Engine Crawler" },
      ),
      payload,
      origin: "https://example.com",
    });

    expect(result).toMatchObject({
      category: "bot",
    });
    expect(result.reasons).toContain("cf_verified_bot_category");
  });

  it("classifies configured hosting ASNs as suspected bot traffic", () => {
    const result = classifyCollectBotTraffic({
      request: request(
        {
          "user-agent": CHROME_UA,
          origin: "https://example.com",
        },
        {
          asn: 13335,
          asOrganization: "Cloudflare Inc.",
        },
      ),
      payload,
      origin: "https://example.com",
    });

    expect(result).toMatchObject({
      category: "suspected_bot",
    });
    expect(result.reasons).toContain("hosting_asn");
    expect(vi.mocked(classifyASN)).toHaveBeenCalledWith(13335);
  });

  it("does not classify AS organization names without a risky ASN class", () => {
    vi.mocked(classifyASN).mockReturnValueOnce("unknown");
    const result = classifyCollectBotTraffic({
      request: request(
        {
          "user-agent": CHROME_UA,
          origin: "https://example.com",
          "sec-fetch-site": "cross-site",
        },
        {
          asn: 64512,
          asOrganization: "Amazon Data Services Singapore",
        },
      ),
      payload,
      origin: "https://example.com",
    });

    expect(result).toEqual({
      category: "normal",
      reasons: [],
    });
  });

  it("keeps network-service ASNs on the main lane when browser provenance is present", () => {
    const result = classifyCollectBotTraffic({
      request: request(
        {
          "user-agent": CHROME_UA,
          origin: "https://example.com",
          "sec-fetch-site": "cross-site",
        },
        {
          asn: 9009,
          asOrganization: "M247 Global",
        },
      ),
      payload,
      origin: "https://example.com",
    });

    expect(result).toEqual({
      category: "normal",
      reasons: ["network_service_asn"],
    });
  });

  it("classifies network-service ASNs with missing browser provenance as suspected bot traffic", () => {
    const result = classifyCollectBotTraffic({
      request: request(
        {
          "user-agent": CHROME_UA,
        },
        {
          asn: 9009,
          asOrganization: "M247 Global",
        },
      ),
      payload,
      origin: "https://example.com",
    });

    expect(result).toMatchObject({
      category: "suspected_bot",
    });
    expect(result.reasons).toEqual([
      "network_service_asn",
      "missing_browser_provenance",
    ]);
  });

  it("does not divert transit or access ASNs on ASN class alone", () => {
    const transit = classifyCollectBotTraffic({
      request: request(
        {
          "user-agent": CHROME_UA,
          origin: "https://example.com",
          "sec-fetch-site": "cross-site",
        },
        {
          asn: 4134,
          asOrganization: "China Telecom",
        },
      ),
      payload,
      origin: "https://example.com",
    });
    const access = classifyCollectBotTraffic({
      request: request(
        {
          "user-agent": CHROME_UA,
          origin: "https://example.com",
          "sec-fetch-site": "cross-site",
        },
        {
          asn: 7922,
          asOrganization: "Comcast",
        },
      ),
      payload,
      origin: "https://example.com",
    });

    expect(transit).toEqual({
      category: "normal",
      reasons: ["transit_asn"],
    });
    expect(access).toEqual({
      category: "normal",
      reasons: ["access_asn"],
    });
  });

  it("keeps normal browser requests on the main lane", () => {
    const result = classifyCollectBotTraffic({
      request: request({
        "user-agent": CHROME_UA,
        origin: "https://example.com",
        "sec-fetch-site": "cross-site",
      }),
      payload,
      origin: "https://example.com",
    });

    expect(result).toEqual({
      category: "normal",
      reasons: [],
    });
  });

  it("writes rich request observation points with site index and metadata", () => {
    const writeDataPoint = vi.fn();
    const env = {
      REQUEST_ANALYTICS: { writeDataPoint },
    } as unknown as Env;

    writeRequestAnalyticsPoint(env, {
      request: request(
        {
          "user-agent": "curl/8.14.1",
          "cf-connecting-ip": "203.0.113.10",
          "cf-ray": "ray-1",
          origin: "https://example.com",
        },
        {
          asn: 137409,
          asOrganization: "GSL Networks Pty LTD - Tokyo",
          country: "JP",
          region: "Tokyo",
          city: "Tokyo",
          continent: "AS",
          colo: "NRT",
          latitude: "35.6895",
          longitude: "139.69171",
        },
      ),
      payload,
      siteId: "site-1",
      origin: "https://example.com",
      traceId: "trace-1",
      receivedAt: 1_800_000_000_000,
      category: "bot",
      disposition: "blocked",
      reasons: ["script_ua"],
    });

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point).toMatchObject({
      indexes: ["site-1"],
      doubles: expect.arrayContaining([
        1_800_000_000_000,
        1_800_000_000_000,
        expect.any(Number),
        137409,
        35.6895,
        139.69171,
        0,
        "curl/8.14.1".length,
      ]),
    });
    expect(point?.blobs).toEqual(
      expect.arrayContaining([
        "pageview",
        "bot",
        "script_ua",
        "203.0.113.10",
        "curl/8.14.1",
        "JP",
        "ray-1",
        "trace-1",
      ]),
    );
  });

  it("drops request observation points when Analytics Engine is disabled", () => {
    const writeDataPoint = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = {
      REQUEST_ANALYTICS: { writeDataPoint },
      INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED: "1",
    } as unknown as Env;

    writeRequestAnalyticsPoint(env, {
      request: request({ "user-agent": "curl/8.14.1" }),
      payload,
      siteId: "site-1",
      origin: "https://example.com",
      traceId: "trace-1",
      receivedAt: 1_800_000_000_000,
      category: "bot",
      disposition: "blocked",
      reasons: ["script_ua"],
    });

    expect(writeDataPoint).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
