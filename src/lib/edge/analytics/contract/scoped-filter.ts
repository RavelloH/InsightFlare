import {
  analyzeFilterHistory,
  type FilterHistoryRequirement,
} from "@/lib/filter-contract/filter-history";
import {
  analyticsFilterDefinition,
  analyticsFilterRegistry,
  type FilterFieldSource,
} from "@/lib/filter-contract/filter-registry";
import {
  analyzeFilterDocument,
  validateFilterConditionDomains,
} from "@/lib/filter-contract/filter-semantics";
import {
  filterDocumentUsesAdvancedExpressions,
  validateFilterRelationDomains,
} from "@/lib/filter-contract/filter-types";
import type {
  FilterCondition,
  FilterDocument,
  FilterExpression,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";
import { isLegacyFilterTarget } from "@/lib/filter-contract/filters";
import {
  copyFilterScopePreferenceMetadata,
  type FilterScope,
  type FilterScopePreference,
  filterScopePreferenceFromDocument,
  normalizeFilterScopePreference,
  savedFilterScopePreferenceFromDocument,
} from "@/lib/filter-contract/scope-preference";

import type { QueryInput, QueryOperation, QueryTime } from "./types";

export type ObservationSource = FilterFieldSource;

export type ScopedFactEntityKind = "session" | "visitor";

export type EntitySetExpression =
  | { readonly kind: "condition"; readonly condition: FilterCondition }
  | {
      readonly kind: "and" | "or";
      readonly children: readonly EntitySetExpression[];
    }
  | { readonly kind: "not"; readonly child: EntitySetExpression };

export interface ObservationMembershipPlan {
  readonly kind: "observation";
  readonly expression: FilterExpression | null;
}

export interface EntityMembershipPlan {
  readonly kind: "entity";
  readonly entityKind: ScopedFactEntityKind;
  readonly expression: EntitySetExpression | null;
}

export interface ScopedFilterPlan {
  readonly scope: FilterScope;
  readonly mode: "observation" | "entity";
  readonly membership: ObservationMembershipPlan | EntityMembershipPlan;
  readonly expansion:
    "matching-observations" | "matching-sessions" | "matching-visitors";
  readonly requiredSources: ReadonlySet<ObservationSource>;
  readonly requiresRawSource: boolean;
  /** Resolved once by the D1 runtime for Core/Relation documents. */
  readonly advancedMatches?: AdvancedFilterMatches;
}

export interface AdvancedFilterIdentity {
  readonly siteId: string;
  readonly id: string;
}

export interface AdvancedFilterMatches {
  readonly entityIds?: readonly AdvancedFilterIdentity[];
  readonly visitIds?: readonly AdvancedFilterIdentity[];
  readonly eventIds?: readonly AdvancedFilterIdentity[];
}

export interface ScopedFilteringCapability {
  readonly kind: "scoped";
  readonly supportedScopes: readonly FilterScope[];
  readonly autoScope: FilterScope;
}

export interface UnscopedFilteringCapability {
  readonly kind: "none";
}

export type FilterScopeCapability =
  ScopedFilteringCapability | UnscopedFilteringCapability;

const ALL_SCOPES = ["event", "session", "visitor"] as const;

const scoped = (autoScope: FilterScope): ScopedFilteringCapability => ({
  kind: "scoped",
  supportedScopes: ALL_SCOPES,
  autoScope,
});

const none: UnscopedFilteringCapability = Object.freeze({ kind: "none" });

/**
 * Every canonical operation is intentionally listed.  Do not replace this
 * table with an "everything else is event" fallback: adding an operation must
 * force an explicit scope decision in review.
 */
export const FILTER_SCOPE_CAPABILITIES: Readonly<
  Record<QueryOperation, FilterScopeCapability>
> = {
  overview: scoped("event"),
  trend: scoped("event"),
  "team-sites": scoped("event"),
  comparison: scoped("event"),
  "comparison-breakdown": scoped("event"),
  dimension: scoped("event"),
  "cross-dimension": scoped("event"),
  "share-trend": scoped("event"),
  radar: scoped("event"),
  pages: scoped("event"),
  "pages-dashboard": scoped("event"),
  referrers: scoped("event"),
  channels: scoped("event"),
  "filter-values": scoped("event"),
  retention: scoped("event"),
  "geo-points": scoped("event"),
  performance: scoped("event"),
  realtime: none,
  "event-summary": scoped("event"),
  "event-trend": scoped("event"),
  "event-types": scoped("event"),
  "event-type-detail": scoped("event"),
  "event-fields": scoped("event"),
  "event-field-values": scoped("event"),
  "event-context": scoped("event"),
  "event-records": scoped("event"),
  "visitor-events": scoped("visitor"),
  "visitor-sessions": scoped("visitor"),
  "session-events": scoped("session"),
  "event-record-detail": none,
  "journey-event-detail": none,
  visitors: scoped("visitor"),
  "visitor-detail": none,
  sessions: scoped("session"),
  "session-detail": none,
  "funnel-analysis": scoped("event"),
  "goal-summary": scoped("event"),
  "goal-timeseries": scoped("event"),
  "team-dashboard": scoped("event"),
  explore: scoped("event"),
};

function entityExpression(
  expression: FilterExpression | null,
): EntitySetExpression | null {
  if (!expression) return null;
  if (expression.kind === "condition") {
    if (!isLegacyFilterTarget(expression.target)) {
      throw new Error("unsupported_filter_expression");
    }
    return { kind: "condition", condition: expression };
  }
  if (expression.kind === "not") {
    return { kind: "not", child: entityExpression(expression.child)! };
  }
  return {
    kind: expression.kind,
    children: expression.children.map((child) => entityExpression(child)!),
  };
}

function factEntityKindForCondition(
  condition: FilterCondition,
): ScopedFactEntityKind | null {
  if (condition.target.kind !== "field") return null;
  const definition = analyticsFilterDefinition(condition.target.field);
  if (!definition) return null;
  if (definition.evaluation === "session-fact") return "session";
  if (definition.evaluation === "visitor-fact") return "visitor";

  // Keep compatibility with metadata produced before `evaluation` was
  // introduced. Derived session boundary fields intentionally do not enter
  // this fallback because their explicit evaluation remains `derived`.
  if (!definition.evaluation && definition.nativeEntity === "session") {
    return "session";
  }
  if (!definition.evaluation && definition.nativeEntity === "visitor") {
    return "visitor";
  }
  return null;
}

export function factEntityKindsForFilter(
  expression: FilterExpression | null,
): ReadonlySet<ScopedFactEntityKind> {
  const kinds = new Set<ScopedFactEntityKind>();
  const visit = (item: FilterExpression | null): void => {
    if (!item) return;
    if (item.kind === "condition") {
      const kind = factEntityKindForCondition(item);
      if (kind) kinds.add(kind);
      return;
    }
    if (item.kind === "not") {
      visit(item.child);
      return;
    }
    item.children.forEach(visit);
  };
  visit(expression);
  return kinds;
}

function requiredSources(
  expression: FilterExpression | null,
): ReadonlySet<ObservationSource> {
  const sources = new Set<ObservationSource>();
  const visitTarget = (target: FilterTargetExpression): void => {
    if (target.kind === "event-payload") {
      sources.add("payload");
      return;
    }
    if (target.kind === "field") {
      const definition = analyticsFilterDefinition(target.field);
      if (definition) sources.add(definition.source);
      return;
    }
    switch (target.kind) {
      case "member":
        visitTarget(target.object);
        break;
      case "selector":
        visitTarget(target.collection);
        visit(target.predicate);
        break;
      case "projection":
        visitTarget(target.collection);
        if (target.member === "payload") sources.add("payload");
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
      default:
        break;
    }
  };
  const visit = (item: FilterExpression | null): void => {
    if (!item) return;
    if (item.kind === "condition") {
      visitTarget(item.target);
      return;
    }
    if (item.kind === "not") {
      visit(item.child);
      return;
    }
    item.children.forEach(visit);
  };
  visit(expression);
  return sources;
}

export function filterScopeCapabilityFor(
  operation: QueryOperation,
): FilterScopeCapability {
  const capability = FILTER_SCOPE_CAPABILITIES[operation];
  if (!capability) {
    throw new Error(`missing_filter_scope_capability:${operation}`);
  }
  return capability;
}

export function reconcileFilterScopePreferences(
  caller: FilterScopePreference,
  saved: FilterScopePreference,
): FilterScopePreference {
  if (caller === "auto") return saved;
  if (saved === "auto") return caller;
  if (caller === saved) return caller;
  throw new Error("scope_conflict");
}

/**
 * Comparison is the one query shape with two independent filter documents.
 * Auto is neutral here: resolve the common concrete preference once after
 * both sides have reconciled their caller and Saved Filter preferences.
 */
export function reconcileComparisonFilterScopePreferences(
  preferences: readonly FilterScopePreference[],
): FilterScopePreference {
  const concrete = new Set(
    preferences.filter((preference) => preference !== "auto"),
  );
  if (concrete.size > 1) throw new Error("scope_conflict");
  return [...concrete][0] ?? "auto";
}

export function resolveFilterScope(
  operation: QueryOperation,
  preference: FilterScopePreference,
): FilterScope | null {
  const capability = filterScopeCapabilityFor(operation);
  if (capability.kind === "none") {
    if (preference !== "auto") throw new Error("unsupported_filter_scope");
    return null;
  }
  const resolved = preference === "auto" ? capability.autoScope : preference;
  if (!capability.supportedScopes.includes(resolved)) {
    throw new Error("unsupported_filter_scope");
  }
  return resolved;
}

export function createScopedFilterPlan(
  operation: QueryOperation,
  filters: FilterDocument,
  preference: FilterScopePreference = "auto",
): ScopedFilterPlan | null {
  const scope = resolveFilterScope(operation, preference);
  if (!scope) return null;
  const expression = filters.root;
  const sources = requiredSources(expression);
  const factKinds = factEntityKindsForFilter(expression);
  const hasAdvancedExpressions = filterDocumentUsesAdvancedExpressions(filters);
  const entityKind =
    scope === "session"
      ? "session"
      : scope === "visitor"
        ? "visitor"
        : factKinds.has("session")
          ? "session"
          : "visitor";
  const mode =
    scope === "event"
      ? hasAdvancedExpressions
        ? "observation"
        : factKinds.size > 0
          ? "entity"
          : "observation"
      : "entity";
  const usesEntityMembership = mode === "entity";
  return {
    scope,
    mode,
    membership: !usesEntityMembership
      ? { kind: "observation", expression }
      : {
          kind: "entity",
          entityKind,
          expression: hasAdvancedExpressions
            ? null
            : entityExpression(expression),
        },
    expansion:
      scope === "event"
        ? "matching-observations"
        : scope === "session"
          ? "matching-sessions"
          : "matching-visitors",
    requiredSources: sources,
    requiresRawSource:
      scope !== "event" || sources.size > 0 || expression !== null,
  };
}

export function prepareScopedQuery<T extends QueryInput>(
  operation: QueryOperation,
  query: T,
): [T] extends [never]
  ? QueryInput
  : T & { readonly scopePlan?: ScopedFilterPlan };
export function prepareScopedQuery(
  operation: QueryOperation,
  query: QueryInput,
): QueryInput {
  if (
    (operation === "comparison" ||
      operation === "comparison-breakdown" ||
      operation === "dimension" ||
      operation === "channels") &&
    isComparisonQuery(query)
  ) {
    return prepareScopedComparisonQuery(operation, query);
  }
  const requestedScope = normalizeFilterScopePreference(
    query.scopePreference ?? filterScopePreferenceFromDocument(query.filters),
  );
  const savedScope = normalizeFilterScopePreference(
    savedFilterScopePreferenceFromDocument(query.filters),
  );
  const reconciledScope = reconcileFilterScopePreferences(
    requestedScope,
    savedScope,
  );
  const plan = createScopedFilterPlan(
    operation,
    query.filters ?? { version: 1, root: null },
    reconciledScope,
  );
  if (!plan) return { ...query, scopePreference: requestedScope };
  const filters = query.filters ?? { version: 1, root: null };
  const semanticAnalysis = analyzeFilterDocument(
    filters,
    analyticsFilterRegistry,
  );
  validateFilterConditionDomains(filters, plan.scope, analyticsFilterRegistry);
  validateFilterRelationDomains(filters, plan.scope, semanticAnalysis);
  const time =
    "time" in query && query.time ? (query.time as QueryTime) : undefined;
  if (!time) {
    throw new Error("scoped_query_requires_time");
  }
  const history = analyzeFilterHistory(
    semanticAnalysis,
    time.range,
    time.capturedAtMs,
    plan.scope,
  );
  const plannedTime = timeWithFilterHistory(time, history);
  const subject = query.context.subject;
  const siteIds =
    subject.kind === "site" ? [subject.siteId] : [...subject.authorizedSiteIds];
  return {
    ...query,
    time: plannedTime,
    scopePreference: requestedScope,
    scopePlan: plan,
    filters: attachScopedFilterMetadata(filters, {
      requestedScope,
      resolvedScope: plan.scope,
      plan,
      time: plannedTime,
      siteIds,
    }),
  } as QueryInput;
}

interface ComparisonSideInput {
  readonly time: QueryTime;
  readonly filters?: FilterDocument;
  readonly scopePreference?: FilterScopePreference;
  readonly [key: string]: unknown;
}

function timeWithFilterHistory(
  time: QueryTime,
  history: FilterHistoryRequirement,
): QueryTime {
  const base: QueryTime = {
    range: time.range,
    reportingTimeZone: time.reportingTimeZone,
    capturedAtMs: time.capturedAtMs,
    ...(time.paginationBinding !== undefined
      ? { paginationBinding: time.paginationBinding }
      : {}),
  };
  if (history.kind === "full-history") return { ...base, fullHistory: true };
  if (history.kind === "bounded")
    return {
      ...base,
      evaluationRange: {
        startMs: history.startMs as QueryTime["range"]["startMs"],
        endExclusiveMs:
          history.endExclusiveMs as QueryTime["range"]["endExclusiveMs"],
      },
    };
  return base;
}

interface ComparisonQueryInput extends QueryInput {
  readonly current: ComparisonSideInput;
  readonly reference: ComparisonSideInput;
}

function isComparisonQuery(query: QueryInput): query is ComparisonQueryInput {
  const candidate = query as Partial<ComparisonQueryInput>;
  return Boolean(candidate.current?.time && candidate.reference?.time);
}

function prepareScopedComparisonQuery(
  operation: QueryOperation,
  query: ComparisonQueryInput,
): QueryInput {
  const requestedScope = normalizeFilterScopePreference(query.scopePreference);
  const prepareSide = (side: ComparisonSideInput) => {
    const sideCallerScope = normalizeFilterScopePreference(
      side.scopePreference ?? requestedScope,
    );
    const savedScope = normalizeFilterScopePreference(
      savedFilterScopePreferenceFromDocument(side.filters),
    );
    return {
      side,
      preference: reconcileFilterScopePreferences(sideCallerScope, savedScope),
    };
  };
  const current = prepareSide(query.current);
  const reference = prepareSide(query.reference);
  const comparisonPreference = reconcileComparisonFilterScopePreferences([
    current.preference,
    reference.preference,
  ]);
  const resolvedScope = resolveFilterScope(operation, comparisonPreference);
  if (!resolvedScope) throw new Error("scope_conflict");
  const subject = query.context.subject;
  const siteIds =
    subject.kind === "site" ? [subject.siteId] : [...subject.authorizedSiteIds];
  const currentPlan = createScopedFilterPlan(
    operation,
    current.side.filters ?? { version: 1, root: null },
    resolvedScope,
  );
  const referencePlan = createScopedFilterPlan(
    operation,
    reference.side.filters ?? { version: 1, root: null },
    resolvedScope,
  );
  if (!currentPlan || !referencePlan)
    throw new Error("unsupported_filter_scope");
  const prepareResolvedSide = (side: ComparisonSideInput) => {
    const filters = side.filters ?? { version: 1, root: null };
    const semanticAnalysis = analyzeFilterDocument(
      filters,
      analyticsFilterRegistry,
    );
    validateFilterConditionDomains(
      filters,
      resolvedScope,
      analyticsFilterRegistry,
    );
    validateFilterRelationDomains(filters, resolvedScope, semanticAnalysis);
    const history = analyzeFilterHistory(
      semanticAnalysis,
      side.time.range,
      side.time.capturedAtMs,
      resolvedScope,
    );
    const time = timeWithFilterHistory(side.time, history);
    return { ...side, filters, time };
  };
  const scopedSide = (prepared: {
    side: ComparisonSideInput;
    plan: ScopedFilterPlan;
    callerScope: FilterScopePreference;
  }): ComparisonSideInput => {
    const resolvedSide = prepareResolvedSide(prepared.side);
    return {
      ...resolvedSide,
      scopePreference: resolvedScope,
      filters: attachScopedFilterMetadata(resolvedSide.filters!, {
        requestedScope: prepared.callerScope,
        resolvedScope,
        plan: prepared.plan,
        time: resolvedSide.time,
        siteIds,
      }),
    };
  };
  return {
    ...query,
    scopePreference: requestedScope,
    scopePlan: currentPlan,
    current: scopedSide({
      ...current,
      plan: currentPlan,
      callerScope: normalizeFilterScopePreference(
        current.side.scopePreference ?? requestedScope,
      ),
    }),
    reference: scopedSide({
      ...reference,
      plan: referencePlan,
      callerScope: normalizeFilterScopePreference(
        reference.side.scopePreference ?? requestedScope,
      ),
    }),
  } as QueryInput;
}

const SCOPED_FILTER_METADATA = Symbol("insightflare.scoped-filter-metadata");

export interface ScopedFilterMetadata {
  readonly requestedScope: FilterScopePreference;
  readonly resolvedScope: FilterScope;
  readonly plan: ScopedFilterPlan;
  readonly time: QueryTime;
  readonly siteIds: readonly string[];
}

export type ScopedFilterDocument = FilterDocument & {
  readonly [SCOPED_FILTER_METADATA]?: ScopedFilterMetadata;
};

function copyScopedMetadata(
  source: FilterDocument,
  target: ScopedFilterDocument,
  skip?: symbol,
): void {
  copyFilterScopePreferenceMetadata(source, target);
  const scopedMetadata = (source as ScopedFilterDocument)[
    SCOPED_FILTER_METADATA
  ];
  if (skip !== SCOPED_FILTER_METADATA && scopedMetadata !== undefined) {
    Object.defineProperty(target, SCOPED_FILTER_METADATA, {
      value: scopedMetadata,
      enumerable: false,
      writable: false,
    });
  }
}

export function attachScopedFilterMetadata(
  filters: FilterDocument,
  metadata: ScopedFilterMetadata,
): ScopedFilterDocument {
  const scopedFilters = { ...filters } as ScopedFilterDocument;
  copyScopedMetadata(filters, scopedFilters, SCOPED_FILTER_METADATA);
  Object.defineProperty(scopedFilters, SCOPED_FILTER_METADATA, {
    value: metadata,
    enumerable: false,
    writable: false,
  });
  return scopedFilters;
}

export function scopedFilterMetadata(
  filters: FilterDocument | undefined,
): ScopedFilterMetadata | undefined {
  if (!filters) return undefined;
  return (filters as ScopedFilterDocument)[SCOPED_FILTER_METADATA];
}

/**
 * Pagination binding input for an already prepared query. Pagination must
 * consume this resolved plan instead of resolving scope independently in each
 * provider. An unfiltered query has no scope semantics.
 */
export function effectiveScopeForPagination(
  filters: FilterDocument | undefined,
): FilterScope | "none" {
  if (!filters?.root) return "none";
  return scopedFilterMetadata(filters)?.resolvedScope ?? "none";
}
