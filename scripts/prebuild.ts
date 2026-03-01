import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const startedAt = Date.now();

function log(msg: string): void {
  console.log(`[prebuild] ${msg}`);
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

  throw new Error("Cannot resolve local Wrangler CLI (node_modules/wrangler/bin/wrangler.js)");
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

  if (!fs.existsSync(wranglerConfig)) {
    throw new Error(`Missing wrangler config: ${wranglerConfig}`);
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
    log(`D1 migrations applied (${migrationTarget})`);
  } else {
    log("INSIGHTFLARE_AUTO_MIGRATE=0, skip D1 migrations");
  }

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

  log(`InsightFlare prebuild done in ${((finishedAt - startedAt) / 1000).toFixed(2)}s`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`failed: ${message}`);
  process.exit(1);
});
