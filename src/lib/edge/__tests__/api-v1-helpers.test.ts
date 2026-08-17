import { describe, expect, it } from "vitest";

import {
  epochSecondsToIso,
  generatedAt,
  getRequestMeta,
  isValidTimeZone,
  jsonError,
  jsonList,
  jsonPaginated,
  jsonSuccess,
  methodNotAllowed,
  normalizeUnknownDirect,
  parseCursorPagination,
  parseMetrics,
  parsePreset,
  parseSort,
  parseTimeRange,
  requireScope,
  validateDimension,
} from "@/lib/edge/api-v1-helpers";
import {
  parseApiV1FilterDocument,
  parseApiV1FilterUrl,
} from "@/lib/edge/query-contract";

function url(path: string): URL {
  return new URL(`https://edge.test${path}`);
}

interface TestEnvelope {
  links?: Record<string, string>;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

describe("api v1 helpers", () => {
  it("wraps success and error responses without ok", async () => {
    const success = await jsonSuccess(
      { value: 1 },
      {
        request: new Request("https://edge.test/api/v1"),
      },
    ).json();
    expect(success).toMatchObject({
      data: { value: 1 },
      meta: { generatedAt: expect.any(String), requestId: expect.any(String) },
    });
    expect(JSON.stringify(success)).not.toContain('"ok"');

    const failure = await jsonError(
      "validation_failed",
      "Invalid",
      400,
      { field: "from" },
      new Request("https://edge.test/api/v1"),
    ).json();
    expect(failure).toMatchObject({
      error: {
        code: "validation_failed",
        message: "Invalid",
        details: { field: "from" },
      },
      meta: { generatedAt: expect.any(String) },
    });
  });

  it("parses ISO time ranges and defaults to the previous seven days", () => {
    const parsed = parseTimeRange(
      url(
        "/api/v1/sites/s/analytics/overview?from=2026-06-01T00:00:00Z&to=2026-06-08T00:00:00Z",
      ),
      new Date("2026-06-26T12:00:00Z"),
    );
    expect(parsed).not.toBeInstanceOf(Response);
    if (!(parsed instanceof Response)) {
      expect(parsed.from).toBe("2026-06-01T00:00:00.000Z");
      expect(parsed.to).toBe("2026-06-08T00:00:00.000Z");
      expect(parsed.startMs).toBeLessThan(parsed.endExclusiveMs);
    }

    const defaulted = parseTimeRange(
      url("/api/v1/sites/s/analytics/overview"),
      new Date("2026-06-26T12:00:00Z"),
    );
    expect(defaulted).not.toBeInstanceOf(Response);
    if (!(defaulted instanceof Response)) {
      expect(defaulted.from).toBe("2026-06-19T12:00:00.000Z");
      expect(defaulted.to).toBe("2026-06-26T12:00:00.000Z");
    }
  });

  it("parses presets with timeZone and rejects conflicting time inputs", async () => {
    const preset = parsePreset(
      "last_7_days",
      "Asia/Shanghai",
      new Date("2026-06-26T12:00:00Z"),
    );
    expect(preset).toMatchObject({
      timeZone: "Asia/Shanghai",
      from: expect.any(String),
      to: expect.any(String),
    });

    const conflict = parseTimeRange(
      url(
        "/api/v1/sites/s/analytics/overview?preset=last_7_days&from=2026-06-01T00:00:00Z",
      ),
    );
    expect(conflict).toBeInstanceOf(Response);
    if (conflict instanceof Response) {
      expect(conflict.status).toBe(400);
      expect(await conflict.json()).toMatchObject({
        error: { code: "validation_failed" },
      });
    }

    const invalidZone = parseTimeRange(
      url("/api/v1/sites/s/analytics/overview?timeZone=Nope/Nowhere"),
    );
    expect(invalidZone).toBeInstanceOf(Response);
  });

  it("parses metrics, typed filters, sort, and cursor pagination", async () => {
    expect(parseMetrics("views,sessions,visitors")).toEqual([
      "views",
      "sessions",
      "visitors",
    ]);
    expect(parseMetrics("views,nope")).toBeInstanceOf(Response);

    expect(
      parseApiV1FilterUrl(url("/api/v1/sites/s/events?filter[geo.country]=US"))
        .root,
    ).toMatchObject({ kind: "condition", value: "us" });

    expect(parseSort("-lastSeenAt")).toEqual({
      field: "lastSeenAt",
      direction: "desc",
    });
    expect(parseSort("page.path")).toEqual({
      field: "page.path",
      direction: "asc",
    });

    expect(parseCursorPagination(url("/api/v1/sites/s/events"))).toEqual({
      limit: 100,
      cursor: null,
    });
    expect(
      parseCursorPagination(url("/api/v1/sites/s/events?limit=2000")),
    ).toEqual({ limit: 1000, cursor: null });
    expect(
      parseCursorPagination(url("/api/v1/sites/s/events?cursor=bad space")),
    ).toBeInstanceOf(Response);
  });

  it("validates dimensions and structured filters", () => {
    expect(validateDimension("geo.country")).toBe("geo.country");
    expect(validateDimension("country")).toBeInstanceOf(Response);
    expect(
      parseApiV1FilterDocument({
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "page.path" },
          operator: "startsWith",
          value: "/posts/",
        },
      }).root,
    ).toMatchObject({ operator: "startsWith" });
  });

  // ── additional coverage ──────────────────────────────────────────

  it("jsonList wraps data in the success envelope", async () => {
    const res = jsonList([{ id: 1 }], {
      request: new Request("https://edge.test"),
      meta: { extra: true },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestEnvelope;
    expect(body).toMatchObject({
      data: [{ id: 1 }],
      meta: { generatedAt: expect.any(String), extra: true },
    });
  });

  it("jsonPaginated includes pagination in the envelope", async () => {
    const res = jsonPaginated(
      [{ id: 1 }],
      { limit: 50, nextCursor: "abc", hasMore: true },
      { request: new Request("https://edge.test") },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestEnvelope;
    expect(body).toMatchObject({
      data: [{ id: 1 }],
      pagination: { limit: 50, nextCursor: "abc", hasMore: true },
    });
  });

  it("jsonSuccess applies custom status and headers", () => {
    const res = jsonSuccess(
      { ok: true },
      {
        status: 201,
        headers: { "x-custom": "yes" },
      },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("yes");
  });

  it("jsonPaginated includes links when provided", async () => {
    const res = jsonPaginated(
      [],
      { limit: 10, nextCursor: null, hasMore: false },
      { links: { self: "/api/v1/items" } },
    );
    const body = (await res.json()) as TestEnvelope;
    expect(body.links).toEqual({ self: "/api/v1/items" });
  });

  it("jsonSuccess includes links when provided", async () => {
    const res = jsonSuccess(
      { id: 1 },
      {
        links: { self: "/api/v1/items/1" },
      },
    );
    const body = (await res.json()) as TestEnvelope;
    expect(body.links).toEqual({ self: "/api/v1/items/1" });
  });

  it("jsonError omits details when not provided", async () => {
    const res = jsonError("not_found", "Not Found", 404);
    const body = (await res.json()) as TestEnvelope;
    expect(body.error).toEqual({ code: "not_found", message: "Not Found" });
    expect(body.error).not.toHaveProperty("details");
  });

  it("methodNotAllowed returns 405", async () => {
    const res = methodNotAllowed(
      new Request("https://edge.test/api/v1", { method: "POST" }),
    );
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body).toMatchObject({
      error: { code: "method_not_allowed" },
    });
  });

  it("generatedAt returns an ISO string", () => {
    const ts = generatedAt();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("getRequestMeta adds requestId when a request is provided", () => {
    const req = new Request("https://edge.test", {
      headers: { "cf-ray": "ray-123" },
    });
    const meta = getRequestMeta(req);
    expect(meta.requestId).toBeDefined();
    expect(meta.generatedAt).toBeDefined();
  });

  it("getRequestMeta omits requestId when no request is provided", () => {
    const meta = getRequestMeta(null);
    expect(meta).not.toHaveProperty("requestId");
    expect(meta.generatedAt).toBeDefined();
  });

  it("parsePreset handles all eight presets", () => {
    const now = new Date("2026-06-26T12:00:00Z");
    const presets = [
      "today",
      "yesterday",
      "last_7_days",
      "last_30_days",
      "this_week",
      "last_week",
      "this_month",
      "last_month",
    ] as const;
    for (const preset of presets) {
      const result = parsePreset(preset, "UTC", now);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.startMs).toBeLessThan(result.endExclusiveMs);
        expect(result.timeZone).toBe("UTC");
      }
    }
  });

  it("parsePreset returns null for an unknown preset", () => {
    expect(parsePreset("next_year", "UTC", new Date())).toBeNull();
  });

  it("parsePreset returns null for an invalid timezone", () => {
    expect(parsePreset("today", "Invalid/Zone", new Date())).toBeNull();
  });

  it("parseTimeRange rejects an invalid preset value", async () => {
    const res = parseTimeRange(url("/api/v1/sites/s?preset=nonsense"));
    expect(res).toBeInstanceOf(Response);
    if (res instanceof Response) {
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: { code: "validation_failed" } });
    }
  });

  it("parseTimeRange rejects malformed from/to ISO dates", async () => {
    const res = parseTimeRange(
      url("/api/v1/sites/s?from=not-a-date&to=2026-06-01T00:00:00Z"),
    );
    expect(res).toBeInstanceOf(Response);
    if (res instanceof Response) {
      expect(res.status).toBe(400);
    }
  });

  it("parseTimeRange rejects when from is after to", async () => {
    const res = parseTimeRange(
      url("/api/v1/sites/s?from=2026-06-10T00:00:00Z&to=2026-06-01T00:00:00Z"),
    );
    expect(res).toBeInstanceOf(Response);
    if (res instanceof Response) {
      expect(res.status).toBe(400);
    }
  });

  it("parseTimeRange defaults to when only from is set", () => {
    const res = parseTimeRange(
      url("/api/v1/sites/s?from=2026-06-01T00:00:00Z"),
      new Date("2026-06-26T12:00:00Z"),
    );
    expect(res).not.toBeInstanceOf(Response);
    if (!(res instanceof Response)) {
      expect(res.from).toBe("2026-06-01T00:00:00.000Z");
    }
  });

  it("parseTimeRange defaults to when only to is set", () => {
    const res = parseTimeRange(
      url("/api/v1/sites/s?to=2026-06-26T12:00:00Z"),
      new Date("2026-06-26T12:00:00Z"),
    );
    expect(res).not.toBeInstanceOf(Response);
    if (!(res instanceof Response)) {
      expect(res.endExclusiveMs).toBe(
        new Date("2026-06-26T12:00:00Z").getTime(),
      );
    }
  });

  it("parseMetrics falls back to defaults when raw is null", () => {
    expect(parseMetrics(null)).toEqual(["views", "sessions", "visitors"]);
    expect(parseMetrics(null, ["events"])).toEqual(["events"]);
  });

  it("parseMetrics deduplicates values", () => {
    expect(parseMetrics("views,views,sessions")).toEqual(["views", "sessions"]);
  });

  it("parseSort returns null for null, empty, or whitespace", () => {
    expect(parseSort(null)).toBeNull();
    expect(parseSort("")).toBeNull();
    expect(parseSort("   ")).toBeNull();
  });

  it("parseCursorPagination rejects limit <= 0", async () => {
    const res = parseCursorPagination(url("/api/v1/sites/s/events?limit=0"));
    expect(res).toBeInstanceOf(Response);
    if (res instanceof Response) {
      expect(res.status).toBe(400);
    }
  });

  it("parseCursorPagination rejects negative limit", async () => {
    const res = parseCursorPagination(url("/api/v1/sites/s/events?limit=-5"));
    expect(res).toBeInstanceOf(Response);
    if (res instanceof Response) {
      expect(res.status).toBe(400);
    }
  });

  it("parseCursorPagination accepts a valid cursor", () => {
    const result = parseCursorPagination(
      url("/api/v1/sites/s/events?cursor=abc123"),
    );
    expect(result).toEqual({ limit: 100, cursor: "abc123" });
  });

  it("validateDimension returns the dimension when valid", () => {
    expect(validateDimension("event.name")).toBe("event.name");
  });

  it("requireScope returns null when scope is present", () => {
    const req = new Request("https://edge.test");
    expect(
      requireScope(["site:read", "analytics:read"], "site:read", req),
    ).toBeNull();
  });

  it("requireScope returns 403 when scope is missing", async () => {
    const req = new Request("https://edge.test");
    const res = requireScope(["site:read"], "analytics:read", req);
    expect(res).toBeInstanceOf(Response);
    if (res) {
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toMatchObject({
        error: { code: "insufficient_scope" },
      });
    }
  });

  it("epochSecondsToIso returns null for null and undefined", () => {
    expect(epochSecondsToIso(null)).toBeNull();
    expect(epochSecondsToIso(undefined)).toBeNull();
  });

  it("epochSecondsToIso converts a unix timestamp to ISO", () => {
    const result = epochSecondsToIso(1_000_000_000);
    expect(result).toBe("2001-09-09T01:46:40.000Z");
  });

  it("normalizeUnknownDirect handles empty, direct, and normal values", () => {
    expect(normalizeUnknownDirect(null)).toEqual({
      key: "__unknown__",
      label: "Unknown",
    });
    expect(normalizeUnknownDirect("")).toEqual({
      key: "__unknown__",
      label: "Unknown",
    });
    expect(normalizeUnknownDirect("  ")).toEqual({
      key: "__unknown__",
      label: "Unknown",
    });
    expect(normalizeUnknownDirect("direct")).toEqual({
      key: "__direct__",
      label: "Direct",
    });
    expect(normalizeUnknownDirect("Direct")).toEqual({
      key: "__direct__",
      label: "Direct",
    });
    expect(normalizeUnknownDirect("Google")).toEqual({
      key: "Google",
      label: "Google",
    });
  });

  it("isValidTimeZone returns true for valid zones and false for invalid", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Not/A/Zone")).toBe(false);
  });
});
