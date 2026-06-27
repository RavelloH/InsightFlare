#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";

import { createScriptLogger } from "./shared/logger";

const require = createRequire(import.meta.url);
const rlog = createScriptLogger();

function readAstGrepVersion(): string {
  const pkgPath = "node_modules/@ast-grep/napi/package.json";
  if (!existsSync(pkgPath)) {
    throw new Error("Missing node_modules/@ast-grep/napi/package.json");
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    version?: unknown;
  };
  const version = String(pkg.version || "").trim();
  if (!version) {
    throw new Error("Cannot read @ast-grep/napi version");
  }
  return version;
}

function canLoadAstGrep(): boolean {
  try {
    require("@ast-grep/napi");
    return true;
  } catch {
    return false;
  }
}

function runNpmInstall(pkgWithVersion: string): boolean {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--no-save", pkgWithVersion],
    { stdio: "inherit", env: process.env },
  );
  return result.status === 0;
}

function targetBindingPackage(version: string): string | null {
  if (process.platform === "linux" && process.arch === "x64") {
    return `@ast-grep/napi-linux-x64-gnu@${version}`;
  }
  return null;
}

export function runCli(): void {
  if (canLoadAstGrep()) {
    rlog.success("ast-grep native binding already available");
    return;
  }

  const version = readAstGrepVersion();
  const pkg = targetBindingPackage(version);
  if (!pkg) {
    throw new Error(
      `@ast-grep/napi binding missing on unsupported auto-fix platform: ${process.platform}/${process.arch}`,
    );
  }

  rlog.info(`ast-grep binding missing, installing ${pkg}`);
  const ok = runNpmInstall(pkg);
  if (!ok || !canLoadAstGrep()) {
    throw new Error(`Failed to install working binding package: ${pkg}`);
  }
  rlog.success("ast-grep binding repaired");
}

try {
  runCli();
} catch (error: unknown) {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  rlog.error(message);
  process.exitCode = 1;
}
