#!/usr/bin/env tsx

// Runs local Miniflare D1 cost measurements. Remote baselines are excluded.
// Usage: pnpm run test:cost [vitest args]
import { spawnSync } from "node:child_process";
import process from "node:process";

// Do not let credentials or a previous remote opt-in turn this local command
// into a paid remote matrix, including when extra Vitest filters are supplied.
const remoteEnvironmentNames = new Set([
  "CLOUDFLARE_API_TOKEN",
  "C01_ACCOUNT_ID",
  "C01_D1_DATABASE_ID",
  "C01_ANALYSIS_REMOTE",
  "C01_NEXT_REMOTE",
  "C01_DURATION_REMOTE",
]);
const localEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !remoteEnvironmentNames.has(name.toUpperCase()),
  ),
);
console.info("Cost tests use local Miniflare; remote D1 is disabled.");
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
    env: { ...localEnvironment, INSIGHTFLARE_COST_TESTS: "1" },
  },
);

process.exitCode = result.status ?? 1;
