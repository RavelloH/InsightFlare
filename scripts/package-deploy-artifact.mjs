#!/usr/bin/env node
/**
 * Package a credential-free, account-independent InsightFlare build for
 * public GitHub Release distribution. The output never contains .env files,
 * Cloudflare API tokens, real D1 IDs or maintainer-specific Wrangler config.
 *
 * The release manifest is format v1. The GitHub Release tag and filename
 * contain the exact commit SHA. Consumers must additionally verify the
 * GitHub Release asset's SHA256 digest before trusting this manifest.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_SCHEMA = 1;
const GIT_REPO = "RavelloH/InsightFlare";
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const ALLOWED_ASSET_EXTENSIONS = new Set([
  ".html", ".js", ".mjs", ".css", ".json", ".webmanifest",
  ".png", ".svg", ".ico", ".jpg", ".jpeg", ".webp", ".gif", ".avif",
  ".woff2", ".woff", ".ttf", ".otf", ".txt", ".xml", ".wasm",
  ".eot", ".pdf", ".mp4", ".webm", ".ogg", ".mp3", ".webp"
]);
const MAX_FILES = 6000;
const MAX_BYTES = 90 * 1024 * 1024;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(check, message) {
  if (!check) throw new Error("Invalid InsightFlare deploy artifact: " + message);
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function cleanRelative(relative) {
  const parts = relative.replaceAll("\\", "/").split("/");
  assert(parts.every(part => part.length && part !== "." && part !== ".." &&
    /^[a-zA-Z0-9._-]+$/.test(part)), "unsafe path " + relative);
  return parts.join("/");
}
async function walk(root, prefix = "") {
  const result = [];
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = cleanRelative(prefix ? prefix + "/" + item.name : item.name);
    assert(!item.isSymbolicLink(), "symlink is not permitted: " + rel);
    if (item.isDirectory()) result.push(...await walk(root, rel));
    else if (item.isFile()) result.push(rel);
    else throw Error("Unsupported build entry " + rel);
  }
  return result.sort((a, b) => a.localeCompare(b, "en"));
}
function sanitizedConfig(config) {
  assert(config?.name === "insightflare" && config.main === "index.js" &&
    config.no_bundle === true && config.assets?.directory === "../client",
    "unrecognized compiled Cloudflare Worker config");
  assert(/^20\d{2}-\d{2}-\d{2}$/.test(config.compatibility_date) &&
    Array.isArray(config.compatibility_flags), "missing compatibility options");
  const bindings = {
    durableObjects: (config.durable_objects?.bindings ?? []).map(({ name, class_name }) => ({ name, className: class_name })),
    d1: (config.d1_databases ?? []).map(({ binding }) => binding),
    kv: (config.kv_namespaces ?? []).map(({ binding }) => binding),
    analyticsEngine: (config.analytics_engine_datasets ?? []).map(({ binding, dataset }) => ({ binding, dataset }))
  };
  assert(bindings.durableObjects.some(item => item.name === "INGEST_DO" && item.className === "IngestDurableObject") &&
    bindings.d1.includes("DB") && bindings.kv.includes("SITE_SETTINGS_KV"),
    "required D1, KV or Durable Object binding missing");
  const doMigrations = config.migrations ?? [];
  assert(Array.isArray(doMigrations) && doMigrations.length && doMigrations.length <= 50 &&
    doMigrations.every(item => /^[a-zA-Z0-9_.-]{1,128}$/.test(item.tag)),
    "invalid Durable Object migration history");
  const allowedVars = ["SESSION_WINDOW_MINUTES", "SCRIPT_CACHE_TTL_SECONDS", "PARQUET_WASM_URL"];
  const vars = {};
  for (const name of allowedVars) {
    if (Object.hasOwn(config.vars ?? {}, name)) {
      assert(typeof config.vars[name] === "string", "an unexpected non-string public variable");
      vars[name] = config.vars[name];
    }
  }
  return {
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    mainModule: "index.js",
    assetConfig: { html_handling: "auto-trailing-slash", not_found_handling: "none" },
    bindings, doMigrations,
    vars, crons: config.triggers?.crons ?? []
  };
}

export async function packageDeployArtifact({
  root = DEFAULT_ROOT, sha, outputDirectory = path.join(root, ".tmp", "deploy-release"),
  archive = false
}) {
  assert(typeof sha === "string" && SHA_PATTERN.test(sha), "full commit SHA required");
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  assert(head === sha, "checked-out Git HEAD differs from requested SHA");

  const serverDir = path.join(root, "dist", "server");
  const clientDir = path.join(root, "dist", "client");
  const migrationDir = path.join(root, "migrations");
  const config = sanitizedConfig(JSON.parse(await readFile(path.join(serverDir, "wrangler.json"), "utf8")));
  const names = {
    archive: "insightflare-deploy-" + sha + ".tar.gz",
    manifest: "insightflare-deploy-" + sha + ".json"
  };
  const bundleDir = path.join(outputDirectory, "bundle");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });
  let totalBytes = 0;
  const files = [];
  const seen = new Set();

  async function add(category, directory, rel) {
    cleanRelative(rel);
    const output = category + "/" + rel;
    assert(!seen.has(output), "duplicate output: " + output);
    seen.add(output);
    const source = path.join(directory, ...rel.split("/"));
    const info = await lstat(source);
    assert(info.isFile() && !info.isSymbolicLink(), "source must be regular file: " + output);
    const bytes = await readFile(source);
    totalBytes += bytes.byteLength;
    assert(seen.size <= MAX_FILES && totalBytes <= MAX_BYTES, "artifact exceeds safety limits");
    const destination = path.join(bundleDir, ...output.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    files.push({ path: output, size: bytes.byteLength, sha256: digest(bytes) });
  }

  const server = (await walk(serverDir)).filter(name => {
    if (name === "wrangler.json" || name.startsWith(".vite/") ||
      name.endsWith(".map") || name.endsWith(".css") || name.endsWith(".woff") || name.endsWith(".woff2")) return false;
    assert(/\.(?:js|mjs|wasm)$/.test(name), "unexpected Worker output " + name);
    return true;
  });
  const assets = (await walk(clientDir)).filter(name => {
    if (name === ".assetsignore" || name.endsWith(".map") ||
      name.split("/").some(part => part.startsWith("."))) return false;
    assert(ALLOWED_ASSET_EXTENSIONS.has(path.posix.extname(name)), "unknown asset extension " + name);
    return true;
  });
  const migrations = (await walk(migrationDir)).filter(name => {
    assert(name.endsWith(".sql") && !name.includes("/"), "unexpected D1 migration path " + name);
    return true;
  });
  assert(server.includes(config.mainModule) && server.length > 0 && assets.length > 0 &&
    migrations.length > 0, "incomplete Worker, assets or D1 migration set");
  for (const file of server) await add("worker", serverDir, file);
  for (const file of assets) await add("asset", clientDir, file);
  for (const file of migrations) await add("migrations", migrationDir, file);

  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  // Deterministic digest remains compatible with Deploy's pack-build.mjs.
  const contentHash = createHash("sha256");
  for (const file of files.filter(entry => entry.path.startsWith("worker/") || entry.path.startsWith("asset/"))) {
    contentHash.update(file.path).update("\0")
      .update(Buffer.from(file.sha256, "hex")).update("\0");
  }
  const artifactDigest = contentHash.digest("hex");
  const manifest = {
    schemaVersion: RELEASE_SCHEMA,
    source: { repository: GIT_REPO, sha },
    artifactDigest, config,
    files,
    totals: {
      modules: server.length, assets: assets.length, migrations: migrations.length,
      bytes: totalBytes
    }
  };
  const json = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(path.join(bundleDir, "manifest.json"), json);
  await writeFile(path.join(outputDirectory, names.manifest), json);

  if (archive) {
    assert(process.platform === "linux", "reproducible archive creation requires GNU tar and gzip on Linux");
    const archivePath = path.join(outputDirectory, names.archive);
    const cmd = spawnSync("tar", [
      "--sort=name", "--mtime=UTC 2020-01-01", "--owner=0", "--group=0",
      "--numeric-owner", "--format=ustar", "-czf", archivePath, "-C", bundleDir, "."
    ], { stdio: "inherit" });
    assert(cmd.status === 0, "tar archive creation failed");
  }
  return { manifest, outputDirectory, names };
}

const invoked = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  const args = process.argv.slice(2);
  const sha = args.find(value => SHA_PATTERN.test(value));
  const archive = args.includes("--archive");
  const rootOption = args.find(value => value.startsWith("--root="));
  packageDeployArtifact({
    sha, archive,
    ...(rootOption ? { root: path.resolve(rootOption.slice("--root=".length)) } : {})
  }).then(result => {
    console.log(JSON.stringify({
      sha: result.manifest.source.sha,
      digest: result.manifest.artifactDigest,
      files: result.manifest.totals,
      outputDirectory: result.outputDirectory,
      archive: archive ? result.names.archive : "not requested"
    }, null, 2));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
