import {
  analyticsFilterDefinition,
  type FilterFieldSource,
} from "./filter-registry";
import type {
  FilterCondition,
  FilterDocument,
  FilterExpression,
} from "./filters";
import type { QueryInput, QueryOperation, QueryTime } from "./types";

export type FilterScope = "event" | "session" | "visitor";
export type FilterScopePreference = FilterScope | "auto";

export type ObservationSource = FilterFieldSource;

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
  readonly entityKind: "session" | "visitor";
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
}

export interface SqlBinding {
  readonly value: string | number | null;
}

export interface ScopedDatasetSql {
  readonly ctes: string;
  readonly bindings: readonly SqlBinding[];
  readonly visitRelation: string;
  readonly eventRelation: string;
  readonly sessionRelation: string;
  readonly visitorRelation: string;
  readonly scope: FilterScope;
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
  "team-dashboard": scoped("event"),
  explore: scoped("event"),
};

function entityExpression(
  expression: FilterExpression | null,
): EntitySetExpression | null {
  if (!expression) return null;
  if (expression.kind === "condition") {
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

function requiredSources(
  expression: FilterExpression | null,
): ReadonlySet<ObservationSource> {
  const sources = new Set<ObservationSource>();
  const visit = (item: FilterExpression | null): void => {
    if (!item) return;
    if (item.kind === "condition") {
      if (item.target.kind === "event-payload") {
        sources.add("payload");
        return;
      }
      const definition = analyticsFilterDefinition(item.target.field);
      if (definition) sources.add(definition.source);
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

export function normalizeFilterScopePreference(
  value: unknown,
): FilterScopePreference {
  if (value === undefined || value === null || value === "") return "auto";
  if (
    value === "auto" ||
    value === "event" ||
    value === "session" ||
    value === "visitor"
  ) {
    return value;
  }
  throw new Error("invalid_filter_scope");
}

function scopeSearchParams(
  input: string | URL | URLSearchParams,
): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (input instanceof URL) return input.searchParams;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) {
    return new URL(input).searchParams;
  }
  return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
}

export function parseFilterScopePreference(
  input: string | URL | URLSearchParams,
  parameter = "scope",
): FilterScopePreference {
  return normalizeFilterScopePreference(
    scopeSearchParams(input).get(parameter),
  );
}

export function serializeFilterScopePreference(
  input: URLSearchParams,
  preference: FilterScopePreference,
  parameter = "scope",
): URLSearchParams {
  const result = new URLSearchParams(input);
  if (preference === "auto") result.delete(parameter);
  else result.set(parameter, preference);
  return result;
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
  const entityKind = scope === "session" ? "session" : "visitor";
  return {
    scope,
    mode: scope === "event" ? "observation" : "entity",
    membership:
      scope === "event"
        ? { kind: "observation", expression }
        : {
            kind: "entity",
            entityKind,
            expression: entityExpression(expression),
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

export function prepareScopedQuery(
  operation: QueryOperation,
  query: QueryInput,
): QueryInput {
  if (
    (operation === "comparison" || operation === "comparison-breakdown") &&
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
  const time =
    "time" in query && query.time ? (query.time as QueryTime) : undefined;
  if (!time) {
    throw new Error("scoped_query_requires_time");
  }
  const subject = query.context.subject;
  const siteIds =
    subject.kind === "site" ? [subject.siteId] : [...subject.authorizedSiteIds];
  return {
    ...query,
    scopePreference: requestedScope,
    scopePlan: plan,
    filters: attachScopedFilterMetadata(
      query.filters ?? { version: 1, root: null },
      {
        requestedScope,
        resolvedScope: plan.scope,
        plan,
        time,
        siteIds,
      },
    ),
  };
}

interface ComparisonSideInput {
  readonly time: QueryTime;
  readonly filters?: FilterDocument;
  readonly scopePreference?: FilterScopePreference;
  readonly [key: string]: unknown;
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
  const scopedSide = (prepared: {
    side: ComparisonSideInput;
    plan: ScopedFilterPlan;
    callerScope: FilterScopePreference;
  }): ComparisonSideInput => ({
    ...prepared.side,
    scopePreference: resolvedScope,
    filters: attachScopedFilterMetadata(
      prepared.side.filters ?? { version: 1, root: null },
      {
        requestedScope: prepared.callerScope,
        resolvedScope,
        plan: prepared.plan,
        time: prepared.side.time,
        siteIds,
      },
    ),
  });
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
const FILTER_SCOPE_PREFERENCE = Symbol("insightflare.filter-scope-preference");
const SAVED_FILTER_SCOPE_PREFERENCE = Symbol(
  "insightflare.saved-filter-scope-preference",
);

export interface ScopedFilterMetadata {
  readonly requestedScope: FilterScopePreference;
  readonly resolvedScope: FilterScope;
  readonly plan: ScopedFilterPlan;
  readonly time: QueryTime;
  readonly siteIds: readonly string[];
}

export type ScopedFilterDocument = FilterDocument & {
  readonly [SCOPED_FILTER_METADATA]?: ScopedFilterMetadata;
  readonly [FILTER_SCOPE_PREFERENCE]?: FilterScopePreference;
  readonly [SAVED_FILTER_SCOPE_PREFERENCE]?: FilterScopePreference;
};

function copyScopedMetadata(
  source: FilterDocument,
  target: ScopedFilterDocument,
  skip?: symbol,
): void {
  const sourceRecord = source as ScopedFilterDocument;
  const entries = [
    [FILTER_SCOPE_PREFERENCE, sourceRecord[FILTER_SCOPE_PREFERENCE]],
    [
      SAVED_FILTER_SCOPE_PREFERENCE,
      sourceRecord[SAVED_FILTER_SCOPE_PREFERENCE],
    ],
    [SCOPED_FILTER_METADATA, sourceRecord[SCOPED_FILTER_METADATA]],
  ] as const;
  for (const [key, value] of entries) {
    if (key !== skip && value !== undefined) {
      Object.defineProperty(target, key, {
        value,
        enumerable: false,
        writable: false,
      });
    }
  }
}

export function attachFilterScopePreference(
  filters: FilterDocument,
  preference: FilterScopePreference,
): ScopedFilterDocument {
  const scopedFilters = { ...filters } as ScopedFilterDocument;
  copyScopedMetadata(filters, scopedFilters, FILTER_SCOPE_PREFERENCE);
  Object.defineProperty(scopedFilters, FILTER_SCOPE_PREFERENCE, {
    value: preference,
    enumerable: false,
    writable: false,
  });
  return scopedFilters;
}

export function filterScopePreferenceFromDocument(
  filters: FilterDocument | undefined,
): FilterScopePreference | undefined {
  if (!filters) return undefined;
  return (filters as ScopedFilterDocument)[FILTER_SCOPE_PREFERENCE];
}

export function attachSavedFilterScopePreference(
  filters: FilterDocument,
  preference: FilterScopePreference,
): ScopedFilterDocument {
  const scopedFilters = { ...filters } as ScopedFilterDocument;
  copyScopedMetadata(filters, scopedFilters, SAVED_FILTER_SCOPE_PREFERENCE);
  Object.defineProperty(scopedFilters, SAVED_FILTER_SCOPE_PREFERENCE, {
    value: preference,
    enumerable: false,
    writable: false,
  });
  return scopedFilters;
}

export function savedFilterScopePreferenceFromDocument(
  filters: FilterDocument | undefined,
): FilterScopePreference | undefined {
  if (!filters) return undefined;
  return (filters as ScopedFilterDocument)[SAVED_FILTER_SCOPE_PREFERENCE];
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
