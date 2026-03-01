import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function log(message: string): void {
  console.log(`[edge:prebuild] ${message}`);
}

const migrationTarget = (process.env.INSIGHTFLARE_MIGRATION_TARGET ?? "local").toLowerCase();
const targetFlag = migrationTarget === "remote" ? "--remote" : "--local";
const dbName = process.env.INSIGHTFLARE_D1_DATABASE ?? "insightflare";
const wranglerEnv = process.env.INSIGHTFLARE_ENV;
const cwd = process.cwd();

function resolveWranglerCli(): string {
  const candidates = [
    path.join(cwd, "node_modules", "wrangler", "bin", "wrangler.js"),
    path.join(cwd, "..", "..", "node_modules", "wrangler", "bin", "wrangler.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Cannot resolve local Wrangler CLI");
}

const wranglerCli = resolveWranglerCli();

const args = [
  wranglerCli,
  "d1",
  "migrations",
  "apply",
  dbName,
  "--config",
  "wrangler.toml",
  targetFlag,
];

if (wranglerEnv && wranglerEnv.length > 0) {
  args.push("--env", wranglerEnv);
}

log(`$ ${process.execPath} ${args.join(" ")}`);
const result = spawnSync(process.execPath, args, {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});

if (result.status !== 0) {
  throw new Error("Edge prebuild migration failed");
}

log(`migration apply done (${migrationTarget})`);
