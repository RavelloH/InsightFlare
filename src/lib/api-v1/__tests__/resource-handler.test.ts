import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  UpdateFunnelInputSchema,
  UpdatePrivacySettingsInputSchema,
  UpdateSharingSettingsInputSchema,
  UpdateSiteInputSchema,
  UpdateTrackingSettingsInputSchema,
} from "@/lib/api-v1/application-registry";
import { createResourceApplicationService } from "@/lib/api-v1/resource-application-service";
import { handlePlannedResourceRoute } from "@/lib/api-v1/resource-handler";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const resourceDependencies = vi.hoisted(() => ({
  createSiteWithDefaultSettings: vi.fn(),
  deleteSiteData: vi.fn(),
  ensurePublicSlugAvailable: vi.fn(),
  readSiteScriptSettings: vi.fn(),
  upsertSiteScriptSettings: vi.fn(),
}));

vi.mock("@/lib/edge/admin-sites", () => ({
  createSiteWithDefaultSettings:
    resourceDependencies.createSiteWithDefaultSettings,
  deleteSiteData: resourceDependencies.deleteSiteData,
  ensurePublicSlugAvailable: resourceDependencies.ensurePublicSlugAvailable,
}));

vi.mock("@/lib/edge/site-settings-store", () => ({
  readSiteScriptSettings: resourceDependencies.readSiteScriptSettings,
  upsertSiteScriptSettings: resourceDependencies.upsertSiteScriptSettings,
}));

const principal = (
  scopes: ApiKeyPrincipal["scopes"] = ["site:read"],
): ApiKeyPrincipal => ({
  keyId: "key-1",
  teamId: "team-1",
  prefix: "if_test",
  scopes,
  siteIds: ["site-1"],
});

const siteRow = {
  id: "site-1",
  teamId: "team-1",
  name: "Example",
  domain: "example.test",
  publicEnabled: 0,
  publicSlug: null,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_001,
};

function envWithSite() {
  const first = vi.fn().mockResolvedValue(siteRow);
  const all = vi.fn().mockResolvedValue({ results: [siteRow] });
  const bind = vi.fn().mockReturnValue({ first, all, run: vi.fn() });
  return {
    env: { DB: { prepare: vi.fn().mockReturnValue({ bind }) } } as never,
    prepare: bind.mock.instances as unknown[],
    first,
    all,
  };
}

const scriptSettings = {
  trackingStrength: "smart" as const,
  trackQueryParams: true,
  trackHash: true,
  autoTrackOutboundLinks: false,
  domainWhitelist: [],
  pathBlacklist: [],
  ignoreDoNotTrack: true,
  performanceSampleRate: 100,
};

const funnelRow = {
  id: "funnel-1",
  site_id: "site-1",
  name: "Signup",
  config_json: JSON.stringify({
    steps: [
      { type: "pageview", value: "/pricing" },
      { type: "event", value: "signup" },
    ],
  }),
  created_at: 1_700_000_000,
  updated_at: 1_700_000_001,
};

function resourceEnv(
  rows: {
    readonly site: typeof siteRow | null;
    readonly funnel: typeof funnelRow | null;
  } = { site: siteRow, funnel: funnelRow },
) {
  const runs = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: vi
        .fn()
        .mockResolvedValue(
          sql.includes("analysis_definitions") ? rows.funnel : rows.site,
        ),
      all: vi.fn().mockResolvedValue({
        results: [
          sql.includes("analysis_definitions") ? rows.funnel : rows.site,
        ].filter(
          (row): row is typeof siteRow | typeof funnelRow => row !== null,
        ),
      }),
      run: runs,
    })),
  }));
  return { env: { DB: { prepare } } as never, prepare, runs };
}

describe("typed API v1 resource boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resourceDependencies.ensurePublicSlugAvailable.mockResolvedValue(true);
    resourceDependencies.readSiteScriptSettings.mockResolvedValue(
      scriptSettings,
    );
    resourceDependencies.upsertSiteScriptSettings.mockResolvedValue(
      scriptSettings,
    );
    resourceDependencies.createSiteWithDefaultSettings.mockResolvedValue(
      "site-1",
    );
  });

  it("rejects wrong methods, media types, and scopes before resource execution", async () => {
    const noScope = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites/site-1"),
      env: {} as never,
      principal: principal([]),
      routeId: "sites.get",
      siteId: "site-1",
    });
    expect(noScope.status).toBe(403);

    const media = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "nope",
      }),
      env: {} as never,
      principal: principal(["site:write"]),
      routeId: "sites.create",
    });
    expect(media.status).toBe(415);

    const method = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites/site-1", {
        method: "POST",
      }),
      env: {} as never,
      principal: principal(),
      routeId: "sites.get",
      siteId: "site-1",
    });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");

    const collectionMethod = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites", { method: "PUT" }),
      env: {} as never,
      principal: principal(),
      routeId: "sites.list",
      allow: "GET, POST",
    });
    expect(collectionMethod.headers.get("allow")).toBe("GET, POST");
  });

  it("serializes a typed site resource and keeps a restricted principal out of D1", async () => {
    const db = envWithSite();
    const response = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites/site-1"),
      env: db.env,
      principal: principal(),
      routeId: "sites.get",
      siteId: "site-1",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: "site-1", sharing: { publicEnabled: false } },
    });

    const prepare = vi.fn();
    const denied = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites/site-2"),
      env: { DB: { prepare } } as never,
      principal: principal(),
      routeId: "sites.get",
      siteId: "site-2",
    });
    expect(denied.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps resource service inputs HTTP-free and filters a site list by the trusted context", async () => {
    const db = envWithSite();
    const service = createResourceApplicationService(db.env);
    const result = await service.execute(
      { teamId: "team-1", siteIds: ["site-2"] },
      "sites.list",
      {},
      {},
    );
    expect(result).toEqual({ ok: true, value: [] });
    expect(db.all).toHaveBeenCalledOnce();
  });

  it("rejects immutable settings fields and oversized mutation bodies at the HTTP boundary", async () => {
    expect(
      UpdateTrackingSettingsInputSchema.safeParse({
        siteId: "site-1",
        trackPageviews: true,
      }).success,
    ).toBe(false);
    expect(
      UpdateTrackingSettingsInputSchema.safeParse({
        siteId: "site-1",
        trackQuery: false,
      }).success,
    ).toBe(true);
    expect(
      UpdateSharingSettingsInputSchema.safeParse({
        siteId: "site-1",
        publicSlug: "team-example",
      }).success,
    ).toBe(true);
    expect(
      UpdateSharingSettingsInputSchema.safeParse({ siteId: "site-1" }).success,
    ).toBe(false);

    const immutable = await handlePlannedResourceRoute({
      request: new Request(
        "https://app.test/api/v1/sites/site-1/settings/tracking",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trackPageviews: true }),
        },
      ),
      env: {} as never,
      principal: principal(["site_config:write"]),
      routeId: "settings.tracking.update",
      siteId: "site-1",
    });
    expect(immutable.status).toBe(400);

    const oversized = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Example", domain: "x".repeat(70_000) }),
      }),
      env: {} as never,
      principal: principal(["site:write"]),
      routeId: "sites.create",
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "payload_too_large" },
    });
  });

  it("merges resource settings and preserves sharing state for slug-only patches", async () => {
    const db = resourceEnv();
    const service = createResourceApplicationService(db.env);
    const context = { teamId: "team-1", siteIds: [] };

    const tracking = await service.execute(
      context,
      "settings.tracking.update",
      {
        siteId: "site-1",
        trackQuery: false,
        allowedDomains: ["example.test", "www.example.test"],
        excludedPaths: ["/admin"],
      },
      {},
    );
    expect(tracking).toMatchObject({
      ok: true,
      value: { trackQuery: true, allowedDomains: ["example.test"] },
    });
    expect(resourceDependencies.upsertSiteScriptSettings).toHaveBeenCalledWith(
      db.env,
      "site-1",
      expect.objectContaining({
        settings: expect.objectContaining({
          trackQueryParams: false,
          domainWhitelist: ["www.example.test"],
          pathBlacklist: ["/admin"],
        }),
      }),
    );

    const sharing = await service.execute(
      context,
      "settings.sharing.update",
      { siteId: "site-1", publicSlug: "public-example" },
      {},
    );
    expect(sharing).toEqual({
      ok: true,
      value: { publicEnabled: false, publicSlug: null },
    });

    const conflict = await service.execute(
      context,
      "settings.sharing.update",
      { siteId: "site-1", publicEnabled: true, publicSlug: "taken" },
      {},
    );
    expect(conflict).toMatchObject({ ok: true });
    resourceDependencies.ensurePublicSlugAvailable.mockResolvedValueOnce(false);
    await expect(
      service.execute(
        context,
        "settings.sharing.update",
        { siteId: "site-1", publicEnabled: true, publicSlug: "taken" },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "conflict" } });
  });

  it("executes site and funnel mutations through the resource service without HTTP state", async () => {
    const db = resourceEnv();
    const service = createResourceApplicationService(db.env);
    const context = { teamId: "team-1", siteIds: [] };

    await expect(
      service.execute(
        context,
        "sites.update",
        { siteId: "site-1", name: "Renamed", domain: "renamed.test" },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { id: "site-1" } });
    expect(db.runs).toHaveBeenCalled();

    await expect(
      service.execute(
        context,
        "funnels.update",
        {
          siteId: "site-1",
          funnelId: "funnel-1",
          name: "Onboarding",
          steps: [
            { type: "pageview", value: "/" },
            { type: "event", value: "complete" },
          ],
        },
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { id: "funnel-1", name: "Onboarding" },
    });
    await expect(
      service.execute(
        context,
        "funnels.delete",
        { siteId: "site-1", funnelId: "funnel-1" },
        {},
      ),
    ).resolves.toEqual({ ok: true, value: undefined });

    await expect(
      service.execute(context, "sites.delete", { siteId: "site-1" }, {}),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(resourceDependencies.deleteSiteData).toHaveBeenCalledWith(
      db.env,
      "site-1",
    );
  });

  it("covers resource reads, creates, privacy merge, and execution guards", async () => {
    const db = resourceEnv();
    const service = createResourceApplicationService(db.env);
    const context = { teamId: "team-1", siteIds: [] };

    await expect(
      service.execute(context, "sites.list", {}, {}),
    ).resolves.toMatchObject({
      ok: true,
      value: [{ id: "site-1" }],
    });
    await expect(
      service.execute(
        context,
        "sites.create",
        {
          name: "New site",
          domain: "new.example.test",
          publicEnabled: true,
          publicSlug: "new-site",
        },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { id: "site-1" } });
    await expect(
      service.execute(
        { ...context, siteIds: ["other-site"] },
        "sites.create",
        { name: "Denied", domain: "denied.example.test", publicEnabled: false },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "forbidden" } });

    await expect(
      service.execute(
        context,
        "settings.tracking.get",
        { siteId: "site-1" },
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { trackPageviews: true, allowedDomains: ["example.test"] },
    });
    await expect(
      service.execute(
        context,
        "settings.privacy.get",
        { siteId: "site-1" },
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { anonymizeIp: true, dataRetentionDays: 180 },
    });
    await expect(
      service.execute(
        context,
        "settings.privacy.update",
        { siteId: "site-1", respectDoNotTrack: true, euMode: true },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { respectDoNotTrack: false } });
    await expect(
      service.execute(
        context,
        "settings.trackingScript.get",
        { siteId: "site-1", origin: "https://app.test/" },
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { src: "https://app.test/script.js?siteId=site-1" },
    });

    await expect(
      service.execute(context, "funnels.list", { siteId: "site-1" }, {}),
    ).resolves.toMatchObject({ ok: true, value: [{ id: "funnel-1" }] });
    await expect(
      service.execute(
        context,
        "funnels.create",
        {
          siteId: "site-1",
          name: "New funnel",
          steps: [
            { type: "pageview", value: "/" },
            { type: "event", value: "signup" },
          ],
        },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { name: "New funnel" } });
    await expect(
      service.execute(
        context,
        "funnels.get",
        { siteId: "site-1", funnelId: "funnel-1" },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { id: "funnel-1" } });

    const controller = new AbortController();
    controller.abort();
    await expect(
      service.execute(
        context,
        "sites.get",
        { siteId: "site-1" },
        { signal: controller.signal },
      ),
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });
    await expect(
      service.execute(
        context,
        "sites.get",
        { siteId: "site-1" },
        { deadlineMs: Date.now() - 1 },
      ),
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });
  });

  it("keeps resource transport failures and JSON negotiation outside D1", async () => {
    const unsupportedEncoding = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites/site-1", {
        headers: { "content-encoding": "gzip" },
      }),
      env: {} as never,
      principal: principal(),
      routeId: "sites.get",
      siteId: "site-1",
    });
    expect(unsupportedEncoding.status).toBe(415);

    const unacceptable = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites/site-1", {
        headers: { accept: "text/html" },
      }),
      env: {} as never,
      principal: principal(),
      routeId: "sites.get",
      siteId: "site-1",
    });
    expect(unacceptable.status).toBe(406);

    const compatible = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites/site-1", {
        headers: { accept: "text/html, application/json; q=0.9" },
      }),
      env: envWithSite().env,
      principal: principal(),
      routeId: "sites.get",
      siteId: "site-1",
    });
    expect(compatible.status).toBe(200);

    const malformed = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      env: {} as never,
      principal: principal(["site:write"]),
      routeId: "sites.create",
    });
    expect(malformed.status).toBe(400);
  });

  it("maps missing resources returned by the application service to the public 404", async () => {
    const response = await handlePlannedResourceRoute({
      request: new Request("https://app.test/api/v1/sites/site-1"),
      env: resourceEnv({ site: null, funnel: null }).env,
      principal: principal(),
      routeId: "sites.get",
      siteId: "site-1",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "resource_not_found" },
    });
  });

  it("contains defensive service failures for missing rows, conflicting slugs, and invalid funnels", async () => {
    const context = { teamId: "team-1", siteIds: [] };
    const db = resourceEnv();
    const service = createResourceApplicationService(db.env);

    resourceDependencies.ensurePublicSlugAvailable.mockResolvedValueOnce(false);
    await expect(
      service.execute(
        context,
        "sites.create",
        {
          name: "Conflicting site",
          domain: "conflict.example.test",
          publicEnabled: true,
          publicSlug: "taken",
        },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "conflict" } });

    await expect(
      service.execute(
        context,
        "settings.sharing.get",
        { siteId: "site-1" },
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { publicEnabled: false, publicSlug: null },
    });

    const missing = createResourceApplicationService(
      resourceEnv({ site: null, funnel: null }).env,
    );
    await expect(
      missing.execute(context, "sites.get", { siteId: "site-1" }, {}),
    ).resolves.toEqual({ ok: false, error: { code: "not_found" } });
    await expect(
      missing.execute(
        context,
        "funnels.get",
        { siteId: "site-1", funnelId: "funnel-1" },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "not_found" } });

    const malformedFunnel = createResourceApplicationService(
      resourceEnv({
        site: siteRow,
        funnel: { ...funnelRow, config_json: "not json" },
      }).env,
    );
    await expect(
      malformedFunnel.execute(
        context,
        "funnels.update",
        { siteId: "site-1", funnelId: "funnel-1" } as never,
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });

    const failingDatabase = resourceEnv();
    failingDatabase.prepare.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    await expect(
      createResourceApplicationService(failingDatabase.env).execute(
        context,
        "sites.get",
        { siteId: "site-1" },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });
  });

  it("requires an actual mutable field for every PATCH contract", () => {
    expect(UpdateSiteInputSchema.safeParse({ siteId: "site-1" }).success).toBe(
      false,
    );
    for (const patch of [
      { name: "Renamed" },
      { domain: "renamed.example.test" },
      { publicEnabled: true },
      { publicSlug: "public-example" },
    ]) {
      expect(
        UpdateSiteInputSchema.safeParse({ siteId: "site-1", ...patch }).success,
      ).toBe(true);
    }
    for (const patch of [
      { trackQuery: false },
      { trackHash: false },
      { trackWebVitals: false },
      { autoTrackOutboundLinks: true },
      { trackingStrength: "weak" },
      { allowedDomains: ["example.test"] },
      { excludedPaths: ["/admin"] },
    ]) {
      expect(
        UpdateTrackingSettingsInputSchema.safeParse({
          siteId: "site-1",
          ...patch,
        }).success,
      ).toBe(true);
    }
    expect(
      UpdatePrivacySettingsInputSchema.safeParse({ siteId: "site-1" }).success,
    ).toBe(false);
    expect(
      UpdatePrivacySettingsInputSchema.safeParse({
        siteId: "site-1",
        respectDoNotTrack: false,
      }).success,
    ).toBe(true);
    expect(
      UpdatePrivacySettingsInputSchema.safeParse({
        siteId: "site-1",
        euMode: false,
      }).success,
    ).toBe(true);
    expect(
      UpdateFunnelInputSchema.safeParse({
        siteId: "site-1",
        funnelId: "funnel-1",
      }).success,
    ).toBe(false);
    expect(
      UpdateFunnelInputSchema.safeParse({
        siteId: "site-1",
        funnelId: "funnel-1",
        name: "Renamed",
      }).success,
    ).toBe(true);
  });

  it("fails closed for unauthorized IDs and missing post-mutation reads", async () => {
    const context = { teamId: "team-1", siteIds: ["site-2"] };
    const service = createResourceApplicationService(resourceEnv().env);
    await expect(
      service.execute(context, "sites.get", { siteId: "site-1" }, {}),
    ).resolves.toEqual({ ok: false, error: { code: "not_found" } });

    resourceDependencies.createSiteWithDefaultSettings.mockResolvedValueOnce(
      "created-site",
    );
    const missingRead = createResourceApplicationService(
      resourceEnv({ site: null, funnel: null }).env,
    );
    await expect(
      missingRead.execute(
        { teamId: "team-1", siteIds: [] },
        "sites.create",
        {
          name: "Created but unreadable",
          domain: "created.example.test",
          publicEnabled: false,
        },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });
  });

  it("preserves explicit false settings and normalizes default settings reads", async () => {
    const db = resourceEnv();
    resourceDependencies.readSiteScriptSettings.mockResolvedValueOnce(null);
    resourceDependencies.upsertSiteScriptSettings.mockResolvedValueOnce({
      ...scriptSettings,
      trackingStrength: "weak",
      ignoreDoNotTrack: false,
      performanceSampleRate: 0,
    });
    const service = createResourceApplicationService(db.env);
    const context = { teamId: "team-1", siteIds: [] };

    await expect(
      service.execute(
        context,
        "settings.tracking.get",
        { siteId: "site-1" },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { trackQuery: true } });
    await expect(
      service.execute(
        context,
        "settings.privacy.update",
        { siteId: "site-1", respectDoNotTrack: false, euMode: false },
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { respectDoNotTrack: true, euMode: true },
    });
    expect(resourceDependencies.upsertSiteScriptSettings).toHaveBeenCalledWith(
      db.env,
      "site-1",
      expect.objectContaining({
        settings: {
          ignoreDoNotTrack: true,
          trackingStrength: "strong",
        },
      }),
    );
  });

  it("covers optional resource mutation fields without widening their contract", async () => {
    const db = resourceEnv();
    const service = createResourceApplicationService(db.env);
    const context = { teamId: "team-1", siteIds: [] };

    await expect(
      service.execute(
        context,
        "sites.create",
        {
          name: "Private site",
          domain: "private.example.test",
          publicEnabled: false,
        },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { id: "site-1" } });
    await expect(
      service.execute(
        context,
        "sites.create",
        {
          name: "Public site",
          domain: "public.example.test",
          publicEnabled: true,
        },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { id: "site-1" } });
    await expect(
      service.execute(
        context,
        "sites.update",
        { siteId: "site-1", publicEnabled: true },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { id: "site-1" } });
    await expect(
      service.execute(
        context,
        "sites.update",
        { siteId: "site-1", publicEnabled: false },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { id: "site-1" } });
    await expect(
      service.execute(
        context,
        "sites.update",
        { siteId: "site-1", name: "Name only" },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { id: "site-1" } });

    for (const trackWebVitals of [true, false]) {
      await expect(
        service.execute(
          context,
          "settings.tracking.update",
          { siteId: "site-1", trackWebVitals },
          {},
        ),
      ).resolves.toMatchObject({ ok: true });
    }
    await expect(
      service.execute(
        context,
        "settings.privacy.update",
        { siteId: "site-1", respectDoNotTrack: true },
        {},
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      service.execute(
        context,
        "settings.privacy.update",
        { siteId: "site-1", euMode: true },
        {},
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      service.execute(
        context,
        "settings.sharing.update",
        { siteId: "site-1", publicEnabled: true },
        {},
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      service.execute(
        context,
        "funnels.update",
        {
          siteId: "site-1",
          funnelId: "funnel-1",
          steps: [
            { type: "pageview", value: "/" },
            { type: "event", value: "signup" },
          ],
        },
        {},
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      service.execute(
        context,
        "funnels.update",
        { siteId: "site-1" } as never,
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "not_found" } });
    await expect(
      createResourceApplicationService(
        resourceEnv({ site: siteRow, funnel: null }).env,
      ).execute(
        context,
        "funnels.get",
        { siteId: "site-1", funnelId: "missing" },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "not_found" } });
  });
});
