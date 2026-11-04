#!/usr/bin/env node
/**
 * Narrowly scoped retention for one rolling GitHub nightly prerelease.
 * Never touches formal Releases, foreign assets, the latest main SHA, assets
 * created within 72 hours, or the 20 most recent SHA-addressed build groups.
 * Dry-run unless the explicitly guarded --execute option is supplied.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

const REPO = "RavelloH/InsightFlare";
const SHA = /^[a-f0-9]{40}$/;
const NAME = /^insightflare-deploy-([a-f0-9]{40})\.(?:json|tar\.gz)$/;
const MIN_AGE_MS = 72 * 60 * 60 * 1000;
const KEEP_COMMITS = 20;

export function planPruneNightlyAssets(assets, currentSha, now = Date.now()) {
  if (!SHA.test(currentSha) || !Array.isArray(assets)) {
    throw new Error("Invalid nightly SHA or GitHub asset inventory");
  }
  const groups = new Map();
  for (const asset of assets) {
    const match = NAME.exec(asset?.name ?? "");
    if (!match || !Number.isSafeInteger(asset.id) || asset.id <= 0) continue;
    const sha = match[1];
    if (sha === currentSha) continue;
    const timestamp = Date.parse(asset.created_at ?? "");
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > now) continue;
    const existing = groups.get(sha) ?? [];
    existing.push({ id: asset.id, name: asset.name, createdAt: timestamp });
    groups.set(sha, existing);
  }
  const ordered = [...groups.entries()].map(([sha, files]) => ({
    sha, files, lastPublished: Math.max(...files.map(f => f.createdAt))
  })).sort((a, b) => b.lastPublished - a.lastPublished);

  const candidates = [];
  for (const [index, group] of ordered.entries()) {
    if (index < KEEP_COMMITS || now - group.lastPublished < MIN_AGE_MS) continue;
    candidates.push(...group.files);
  }
  return candidates;
}

async function request(pathname, token, method = "GET") {
  const response = await fetch("https://api.github.com/repos/" + REPO + pathname, {
    method, headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "User-Agent": "InsightFlare-Nightly-Retention"
    }, signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    throw new Error("GitHub retention API failed, HTTP " + response.status);
  }
  if (method === "DELETE") return null;
  return response.json();
}

async function execute(currentSha, dryRun) {
  if (process.env.GITHUB_REPOSITORY !== REPO || !SHA.test(currentSha)) {
    throw new Error("Refusing retention outside the official repository or without exact SHA");
  }
  const token = process.env.GH_TOKEN;
  if (!token || token.length < 10) throw new Error("GitHub token unavailable");

  const release = await request("/releases/tags/nightly", token);
  if (release.tag_name !== "nightly" || release.draft !== false ||
    release.prerelease !== true || release.immutable !== false ||
    !String(release.body ?? "").includes('"sha":"' + currentSha + '"')) {
    throw new Error("Nightly no longer advertises this commit; pruning refused");
  }
  const head = await request("/commits/main", token);
  if (head.sha !== currentSha) {
    console.log("Main moved since publication; retention will be handled by a newer run.");
    return;
  }

  const assets = [];
  for (let page = 1; page <= 10; page++) {
    const results = await request("/releases/" + release.id + "/assets?per_page=100&page=" + page, token);
    if (!Array.isArray(results)) throw new Error("Invalid GitHub release asset listing");
    assets.push(...results);
    if (results.length < 100) break;
  }
  const selected = planPruneNightlyAssets(assets, currentSha);
  console.log(JSON.stringify({
    operation: dryRun ? "dry-run" : "prune",
    currentSha,
    candidates: selected.length,
    protectedRecentBuilds: KEEP_COMMITS,
    minimumAgeHours: MIN_AGE_MS / 3600000
  }));
  if (dryRun) return;
  for (const asset of selected) {
    await request("/releases/assets/" + asset.id, token, "DELETE");
    console.log("Removed expired nightly build asset: " + asset.name);
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  const args = process.argv.slice(2);
  const run = args[0] === "--execute";
  const sha = args.at(-1);
  execute(sha, !run).catch(error => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}
