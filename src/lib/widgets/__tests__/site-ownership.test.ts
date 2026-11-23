// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@/lib/db";
import type { Env } from "@/lib/edge/types";
import { widgetSiteBelongsToTeam } from "@/lib/widgets/store";

const mocks = vi.hoisted(() => ({
  first: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    createD1DatabaseClient: vi.fn(() => ({ first: mocks.first })),
  };
});

describe("widget site ownership verified against D1 team membership", () => {
  const env = { DB: {} } as Env;

  beforeEach(() => {
    mocks.first.mockReset();
  });

  it("accepts only an exact site match returned by the team-scoped SQL query", async () => {
    mocks.first.mockResolvedValueOnce({ siteId: "site-a" });

    expect(await widgetSiteBelongsToTeam(env, "team-a", "site-a")).toBe(true);
    expect(mocks.first).toHaveBeenCalledTimes(1);

    const compiled = mocks.first.mock.calls[0]?.[0] as {
      sql?: string;
      bindings?: unknown[];
    };
    expect(compiled.sql).toContain("JOIN");
    expect(JSON.stringify(compiled)).toContain("team-a");
    expect(JSON.stringify(compiled)).toContain("site-a");
  });

  it("refuses missing sites even when a query succeeds", async () => {
    mocks.first.mockResolvedValueOnce(null);
    expect(await widgetSiteBelongsToTeam(env, "team-a", "missing")).toBe(false);
  });

  it("refuses a row for a different site rather than treating any result as authorization", async () => {
    mocks.first.mockResolvedValueOnce({ siteId: "another-site" });
    expect(await widgetSiteBelongsToTeam(env, "team-a", "site-a")).toBe(false);
  });

  it("fails closed when the tenant ownership query cannot reach D1", async () => {
    mocks.first.mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(
      widgetSiteBelongsToTeam(env, "team-a", "site-a"),
    ).rejects.toThrow("D1 unavailable");
  });
});
