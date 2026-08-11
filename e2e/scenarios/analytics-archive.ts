import { expect, test } from "@playwright/test";

import {
  type ApiEnvelope,
  apiRequest,
  apiV1Request,
  type OverviewMetrics,
  siteQueryPathForWindow,
} from "../support/api";
import { signIn } from "../support/browser";
import type {
  DashboardPage,
  DimensionMetric,
  E2eContext,
  PerformancePayload,
  ReferrerMetric,
} from "../support/flow-context";

export function registerAnalyticsArchiveScenarios(context: E2eContext) {
  const {
    browserNowMs,
    saveManifest,
    seed,
    seedArchiveObject,
    seedHistoricalVisits,
  } = context;
  const { ownerA: ownerAPassword, restrictedA: restrictedAPassword } =
    context.passwords;

  test("14. historical D1 seed matches analytics query truth", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const siteB = seed.sites.siteB;
    expect(siteB).toBeDefined();

    const history = await seedHistoricalVisits(siteB?.id || "");
    seed.history = { siteB: history };
    await saveManifest();

    await signIn(page, "owner-a", ownerAPassword);
    const path = (resource: string) =>
      siteQueryPathForWindow(
        siteB?.id || "",
        resource,
        history.fromMs - 1,
        history.toMs + 1,
      );

    const overview = await apiRequest<OverviewMetrics>(
      page,
      "GET",
      path("overview"),
      undefined,
      "no-store",
    );
    expect(overview.status).toBe(200);
    expect(overview.payload.data).toMatchObject({
      sessions: 40,
      views: history.totalVisits,
      visitors: 24,
    });

    const pages = await apiRequest<DashboardPage[]>(
      page,
      "GET",
      path("pages"),
      undefined,
      "no-store",
    );
    expect(pages.status).toBe(200);
    expect(pages.payload.data).toEqual(
      expect.arrayContaining(
        Object.entries(history.pages).map(([pathname, views]) =>
          expect.objectContaining({ pathname, views }),
        ),
      ),
    );

    const referrers = await apiRequest<ReferrerMetric[]>(
      page,
      "GET",
      path("referrers"),
      undefined,
      "no-store",
    );
    expect(referrers.status).toBe(200);
    expect(referrers.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referrer: "google.com",
          sessions: 40,
          views: 40,
        }),
      ]),
    );

    const campaign = await apiRequest<DimensionMetric[]>(
      page,
      "GET",
      path("utm-campaign"),
      undefined,
      "no-store",
    );
    expect(campaign.status).toBe(200);
    expect(campaign.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "summer-launch",
          sessions: 24,
          views: 24,
          visitors: 24,
        }),
      ]),
    );

    const countries = await apiRequest<DimensionMetric[]>(
      page,
      "GET",
      path("countries"),
      undefined,
      "no-store",
    );
    expect(countries.status).toBe(200);
    expect(countries.payload.data).toEqual(
      expect.arrayContaining(
        ["CN", "DE", "JP", "US"].map((label) =>
          expect.objectContaining({ label, views: 30 }),
        ),
      ),
    );

    const devices = await apiRequest<DimensionMetric[]>(
      page,
      "GET",
      path("overview-client-device-type"),
      undefined,
      "no-store",
    );
    expect(devices.status).toBe(200);
    expect(devices.payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "desktop", views: 80 }),
        expect.objectContaining({ label: "mobile", views: 40 }),
      ]),
    );

    const browsers = await apiRequest<DimensionMetric[]>(
      page,
      "GET",
      path("overview-client-browser"),
      undefined,
      "no-store",
    );
    expect(browsers.status).toBe(200);
    expect(browsers.payload.data).toEqual(
      expect.arrayContaining(
        ["Chrome", "Edge", "Firefox", "Safari"].map((label) =>
          expect.objectContaining({ label, views: 30 }),
        ),
      ),
    );

    const performance = await apiRequest<unknown>(
      page,
      "GET",
      `${path("performance")}&interval=month`,
      undefined,
      "no-store",
    );
    const performancePayload = performance.payload as ApiEnvelope<unknown> &
      PerformancePayload;
    expect(performance.status).toBe(200);
    expect(performancePayload.summaries?.lcp).toEqual(
      expect.objectContaining({
        avg: 1550,
        p75: 1700,
        samples: 120,
      }),
    );
    expect(performancePayload.routes).toEqual(
      expect.arrayContaining(
        Object.entries(history.pages).map(([pathname, views]) =>
          expect.objectContaining({
            metrics: expect.objectContaining({
              lcp: expect.objectContaining({ samples: views }),
            }),
            pathname,
            views,
          }),
        ),
      ),
    );

    const visitors = await apiRequest<Array<{ visitorId: string }>>(
      page,
      "GET",
      `${path("visitors")}&limit=30`,
      undefined,
      "no-store",
    );
    expect(visitors.status).toBe(200);
    expect(visitors.payload.data).toHaveLength(24);

    const sessions = await apiRequest<Array<{ sessionId: string }>>(
      page,
      "GET",
      `${path("sessions")}&limit=50`,
      undefined,
      "no-store",
    );
    expect(sessions.status).toBe(200);
    expect(sessions.payload.data).toHaveLength(40);
  });

  test("14b. archive manifests and ranged files use the local R2 binding", async ({
    page,
  }) => {
    const siteB = seed.sites.siteB;
    expect(siteB).toBeDefined();
    const archive = await seedArchiveObject(siteB?.id || "");
    const from = archive.hour * 60 * 60 * 1000;
    const to = from + 60 * 60 * 1000 - 1;

    await signIn(page, "owner-a", ownerAPassword);
    const manifest = await apiRequest<unknown>(
      page,
      "GET",
      `/api/private/archive/manifest?siteId=${encodeURIComponent(siteB?.id || "")}&from=${from}&to=${to}`,
    );
    const manifestPayload = manifest.payload as {
      files: Array<{ archiveKey: string; fetchUrl: string; sizeBytes: number }>;
    };
    expect(manifest.status).toBe(200);
    expect(manifestPayload.files).toEqual([
      expect.objectContaining({
        archiveKey: archive.archiveKey,
        fetchUrl: `/api/private/archive/file?key=${encodeURIComponent(archive.archiveKey)}`,
        sizeBytes: archive.content.length,
      }),
    ]);

    const range = await page.request.get(
      `/api/private/archive/file?key=${encodeURIComponent(archive.archiveKey)}`,
      { headers: { range: "bytes=0-2" } },
    );
    expect(range.status()).toBe(206);
    expect(range.headers()["content-range"]).toBe(
      `bytes 0-2/${archive.content.length}`,
    );
    expect(await range.text()).toBe(archive.content.slice(0, 3));

    await signIn(page, "restricted-a", restrictedAPassword);
    const denied = await apiRequest<unknown>(
      page,
      "GET",
      `/api/private/archive/manifest?siteId=${encodeURIComponent(siteB?.id || "")}&from=${from}&to=${to}`,
    );
    expect(denied.status).toBe(401);
  });

  test("15. scoped API keys authenticate v1 analytics and enforce scope and revocation", async ({
    page,
  }) => {
    const siteA = seed.sites.siteA;
    const siteB = seed.sites.siteB;
    const analyticsRead = seed.apiKeys.analyticsRead;
    const revoked = seed.apiKeys.revoked;
    expect(siteA).toBeDefined();
    expect(siteB).toBeDefined();
    expect(analyticsRead).toBeDefined();
    expect(revoked).toBeDefined();

    await signIn(page, "owner-a", ownerAPassword);
    const analyticsKey = analyticsRead?.secret || "";
    const toMs = browserNowMs();
    const fromMs = toMs - 60 * 60 * 1000;
    const privateOverview = await apiRequest<OverviewMetrics>(
      page,
      "GET",
      siteQueryPathForWindow(siteA?.id || "", "overview", fromMs, toMs),
      undefined,
      "no-store",
    );
    expect(privateOverview.status).toBe(200);

    const token = await apiV1Request<{
      scopes: string[];
      siteAccess: { mode: string; siteIds: string[] };
    }>(page, "GET", "/api/v1/token", analyticsKey);
    expect(token.status).toBe(200);
    expect(token.payload.data).toMatchObject({
      scopes: ["analytics:read"],
      siteAccess: { mode: "restricted", siteIds: [siteA?.id] },
    });

    const capabilities = await apiV1Request<{
      features: { analytics: boolean; sites: boolean };
    }>(page, "GET", "/api/v1/capabilities", analyticsKey);
    expect(capabilities.status).toBe(200);
    expect(capabilities.payload.data).toMatchObject({
      features: { analytics: true, sites: false },
    });

    const overview = await apiV1Request<OverviewMetrics>(
      page,
      "GET",
      `/api/v1/sites/${encodeURIComponent(siteA?.id || "")}/analytics/overview?from=${encodeURIComponent(new Date(fromMs).toISOString())}&to=${encodeURIComponent(new Date(toMs).toISOString())}&timeZone=UTC`,
      analyticsKey,
    );
    expect(overview.status).toBe(200);
    expect(overview.payload.data).toMatchObject({
      sessions: privateOverview.payload.data?.sessions,
      views: privateOverview.payload.data?.views,
      visitors: privateOverview.payload.data?.visitors,
    });

    const checks = await apiV1Request<{
      checks: Array<{ allowed: boolean; reason?: string; siteId?: string }>;
    }>(page, "POST", "/api/v1/token/check", analyticsKey, {
      checks: [
        { scope: "analytics:read", siteId: siteA?.id || "" },
        { scope: "analytics:read", siteId: siteB?.id || "" },
        { scope: "site:read" },
      ],
    });
    expect(checks.status).toBe(200);
    expect(checks.payload.data?.checks).toEqual([
      expect.objectContaining({ allowed: true, siteId: siteA?.id }),
      expect.objectContaining({
        allowed: false,
        reason: "site_not_allowed",
        siteId: siteB?.id,
      }),
      expect.objectContaining({ allowed: false, reason: "missing_scope" }),
    ]);

    const otherSite = await apiV1Request<OverviewMetrics>(
      page,
      "GET",
      `/api/v1/sites/${encodeURIComponent(siteB?.id || "")}/analytics/overview?from=${encodeURIComponent(new Date(fromMs).toISOString())}&to=${encodeURIComponent(new Date(toMs).toISOString())}`,
      analyticsKey,
    );
    expect(otherSite.status).toBe(404);

    const revokedKey = await apiV1Request<unknown>(
      page,
      "GET",
      "/api/v1/sites",
      revoked?.secret || "",
    );
    expect(revokedKey.status).toBe(401);
  });
}
