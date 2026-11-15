import { countSelectorSupport } from "@/lib/edge/analytics/engine/advanced-count-selector-support";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  analyzeFilterDocument,
  validateFilterConditionDomains,
} from "@/lib/filter-contract/filter-semantics";
import {
  type FilterRelationScope,
  validateFilterRelationDomains,
} from "@/lib/filter-contract/filter-types";
import {
  type FilterDocument,
  type FilterExpression,
  type FilterTargetExpression,
  FilterValidationError,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

export interface SequenceWindow {
  readonly range: { readonly startMs: number; readonly endExclusiveMs: number };
  readonly readRange?: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly filterRange?: unknown;
  readonly fullHistory?: boolean;
  readonly filterRangeEmpty?: boolean;
  readonly capturedAtMs?: number;
}
export interface SequenceStep {
  readonly kind: "page" | "event";
  readonly predicate: FilterExpression | null;
  readonly window?: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
}
export interface SupportedSequence {
  readonly kind: "supported";
  readonly code: "sequence_sql_two_step_exists";
  readonly scope: "session" | "visitor";
  readonly document: FilterDocument;
  readonly steps: readonly [SequenceStep, SequenceStep];
  readonly windowCandidateRange?: SequenceWindow["range"];
}
export interface UnsupportedSequence {
  readonly kind: "unsupported";
  readonly code: string;
  readonly path: string;
  readonly reason: string;
}
export type SequenceSupport = SupportedSequence | UnsupportedSequence;
const proofs = new WeakMap<SupportedSequence, string>();
const unsupported = (
  code: string,
  reason: string,
  path = "root",
): UnsupportedSequence => ({ kind: "unsupported", code, path, reason });

// This slice deliberately reuses registered string field semantics only.
// Wider Count support (payload/numbers/reducers) does not imply Seq support.
function predicateSupported(
  expression: FilterExpression,
  kind: "page" | "event",
): boolean {
  if (expression.kind === "not")
    return predicateSupported(expression.child, kind);
  if (expression.kind === "and" || expression.kind === "or")
    return expression.children.every((child) =>
      predicateSupported(child, kind),
    );
  return (
    expression.kind === "condition" &&
    expression.target.kind === "field" &&
    expression.target.field === (kind === "page" ? "page.path" : "event.name")
  );
}
function step(
  input: FilterTargetExpression,
  path: string,
  range: SequenceWindow["range"],
): SequenceStep | UnsupportedSequence {
  if (input.kind === "window") {
    const duration = range.endExclusiveMs - range.startMs;
    if (
      !Number.isSafeInteger(range.startMs) ||
      !Number.isSafeInteger(range.endExclusiveMs) ||
      !Number.isSafeInteger(duration) ||
      duration <= 1 ||
      input.anchor.kind !== "time-anchor" ||
      input.anchor.anchor !== "range.start" ||
      input.anchor.offset !== undefined ||
      input.startOffset.unit !== "ms" ||
      input.startOffset.amount !== 0 ||
      input.endOffset.unit !== "ms" ||
      input.endOffset.amount !== duration - 1
    )
      return unsupported(
        "sequence_sql_window_unsupported",
        "Only explicit [range.start, range.end-1ms) windows with safe endpoints are supported in this slice.",
        path,
      );
    const inner = step(input.collection, `${path}.collection`, range);
    if (inner.kind === "unsupported") return inner;
    if (inner.window)
      return unsupported(
        "sequence_sql_window_unsupported",
        "Nested windows remain Core.",
        path,
      );
    return {
      ...inner,
      window: {
        startMs: range.startMs,
        endExclusiveMs: range.endExclusiveMs - 1,
      },
    };
  }
  const collection = input.kind === "selector" ? input.collection : input;
  if (
    collection.kind !== "entity-root" ||
    (collection.entity !== "page" && collection.entity !== "event")
  )
    return unsupported(
      "sequence_sql_step_collection_unsupported",
      "Steps must be finite Page/Event roots or direct selectors.",
      path,
    );
  if (input.kind === "selector") {
    const invalid = countSelectorSupport(input, path);
    if (invalid) return invalid;
    if (!predicateSupported(input.predicate, collection.entity))
      return unsupported(
        "sequence_sql_step_field_unsupported",
        "The first slice supports only own Page.path/Event.name string leaves.",
        path,
      );
  }
  return {
    kind: collection.entity,
    predicate: input.kind === "selector" ? input.predicate : null,
  };
}

/** Whole tree proof; no leaf-wise speculative routing or public validation. */
export function classifyTwoStepSequence(
  document: FilterDocument,
  scope: FilterRelationScope,
  time: SequenceWindow,
): SequenceSupport {
  let normalized: FilterDocument;
  try {
    normalized = normalizeFilterDocument(document, analyticsFilterRegistry);
    const analysis = analyzeFilterDocument(normalized, analyticsFilterRegistry);
    validateFilterConditionDomains(normalized, scope, analyticsFilterRegistry);
    validateFilterRelationDomains(normalized, scope, analysis);
  } catch (error) {
    return unsupported(
      error instanceof FilterValidationError
        ? error.code
        : "sequence_sql_invalid_analysis",
      error instanceof Error ? error.message : String(error),
      error instanceof FilterValidationError ? error.path : "root",
    );
  }
  if (scope !== "session" && scope !== "visitor")
    return unsupported(
      "sequence_sql_scope_unsupported",
      "Seq requires Session/Visitor scope.",
    );
  if (
    !Number.isSafeInteger(time.range.startMs) ||
    !Number.isSafeInteger(time.range.endExclusiveMs) ||
    time.range.startMs >= time.range.endExclusiveMs ||
    !Number.isSafeInteger(time.range.endExclusiveMs - time.range.startMs)
  )
    return unsupported(
      "sequence_sql_invalid_time_domain",
      "Candidate endpoints and duration must be safe finite nonempty milliseconds.",
    );
  const read = time.readRange ?? time.range;
  if (
    time.capturedAtMs !== undefined &&
    (!Number.isSafeInteger(time.capturedAtMs) ||
      !Number.isSafeInteger(time.capturedAtMs + 1) ||
      read.endExclusiveMs > time.capturedAtMs + 1)
  )
    return unsupported(
      "sequence_sql_invalid_time_domain",
      "The read domain must be within the captured clock and safe arithmetic.",
    );
  if (
    time.fullHistory ||
    time.filterRange !== undefined ||
    time.filterRangeEmpty ||
    read.startMs !== time.range.startMs ||
    read.endExclusiveMs !== time.range.endExclusiveMs
  )
    return unsupported(
      "sequence_sql_independent_time_domains",
      "The initial Seq slice requires one candidate/read/expression window.",
    );
  const root = normalized.root;
  if (
    root?.kind !== "condition" ||
    root.operator !== "exists" ||
    root.target.kind !== "sequence" ||
    root.target.steps.length !== 2
  )
    return unsupported(
      "sequence_sql_whole_tree_unsupported",
      "Only a bare two-step Seq exists tree is supported.",
    );
  const first = step(root.target.steps[0]!, "root.target.steps[0]", time.range);
  if (first.kind === "unsupported") return first;
  const second = step(
    root.target.steps[1]!,
    "root.target.steps[1]",
    time.range,
  );
  if (second.kind === "unsupported") return second;
  if (Boolean(first.window) !== Boolean(second.window))
    return unsupported(
      "sequence_sql_window_unsupported",
      "Both steps must use the same explicit window form.",
    );
  const result: SupportedSequence = {
    kind: "supported",
    code: "sequence_sql_two_step_exists",
    scope,
    document: normalized,
    steps: [first, second],
    ...(first.window ? { windowCandidateRange: { ...time.range } } : {}),
  };
  proofs.set(result, JSON.stringify(result));
  return result;
}

export function assertSequenceProof(proof: SupportedSequence): void {
  if (proofs.get(proof) !== JSON.stringify(proof))
    throw new Error("sequence_sql_support_proof_invalid");
}
