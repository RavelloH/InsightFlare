#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
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

function folderSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let size = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      size += folderSize(entryPath);
    } else if (entry.isFile()) {
      size += fs.statSync(entryPath).size;
    }
  }
  return size;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(2)} ${units[index]}`;
}

function prebuildArgs(options: CommonOptions): string[] {
  const args = [
    localCli(ROOT_DIR, "tsx", path.join("dist", "cli.mjs")),
    path.join(ROOT_DIR, "scripts", "prebuild.ts"),
    "--target",
    options.target,
    "--config",
    options.config,
    "--database",
    options.database,
  ];
  if (options.envName) {
    args.push("--env", options.envName);
  }
  if (options.skipSdk) {
    args.push("--skip-sdk");
  }
  return args;
}

async function verifySkillsManifest(options: CommonOptions): Promise<void> {
  await runtime.runCommand(
    process.execPath,
    [
      localCli(ROOT_DIR, "tsx", path.join("dist", "cli.mjs")),
      path.join(ROOT_DIR, "scripts", "check-skills.ts"),
    ],
    targetEnv(options.target),
    ROOT_DIR,
    "verify generated skills manifest",
  );
}

async function runPrebuild(options: CommonOptions): Promise<void> {
  if (options.skipPrebuild) {
    runtime.rlog.info("Prebuild skipped.");
    return;
  }
  await runtime.runCommand(
    process.execPath,
    prebuildArgs(options),
    targetEnv(options.target),
  );
}

async function runViteBuild(options: CommonOptions): Promise<void> {
  const mode =
    options.target === "cf"
      ? "production"
      : options.target === "demo"
        ? "demo"
        : "local";
  fs.rmSync(path.join(ROOT_DIR, "dist"), { recursive: true, force: true });
  await runtime.runCommand(
    process.execPath,
    [
      localCli(ROOT_DIR, "vite", path.join("bin", "vite.js")),
      "build",
      "--mode",
      mode,
    ],
    {
      ...targetEnv(options.target),
      CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: path.resolve(
        ROOT_DIR,
        options.config,
      ),
      ...(options.envName ? { CLOUDFLARE_ENV: options.envName } : {}),
    },
    ROOT_DIR,
    `vite build --mode ${mode}`,
  );
  await runtime.runCommand(
    process.execPath,
    [
      localCli(ROOT_DIR, "tsx", path.join("dist", "cli.mjs")),
      path.join(ROOT_DIR, "scripts", "prune-server-output.ts"),
    ],
    targetEnv(options.target),
    ROOT_DIR,
    "prune unreachable server modules",
  );
}

const runtime = createRuntime("build", "Build");

async function main(): Promise<void> {
  const options = parseCommonOptions(process.argv.slice(2));
  const startedAt = Date.now();
  const stages: StageResult[] = [];

  runtime.logHeader(options);
  runtime.assertEnvironment(options);

  stages.push(
    await runtime.runStage(1, 3, "Verifying skills manifest", () =>
      verifySkillsManifest(options),
    ),
  );
  stages.push(
    await runtime.runStage(2, 3, "Preparing build inputs", () =>
      runPrebuild(options),
    ),
  );
  stages.push(
    await runtime.runStage(3, 3, "Building Cloudflare worker", () =>
      runViteBuild(options),
    ),
  );

  runtime.logSummary(stages, startedAt);
  runtime.rlog.log(
    `dist size${"".padEnd(25)} ${formatBytes(folderSize(path.join(ROOT_DIR, "dist")))}`,
  );
  runtime.rlog.success("InsightFlare build completed successfully.");
}

main().catch((error: unknown) => {
  runtime.rlog.log();
  runtime.rlog.error("InsightFlare build failed");
  runtime.rlog.error(error instanceof Error ? error.message : String(error));
  runtime.rlog.error(`Full log: ${runtime.logFilePath}`);
  process.exitCode = 1;
});
