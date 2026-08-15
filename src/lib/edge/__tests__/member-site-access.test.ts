import { describe, expect, it, vi } from "vitest";

import { assertSitesBelongToTeam } from "@/lib/edge/member-site-access";
import type { Env } from "@/lib/edge/types";

function teamSiteEnv() {
  const bindings: unknown[][] = [];
  const db = {
    prepare: vi.fn(() => {
      let bound: unknown[] = [];
      const statement = {
        bind: vi.fn((...values: unknown[]) => {
          bound = values;
          bindings.push(values);
          return statement;
        }),
        all: vi.fn(async () => ({
          results: bound.slice(1).map((id) => ({ id })),
        })),
      };
      return statement;
    }),
  };
  return { env: { DB: db } as unknown as Env, bindings };
}

describe("assertSitesBelongToTeam", () => {
  it("splits team-scoped site checks before D1 reaches 100 bindings", async () => {
    const siteIds = Array.from({ length: 100 }, (_, index) => `site-${index}`);
    const { env, bindings } = teamSiteEnv();

    await expect(assertSitesBelongToTeam(env, "team-1", siteIds)).resolves.toBe(
      true,
    );
    expect(bindings.map((values) => values.length)).toEqual([100, 2]);
  });

  it("preserves the previous duplicate-id rejection", async () => {
    const { env, bindings } = teamSiteEnv();

    await expect(
      assertSitesBelongToTeam(env, "team-1", ["site-1", "site-1"]),
    ).resolves.toBe(false);
    expect(bindings).toEqual([]);
  });
});
