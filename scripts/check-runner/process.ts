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
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private truncated = false;

  append(text: string, terminated: boolean): void {
    const next = Buffer.from(text + (terminated ? "\n" : ""), "utf8");
    const headLimit = 16 * 1024;
    const tailLimit = MAX_FAILURE_OUTPUT_BYTES - headLimit;
    const available = Math.max(0, headLimit - this.head.length);
    if (available > 0) {
      this.head = Buffer.concat([this.head, next.subarray(0, available)]);
    }
    const rest = next.subarray(available);
    if (!rest.length) return;
    const combined = Buffer.concat([this.tail, rest]);
    if (combined.length > tailLimit) this.truncated = true;
    this.tail = combined.subarray(Math.max(0, combined.length - tailLimit));
  }

  toString(): string {
    const separator = this.truncated
      ? "\n[process output truncated; retained beginning and end]\n"
      : "";
    return this.head.toString("utf8") + separator + this.tail.toString("utf8");
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
