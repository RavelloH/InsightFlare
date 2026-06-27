import { spawn } from "node:child_process";
import process from "node:process";

import { createScriptLogger } from "../shared/logger";

interface CheckStep {
  name: string;
  args: string[];
}

interface CheckTask {
  name: string;
  steps: CheckStep[];
}

interface StepResult {
  ok: boolean;
  output: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

interface TaskResult extends StepResult {
  name: string;
  failedStep?: string;
}

export const rlog = createScriptLogger({
  silent: true,
});

const tasks: CheckTask[] = [
  {
    name: "Quality",
    steps: [
      {
        name: "Format",
        args: ["run", "format:check"],
      },
      {
        name: "Lint",
        args: ["run", "lint"],
      },
      {
        name: "Translations",
        args: ["run", "check:i18n"],
      },
      {
        name: "Typecheck",
        args: ["run", "typecheck"],
      },
    ],
  },
  {
    name: "Coverage",
    steps: [
      {
        name: "Coverage",
        args: ["run", "test:coverage"],
      },
    ],
  },
  {
    name: "Spec",
    steps: [
      {
        name: "OpenAPI spec",
        args: ["run", "check:openapi"],
      },
      {
        name: "Skills spec",
        args: ["run", "check:skills"],
      },
    ],
  },
  {
    name: "Build",
    steps: [
      {
        name: "Build",
        args: ["run", "ci:build"],
      },
    ],
  },
];

function npmSpawnCommand(args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return {
      command: "npm",
      args,
    };
  }

  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", ["npm", ...args].join(" ")],
  };
}

function runStep(step: CheckStep, verbose: boolean): Promise<StepResult> {
  return new Promise((resolve) => {
    const command = npmSpawnCommand(step.args);
    const child = spawn(command.command, command.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    let output = "";

    if (!verbose) {
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
    }

    child.on("error", (error: Error) => {
      resolve({
        ok: false,
        output: error.stack || error.message,
      });
    });

    child.on("close", (code, signal) => {
      resolve({
        ok: code === 0,
        output,
        code,
        signal,
      });
    });
  });
}

async function runTask(task: CheckTask, verbose: boolean): Promise<TaskResult> {
  rlog.info(`Running ${task.name}`);

  for (const step of task.steps) {
    if (verbose && task.steps.length > 1) {
      rlog.info(`Running ${task.name} / ${step.name}`);
    }

    const result = await runStep(step, verbose);
    if (!result.ok) {
      return {
        ...result,
        name: task.name,
        failedStep: step.name,
      };
    }
  }

  rlog.success(`Passed ${task.name}`);
  return {
    ok: true,
    output: "",
    code: 0,
    name: task.name,
  };
}

function parseArgs(argv: string[]): { verbose: boolean } {
  const knownArgs = new Set(["--verbose", "--help", "-h"]);
  const unknownArgs = argv.filter((arg) => !knownArgs.has(arg));

  if (argv.includes("--help") || argv.includes("-h")) {
    rlog.info("Usage: tsx scripts/check.ts [--verbose]");
    rlog.info(
      "Runs the same quality, coverage, spec, and build checks used by CI.",
    );
    process.exit(0);
  }

  if (unknownArgs.length > 0) {
    rlog.error(`Unknown option: ${unknownArgs.join(", ")}`);
    rlog.info("Usage: tsx scripts/check.ts [--verbose]");
    process.exit(1);
  }

  return {
    verbose: argv.includes("--verbose"),
  };
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { verbose } = parseArgs(argv);
  const results = await Promise.all(
    tasks.map((task) => runTask(task, verbose)),
  );
  const failures = results.filter((result) => !result.ok);

  for (const result of failures) {
    const name = result.failedStep
      ? `${result.name} / ${result.failedStep}`
      : result.name;
    rlog.error(`Failed ${name}`);
    if (result.signal) {
      rlog.error(`Signal: ${result.signal}`);
    } else if (typeof result.code === "number") {
      rlog.error(`Exit code: ${result.code}`);
    }

    const trimmedOutput = result.output.trim();
    if (trimmedOutput) {
      rlog.error(["--- output ---", trimmedOutput].join("\n"));
    }

    rlog.error("");
  }

  if (failures.length > 0) {
    process.exit(1);
  }

  rlog.success("All checks passed");
}
