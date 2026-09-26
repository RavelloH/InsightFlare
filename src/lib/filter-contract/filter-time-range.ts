import type {
  FilterCondition,
  FilterDocument,
  FilterExpression,
  FilterTargetExpression,
  FilterValue,
} from "./filters";

export interface FilterTimeRange {
  readonly startMs: number;
  readonly endExclusiveMs: number;
}

export interface FilterTimeRangePreparation {
  readonly filters: FilterDocument;
  readonly evaluationRange?: FilterTimeRange;
}

const DURATION_MS: Readonly<Record<string, number>> = {
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

function hasTopLevelTime(expression: FilterExpression): boolean {
  if (expression.kind === "condition") return isTimeTarget(expression.target);
  if (expression.kind === "not") return hasTopLevelTime(expression.child);
  return expression.children.some(hasTopLevelTime);
}

function anchorValue(
  value: FilterValue | FilterTargetExpression,
  candidateRange: FilterTimeRange,
  capturedAtMs: number,
): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isSafeInteger(timestamp)) return timestamp;
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === "time-anchor"
  ) {
    const base =
      value.anchor === "now"
        ? capturedAtMs
        : value.anchor === "range.start"
          ? candidateRange.startMs
          : candidateRange.endExclusiveMs;
    if (!value.offset) return base;
    const unitMs = DURATION_MS[value.offset.unit];
    if (unitMs === undefined) throw new TypeError("filter_time_range_invalid");
    const offset = value.offset.amount * unitMs;
    const result = base + offset;
    if (!Number.isSafeInteger(result))
      throw new TypeError("filter_time_range_invalid");
    return result;
  }
  throw new TypeError("filter_time_range_invalid");
}

function readBounds(
  condition: FilterCondition,
  candidateRange: FilterTimeRange,
  capturedAtMs: number,
): { readonly start?: number; readonly end?: number } {
  const values = Array.isArray(condition.value)
    ? condition.value
    : condition.value === undefined
      ? []
      : [condition.value];
  if (condition.operator === "between" && values.length === 2) {
    const start = anchorValue(values[0]!, candidateRange, capturedAtMs);
    const inclusiveEnd = anchorValue(values[1]!, candidateRange, capturedAtMs);
    if (inclusiveEnd === Number.MAX_SAFE_INTEGER)
      throw new TypeError("filter_time_range_invalid");
    return { start, end: inclusiveEnd + 1 };
  }
  if (values.length !== 1) throw new TypeError("filter_time_range_invalid");
  const value = anchorValue(values[0]!, candidateRange, capturedAtMs);
  switch (condition.operator) {
    case "eq":
      if (value === Number.MAX_SAFE_INTEGER)
        throw new TypeError("filter_time_range_invalid");
      return { start: value, end: value + 1 };
    case "gt":
      if (value === Number.MAX_SAFE_INTEGER)
        throw new TypeError("filter_time_range_invalid");
      return { start: value + 1 };
    case "gte":
      return { start: value };
    case "lt":
      return { end: value };
    case "lte":
      if (value === Number.MAX_SAFE_INTEGER)
        throw new TypeError("filter_time_range_invalid");
      return { end: value + 1 };
    default:
      throw new TypeError("filter_time_range_invalid");
  }
}

function copyDocumentWithRoot(
  document: FilterDocument,
  root: FilterExpression | null,
): FilterDocument {
  const result = { version: document.version, root } as FilterDocument;
  for (const key of Reflect.ownKeys(document)) {
    if (typeof key !== "symbol") continue;
    const descriptor = Object.getOwnPropertyDescriptor(document, key);
    if (descriptor) Object.defineProperty(result, key, descriptor);
  }
  return result;
}

/**
 * Extracts unconditional top-level `time` bounds into the query's historical
 * evaluation window. Time conditions nested inside selectors remain ordinary
 * activity predicates. Top-level time bounds must be in a conjunction so they
 * cannot vary by boolean branch.
 */
export function prepareFilterTimeRange(
  document: FilterDocument,
  candidateRange: FilterTimeRange,
  capturedAtMs: number,
): FilterTimeRangePreparation {
  if (!document.root) return { filters: document };

  let hasBounds = false;
  let lowerBound: number | undefined;
  let upperBound: number | undefined;
  const readTopLevel = (
    expression: FilterExpression,
  ): FilterExpression | null => {
    if (expression.kind === "condition") {
      if (!isTimeTarget(expression.target)) return expression;
      hasBounds = true;
      const bounds = readBounds(expression, candidateRange, capturedAtMs);
      if (bounds.start !== undefined)
        lowerBound = Math.max(
          lowerBound ?? Number.MIN_SAFE_INTEGER,
          bounds.start,
        );
      if (bounds.end !== undefined)
        upperBound = Math.min(
          upperBound ?? Number.MAX_SAFE_INTEGER,
          bounds.end,
        );
      return null;
    }
    if (expression.kind === "and") {
      const children = expression.children
        .map(readTopLevel)
        .filter((child): child is FilterExpression => child !== null);
      if (children.length === 0) return null;
      return children.length === 1 ? children[0]! : { kind: "and", children };
    }
    if (hasTopLevelTime(expression))
      throw new TypeError("filter_time_range_must_be_unconditional");
    return expression;
  };

  const root = readTopLevel(document.root);
  if (!hasBounds) return { filters: document };

  const startMs = lowerBound ?? candidateRange.startMs;
  const endExclusiveMs =
    upperBound ?? Math.max(candidateRange.endExclusiveMs, capturedAtMs + 1);
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endExclusiveMs) ||
    endExclusiveMs <= startMs
  )
    throw new TypeError("filter_time_range_invalid");

  return {
    filters: copyDocumentWithRoot(document, root),
    evaluationRange: { startMs, endExclusiveMs },
  };
}
