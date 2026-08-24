import { describe, expect, it } from "vitest";

import {
  badRequest,
  jsonResponse,
  notAllowed,
  notFound,
  siteQueryHeaders,
  siteQueryResponse,
  unauthorized,
} from "@/lib/edge/analytics/providers/d1/internal/core-responses";
import {
  PRIVATE_CACHE_HEADERS,
  PUBLIC_CACHE_HEADERS,
  PUBLIC_PRIVACY,
} from "@/lib/edge/analytics/providers/d1/internal/core-types";

describe("edge query response helpers", () => {
  it("serializes JSON responses with status and extra headers", async () => {
    const response = jsonResponse({ ok: true }, 202, {
      "cache-control": "no-store",
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("builds standard error responses with code and message", async () => {
    const badReq = await badRequest("Invalid").json();
    expect(badReq).toMatchObject({
      ok: false,
      error: { message: "Invalid" },
    });
    expect(badReq).toHaveProperty("requestId");
    expect(badReq).toHaveProperty("timestamp");

    const unauth = await unauthorized().json();
    expect(unauth).toMatchObject({
      ok: false,
      error: { message: "Unauthorized" },
    });

    const missing = await notFound("Missing").json();
    expect(missing).toMatchObject({
      ok: false,
      error: { message: "Missing" },
    });

    const notAllowedResponse = notAllowed();
    expect(notAllowedResponse.status).toBe(405);
    const notAllowedBody = await notAllowedResponse.json();
    expect(notAllowedBody).toMatchObject({
      ok: false,
      error: { message: "Method Not Allowed" },
    });
  });

  it("selects private and public site query cache headers", () => {
    expect(siteQueryHeaders({})).toBe(PRIVATE_CACHE_HEADERS);
    expect(
      siteQueryHeaders({
        publicSite: { slug: "public", name: "Public", domain: "example.com" },
      }),
    ).toBe(PUBLIC_CACHE_HEADERS);
  });

  it("wraps private responses with site id and public responses with privacy", async () => {
    const privateResponse = siteQueryResponse("site-1", { ok: true });
    const publicResponse = siteQueryResponse(
      "site-1",
      { ok: true, siteId: "ignored" },
      {
        publicSite: {
          slug: "public",
          name: "Public",
          domain: "public.example",
        },
      },
    );

    expect(privateResponse.headers.get("cache-control")).toBe(
      PRIVATE_CACHE_HEADERS["cache-control"],
    );
    await expect(privateResponse.json()).resolves.toEqual({
      ok: true,
      siteId: "site-1",
    });
    expect(publicResponse.headers.get("access-control-allow-origin")).toBe("*");
    await expect(publicResponse.json()).resolves.toEqual({
      ok: true,
      siteId: "ignored",
      site: { slug: "public", name: "Public", domain: "public.example" },
      privacy: PUBLIC_PRIVACY,
    });
  });

  it("includes requestId and timestamp when ctx is provided", async () => {
    const response = siteQueryResponse(
      "site-1",
      { ok: true },
      {},
      { requestId: "test-ray-id" },
    );
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      siteId: "site-1",
      requestId: "test-ray-id",
    });
    expect(body).toHaveProperty("timestamp");
  });
});
