import { describe, expect, it } from "vitest";

import {
  buildSiteAnalyticsSchema,
  buildTeamAnalyticsSchema,
} from "@/lib/api-v1/analytics-schema";
import { apiV1RouteRegistry } from "@/lib/api-v1/route-registry";
import { AnalyticsSchemaDataSchema } from "@/lib/api-v1/wire";

function expectedOperations(subject: "site" | "team", siteId?: string) {
  return apiV1RouteRegistry
    .filter(
      (route) =>
        route.lifecycle === "exposed" &&
        route.id.startsWith(`${subject}.analytics.`) &&
        (subject === "team" || route.path.includes("{siteId}")),
    )
    .map((route) => ({
      id: route.id,
      method: route.method,
      path: siteId
        ? route.path.replace("{siteId}", encodeURIComponent(siteId))
        : route.path,
    }));
}

describe("typed analytics schema catalog", () => {
  it("derives every exposed site analytics operation from the canonical registry", () => {
    const schema = buildSiteAnalyticsSchema("site/a", {
      now: () => "2026-08-02T00:00:00.000Z",
    });

    expect(schema.timeRange.latestAvailableAt).toBe("2026-08-02T00:00:00.000Z");
    expect(schema.operations).toEqual(expectedOperations("site", "site/a"));
    expect(schema.operations).toContainEqual({
      id: "site.analytics.timeseries",
      method: "POST",
      path: "/api/v1/sites/site%2Fa/analytics/timeseries",
    });
    expect(schema.operations).toContainEqual({
      id: "site.analytics.funnelAnalysis",
      method: "POST",
      path: "/api/v1/sites/site%2Fa/analytics/funnel-analysis",
    });
    expect(schema.links).toEqual({
      overview: "/api/v1/sites/site%2Fa/analytics/overview",
    });
    expect(schema.filters).toContain("page.path");
    expect(schema.operators).toContain("eq");
    expect(schema.filterProtocol.json).toMatchObject({
      documentVersion: 1,
      operators: expect.arrayContaining(["eq", "startsWith"]),
    });
    expect(schema.filterProtocol.dsl).toMatchObject({
      version: 1,
      maxLength: 65_536,
      operators: expect.arrayContaining(["eq", "startsWith"]),
      examples: expect.arrayContaining(['page.path eq "/pricing"']),
    });
    expect(schema.filterProtocol.dsl.syntax.condition).toBe(
      "<field> <operator> <value>",
    );
    expect(AnalyticsSchemaDataSchema.safeParse(schema).success).toBe(true);
  });

  it("does not advertise non-HTTP analytics registry entries", () => {
    const registry = apiV1RouteRegistry as unknown as Array<{
      id: string;
      method: string;
      path: string;
      lifecycle: string;
    }>;
    const sentinel = {
      id: "site.analytics.internal-sentinel",
      method: "DELETE",
      path: "/api/v1/sites/{siteId}/analytics/internal-sentinel",
      lifecycle: "exposed",
    };
    registry.push(sentinel);
    try {
      expect(buildSiteAnalyticsSchema("site-1").operations).not.toContainEqual(
        expect.objectContaining({ id: sentinel.id }),
      );
    } finally {
      registry.pop();
    }
  });
});

describe("team analytics schema", () => {
  it("derives exposed team operations without a caller-controlled team ID", () => {
    const schema = buildTeamAnalyticsSchema({
      now: () => "2026-08-02T00:00:00.000Z",
    });

    expect(schema.operations).toEqual(expectedOperations("team"));
    expect(schema.operations).toContainEqual({
      id: "team.analytics.timeseries",
      method: "POST",
      path: "/api/v1/team/analytics/timeseries",
    });
    expect(
      schema.operations.some((operation) => operation.path.includes("teamId")),
    ).toBe(false);
    expect(AnalyticsSchemaDataSchema.safeParse(schema).success).toBe(true);
  });
});
