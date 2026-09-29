import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { NativeMatchRelation } from "@/lib/edge/analytics/engine/scope-contract";
import {
  createCandidateScopeUniverse,
  resolveScopeFilterSelection,
  type ScopeBooleanExpression,
  type ScopeFilterSelection,
} from "@/lib/edge/analytics/engine/scope-contract";
import { createNativeMatchConverter } from "@/lib/edge/analytics/engine/scope-rebase";
import type {
  LogicalFilterScope,
  ObservationKind,
} from "@/lib/edge/analytics/engine/semantic/entities";
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
  observationCapabilityForAttribute,
  type PreparedPrimitiveFieldCondition,
  preparePrimitiveFieldCondition,
  primitivePredicateForSource,
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
  | "unsupported-scope-conversion"
  | "unsupported-selector"
  | "unsupported-selector-scope"
  | "unsupported-selector-operator"
  | "selector-temporal-domain-mismatch";

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
      readonly kind: "selector";
      readonly collection: ObservationKind;
      readonly predicate: PreparedActivityPredicate;
      readonly temporalDomain: TemporalDomainRef;
      readonly negative: boolean;
      readonly match: NativeMatchRelation;
    }
  | {
      readonly kind: "and" | "or";
      readonly children: readonly PreparedExpression[];
    }
  | { readonly kind: "not"; readonly child: PreparedExpression };

type PreparedActivityPredicate =
  | {
      readonly kind: "field";
      readonly originalCondition: FilterCondition;
      readonly preparedCondition: PreparedPrimitiveFieldCondition;
    }
  | {
      readonly kind: "and" | "or";
      readonly children: readonly PreparedActivityPredicate[];
    }
  | { readonly kind: "not"; readonly child: PreparedActivityPredicate };

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
  if (expression.kind === "selector") {
    const match: ScopeBooleanExpression = {
      kind: "match",
      value: expression.match,
    };
    return expression.negative ? { kind: "not", child: match } : match;
  }
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
  if (expression.kind === "selector") {
    const match = lowerActivitySelector(
      builder,
      expression.collection,
      expression.predicate,
      expression.temporalDomain,
    );
    const scopeMatch: ScopeBooleanExpression = { kind: "match", value: match };
    return expression.negative
      ? { kind: "not", child: scopeMatch }
      : scopeMatch;
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

type ActivityPredicatePrepareResult =
  | { readonly kind: "prepared"; readonly predicate: PreparedActivityPredicate }
  | {
      readonly kind: "unsupported";
      readonly result: Extract<
        FilterDocumentLoweringResult,
        { kind: "unsupported" }
      >;
    };

function prepareActivityPredicate(
  probeBuilder: LogicalPlanBuilder,
  analysis: AnalyzedFilterDocument,
  verifiedAnalysis: AnalyzedFilterDocument,
  targetScope: LogicalFilterScope,
  collection: ObservationKind,
  selectorPath: string,
  selectorTemporalDomain: TemporalDomainRef,
  resolveTemporalDomain: FilterDocumentLoweringOptions["resolveTemporalDomain"],
  expression: FilterExpression,
  path: string,
): ActivityPredicatePrepareResult {
  if (expression.kind === "not") {
    const child = prepareActivityPredicate(
      probeBuilder,
      analysis,
      verifiedAnalysis,
      targetScope,
      collection,
      selectorPath,
      selectorTemporalDomain,
      resolveTemporalDomain,
      expression.child,
      `${path}.child`,
    );
    return child.kind === "unsupported"
      ? child
      : {
          kind: "prepared",
          predicate: { kind: "not", child: child.predicate },
        };
  }

  if (expression.kind === "and" || expression.kind === "or") {
    if (expression.children.length === 0) {
      return {
        kind: "unsupported",
        result: unsupported(
          "invalid-document",
          path,
          "Activity selector Boolean groups must contain at least one child.",
        ),
      };
    }
    const children: PreparedActivityPredicate[] = [];
    for (const [index, child] of expression.children.entries()) {
      const prepared = prepareActivityPredicate(
        probeBuilder,
        analysis,
        verifiedAnalysis,
        targetScope,
        collection,
        selectorPath,
        selectorTemporalDomain,
        resolveTemporalDomain,
        child,
        `${path}.children[${index}]`,
      );
      if (prepared.kind === "unsupported") return prepared;
      children.push(prepared.predicate);
    }
    return {
      kind: "prepared",
      predicate: { kind: expression.kind, children },
    };
  }

  if (expression.kind !== "condition") {
    return {
      kind: "unsupported",
      result: unsupported(
        "invalid-document",
        path,
        "Activity selector predicates must be field conditions or Boolean groups.",
      ),
    };
  }
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
        "Activity predicate condition identity is missing from the analyzed document sidecar.",
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
        `Activity predicate time-domain selection failed: ${errorMessage(error)}`,
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
        "The caller did not assign this activity predicate a candidate, filter, or read time domain.",
        condition,
      ),
    };
  }
  if (temporalDomain !== selectorTemporalDomain) {
    return {
      kind: "unsupported",
      result: unsupported(
        "selector-temporal-domain-mismatch",
        path,
        `Activity selector at ${selectorPath} uses '${selectorTemporalDomain}', but this predicate uses '${temporalDomain}'.`,
        condition,
        condition.target.kind === "field" ? condition.target.field : undefined,
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

  let preparedCondition: ReturnType<typeof preparePrimitiveFieldCondition>;
  try {
    preparedCondition = preparePrimitiveFieldCondition(condition);
  } catch (error) {
    return {
      kind: "unsupported",
      result: unsupported(
        "condition-lowering-failed",
        path,
        `Analyzed activity predicate could not be lowered: ${errorMessage(error)}`,
        condition,
      ),
    };
  }
  if (preparedCondition.kind === "unsupported") {
    return {
      kind: "unsupported",
      result: unsupported(
        preparedCondition.code,
        path,
        `Activity selector does not support ${targetName(condition)} ${condition.operator} (${preparedCondition.code}).`,
        condition,
        preparedCondition.fieldId,
      ),
    };
  }

  const attribute = preparedCondition.attribute;
  const capability = observationCapabilityForAttribute(attribute);
  if (capability.kind === "unsupported") {
    return {
      kind: "unsupported",
      result: unsupported(
        capability.code,
        path,
        `Activity selector cannot read ${attribute.id} (${capability.code}).`,
        condition,
        attribute.id,
      ),
    };
  }
  // The capability check above guarantees observation evaluation, non-null
  // presence, and at least one supported observation collection.
  if (attribute.nativeEntity !== collection) {
    return {
      kind: "unsupported",
      result: unsupported(
        "unsupported-native-entity",
        path,
        `Activity selector for ${collection} cannot read ${attribute.id}, whose native entity is ${attribute.nativeEntity}.`,
        condition,
        attribute.id,
      ),
    };
  }

  return {
    kind: "prepared",
    predicate: {
      kind: "field",
      originalCondition: condition,
      preparedCondition,
    },
  };
}

function activityPredicateFields(
  predicate: PreparedActivityPredicate,
): string[] {
  if (predicate.kind === "field") return [predicate.preparedCondition.field.id];
  if (predicate.kind === "not") return activityPredicateFields(predicate.child);
  return predicate.children.flatMap(activityPredicateFields);
}

function compileActivityPredicate(
  builder: LogicalPlanBuilder,
  source: ReturnType<LogicalPlanBuilder["source"]>,
  predicate: PreparedActivityPredicate,
): ReturnType<LogicalPlanBuilder["coalesce"]> {
  if (predicate.kind === "field") {
    const prepared = predicate.preparedCondition;
    return builder.coalesce(
      primitivePredicateForSource(
        builder,
        source,
        prepared.condition,
        prepared.field,
        prepared.attribute,
      ),
      builder.literal(false, { kind: "scalar", scalar: "boolean" }),
    );
  }
  if (predicate.kind === "not") {
    return builder.not(
      compileActivityPredicate(builder, source, predicate.child),
    );
  }
  const children: ReturnType<LogicalPlanBuilder["coalesce"]>[] =
    predicate.children.map((child) =>
      compileActivityPredicate(builder, source, child),
    );
  return predicate.kind === "and"
    ? builder.and(...children)
    : builder.or(...children);
}

function lowerActivitySelector(
  builder: LogicalPlanBuilder,
  collection: ObservationKind,
  predicate: PreparedActivityPredicate,
  temporalDomain: TemporalDomainRef,
): NativeMatchRelation {
  const relationship = `${collection}.observation` as const;
  const attributeIds = [...new Set(activityPredicateFields(predicate))];
  const source = builder.source(collection, {
    attributes: attributeIds,
    relationships: [relationship],
    temporalDomain,
  });
  const filtered = builder.filter(
    source,
    compileActivityPredicate(builder, source, predicate),
  );
  const projected = builder.project(filtered, {
    observation: builder.slot(filtered, `relationship:${relationship}`),
  });
  const relation = builder.distinctEntity(projected, "observation");
  return {
    nativeEntity: "observation",
    relation,
    entitySlot: "observation",
    temporalDomain,
  };
}

function prepareActivitySelector(
  probeBuilder: LogicalPlanBuilder,
  analysis: AnalyzedFilterDocument,
  verifiedAnalysis: AnalyzedFilterDocument,
  targetScope: LogicalFilterScope,
  resolveTemporalDomain: FilterDocumentLoweringOptions["resolveTemporalDomain"],
  condition: FilterCondition,
  temporalDomain: TemporalDomainRef,
  path: string,
): PrepareResult {
  if (targetScope === "observation") {
    return {
      kind: "unsupported",
      result: unsupported(
        "unsupported-selector-scope",
        path,
        "Page/Event selectors are supported only for Session or Visitor targets; Observation selector anchoring remains unresolved.",
        condition,
      ),
    };
  }
  if (condition.operator !== "exists" && condition.operator !== "notExists") {
    return {
      kind: "unsupported",
      result: unsupported(
        "unsupported-selector-operator",
        path,
        `Page/Event selectors support exists or notExists; received '${condition.operator}'.`,
        condition,
      ),
    };
  }

  const target = condition.target;
  if (
    target.kind !== "selector" ||
    !target.collection ||
    target.collection.kind !== "entity-root" ||
    (target.collection.entity !== "page" &&
      target.collection.entity !== "event")
  ) {
    return {
      kind: "unsupported",
      result: unsupported(
        "unsupported-selector",
        path,
        "Only an entity-root Page or Event selector is supported.",
        condition,
      ),
    };
  }
  if (!target.predicate || typeof target.predicate !== "object") {
    return {
      kind: "unsupported",
      result: unsupported(
        "unsupported-selector",
        path,
        "The Page/Event selector has no Boolean predicate.",
        condition,
      ),
    };
  }

  const collection = target.collection.entity;
  const preparedPredicate = prepareActivityPredicate(
    probeBuilder,
    analysis,
    verifiedAnalysis,
    targetScope,
    collection,
    path,
    temporalDomain,
    resolveTemporalDomain,
    target.predicate,
    `${path}.target.predicate`,
  );
  if (preparedPredicate.kind === "unsupported") return preparedPredicate;

  try {
    const match = lowerActivitySelector(
      probeBuilder,
      collection,
      preparedPredicate.predicate,
      temporalDomain,
    );
    return {
      kind: "prepared",
      expression: {
        kind: "selector",
        collection,
        predicate: preparedPredicate.predicate,
        temporalDomain,
        negative: condition.operator === "notExists",
        match,
      },
    };
  } catch (error) {
    return {
      kind: "unsupported",
      result: unsupported(
        "condition-lowering-failed",
        path,
        `Page/Event selector could not be lowered: ${errorMessage(error)}`,
        condition,
      ),
    };
  }
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

    if (condition.target.kind === "selector") {
      return prepareActivitySelector(
        probeBuilder,
        analysis,
        verifiedAnalysis,
        targetScope,
        resolveTemporalDomain,
        condition,
        temporalDomain,
        path,
      );
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
