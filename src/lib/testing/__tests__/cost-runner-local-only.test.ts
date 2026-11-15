// @vitest-environment node
import { spawnSync } from "node:child_process";
import process from "node:process";

import { expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

it("keeps the cost runner local even with inherited remote credentials and filters", async () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const names = [
    "CLOUDFLARE_API_TOKEN",
    "C01_ACCOUNT_ID",
    "C01_D1_DATABASE_ID",
    "C01_ANALYSIS_REMOTE",
    "C01_NEXT_REMOTE",
    "C01_DURATION_REMOTE",
  ];
  for (const name of names) vi.stubEnv(name, "fake-local-cost-test");
  vi.stubEnv("C01_VISITS", "24");
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  });
  try {
    process.argv = ["node", "scripts/test-cost.ts", "remote-d1-cost"];
    await import("@/../scripts/test-cost");
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
    expect(args).toEqual([
      "vitest",
      "run",
      "miniflare",
      "--testTimeout=600000",
      "remote-d1-cost",
    ]);
    const environment = options?.env;
    expect(environment?.["INSIGHTFLARE_COST_TESTS"]).toBe("1");
    expect(environment?.["C01_VISITS"]).toBe("24");
    for (const name of Object.keys(environment ?? {}))
      expect(names).not.toContain(name.toUpperCase());
    for (const name of names)
      expect(process.env[name]).toBe("fake-local-cost-test");
    expect(process.exitCode).toBe(0);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    info.mockRestore();
    vi.mocked(spawnSync).mockReset();
  }
});
