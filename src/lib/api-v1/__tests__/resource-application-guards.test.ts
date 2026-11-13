import { beforeEach, describe, expect, it, vi } from "vitest";

import { createResourceApplicationService } from "@/lib/api-v1/resources/application-service";
import type * as SitesHandler from "@/lib/edge/admin/sites/handler";
import {
  type FunnelConfigV2,
  FunnelConfigValidationError,
} from "@/lib/edge/analytics/contract";
import type * as GoalConfig from "@/lib/edge/analytics/contract/goal-config";
import { encodePageCursor, paginationBinding } from "@/lib/pagination";

const hoisted = vi.hoisted(() => ({
  ensurePublicSlugAvailable: vi.fn(),
  encodeGoalConfigFailure: null as null | Error,
}));

vi.mock("@/lib/edge/admin/sites/handler", async (importOriginal) => {
  const actual = await importOriginal<typeof SitesHandler>();
  return {
    ...actual,
    ensurePublicSlugAvailable: hoisted.ensurePublicSlugAvailable,
  };
});
vi.mock("@/lib/edge/analytics/contract/goal-config", async (importOriginal) => {
  const actual = await importOriginal<typeof GoalConfig>();
  return {
    ...actual,
    encodeGoalConfig: (...args: Parameters<typeof actual.encodeGoalConfig>) => {
      if (hoisted.encodeGoalConfigFailure) {
        throw hoisted.encodeGoalConfigFailure;
      }
      return actual.encodeGoalConfig(...args);
    },
  };
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
const goalRow = {
  id: "goal-1",
  site_id: "site-1",
  name: "Purchase",
  config_json: JSON.stringify({
    filterDslVersion: 1,
    filterDsl: 'event.name eq "purchase"',
  }),
  config_version: 1,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_001,
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

interface Rows {
  site: Record<string, unknown> | null;
  definition: Record<string, unknown> | null;
}

function makeEnv(rows: Rows, withSecret = true) {
  const runs = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: vi
        .fn()
        .mockResolvedValue(
          sql.includes("analysis_definitions") ? rows.definition : rows.site,
        ),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: runs,
    })),
  }));
  const env = {
    DB: { prepare },
    ...(withSecret ? { MAIN_SECRET: "guard-test-secret" } : {}),
  };
  return { env: env as never, runs };
}

const context = { teamId: "team-1", siteIds: [] as string[] };
const run = (
  rows: Rows,
  operation: string,
  input: unknown,
  options: {
    withSecret?: boolean;
    ctx?: typeof context;
    validateFunnelConfigForStorage?: (config: FunnelConfigV2) => void;
  } = {},
) => {
  const db = makeEnv(rows, options.withSecret);
  const service = createResourceApplicationService(db.env, {
    validateFunnelConfigForStorage: options.validateFunnelConfigForStorage,
  });
  return {
    db,
    result: (service.execute as (...args: unknown[]) => Promise<unknown>)(
      options.ctx ?? context,
      operation,
      input,
      {},
    ),
  };
};
const page = (cursor: string | null) => ({ limit: 10, cursor });

async function forgedCursor(
  operation: "sites" | "funnels" | "goals",
  key: unknown,
) {
  const binding = await paginationBinding([
    "api-v1-resource-pagination-v1",
    operation,
    "team-1",
    [],
    operation === "sites" ? null : "site-1",
  ]);
  return encodePageCursor({ MAIN_SECRET: "guard-test-secret" }, binding, key);
}

beforeEach(() => {
  hoisted.ensurePublicSlugAvailable.mockReset().mockResolvedValue(true);
  hoisted.encodeGoalConfigFailure = null;
});

describe("API v1 resource application cursor guards", () => {
  it.each([
    ["sites", "sites.list", { page: undefined }],
    ["funnels", "funnels.list", { siteId: "site-1" }],
    ["goals", "goals.list", { siteId: "site-1" }],
  ] as const)(
    "rejects malformed %s page keys as invalid_cursor",
    async (kind, operation, base) => {
      for (const key of [
        [1, 2],
        "text",
        { createdAt: 1 },
        { createdAt: -5, id: "x" },
        { createdAt: 1.5, id: "x" },
        { createdAt: 1, id: "" },
      ]) {
        const cursor = await forgedCursor(kind, key);
        const { result } = run({ site: siteRow, definition: null }, operation, {
          ...base,
          page: page(cursor),
        });
        await expect(result).resolves.toEqual({
          ok: false,
          error: { code: "invalid_cursor" },
        });
      }
    },
  );

  it.each([
    ["sites.list", { page: page("anything") }],
    ["funnels.list", { siteId: "site-1", page: page("anything") }],
    ["goals.list", { siteId: "site-1", page: page("anything") }],
  ])(
    "reports %s as an internal error when cursor signing is unavailable",
    async (operation, input) => {
      const { result } = run(
        { site: siteRow, definition: null },
        operation,
        input,
        { withSecret: false },
      );
      await expect(result).resolves.toEqual({
        ok: false,
        error: { code: "internal_error" },
      });
    },
  );
});

describe("API v1 resource application site guards", () => {
  it("hides sites outside the caller's allowed site list", async () => {
    const { result, db } = run(
      { site: siteRow, definition: goalRow },
      "goals.list",
      { siteId: "site-1", page: page(null) },
      { ctx: { teamId: "team-1", siteIds: ["other-site"] } },
    );
    await expect(result).resolves.toEqual({
      ok: false,
      error: { code: "not_found" },
    });
    expect(db.runs).not.toHaveBeenCalled();
  });

  it("returns not_found for goals.list and goals.create on a missing site", async () => {
    await expect(
      run({ site: null, definition: null }, "goals.list", {
        siteId: "site-1",
        page: page(null),
      }).result,
    ).resolves.toEqual({ ok: false, error: { code: "not_found" } });
    await expect(
      run({ site: null, definition: null }, "goals.create", {
        siteId: "site-1",
        name: "G",
        filterDslVersion: 1,
        filterDsl: 'event.name eq "x"',
      }).result,
    ).resolves.toEqual({ ok: false, error: { code: "not_found" } });
  });

  it("fails closed when a persisted row has no id", async () => {
    const { result } = run(
      { site: { ...siteRow, id: null }, definition: null },
      "sites.get",
      { siteId: "site-1" },
    );
    await expect(result).resolves.toEqual({
      ok: false,
      error: { code: "internal_error" },
    });
  });

  it("returns a conflict when the requested public slug is taken", async () => {
    hoisted.ensurePublicSlugAvailable.mockResolvedValue(false);
    const { result, db } = run(
      { site: siteRow, definition: null },
      "sites.update",
      { siteId: "site-1", publicEnabled: true, publicSlug: "taken" },
    );
    await expect(result).resolves.toEqual({
      ok: false,
      error: { code: "conflict" },
    });
    expect(hoisted.ensurePublicSlugAvailable).toHaveBeenCalledWith(
      expect.anything(),
      "taken",
      "site-1",
    );
    expect(db.runs).not.toHaveBeenCalled();
  });
});

describe("API v1 Goal resource guards", () => {
  it("rejects an invalid Goal DSL on create without writing", async () => {
    const { result, db } = run(
      { site: siteRow, definition: null },
      "goals.create",
      {
        siteId: "site-1",
        name: "Bad",
        filterDslVersion: 1,
        filterDsl: "not valid",
      },
    );
    await expect(result).resolves.toEqual({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(db.runs).not.toHaveBeenCalled();
  });

  it("does not swallow unexpected Goal encoding failures", async () => {
    hoisted.encodeGoalConfigFailure = new Error("encoder exploded");
    const create = run({ site: siteRow, definition: null }, "goals.create", {
      siteId: "site-1",
      name: "Bad",
      filterDslVersion: 1,
      filterDsl: 'event.name eq "x"',
    });
    await expect(create.result).resolves.toEqual({
      ok: false,
      error: { code: "internal_error" },
    });
    const update = run({ site: siteRow, definition: goalRow }, "goals.update", {
      siteId: "site-1",
      goalId: "goal-1",
      filterDsl: 'event.name eq "y"',
    });
    await expect(update.result).resolves.toEqual({
      ok: false,
      error: { code: "internal_error" },
    });
    expect(update.db.runs).not.toHaveBeenCalled();
  });

  it("returns not_found for a missing or absent goal id", async () => {
    await expect(
      run({ site: siteRow, definition: goalRow }, "goals.get", {
        siteId: "site-1",
      }).result,
    ).resolves.toEqual({ ok: false, error: { code: "not_found" } });
    await expect(
      run({ site: siteRow, definition: null }, "goals.delete", {
        siteId: "site-1",
        goalId: "missing",
      }).result,
    ).resolves.toEqual({ ok: false, error: { code: "not_found" } });
  });

  it("fails closed when a persisted Goal row has no id", async () => {
    await expect(
      run(
        { site: siteRow, definition: { ...goalRow, id: null } },
        "goals.get",
        { siteId: "site-1", goalId: "goal-1" },
      ).result,
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });
  });
});

describe("API v1 Funnel resource storage validation", () => {
  const createInput = {
    siteId: "site-1",
    name: "Signup",
    filterDslVersion: 2 as const,
    progressionScope: "session" as const,
    conversionWindowMs: 60_000,
    steps: [
      { type: "pageview" as const, value: "/a" },
      { type: "event" as const, value: "b" },
    ],
  };

  it("maps storage validation failures to invalid_input on create and update", async () => {
    const validate = vi.fn(() => {
      throw new FunnelConfigValidationError("funnel_invalid");
    });
    const create = run(
      { site: siteRow, definition: null },
      "funnels.create",
      createInput,
      { validateFunnelConfigForStorage: validate },
    );
    await expect(create.result).resolves.toEqual({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({
        progressionScope: "session",
        conversionWindowMs: 60_000,
      }),
    );
    expect(create.db.runs).not.toHaveBeenCalled();

    const update = run(
      { site: siteRow, definition: funnelRow },
      "funnels.update",
      { siteId: "site-1", funnelId: "funnel-1", name: "Renamed" },
      { validateFunnelConfigForStorage: validate },
    );
    await expect(update.result).resolves.toEqual({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(update.db.runs).not.toHaveBeenCalled();
  });

  it("does not map unexpected validator failures to invalid_input", async () => {
    const validate = vi.fn(() => {
      throw new Error("validator crashed");
    });
    await expect(
      run({ site: siteRow, definition: null }, "funnels.create", createInput, {
        validateFunnelConfigForStorage: validate,
      }).result,
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });
    await expect(
      run(
        { site: siteRow, definition: funnelRow },
        "funnels.update",
        { siteId: "site-1", funnelId: "funnel-1", name: "Renamed" },
        { validateFunnelConfigForStorage: validate },
      ).result,
    ).resolves.toEqual({ ok: false, error: { code: "internal_error" } });
  });
});
