import { describe, expect, it, vi } from "vitest";

import { apiV1AnalyticsListRouteRegistry } from "@/lib/api-v1/route-registry";
import {
  handlePlannedSiteChannels,
  type SiteChannelsReader,
} from "@/lib/api-v1/site-list-handler";
import { AnalyticsChannelsResponseSchema } from "@/lib/api-v1/wire";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  status: "active",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
};

const request = (body: unknown) =>
  new Request("https://app.test/api/v1/sites/site-1/analytics/channels", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

describe("site analytics channels API", () => {
  it("registers the exposed operation with its own route", () => {
    expect(apiV1AnalyticsListRouteRegistry).toContainEqual(
      expect.objectContaining({
        id: "site.analytics.channels",
        operationId: "site.analytics.channels",
        path: "/api/v1/sites/{siteId}/analytics/channels",
        lifecycle: "exposed",
      }),
    );
  });

  it("uses list-envelope validation and defaults limit to 20", async () => {
    const reader: SiteChannelsReader = vi.fn().mockResolvedValue({
      items: [{ channel: "direct", views: 3, sessions: 2, visitors: 1 }],
    });
    const response = await handlePlannedSiteChannels(
      request({
        timeRange: {
          kind: "absolute",
          from: "2026-08-01T00:00:00.000Z",
          to: "2026-08-02T00:00:00.000Z",
        },
      }),
      principal,
      "site-1",
      reader,
    );

    expect(response.status).toBe(200);
    expect(
      AnalyticsChannelsResponseSchema.safeParse(await response.json()).success,
    ).toBe(true);
    expect(reader).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 20,
        filters: { version: 1, root: null },
      }),
    );
  });
});
