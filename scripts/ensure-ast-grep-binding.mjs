import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function log(message) {
  console.log(`[ensure-ast-grep] ${message}`);
}

function readAstGrepVersion() {
  const pkgPath = "node_modules/@ast-grep/napi/package.json";
  if (!existsSync(pkgPath)) {
    throw new Error("Missing node_modules/@ast-grep/napi/package.json");
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const version = String(pkg.version || "").trim();
  if (!version) {
    throw new Error("Cannot read @ast-grep/napi version");
  }
  return version;
}

function canLoadAstGrep() {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    require("@ast-grep/napi");
    return true;
  } catch {
    return false;
  }
}

function runNpmInstall(pkgWithVersion) {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--no-save", pkgWithVersion],
    { stdio: "inherit", env: process.env },
  );
  return result.status === 0;
}

function targetBindingPackage(version) {
  if (process.platform === "linux" && process.arch === "x64") {
    return `@ast-grep/napi-linux-x64-gnu@${version}`;
  }
  return null;
}

function main() {
  if (canLoadAstGrep()) {
    log("native binding already available");
    return;
  }

  const version = readAstGrepVersion();
  const pkg = targetBindingPackage(version);
  if (!pkg) {
    throw new Error(
      `@ast-grep/napi binding missing on unsupported auto-fix platform: ${process.platform}/${process.arch}`,
    );
  }

  log(`binding missing, installing ${pkg}`);
  const ok = runNpmInstall(pkg);
  if (!ok || !canLoadAstGrep()) {
    throw new Error(`Failed to install working binding package: ${pkg}`);
  }
  log("binding repaired");
}

main();
