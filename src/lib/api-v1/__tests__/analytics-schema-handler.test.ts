import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  handlePlannedSiteAnalyticsSchema,
  handlePlannedTeamAnalyticsSchema,
} from "@/lib/api-v1/analytics-schema-handler";
import { AnalyticsSchemaResponseSchema } from "@/lib/api-v1/wire";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
  status: "active",
};

describe("planned analytics schema HTTP adapter", () => {
  it("returns a private typed catalog with matching request ID headers", async () => {
    const app = new Hono();
    app.get("/api/v1/sites/:siteId/analytics/schema", (context) =>
      handlePlannedSiteAnalyticsSchema(
        context.req.raw,
        principal,
        context.req.param("siteId"),
        { now: () => "2026-08-02T00:00:00.000Z" },
      ),
    );
    const response = await app.fetch(
      new Request("https://app.test/api/v1/sites/site-1/analytics/schema"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = (await response.json()) as {
      readonly meta: { readonly requestId: string };
    };
    expect(AnalyticsSchemaResponseSchema.safeParse(body).success).toBe(true);
    expect(body.meta.requestId).toBe(response.headers.get("X-Request-Id"));
  });

  it("fails closed for method, scope, inactive key, and site violations", () => {
    const base = "https://app.test/api/v1/sites/site-1/analytics/schema";
    expect(
      handlePlannedSiteAnalyticsSchema(
        new Request(base, { method: "POST" }),
        principal,
        "site-1",
      ).status,
    ).toBe(405);
    expect(
      handlePlannedSiteAnalyticsSchema(
        new Request(base),
        { ...principal, scopes: [] },
        "site-1",
      ).status,
    ).toBe(403);
    expect(
      handlePlannedSiteAnalyticsSchema(
        new Request(base),
        { ...principal, status: "revoked" },
        "site-1",
      ).status,
    ).toBe(403);
    expect(
      handlePlannedSiteAnalyticsSchema(new Request(base), principal, "site-2")
        .status,
    ).toBe(404);
  });

  it("serves the team catalog only to active analytics principals", async () => {
    const request = new Request(
      "https://app.test/api/v1/team/analytics/schema",
    );
    const response = handlePlannedTeamAnalyticsSchema(request, principal, {
      now: () => "2026-08-02T00:00:00.000Z",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: { operations: unknown[] };
    };
    expect(payload.data.operations).toEqual(
      expect.arrayContaining([
        {
          id: "team.analytics.overview",
          method: "POST",
          path: "/api/v1/team/analytics/overview",
        },
        {
          id: "team.analytics.comparison",
          method: "POST",
          path: "/api/v1/team/analytics/comparison",
        },
        {
          id: "team.analytics.sites",
          method: "POST",
          path: "/api/v1/team/analytics/sites",
        },
      ]),
    );
    expect(
      handlePlannedTeamAnalyticsSchema(request, { ...principal, scopes: [] })
        .status,
    ).toBe(403);
    expect(
      handlePlannedTeamAnalyticsSchema(
        new Request(request.url, { method: "POST" }),
        principal,
      ).status,
    ).toBe(405);
    expect(
      handlePlannedTeamAnalyticsSchema(request, {
        ...principal,
        status: "revoked",
      }).status,
    ).toBe(403);
  });
});
