import process from "node:process";

import { createScriptLogger } from "../shared/logger";
import { runCapturedProcess } from "./process";
import { CheckProgress } from "./progress";

interface CheckStep {
  name: string;
  args: string[];
}

interface CheckTask {
  name: string;
  steps: CheckStep[];
  dependsOn?: string[];
  parallelSteps?: boolean;
}

interface StepResult {
  ok: boolean;
  output: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  durationMs: number;
}

interface TaskResult extends StepResult {
  name: string;
  failedStep?: string;
}

interface CheckOptions {
  fix: boolean;
  verbose: boolean;
}

export const rlog = createScriptLogger({
  silent: true,
});

function createTasks(fix: boolean): CheckTask[] {
  const formatSteps: CheckStep[] = fix
    ? [
        {
          name: "Format",
          args: ["run", "format"],
        },
      ]
    : [
        {
          name: "Format",
          args: ["run", "format:check"],
        },
      ];
  const lintSteps: CheckStep[] = fix
    ? [
        {
          name: "Lint fix",
          args: ["run", "lint:fix"],
        },
      ]
    : [
        {
          name: "Lint",
          args: ["run", "lint"],
        },
      ];

  return [
    {
      name: "Tracker SDK",
      steps: [
        {
          name: "Tracker SDK",
          args: ["run", "build:tracker-sdk"],
        },
      ],
    },
    {
      name: "Format",
      dependsOn: ["Tracker SDK"],
      steps: formatSteps,
    },
    {
      name: "Lint",
      dependsOn: fix ? ["Format"] : undefined,
      steps: lintSteps,
    },
    {
      name: "Translations",
      dependsOn: fix ? ["Lint"] : undefined,
      steps: [
        {
          name: "Translations",
          args: ["run", "check:i18n"],
        },
      ],
    },
    {
      name: "Typecheck",
      dependsOn: fix ? ["Lint"] : undefined,
      steps: [
        {
          name: "Typecheck",
          args: ["run", "typecheck"],
        },
      ],
    },
    {
      name: "Coverage",
      dependsOn: fix ? ["Lint"] : undefined,
      steps: [
        {
          name: "Coverage",
          args: ["run", "test:coverage:check"],
        },
      ],
    },
    {
      name: "Spec",
      dependsOn: fix ? ["Lint"] : undefined,
      parallelSteps: true,
      steps: [
        {
          name: "OpenAPI spec",
          args: ["run", fix ? "check:openapi:fix" : "check:openapi"],
        },
        {
          name: "Schema spec",
          args: ["run", fix ? "check:schema:fix" : "check:schema"],
        },
      ],
    },
    {
      name: "Build",
      dependsOn: fix
        ? ["Spec", "Lint", "Tracker SDK", "Coverage"]
        : ["Spec", "Tracker SDK", "Coverage"],
      steps: [
        {
          name: "Build",
          args: ["run", "build:demo", "--", "--skip-sdk"],
        },
      ],
    },
  ];
}

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

async function runStep(
  taskName: string,
  step: CheckStep,
  verbose: boolean,
): Promise<StepResult> {
  const command = npmSpawnCommand(step.args);
  const result = await runCapturedProcess({
    command: command.command,
    args: command.args,
    cwd: process.cwd(),
    env: process.env,
    logger: rlog.child({ checkTask: taskName, checkStep: step.name }),
    verbose,
  });

  return result;
}

async function runTask(
  task: CheckTask,
  verbose: boolean,
  progress: CheckProgress,
): Promise<TaskResult> {
  const taskLogger = rlog.child({ checkTask: task.name });
  const startedAt = Date.now();
  progress.startTask(task.name);
  taskLogger.text.info(`Running ${task.name}`);

  const runStepWithProgress = async (
    step: CheckStep,
  ): Promise<{ step: CheckStep; result: StepResult }> => {
    progress.startStep(task.name, step.name);
    if (verbose && task.steps.length > 1) {
      taskLogger.text.info(`Running ${task.name} / ${step.name}`);
    }

    const result = await runStep(task.name, step, verbose);
    if (result.ok) {
      progress.completeStep(task.name, step.name, result.durationMs);
    } else {
      progress.failStep(task.name, step.name, result.durationMs);
    }
    return { step, result };
  };

  const stepResults: Array<{ step: CheckStep; result: StepResult }> =
    task.parallelSteps
      ? await Promise.all(task.steps.map((step) => runStepWithProgress(step)))
      : await (async () => {
          const results: Array<{ step: CheckStep; result: StepResult }> = [];
          for (const step of task.steps) {
            const stepResult = await runStepWithProgress(step);
            results.push(stepResult);
            if (!stepResult.result.ok) break;
          }
          return results;
        })();

  const failedStep = stepResults.find(({ result }) => !result.ok);
  if (failedStep) {
    progress.failTask(task.name, Date.now() - startedAt);
    return {
      ...failedStep.result,
      name: task.name,
      failedStep: failedStep.step.name,
      durationMs: Date.now() - startedAt,
    };
  }

  progress.completeTask(task.name, Date.now() - startedAt);
  taskLogger.text.success(
    `Passed ${task.name} in ${((Date.now() - startedAt) / 1000).toFixed(2)}s`,
  );
  return {
    ok: true,
    output: "",
    code: 0,
    name: task.name,
    durationMs: Date.now() - startedAt,
  };
}

function scheduleTasks(
  tasks: CheckTask[],
  verbose: boolean,
  progress: CheckProgress,
): Promise<TaskResult[]> {
  const taskByName = new Map(tasks.map((task) => [task.name, task]));
  const scheduled = new Map<string, Promise<TaskResult>>();

  const schedule = (task: CheckTask): Promise<TaskResult> => {
    const existing = scheduled.get(task.name);
    if (existing) return existing;

    const dependencies = (task.dependsOn ?? []).map((dependencyName) => {
      const dependency = taskByName.get(dependencyName);
      if (!dependency) {
        throw new Error(
          `Unknown check dependency ${dependencyName} for ${task.name}`,
        );
      }
      return schedule(dependency);
    });

    const result = Promise.all(dependencies).then(() =>
      runTask(task, verbose, progress),
    );
    scheduled.set(task.name, result);
    return result;
  };

  return Promise.all(tasks.map((task) => schedule(task)));
}

function parseArgs(argv: string[]): CheckOptions {
  const knownArgs = new Set(["--fix", "--help", "--verify", "--verbose", "-h"]);
  const unknownArgs = argv.filter((arg) => !knownArgs.has(arg));

  if (argv.includes("--help") || argv.includes("-h")) {
    rlog.info("Usage: tsx scripts/check.ts [--verify] [--verbose]");
    rlog.info(
      "Runs quality, coverage, spec, and build checks with automatic fixes.",
    );
    rlog.info("Use --verify to run the strict, non-fixing mode.");
    process.exit(0);
  }

  if (argv.includes("--fix") && argv.includes("--verify")) {
    rlog.error("The --fix and --verify options cannot be used together.");
    process.exit(1);
  }

  if (unknownArgs.length > 0) {
    rlog.error(`Unknown option: ${unknownArgs.join(", ")}`);
    rlog.info("Usage: tsx scripts/check.ts [--verify] [--verbose]");
    process.exit(1);
  }

  return {
    fix: !argv.includes("--verify"),
    verbose: argv.includes("--verbose"),
  };
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { fix, verbose } = parseArgs(argv);
  const tasks = createTasks(fix);
  const progress = new CheckProgress(tasks, {
    interactive: !verbose,
  });
  let results: TaskResult[];

  try {
    results = await scheduleTasks(tasks, verbose, progress);
  } finally {
    progress.finish();
  }

  const failures = results.filter((result) => !result.ok);

  for (const result of failures) {
    const name = result.failedStep
      ? `${result.name} / ${result.failedStep}`
      : result.name;
    rlog.error(
      `Failed ${name} after ${(result.durationMs / 1000).toFixed(2)}s`,
    );
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
    process.exitCode = 1;
    await rlog.flush();
    return;
  }

  rlog.success("All checks passed");
  await rlog.flush();
}
