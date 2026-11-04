import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planPruneNightlyAssets } from "../scripts/prune-nightly-artifacts.mjs";

const now = Date.parse("2026-11-05T00:00:00Z");
const current = "f".repeat(40);
const sha = n => n.toString(16).padStart(40, "0");
function build(n, daysOld, id = n * 100) {
  const created_at = new Date(now - daysOld * 86400000).toISOString();
  const commit = sha(n);
  return [
    { id: id + 1, name: "insightflare-deploy-" + commit + ".json", created_at },
    { id: id + 2, name: "insightflare-deploy-" + commit + ".tar.gz", created_at }
  ];
}
describe("rolling Nightly retention, never deletes current or unrelated assets", () => {
  it("keeps 20 newest previous SHA groups and prunes only old groups", () => {
    const assets = [ ...Array.from({ length: 25 }, (_, i) => build(i + 1, 10 + i / 10)).flat(),
      { id: 9999, name: "insightflare-deploy-" + current + ".json", created_at: new Date(now - 10000000).toISOString() }
    ];
    const doomed = planPruneNightlyAssets(assets, current, now);
    assert.equal(doomed.length, 10);
    assert.ok(doomed.every(item => /^insightflare-deploy-[0-9a-f]{40}\.(?:json|tar\.gz)$/.test(item.name)));
    assert.ok(!doomed.some(item => item.name.includes(current)));
  });

  it("does not prune recent builds even when there are more than 20 groups", () => {
    const assets = Array.from({ length: 50 }, (_, i) => build(i + 1, 0.5)).flat();
    assert.deepEqual(planPruneNightlyAssets(assets, current, now), []);
  });

  it("keeps foreign assets and rejects malformed entries", () => {
    const assets = [
      ...Array.from({ length: 25 }, (_, i) => build(i + 1, 15)).flat(),
      { id: 99991, name: "v0.7.1.zip", created_at: new Date(now - 30 * 86400000).toISOString() },
      { id: 99992, name: "notes.md", created_at: new Date(now - 30 * 86400000).toISOString() },
      { id: -1, name: "insightflare-deploy-" + sha(8) + ".json", created_at: new Date(now - 30 * 86400000).toISOString() },
      { id: 99993, name: "insightflare-deploy-" + sha(7) + ".tar.gz", created_at: "not-a-date" }
    ];
    const doomed = planPruneNightlyAssets(assets, current, now);
    assert.ok(!doomed.some(x => x.id >= 99991));
  });

  it("rejects invalid source pointer or asset inventory", () => {
    assert.throws(() => planPruneNightlyAssets([], "main", now));
    assert.throws(() => planPruneNightlyAssets(null, current, now));
  });
});
