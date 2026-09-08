import { describe, expect, it, vi } from "vitest";

import { createResourceApplicationService } from "@/lib/api-v1/resource-application-service";

const site = {
  id: "site-1",
  teamId: "team-1",
  name: "Example",
  domain: "example.test",
  publicEnabled: 0,
  publicSlug: null,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_001,
};
const goal = {
  id: "goal-1",
  site_id: "site-1",
  name: "Purchase completed",
  config_json: JSON.stringify({
    filterDslVersion: 1,
    filterDsl: '  event.name eq "purchase"  ',
  }),
  config_version: 1,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_001,
};

function goalEnv() {
  const runs = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((..._bindings: unknown[]) => ({
      first: vi
        .fn()
        .mockResolvedValue(sql.includes("FROM sites") ? site : goal),
      all: vi.fn().mockResolvedValue({
        results: sql.includes("analysis_definitions") ? [goal] : [site],
      }),
      run: runs,
    })),
  }));
  return { env: { DB: { prepare } } as never, prepare, runs };
}

describe("API v1 Goal resource application", () => {
  it("lists/gets and returns semantic fingerprint plus links", async () => {
    const db = goalEnv();
    const service = createResourceApplicationService(db.env);
    const context = { teamId: "team-1", siteIds: [] };

    await expect(
      service.execute(
        context,
        "goals.list",
        { siteId: "site-1", page: { limit: 10, cursor: null } },
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        items: [
          {
            id: "goal-1",
            filterDsl: '  event.name eq "purchase"  ',
            semanticFingerprint: expect.any(String),
            links: {
              summary: expect.stringContaining("analytics/goals/summary"),
              timeseries: expect.stringContaining("analytics/goals/timeseries"),
            },
          },
        ],
      },
    });
    await expect(
      service.execute(
        context,
        "goals.get",
        { siteId: "site-1", goalId: "goal-1" },
        {},
      ),
    ).resolves.toMatchObject({ ok: true, value: { id: "goal-1" } });
  });

  it("validates Goal writes and performs create/update/delete through the resource route", async () => {
    const db = goalEnv();
    const service = createResourceApplicationService(db.env);
    const context = { teamId: "team-1", siteIds: [] };
    const createInput = {
      siteId: "site-1",
      name: "New purchase",
      filterDslVersion: 1 as const,
      filterDsl: 'event.name eq "purchase"',
    };

    await expect(
      service.execute(context, "goals.create", createInput, {}),
    ).resolves.toMatchObject({
      ok: true,
      value: { name: "New purchase", filterDslVersion: 1 },
    });
    await expect(
      service.execute(
        context,
        "goals.update",
        {
          siteId: "site-1",
          goalId: "goal-1",
          filterDsl: 'event.name eq "signup"',
        },
        {},
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { filterDsl: 'event.name eq "signup"' },
    });
    await expect(
      service.execute(
        context,
        "goals.update",
        {
          siteId: "site-1",
          goalId: "goal-1",
          filterDsl: "not valid",
        } as never,
        {},
      ),
    ).resolves.toEqual({ ok: false, error: { code: "invalid_input" } });
    await expect(
      service.execute(
        context,
        "goals.delete",
        { siteId: "site-1", goalId: "goal-1" },
        {},
      ),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(db.runs).toHaveBeenCalled();
  });
});
