#!/usr/bin/env tsx

// Runs the Miniflare D1 cost measurements that the default test run excludes.
// Usage: pnpm run test:cost [vitest args]
import { spawnSync } from "node:child_process";
import process from "node:process";

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "vitest",
    "run",
    "miniflare",
    "--testTimeout=600000",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, INSIGHTFLARE_COST_TESTS: "1" },
  },
);

process.exitCode = result.status ?? 1;
