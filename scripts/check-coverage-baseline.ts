#!/usr/bin/env tsx

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Metric = "statements" | "branches" | "functions" | "lines";

type CoverageBaseline = {
  version: number;
  projects: Record<
    string,
    {
      summary: string;
      metrics: Record<Metric, number>;
    }
  >;
};

const root = resolve(import.meta.dirname, "..");
const baselinePath = resolve(root, ".github", "coverage-baseline.json");
const metrics: Metric[] = ["statements", "branches", "functions", "lines"];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metricPercent(summary: unknown, metric: Metric): number | null {
  if (!isRecord(summary) || !isRecord(summary.total)) return null;
  const entry = summary.total[metric];
  if (!isRecord(entry)) return null;
  const percent = Number(entry.pct);
  return Number.isFinite(percent) ? percent : null;
}

if (!existsSync(baselinePath)) {
  console.error(`Coverage baseline not found: ${baselinePath}`);
  process.exit(1);
}

const baseline = readJson(baselinePath) as Partial<CoverageBaseline>;
if (baseline.version !== 1 || !isRecord(baseline.projects)) {
  console.error(`Invalid coverage baseline: ${baselinePath}`);
  process.exit(1);
}

const failures: string[] = [];
for (const [project, definition] of Object.entries(baseline.projects)) {
  if (
    !isRecord(definition) ||
    typeof definition.summary !== "string" ||
    !isRecord(definition.metrics)
  ) {
    failures.push(`${project}: invalid baseline definition`);
    continue;
  }

  const summaryPath = resolve(root, definition.summary);
  if (!existsSync(summaryPath)) {
    failures.push(
      `${project}: coverage summary not found at ${definition.summary}`,
    );
    continue;
  }

  const summary = readJson(summaryPath);
  for (const metric of metrics) {
    const minimum = Number(definition.metrics[metric]);
    const actual = metricPercent(summary, metric);
    if (!Number.isFinite(minimum) || actual === null) {
      failures.push(`${project}.${metric}: missing or invalid coverage data`);
      continue;
    }
    if (actual + Number.EPSILON < minimum) {
      failures.push(
        `${project}.${metric}: ${actual.toFixed(2)}% is below baseline ${minimum.toFixed(2)}%`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Coverage baseline check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Coverage baseline check passed (${Object.keys(baseline.projects).length} projects).`,
);
