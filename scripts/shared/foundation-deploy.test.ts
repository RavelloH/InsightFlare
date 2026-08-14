import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertFoundationDeployConfig,
  writeFoundationDeployManifest,
} from "./foundation-deploy";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function createWorkspace(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "foundation-deploy-"),
  );
  directories.push(directory);
  fs.mkdirSync(path.join(directory, "migrations"));
  fs.writeFileSync(
    path.join(
      directory,
      "migrations",
      "0033_performance_foundation_controls.sql",
    ),
    "CREATE TABLE foundation_test (id TEXT);\n",
  );
  return directory;
}

describe("Foundation deploy safeguards", () => {
  it("requires diagnostics and version metadata bindings", () => {
    expect(() =>
      assertFoundationDeployConfig('binding = "QUERY_DIAGNOSTICS"'),
    ).toThrow("CF_VERSION_METADATA");

    expect(() =>
      assertFoundationDeployConfig(
        'binding = "QUERY_DIAGNOSTICS"\nbinding = "CF_VERSION_METADATA"',
      ),
    ).not.toThrow();
  });

  it("validates generated JSON config and ignores commented TOML bindings", () => {
    expect(() =>
      assertFoundationDeployConfig(
        JSON.stringify({
          analytics_engine_datasets: [
            { binding: "QUERY_DIAGNOSTICS", dataset: "diagnostics" },
          ],
          version_metadata: { binding: "CF_VERSION_METADATA" },
        }),
      ),
    ).not.toThrow();

    expect(() =>
      assertFoundationDeployConfig(
        '# binding = "QUERY_DIAGNOSTICS"\n# binding = "CF_VERSION_METADATA"',
      ),
    ).toThrow("QUERY_DIAGNOSTICS");
  });

  it("writes a reproducible manifest only after a real deploy", () => {
    const rootDir = createWorkspace();
    const configPath = path.join(rootDir, "wrangler.toml");
    fs.writeFileSync(configPath, 'name = "insightflare"\n');

    const manifest = writeFoundationDeployManifest({
      configPath,
      dryRun: false,
      envName: "ravelloh",
      rootDir,
      target: "cf",
    });

    expect(manifest).toMatchObject({
      configPath: "wrangler.toml",
      envName: "ravelloh",
      expectedBindings: ["QUERY_DIAGNOSTICS", "CF_VERSION_METADATA"],
      target: "cf",
    });
    expect(manifest?.configSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest?.migration.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(rootDir, ".cache", "foundation-deploy-manifest.json"),
          "utf8",
        ),
      ),
    ).toEqual(manifest);
  });

  it("does not write a manifest for dry runs", () => {
    const rootDir = createWorkspace();
    const configPath = path.join(rootDir, "wrangler.toml");
    fs.writeFileSync(configPath, 'name = "insightflare"\n');

    expect(
      writeFoundationDeployManifest({
        configPath,
        dryRun: true,
        rootDir,
        target: "cf",
      }),
    ).toBeNull();
    expect(fs.existsSync(path.join(rootDir, ".cache"))).toBe(false);
  });
});
