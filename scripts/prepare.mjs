import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";

// Only explicitly selected, non-executing CI jobs may omit root generation.
// Dependency installation scripts (e.g. esbuild/workerd) are not disabled.
if (process.env.INSIGHTFLARE_CI_PREPARE === "skip") {
  if (process.env.CI !== "true" || process.env.HUSKY !== "0") {
    throw new Error("Skipping generated preparation is restricted to CI.");
  }
  console.log("Skipping root generated inputs for a non-executing CI job.");
  process.exit(0);
}

const require = createRequire(import.meta.url);
function run(bin, args) {
  const packagePath = require.resolve(bin + "/package.json");
  const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  const executable =
    typeof metadata.bin === "string" ? metadata.bin : metadata.bin[bin];
  if (!executable) throw new Error("Missing local executable: " + bin);
  const result = spawnSync(
    process.execPath,
    [resolve(dirname(packagePath), executable), ...args],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("tsx", ["scripts/generate-messages.ts"]);
run("tsx", ["scripts/build-tracker-sdk.ts"]);
// Husky exports only its module entrypoint, so resolve its local bin path directly.
const result = spawnSync(process.execPath, ["node_modules/husky/bin.js"], {
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
