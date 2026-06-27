#!/usr/bin/env tsx

import process from "node:process";

import { rlog, runCli } from "./check-runner/cli";

runCli().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  rlog.error(message);
  process.exitCode = 1;
});
