import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnv } from "vite";
import { afterAll, describe, expect, it } from "vitest";

import { resolveViteBuildMode } from "./deploy-runtime";

const envDir = mkdtempSync(join(tmpdir(), "insightflare-build-mode-"));
afterAll(() => rmSync(envDir, { recursive: true, force: true }));

describe("Vite build mode", () => {
  it.each([
    ["cf", "production"],
    ["demo", "demo"],
    ["local", "development"],
  ] as const)("maps %s to the supported %s mode", (target, expectedMode) => {
    const mode = resolveViteBuildMode(target);
    expect(mode).toBe(expectedMode);
    expect(() =>
      loadEnv(mode, envDir, "INSIGHTFLARE_MODE_TEST_"),
    ).not.toThrow();
  });
});
