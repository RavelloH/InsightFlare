import type { AnalyzedFilterDocument } from "./filter-semantics";
import type {
  FilterCondition,
  FilterDocument,
  FilterExpression,
  FilterTargetExpression,
  FilterTimeAnchorTarget,
} from "./filters";

export interface FilterHistoryRange {
  readonly startMs: number;
  readonly endExclusiveMs: number;
}

export type FilterHistoryRequirement =
  | { readonly kind: "candidate-only" }
  | ({ readonly kind: "bounded" } & FilterHistoryRange)
  | { readonly kind: "full-history" };

const ELAPSED_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function isTimeTarget(target: FilterTargetExpression): boolean {
  return target.kind === "member" && target.member === "time";
}

function resolveEndpoint(
  value: unknown,
  candidate: FilterHistoryRange,
  capturedAtMs: number,
): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  if (value.kind !== "time-anchor") return null;
  const timeAnchor = value as FilterTimeAnchorTarget;
  const anchor = timeAnchor.anchor;
  let result =
    anchor === "now"
      ? capturedAtMs
      : anchor === "range.start"
        ? candidate.startMs
        : candidate.endExclusiveMs;
  if (timeAnchor.offset) {
    const unit = timeAnchor.offset.unit;
    const factor = ELAPSED_MS[unit];
    if (factor === undefined) return null;
    result += timeAnchor.offset.amount * factor;
  }
  return Number.isSafeInteger(result) ? result : null;
}

function boundsForCondition(
  condition: FilterCondition,
  candidate: FilterHistoryRange,
  capturedAtMs: number,
): { start?: number; end?: number } | null {
  if (!isTimeTarget(condition.target)) return null;
  const values = Array.isArray(condition.value)
    ? condition.value
    : condition.value === undefined
      ? []
      : [condition.value];
  if (condition.operator === "between" && values.length === 2) {
    const start = resolveEndpoint(values[0], candidate, capturedAtMs);
    const end = resolveEndpoint(values[1], candidate, capturedAtMs);
    if (start === null || end === null || end === Number.MAX_SAFE_INTEGER)
      return null;
    return { start, end: end + 1 };
  }
  if (values.length !== 1) return null;
  const value = resolveEndpoint(values[0], candidate, capturedAtMs);
  if (value === null) return null;
  switch (condition.operator) {
    case "eq":
      return value === Number.MAX_SAFE_INTEGER
        ? null
        : { start: value, end: value + 1 };
    case "gt":
      return value === Number.MAX_SAFE_INTEGER ? null : { start: value + 1 };
    case "gte":
      return { start: value };
    case "lt":
      return { end: value };
    case "lte":
      return value === Number.MAX_SAFE_INTEGER ? null : { end: value + 1 };
    default:
      return null;
  }
}

interface PredicateTimeBounds {
  readonly hasTime: boolean;
  readonly fullHistory: boolean;
  readonly start?: number;
  readonly end?: number;
}

function predicateTimeBounds(
  expression: FilterExpression,
  candidate: FilterHistoryRange,
  capturedAtMs: number,
  analysis: AnalyzedFilterDocument,
): PredicateTimeBounds {
  if (expression.kind === "condition") {
    if (!analysis.conditions.get(expression)?.temporalPredicate)
      return { hasTime: false, fullHistory: false };
    const bounds = boundsForCondition(expression, candidate, capturedAtMs);
    return bounds
      ? { hasTime: true, fullHistory: false, ...bounds }
      : {
          hasTime: true,
          fullHistory: true,
        };
  }
  if (expression.kind === "not" || expression.kind === "or") {
    const containsTime =
      expression.kind === "not"
        ? predicateTimeBounds(
            expression.child,
            candidate,
            capturedAtMs,
            analysis,
          ).hasTime
        : expression.children.some(
            (child) =>
              predicateTimeBounds(child, candidate, capturedAtMs, analysis)
                .hasTime,
          );
    return { hasTime: containsTime, fullHistory: containsTime };
  }
  let hasTime = false;
  let fullHistory = false;
  let start: number | undefined;
  let end: number | undefined;
  for (const child of expression.children) {
    const bounds = predicateTimeBounds(
      child,
      candidate,
      capturedAtMs,
      analysis,
    );
    hasTime ||= bounds.hasTime;
    fullHistory ||= bounds.fullHistory;
    if (bounds.start !== undefined)
      start = Math.max(start ?? Number.MIN_SAFE_INTEGER, bounds.start);
    if (bounds.end !== undefined)
      end = Math.min(end ?? Number.MAX_SAFE_INTEGER, bounds.end);
  }
  if (start !== undefined && end !== undefined && end <= start)
    return { hasTime: true, fullHistory: false, start, end };
  return {
    hasTime,
    fullHistory:
      fullHistory || (hasTime && start === undefined && end !== undefined),
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
  };
}

function completePredicateTimeBounds(
  bounds: PredicateTimeBounds,
): PredicateTimeBounds {
  return {
    ...bounds,
    fullHistory:
      bounds.fullHistory ||
      (bounds.hasTime &&
        bounds.start === undefined &&
        bounds.end !== undefined),
  };
}

function selectorHasBoundedTime(
  target: FilterTargetExpression,
  candidate: FilterHistoryRange,
  capturedAtMs: number,
  analysis: AnalyzedFilterDocument,
): boolean {
  if (target.kind !== "selector") return false;
  const bounds = completePredicateTimeBounds(
    predicateTimeBounds(target.predicate, candidate, capturedAtMs, analysis),
  );
  return bounds.hasTime && !bounds.fullHistory && bounds.start !== undefined;
}

function targetTimePredicateBounds(
  target: FilterTargetExpression,
  candidate: FilterHistoryRange,
  capturedAtMs: number,
  analysis: AnalyzedFilterDocument,
): PredicateTimeBounds {
  if (target.kind === "selector")
    return completePredicateTimeBounds(
      predicateTimeBounds(target.predicate, candidate, capturedAtMs, analysis),
    );
  if (target.kind === "member")
    return targetTimePredicateBounds(
      target.object,
      candidate,
      capturedAtMs,
      analysis,
    );
  if (
    target.kind === "reducer" &&
    ["first", "last", "nth"].includes(target.reducer)
  )
    return targetTimePredicateBounds(
      target.input,
      candidate,
      capturedAtMs,
      analysis,
    );
  return { hasTime: false, fullHistory: false };
}

function elapsedOffsetMs(amount: number, unit: string): number | null {
  const factor = ELAPSED_MS[unit];
  if (factor === undefined) return null;
  const offset = amount * factor;
  return Number.isSafeInteger(offset) ? offset : null;
}

function targetNeedsFullHistory(
  target: FilterTargetExpression,
  candidate: FilterHistoryRange,
  capturedAtMs: number,
  analysis: AnalyzedFilterDocument,
): boolean {
  switch (target.kind) {
    case "reducer":
      if (
        ["first", "last", "nth"].includes(target.reducer) &&
        !selectorHasBoundedTime(target.input, candidate, capturedAtMs, analysis)
      )
        return true;
      return targetNeedsFullHistory(
        target.input,
        candidate,
        capturedAtMs,
        analysis,
      );
    case "sequence":
      return target.steps.some(
        (step) =>
          !selectorHasBoundedTime(step, candidate, capturedAtMs, analysis),
      );
    case "adjacent":
      return targetNeedsFullHistory(
        target.sequence,
        candidate,
        capturedAtMs,
        analysis,
      );
    case "without":
      return (
        targetNeedsFullHistory(
          target.sequence,
          candidate,
          capturedAtMs,
          analysis,
        ) ||
        targetNeedsFullHistory(
          target.excluded,
          candidate,
          capturedAtMs,
          analysis,
        )
      );
    case "selector":
      return false;
    case "member":
      return targetNeedsFullHistory(
        target.object,
        candidate,
        capturedAtMs,
        analysis,
      );
    case "projection":
      return targetNeedsFullHistory(
        target.collection,
        candidate,
        capturedAtMs,
        analysis,
      );
    case "arithmetic":
      return (
        targetNeedsFullHistory(
          target.left,
          candidate,
          capturedAtMs,
          analysis,
        ) ||
        targetNeedsFullHistory(target.right, candidate, capturedAtMs, analysis)
      );
    case "bucket":
      return targetNeedsFullHistory(
        target.input,
        candidate,
        capturedAtMs,
        analysis,
      );
    case "window":
      return (
        targetNeedsFullHistory(
          target.collection,
          candidate,
          capturedAtMs,
          analysis,
        ) ||
        targetNeedsFullHistory(target.anchor, candidate, capturedAtMs, analysis)
      );
    case "periods":
      return targetNeedsFullHistory(
        target.collection,
        candidate,
        capturedAtMs,
        analysis,
      );
    default:
      return false;
  }
}

export function analyzeFilterHistory(
  analysis: AnalyzedFilterDocument,
  candidate: FilterHistoryRange,
  capturedAtMs: number,
): FilterHistoryRequirement {
  const document: FilterDocument = analysis.document;
  if (!document.root) return { kind: "candidate-only" };
  let fullHistory = false;
  let start: number | undefined;
  let end: number | undefined;
  const visitTarget = (target: FilterTargetExpression): void => {
    if (target.kind === "selector") {
      const bounds = completePredicateTimeBounds(
        predicateTimeBounds(
          target.predicate,
          candidate,
          capturedAtMs,
          analysis,
        ),
      );
      fullHistory ||= bounds.fullHistory;
      if (bounds.start !== undefined)
        start = Math.min(start ?? Number.MAX_SAFE_INTEGER, bounds.start);
      if (bounds.end !== undefined)
        end = Math.max(end ?? Number.MIN_SAFE_INTEGER, bounds.end);
      visitExpression(target.predicate);
      visitTarget(target.collection);
      return;
    }
    fullHistory ||= targetNeedsFullHistory(
      target,
      candidate,
      capturedAtMs,
      analysis,
    );
    if (target.kind === "window") {
      const anchorBounds = targetTimePredicateBounds(
        target.anchor,
        candidate,
        capturedAtMs,
        analysis,
      );
      const startOffset = elapsedOffsetMs(
        target.startOffset.amount,
        target.startOffset.unit,
      );
      const endOffset = elapsedOffsetMs(
        target.endOffset.amount,
        target.endOffset.unit,
      );
      if (anchorBounds.start !== undefined && !anchorBounds.fullHistory) {
        if (startOffset === null) {
          fullHistory = true;
        } else {
          const requiredStart = anchorBounds.start + Math.min(0, startOffset);
          if (!Number.isSafeInteger(requiredStart)) fullHistory = true;
          else
            start = Math.min(start ?? Number.MAX_SAFE_INTEGER, requiredStart);
        }
      }
      if (
        anchorBounds.end !== undefined &&
        !anchorBounds.fullHistory &&
        endOffset !== null
      ) {
        const rawRequiredEnd = anchorBounds.end + endOffset;
        if (!Number.isSafeInteger(rawRequiredEnd)) {
          fullHistory = true;
        } else {
          const requiredEnd = Math.min(rawRequiredEnd, capturedAtMs + 1);
          end = Math.max(end ?? Number.MIN_SAFE_INTEGER, requiredEnd);
        }
      }
    }
    switch (target.kind) {
      case "member":
        visitTarget(target.object);
        break;
      case "projection":
        visitTarget(target.collection);
        break;
      case "reducer":
        visitTarget(target.input);
        break;
      case "arithmetic":
        visitTarget(target.left);
        visitTarget(target.right);
        break;
      case "bucket":
        visitTarget(target.input);
        break;
      case "window":
        visitTarget(target.collection);
        visitTarget(target.anchor);
        break;
      case "periods":
        visitTarget(target.collection);
        break;
      case "sequence":
        target.steps.forEach(visitTarget);
        break;
      case "adjacent":
        visitTarget(target.sequence);
        break;
      case "without":
        visitTarget(target.sequence);
        visitTarget(target.excluded);
        break;
    }
  };
  const visitExpression = (expression: FilterExpression): void => {
    if (expression.kind === "condition") {
      visitTarget(expression.target);
      return;
    }
    if (expression.kind === "not") {
      visitExpression(expression.child);
      return;
    }
    expression.children.forEach(visitExpression);
  };
  visitExpression(document.root);
  if (fullHistory) return { kind: "full-history" };
  if (start === undefined && end === undefined)
    return { kind: "candidate-only" };
  const startMs = start ?? candidate.startMs;
  const endExclusiveMs = end ?? capturedAtMs + 1;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endExclusiveMs))
    return { kind: "full-history" };
  if (endExclusiveMs <= startMs) return { kind: "candidate-only" };
  return { kind: "bounded", startMs, endExclusiveMs };
}
