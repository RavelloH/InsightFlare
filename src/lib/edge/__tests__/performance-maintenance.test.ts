import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimPerformanceMaintenanceJob,
  type PerformanceMaintenanceLease,
  releasePerformanceMaintenanceJob,
  runPerformanceMaintenance,
} from "@/lib/edge/performance-maintenance";
import type { Env } from "@/lib/edge/types";

interface MockStatement {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function statement(
  input: {
    first?: unknown;
    changes?: number;
    runError?: unknown;
  } = {},
): MockStatement {
  const result: MockStatement = {
    bind: vi.fn(),
    first: vi.fn(),
    run: vi.fn(),
  };
  result.bind.mockReturnValue(result);
  result.first.mockResolvedValue(input.first ?? null);
  if ("runError" in input) {
    result.run.mockRejectedValue(input.runError);
  } else {
    result.run.mockResolvedValue({ meta: { changes: input.changes ?? 0 } });
  }
  return result;
}

function mockEnv(statements: MockStatement[]): {
  env: Env;
  prepare: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const prepare = vi.fn(() => {
    const result = statements[index++];
    if (!result) throw new Error("unexpected DB statement");
    return result;
  });
  return {
    env: { DB: { prepare } } as unknown as Env,
    prepare,
  };
}

const lease: PerformanceMaintenanceLease = {
  jobKey: "foundation-health",
  owner: "worker-a",
  token: "lease-token-a",
  revision: 4,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("performance maintenance lease", () => {
  it("claims an expired job with a token and revision fence", async () => {
    const insert = statement();
    const update = statement({ changes: 1 });
    const read = statement({ first: { revision: 9 } });
    const { env, prepare } = mockEnv([insert, update, read]);

    vi.spyOn(crypto, "randomUUID").mockReturnValue("token-a" as never);

    const result = await claimPerformanceMaintenanceJob(
      env,
      "foundation-health",
      "worker-a",
      1_000,
    );

    expect(result).toEqual({
      jobKey: "foundation-health",
      owner: "worker-a",
      token: "token-a",
      revision: 9,
    });
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(update.bind).toHaveBeenCalledWith(
      "worker-a",
      "token-a",
      91_000,
      "foundation-health",
      1_000,
    );
    expect(
      prepare.mock.calls.map(([sql]) => String(sql)).join("\n"),
    ).not.toMatch(/scheduled_task_|analytics/i);
  });

  it("does not read a lease revision when another owner holds the job", async () => {
    const insert = statement();
    const update = statement({ changes: 0 });
    const { env, prepare } = mockEnv([insert, update]);

    await expect(
      claimPerformanceMaintenanceJob(
        env,
        "foundation-health",
        "worker-b",
        2_000,
      ),
    ).resolves.toBeNull();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("fences release with owner, token, and revision", async () => {
    const staleUpdate = statement({ changes: 0 });
    const stale = mockEnv([staleUpdate]);
    await expect(
      releasePerformanceMaintenanceJob(stale.env, lease),
    ).resolves.toBe(false);
    expect(staleUpdate.bind).toHaveBeenCalledWith(
      "foundation-health",
      "worker-a",
      "lease-token-a",
      4,
    );

    const releasedUpdate = statement({ changes: 1 });
    const released = mockEnv([releasedUpdate]);
    await expect(
      releasePerformanceMaintenanceJob(released.env, lease),
    ).resolves.toBe(true);
    expect(String(released.prepare.mock.calls[0][0])).toMatch(
      /performance_maintenance_jobs/,
    );
    expect(String(released.prepare.mock.calls[0][0])).toMatch(/revision=\?/);
  });

  it("swallows claim failures so cron can continue existing tasks", async () => {
    const { env } = mockEnv([
      statement({ runError: new Error("missing table") }),
    ]);
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    await expect(runPerformanceMaintenance(env)).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('"event":"performance_maintenance_claim_failed"'),
    );
  });

  it("swallows release failures after a successful claim", async () => {
    const insert = statement();
    const claim = statement({ changes: 1 });
    const read = statement({ first: { revision: 2 } });
    const release = statement({ runError: new Error("lease update failed") });
    const { env } = mockEnv([insert, claim, read, release]);
    vi.spyOn(crypto, "randomUUID").mockReturnValue("token-b" as never);
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    await expect(runPerformanceMaintenance(env)).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        '"event":"performance_maintenance_release_failed"',
      ),
    );
  });
});
