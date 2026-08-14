#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  type CommonOptions,
  createRuntime,
  localCli,
  parseCommonOptions,
  resolveConfigPath,
  type StageResult,
  targetEnv,
} from "./shared/deploy-runtime";
import { ROOT_DIR } from "./shared/paths";
import {
  applyAnalyticsEngineDisabledFallback,
  isAnalyticsEngineNotEnabledError,
} from "./wrangler-env-overrides";

function deployArgs(options: CommonOptions, configPath: string): string[] {
  const args = ["deploy", "--config", configPath];
  if (options.envName) {
    args.push("--env", options.envName);
  }
  if (options.dryRun) {
    args.push("--dry-run");
  }
  // Cloudflare's Vite output is already bundled and minified. Passing
  // --minify with its generated no_bundle JSON config only emits a warning.
  if (path.extname(configPath).toLowerCase() !== ".json") {
    args.push("--minify");
  }
  return args;
}

function deployLogText(error: unknown): string {
  const log = fs.existsSync(runtime.logFilePath)
    ? fs.readFileSync(runtime.logFilePath, "utf8")
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return `${message}\n${log}`;
}

function analyticsEngineDisabledConfigPath(configPath: string): string {
  const parsed = path.parse(configPath);
  return path.join(parsed.dir, `${parsed.name}.ae-disabled${parsed.ext}`);
}

function writeAnalyticsEngineDisabledConfig(
  configPath: string,
  envName: string | undefined,
): string {
  const fallbackPath = analyticsEngineDisabledConfigPath(configPath);
  const source = fs.readFileSync(configPath, "utf8");
  if (path.extname(configPath).toLowerCase() === ".json") {
    const parsed = JSON.parse(source) as {
      analytics_engine_datasets?: unknown[];
      vars?: Record<string, string>;
    };
    delete parsed.analytics_engine_datasets;
    parsed.vars = {
      ...parsed.vars,
      INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED: "1",
    };
    fs.writeFileSync(fallbackPath, `${JSON.stringify(parsed, null, 2)}\n`);
    runtime.rlog.info(
      `Analytics Engine disabled fallback config: ${fallbackPath}`,
    );
    return fallbackPath;
  }
  const result = applyAnalyticsEngineDisabledFallback(source, envName);
  fs.writeFileSync(fallbackPath, result.content);
  runtime.rlog.info(
    `Analytics Engine disabled fallback config: ${fallbackPath}`,
  );
  if (result.applied.length > 0) {
    runtime.rlog.info(`Fallback config changes: ${result.applied.join(", ")}`);
  }
  return fallbackPath;
}

async function runWranglerDeploy(
  options: CommonOptions,
  configPath: string,
): Promise<void> {
  await runtime.runCommand(
    process.execPath,
    [
      localCli(ROOT_DIR, "wrangler", "bin/wrangler.js"),
      ...deployArgs(options, configPath),
    ],
    targetEnv(options.target),
  );
}

async function deployWithAnalyticsEngineFallback(
  options: CommonOptions,
): Promise<void> {
  if (options.target === "local") {
    throw new Error(
      "deploy does not support target=local; use publish for releases.",
    );
  }

  const generatedConfig = path.join(
    ROOT_DIR,
    "dist",
    "server",
    "wrangler.json",
  );
  const configPath = fs.existsSync(generatedConfig)
    ? generatedConfig
    : resolveConfigPath(options.config);
  try {
    await runWranglerDeploy(options, configPath);
    return;
  } catch (error) {
    if (!isAnalyticsEngineNotEnabledError(deployLogText(error))) {
      throw error;
    }
    runtime.rlog.info(
      "Analytics Engine is not enabled for this account; retrying without the binding.",
    );
  }

  const fallbackConfigPath = writeAnalyticsEngineDisabledConfig(
    configPath,
    options.envName,
  );
  await runWranglerDeploy(options, fallbackConfigPath);
}

const runtime = createRuntime("deploy", "Deploy");

async function main(): Promise<void> {
  const options = parseCommonOptions(process.argv.slice(2));
  const startedAt = Date.now();
  const stages: StageResult[] = [];

  runtime.logHeader(options);
  runtime.assertEnvironment(options);
  stages.push(
    await runtime.runStage(1, 1, "Deploying Worker", () =>
      deployWithAnalyticsEngineFallback(options),
    ),
  );
  runtime.logSummary(stages, startedAt);
  runtime.rlog.success("InsightFlare deploy completed successfully.");
}

main().catch((error: unknown) => {
  runtime.rlog.log();
  runtime.rlog.error("InsightFlare deploy failed");
  runtime.rlog.error(error instanceof Error ? error.message : String(error));
  runtime.rlog.error(`Full log: ${runtime.logFilePath}`);
  process.exitCode = 1;
});
