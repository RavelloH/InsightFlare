import process from "node:process";

export interface CheckProgressTask {
  name: string;
  steps: readonly CheckProgressStep[];
}

export interface CheckProgressStep {
  name: string;
}

type ProgressStatus =
  "pending" | "running" | "completed" | "failed" | "skipped";

interface ProgressStepState extends CheckProgressStep {
  status: ProgressStatus;
  durationMs?: number;
}

interface ProgressTaskState extends CheckProgressTask {
  status: ProgressStatus;
  steps: ProgressStepState[];
  durationMs?: number;
}

export interface CheckProgressOptions {
  interactive?: boolean;
  write?: (text: string) => void;
}

const spinnerFrames = ["⣾", "⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽"];
const ansi = {
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
};

export function formatDuration(durationMs: number): string {
  const roundedDurationMs = Math.max(0, Math.round(durationMs));
  if (roundedDurationMs < 1000) return `${roundedDurationMs}ms`;

  return `${(roundedDurationMs / 1000).toFixed(2)}s`;
}

function isCiEnvironment(): boolean {
  return process.env.CI === "1" || process.env.CI?.toLowerCase() === "true";
}

export class CheckProgress {
  private readonly interactive: boolean;
  private readonly write: (text: string) => void;
  private readonly tasks: ProgressTaskState[];
  private frame = 0;
  private liveLines = 0;
  private finalized = false;
  private animationTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    tasks: readonly CheckProgressTask[],
    options: CheckProgressOptions = {},
  ) {
    const terminalSupportsLiveOutput =
      process.stdout.isTTY === true && !isCiEnvironment();
    this.interactive =
      terminalSupportsLiveOutput && (options.interactive ?? true);
    this.write = options.write ?? ((text) => process.stdout.write(text));
    this.tasks = tasks.map((task) => ({
      ...task,
      status: "pending",
      steps: task.steps.map((step) => ({ ...step, status: "pending" })),
    }));

    if (this.interactive) {
      this.animationTimer = setInterval(() => {
        if (this.hasRunningWork()) {
          this.frame = (this.frame + 1) % spinnerFrames.length;
          this.draw();
        }
      }, 100);
      this.animationTimer.unref?.();
      this.draw();
    }
  }

  startTask(taskName: string): void {
    const task = this.getTask(taskName);
    task.status = "running";
    this.draw();
  }

  completeTask(taskName: string, durationMs: number): void {
    const task = this.getTask(taskName);
    task.status = "completed";
    task.durationMs = durationMs;
    for (const step of task.steps) {
      if (step.status === "pending" || step.status === "running") {
        step.status = "completed";
      }
    }
    this.draw();
  }

  failTask(taskName: string, durationMs: number): void {
    const task = this.getTask(taskName);
    task.status = "failed";
    task.durationMs = durationMs;
    for (const step of task.steps) {
      if (step.status === "pending" || step.status === "running") {
        step.status = "skipped";
      }
    }
    this.draw();
  }

  startStep(taskName: string, stepName: string): void {
    const step = this.getStep(taskName, stepName);
    step.status = "running";
    this.draw();
  }

  completeStep(taskName: string, stepName: string, durationMs: number): void {
    const step = this.getStep(taskName, stepName);
    step.status = "completed";
    step.durationMs = durationMs;
    this.draw();
  }

  failStep(taskName: string, stepName: string, durationMs: number): void {
    const step = this.getStep(taskName, stepName);
    step.status = "failed";
    step.durationMs = durationMs;
    this.draw();
  }

  finish(): void {
    if (this.finalized) return;
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = undefined;
    }

    if (this.interactive) {
      this.draw();
      this.liveLines = 0;
    } else {
      this.write(`${this.renderLines(false).join("\n")}\n`);
    }

    this.finalized = true;
  }

  private getTask(taskName: string): ProgressTaskState {
    const task = this.tasks.find((candidate) => candidate.name === taskName);
    if (!task) throw new Error(`Unknown check progress task: ${taskName}`);
    return task;
  }

  private getStep(taskName: string, stepName: string): ProgressStepState {
    const task = this.getTask(taskName);
    const step = task.steps.find((candidate) => candidate.name === stepName);
    if (!step) {
      throw new Error(`Unknown check progress step: ${taskName} / ${stepName}`);
    }
    return step;
  }

  private hasRunningWork(): boolean {
    return this.tasks.some((task) => task.status === "running");
  }

  private draw(): void {
    if (!this.interactive || this.finalized) return;

    const lines = this.renderLines(true);
    if (this.liveLines > 0) {
      this.write(`\u001b[${this.liveLines}A\r\u001b[J`);
    }
    this.write(`${lines.join("\n")}\n`);
    this.liveLines = lines.length;
  }

  private renderLines(withColor: boolean): string[] {
    const rootStatus = this.rootStatus();
    const rootLabel =
      rootStatus === "completed"
        ? "Checks complete"
        : rootStatus === "failed"
          ? "Checks failed"
          : "Checking";
    const lines = [
      `${this.marker(rootStatus, withColor)} ${this.label(rootLabel, withColor)}`,
    ];

    for (const task of this.tasks) {
      lines.push(
        `${"  "}${this.marker(task.status, withColor)} ${this.label(task.name, withColor, task.durationMs)}`,
      );

      if (this.shouldRenderSteps(task)) {
        for (const step of task.steps) {
          lines.push(
            `${"    "}${this.marker(step.status, withColor)} ${this.label(step.name, withColor, step.durationMs)}`,
          );
        }
      }
    }

    return lines;
  }

  private rootStatus(): ProgressStatus {
    if (this.tasks.some((task) => task.status === "failed")) return "failed";
    if (this.tasks.every((task) => task.status === "completed")) {
      return "completed";
    }
    if (this.tasks.some((task) => task.status === "running")) return "running";
    return "pending";
  }

  private shouldRenderSteps(task: ProgressTaskState): boolean {
    return (
      task.steps.length > 1 ||
      task.steps.some((step) => step.name !== task.name)
    );
  }

  private marker(status: ProgressStatus, withColor: boolean): string {
    switch (status) {
      case "completed":
        return this.color("✓", ansi.green, withColor);
      case "failed":
        return this.color("x", ansi.red, withColor);
      case "running":
        return this.color(spinnerFrames[this.frame], ansi.cyan, withColor);
      case "skipped":
      case "pending":
        return this.color("-", ansi.dim, withColor);
    }
  }

  private label(
    label: string,
    withColor: boolean,
    durationMs?: number,
  ): string {
    const labelWithDuration =
      typeof durationMs === "number"
        ? `${label} (${formatDuration(durationMs)})`
        : label;
    return this.color(labelWithDuration, ansi.dim, withColor);
  }

  private color(value: string, code: string, withColor: boolean): string {
    return withColor ? `${code}${value}${ansi.reset}` : value;
  }
}
