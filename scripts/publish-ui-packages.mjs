/**
 * OIDC-only npm release coordinator.
 *
 * Triggered from .github/workflows/publish-ui.yml on main.
 * All versions come from committed package.json files, never CI run IDs.
 * The same version is used by both @insightflare/ui and @insightflare/product-ui.
 * The first publication of each package must be bootstrapped manually because
 * npm only allows Trusted Publisher configuration for an existing package.
 *
 * node scripts/publish-ui-packages.mjs --check
 * node scripts/publish-ui-packages.mjs --publish
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org";
const packages = [
  { name: "@insightflare/ui", dir: "packages/ui" },
  { name: "@insightflare/product-ui", dir: "packages/product-ui" }
];
const mode = process.argv[2];
if (mode !== "--check" && mode !== "--publish") {
  throw new Error("Usage: node scripts/publish-ui-packages.mjs --check|--publish");
}

if (mode === "--publish" && process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Automated release is permitted only from the configured GitHub Actions workflow.");
}
if (mode === "--publish" && process.env.GITHUB_REF !== "refs/heads/main") {
  throw new Error("Automated release must originate from the main branch.");
}

async function readPackage(entry) {
  const manifest = JSON.parse(await readFile(resolve(root, entry.dir, "package.json"), "utf8"));
  if (manifest.name !== entry.name) throw new Error("Unexpected npm package in " + entry.dir);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("Invalid package version: " + manifest.version);
  }
  if (manifest.publishConfig?.access !== "public" || manifest.license !== "MIT" || manifest.private) {
    throw new Error("Package is not configured for public MIT publication: " + manifest.name);
  }
  return { ...entry, version: manifest.version, manifest };
}

async function published(name, version) {
  // The npm direct version route avoids stale top-level metadata caches.
  const url = new URL(registry + "/" + name + "/" + version);
  const { get } = await import("node:https");
  const response = await new Promise((resolve, reject) => {
    const req = get(url, { timeout: 15000, headers: { Accept: "application/json", Connection: "close" } }, res => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        content += chunk;
        if (content.length > 1024 * 1024) req.destroy(new Error("npm manifest response is too large."));
      });
      res.on("end", () => resolve({ status: res.statusCode, content }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("npm registry check timed out.")));
    req.on("error", reject);
  });
  if (response.status === 404) return false;
  if (response.status !== 200) throw new Error("Cannot verify npm registry for " + name + "@" + version + ": HTTP " + response.status);
  const manifest = JSON.parse(response.content);
  if (manifest.name !== name || (version !== "latest" && manifest.version !== version)) {
    throw new Error("npm registry returned an unexpected manifest for " + name + "@" + version);
  }
  return true;
}

function auditArchive(pkg) {
  const dir = resolve(root, pkg.dir);
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: dir, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, shell: process.platform === "win32",
    env: { ...process.env, npm_config_loglevel: "silent" }
  });
  const manifest = JSON.parse(output)[0];
  if (manifest?.name !== pkg.name || manifest?.version !== pkg.version) {
    throw new Error("npm pack returned an unexpected archive for " + pkg.name);
  }
  const paths = new Set(manifest.files?.map(file => file.path) ?? []);
  const required = pkg.name.endsWith("/product-ui")
    ? ["package.json", "LICENSE", "README.md", "styles.css", "dist/realtime/index.js", "dist/realtime/index.d.ts"]
    : ["package.json", "LICENSE", "README.md", "src/styles.css", "dist/components/ui/button.js", "dist/components/ui/button.d.ts"];
  for (const path of required) if (!paths.has(path)) throw new Error(pkg.name + " archive is missing " + path);
  for (const path of paths) {
    if (/(?:^|\/)(?:__tests__|tests)(?:\/)|\.(?:test|spec)\./.test(path)) {
      throw new Error(pkg.name + " archive includes a test file: " + path);
    }
    if (path.startsWith(".env") || path.startsWith(".npmrc")) {
      throw new Error(pkg.name + " archive includes a sensitive file: " + path);
    }
  }
  console.log("Archive verified: " + pkg.name + "@" + pkg.version + " (" + paths.size + " files)");
}

const manifests = await Promise.all(packages.map(readPackage));
const [ui, product] = manifests;
if (ui.version !== product.version) {
  throw new Error("UI and Product UI versions must match. Bump both package.json files together.");
}
if (product.manifest.peerDependencies?.["@insightflare/ui"] !== ui.version) {
  throw new Error("Product UI peer dependency must exactly match the UI release version.");
}
for (const pkg of manifests) auditArchive(pkg);
const publishedVersions = await Promise.all(manifests.map(p => published(p.name, p.version)));
for (let i = 0; i < manifests.length; i++) {
  const pkg = manifests[i];
  console.log((publishedVersions[i] ? "Already published: " : "To publish: ") + pkg.name + "@" + pkg.version);
}
if (mode === "--check") process.exit(0);

for (let i = 0; i < manifests.length; i++) {
  if (publishedVersions[i]) continue;
  const pkg = manifests[i];
  if (!(await published(pkg.name, "latest"))) {
    console.log("::warning::" + pkg.name + " must be published manually once before Trusted Publisher can be configured.");
    continue;
  }
  // The OIDC provider identity and short-lived token are managed entirely by npm CLI.
  // No NODE_AUTH_TOKEN or persistent npm token should be provided to this job.
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error("GitHub Actions OIDC permission is missing; refusing publish.");
  }
  console.log("Publishing " + pkg.name + "@" + pkg.version);
  execFileSync("npm", ["publish", "--access", "public"], {
    cwd: resolve(root, pkg.dir),
    env: { ...process.env, NODE_AUTH_TOKEN: "" },
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  // Confirm the exact version is visible before releasing a package that depends on it.
  let visible = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await published(pkg.name, pkg.version)) { visible = true; break; }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  if (!visible) throw new Error("Published version is not yet readable from npm; stopping dependent releases.");
}
console.log("UI npm publication completed.");
