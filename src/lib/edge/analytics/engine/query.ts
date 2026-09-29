import type { QueryOperation } from "@/lib/edge/analytics/contract/types";
import type { CalendarGranularity } from "@/lib/edge/analytics/contract/types";
import type { FilterDocument } from "@/lib/filter-contract/filters";

import type { SemanticDimensionId } from "./semantic/dimensions";
import { semanticDimension } from "./semantic/dimensions";
import type { ResolvedAnalyticsScope } from "./semantic/entities";
import type { SemanticMetricId } from "./semantic/metrics";
import { semanticMetric } from "./semantic/metrics";
import type { SemanticSubjectDomain } from "./semantic/subject";
import type { SemanticTemporalDomains } from "./semantic/time";

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
  if (query.metrics.length === 0) {
    issues.push({
      path: "metrics",
      message: "Semantic aggregate queries require at least one metric.",
    });
  }
  const dimensions = new Set<string>();
  query.dimensions.forEach((id, index) => {
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
  query.metrics.forEach((id, index) => {
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
  query.sort.forEach((item, index) => {
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
    dimensions: Object.freeze([...query.dimensions]),
    metrics: Object.freeze([...query.metrics]),
    sort: Object.freeze(query.sort.map((item) => Object.freeze({ ...item }))),
  });
}
