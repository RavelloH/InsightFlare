import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { createScriptLogger } from "./logger";
import { LOGS_DIR, ROOT_DIR } from "./paths";

export type DeployTarget = "cf" | "demo" | "local";

export interface CommonOptions {
  config: string;
  database: string;
  dryRun: boolean;
  envName?: string;
  skipPrebuild: boolean;
  skipSdk: boolean;
  target: DeployTarget;
}

export interface StageResult {
  durationMs: number;
  name: string;
}

export interface ExecutionEnvironment {
  details: string[];
  isCloudflare: boolean;
  kind: "cf" | "local";
}

export function readOption(argv: string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === flag) {
      return argv[index + 1];
    }
    if (current.startsWith(`${flag}=`)) {
      return current.slice(flag.length + 1);
    }
  }
  return undefined;
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export function parseTarget(value: string | undefined): DeployTarget {
  const normalized = String(value || "cf")
    .trim()
    .toLowerCase();
  if (normalized === "local") return "local";
  if (normalized === "demo") return "demo";
  if (normalized === "cf" || normalized === "cloudflare") return "cf";
  throw new Error(`Unsupported target: ${value}`);
}

export function parseCommonOptions(argv: string[]): CommonOptions {
  const target = parseTarget(readOption(argv, "target"));
  const config =
    readOption(argv, "config") ??
    process.env.INSIGHTFLARE_WRANGLER_CONFIG ??
    (target === "demo" ? "wrangler.demo.toml" : "wrangler.toml");

  return {
    config,
    database:
      readOption(argv, "database") ??
      process.env.INSIGHTFLARE_D1_DATABASE ??
      "insightflare",
    dryRun: hasFlag(argv, "dry-run"),
    envName: readOption(argv, "env") ?? process.env.INSIGHTFLARE_ENV,
    skipPrebuild: hasFlag(argv, "skip-prebuild"),
    skipSdk: hasFlag(argv, "skip-sdk"),
    target,
  };
}

export function detectExecutionEnvironment(): ExecutionEnvironment {
  const details: string[] = [];
  const cwd = process.cwd().replace(/\\/g, "/");

  if (process.env.CF_PAGES === "1") details.push("CF_PAGES=1");

  const markerNames = [
    "CF_BUILD_ID",
    "CF_BUILD_TOKEN",
    "CLOUDFLARE_BUILD_ID",
    "CLOUDFLARE_BUILD_TOKEN",
    "WORKERS_CI",
  ];
  for (const name of markerNames) {
    if (process.env[name]) details.push(`${name}=set`);
  }

  if (cwd.includes("/opt/buildhome/")) {
    details.push(`cwd=${cwd}`);
  }

  const isCloudflare = details.length > 0;
  return {
    details: details.length > 0 ? details : [`cwd=${cwd}`],
    isCloudflare,
    kind: isCloudflare ? "cf" : "local",
  };
}

export function targetSuggestion(
  scriptName: string,
  target: DeployTarget,
): string {
  if (target === "cf") {
    if (scriptName === "build") return "Use `npm run build:local` locally.";
    if (scriptName === "prebuild")
      return "Use `npm run build:pre:local` locally.";
    if (scriptName === "deploy")
      return "Run this only as the Cloudflare deploy command, or use a demo/local command.";
    if (scriptName === "publish")
      return "Run this only from Cloudflare, or use `npm run publish:demo` for demo publishing.";
    if (scriptName === "db")
      return "Use `npm run db:migrate:local` for local D1, or run the Cloudflare database command in Cloudflare.";
    if (scriptName === "ops")
      return "Run Cloudflare operations only in Cloudflare, or use Wrangler directly if you intentionally need an interactive local operation.";
  }

  if (target === "local") {
    if (scriptName === "build") return "Use `npm run build` in Cloudflare.";
    if (scriptName === "prebuild")
      return "Use `npm run build:pre` in Cloudflare.";
  }

  return "Choose the command whose target matches the current environment.";
}

export function targetEnv(target: DeployTarget): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(target === "demo" ? { DEMO_MODE: "1" } : {}),
  };
}

export function resolveConfigPath(config: string): string {
  return path.isAbsolute(config) ? config : path.resolve(ROOT_DIR, config);
}

export function quoteArg(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

export function commandLine(command: string, args: string[]): string {
  return [command, ...args.map(quoteArg)].join(" ");
}

export function normalizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  ) as NodeJS.ProcessEnv;
}

export function createRuntime(scriptName: string, title: string) {
  const logFile = `${scriptName}.log`;
  const logFilePath = path.join(LOGS_DIR, logFile);
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(logFilePath, "");

  const rlog = createScriptLogger({ logFile });

  function logHeader(options: CommonOptions): void {
    const environment = detectExecutionEnvironment();
    rlog.log();
    rlog.log(`InsightFlare ${title}`);
    rlog.log();
    rlog.info(`Target: ${options.target}`);
    rlog.info(`Environment: ${environment.kind}`);
    rlog.info(`Environment detail: ${environment.details.join(", ")}`);
    rlog.info(`Config: ${options.config}`);
    if (options.envName) rlog.info(`Wrangler env: ${options.envName}`);
    if (options.dryRun) rlog.info("Dry run: enabled");
    rlog.info(`Log file: ${logFilePath}`);
  }

  function appendLog(chunk: Buffer | string): void {
    fs.appendFileSync(logFilePath, chunk);
  }

  function runCommand(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
    cwd = ROOT_DIR,
    displayCommand = commandLine(command, args),
  ): Promise<void> {
    rlog.info(`$ ${displayCommand}`);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: normalizeEnv(env),
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
        appendLog(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
        appendLog(chunk);
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        const reason =
          signal !== null
            ? `Command terminated by signal ${signal}`
            : `Command failed with exit code ${code ?? 1}`;
        reject(new Error(`${reason}: ${displayCommand}`));
      });
    });
  }

  async function runStage(
    index: number,
    total: number,
    name: string,
    task: () => Promise<void> | void,
  ): Promise<StageResult> {
    const startedAt = Date.now();
    rlog.log();
    rlog.info(`[${index}/${total}] ${name}`);
    await task();
    const durationMs = Date.now() - startedAt;
    rlog.success(`Done in ${(durationMs / 1000).toFixed(2)}s`);
    return { durationMs, name };
  }

  function logSummary(stages: StageResult[], startedAt: number): void {
    const totalMs = Date.now() - startedAt;
    rlog.log();
    rlog.success("Summary:");
    rlog.log("----------------------------------------");
    for (const stage of stages) {
      rlog.log(
        `${stage.name.padEnd(35)} ${(stage.durationMs / 1000).toFixed(2)}s`,
      );
    }
    rlog.log(`Total time${"".padEnd(25)} ${(totalMs / 1000).toFixed(2)}s`);
    rlog.log(`Log file${"".padEnd(27)} ${logFilePath}`);
    rlog.log("----------------------------------------");
  }

  function assertEnvironment(options: CommonOptions): void {
    const environment = detectExecutionEnvironment();
    const wrongCloudflareTarget =
      options.target === "cf" && !environment.isCloudflare;
    const wrongLocalTarget =
      options.target === "local" && environment.isCloudflare;

    if (!wrongCloudflareTarget && !wrongLocalTarget) return;

    rlog.error("Target/environment mismatch.");
    rlog.error(`Target: ${options.target}`);
    rlog.error(`Current environment: ${environment.kind}`);
    rlog.error(`Environment detail: ${environment.details.join(", ")}`);
    rlog.error(targetSuggestion(scriptName, options.target));
    throw new Error(`Refusing to run ${scriptName}:${options.target} here.`);
  }

  return {
    assertEnvironment,
    logFilePath,
    logHeader,
    logSummary,
    rlog,
    runCommand,
    runStage,
  };
}

export function localCli(rootDir: string, packageName: string, bin: string) {
  const candidate = path.join(rootDir, "node_modules", packageName, bin);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Cannot resolve local ${packageName} CLI (${candidate})`);
}

export function npmCommand(args: string[]): {
  args: string[];
  command: string;
} {
  if (process.platform !== "win32") {
    return { args, command: "npm" };
  }
  return {
    args: ["/d", "/s", "/c", commandLine("npm", args)],
    command: process.env.ComSpec || "cmd.exe",
  };
}
