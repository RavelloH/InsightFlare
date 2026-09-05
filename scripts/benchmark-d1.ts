#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const ROOT_DIR = resolve(import.meta.dirname, "..");
const DAY_MS = 86_400_000;

export type BenchmarkCase = "scoped" | "pages-tabs" | "hourly" | "scheduled";
export type BenchmarkMode = "local" | "remote-readonly";
export type SiteSample = "high" | "medium" | "low";

interface QueryWindow {
  readonly startMs: number;
  readonly endExclusiveMs: number;
}

interface SqlCaseContext {
  readonly siteId?: string;
  readonly window: QueryWindow;
}

interface SqlCaseDefinition {
  readonly description: string;
  readonly requiresSiteId: boolean;
  readonly buildSql: (context: SqlCaseContext) => string;
}

interface CliOptions {
  readonly caseName: BenchmarkCase;
  readonly mode: BenchmarkMode;
  readonly sample: SiteSample;
  readonly databaseName?: string;
  readonly environmentName?: string;
  readonly configPath?: string;
  readonly iterations: number;
  readonly warmup: number;
  readonly windowStart?: string;
  readonly windowEnd?: string;
  readonly siteId?: string;
  readonly sql?: string;
  readonly help: boolean;
}

interface ExecutionResult {
  readonly rows: readonly unknown[];
  readonly rowsRead: number;
  readonly sqlDurationMs: number;
  readonly wallTimeMs: number;
  readonly statementCount: number;
}

interface MetricSummary {
  readonly mean: number;
  readonly median: number;
  readonly p95: number;
  readonly p99: number;
}

interface BenchmarkReport {
  readonly case: BenchmarkCase;
  readonly mode: BenchmarkMode;
  readonly sample: SiteSample | null;
  readonly iterations: number;
  readonly warmup: number;
  readonly rowsRead: number;
  readonly sqlDurationMs: number;
  readonly wallTimeMs: number;
  readonly statementCount: number;
  readonly resultHash: string;
  readonly resultHashStable: boolean;
  readonly metrics: {
    readonly rowsRead: MetricSummary;
    readonly sqlDurationMs: MetricSummary;
    readonly wallTimeMs: MetricSummary;
    readonly statementCount: MetricSummary;
  };
  readonly windowStart: string;
  readonly windowEnd: string;
}

interface WranglerOptions {
  readonly databaseName: string;
  readonly environmentName?: string;
  readonly configPath?: string;
}

/**
 * # D1 benchmark case registry
 *
 * These probes intentionally do not import Worker query builders. Those
 * builders need request-scoped filters, bindings, and runtime context that a
 * standalone CLI cannot safely recreate. Each case below is therefore a
 * fixed, read-only SQL shape against the current migrated schema.
 *
 * `scoped`, `pages-tabs`, and `hourly` use an explicit site id when supplied
 * with `--site-id` (or `D1_BENCHMARK_SITE_ID`). Otherwise the CLI
 * selects one deterministic high/medium/low traffic sample with one
 * read-only query before timing; it never invents an id or inserts data.
 * `scheduled` reads the scheduler run table and does not need a site id.
 *
 * A fixed probe can be supplied with `--sql`. It may use the SQL-literal
 * placeholders `{{site_id}}`, `{{window_start_ms}}`, `{{window_end_ms}}`,
 * `{{window_start_s}}`, and `{{window_end_s}}`. No `?` bindings or multiple
 * statements are accepted. Remote mode additionally requires the final SQL
 * statement to be SELECT or EXPLAIN (query-plan SELECT).
 */

export const D1_BENCHMARK_CASES: Readonly<
  Record<BenchmarkCase, SqlCaseDefinition>
> = {
  scoped: {
    description: "site-scoped visit summary over the selected window",
    requiresSiteId: true,
    buildSql: ({ siteId, window }) => `
SELECT
  COUNT(*) AS views,
  COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors,
  COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions
FROM visits
WHERE site_pk = (
  SELECT site_pk
  FROM site_identities
  WHERE site_id = ${sqlText(requireSiteId(siteId))}
)
  AND started_at >= ${sqlInteger(window.startMs)}
  AND started_at < ${sqlInteger(window.endExclusiveMs)}
`,
  },
  "pages-tabs": {
    description: "page rows and page-tab aggregates over the selected window",
    requiresSiteId: true,
    buildSql: ({ siteId, window }) => `
WITH filtered_visits AS MATERIALIZED (
  SELECT
    pathname,
    query_string,
    hash_fragment,
    session_id,
    visitor_id,
    started_at,
    visit_id,
    TRIM(COALESCE(title, '')) AS title,
    TRIM(COALESCE(hostname, '')) AS hostname
  FROM visits
  WHERE site_pk = (
    SELECT site_pk
    FROM site_identities
    WHERE site_id = ${sqlText(requireSiteId(siteId))}
  )
    AND started_at >= ${sqlInteger(window.startMs)}
    AND started_at < ${sqlInteger(window.endExclusiveMs)}
),
page_rows AS (
  SELECT
    'page' AS row_type,
    '' AS card_type,
    pathname AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  GROUP BY pathname, query_string, hash_fragment
),
card_rows AS (
  SELECT 'path' AS card_type, pathname AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE TRIM(COALESCE(pathname, '')) != ''
  GROUP BY pathname
  UNION ALL
  SELECT 'title' AS card_type, title AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE title != ''
  GROUP BY title
  UNION ALL
  SELECT 'hostname' AS card_type, hostname AS value,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits
  WHERE hostname != ''
  GROUP BY hostname
),
ranked_cards AS (
  SELECT card_type, value, views, sessions, visitors,
    ROW_NUMBER() OVER (
      PARTITION BY card_type
      ORDER BY views DESC, sessions DESC, value ASC
    ) AS card_rank
  FROM card_rows
)
SELECT row_type, card_type, value, views, sessions, visitors
FROM page_rows
UNION ALL
SELECT 'tab' AS row_type, card_type, value, views, sessions, visitors
FROM ranked_cards
WHERE card_rank <= 100
ORDER BY row_type ASC, card_type ASC, views DESC, sessions DESC, value ASC
`,
  },
  hourly: {
    description: "hourly visit aggregation over the selected window",
    requiresSiteId: true,
    buildSql: ({ siteId, window }) => `
SELECT
  CAST(started_at / 3600000 AS INTEGER) AS hour_bucket,
  COUNT(*) AS views,
  COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
  COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors,
  COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS duration_ms_sum,
  COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS duration_ms_count
FROM visits
WHERE site_pk = (
  SELECT site_pk
  FROM site_identities
  WHERE site_id = ${sqlText(requireSiteId(siteId))}
)
  AND started_at >= ${sqlInteger(window.startMs)}
  AND started_at < ${sqlInteger(window.endExclusiveMs)}
  AND status != 'open'
GROUP BY hour_bucket
ORDER BY hour_bucket ASC
`,
  },
  scheduled: {
    description: "scheduled-task run aggregates over the selected window",
    requiresSiteId: false,
    buildSql: ({ window }) => `
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
WHERE started_at_ms >= ${sqlInteger(window.startMs)}
  AND started_at_ms < ${sqlInteger(window.endExclusiveMs)}
GROUP BY task_key
ORDER BY task_key ASC
`,
  },
};

function requireSiteId(siteId: string | undefined): string {
  if (!siteId) {
    throw new Error(
      "This benchmark case requires a fixed site id; pass --site-id or INSIGHTFLARE_BENCHMARK_SITE_ID.",
    );
  }
  return siteId;
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlInteger(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Expected a safe integer SQL value, received ${value}.`);
  }
  return String(value);
}

function parseCase(value: string): BenchmarkCase {
  if (
    value === "scoped" ||
    value === "pages-tabs" ||
    value === "hourly" ||
    value === "scheduled"
  ) {
    return value;
  }
  throw new Error(
    `Unsupported --case value: ${value}. Expected scoped, pages-tabs, hourly, or scheduled.`,
  );
}

function parseMode(value: string): BenchmarkMode {
  if (value === "local" || value === "remote-readonly") return value;
  throw new Error(
    `Unsupported --mode value: ${value}. Expected local or remote-readonly.`,
  );
}

function parseSiteSample(value: string): SiteSample {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  throw new Error(
    `Unsupported --sample value: ${value}. Expected high, medium, or low.`,
  );
}

function parseCount(
  value: string,
  optionName: string,
  minimum: number,
): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${optionName} must be a non-negative integer.`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < minimum) {
    throw new Error(`${optionName} must be at least ${minimum}.`);
  }
  return count;
}

function optionValue(
  argv: readonly string[],
  index: number,
  optionName: string,
  inlineValue: string | undefined,
): { readonly value: string; readonly nextIndex: number } {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) {
      throw new Error(`${optionName} requires a value.`);
    }
    return { value: inlineValue, nextIndex: index };
  }
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return { value: next, nextIndex: index + 1 };
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let caseName: BenchmarkCase = "scoped";
  let mode: BenchmarkMode = "local";
  let sample: SiteSample = "high";
  let databaseName: string | undefined;
  let environmentName: string | undefined;
  let configPath: string | undefined;
  let iterations = 5;
  let warmup = 3;
  let windowStart: string | undefined;
  let windowEnd: string | undefined;
  let siteId: string | undefined;
  let sql: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const separator = argument.indexOf("=");
    const optionName =
      separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue =
      separator === -1 ? undefined : argument.slice(separator + 1);

    if (
      optionName !== "--case" &&
      optionName !== "--mode" &&
      optionName !== "--sample" &&
      optionName !== "--database" &&
      optionName !== "--env" &&
      optionName !== "--config" &&
      optionName !== "--iterations" &&
      optionName !== "--warmup" &&
      optionName !== "--window-start" &&
      optionName !== "--window-end" &&
      optionName !== "--site-id" &&
      optionName !== "--sql"
    ) {
      throw new Error(`Unknown option: ${optionName}`);
    }

    const parsed = optionValue(argv, index, optionName, inlineValue);
    index = parsed.nextIndex;
    switch (optionName) {
      case "--case":
        caseName = parseCase(parsed.value);
        break;
      case "--mode":
        mode = parseMode(parsed.value);
        break;
      case "--sample":
        sample = parseSiteSample(parsed.value);
        break;
      case "--database":
        databaseName = parsed.value.trim();
        if (!databaseName)
          throw new Error("--database requires a non-empty value.");
        break;
      case "--env":
        environmentName = parsed.value.trim();
        if (!environmentName)
          throw new Error("--env requires a non-empty value.");
        break;
      case "--config":
        configPath = parsed.value.trim();
        if (!configPath)
          throw new Error("--config requires a non-empty value.");
        break;
      case "--iterations":
        iterations = parseCount(parsed.value, "--iterations", 1);
        break;
      case "--warmup":
        warmup = parseCount(parsed.value, "--warmup", 0);
        break;
      case "--window-start":
        windowStart = parsed.value;
        break;
      case "--window-end":
        windowEnd = parsed.value;
        break;
      case "--site-id":
        siteId = parsed.value.trim();
        if (!siteId) throw new Error("--site-id requires a non-empty value.");
        break;
      case "--sql":
        sql = parsed.value;
        break;
    }
  }

  return {
    caseName,
    mode,
    sample,
    databaseName:
      databaseName || process.env.D1_BENCHMARK_DATABASE?.trim() || undefined,
    environmentName:
      environmentName || process.env.D1_BENCHMARK_ENV?.trim() || undefined,
    configPath:
      configPath || process.env.D1_BENCHMARK_CONFIG?.trim() || undefined,
    iterations,
    warmup,
    windowStart,
    windowEnd,
    siteId:
      siteId ||
      process.env.D1_BENCHMARK_SITE_ID?.trim() ||
      process.env.INSIGHTFLARE_BENCHMARK_SITE_ID?.trim(),
    sql,
    help,
  };
}

function parseBoundary(value: string, optionName: string): number {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${optionName} requires a non-empty value.`);

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const timestamp = Date.parse(`${normalized}T00:00:00.000Z`);
    if (
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== normalized
    ) {
      throw new Error(`${optionName} is not a valid UTC date: ${value}`);
    }
    return timestamp;
  }

  const timestamp = Date.parse(normalized);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error(
      `${optionName} must be YYYY-MM-DD or an ISO-8601 timestamp: ${value}`,
    );
  }
  return timestamp;
}

function defaultWindow(nowMs = Date.now()): QueryWindow {
  const now = new Date(nowMs);
  const endExclusiveMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return { startMs: endExclusiveMs - 7 * DAY_MS, endExclusiveMs };
}

function resolveWindow(options: CliOptions): QueryWindow {
  const defaults = defaultWindow();
  const startMs = options.windowStart
    ? parseBoundary(options.windowStart, "--window-start")
    : options.windowEnd
      ? parseBoundary(options.windowEnd, "--window-end") - 7 * DAY_MS
      : defaults.startMs;
  const endExclusiveMs = options.windowEnd
    ? parseBoundary(options.windowEnd, "--window-end")
    : defaults.endExclusiveMs;

  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endExclusiveMs)) {
    throw new Error("Window boundaries must be safe integer timestamps.");
  }
  if (endExclusiveMs <= startMs) {
    throw new Error("Window end must be after window start.");
  }
  return { startMs, endExclusiveMs };
}

function renderSqlTemplate(template: string, context: SqlCaseContext): string {
  const values: Record<string, string> = {
    window_start_ms: sqlInteger(context.window.startMs),
    window_end_ms: sqlInteger(context.window.endExclusiveMs),
    window_start_s: sqlInteger(Math.floor(context.window.startMs / 1000)),
    window_end_s: sqlInteger(Math.floor(context.window.endExclusiveMs / 1000)),
  };
  if (context.siteId) values.site_id = sqlText(context.siteId);

  const unresolved = new Set<string>();
  const rendered = template.replaceAll(
    /\{\{([a-z0-9_]+)\}\}/gi,
    (_match, name: string) => {
      const value = values[name.toLowerCase()];
      if (value === undefined) {
        unresolved.add(name);
        return _match;
      }
      return value;
    },
  );
  if (unresolved.size > 0) {
    throw new Error(
      `Unknown or unavailable SQL placeholder(s): ${[...unresolved].join(", ")}.`,
    );
  }
  return rendered.trim();
}

function stripLeadingSqlTrivia(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    while (/\s/.test(sql[index] ?? "")) index += 1;
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1)
        throw new Error("SQL contains an unterminated block comment.");
      index = end + 2;
      continue;
    }
    break;
  }
  return sql.slice(index);
}

function hasTopLevelSemicolon(sql: string): boolean {
  let quote: "'" | '"' | "`" | null = null;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (quote) {
      if (character === quote) {
        if (next === quote) {
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1)
        throw new Error("SQL contains an unterminated block comment.");
      index = end + 2;
      continue;
    }
    if (character === ";") return true;
    index += 1;
  }
  return false;
}

function topLevelSqlKeywords(sql: string): string[] {
  const keywords: string[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (quote) {
      if (character === quote) {
        if (next === quote) {
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1)
        throw new Error("SQL contains an unterminated block comment.");
      index = end + 2;
      continue;
    }
    if (character === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth === 0 && /[a-z_]/i.test(character)) {
      const match = sql.slice(index).match(/^[a-z_][a-z0-9_]*/i);
      if (match) {
        keywords.push(match[0].toLowerCase());
        index += match[0].length;
        continue;
      }
    }
    index += 1;
  }
  return keywords;
}

function isReadOnlySelect(sql: string): boolean {
  const keywords = topLevelSqlKeywords(sql);
  if (keywords[0] === "select") return true;
  if (keywords[0] !== "with") return false;
  const statementKeyword = keywords.find((keyword, index) => {
    if (index === 0) return false;
    return ["select", "insert", "update", "delete", "replace"].includes(
      keyword,
    );
  });
  return statementKeyword === "select";
}

function validateReadOnlySql(sql: string): void {
  if (!sql || sql.includes("\0")) {
    throw new Error("SQL must be non-empty and must not contain NUL bytes.");
  }
  if (sql.includes("?")) {
    throw new Error(
      "SQL bindings are not supported by this CLI; use fixed literals or the documented {{...}} placeholders.",
    );
  }
  if (hasTopLevelSemicolon(sql)) {
    throw new Error(
      "Only one SQL statement is allowed; semicolons are rejected.",
    );
  }

  const statement = stripLeadingSqlTrivia(sql);
  const keyword = statement.match(/^([a-z]+)/i)?.[1]?.toLowerCase();
  if (isReadOnlySelect(statement)) return;
  if (keyword === "explain") {
    const explainBody = stripLeadingSqlTrivia(
      statement.slice("explain".length),
    );
    const queryPlanBody = explainBody.replace(/^query\s+plan\s+/i, "");
    if (isReadOnlySelect(queryPlanBody)) return;
  }
  throw new Error(
    "Only SELECT or EXPLAIN SELECT statements are allowed for a D1 benchmark.",
  );
}

function buildSql(options: CliOptions, window: QueryWindow): string {
  const context: SqlCaseContext = { siteId: options.siteId, window };
  const definition = D1_BENCHMARK_CASES[options.caseName];
  if (!options.sql && definition.requiresSiteId && !options.siteId) {
    throw new Error(
      `Case ${options.caseName} requires a fixed site id; pass --site-id or INSIGHTFLARE_BENCHMARK_SITE_ID.`,
    );
  }
  const sql = options.sql
    ? renderSqlTemplate(options.sql, context)
    : definition.buildSql(context);
  validateReadOnlySql(sql);
  return sql;
}

function toFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function roundedMilliseconds(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

function metricSummary(values: readonly number[]): MetricSummary {
  if (values.length === 0) {
    throw new Error("At least one timed benchmark iteration is required.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ??
    0;
  const mean =
    values.reduce((total, value) => total + value, 0) / values.length;
  const median = percentile(0.5);
  return {
    mean: roundedMilliseconds(mean),
    median: roundedMilliseconds(median),
    p95: roundedMilliseconds(percentile(0.95)),
    p99: roundedMilliseconds(percentile(0.99)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValueFromStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Wrangler returned empty JSON output.");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const candidates = [
      [trimmed.indexOf("["), trimmed.lastIndexOf("]")],
      [trimmed.indexOf("{"), trimmed.lastIndexOf("}")],
    ];
    for (const [start, end] of candidates) {
      if (start < 0 || end <= start) continue;
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      } catch {
        // Try the next JSON-shaped candidate without echoing command output.
      }
    }
  }
  throw new Error("Wrangler --json output was not valid JSON.");
}

function parseWranglerResult(stdout: string): {
  readonly rows: readonly unknown[];
  readonly rowsRead: number;
  readonly sqlDurationMs: number;
  readonly statementCount: number;
} {
  const parsed = jsonValueFromStdout(stdout);
  const potentialEnvelopes = Array.isArray(parsed) ? parsed : [parsed];
  const envelopes = potentialEnvelopes.filter(
    (value): value is Record<string, unknown> =>
      isRecord(value) &&
      ("results" in value || "success" in value || "meta" in value),
  );
  if (envelopes.length === 0) {
    return {
      rows: Array.isArray(parsed) ? parsed : [parsed],
      rowsRead: Array.isArray(parsed) ? parsed.length : 1,
      sqlDurationMs: 0,
      statementCount: 1,
    };
  }

  const rows: unknown[] = [];
  let rowsRead = 0;
  let hasRowsRead = false;
  let sqlDurationMs = 0;
  for (const envelope of envelopes) {
    if (envelope.success === false) {
      throw new Error("Wrangler reported an unsuccessful D1 statement.");
    }
    const envelopeRows = envelope.results;
    if (Array.isArray(envelopeRows)) rows.push(...envelopeRows);
    const meta = isRecord(envelope.meta) ? envelope.meta : envelope;
    const metaRowsRead =
      toFiniteNumber(meta.rows_read) ?? toFiniteNumber(meta.rowsRead);
    if (metaRowsRead !== undefined) {
      rowsRead += Math.max(0, Math.trunc(metaRowsRead));
      hasRowsRead = true;
    }
    const duration =
      toFiniteNumber(meta.duration) ??
      toFiniteNumber(meta.duration_ms) ??
      toFiniteNumber(meta.durationMs);
    if (duration !== undefined) sqlDurationMs += Math.max(0, duration);
  }

  return {
    rows,
    rowsRead: hasRowsRead ? rowsRead : rows.length,
    sqlDurationMs: roundedMilliseconds(sqlDurationMs),
    statementCount: Math.max(1, envelopes.length),
  };
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return String(value);
}

function hashRows(rows: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(rows)))
    .digest("hex");
}

function runWrangler(
  sql: string,
  mode: BenchmarkMode,
  options: WranglerOptions,
): Promise<ExecutionResult> {
  // Invoke Wrangler's local JS entry point directly. This keeps the benchmark
  // independent of a globally installed CLI and avoids Windows shell quoting
  // differences for multi-line SQL.
  const executable = process.execPath;
  const wranglerEntry = resolve(
    ROOT_DIR,
    "node_modules/wrangler/bin/wrangler.js",
  );
  const args = ["d1", "execute", options.databaseName];
  if (options.configPath) args.push("--config", options.configPath);
  if (options.environmentName) args.push("--env", options.environmentName);
  if (mode === "remote-readonly") {
    args.push("--remote");
  } else {
    args.push("--local");
  }
  args.push("--json", "--command", sql);

  const startedAt = performance.now();
  return new Promise<ExecutionResult>((resolve, reject) => {
    const child = spawn(executable, [wranglerEntry, ...args], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error: Error) => reject(error));
    child.once("close", (code: number | null) => {
      if (code !== 0) {
        const details = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            `Wrangler D1 execute failed with exit code ${code ?? 1}${
              details ? `: ${details.slice(-4000)}` : "."
            }`,
          ),
        );
        return;
      }
      try {
        const parsed = parseWranglerResult(
          Buffer.concat(stdout).toString("utf8"),
        );
        resolve({
          ...parsed,
          wallTimeMs: roundedMilliseconds(performance.now() - startedAt),
        });
      } catch (error: unknown) {
        reject(error);
      }
    });
  });
}

async function resolveSiteSample(
  mode: BenchmarkMode,
  sample: SiteSample,
  window: QueryWindow,
  options: WranglerOptions,
): Promise<string> {
  const order =
    sample === "high"
      ? "visitCount DESC, site_id ASC"
      : sample === "low"
        ? "visitCount ASC, site_id ASC"
        : "ABS(siteRank - (siteCount + 1) / 2.0), visitCount DESC, site_id ASC";
  const result = await runWrangler(
    `
WITH site_counts AS (
  SELECT site_pk, COUNT(*) AS visitCount
  FROM visits
  WHERE started_at >= ${sqlInteger(window.startMs)}
    AND started_at < ${sqlInteger(window.endExclusiveMs)}
  GROUP BY site_pk
), ranked_sites AS (
  SELECT
    site_pk,
    visitCount,
    ROW_NUMBER() OVER (ORDER BY visitCount DESC, site_pk ASC) AS siteRank,
    COUNT(*) OVER () AS siteCount
  FROM site_counts
)
SELECT si.site_id
FROM ranked_sites rs
INNER JOIN site_identities si ON si.site_pk = rs.site_pk
ORDER BY ${order}
LIMIT 1
`,
    mode,
    options,
  );
  const row = result.rows[0];
  if (!isRecord(row)) {
    throw new Error(
      `No site sample was found for the selected UTC window (${sample}).`,
    );
  }
  const siteId = row.site_id ?? row.siteId;
  if (typeof siteId !== "string" || siteId.trim().length === 0) {
    throw new Error("The selected site sample did not contain a site id.");
  }
  return siteId;
}

function usage(): string {
  return `Usage: npm run bench:d1 -- [options]

Options:
  --case scoped|pages-tabs|hourly|scheduled  Benchmark case (default: scoped)
  --mode local|remote-readonly               Execution mode (default: local)
  --sample high|medium|low                   Automatic site sample (default: high)
  --database VALUE                            D1 database name (required; or D1_BENCHMARK_DATABASE)
  --env VALUE                                 Wrangler environment (or D1_BENCHMARK_ENV)
  --config PATH                               Wrangler config path (or D1_BENCHMARK_CONFIG)
  --iterations N                             Timed iterations (default: 5)
  --warmup N                                 Warmup iterations (default: 3)
  --window-start VALUE                       Inclusive UTC date/timestamp
  --window-end VALUE                         Exclusive UTC date/timestamp
  --site-id VALUE                            Fixed site id for site-scoped cases
  --sql VALUE                                Fixed SELECT/EXPLAIN SQL override
  --help                                     Show this help

Examples:
  npm run bench:d1 -- --database <d1-name> --case scoped
  npm run bench:d1 -- --database <d1-name> --env <wrangler-env> --mode remote-readonly --case hourly

Remote mode is read-only and never prints result rows.\n`;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const window = resolveWindow(options);
  const databaseName = options.databaseName;
  if (!databaseName) {
    throw new Error(
      "A D1 database name is required; pass --database or set D1_BENCHMARK_DATABASE.",
    );
  }
  const wranglerOptions: WranglerOptions = {
    databaseName,
    ...(options.environmentName
      ? { environmentName: options.environmentName }
      : {}),
    ...(options.configPath ? { configPath: options.configPath } : {}),
  };
  const definition = D1_BENCHMARK_CASES[options.caseName];
  const usesAutomaticSample =
    !options.siteId &&
    definition.requiresSiteId &&
    (!options.sql || options.sql.includes("{{site_id}}"));
  const siteId = usesAutomaticSample
    ? await resolveSiteSample(
        options.mode,
        options.sample,
        window,
        wranglerOptions,
      )
    : options.siteId;
  const sql = buildSql({ ...options, siteId }, window);

  for (let index = 0; index < options.warmup; index += 1) {
    await runWrangler(sql, options.mode, wranglerOptions);
  }

  const rowsReadSamples: number[] = [];
  const sqlDurationSamples: number[] = [];
  const wallTimeSamples: number[] = [];
  const statementCountSamples: number[] = [];
  const resultHashes: string[] = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const result = await runWrangler(sql, options.mode, wranglerOptions);
    rowsReadSamples.push(result.rowsRead);
    sqlDurationSamples.push(result.sqlDurationMs);
    wallTimeSamples.push(result.wallTimeMs);
    statementCountSamples.push(result.statementCount);
    resultHashes.push(hashRows(result.rows));
  }

  const rowsRead = metricSummary(rowsReadSamples);
  const sqlDurationMs = metricSummary(sqlDurationSamples);
  const wallTimeMs = metricSummary(wallTimeSamples);
  const statementCount = metricSummary(statementCountSamples);
  const report: BenchmarkReport = {
    case: options.caseName,
    mode: options.mode,
    sample: usesAutomaticSample ? options.sample : null,
    iterations: options.iterations,
    warmup: options.warmup,
    rowsRead: rowsRead.median,
    sqlDurationMs: sqlDurationMs.median,
    wallTimeMs: wallTimeMs.median,
    statementCount: statementCount.median,
    resultHash: resultHashes[0] ?? "",
    resultHashStable: resultHashes.every((hash) => hash === resultHashes[0]),
    metrics: {
      rowsRead,
      sqlDurationMs,
      wallTimeMs,
      statementCount,
    },
    windowStart: new Date(window.startMs).toISOString(),
    windowEnd: new Date(window.endExclusiveMs).toISOString(),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`benchmark-d1: ${message}\n`);
  process.exitCode = 1;
});
