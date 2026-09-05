#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DEFAULT_FIXTURE_ROWS = 50_000;
const DEFAULT_WARMUP = 3;
const DEFAULT_ITERATIONS = 5;

const QUERY = `
SELECT
  task_key,
  COUNT(*) AS total_runs,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_runs,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
  SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial_runs,
  SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_runs,
  SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_runs,
  AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) AS avg_duration_ms
FROM scheduled_task_runs
WHERE started_at_ms >= ?
  AND started_at_ms < ?
GROUP BY task_key
ORDER BY task_key ASC
`;

const START_MS = Date.UTC(2026, 0, 1);
const END_MS = START_MS + 7 * DAY_MS;

type VariantName = "current" | "started-at-task" | "task-started-desc";

interface Variant {
  readonly name: VariantName;
  readonly indexSql: string;
  readonly indexName: string;
}

interface VariantResult {
  readonly name: VariantName;
  readonly indexName: string;
  readonly fixtureRows: number;
  readonly writeMs: number;
  readonly meanMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly resultHash: string;
  readonly plan: readonly string[];
  readonly usesConfiguredIndex: boolean;
}

const VARIANTS: readonly Variant[] = [
  {
    name: "current",
    indexName: "idx_scheduled_task_runs_task_started",
    indexSql:
      "CREATE INDEX idx_scheduled_task_runs_task_started ON scheduled_task_runs(task_key, started_at_ms)",
  },
  {
    name: "started-at-task",
    indexName: "idx_bench_scheduled_started_task",
    indexSql:
      "CREATE INDEX idx_bench_scheduled_started_task ON scheduled_task_runs(started_at_ms, task_key)",
  },
  {
    name: "task-started-desc",
    indexName: "idx_bench_scheduled_task_started_desc",
    indexSql:
      "CREATE INDEX idx_bench_scheduled_task_started_desc ON scheduled_task_runs(task_key, started_at_ms DESC)",
  },
];

function parseCount(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return count;
}

function parseOptions(argv: readonly string[]): {
  readonly rows: number;
  readonly warmup: number;
  readonly iterations: number;
  readonly help: boolean;
} {
  let rows = DEFAULT_FIXTURE_ROWS;
  let warmup = DEFAULT_WARMUP;
  let iterations = DEFAULT_ITERATIONS;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue =
      separator === -1 ? undefined : argument.slice(separator + 1);
    if (name !== "--rows" && name !== "--warmup" && name !== "--iterations") {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }
    if (name === "--rows") rows = parseCount(value, name);
    if (name === "--warmup") warmup = Number(value);
    if (name === "--iterations") iterations = parseCount(value, name);
  }
  if (!Number.isSafeInteger(warmup) || warmup < 0) {
    throw new Error("--warmup must be a non-negative integer.");
  }
  return { rows, warmup, iterations, help };
}

function setupDatabase(variant: Variant, fixtureRows: number): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE scheduled_task_runs (
      id TEXT PRIMARY KEY,
      task_key TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      duration_ms INTEGER,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_scheduled_task_runs_status_started
      ON scheduled_task_runs(status, started_at_ms);
    CREATE INDEX idx_scheduled_task_runs_expires_at
      ON scheduled_task_runs(expires_at);
    ${variant.indexSql};
  `);
  const insert = database.prepare(
    "INSERT INTO scheduled_task_runs (id, task_key, status, started_at_ms, duration_ms, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const statuses = ["success", "failed", "partial", "skipped", "running"];
  const tasks = ["hourly", "daily", "cleanup", "retention", "archive"];
  for (let index = 0; index < fixtureRows; index += 1) {
    const task = tasks[index % tasks.length] ?? "hourly";
    const status = statuses[index % statuses.length] ?? "success";
    const startedAt = START_MS + (index % ((10 * DAY_MS) / HOUR_MS)) * HOUR_MS;
    insert.run(
      `fixture-${variant.name}-${index}`,
      task,
      status,
      startedAt,
      status === "running" ? null : (index % 13) * 100,
      Math.floor((startedAt + 30 * DAY_MS) / 1000),
    );
  }
  return database;
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return String(value);
}

function resultHash(rows: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(rows)))
    .digest("hex");
}

function rounded(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ??
    0
  );
}

function benchmarkVariant(
  variant: Variant,
  fixtureRows: number,
  warmup: number,
  iterations: number,
): VariantResult {
  const writeStartedAt = performance.now();
  const database = setupDatabase(variant, fixtureRows);
  const writeMs = rounded(performance.now() - writeStartedAt);
  try {
    const statement = database.prepare(QUERY);
    const explain = database
      .prepare(`EXPLAIN QUERY PLAN ${QUERY}`)
      .all(START_MS, END_MS) as Array<{ detail: string }>;
    const plan = explain.map((row) => row.detail);
    const warmupStatement = statement;
    for (let index = 0; index < warmup; index += 1) {
      warmupStatement.all(START_MS, END_MS);
    }
    const durations: number[] = [];
    let rows: unknown[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      rows = warmupStatement.all(START_MS, END_MS) as unknown[];
      durations.push(performance.now() - startedAt);
    }
    const mean =
      durations.reduce((total, value) => total + value, 0) / durations.length;
    return {
      name: variant.name,
      indexName: variant.indexName,
      fixtureRows,
      writeMs,
      meanMs: rounded(mean),
      medianMs: rounded(percentile(durations, 0.5)),
      p95Ms: rounded(percentile(durations, 0.95)),
      resultHash: resultHash(rows),
      plan,
      usesConfiguredIndex: plan.some((detail) =>
        detail.includes(variant.indexName),
      ),
    };
  } finally {
    database.close();
  }
}

function usage(): string {
  return `Usage: npm run bench:d1:indexes -- [options]

Options:
  --rows N       In-memory scheduled-task fixture rows (default: ${DEFAULT_FIXTURE_ROWS})
  --warmup N     Warmup queries per variant (default: ${DEFAULT_WARMUP})
  --iterations N Timed queries per variant (default: ${DEFAULT_ITERATIONS})
  --help         Show this help

This experiment never opens the project's local D1 and never writes production data.
`;
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const results = VARIANTS.map((variant) =>
    benchmarkVariant(variant, options.rows, options.warmup, options.iterations),
  );
  const baseline = results[0];
  const comparison = results.map((result) => ({
    name: result.name,
    latencyReductionPct:
      baseline && baseline.medianMs > 0
        ? rounded((1 - result.medianMs / baseline.medianMs) * 100)
        : 0,
    writeOverheadPct:
      baseline && baseline.writeMs > 0
        ? rounded((result.writeMs / baseline.writeMs - 1) * 100)
        : 0,
    explainUsesIndex: result.usesConfiguredIndex,
    resultHashMatchesBaseline: result.resultHash === baseline?.resultHash,
    qualifiesForMigration: false,
  }));
  process.stdout.write(
    `${JSON.stringify({
      case: "scheduled-indexes",
      fixtureRows: options.rows,
      warmup: options.warmup,
      iterations: options.iterations,
      rowsRead: null,
      rowsReadNote: "Local SQLite fixture; D1 rows_read is unavailable.",
      migrationDecision:
        "hold: compare D1 rows_read before considering a production migration",
      variants: results,
      comparison,
    })}\n`,
  );
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`benchmark-scheduled-index: ${message}\n`);
  process.exitCode = 1;
}
