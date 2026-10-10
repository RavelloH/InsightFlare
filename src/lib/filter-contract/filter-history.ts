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

export type FilterHistoryScope = "event" | "session" | "visitor";

export interface FilterEvaluationDomain {
  /** Omitted start means the earliest confirmed retained data. */
  readonly startMs?: number;
  /** Omitted end means the captured query clock. */
  readonly endExclusiveMs?: number;
}

export interface FilterTimeAnalysis {
  readonly explicit: boolean;
  readonly empty: boolean;
  readonly range?: FilterEvaluationDomain;
}

export interface TargetHistoryAnalysis {
  readonly requirement: FilterHistoryRequirement;
  /** Proven time domain for this target when it yields ordered values. */
  readonly temporalBounds?: FilterHistoryRange;
  /** Whether an explicit finite history domain bounds a collection. */
  readonly boundedCollection: boolean;
}

interface PredicateTimeBounds {
  readonly hasTime: boolean;
  readonly fullHistory: boolean;
  readonly impossible?: boolean;
  readonly start?: number;
  readonly end?: number;
}

const CANDIDATE_ONLY: FilterHistoryRequirement = Object.freeze({
  kind: "candidate-only",
});
const FULL_HISTORY: FilterHistoryRequirement = Object.freeze({
  kind: "full-history",
});

const ELAPSED_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function isTimeTarget(target: FilterTargetExpression): boolean {
  return (
    target.kind === "member" &&
    target.member === "time" &&
    target.object.kind === "context-root" &&
    target.object.context === "current"
  );
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
    const factor = ELAPSED_MS[timeAnchor.offset.unit];
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
      : { hasTime: true, fullHistory: true };
  }
  if (expression.kind === "not" || expression.kind === "or") {
    const childBounds =
      expression.kind === "not"
        ? [
            predicateTimeBounds(
              expression.child,
              candidate,
              capturedAtMs,
              analysis,
            ),
          ]
        : expression.children.map((child) =>
            predicateTimeBounds(child, candidate, capturedAtMs, analysis),
          );
    const hasTime = childBounds.some((bounds) => bounds.hasTime);
    return { hasTime, fullHistory: hasTime };
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
    return { hasTime: true, fullHistory: false, impossible: true, start, end };
  if (hasTime && start === undefined && end !== undefined) fullHistory = true;
  return {
    hasTime,
    fullHistory,
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
  };
}

function requirementForRange(
  range: FilterHistoryRange,
  capturedAtMs: number,
): FilterHistoryRequirement {
  const endExclusiveMs = Math.min(range.endExclusiveMs, capturedAtMs + 1);
  if (range.startMs >= endExclusiveMs) return CANDIDATE_ONLY;
  if (
    !Number.isSafeInteger(range.startMs) ||
    !Number.isSafeInteger(endExclusiveMs)
  )
    return FULL_HISTORY;
  return { kind: "bounded", startMs: range.startMs, endExclusiveMs };
}

function mergeRequirements(
  left: FilterHistoryRequirement,
  right: FilterHistoryRequirement,
): FilterHistoryRequirement {
  if (left.kind === "full-history" || right.kind === "full-history")
    return FULL_HISTORY;
  if (left.kind === "candidate-only") return right;
  if (right.kind === "candidate-only") return left;
  return {
    kind: "bounded",
    startMs: Math.min(left.startMs, right.startMs),
    endExclusiveMs: Math.max(left.endExclusiveMs, right.endExclusiveMs),
  };
}

function unionBounds(
  left: FilterHistoryRange | undefined,
  right: FilterHistoryRange | undefined,
): FilterHistoryRange | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    startMs: Math.min(left.startMs, right.startMs),
    endExclusiveMs: Math.max(left.endExclusiveMs, right.endExclusiveMs),
  };
}

function elapsedOffsetMs(amount: number, unit: string): number | null {
  const factor = ELAPSED_MS[unit];
  if (factor === undefined) return null;
  const offset = amount * factor;
  return Number.isSafeInteger(offset) ? offset : null;
}

function addOffset(value: number, offset: number): number | null {
  const result = value + offset;
  return Number.isSafeInteger(result) ? result : null;
}

function analyzeTarget(
  target: FilterTargetExpression,
  candidate: FilterHistoryRange,
  capturedAtMs: number,
  analysis: AnalyzedFilterDocument,
  filterRange?: FilterEvaluationDomain,
): TargetHistoryAnalysis {
  const analyze = (child: FilterTargetExpression) =>
    analyzeTarget(child, candidate, capturedAtMs, analysis, filterRange);
  switch (target.kind) {
    case "entity-root": {
      if (filterRange) {
        const startMs = filterRange.startMs;
        const endExclusiveMs = filterRange.endExclusiveMs ?? capturedAtMs + 1;
        if (startMs === undefined) {
          return {
            requirement: FULL_HISTORY,
            boundedCollection: true,
          };
        }
        const range = { startMs, endExclusiveMs };
        return {
          requirement: requirementForRange(range, capturedAtMs),
          temporalBounds: range,
          boundedCollection: true,
        };
      }
      return {
        requirement: CANDIDATE_ONLY,
        boundedCollection: false,
      };
    }
    case "field":
    case "event-payload":
    case "current-payload":
    case "context-root":
    case "duration":
      return { requirement: CANDIDATE_ONLY, boundedCollection: false };
    case "context-intrinsic":
      if (target.intrinsic === "same") analyze(target.input);
      return { requirement: CANDIDATE_ONLY, boundedCollection: false };
    case "occurrence-time":
      return analyze(target.input);
    case "time-anchor": {
      const value = resolveEndpoint(target, candidate, capturedAtMs);
      if (value === null || value === Number.MAX_SAFE_INTEGER)
        return { requirement: CANDIDATE_ONLY, boundedCollection: false };
      return {
        requirement: CANDIDATE_ONLY,
        temporalBounds: { startMs: value, endExclusiveMs: value + 1 },
        boundedCollection: false,
      };
    }
    case "selector": {
      const source = analyze(target.collection);
      const predicateTargets = analyzeExpressionTargets(
        target.predicate,
        candidate,
        capturedAtMs,
        analysis,
        filterRange,
      );
      return {
        requirement: mergeRequirements(source.requirement, predicateTargets),
        temporalBounds: source.temporalBounds,
        boundedCollection: source.boundedCollection,
      };
    }
    case "member": {
      const object = analyze(target.object);
      return object;
    }
    case "projection": {
      const collection = analyze(target.collection);
      return collection;
    }
    case "reducer": {
      const input = analyze(target.input);
      if (["first", "last", "nth"].includes(target.reducer))
        return {
          ...input,
          requirement: input.boundedCollection
            ? input.requirement
            : mergeRequirements(input.requirement, FULL_HISTORY),
        };
      return input;
    }
    case "arithmetic": {
      const left = analyze(target.left);
      const right = analyze(target.right);
      return {
        requirement: mergeRequirements(left.requirement, right.requirement),
        temporalBounds: unionBounds(left.temporalBounds, right.temporalBounds),
        boundedCollection: left.boundedCollection && right.boundedCollection,
      };
    }
    case "bucket":
      return analyze(target.input);
    case "periods":
      return analyze(target.collection);
    case "window": {
      const collection = analyze(target.collection);
      const anchor = analyze(target.anchor);
      let requirement = mergeRequirements(
        collection.requirement,
        anchor.requirement,
      );
      let temporalBounds = collection.temporalBounds;
      let boundedCollection = collection.boundedCollection;
      if (anchor.temporalBounds) {
        const startOffset = elapsedOffsetMs(
          target.startOffset.amount,
          target.startOffset.unit,
        );
        const endOffset = elapsedOffsetMs(
          target.endOffset.amount,
          target.endOffset.unit,
        );
        if (startOffset === null || endOffset === null) {
          requirement = FULL_HISTORY;
        } else {
          const startMs = addOffset(
            anchor.temporalBounds.startMs,
            Math.min(0, startOffset),
          );
          const rawEnd = addOffset(
            anchor.temporalBounds.endExclusiveMs,
            endOffset,
          );
          if (startMs === null || rawEnd === null) {
            requirement = FULL_HISTORY;
          } else {
            const range = {
              startMs,
              endExclusiveMs: Math.min(rawEnd, capturedAtMs + 1),
            };
            temporalBounds = unionBounds(temporalBounds, range);
            boundedCollection = true;
            requirement = mergeRequirements(
              requirement,
              requirementForRange(range, capturedAtMs),
            );
          }
        }
      } else if (anchor.requirement.kind === "full-history") {
        requirement = FULL_HISTORY;
      }
      return { requirement, temporalBounds, boundedCollection };
    }
    case "sequence": {
      const steps = target.steps.map(analyze);
      const requirement = steps.reduce(
        (current, step) => mergeRequirements(current, step.requirement),
        CANDIDATE_ONLY,
      );
      const bounded = steps.every((step) => step.boundedCollection);
      const temporalBounds = steps.reduce<FilterHistoryRange | undefined>(
        (current, step) => unionBounds(current, step.temporalBounds),
        undefined,
      );
      return {
        requirement: bounded ? requirement : FULL_HISTORY,
        temporalBounds,
        boundedCollection: bounded,
      };
    }
    case "adjacent":
      return analyze(target.sequence);
    case "without": {
      const sequence = analyze(target.sequence);
      const excluded = analyze(target.excluded);
      if (sequence.requirement.kind === "full-history") return sequence;
      let temporalBounds = sequence.temporalBounds;
      let requirement: FilterHistoryRequirement = sequence.requirement;
      if (excluded.requirement.kind === "full-history") {
        requirement = FULL_HISTORY;
      } else if (excluded.temporalBounds) {
        temporalBounds = unionBounds(temporalBounds, excluded.temporalBounds);
        requirement = mergeRequirements(
          requirement,
          requirementForRange(excluded.temporalBounds, capturedAtMs),
        );
      }
      return {
        requirement,
        temporalBounds,
        boundedCollection: sequence.boundedCollection,
      };
    }
  }
}

function analyzeExpressionTargets(
  expression: FilterExpression,
  candidate: FilterHistoryRange,
  capturedAtMs: number,
  analysis: AnalyzedFilterDocument,
  filterRange?: FilterEvaluationDomain,
): FilterHistoryRequirement {
  if (expression.kind === "condition") {
    const target = analyzeTarget(
      expression.target,
      candidate,
      capturedAtMs,
      analysis,
      filterRange,
    );
    let requirement = target.requirement;
    if (
      expression.value &&
      typeof expression.value === "object" &&
      !Array.isArray(expression.value) &&
      "kind" in expression.value
    )
      requirement = mergeRequirements(
        requirement,
        analyzeTarget(
          expression.value as FilterTargetExpression,
          candidate,
          capturedAtMs,
          analysis,
          filterRange,
        ).requirement,
      );
    return requirement;
  }
  if (expression.kind === "not")
    return analyzeExpressionTargets(
      expression.child,
      candidate,
      capturedAtMs,
      analysis,
      filterRange,
    );
  return expression.children.reduce(
    (requirement, child) =>
      mergeRequirements(
        requirement,
        analyzeExpressionTargets(
          child,
          candidate,
          capturedAtMs,
          analysis,
          filterRange,
        ),
      ),
    CANDIDATE_ONLY,
  );
}

export function analyzeFilterHistory(
  analysis: AnalyzedFilterDocument,
  candidate: FilterHistoryRange,
  capturedAtMs: number,
  scope: FilterHistoryScope,
  filterRange?: FilterEvaluationDomain,
): FilterHistoryRequirement {
  const document: FilterDocument = analysis.document;
  if (!document.root) return CANDIDATE_ONLY;
  void scope;
  const expressionRequirement = analyzeExpressionTargets(
    document.root,
    candidate,
    capturedAtMs,
    analysis,
    filterRange,
  );
  if (!filterRange) return expressionRequirement;
  if (filterRange.startMs === undefined) return FULL_HISTORY;
  const endExclusiveMs = filterRange.endExclusiveMs ?? capturedAtMs + 1;
  if (filterRange.startMs >= endExclusiveMs) return CANDIDATE_ONLY;
  return mergeRequirements(
    requirementForRange(
      { startMs: filterRange.startMs, endExclusiveMs },
      capturedAtMs,
    ),
    expressionRequirement,
  );
}

/** Derive the top-level DSL `time` domain used to evaluate the whole document. */
export function analyzeFilterTimeRange(
  analysis: AnalyzedFilterDocument,
  candidate: FilterHistoryRange,
  capturedAtMs: number,
): FilterTimeAnalysis {
  const document = analysis.document;
  if (!document.root) return { explicit: false, empty: false };
  const bounds = predicateTimeBounds(
    document.root,
    candidate,
    capturedAtMs,
    analysis,
  );
  if (!bounds.hasTime) return { explicit: false, empty: false };
  if (bounds.impossible) return { explicit: true, empty: true };
  const startMs = bounds.start;
  const endExclusiveMs = Math.min(
    bounds.end ?? capturedAtMs + 1,
    capturedAtMs + 1,
  );
  if (
    (startMs !== undefined && !Number.isSafeInteger(startMs)) ||
    !Number.isSafeInteger(endExclusiveMs)
  )
    return { explicit: true, empty: false, range: {} };
  if (startMs !== undefined && startMs >= endExclusiveMs)
    return { explicit: true, empty: true };
  return {
    explicit: true,
    empty: false,
    range: {
      ...(startMs !== undefined ? { startMs } : {}),
      endExclusiveMs,
    },
  };
}
