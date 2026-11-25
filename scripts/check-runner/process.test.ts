import process from "node:process";

import Rlog from "rlog-js";
import { describe, expect, it } from "vitest";

import { runCapturedProcess } from "./process";

function createTestLogger(): Rlog {
  return new Rlog({
    screenOutput: "none",
    silent: true,
  });
}

describe("runCapturedProcess", () => {
  it(
    "captures stdout and stderr from a successful process",
    { timeout: 30_000 },
    async () => {
      const logger = createTestLogger();

      try {
        const result = await runCapturedProcess({
          command: process.execPath,
          args: ["-e", 'console.log("stdout"); console.error("stderr")'],
          cwd: process.cwd(),
          env: process.env,
          logger,
          verbose: false,
        });

        expect(result.ok).toBe(true);
        expect(result.code).toBe(0);
        expect(result.output).toContain("stdout");
        expect(result.output).toContain("stderr");
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        await logger.close();
      }
    },
  );

  it(
    "returns the exit code and captured output for a failed process",
    { timeout: 30_000 },
    async () => {
      const logger = createTestLogger();

      try {
        const result = await runCapturedProcess({
          command: process.execPath,
          args: ["-e", 'console.error("failure"); process.exitCode = 7'],
          cwd: process.cwd(),
          env: process.env,
          logger,
          verbose: false,
        });

        expect(result.ok).toBe(false);
        expect(result.code).toBe(7);
        expect(result.signal).toBeNull();
        expect(result.output).toContain("failure");
      } finally {
        await logger.close();
      }
    },
  );
  it(
    "retains the final diagnostic when successful progress fills the output budget",
    { timeout: 30_000 },
    async () => {
      const logger = createTestLogger();
      try {
        const result = await runCapturedProcess({
          command: process.execPath,
          args: [
            "-e",
            'console.log("start-marker"); console.log("a".repeat(200000)); console.error("final-diagnostic"); process.exitCode = 1',
          ],
          cwd: process.cwd(),
          env: process.env,
          logger,
          verbose: false,
        });
        expect(result.ok).toBe(false);
        expect(result.output).toContain("start-marker");
        expect(result.output).toContain("final-diagnostic");
        expect(result.output).toContain("retained beginning and end");
        expect(Buffer.byteLength(result.output)).toBeLessThan(132000);
      } finally {
        await logger.close();
      }
    },
  );
});
