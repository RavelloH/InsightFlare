import { describe, expect, it, vi } from "vitest";

import {
  AnalysisDefinitionIntegrityError,
  AnalysisDefinitionReadCancelledError,
  createAnalysisDefinitionReader,
} from "@/lib/api-v1/analysis-definition-reader";

function database(row: unknown) {
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { db: { prepare }, prepare, bind, first };
}

describe("API v1 analysis definition reader", () => {
  it("reads only a team-visible definition scoped to the API key's team", async () => {
    const fake = database({
      filterDsl: 'geo.country eq "CN"',
      filterDslVersion: 1,
    });
    const reader = createAnalysisDefinitionReader({ DB: fake.db } as never, {
      teamId: "team-1",
    });

    const result = await reader.resolveTeamVisibleSavedFilter({
      siteId: "site-1",
      id: "filter-1",
    });

    expect(fake.prepare).toHaveBeenCalledWith(
      expect.stringContaining("INNER JOIN sites s ON s.id = sf.site_id"),
    );
    expect(fake.prepare).toHaveBeenCalledWith(
      expect.stringContaining("sf.visibility = 'team'"),
    );
    expect(fake.bind).toHaveBeenCalledWith("site-1", "filter-1", "team-1");
    expect(result).toMatchObject({
      document: {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "geo.country" },
        },
      },
    });
    expect(result?.fingerprint).toMatch(/^saved-filter-v1:1:[a-f0-9]{64}$/);
    expect(result?.fingerprint).not.toContain("CN");
  });

  it("uses not-found semantics for absent, private, or cross-team rows", async () => {
    const fake = database(null);
    const reader = createAnalysisDefinitionReader({ DB: fake.db } as never, {
      teamId: "team-1",
    });

    await expect(
      reader.resolveTeamVisibleSavedFilter({ siteId: "site-1", id: "hidden" }),
    ).resolves.toBeNull();
  });

  it("fails closed when a persisted definition is malformed", async () => {
    const fake = database({
      filterDsl: 'geo.country invalid "CN"',
      filterDslVersion: 1,
    });
    const reader = createAnalysisDefinitionReader({ DB: fake.db } as never, {
      teamId: "team-1",
    });

    await expect(
      reader.resolveTeamVisibleSavedFilter({ siteId: "site-1", id: "broken" }),
    ).rejects.toBeInstanceOf(AnalysisDefinitionIntegrityError);
  });

  it("does not read D1 after the request has been cancelled", async () => {
    const fake = database(null);
    const reader = createAnalysisDefinitionReader({ DB: fake.db } as never, {
      teamId: "team-1",
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      reader.resolveTeamVisibleSavedFilter({
        siteId: "site-1",
        id: "filter-1",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AnalysisDefinitionReadCancelledError);
    expect(fake.prepare).not.toHaveBeenCalled();
  });

  it("does not return a definition when cancellation races the D1 read", async () => {
    const fake = database({
      filterDsl: 'geo.country eq "CN"',
      filterDslVersion: 1,
    });
    const controller = new AbortController();
    fake.first.mockImplementationOnce(async () => {
      controller.abort();
      return null;
    });
    const reader = createAnalysisDefinitionReader({ DB: fake.db } as never, {
      teamId: "team-1",
    });

    await expect(
      reader.resolveTeamVisibleSavedFilter({
        siteId: "site-1",
        id: "filter-1",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AnalysisDefinitionReadCancelledError);
  });
});
