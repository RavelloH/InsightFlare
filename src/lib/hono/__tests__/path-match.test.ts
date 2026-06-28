import { describe, expect, it } from "vitest";

import { shouldUseHono } from "@/lib/hono/path-match";

describe("shouldUseHono", () => {
  it.each([
    "/api/private/overview",
    "/api/public/demo/site",
    "/api/v1/capabilities",
    "/api/map-tiles/1/0/0.png",
    "/collect",
    "/script.js",
    "/healthz",
    "/.well-known/openapi.json",
    "/.well-known/security.txt",
    "/admin/ws",
  ])("routes %s through the Hono app", (pathname) => {
    expect(shouldUseHono(pathname)).toBe(true);
  });

  it.each([
    "/",
    "/app",
    "/login",
    "/zh/app/team/site",
    "/_next/static/chunk.js",
    "/favicon.ico",
    "/api",
    "/collect/",
    "/admin/ws/extra",
  ])("leaves %s on the OpenNext path", (pathname) => {
    expect(shouldUseHono(pathname)).toBe(false);
  });
});
