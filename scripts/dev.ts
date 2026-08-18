/**
 * Development runner: builds the tracker SDK, regenerates messages.ts from the
 * yaml sources, then starts `vite dev` while watching src/i18n/*.yaml.
 *
 * Replacements:
 *   "dev": "tsx scripts/build-tracker-sdk.ts && vite dev --mode development"
 * with:
 *   "dev": "tsx scripts/dev.ts"
 *
 * The yaml watcher reruns `regenerateAppMessages()` on change so editing
 * translation files takes effect in the running app without a restart.
 */
import { spawn } from "node:child_process";
import path from "node:path";

import { createYamlWatcher } from "./i18n-check/watch";
import { localCli } from "./shared/deploy-runtime";
import { createScriptLogger } from "./shared/logger";

const rlog = createScriptLogger({
  logFile: "dev.log",
});

const ROOT = process.cwd();
const VITE = localCli(ROOT, "vite", path.join("bin", "vite.js"));
const TSCLI = localCli(ROOT, "tsx", "dist/cli.mjs");

async function runBuildSdk(): Promise<void> {
  rlog.info("Building tracker SDK...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [TSCLI, path.join(ROOT, "scripts", "build-tracker-sdk.ts")],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`build-tracker-sdk failed with exit code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  await runBuildSdk();

  const watcher = createYamlWatcher(rlog);
  watcher.start();

  rlog.info(`Starting vite dev (${VITE})...`);
  const vite = spawn(process.execPath, [VITE, "dev", "--mode", "development"], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });

  vite.on("error", (error) => {
    rlog.error("vite failed to start:", error.message);
    watcher.stop();
    process.exit(1);
  });

  vite.on("close", (code, signal) => {
    watcher.stop();
    const reason =
      signal != null
        ? `vite terminated by signal ${signal}`
        : `vite exited with code ${code ?? 0}`;
    rlog.info(reason);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  rlog.error(
    "fatal:",
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exit(1);
});
