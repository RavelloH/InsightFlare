#!/usr/bin/env tsx

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

const ROOT_DIR = process.cwd();
const NODE_MODULES = path.join(ROOT_DIR, "node_modules");
const DEFAULT_BASELINE_REF = "794d312d56a900acc23681c8f6d13066f3bf20b2";
const CANARY_MODULE = `import { compileD1Query, project, scan, unixepoch } from "@/lib/db";
import { schema } from "@/lib/db/schema";

const sites = scan(schema.sites);
export const dbBundleCanary = {
  catalogObjects: Object.keys(schema).length,
  query: compileD1Query(project(sites, { id: sites.columns.id, now: unixepoch() })).sql,
};
`;
const CANARY_WORKER = `import worker, { IngestDurableObject } from "./server";
import { dbBundleCanary } from "./db-bundle-canary";
import type { Env } from "@/lib/edge/types";

export { IngestDurableObject };
export default {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__db_bundle_measure") {
      return Response.json(dbBundleCanary);
    }
    return worker.fetch(request, env, ctx);
  },
};
`;

interface ModuleSize {
  readonly file: string;
  readonly bytes: number;
  readonly gzipBytes: number;
}

interface VariantMeasurement {
  readonly name: string;
  readonly entryBytes: number;
  readonly reachableBytes: number;
  readonly reachableGzipBytes: number;
  readonly moduleCount: number;
  readonly modules: readonly ModuleSize[];
}

function parseOptions(args: readonly string[]): { baselineRef: string } {
  const index = args.indexOf("--baseline-ref");
  const baselineRef = index >= 0 ? args[index + 1] : DEFAULT_BASELINE_REF;
  if (!baselineRef) throw new Error("--baseline-ref requires a commit or ref.");
  return { baselineRef };
}

function copyWorkspace(destination: string): void {
  fs.cpSync(ROOT_DIR, destination, {
    recursive: true,
    filter(source) {
      const relative = path.relative(ROOT_DIR, source);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      return !new Set([
        ".git",
        ".wrangler",
        ".tmp",
        ".cache",
        ".tanstack",
        "coverage",
        "dist",
        "logs",
        "node_modules",
        "plan",
        "playwright-report",
        "test-results",
      ]).has(first ?? "");
    },
  });
  fs.symlinkSync(
    NODE_MODULES,
    path.join(destination, "node_modules"),
    "junction",
  );
}

function attachNodeModules(destination: string): void {
  fs.symlinkSync(
    NODE_MODULES,
    path.join(destination, "node_modules"),
    "junction",
  );
}

function createBaselineWorktree(revision: string, destination: string): void {
  execFileSync("git", ["worktree", "add", "--detach", destination, revision], {
    cwd: ROOT_DIR,
    stdio: "inherit",
  });
  attachNodeModules(destination);
  for (const artifact of ["sdk.min.ts", "sdk.no-perf.min.ts"]) {
    const source = path.join(ROOT_DIR, "src", "tracker", artifact);
    const target = path.join(destination, "src", "tracker", artifact);
    if (fs.existsSync(source)) fs.copyFileSync(source, target);
  }
}

function configureCanary(destination: string): void {
  const sourcePath = path.join(destination, "src", "server.ts");
  const workerPath = path.join(
    destination,
    "src",
    "server.db-bundle-measure.ts",
  );
  const configPath = path.join(destination, "wrangler.toml");
  fs.writeFileSync(
    path.join(destination, "src", "db-bundle-canary.ts"),
    CANARY_MODULE,
  );
  fs.writeFileSync(workerPath, CANARY_WORKER);
  if (!fs.existsSync(sourcePath))
    throw new Error("Expected src/server.ts in the build copy.");
  const config = fs.readFileSync(configPath, "utf8");
  const changed = config.replace(
    /^main\s*=\s*["'][^"']+["']/mu,
    'main = "./src/server.db-bundle-measure.ts"',
  );
  if (changed === config)
    throw new Error("Could not locate the main setting in wrangler.toml.");
  fs.writeFileSync(configPath, changed);
}

function skipIrrelevantSkillPreflight(directory: string): void {
  const buildScript = path.join(directory, "scripts", "build.ts");
  const source = fs.readFileSync(buildScript, "utf8");
  const changed = source.replace(
    /\s+stages\.push\(\s*await runtime\.runStage\(1,\s*3,\s*"Verifying skills manifest",[\s\S]*?verifySkillsManifest\(options\),\s*\),\s*\);\s*/u,
    "",
  );
  if (changed === source)
    throw new Error(
      "Could not remove the unrelated skills preflight from build.ts.",
    );
  fs.writeFileSync(buildScript, changed);
}

function runWorkerBuild(
  directory: string,
  name: string,
  commitSha: string,
): void {
  skipIrrelevantSkillPreflight(directory);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npm,
    ["run", "build:cf", "--", "--skip-prebuild", "--skip-sdk"],
    {
      cwd: directory,
      env: {
        ...process.env,
        CF_BUILD_ID: `db-bundle-${name}`,
        COMMIT_SHA: commitSha,
      },
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${name} Worker build failed with exit code ${result.status}`,
    );
}

function reachableServerModules(serverDirectory: string): string[] {
  const entry = path.join(serverDirectory, "index.js");
  if (!fs.existsSync(entry))
    throw new Error(`Missing Worker entry ${path.relative(ROOT_DIR, entry)}.`);
  const importsPattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/gu;
  const reachable = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    const source = fs.readFileSync(current, "utf8");
    for (const match of source.matchAll(importsPattern)) {
      const specifier = match[1];
      if (!specifier?.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(current), specifier);
      if (
        resolved.startsWith(`${serverDirectory}${path.sep}`) &&
        fs.existsSync(resolved)
      )
        pending.push(resolved);
    }
  }
  return [...reachable].sort();
}

function measureVariant(directory: string, name: string): VariantMeasurement {
  const serverDirectory = path.join(directory, "dist", "server");
  const modules = reachableServerModules(serverDirectory).map((file) => {
    const source = fs.readFileSync(file);
    return {
      file: path.relative(serverDirectory, file).replaceAll(path.sep, "/"),
      bytes: source.byteLength,
      gzipBytes: gzipSync(source, { level: 9 }).byteLength,
    };
  });
  const entry = modules.find((module) => module.file === "index.js");
  if (!entry)
    throw new Error("Worker entry was not included in module traversal.");
  const bytes = modules.reduce((total, module) => total + module.bytes, 0);
  const combined = Buffer.concat(
    modules.map((module) =>
      fs.readFileSync(path.join(serverDirectory, module.file)),
    ),
  );
  return {
    name,
    entryBytes: entry.bytes,
    reachableBytes: bytes,
    reachableGzipBytes: gzipSync(combined, { level: 9 }).byteLength,
    moduleCount: modules.length,
    modules: [...modules].sort((left, right) => right.bytes - left.bytes),
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function report(measurements: readonly VariantMeasurement[]): void {
  console.log(
    "\n| Variant | Worker entry | Reachable JS | Gzip (combined) | Modules |",
  );
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const item of measurements) {
    console.log(
      `| ${item.name} | ${formatBytes(item.entryBytes)} | ${formatBytes(item.reachableBytes)} | ${formatBytes(item.reachableGzipBytes)} | ${item.moduleCount} |`,
    );
  }
  for (const item of measurements) {
    console.log(`\n### ${item.name}: largest reachable modules`);
    for (const module of item.modules.slice(0, 10))
      console.log(
        `- ${module.file}: ${formatBytes(module.bytes)} raw, ${formatBytes(module.gzipBytes)} gzip`,
      );
  }
}

async function main(): Promise<void> {
  const { baselineRef } = parseOptions(process.argv.slice(2));
  const baselineSha = execFileSync(
    "git",
    ["rev-parse", "--verify", `${baselineRef}^{commit}`],
    {
      cwd: ROOT_DIR,
      encoding: "utf8",
    },
  ).trim();
  const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  }).trim();
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "insightflare-db-bundle-"),
  );
  const baselineDirectory = path.join(tempRoot, "baseline");
  const foundationDirectory = path.join(tempRoot, "foundation");
  const canaryDirectory = path.join(tempRoot, "canary");
  for (const directory of [foundationDirectory, canaryDirectory])
    fs.mkdirSync(directory);
  let baselineWorktreeAttached = false;

  try {
    createBaselineWorktree(baselineSha, baselineDirectory);
    baselineWorktreeAttached = true;
    copyWorkspace(foundationDirectory);
    copyWorkspace(canaryDirectory);
    configureCanary(canaryDirectory);

    runWorkerBuild(baselineDirectory, "baseline", baselineSha);
    const baseline = measureVariant(
      baselineDirectory,
      "Pre-foundation production",
    );
    runWorkerBuild(foundationDirectory, "foundation", currentSha);
    const foundation = measureVariant(foundationDirectory, "Foundation unused");
    runWorkerBuild(canaryDirectory, "canary", currentSha);
    const canary = measureVariant(canaryDirectory, "Schema + query canary");
    report([baseline, foundation, canary]);
  } finally {
    if (baselineWorktreeAttached)
      execFileSync(
        "git",
        ["worktree", "remove", "--force", baselineDirectory],
        {
          cwd: ROOT_DIR,
          stdio: "inherit",
        },
      );
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
