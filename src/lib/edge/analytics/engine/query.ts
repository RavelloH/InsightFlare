import type { QueryOperation } from "@/lib/edge/analytics/contract/types";
import type { CalendarGranularity } from "@/lib/edge/analytics/contract/types";
import type { FilterDocument } from "@/lib/filter-contract/filters";

import type { SemanticDimensionId } from "./semantic/dimensions";
import { semanticDimension } from "./semantic/dimensions";
import {
  type ResolvedAnalyticsScope,
  validateResolvedAnalyticsScope,
} from "./semantic/entities";
import type { SemanticMetricId } from "./semantic/metrics";
import { semanticMetric } from "./semantic/metrics";
import type { SemanticSubjectDomain } from "./semantic/subject";
import {
  isCalendarGranularity,
  type SemanticTemporalDomains,
} from "./semantic/time";

export interface SemanticQueryContext {
  readonly subject: SemanticSubjectDomain;
  readonly time: SemanticTemporalDomains;
  readonly scope: ResolvedAnalyticsScope;
  readonly originOperation?: QueryOperation;
}

export interface SemanticAggregateSort {
  readonly field: SemanticDimensionId | SemanticMetricId | "timeBucket";
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
}

export interface SemanticAggregateQuery {
  readonly context: SemanticQueryContext;
  /** The Filter Contract document is retained for the later scope-lowering phase. */
  readonly filters?: FilterDocument;
  readonly dimensions: readonly SemanticDimensionId[];
  readonly metrics: readonly SemanticMetricId[];
  readonly sort: readonly SemanticAggregateSort[];
  readonly limit?: number;
  readonly timeBucket?: { readonly granularity: CalendarGranularity };
}

export interface SemanticQueryIssue {
  readonly path: string;
  readonly message: string;
}

export class SemanticQueryError extends Error {
  readonly issues: readonly SemanticQueryIssue[];

  constructor(issues: readonly SemanticQueryIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "SemanticQueryError";
    this.issues = Object.freeze([...issues]);
  }
}

export function validateSemanticAggregateQuery(
  query: SemanticAggregateQuery,
): SemanticAggregateQuery {
  const issues: SemanticQueryIssue[] = [];
  if (!query || typeof query !== "object") {
    throw new SemanticQueryError([
      { path: "query", message: "Semantic aggregate query must be an object." },
    ]);
  }
  if (!query.context || typeof query.context !== "object") {
    issues.push({
      path: "context",
      message: "Semantic aggregate query requires a context object.",
    });
  } else {
    try {
      validateResolvedAnalyticsScope(query.context.scope);
    } catch {
      issues.push({
        path: "context.scope",
        message: "Resolved analytics scope is invalid or inconsistent.",
      });
    }
  }
  const dimensionsInput = Array.isArray(query.dimensions)
    ? query.dimensions
    : [];
  const metricsInput = Array.isArray(query.metrics) ? query.metrics : [];
  const sortInput = Array.isArray(query.sort) ? query.sort : [];
  if (!Array.isArray(query.dimensions))
    issues.push({
      path: "dimensions",
      message: "Dimensions must be an array.",
    });
  if (!Array.isArray(query.metrics))
    issues.push({ path: "metrics", message: "Metrics must be an array." });
  if (!Array.isArray(query.sort))
    issues.push({ path: "sort", message: "Sort keys must be an array." });

  if (metricsInput.length === 0) {
    issues.push({
      path: "metrics",
      message: "Semantic aggregate queries require at least one metric.",
    });
  }
  const dimensions = new Set<string>();
  dimensionsInput.forEach((id, index) => {
    if (!semanticDimension(id))
      issues.push({
        path: `dimensions[${index}]`,
        message: `Unknown dimension ${id}.`,
      });
    if (dimensions.has(id))
      issues.push({
        path: `dimensions[${index}]`,
        message: `Dimension ${id} is duplicated.`,
      });
    dimensions.add(id);
  });
  const metrics = new Set<string>();
  metricsInput.forEach((id, index) => {
    const metric = semanticMetric(id);
    if (!metric || metric.visibility !== "public")
      issues.push({
        path: `metrics[${index}]`,
        message: `Metric ${id} is unknown or internal.`,
      });
    if (metrics.has(id))
      issues.push({
        path: `metrics[${index}]`,
        message: `Metric ${id} is duplicated.`,
      });
    metrics.add(id);
  });
  sortInput.forEach((item, index) => {
    const path = `sort[${index}]`;
    if (!item || typeof item !== "object") {
      issues.push({ path, message: "Sort key must be an object." });
      return;
    }
    if (item.direction !== "asc" && item.direction !== "desc") {
      issues.push({
        path: `${path}.direction`,
        message: "Sort direction must be asc or desc.",
      });
    }
    if (item.nulls !== "first" && item.nulls !== "last") {
      issues.push({
        path: `${path}.nulls`,
        message: "Sort null ordering must be first or last.",
      });
    }
    if (
      !dimensions.has(item.field) &&
      !metrics.has(item.field) &&
      !(item.field === "timeBucket" && query.timeBucket !== undefined)
    ) {
      issues.push({
        path: `sort[${index}].field`,
        message: `Sort field ${item.field} is not selected.`,
      });
    }
  });
  if (query.timeBucket !== undefined) {
    const timeBucket = query.timeBucket as unknown;
    if (
      !timeBucket ||
      typeof timeBucket !== "object" ||
      !isCalendarGranularity(
        (timeBucket as { readonly granularity?: unknown }).granularity,
      )
    ) {
      issues.push({
        path: "timeBucket.granularity",
        message: "Time bucket granularity is invalid.",
      });
    }
  }
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit < 0)
  ) {
    issues.push({
      path: "limit",
      message: "Limit must be a non-negative integer.",
    });
  }
  if (issues.length > 0) throw new SemanticQueryError(issues);
  return Object.freeze({
    ...query,
    context: Object.freeze({
      ...query.context,
      subject: Object.freeze({
        ...query.context.subject,
        siteIds: Object.freeze([...query.context.subject.siteIds]),
      }),
      time: query.context.time,
      scope: Object.freeze({ ...query.context.scope }),
    }),
    dimensions: Object.freeze([...dimensionsInput]),
    metrics: Object.freeze([...metricsInput]),
    sort: Object.freeze(sortInput.map((item) => Object.freeze({ ...item }))),
    ...(query.timeBucket
      ? { timeBucket: Object.freeze({ ...query.timeBucket }) }
      : {}),
  });
}
