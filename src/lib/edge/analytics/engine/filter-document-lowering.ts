import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { NativeMatchRelation } from "@/lib/edge/analytics/engine/scope-contract";
import {
  createCandidateScopeUniverse,
  resolveScopeFilterSelection,
  type ScopeBooleanExpression,
  type ScopeFilterSelection,
} from "@/lib/edge/analytics/engine/scope-contract";
import { createNativeMatchConverter } from "@/lib/edge/analytics/engine/scope-rebase";
import type { LogicalFilterScope } from "@/lib/edge/analytics/engine/semantic/entities";
import {
  temporalDomainExists,
  type TemporalDomainRef,
} from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type AnalyzedFilterDocument,
  analyzeFilterDocument,
} from "@/lib/filter-contract/filter-semantics";
import {
  type FilterCondition,
  type FilterExpression,
  type FilterOperator,
} from "@/lib/filter-contract/filters";

import {
  type FilterLoweringUnsupportedCode,
  lowerFilterCondition,
} from "./filter-lowering";

export type FilterDocumentLoweringUnsupportedCode =
  | FilterLoweringUnsupportedCode
  | "condition-lowering-failed"
  | "invalid-analysis"
  | "invalid-document"
  | "missing-condition-time-domain"
  | "invalid-condition-time-domain"
  | "time-domain-resolution-failed"
  | "invalid-target-scope"
  | "unsupported-scope-conversion";

export interface FilterConditionTimeDomainContext {
  readonly analysis: AnalyzedFilterDocument;
  /** The original condition object held by `analysis.document`, not a copy. */
  readonly condition: FilterCondition;
  /** Stable AST location such as `root.children[1].child`. */
  readonly path: string;
  readonly targetScope: LogicalFilterScope;
}

export interface FilterDocumentLoweringOptions {
  /** Must be a concrete scope selected by the caller; `auto` is not accepted. */
  readonly targetScope: LogicalFilterScope;
  /** Every condition must receive an explicit candidate/filter/read domain. */
  readonly resolveTemporalDomain: (
    context: FilterConditionTimeDomainContext,
  ) => TemporalDomainRef | undefined;
}

export type FilterDocumentLoweringResult =
  | { readonly kind: "unfiltered" }
  | {
      readonly kind: "supported";
      readonly scope: LogicalFilterScope;
      readonly selection: Extract<ScopeFilterSelection, { kind: "matching" }>;
    }
  | {
      readonly kind: "unsupported";
      readonly code: FilterDocumentLoweringUnsupportedCode;
      readonly path: string;
      readonly conditionTarget?: string;
      readonly fieldId?: string;
      readonly operator?: FilterOperator;
      readonly reason: string;
    };

type PreparedExpression =
  | {
      readonly kind: "match";
      readonly condition: FilterCondition;
      readonly temporalDomain: TemporalDomainRef;
      readonly match: NativeMatchRelation;
    }
  | {
      readonly kind: "and" | "or";
      readonly children: readonly PreparedExpression[];
    }
  | { readonly kind: "not"; readonly child: PreparedExpression };

type PrepareResult =
  | { readonly kind: "prepared"; readonly expression: PreparedExpression }
  | {
      readonly kind: "unsupported";
      readonly result: Extract<
        FilterDocumentLoweringResult,
        { kind: "unsupported" }
      >;
    };

const SCOPES: readonly LogicalFilterScope[] = [
  "observation",
  "session",
  "visitor",
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetName(condition: FilterCondition): string {
  const target = condition.target;
  if (target.kind === "field") return target.field;
  if (target.kind === "event-payload") return `event-payload:${target.path}`;
  return target.kind;
}

function unsupported(
  code: FilterDocumentLoweringUnsupportedCode,
  path: string,
  reason: string,
  condition?: FilterCondition,
  fieldId?: string,
): Extract<FilterDocumentLoweringResult, { kind: "unsupported" }> {
  return {
    kind: "unsupported",
    code,
    path,
    ...(condition ? { conditionTarget: targetName(condition) } : {}),
    ...(fieldId ? { fieldId } : {}),
    ...(condition ? { operator: condition.operator } : {}),
    reason,
  };
}

function asScopeBooleanExpression(
  expression: PreparedExpression,
): ScopeBooleanExpression {
  if (expression.kind === "match")
    return { kind: "match", value: expression.match };
  if (expression.kind === "not")
    return {
      kind: "not",
      child: asScopeBooleanExpression(expression.child),
    };
  return {
    kind: expression.kind,
    children: expression.children.map(asScopeBooleanExpression),
  };
}

function lowerPreparedExpression(
  builder: LogicalPlanBuilder,
  analysis: AnalyzedFilterDocument,
  expression: PreparedExpression,
): ScopeBooleanExpression {
  if (expression.kind === "match") {
    const lowered = lowerFilterCondition(
      builder,
      analysis,
      expression.condition,
      expression.temporalDomain,
    );
    if (lowered.kind !== "supported") {
      throw new Error("filter_document_lowering_preflight_mismatch");
    }
    return { kind: "match", value: lowered.match };
  }
  if (expression.kind === "not")
    return {
      kind: "not",
      child: lowerPreparedExpression(builder, analysis, expression.child),
    };
  return {
    kind: expression.kind,
    children: expression.children.map((child) =>
      lowerPreparedExpression(builder, analysis, child),
    ),
  };
}

function prepareExpression(
  probeBuilder: LogicalPlanBuilder,
  analysis: AnalyzedFilterDocument,
  verifiedAnalysis: AnalyzedFilterDocument,
  targetScope: LogicalFilterScope,
  resolveTemporalDomain: FilterDocumentLoweringOptions["resolveTemporalDomain"],
  expression: FilterExpression,
  path: string,
): PrepareResult {
  if (expression.kind === "condition") {
    const condition = expression;
    let analyzed = false;
    try {
      analyzed =
        Boolean(analysis.conditions?.get(condition)) &&
        verifiedAnalysis.conditions.has(condition);
    } catch {
      analyzed = false;
    }
    if (!analyzed) {
      return {
        kind: "unsupported",
        result: unsupported(
          "invalid-analysis",
          path,
          "Condition identity is missing from the analyzed document sidecar.",
          condition,
        ),
      };
    }

    let temporalDomain: TemporalDomainRef | undefined;
    try {
      temporalDomain = resolveTemporalDomain({
        analysis,
        condition,
        path,
        targetScope,
      });
    } catch (error) {
      return {
        kind: "unsupported",
        result: unsupported(
          "time-domain-resolution-failed",
          path,
          `Condition time-domain selection failed: ${errorMessage(error)}`,
          condition,
        ),
      };
    }
    if (temporalDomain === undefined) {
      return {
        kind: "unsupported",
        result: unsupported(
          "missing-condition-time-domain",
          path,
          "The caller did not assign this condition a candidate, filter, or read time domain.",
          condition,
        ),
      };
    }
    if (!temporalDomainExists(probeBuilder.context.time, temporalDomain)) {
      return {
        kind: "unsupported",
        result: unsupported(
          "invalid-condition-time-domain",
          path,
          `The selected time domain '${temporalDomain}' is unavailable in the builder context.`,
          condition,
        ),
      };
    }

    let lowered: ReturnType<typeof lowerFilterCondition>;
    try {
      lowered = lowerFilterCondition(
        probeBuilder,
        analysis,
        condition,
        temporalDomain,
      );
    } catch (error) {
      return {
        kind: "unsupported",
        result: unsupported(
          "condition-lowering-failed",
          path,
          `Analyzed condition could not be lowered: ${errorMessage(error)}`,
          condition,
        ),
      };
    }
    if (lowered.kind === "unsupported") {
      return {
        kind: "unsupported",
        result: unsupported(
          lowered.code,
          path,
          `Primitive lowering does not support ${targetName(condition)} ${condition.operator} (${lowered.code}).`,
          condition,
          lowered.fieldId,
        ),
      };
    }
    return {
      kind: "prepared",
      expression: {
        kind: "match",
        condition,
        temporalDomain,
        match: lowered.match,
      },
    };
  }

  if (expression.kind === "not") {
    const child = prepareExpression(
      probeBuilder,
      analysis,
      verifiedAnalysis,
      targetScope,
      resolveTemporalDomain,
      expression.child,
      `${path}.child`,
    );
    if (child.kind === "unsupported") return child;
    return {
      kind: "prepared",
      expression: { kind: "not", child: child.expression },
    };
  }

  const children = expression.children;
  if (children.length === 0) {
    return {
      kind: "unsupported",
      result: unsupported(
        "invalid-document",
        path,
        "Boolean groups must contain at least one child; only a null root is unfiltered.",
      ),
    };
  }
  const preparedChildren: PreparedExpression[] = [];
  for (const [index, child] of children.entries()) {
    const prepared = prepareExpression(
      probeBuilder,
      analysis,
      verifiedAnalysis,
      targetScope,
      resolveTemporalDomain,
      child,
      `${path}.children[${index}]`,
    );
    if (prepared.kind === "unsupported") return prepared;
    preparedChildren.push(prepared.expression);
  }
  return {
    kind: "prepared",
    expression: { kind: expression.kind, children: preparedChildren },
  };
}

/**
 * Lowers one analyzed Filter v1 Boolean tree into a candidate-scope Logical IR.
 * Every leaf needs an explicit caller-selected temporal domain. A probe builder
 * preflights all leaves and set operations so unsupported documents leave the
 * supplied builder untouched.
 */
export function lowerFilterDocumentToScope(
  builder: LogicalPlanBuilder,
  analysis: AnalyzedFilterDocument,
  options: FilterDocumentLoweringOptions,
): FilterDocumentLoweringResult {
  if (
    !(builder instanceof LogicalPlanBuilder) ||
    !analysis ||
    typeof analysis !== "object" ||
    !analysis.document ||
    typeof analysis.document !== "object" ||
    analysis.document.version !== 1
  ) {
    return unsupported(
      "invalid-analysis",
      "root",
      "A version 1 analyzed FilterDocument and LogicalPlanBuilder are required.",
    );
  }

  let verifiedAnalysis: AnalyzedFilterDocument;
  try {
    verifiedAnalysis = analyzeFilterDocument(
      analysis.document,
      analyticsFilterRegistry,
    );
  } catch (error) {
    return unsupported(
      "invalid-analysis",
      "root",
      `Analyzed FilterDocument is invalid: ${errorMessage(error)}`,
    );
  }

  const targetScope = options?.targetScope;
  if (!SCOPES.includes(targetScope)) {
    return unsupported(
      "invalid-target-scope",
      "root",
      `A concrete observation, session, or visitor target scope is required; received '${String(targetScope)}'.`,
      undefined,
      String(targetScope),
    );
  }
  if (
    builder.context.scope.logicalScope !== null &&
    builder.context.scope.logicalScope !== targetScope
  ) {
    return unsupported(
      "invalid-target-scope",
      "root",
      `Target scope '${targetScope}' conflicts with the builder's resolved logical scope '${builder.context.scope.logicalScope}'.`,
      undefined,
      String(targetScope),
    );
  }

  const root = analysis.document.root;
  if (root === null) return Object.freeze({ kind: "unfiltered" });
  if (typeof options?.resolveTemporalDomain !== "function") {
    return unsupported(
      "missing-condition-time-domain",
      "root",
      "An explicit per-condition time-domain selector is required.",
    );
  }

  const probeBuilder = new LogicalPlanBuilder(builder.context);
  const prepared = prepareExpression(
    probeBuilder,
    analysis,
    verifiedAnalysis,
    targetScope,
    options.resolveTemporalDomain,
    root,
    "root",
  );
  if (prepared.kind === "unsupported") return prepared.result;

  try {
    const candidate = createCandidateScopeUniverse(probeBuilder, targetScope);
    resolveScopeFilterSelection(
      probeBuilder,
      candidate,
      asScopeBooleanExpression(prepared.expression),
      createNativeMatchConverter(probeBuilder),
    );
  } catch (error) {
    return unsupported(
      "unsupported-scope-conversion",
      "root",
      `FilterDocument cannot be converted to the selected candidate scope: ${errorMessage(error)}`,
      undefined,
      `scope:${targetScope}`,
    );
  }

  const expression = lowerPreparedExpression(
    builder,
    analysis,
    prepared.expression,
  );
  const candidate = createCandidateScopeUniverse(builder, targetScope);
  const selection = resolveScopeFilterSelection(
    builder,
    candidate,
    expression,
    createNativeMatchConverter(builder),
  );
  return Object.freeze({
    kind: "supported",
    scope: targetScope,
    selection,
  });
}
