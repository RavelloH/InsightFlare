import { spawn } from "node:child_process";

import type Rlog from "rlog-js";
import { CaptureError, type ProcessCaptureResult } from "rlog-js";

const MAX_FAILURE_OUTPUT_BYTES = 128 * 1024;
const SCREEN_TARGETS = new Set<"screen">(["screen"]);

export interface CapturedProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: Rlog;
  verbose: boolean;
}

export interface CapturedProcessResult {
  ok: boolean;
  output: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

class FailureOutputBuffer {
  private value = "";
  private size = 0;
  private truncated = false;

  append(text: string, terminated: boolean): void {
    if (this.truncated) return;

    const suffix = terminated ? "\n" : "";
    const next = `${text}${suffix}`;
    const remaining = MAX_FAILURE_OUTPUT_BYTES - this.size;
    if (Buffer.byteLength(next, "utf8") <= remaining) {
      this.value += next;
      this.size += Buffer.byteLength(next, "utf8");
      return;
    }

    const truncated = Buffer.from(next, "utf8")
      .subarray(0, Math.max(remaining, 0))
      .toString("utf8");
    this.value += truncated;
    this.size += Buffer.byteLength(truncated, "utf8");
    this.truncated = true;
  }

  toString(): string {
    if (!this.truncated) return this.value;
    return `${this.value}\n[process output truncated after ${MAX_FAILURE_OUTPUT_BYTES} bytes]`;
  }
}

function errorOutput(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function captureErrorResult(error: unknown): {
  code: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
} {
  if (!(error instanceof CaptureError)) {
    return { code: null, signal: null, durationMs: 0 };
  }

  return {
    code: error.partialResult.exitCode ?? null,
    signal: error.partialResult.signal ?? null,
    durationMs: error.partialResult.durationMs,
  };
}

function resultFromCapture(
  result: ProcessCaptureResult,
  output: string,
): CapturedProcessResult {
  return {
    ok: result.exitCode === 0,
    output,
    code: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
  };
}

export async function runCapturedProcess(
  options: CapturedProcessOptions,
): Promise<CapturedProcessResult> {
  const output = new FailureOutputBuffer();
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  try {
    const result = await options.logger.capture.process(child, {
      mirrorTargets: SCREEN_TARGETS,
      stdoutDisplay: options.verbose ? "info" : "none",
      stderrDisplay: options.verbose ? "error" : "none",
      killProcessOnAbort: true,
      onStdoutLine: (line) => output.append(line.text, line.terminated),
      onStderrLine: (line) => output.append(line.text, line.terminated),
    });

    return resultFromCapture(result, output.toString());
  } catch (error) {
    const processResult = captureErrorResult(error);
    return {
      ok: false,
      output: [output.toString(), errorOutput(error)]
        .filter(Boolean)
        .join("\n"),
      ...processResult,
    };
  }
}
