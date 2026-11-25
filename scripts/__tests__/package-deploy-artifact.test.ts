import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const packager = resolve("scripts/package-deploy-artifact.mjs");
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "insightflare-artifact-"));
  roots.push(root);
  function write(relative: string, content: string) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const git = (args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git(["init", "--quiet"]);
  git([
    "-c",
    "user.name=Artifact Test",
    "-c",
    "user.email=artifact@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=" + join(root, "no-hooks"),
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const sha = git(["rev-parse", "HEAD"]);
  write(
    "dist/server/wrangler.json",
    JSON.stringify({
      name: "insightflare",
      main: "index.js",
      no_bundle: true,
      assets: { directory: "../client" },
      compatibility_date: "2026-01-01",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: {
        bindings: [{ name: "INGEST_DO", class_name: "IngestDurableObject" }],
      },
      d1_databases: [{ binding: "DB" }],
      kv_namespaces: [{ binding: "SITE_SETTINGS_KV" }],
      migrations: [{ tag: "v1", new_sqlite_classes: ["IngestDurableObject"] }],
    }),
  );
  write("dist/server/index.js", "export default {};");
  write("dist/server/assets/module.js", "export const x = 1;");
  write("dist/client/index.html", "<html></html>");
  write("migrations/0001_initial.sql", "SELECT 1;");
  const run = () =>
    spawnSync(process.execPath, [packager, sha, "--root=" + root], {
      encoding: "utf8",
    });
  const manifest = () =>
    JSON.parse(
      readFileSync(
        join(root, ".tmp", "deploy-release", "bundle", "manifest.json"),
        "utf8",
      ),
    ) as { files: { path: string }[] };
  return { write, run, manifest };
}

describe("Nightly deploy artifact", () => {
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  it("includes identical SSR static resources only as client assets", () => {
    const { write, run, manifest } = fixture();
    const assets = ["arc.svg", "main.css", "font.woff", "font.woff2"];
    for (const asset of assets) {
      write("dist/server/assets/" + asset, asset);
      write("dist/client/assets/" + asset, asset);
    }
    write("dist/client/_headers", "/assets/*\n  Cache-Control: public");
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const files = manifest().files.map((file) => file.path);
    expect(files).not.toContain("asset/_headers");
    expect(files).toContain("worker/index.js");
    expect(files).toContain("worker/assets/module.js");
    for (const asset of assets) {
      expect(files).toContain("asset/assets/" + asset);
      expect(files).not.toContain("worker/assets/" + asset);
    }
  });

  it("rejects an SSR SVG without its client copy", () => {
    const { write, run } = fixture();
    write("dist/server/assets/arc.svg", "svg");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "missing client copy of Worker asset assets/arc.svg",
    );
  });

  it("rejects a mismatching client copy", () => {
    const { write, run } = fixture();
    write("dist/server/assets/arc.svg", "server");
    write("dist/client/assets/arc.svg", "client");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "different client copy of Worker asset assets/arc.svg",
    );
  });

  it("still rejects unknown Worker output", () => {
    const { write, run } = fixture();
    write("dist/server/assets/unexpected.txt", "not a module");
    write("dist/client/assets/unexpected.txt", "not a module");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "unexpected Worker output assets/unexpected.txt",
    );
  });
});
