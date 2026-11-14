#!/usr/bin/env node
/**
 * Keep exactly one current nightly .tar.gz after the new build is uploaded,
 * checked, and published as the release-notes SHA pointer.
 * No formal releases or unrelated assets are ever touched.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "RavelloH/InsightFlare";
const SHA = /^[a-f0-9]{40}$/;
const ARCHIVE = /^insightflare-deploy-([a-f0-9]{40})\.tar\.gz$/;
const SIDECAR = /^insightflare-deploy-([a-f0-9]{40})\.json$/;

export function planPruneNightlyAssets(assets, currentSha) {
  if (!SHA.test(currentSha) || !Array.isArray(assets)) {
    throw Error("Invalid nightly SHA or release asset inventory");
  }
  const keep = "insightflare-deploy-" + currentSha + ".tar.gz";
  let current = 0;
  const stale = [];
  for (const item of assets) {
    const name = item?.name;
    if (!Number.isSafeInteger(item?.id) || item.id < 1 || typeof name !== "string") {
      throw Error("Malformed nightly asset metadata; cleanup refused");
    }
    if (!ARCHIVE.test(name) && !SIDECAR.test(name)) {
      throw Error("Unrecognized nightly attachment; cleanup refused");
    }
    if (name === keep) { current++; continue; }
    stale.push({ id: item.id, name });
  }
  if (current !== 1) throw Error("Exactly one current nightly tar.gz required before cleanup");
  return stale;
}

async function request(pathname, token, method = "GET") {
  const response = await fetch("https://api.github.com/repos/" + REPO + pathname, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "User-Agent": "InsightFlare-Nightly-Cleanup"
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw Error("GitHub nightly API failure HTTP " + response.status);
  if (method === "DELETE") return null;
  return response.json();
}

async function run(sha, execute) {
  if (process.env.GITHUB_REPOSITORY !== REPO || !SHA.test(sha)) {
    throw Error("Not official repository / full SHA; refusing cleanup");
  }
  const token = process.env.GH_TOKEN;
  if (!token || token.length < 10) throw Error("No GitHub workflow token");
  const release = await request("/releases/tags/nightly", token);
  if (release.tag_name !== "nightly" || release.draft !== false ||
      release.prerelease !== true || release.immutable !== false ||
      !String(release.body ?? "").includes('"sha":"' + sha + '"')) {
    throw Error("Nightly pointer does not match this commit");
  }
  const main = await request("/commits/main", token);
  if (main.sha !== sha) { console.log("Main advanced; newer workflow must clean up"); return; }

  const assets = [];
  for (let page = 1; page <= 10; page++) {
    const entries = await request("/releases/" + release.id +
      "/assets?per_page=100&page=" + page, token);
    if (!Array.isArray(entries)) throw Error("Malformed release asset listing");
    assets.push(...entries);
    if (entries.length < 100) break;
    if (page === 10) throw Error("Asset list exceeded safe pagination range");
  }
  const stale = planPruneNightlyAssets(assets, sha);
  console.log(JSON.stringify({ mode: execute ? "prune" : "dry-run", sha, stale: stale.length }));
  if (!execute) return;
  for (const item of stale) {
    // Extra checks ensure no older job can delete the newly active archive.
    const latest = await request("/releases/tags/nightly", token);
    const currentMain = await request("/commits/main", token);
    if (!String(latest.body ?? "").includes('"sha":"' + sha + '"') ||
        currentMain.sha !== sha) {
      throw Error("Nightly/main pointer changed during pruning; stop");
    }
    await request("/releases/assets/" + item.id, token, "DELETE");
    console.log("Deleted previous nightly attachment " + item.name);
  }
}

const direct = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) {
  const args = process.argv.slice(2);
  run(args.at(-1), args[0] === "--execute").catch(error => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}
