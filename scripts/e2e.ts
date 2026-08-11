#!/usr/bin/env tsx

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { createScriptLogger } from "./shared/logger";
import { ROOT_DIR } from "./shared/paths";

const rlog = createScriptLogger({ logFile: "e2e.log" });
const MIGRATION_PROGRESS_MAX = 85;
const TRACKER_BUILD_PROGRESS = 90;
const PREPARATION_PROGRESS_MAX = 100;
const E2E_INITIAL_NOW_MS = Date.UTC(2026, 6, 13, 12);

interface Options {
  debug: boolean;
  headed: boolean;
  keep: boolean;
  ui: boolean;
  workers: number | undefined;
}

interface Environment {
  adminPassword: string;
  archiveBucketName: string;
  baseURL: string;
  configPath: string;
  controlToken: string;
  directory: string;
  id: string;
  mainSecret: string;
  mockControlToken: string;
  nowMs: number;
  persistencePath: string;
  port: number;
  testSitePort: number;
  testSiteURL: string;
}

interface StartedProcess {
  child: ChildProcess;
  exited: Promise<void>;
  name: string;
}

interface StartedTestSite {
  mailbox: MockEmail[];
  server: Server;
  url: string;
}

interface MockEmail {
  authorization: string;
  body: Record<string, unknown>;
  id: string;
}

type ResendMockMode =
  | "bad_request"
  | "rate_limited"
  | "server_error"
  | "success";

const E2E_GITHUB_RELEASES = [
  {
    author: { login: "insightflare-e2e" },
    body: "E2E mock release notes",
    created_at: "2026-07-13T12:00:00.000Z",
    draft: false,
    html_url: "https://example.test/releases/v0.5.0",
    id: 1,
    name: "InsightFlare E2E release",
    prerelease: false,
    published_at: "2026-07-13T12:00:00.000Z",
    tag_name: "v0.5.0",
    target_commitish: "e2e-release",
    updated_at: "2026-07-13T12:00:00.000Z",
  },
];

function optionValue(argv: string[], name: string): string | undefined {
  const flag = `--${name}`;
  const index = argv.indexOf(flag);
  if (index >= 0) return argv[index + 1];
  return argv
    .find((value) => value.startsWith(`${flag}=`))
    ?.slice(flag.length + 1);
}

function parseWorkers(argv: string[]): number | undefined {
  const value = optionValue(argv, "workers");
  if (value === undefined) return undefined;
  const workers = Number(value);
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error("--workers must be a positive integer.");
  }
  if (workers !== 1) {
    throw new Error(
      "E2E scenarios share one linear stateful environment; --workers must be 1.",
    );
  }
  return workers;
}

function parseOptions(argv: string[]): Options {
  return {
    debug: argv.includes("--debug"),
    headed: argv.includes("--headed"),
    keep: argv.includes("--keep"),
    ui: argv.includes("--ui"),
    workers: parseWorkers(argv),
  };
}

function runId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value.replace(/\\/g, "/"));
}

function workerName(id: string): string {
  return `insightflare-e2e-${id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

function generatedWranglerConfig(input: {
  adminPassword: string;
  archiveBucketName: string;
  controlToken: string;
  id: string;
  mainSecret: string;
  nowMs: number;
  resendApiUrl: string;
}): string {
  const root = (relativePath: string) =>
    tomlString(path.join(ROOT_DIR, relativePath));
  const name = workerName(input.id);

  return `name = ${tomlString(name)}
main = ${root("src/server.ts")}
compatibility_date = "2026-03-01"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]

[assets]
directory = ${root("public")}
binding = "ASSETS"

[vars]
DEMO_MODE = "0"
DISABLE_CRON_TASKS = "1"
INSIGHTFLARE_E2E = "1"
INSIGHTFLARE_E2E_CONTROL_TOKEN = ${tomlString(input.controlToken)}
INSIGHTFLARE_E2E_NOW = ${tomlString(String(input.nowMs))}
INSIGHTFLARE_E2E_CLOUDFLARE_API_URL = ${tomlString(`${input.resendApiUrl.replace("/resend/emails", "/cloudflare/client/v4/accounts")}`)}
INSIGHTFLARE_E2E_RESEND_API_URL = ${tomlString(input.resendApiUrl)}
INSIGHTFLARE_E2E_TURNSTILE_SITEVERIFY_URL = ${tomlString(`${input.resendApiUrl.replace("/resend/emails", "/turnstile/siteverify")}`)}
MAIN_SECRET = ${tomlString(input.mainSecret)}
BOOTSTRAP_ADMIN_PASSWORD = ${tomlString(input.adminPassword)}
SESSION_WINDOW_MINUTES = "30"
SCRIPT_CACHE_TTL_SECONDS = "600"
[[durable_objects.bindings]]
name = "INGEST_DO"
class_name = "IngestDurableObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["IngestDurableObject"]

[[d1_databases]]
binding = "DB"
database_name = ${tomlString(name)}
database_id = ${tomlString(name)}
migrations_dir = ${root("migrations")}

[[kv_namespaces]]
binding = "SITE_SETTINGS_KV"
id = ${tomlString(name)}

[[r2_buckets]]
binding = "ARCHIVE_BUCKET"
bucket_name = ${tomlString(input.archiveBucketName)}

[[analytics_engine_datasets]]
binding = "BOT_ANALYTICS"
dataset = "insightflare_e2e_bot_events"

[[analytics_engine_datasets]]
binding = "NORMAL_ANALYTICS"
dataset = "insightflare_e2e_normal_events"
`;
}

async function findOpenPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate an E2E port.");
  }
  return address.port;
}

async function writeRunManifest(
  environment: Environment,
  options: Options,
): Promise<void> {
  await fs.writeFile(
    path.join(environment.directory, "manifest", "run.json"),
    `${JSON.stringify(
      {
        baseURL: environment.baseURL,
        createdAt: new Date().toISOString(),
        clock: {
          initialNow: new Date(environment.nowMs).toISOString(),
          nowMs: environment.nowMs,
          sessionWindowMinutes: 30,
          timeZone: "Asia/Shanghai",
        },
        debug: options.debug,
        headed: options.headed,
        keep: options.keep,
        phase: 3,
        port: environment.port,
        runId: environment.id,
        testSiteURL: environment.testSiteURL,
        ui: options.ui,
        workers: options.workers ?? 1,
      },
      null,
      2,
    )}\n`,
  );
}

async function createEnvironment(options: Options): Promise<Environment> {
  const id = runId();
  const directory = path.resolve(".tmp", "e2e", id);
  const configDirectory = path.join(directory, "config");
  const persistencePath = path.join(directory, "state");
  await Promise.all([
    fs.mkdir(path.join(directory, "artifacts"), { recursive: true }),
    fs.mkdir(configDirectory, { recursive: true }),
    fs.mkdir(path.join(directory, "logs"), { recursive: true }),
    fs.mkdir(path.join(directory, "manifest"), { recursive: true }),
    fs.mkdir(persistencePath, { recursive: true }),
  ]);

  const environment: Environment = {
    adminPassword: `e2e-${randomBytes(24).toString("hex")}`,
    archiveBucketName: `${workerName(id)}-archive`,
    baseURL: "",
    configPath: path.join(configDirectory, "wrangler.e2e.toml"),
    controlToken: randomBytes(32).toString("hex"),
    directory,
    id,
    mainSecret: randomBytes(32).toString("hex"),
    mockControlToken: randomBytes(32).toString("hex"),
    nowMs: E2E_INITIAL_NOW_MS,
    persistencePath,
    port: await findOpenPort(),
    testSitePort: await findOpenPort(),
    testSiteURL: "",
  };
  environment.baseURL = `http://127.0.0.1:${environment.port}`;
  environment.testSiteURL = `http://127.0.0.1:${environment.testSitePort}`;

  await fs.writeFile(
    environment.configPath,
    generatedWranglerConfig({
      adminPassword: environment.adminPassword,
      archiveBucketName: environment.archiveBucketName,
      controlToken: environment.controlToken,
      id: environment.id,
      mainSecret: environment.mainSecret,
      nowMs: environment.nowMs,
      resendApiUrl: `${environment.testSiteURL}/resend/emails`,
    }),
  );
  await writeRunManifest(environment, options);
  return environment;
}

function testSiteHtml(workerURL: string, requestURL: URL): string {
  const siteId = requestURL.searchParams.get("siteId") || "";
  const scriptURL = `${workerURL}/script.js?siteId=${encodeURIComponent(siteId)}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>InsightFlare E2E Test Site</title>
<script defer src="${scriptURL}"></script></head>
<body><main><h1>E2E Test Site</h1><a id="product-link" href="/product?siteId=${encodeURIComponent(siteId)}">Product</a>
<button id="signup" data-insightflare-event="signup_clicked" data-insightflare-event-plan="pro">Sign up</button>
<button id="spa-route">SPA checkout</button></main>
<script>document.getElementById('spa-route').addEventListener('click',()=>history.pushState({},'', '/spa/checkout?siteId=${encodeURIComponent(siteId)}&utm_source=e2e'));</script>
</body></html>`;
}

function json(response: ServerResponse, body: unknown) {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function jsonEachRow(rows: Record<string, unknown>[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function mockAnalyticsTimestamp(sql: string): number {
  const match = sql.match(/timestamp\s*<=\s*toDateTime\((\d+)\)/);
  const toSeconds = Number(match?.[1]);
  return (
    (Number.isFinite(toSeconds) ? toSeconds : Date.now() / 1000) * 1000 - 60_000
  );
}

function mockAnalyticsRows(sql: string): Record<string, unknown>[] {
  const timestampMs = mockAnalyticsTimestamp(sql);
  const timestamp = new Date(timestampMs).toISOString();
  const normal = sql.includes("FROM insightflare_normal_events");
  if (sql.includes("AS timestampMs")) {
    return [
      {
        avgLatencyMs: normal ? 42 : undefined,
        count: normal ? 3 : 2,
        customEvents: normal ? 1 : 0,
        p50LatencyMs: normal ? 40 : undefined,
        p75LatencyMs: normal ? 45 : undefined,
        p95LatencyMs: normal ? 50 : undefined,
        p99LatencyMs: normal ? 50 : undefined,
        pageviews: normal ? 2 : 0,
        timestampMs,
      },
    ];
  }
  if (sql.includes("AS pointCount")) {
    return [
      {
        country: "CN",
        latitude: normal ? 31.23 : 39.9,
        longitude: normal ? 121.47 : 116.4,
        pointCount: normal ? 3 : 2,
      },
    ];
  }
  if (sql.includes("count() AS total")) {
    return [
      normal
        ? { affectedSites: 1, total: 3, uniqueAsns: 1, uniqueCountries: 1 }
        : {
            affectedSites: 1,
            highConfidence: 2,
            mediumConfidence: 0,
            total: 2,
            uniqueAsns: 1,
            uniqueCountries: 1,
          },
    ];
  }
  if (sql.includes(" AS label")) {
    return [
      {
        count: normal ? 3 : 2,
        highConfidence: normal ? 0 : 2,
        label: normal ? "E2E Normal Network" : "E2E Bot Network",
      },
    ];
  }
  if (sql.includes("blob3 AS confidence")) {
    return [
      {
        asn: 64512,
        asOrganization: "E2E Bot Network",
        botScore: 5,
        city: "Beijing",
        confidence: "high",
        continent: "AS",
        country: "CN",
        hostname: "app.example.test",
        ip: "198.51.100.8",
        kind: "bot",
        latitude: 39.9,
        longitude: 116.4,
        origin: "https://app.example.test",
        pathname: "/crawl",
        rayId: "e2e-bot-ray",
        reasons: "e2e_mock",
        receivedAt: timestampMs,
        region: "Beijing",
        siteId: "",
        timestamp,
        userAgent: "E2E Bot",
        userAgentLength: 7,
      },
    ];
  }
  if (sql.includes("blob3 AS origin")) {
    return [
      {
        asn: 64513,
        asOrganization: "E2E Normal Network",
        city: "Shanghai",
        continent: "AS",
        country: "CN",
        edgeLatencyMs: 42,
        eventAt: timestampMs,
        hostname: "app.example.test",
        kind: "pageview",
        latitude: 31.23,
        longitude: 121.47,
        origin: "https://app.example.test",
        pathname: "/home",
        rayId: "e2e-normal-ray",
        receivedAt: timestampMs,
        region: "Shanghai",
        requestMethod: "GET",
        siteId: "",
        timestamp,
        traceId: "e2e-normal-trace",
        userAgentLength: 12,
      },
    ];
  }
  return [];
}

async function requestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function requestBody(request: IncomingMessage) {
  try {
    const body = JSON.parse(await requestText(request)) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function startTestSite(
  workerURL: string,
  port: number,
  controlToken: string,
): Promise<StartedTestSite> {
  const mailbox: MockEmail[] = [];
  let resendMode: ResendMockMode = "success";
  const server = createServer((request, response) => {
    void (async () => {
      const requestURL = new URL(request.url || "/", "http://127.0.0.1");
      if (
        request.method === "POST" &&
        requestURL.pathname === "/resend/emails"
      ) {
        if (resendMode !== "success") {
          const status =
            resendMode === "bad_request"
              ? 400
              : resendMode === "rate_limited"
                ? 429
                : 500;
          response.writeHead(status, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(
            `${JSON.stringify({
              message: `E2E forced Resend ${resendMode}`,
            })}\n`,
          );
          return;
        }
        const id = `e2e-email-${mailbox.length + 1}`;
        mailbox.push({
          authorization: String(request.headers.authorization || ""),
          body: await requestBody(request),
          id,
        });
        json(response, { id });
        return;
      }
      if (
        request.method === "POST" &&
        requestURL.pathname === "/__e2e__/resend/mode"
      ) {
        if (request.headers["x-insightflare-e2e-token"] !== controlToken) {
          response.writeHead(403, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(`${JSON.stringify({ error: "Forbidden" })}\n`);
          return;
        }
        const body = await requestBody(request);
        const mode = String(body.mode || "");
        if (
          mode !== "success" &&
          mode !== "bad_request" &&
          mode !== "rate_limited" &&
          mode !== "server_error"
        ) {
          response.writeHead(400, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(`${JSON.stringify({ error: "Invalid Resend mode" })}\n`);
          return;
        }
        resendMode = mode;
        json(response, { mode: resendMode });
        return;
      }
      if (
        request.method === "POST" &&
        requestURL.pathname === "/turnstile/siteverify"
      ) {
        const body = new URLSearchParams(await requestText(request));
        json(
          response,
          body.get("secret") === "e2e-turnstile-secret" &&
            body.get("response") === "e2e-turnstile-pass"
            ? { hostname: "127.0.0.1", success: true }
            : { "error-codes": ["invalid-input-response"], success: false },
        );
        return;
      }
      if (
        request.method === "POST" &&
        /^\/cloudflare\/client\/v4\/accounts\/[^/]+\/analytics_engine\/sql$/.test(
          requestURL.pathname,
        )
      ) {
        if (request.headers.authorization !== "Bearer e2e-cloudflare-token") {
          response.writeHead(403, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(
            `${JSON.stringify({
              errors: [
                { code: 1001, message: "E2E Cloudflare token rejected" },
              ],
            })}\n`,
          );
          return;
        }
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
        });
        response.end(
          jsonEachRow(mockAnalyticsRows(await requestText(request))),
        );
        return;
      }
      if (
        request.method === "GET" &&
        requestURL.pathname === "/github/repos/RavelloH/InsightFlare/releases"
      ) {
        json(response, E2E_GITHUB_RELEASES);
        return;
      }
      if (
        request.method === "GET" &&
        requestURL.pathname === "/__e2e__/mailbox"
      ) {
        if (request.headers["x-insightflare-e2e-token"] !== controlToken) {
          response.writeHead(403, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(`${JSON.stringify({ error: "Forbidden" })}\n`);
          return;
        }
        json(response, { messages: mailbox });
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(testSiteHtml(workerURL, requestURL));
    })().catch((error: unknown) => {
      rlog.file.error(
        `E2E test site failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.headersSent) {
        response.writeHead(500, {
          "content-type": "text/plain; charset=utf-8",
        });
      }
      response.end("E2E test site error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to start E2E test site.");
  return { mailbox, server, url: `http://127.0.0.1:${address.port}` };
}

async function stopTestSite(testSite: StartedTestSite | null): Promise<void> {
  if (!testSite) return;
  testSite.server.closeAllConnections();
  await new Promise<void>((resolve) => testSite.server.close(() => resolve()));
}

function childExitError(
  name: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): Error {
  const reason = signal
    ? `received ${signal}`
    : `exited with code ${code ?? 1}`;
  return new Error(`${name} ${reason}.`);
}

function interruptionError(signal: NodeJS.Signals): Error {
  return new Error(`E2E interrupted by ${signal}.`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error("E2E was interrupted.");
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode !== null) return;

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
        },
      );
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  child.kill("SIGKILL");
}

async function migrationFileCount(): Promise<number> {
  const entries = await fs.readdir(path.join(ROOT_DIR, "migrations"), {
    withFileTypes: true,
  });
  const count = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".sql"),
  ).length;
  if (count === 0) throw new Error("No D1 migration files were found.");
  return count;
}

function createMigrationProgress(totalMigrations: number): {
  complete: () => boolean;
  update: (chunk: Buffer) => void;
} {
  const completedMigrations = new Set<string>();
  let output = "";
  let progress = 0;

  const update = (chunk: Buffer) => {
    output += chunk.toString();
    for (const match of output.matchAll(/│\s*([^│\r\n]+?\.sql)\s*│\s*✅/g)) {
      completedMigrations.add(match[1].trim());
    }

    const nextProgress = Math.floor(
      (completedMigrations.size / totalMigrations) * MIGRATION_PROGRESS_MAX,
    );
    if (nextProgress > progress) {
      progress = nextProgress;
      rlog.progress(progress, PREPARATION_PROGRESS_MAX);
    }
  };

  return {
    complete: () => progress >= MIGRATION_PROGRESS_MAX,
    update,
  };
}

async function runCommand(input: {
  args: string[];
  env?: NodeJS.ProcessEnv;
  logPath: string;
  name: string;
  onOutput?: (chunk: Buffer) => void;
  showOutput?: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(input.signal);
  const log = await fs.open(input.logPath, "w");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, input.args, {
        cwd: ROOT_DIR,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const abort = () => {
        void terminateChild(child);
      };
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener("abort", abort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (input.showOutput) process.stdout.write(chunk);
        rlog.file.info(chunk.toString());
        input.onOutput?.(chunk);
        void log.write(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (input.showOutput) process.stderr.write(chunk);
        rlog.file.info(chunk.toString());
        input.onOutput?.(chunk);
        void log.write(chunk);
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        input.signal?.removeEventListener("abort", abort);
        if (code === 0) resolve();
        else reject(childExitError(input.name, code, signal));
      });
    });
  } finally {
    await log.close();
  }
}

async function runPreparationStep<T>(
  name: string,
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  rlog.file.info(`[Preparation] ${name}`);

  try {
    const result = await task();
    rlog.file.info(
      `${name} completed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s.`,
    );
    return result;
  } catch (error) {
    rlog.error(
      `${name} failed after ${((Date.now() - startedAt) / 1000).toFixed(2)}s.`,
    );
    throw error;
  }
}

async function startProcess(input: {
  args: string[];
  env: NodeJS.ProcessEnv;
  logPath: string;
  name: string;
}): Promise<StartedProcess> {
  const log = await fs.open(input.logPath, "w");
  const child = spawn(process.execPath, input.args, {
    cwd: ROOT_DIR,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(childExitError(input.name, code, signal));
    });
  });
  void exited.catch(() => undefined);

  const write = (chunk: Buffer) => {
    rlog.file.info(chunk.toString());
    void log.write(chunk);
  };
  child.stdout?.on("data", write);
  child.stderr?.on("data", write);
  child.once("close", () => {
    void log.close();
  });

  return { child, exited, name: input.name };
}

async function waitForReady(
  baseURL: string,
  worker: StartedProcess,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError = "";
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const exited = await Promise.race([
      worker.exited.then(
        () => "stopped",
        (error: unknown) => error,
      ),
      new Promise<"running">((resolve) =>
        setTimeout(() => resolve("running"), 0),
      ),
    ]);
    if (exited !== "running") {
      throw exited instanceof Error
        ? exited
        : new Error("E2E worker stopped before becoming ready.");
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let response: Response;
      try {
        response = await fetch(`${baseURL}/healthz`, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
      if (response.ok) return;
      lastError = `health check returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`E2E worker did not become ready: ${lastError}`);
}

async function initializeE2eClock(environment: Environment): Promise<void> {
  const response = await fetch(`${environment.baseURL}/__e2e__/clock/set`, {
    body: JSON.stringify({ nowMs: environment.nowMs }),
    headers: {
      "content-type": "application/json",
      "x-insightflare-e2e-token": environment.controlToken,
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Unable to initialize E2E clock: ${response.status}.`);
  }
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 5_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyTestServices(environment: Environment): Promise<void> {
  const [page, mailbox, releases] = await Promise.all([
    fetchWithTimeout(environment.testSiteURL),
    fetchWithTimeout(`${environment.testSiteURL}/__e2e__/mailbox`, {
      headers: { "x-insightflare-e2e-token": environment.mockControlToken },
    }),
    fetchWithTimeout(
      `${environment.testSiteURL}/github/repos/RavelloH/InsightFlare/releases`,
    ),
  ]);

  if (!page.ok) {
    throw new Error(`E2E test site returned ${page.status}.`);
  }
  if (!mailbox.ok) {
    throw new Error(`E2E mailbox mock returned ${mailbox.status}.`);
  }
  if (!releases.ok) {
    throw new Error(`E2E GitHub mock returned ${releases.status}.`);
  }

  const messages = (await mailbox.json()) as { messages?: unknown[] };
  if (!Array.isArray(messages.messages)) {
    throw new Error("E2E mailbox mock returned an invalid payload.");
  }
  const mockReleases = (await releases.json()) as unknown;
  if (!Array.isArray(mockReleases) || mockReleases.length === 0) {
    throw new Error("E2E GitHub mock returned an invalid payload.");
  }
}

async function writeFailureSummary(
  environment: Environment,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await fs.writeFile(
    path.join(environment.directory, "manifest", "failure.json"),
    `${JSON.stringify(
      {
        artifacts: "artifacts/playwright",
        error: message,
        logs: [
          "logs/migrations.log",
          "logs/tracker-build.log",
          "logs/worker.log",
          "logs/playwright.log",
        ],
        retainedAt: new Date().toISOString(),
        runId: environment.id,
        seedManifest: "manifest/seed.json",
      },
      null,
      2,
    )}\n`,
  );
}

async function stopProcess(
  processToStop: StartedProcess | null,
): Promise<void> {
  if (!processToStop) return;
  await terminateChild(processToStop.child);
}

function workerEnvironment(environment: Environment): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BOOTSTRAP_ADMIN_PASSWORD: environment.adminPassword,
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
    CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: environment.configPath,
    INSIGHTFLARE_LOCAL_PERSISTENCE_PATH: environment.persistencePath,
    INSIGHTFLARE_E2E: "1",
    INSIGHTFLARE_E2E_GITHUB_API_BASE: `${environment.testSiteURL}/github`,
    INSIGHTFLARE_PORT: String(environment.port),
    MAIN_SECRET: environment.mainSecret,
  };
}

function localBin(packageName: string, relativePath: string): string {
  return path.join(ROOT_DIR, "node_modules", packageName, relativePath);
}

async function runPlaywright(
  environment: Environment,
  options: Options,
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    localBin("@playwright/test", "cli.js"),
    "test",
    "e2e/e2e.spec.ts",
    "--config",
    "playwright.config.ts",
  ];
  if (options.debug) args.push("--debug");
  if (options.headed) args.push("--headed");
  if (options.ui) args.push("--ui");
  if (options.workers) args.push(`--workers=${options.workers}`);

  await runCommand({
    args,
    env: {
      ...process.env,
      INSIGHTFLARE_E2E_ADMIN_PASSWORD: environment.adminPassword,
      INSIGHTFLARE_E2E_ARCHIVE_BUCKET: environment.archiveBucketName,
      INSIGHTFLARE_E2E_ARTIFACTS: path.join(
        environment.directory,
        "artifacts",
        "playwright",
      ),
      INSIGHTFLARE_E2E_CONTROL_TOKEN: environment.controlToken,
      INSIGHTFLARE_E2E_BASE_URL: environment.baseURL,
      INSIGHTFLARE_E2E_CONFIG_PATH: environment.configPath,
      INSIGHTFLARE_E2E_D1_NAME: workerName(environment.id),
      INSIGHTFLARE_E2E_MANIFEST: path.join(
        environment.directory,
        "manifest",
        "seed.json",
      ),
      INSIGHTFLARE_E2E_PERSISTENCE_PATH: environment.persistencePath,
      INSIGHTFLARE_E2E_NOW_MS: String(environment.nowMs),
      INSIGHTFLARE_E2E_MOCK_CONTROL_TOKEN: environment.mockControlToken,
      INSIGHTFLARE_E2E_RUN_ID: environment.id,
      INSIGHTFLARE_E2E_TEST_SITE_URL: environment.testSiteURL,
    },
    logPath: path.join(environment.directory, "logs", "playwright.log"),
    name: "Playwright",
    showOutput: true,
    signal,
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  let worker: StartedProcess | null = null;
  let testSite: StartedTestSite | null = null;
  let environment: Environment | null = null;
  let failure: unknown = null;
  let succeeded = false;
  const startedAt = Date.now();
  const shutdown = new AbortController();
  const requestShutdown = (signal: NodeJS.Signals) => {
    if (shutdown.signal.aborted) return;
    rlog.warn(`Received ${signal}; stopping E2E services...`);
    shutdown.abort(interruptionError(signal));
    void stopTestSite(testSite);
    void stopProcess(worker);
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    rlog.info("InsightFlare E2E");
    const activeEnvironment = await createEnvironment(options);
    environment = activeEnvironment;
    throwIfAborted(shutdown.signal);
    rlog.info("Preparing isolated E2E environment...");
    rlog.progress(0, PREPARATION_PROGRESS_MAX);
    rlog.file.info(`E2E run: ${activeEnvironment.id}`);
    rlog.file.info(`E2E state: ${activeEnvironment.persistencePath}`);

    const env = workerEnvironment(activeEnvironment);
    const updateMigrationProgress = createMigrationProgress(
      await migrationFileCount(),
    );
    await runPreparationStep("Applying D1 migrations", () =>
      runCommand({
        args: [
          localBin("wrangler", "bin/wrangler.js"),
          "d1",
          "migrations",
          "apply",
          workerName(activeEnvironment.id),
          "--config",
          activeEnvironment.configPath,
          "--local",
          "--persist-to",
          activeEnvironment.persistencePath,
        ],
        env,
        logPath: path.join(
          activeEnvironment.directory,
          "logs",
          "migrations.log",
        ),
        name: "D1 migrations",
        onOutput: updateMigrationProgress.update,
        signal: shutdown.signal,
      }),
    );
    if (!updateMigrationProgress.complete()) {
      rlog.progress(MIGRATION_PROGRESS_MAX, PREPARATION_PROGRESS_MAX);
    }
    await runPreparationStep("Building tracker SDK", () =>
      runCommand({
        args: [
          localBin("tsx", "dist/cli.mjs"),
          path.join(ROOT_DIR, "scripts", "build-tracker-sdk.ts"),
        ],
        env,
        logPath: path.join(
          activeEnvironment.directory,
          "logs",
          "tracker-build.log",
        ),
        name: "tracker build",
        signal: shutdown.signal,
      }),
    );
    rlog.progress(TRACKER_BUILD_PROGRESS, PREPARATION_PROGRESS_MAX);
    await runPreparationStep("Starting local Worker", async () => {
      const startedWorker = await startProcess({
        args: [localBin("vite", "bin/vite.js"), "dev", "--mode", "development"],
        env,
        logPath: path.join(activeEnvironment.directory, "logs", "worker.log"),
        name: "E2E worker",
      });
      worker = startedWorker;
      await waitForReady(
        activeEnvironment.baseURL,
        startedWorker,
        shutdown.signal,
      );
      await initializeE2eClock(activeEnvironment);
    });
    throwIfAborted(shutdown.signal);
    testSite = await runPreparationStep("Starting E2E test site", () =>
      startTestSite(
        activeEnvironment.baseURL,
        activeEnvironment.testSitePort,
        activeEnvironment.mockControlToken,
      ),
    );
    if (testSite.url !== activeEnvironment.testSiteURL) {
      throw new Error("E2E test site started on an unexpected port.");
    }
    await runPreparationStep("Verifying E2E test services", () =>
      verifyTestServices(activeEnvironment),
    );
    throwIfAborted(shutdown.signal);
    await writeRunManifest(activeEnvironment, options);
    rlog.progress(PREPARATION_PROGRESS_MAX, PREPARATION_PROGRESS_MAX);
    rlog.success("Test environment is ready.");
    rlog.info("Running Playwright E2E...");
    await runPlaywright(activeEnvironment, options, shutdown.signal);
    throwIfAborted(shutdown.signal);
    succeeded = true;
    rlog.success(
      `E2E passed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s.`,
    );
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    await stopTestSite(testSite);
    await stopProcess(worker);
    if (environment) {
      if (succeeded && !options.keep) {
        await fs.rm(environment.directory, { force: true, recursive: true });
      } else {
        await writeFailureSummary(
          environment,
          failure ?? new Error("E2E did not complete successfully."),
        );
        rlog.info(`E2E run directory retained: ${environment.directory}`);
      }
    }
  }
}

main().catch((error: unknown) => {
  rlog.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
