import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./prepare.mjs", import.meta.url));

describe("CI-only generated preparation opt-out", () => {
  it("allows skipping generated inputs for a CI job", () => {
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        CI: "true",
        HUSKY: "0",
        INSIGHTFLARE_CI_PREPARE: "skip",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipping root generated inputs");
  });

  it.each([
    ["false", "0"],
    ["true", "1"],
  ])("rejects an unsafe opt-out (CI=%s, HUSKY=%s)", (ci, husky) => {
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        CI: ci,
        HUSKY: husky,
        INSIGHTFLARE_CI_PREPARE: "skip",
      },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restricted to CI");
  });
});
