#!/usr/bin/env tsx

import process from "node:process";

import {
  type CommonOptions,
  createRuntime,
  localCli,
  parseCommonOptions,
  type StageResult,
  targetEnv,
} from "./shared/deploy-runtime";
import { ROOT_DIR } from "./shared/paths";

function buildArgs(options: CommonOptions): string[] {
  return ["run", `build:${options.target}`];
}

function wranglerDevArgs(options: CommonOptions): string[] {
  const config =
    options.target === "demo" ? "wrangler.demo.toml" : options.config;
  const args = ["dev", "--config", config];
  if (options.envName) {
    args.push("--env", options.envName);
  }
  return args;
}

async function runBuild(options: CommonOptions): Promise<void> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  await runtime.runCommand(
    command,
    buildArgs(options),
    targetEnv(options.target),
  );
}

async function runWranglerDev(options: CommonOptions): Promise<void> {
  await runtime.runCommand(
    process.execPath,
    [
      localCli(ROOT_DIR, "wrangler", "bin/wrangler.js"),
      ...wranglerDevArgs(options),
    ],
    targetEnv(options.target),
  );
}

const runtime = createRuntime("preview", "Preview");

async function main(): Promise<void> {
  const options = parseCommonOptions(process.argv.slice(2));
  const startedAt = Date.now();
  const stages: StageResult[] = [];

  if (options.target === "cf") {
    throw new Error("preview does not support target=cf.");
  }

  runtime.logHeader(options);
  runtime.assertEnvironment(options);

  stages.push(
    await runtime.runStage(1, 2, "Building preview artifacts", () =>
      runBuild(options),
    ),
  );
  stages.push(
    await runtime.runStage(2, 2, "Starting Wrangler preview", () =>
      runWranglerDev(options),
    ),
  );
  runtime.logSummary(stages, startedAt);
}

main().catch((error: unknown) => {
  runtime.rlog.log();
  runtime.rlog.error("InsightFlare preview failed");
  runtime.rlog.error(error instanceof Error ? error.message : String(error));
  runtime.rlog.error(`Full log: ${runtime.logFilePath}`);
  process.exitCode = 1;
});
