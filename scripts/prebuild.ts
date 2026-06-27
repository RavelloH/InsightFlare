import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createScriptLogger } from "./shared/logger";
import { checkEnvironmentVariables } from "./check-env";
import { applyWranglerEnvOverrides } from "./wrangler-env-overrides";

const startedAt = Date.now();

const rlog = createScriptLogger({
  logFile: "prebuild.log",
});

function log(
  msg: string,
  type: "info" | "success" | "error" | "warn" = "info",
): void {
  if (type === "success") {
    rlog.success(`[prebuild] ${msg}`);
  } else if (type === "error") {
    rlog.error(`[prebuild] ${msg}`);
  } else if (type === "warn") {
    rlog.warn(`[prebuild] ${msg}`);
  } else {
    rlog.info(`[prebuild] ${msg}`);
  }
}

function pickArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === flag) {
      return argv[i + 1];
    }
    if (current.startsWith(`${flag}=`)) {
      return current.slice(flag.length + 1);
    }
  }
  return undefined;
}

function run(command: string, args: string[], cwd: string): void {
  log(`$ ${command} ${args.join(" ")}`);
  const res = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function resolveWranglerCli(rootDir: string, edgeDir: string): string {
  const candidates = [
    path.join(edgeDir, "node_modules", "wrangler", "bin", "wrangler.js"),
    path.join(rootDir, "node_modules", "wrangler", "bin", "wrangler.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Cannot resolve local Wrangler CLI (node_modules/wrangler/bin/wrangler.js)",
  );
}

function resolveTsxCli(rootDir: string): string {
  const candidate = path.join(
    rootDir,
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(
    "Cannot resolve local tsx CLI (node_modules/tsx/dist/cli.mjs)",
  );
}

async function main(): Promise<void> {
  const autoMigrateArg = pickArg("auto-migrate");
  const autoMigrate =
    autoMigrateArg !== undefined
      ? autoMigrateArg !== "0" && autoMigrateArg.toLowerCase() !== "false"
      : (process.env.INSIGHTFLARE_AUTO_MIGRATE ?? "1") !== "0";
  const migrationTarget = (
    pickArg("target") ??
    process.env.INSIGHTFLARE_MIGRATION_TARGET ??
    "local"
  ).toLowerCase();
  const rootDir = process.cwd();
  const wranglerConfigInput =
    pickArg("config") ??
    process.env.INSIGHTFLARE_WRANGLER_CONFIG ??
    path.join(rootDir, "wrangler.toml");
  const wranglerConfig = path.isAbsolute(wranglerConfigInput)
    ? wranglerConfigInput
    : path.resolve(rootDir, wranglerConfigInput);
  const wranglerDir = path.dirname(wranglerConfig);
  const d1DatabaseName =
    pickArg("database") ??
    process.env.INSIGHTFLARE_D1_DATABASE ??
    "insightflare";
  const wranglerEnv = pickArg("env") ?? process.env.INSIGHTFLARE_ENV;

  log("InsightFlare prebuild started");

  // 检查环境变量安全性
  await checkEnvironmentVariables({ strict: wranglerEnv !== "local" });

  if (!fs.existsSync(wranglerConfig)) {
    throw new Error(`Missing wrangler config: ${wranglerConfig}`);
  }

  const overrideResult = applyWranglerEnvOverrides(
    fs.readFileSync(wranglerConfig, "utf8"),
    process.env,
    wranglerEnv,
  );
  if (overrideResult.applied.length > 0) {
    fs.writeFileSync(wranglerConfig, overrideResult.content);
    log(
      `Applied Wrangler config overrides from environment: ${overrideResult.applied.join(", ")}`,
      "success",
    );
  }

  if (autoMigrate) {
    const targetFlag = migrationTarget === "remote" ? "--remote" : "--local";
    const wranglerCli = resolveWranglerCli(rootDir, wranglerDir);
    const args = [
      wranglerCli,
      "d1",
      "migrations",
      "apply",
      d1DatabaseName,
      "--config",
      wranglerConfig,
      targetFlag,
    ];

    if (wranglerEnv && wranglerEnv.length > 0) {
      args.push("--env", wranglerEnv);
    }

    run(process.execPath, args, wranglerDir);
    log(`D1 migrations applied (${migrationTarget})`, "success");
  } else {
    log("INSIGHTFLARE_AUTO_MIGRATE=0, skip D1 migrations", "warn");
  }

  run(
    process.execPath,
    [
      resolveTsxCli(rootDir),
      path.join(rootDir, "scripts", "build-tracker-sdk.ts"),
    ],
    rootDir,
  );

  const cacheDir = path.join(process.cwd(), ".cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const finishedAt = Date.now();
  fs.writeFileSync(
    path.join(cacheDir, "build-meta.json"),
    JSON.stringify(
      {
        prebuildStartTime: startedAt,
        prebuildEndTime: finishedAt,
        autoMigrate,
        migrationTarget,
      },
      null,
      2,
    ),
  );

  log(
    `InsightFlare prebuild done in ${((finishedAt - startedAt) / 1000).toFixed(2)}s`,
    "success",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`failed: ${message}`, "error");
  process.exit(1);
});
