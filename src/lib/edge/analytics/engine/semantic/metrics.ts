import type { ComparisonMetricKey } from "@/lib/edge/analytics/contract/types";

import type { SemanticAttributeId } from "./attributes";
import type { LogicalValueType } from "./value-types";

export const SEMANTIC_METRIC_IDS = [
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDurationMs",
  "durationViews",
  "avgDurationMs",
  "bounceRate",
  "viewsPerSession",
  "events",
] as const;

export type SemanticMetricId = (typeof SEMANTIC_METRIC_IDS)[number];

/** Boundary mapping keeps the public comparison subset separate from engine IDs. */
export const COMPARISON_TO_SEMANTIC_METRIC = {
  views: "views",
  sessions: "sessions",
  visitors: "visitors",
  bounces: "bounces",
  totalDurationMs: "totalDurationMs",
  durationViews: "durationViews",
  avgDurationMs: "avgDurationMs",
  bounceRate: "bounceRate",
  viewsPerSession: "viewsPerSession",
  events: "events",
} as const satisfies Readonly<Record<ComparisonMetricKey, SemanticMetricId>>;
export type MetricVisibility = "public" | "internal";
export type MetricTimeGroupingPolicy =
  "occurrence" | "entity-first-observation" | "distinct-entity-per-bucket";

export type MetricFormula =
  | MetricReferenceFormula
  | LiteralFormula
  | AddFormula
  | SubtractFormula
  | MultiplyFormula
  | DivideFormula
  | RoundFormula;

export interface MetricReferenceFormula {
  readonly kind: "metric-reference";
  readonly metric: SemanticMetricId;
}

export interface LiteralFormula {
  readonly kind: "literal";
  readonly value: number | null;
}

export interface AddFormula {
  readonly kind: "add";
  readonly left: MetricFormula;
  readonly right: MetricFormula;
}

export interface SubtractFormula {
  readonly kind: "subtract";
  readonly left: MetricFormula;
  readonly right: MetricFormula;
}

export interface MultiplyFormula {
  readonly kind: "multiply";
  readonly left: MetricFormula;
  readonly right: MetricFormula;
}

export interface DivideFormula {
  readonly kind: "divide";
  readonly left: MetricFormula;
  readonly right: MetricFormula;
  readonly zeroDenominator: "null";
}

export interface RoundFormula {
  readonly kind: "round";
  readonly input: MetricFormula;
}

export type AtomicMetricMeasure =
  | {
      readonly kind: "entity-count";
      readonly entity: "page" | "event" | "session" | "visitor";
    }
  | {
      readonly kind: "valid-attribute-sum";
      readonly entity: "page";
      readonly attribute: SemanticAttributeId;
      readonly valid: "non-negative";
      readonly empty: 0;
    }
  | {
      readonly kind: "valid-attribute-count";
      readonly entity: "page";
      readonly attribute: SemanticAttributeId;
      readonly valid: "non-negative";
    }
  | { readonly kind: "session-bounce-count" };

interface SemanticMetricBase {
  readonly id: SemanticMetricId;
  readonly visibility: MetricVisibility;
  readonly valueType: LogicalValueType;
}

export interface AtomicMetricDefinition extends SemanticMetricBase {
  readonly kind: "atomic";
  readonly measure: AtomicMetricMeasure;
  readonly timeGroupingPolicy: MetricTimeGroupingPolicy;
}

export interface DerivedMetricDefinition extends SemanticMetricBase {
  readonly kind: "derived";
  readonly dependencies: readonly SemanticMetricId[];
  readonly formula: MetricFormula;
}

export type SemanticMetricDefinition =
  AtomicMetricDefinition | DerivedMetricDefinition;

const scalar = (unit?: "ms" | "px" | "ratio"): LogicalValueType => ({
  kind: "scalar",
  scalar: "number",
  ...(unit ? { unit } : {}),
});

const metricReference = (metric: SemanticMetricId): MetricReferenceFormula =>
  Object.freeze({ kind: "metric-reference", metric });

const divide = (left: MetricFormula, right: MetricFormula): DivideFormula =>
  Object.freeze({ kind: "divide", left, right, zeroDenominator: "null" });

const metrics: readonly SemanticMetricDefinition[] = [
  {
    id: "views",
    kind: "atomic",
    visibility: "public",
    valueType: scalar(),
    measure: { kind: "entity-count", entity: "page" },
    timeGroupingPolicy: "occurrence",
  },
  {
    id: "sessions",
    kind: "atomic",
    visibility: "public",
    valueType: scalar(),
    measure: { kind: "entity-count", entity: "session" },
    timeGroupingPolicy: "entity-first-observation",
  },
  {
    id: "visitors",
    kind: "atomic",
    visibility: "public",
    valueType: scalar(),
    measure: { kind: "entity-count", entity: "visitor" },
    timeGroupingPolicy: "distinct-entity-per-bucket",
  },
  {
    id: "bounces",
    kind: "atomic",
    visibility: "public",
    valueType: scalar(),
    measure: { kind: "session-bounce-count" },
    timeGroupingPolicy: "entity-first-observation",
  },
  {
    id: "totalDurationMs",
    kind: "atomic",
    visibility: "internal",
    valueType: scalar("ms"),
    measure: {
      kind: "valid-attribute-sum",
      entity: "page",
      attribute: "page.durationMs",
      valid: "non-negative",
      empty: 0,
    },
    timeGroupingPolicy: "occurrence",
  },
  {
    id: "durationViews",
    kind: "atomic",
    visibility: "internal",
    valueType: scalar(),
    measure: {
      kind: "valid-attribute-count",
      entity: "page",
      attribute: "page.durationMs",
      valid: "non-negative",
    },
    timeGroupingPolicy: "occurrence",
  },
  {
    id: "avgDurationMs",
    kind: "derived",
    visibility: "public",
    valueType: scalar("ms"),
    dependencies: ["totalDurationMs", "sessions"],
    formula: Object.freeze({
      kind: "round",
      input: divide(
        metricReference("totalDurationMs"),
        metricReference("sessions"),
      ),
    }),
  },
  {
    id: "bounceRate",
    kind: "derived",
    visibility: "public",
    valueType: scalar("ratio"),
    dependencies: ["bounces", "sessions"],
    formula: divide(metricReference("bounces"), metricReference("sessions")),
  },
  {
    id: "viewsPerSession",
    kind: "derived",
    visibility: "public",
    valueType: scalar("ratio"),
    dependencies: ["views", "sessions"],
    formula: divide(metricReference("views"), metricReference("sessions")),
  },
  {
    id: "events",
    kind: "atomic",
    visibility: "public",
    valueType: scalar(),
    measure: { kind: "entity-count", entity: "event" },
    timeGroupingPolicy: "occurrence",
  },
];

export const semanticMetricCatalog: readonly SemanticMetricDefinition[] =
  Object.freeze(
    metrics
      .map((metric) => Object.freeze(metric))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );

export function semanticMetric(
  id: SemanticMetricId,
): SemanticMetricDefinition | undefined {
  return semanticMetricCatalog.find((metric) => metric.id === id);
}

export interface SemanticMetricIssue {
  readonly code:
    | "duplicate-metric"
    | "missing-dependency"
    | "duplicate-dependency"
    | "dependency-cycle"
    | "undeclared-formula-dependency"
    | "invalid-formula"
    | "duplicate-public-metric";
  readonly path: string;
  readonly message: string;
}

function formulaReferences(formula: MetricFormula): SemanticMetricId[] {
  switch (formula.kind) {
    case "metric-reference":
      return [formula.metric];
    case "literal":
      return [];
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
      return [
        ...formulaReferences(formula.left),
        ...formulaReferences(formula.right),
      ];
    case "round":
      return formulaReferences(formula.input);
  }
}

function validateFormula(
  formula: MetricFormula,
  path: string,
  issues: SemanticMetricIssue[],
): void {
  switch (formula.kind) {
    case "metric-reference":
      return;
    case "literal":
      if (formula.value !== null && !Number.isFinite(formula.value)) {
        issues.push({
          code: "invalid-formula",
          path: `${path}.value`,
          message: "Metric formula literals must be finite numbers or null.",
        });
      }
      return;
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
      validateFormula(formula.left, `${path}.left`, issues);
      validateFormula(formula.right, `${path}.right`, issues);
      if (formula.kind === "divide" && formula.zeroDenominator !== "null") {
        issues.push({
          code: "invalid-formula",
          path: `${path}.zeroDenominator`,
          message: "Undefined metric ratios must evaluate to null.",
        });
      }
      return;
    case "round":
      validateFormula(formula.input, `${path}.input`, issues);
  }
}

export function validateMetricCatalog(
  catalog: readonly SemanticMetricDefinition[] = semanticMetricCatalog,
): readonly SemanticMetricIssue[] {
  const issues: SemanticMetricIssue[] = [];
  const byId = new Map<SemanticMetricId, SemanticMetricDefinition>();
  const publicIds = new Set<SemanticMetricId>();
  for (const [index, metric] of catalog.entries()) {
    if (byId.has(metric.id)) {
      issues.push({
        code: "duplicate-metric",
        path: `metrics[${index}].id`,
        message: `Semantic metric ${metric.id} is duplicated.`,
      });
    }
    byId.set(metric.id, metric);
    if (metric.visibility === "public") {
      if (publicIds.has(metric.id)) {
        issues.push({
          code: "duplicate-public-metric",
          path: `metrics[${index}].id`,
          message: `Public semantic metric ${metric.id} is duplicated.`,
        });
      }
      publicIds.add(metric.id);
    }
  }

  for (const key of SEMANTIC_METRIC_IDS) {
    if (!byId.has(key)) {
      issues.push({
        code: "missing-dependency",
        path: `metrics.${key}`,
        message: `Canonical analytics metric ${key} has no semantic definition.`,
      });
    }
  }

  const graph = new Map<SemanticMetricId, readonly SemanticMetricId[]>();
  for (const metric of catalog) {
    if (metric.kind === "atomic") {
      graph.set(metric.id, []);
      continue;
    }
    const dependencies = new Set<SemanticMetricId>();
    metric.dependencies.forEach((dependency, index) => {
      if (dependencies.has(dependency)) {
        issues.push({
          code: "duplicate-dependency",
          path: `metrics.${metric.id}.dependencies[${index}]`,
          message: `Metric dependency ${dependency} is duplicated.`,
        });
      }
      dependencies.add(dependency);
      if (!byId.has(dependency)) {
        issues.push({
          code: "missing-dependency",
          path: `metrics.${metric.id}.dependencies[${index}]`,
          message: `Metric dependency ${dependency} is not registered.`,
        });
      }
    });
    const declared = new Set(metric.dependencies);
    for (const [index, reference] of formulaReferences(
      metric.formula,
    ).entries()) {
      if (!declared.has(reference)) {
        issues.push({
          code: "undeclared-formula-dependency",
          path: `metrics.${metric.id}.formula.references[${index}]`,
          message: `Formula references ${reference}, which is not declared as a dependency.`,
        });
      }
    }
    validateFormula(metric.formula, `metrics.${metric.id}.formula`, issues);
    graph.set(metric.id, metric.dependencies);
  }

  const visiting = new Set<SemanticMetricId>();
  const visited = new Set<SemanticMetricId>();
  const visit = (id: SemanticMetricId, path: readonly SemanticMetricId[]) => {
    if (visiting.has(id)) {
      issues.push({
        code: "dependency-cycle",
        path: `metrics.${id}.dependencies`,
        message: `Metric dependency cycle: ${[...path, id].join(" -> ")}.`,
      });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency)) visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id, []);

  return Object.freeze(issues);
}

export function assertMetricCatalogValid(): void {
  const issues = validateMetricCatalog();
  if (issues.length > 0) {
    throw new Error(
      `Invalid analytics metric catalog: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
}
