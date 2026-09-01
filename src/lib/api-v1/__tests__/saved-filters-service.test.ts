import { describe, expect, it, vi } from "vitest";

import { createSavedFilterApplicationService } from "@/lib/api-v1/saved-filters-service";

function database(rows: readonly Record<string, unknown>[]) {
  const all = vi.fn().mockResolvedValue({ results: rows });
  const first = vi.fn().mockResolvedValue(rows[0] ?? null);
  const bind = vi.fn().mockReturnValue({ all, first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { DB: { prepare }, prepare, bind, all, first };
}

const row = (
  id: string,
  updatedAt: number,
  scopePreference: "auto" | "event" | "session" | "visitor" = "auto",
) => ({
  id,
  name: `Filter ${id}`,
  description: "Team filter",
  scopePreference,
  filterDsl: 'geo.country eq "CN"',
  filterDslVersion: 1,
  createdAt: updatedAt - 10,
  updatedAt,
});

function base64Url(value: string) {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function signedCursorPayload(value: string) {
  const payload = base64Url(value);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("cursor-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  return `${payload}.${btoa(String.fromCharCode(...signature))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
}

describe("API v1 saved-filter application service", () => {
  it("returns only safe team-visible definition fields", async () => {
    const fake = database([row("filter-1", 20, "event")]);
    const service = createSavedFilterApplicationService(
      fake as never,
      "cursor-secret",
    );

    const result = await service.execute(
      { teamId: "team-1", siteIds: [] },
      "savedFilters.get",
      { siteId: "site-1", id: "filter-1" },
      {},
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: "filter-1",
        visibility: "team",
        scopePreference: "event",
        filter: { version: 1 },
      },
    });
    expect(result.ok && "ownerUserId" in result.value).toBe(false);
    expect(result.ok && "filterDsl" in result.value).toBe(false);
    expect(fake.bind).toHaveBeenCalledWith("site-1", "filter-1", "team-1");
  });

  it("migrates a missing scope preference to Auto", async () => {
    const fake = database([{ ...row("legacy", 20), scopePreference: null }]);
    const service = createSavedFilterApplicationService(
      fake as never,
      "cursor-secret",
    );

    await expect(
      service.execute(
        { teamId: "team-1", siteIds: [] },
        "savedFilters.get",
        { siteId: "site-1", id: "legacy" },
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { id: "legacy", scopePreference: "auto" },
    });
  });

  it("uses a signed, site/team-bound keyset cursor", async () => {
    const fake = database([row("filter-1", 20), row("filter-2", 10)]);
    const service = createSavedFilterApplicationService(
      fake as never,
      "cursor-secret",
    );

    const first = await service.execute(
      { teamId: "team-1", siteIds: [] },
      "savedFilters.list",
      { siteId: "site-1", limit: 1, cursor: null },
      {},
    );
    expect(first).toMatchObject({
      ok: true,
      value: { page: { hasMore: true, limit: 1 } },
    });
    const cursor = first.ok ? first.value.page.nextCursor : null;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

    fake.all.mockResolvedValue({ results: [row("filter-2", 10)] });
    const second = await service.execute(
      { teamId: "team-1", siteIds: [] },
      "savedFilters.list",
      { siteId: "site-1", limit: 1, cursor },
      {},
    );
    expect(second).toMatchObject({
      ok: true,
      value: { items: [{ id: "filter-2" }] },
    });

    const tampered = `${cursor!.slice(0, -1)}x`;
    await expect(
      service.execute(
        { teamId: "team-1", siteIds: [] },
        "savedFilters.list",
        { siteId: "site-1", limit: 1, cursor: tampered },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "invalid_cursor" } });
  });

  it("returns not-found semantics for a site outside the API key site set", async () => {
    const fake = database([row("filter-1", 20)]);
    const service = createSavedFilterApplicationService(
      fake as never,
      "cursor-secret",
    );

    const result = await service.execute(
      { teamId: "team-1", siteIds: ["site-2"] },
      "savedFilters.get",
      { siteId: "site-1", id: "filter-1" },
      {},
    );

    expect(result).toEqual({ ok: false, error: { code: "not_found" } });
    expect(fake.prepare).not.toHaveBeenCalled();
  });

  it("fails the entire page when a visible definition is corrupt", async () => {
    const fake = database([
      { ...row("broken", 20), filterDsl: 'geo.country invalid "CN"' },
    ]);
    const service = createSavedFilterApplicationService(
      fake as never,
      "cursor-secret",
    );

    const result = await service.execute(
      { teamId: "team-1", siteIds: [] },
      "savedFilters.list",
      { siteId: "site-1", limit: 10, cursor: null },
      {},
    );

    expect(result).toEqual({ ok: false, error: { code: "internal_error" } });
  });

  it("fails closed for cancellation, deadline, empty site scope, and database errors", async () => {
    const fake = database([row("filter-1", 20)]);
    fake.first.mockRejectedValue(new Error("db down"));
    const service = createSavedFilterApplicationService(
      fake as never,
      "cursor-secret",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.execute(
        { teamId: "team-1", siteIds: [] },
        "savedFilters.get",
        { siteId: "site-1", id: "filter-1" },
        { signal: controller.signal },
      ),
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });
    await expect(
      service.execute(
        { teamId: "team-1", siteIds: [] },
        "savedFilters.list",
        { siteId: "site-1", limit: 10, cursor: null },
        { deadlineMs: 0 },
      ),
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });
    await expect(
      service.execute(
        { teamId: "team-1", siteIds: ["site-2"] },
        "savedFilters.list",
        { siteId: "site-1", limit: 10, cursor: null },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { items: [] } });
    await expect(
      service.execute(
        { teamId: "team-1", siteIds: [] },
        "savedFilters.get",
        { siteId: "site-1", id: "filter-1" },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });
  });

  it("rejects cursors bound to another site or team and handles missing definitions", async () => {
    const fake = database([row("filter-1", 20), row("filter-2", 10)]);
    const service = createSavedFilterApplicationService(
      fake as never,
      "cursor-secret",
    );
    const first = await service.execute(
      { teamId: "team-1", siteIds: [] },
      "savedFilters.list",
      { siteId: "site-1", limit: 1, cursor: null },
      {},
    );
    const cursor = first.ok ? first.value.page.nextCursor : null;
    expect(cursor).not.toBeNull();
    await expect(
      service.execute(
        { teamId: "team-2", siteIds: [] },
        "savedFilters.list",
        { siteId: "site-1", limit: 1, cursor },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "invalid_cursor" } });
    await expect(
      service.execute(
        { teamId: "team-1", siteIds: [] },
        "savedFilters.list",
        { siteId: "site-2", limit: 1, cursor },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "invalid_cursor" } });

    fake.first.mockResolvedValue(null);
    await expect(
      service.execute(
        { teamId: "team-1", siteIds: [] },
        "savedFilters.get",
        { siteId: "site-1", id: "missing" },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "not_found" } });
  });

  it("fails closed for malformed cursors and list failures", async () => {
    const fake = database([row("filter-1", 20)]);
    const service = createSavedFilterApplicationService(
      fake as never,
      "cursor-secret",
    );
    for (const cursor of ["no-signature", "..", "%%%.$$$", "a.b.c", "YQ.Yg"]) {
      await expect(
        service.execute(
          { teamId: "team-1", siteIds: [] },
          "savedFilters.list",
          { siteId: "site-1", limit: 1, cursor },
          {},
        ),
      ).resolves.toEqual({ ok: false, error: { code: "invalid_cursor" } });
    }
    fake.all.mockRejectedValue(new Error("database unavailable"));
    await expect(
      service.execute(
        { teamId: "team-1", siteIds: [] },
        "savedFilters.list",
        { siteId: "site-1", limit: 1, cursor: null },
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });
  });

  it("rejects oversized, truncated, non-JSON, and structurally invalid signed cursors", async () => {
    const fake = database([row("filter-1", 20)]);
    const service = createSavedFilterApplicationService(
      fake as never,
      "cursor-secret",
    );
    const valid = await signedCursorPayload(
      JSON.stringify({
        version: 1,
        siteId: "site-1",
        teamId: "team-1",
        updatedAt: 1,
        id: "filter-1",
      }),
    );
    const cursors = [
      "a".repeat(12_289),
      `${valid.split(".")[0]}.${valid.split(".")[1]!.slice(0, -2)}`,
      await signedCursorPayload("not-json"),
      await signedCursorPayload(JSON.stringify({ version: 1 })),
    ];
    for (const cursor of cursors) {
      await expect(
        service.execute(
          { teamId: "team-1", siteIds: [] },
          "savedFilters.list",
          { siteId: "site-1", limit: 1, cursor },
          {},
        ),
      ).resolves.toEqual({ ok: false, error: { code: "invalid_cursor" } });
    }
  });
});
