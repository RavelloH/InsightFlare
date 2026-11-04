import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planPruneNightlyAssets } from "../scripts/prune-nightly-artifacts.mjs";

const now = "f".repeat(40);
const sha = n => n.toString(16).padStart(40, "0");
const active = { id: 1, name: "insightflare-deploy-" + now + ".tar.gz" };
const old = n => ({ id: n + 10, name: "insightflare-deploy-" + sha(n) + ".tar.gz" });

describe("nightly release keeps only one active tar.gz", () => {
  it("removes every previous SHA archive, never current", () => {
    const previous = Array.from({ length: 30 }, (_, n) => old(n + 1));
    assert.deepEqual(planPruneNightlyAssets([active, ...previous], now).map(x => x.name),
      previous.map(x => x.name));
  });
  it("removes legacy JSON sidecars, including current SHA sidecar", () => {
    const sidecar = { id: 99, name: "insightflare-deploy-" + now + ".json" };
    assert.deepEqual(planPruneNightlyAssets([active, sidecar], now), [sidecar]);
  });
  it("accepts the single active archive with no deletion", () => {
    assert.deepEqual(planPruneNightlyAssets([active], now), []);
  });
  it("fails closed for unknown files, malformed metadata, missing/duplicate current", () => {
    assert.throws(() => planPruneNightlyAssets([old(5)], now), /Exactly one/);
    assert.throws(() => planPruneNightlyAssets([active, active], now), /Exactly one/);
    assert.throws(() => planPruneNightlyAssets([active, { id: 3, name: "other.zip" }], now), /Unrecognized/);
    assert.throws(() => planPruneNightlyAssets([active, { name: "bad" }], now), /Malformed/);
  });
  it("rejects invalid current commit or list", () => {
    assert.throws(() => planPruneNightlyAssets([active], "main"), /Invalid/);
    assert.throws(() => planPruneNightlyAssets(null, now), /Invalid/);
  });
});
