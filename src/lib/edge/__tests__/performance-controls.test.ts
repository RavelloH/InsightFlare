import { describe, expect, it, vi } from "vitest";

import {
  compareAndSetPerformanceControl,
  readPerformanceControl,
} from "@/lib/edge/performance-controls";
import type { Env } from "@/lib/edge/types";

type Statement = {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
};

function statement(
  options: {
    first?: unknown;
    firstError?: unknown;
    run?: unknown;
    runError?: unknown;
  } = {},
): Statement {
  const result: Statement = {
    bind: vi.fn(),
    first: vi.fn(),
    run: vi.fn(),
  };
  result.bind.mockReturnValue(result);
  if ("firstError" in options)
    result.first.mockRejectedValue(options.firstError);
  else result.first.mockResolvedValue(options.first ?? null);
  if ("runError" in options) result.run.mockRejectedValue(options.runError);
  else result.run.mockResolvedValue(options.run ?? { meta: { changes: 0 } });
  return result;
}

function database(
  statements: Statement[],
  prepareError?: unknown,
): {
  env: Env;
  prepare: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const prepare = vi.fn(() => {
    if (prepareError) throw prepareError;
    const result = statements[index++];
    if (!result) throw new Error("unexpected statement");
    return result;
  });
  return {
    env: { DB: { prepare } } as unknown as Env,
    prepare,
  };
}

const validRow = {
  name: "foundation",
  routeScope: "  foundation  ",
  state: "shadow",
  generation: "  foundation-1  ",
  revision: "2",
  updatedAt: "123.5",
};

describe("performance rollout controls", () => {
  it.each([
    ["disabled", "disabled"],
    ["shadow", "shadow"],
    ["enabled", "enabled"],
  ])(
    "reads the %s state and normalizes persisted values",
    async (state, expected) => {
      const row = { ...validRow, state };
      const read = statement({ first: row });
      const { env: testEnv, prepare } = database([read]);

      await expect(readPerformanceControl(testEnv)).resolves.toEqual({
        name: "foundation",
        routeScope: "foundation",
        state: expected,
        generation: "foundation-1",
        revision: 2,
        updatedAt: 123.5,
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(read.bind).toHaveBeenCalledWith("foundation");
    },
  );

  it("accepts an explicit control name", async () => {
    const read = statement({ first: { ...validRow, name: "checkout" } });
    const { env: testEnv } = database([read]);

    await expect(
      readPerformanceControl(testEnv, "checkout"),
    ).resolves.toMatchObject({
      name: "checkout",
      state: "shadow",
    });
    expect(read.bind).toHaveBeenCalledWith("checkout");
  });

  it.each([
    ["missing row", null],
    ["invalid state", { ...validRow, state: "paused" }],
    ["empty route scope", { ...validRow, routeScope: "   " }],
    ["missing route scope", { ...validRow, routeScope: null }],
    ["empty generation", { ...validRow, generation: "   " }],
    ["missing generation", { ...validRow, generation: undefined }],
    ["non-integer revision", { ...validRow, revision: "1.5" }],
    ["revision below one", { ...validRow, revision: 0 }],
    ["non-finite timestamp", { ...validRow, updatedAt: "not-a-number" }],
  ])("fails closed for %s", async (_label, first) => {
    const read = statement({ first });
    const { env: testEnv } = database([read]);

    await expect(readPerformanceControl(testEnv)).resolves.toBeNull();
  });

  it("fails closed when the database read rejects", async () => {
    const read = statement({ firstError: new Error("database unavailable") });
    const { env: testEnv } = database([read]);

    await expect(readPerformanceControl(testEnv)).resolves.toBeNull();
  });

  it("returns null for a failed compare-and-set write", async () => {
    const update = statement({ run: { meta: { changes: 2 } } });
    const { env: testEnv } = database([update]);

    await expect(
      compareAndSetPerformanceControl(testEnv, {
        name: "foundation",
        revision: 1,
        state: "enabled",
        generation: "foundation-2",
        actorUserId: "admin-1",
        requestId: "request-1",
      }),
    ).resolves.toBeNull();
    expect(update.bind).toHaveBeenCalledWith(
      "enabled",
      "foundation-2",
      "admin-1",
      "request-1",
      "foundation",
      1,
    );
  });

  it("treats missing update metadata as a compare-and-set conflict", async () => {
    const update = statement({ run: {} });
    const { env: testEnv } = database([update]);

    await expect(
      compareAndSetPerformanceControl(testEnv, {
        name: "foundation",
        revision: 1,
        state: "shadow",
        generation: "foundation-2",
        actorUserId: "admin-1",
        requestId: "request-2",
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when the compare-and-set query rejects", async () => {
    const update = statement({ runError: new Error("write failed") });
    const { env: testEnv } = database([update]);

    await expect(
      compareAndSetPerformanceControl(testEnv, {
        name: "foundation",
        revision: 1,
        state: "disabled",
        generation: "foundation-3",
        actorUserId: "admin-1",
        requestId: "request-3",
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when preparing the compare-and-set query rejects", async () => {
    const { env: testEnv, prepare } = database([], new Error("missing table"));

    await expect(
      compareAndSetPerformanceControl(testEnv, {
        name: "foundation",
        revision: 1,
        state: "disabled",
        generation: "foundation-3",
        actorUserId: "admin-1",
        requestId: "request-4",
      }),
    ).resolves.toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
