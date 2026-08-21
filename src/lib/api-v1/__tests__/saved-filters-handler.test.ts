import { describe, expect, it, vi } from "vitest";

import { dispatchApiV1ApplicationRoute } from "@/lib/api-v1/application-dispatcher";
import type { ApiV1ApplicationService } from "@/lib/api-v1/application-registry";
import { handlePlannedSavedFilters } from "@/lib/api-v1/saved-filters-handler";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const principal = (
  overrides: Partial<ApiKeyPrincipal> = {},
): ApiKeyPrincipal => ({
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  scopes: ["analysis:read"],
  siteIds: [],
  status: "active",
  ...overrides,
});

function service(result: unknown) {
  const execute = vi.fn().mockResolvedValue(result);
  return {
    application: { execute } as unknown as ApiV1ApplicationService,
    execute,
  };
}

const env = { DB: {}, MAIN_SECRET: "secret" } as never;

describe("planned saved-filter HTTP adapter", () => {
  it("enforces scope and site access before invoking the application service", async () => {
    const { application, execute } = service({
      ok: true,
      value: { items: [] },
    });
    const request = new Request(
      "https://app.test/api/v1/sites/site-1/saved-filters",
    );

    const missingScope = await handlePlannedSavedFilters(
      request,
      env,
      principal({ scopes: [] }),
      "site-1",
      undefined,
      application,
    );
    expect(missingScope.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();

    const siteDenied = await handlePlannedSavedFilters(
      request,
      env,
      principal({ siteIds: ["site-2"] }),
      "site-1",
      undefined,
      application,
    );
    expect(siteDenied.status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });

  it("maps strict list input and application errors without touching D1 in the adapter", async () => {
    const { application, execute } = service({
      ok: false,
      error: { code: "invalid_cursor" },
    });
    const request = new Request(
      "https://app.test/api/v1/sites/site-1/saved-filters?limit=20&cursor=abc",
    );
    const response = await handlePlannedSavedFilters(
      request,
      env,
      principal(),
      "site-1",
      undefined,
      application,
    );
    expect(response.status).toBe(400);
    expect(execute).toHaveBeenCalledWith(
      { teamId: "team-1", siteIds: [] },
      "savedFilters.list",
      { siteId: "site-1", limit: 20, cursor: "abc" },
      {},
    );

    const unknownQuery = await handlePlannedSavedFilters(
      new Request(
        "https://app.test/api/v1/sites/site-1/saved-filters?owner=user-1",
      ),
      env,
      principal(),
      "site-1",
      undefined,
      application,
    );
    expect(unknownQuery.status).toBe(400);
  });

  it("maps item not-found and rejects non-GET methods", async () => {
    const { application, execute } = service({
      ok: false,
      error: { code: "not_found" },
    });
    const item = await handlePlannedSavedFilters(
      new Request(
        "https://app.test/api/v1/sites/site-1/saved-filters/filter-1",
      ),
      env,
      principal(),
      "site-1",
      "filter-1",
      application,
    );
    expect(item.status).toBe(404);
    expect(execute).toHaveBeenCalledWith(
      { teamId: "team-1", siteIds: [] },
      "savedFilters.get",
      { siteId: "site-1", id: "filter-1" },
      {},
    );

    const mutation = await handlePlannedSavedFilters(
      new Request("https://app.test/api/v1/sites/site-1/saved-filters", {
        method: "POST",
      }),
      env,
      principal(),
      "site-1",
      undefined,
      application,
    );
    expect(mutation.status).toBe(405);
  });

  it("serializes a successful application result", async () => {
    const { application, execute } = service({
      ok: true,
      value: {
        items: [],
        page: { kind: "keyset", limit: 100, nextCursor: null, hasMore: false },
      },
    });
    const response = await handlePlannedSavedFilters(
      new Request("https://app.test/api/v1/sites/site-1/saved-filters"),
      env,
      principal(),
      "site-1",
      undefined,
      application,
    );
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      data: { page: { kind: "keyset" } },
    });
  });

  it("fails closed when a configured application service cannot be created", async () => {
    const response = await dispatchApiV1ApplicationRoute({
      request: new Request(
        "https://app.test/api/v1/sites/site-1/saved-filters",
      ),
      env: { DB: {}, MAIN_SECRET: undefined } as never,
      principal: principal(),
      routeId: "site.saved-filters.list",
      siteId: "site-1",
    });
    expect(response.status).toBe(500);
  });

  it("rejects a malformed application item route before execution", async () => {
    const { application, execute } = service({ ok: true, value: {} });
    const response = await dispatchApiV1ApplicationRoute({
      request: new Request(
        "https://app.test/api/v1/sites/site-1/saved-filters/",
      ),
      env,
      principal: principal(),
      routeId: "site.saved-filters.get",
      siteId: "site-1",
      service: application,
    });
    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an invalid site identifier before a saved-filter item lookup", async () => {
    const { application, execute } = service({ ok: true, value: {} });
    const response = await dispatchApiV1ApplicationRoute({
      request: new Request(
        "https://app.test/api/v1/sites//saved-filters/filter-1",
      ),
      env,
      principal: principal(),
      routeId: "site.saved-filters.get",
      siteId: "",
      savedFilterId: "filter-1",
      service: application,
    });

    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("serializes a successful saved-filter item result", async () => {
    const { application, execute } = service({
      ok: true,
      value: {
        id: "filter-1",
        name: "Production traffic",
        siteId: "site-1",
        fingerprint: "filter-fingerprint",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    const response = await dispatchApiV1ApplicationRoute({
      request: new Request(
        "https://app.test/api/v1/sites/site-1/saved-filters/filter-1",
      ),
      env,
      principal: principal(),
      routeId: "site.saved-filters.get",
      siteId: "site-1",
      savedFilterId: "filter-1",
      service: application,
    });

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      { teamId: "team-1", siteIds: [] },
      "savedFilters.get",
      { siteId: "site-1", id: "filter-1" },
      {},
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { id: "filter-1", name: "Production traffic" },
    });
  });
});
