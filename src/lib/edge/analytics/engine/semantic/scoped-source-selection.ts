import { assertObservationFilterCompatible } from "@/lib/edge/analytics/contract/observation-planner";
import {
  type PreparedMembership,
  preparedMembershipSiteIds,
} from "@/lib/edge/analytics/contract/prepared-membership";
import {
  createScopedFilterPlan,
  factEntityKindsForFilter,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  QueryOperation,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type { LogicalPlanContext } from "@/lib/edge/analytics/engine/logical/plan";
import {
  isQualificationDependencyRef,
  type QualificationDependencyRef,
  qualificationDependencyRefsMatchScope,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import {
  createSemanticSubjectDomain,
  type SemanticSubjectDomain,
} from "@/lib/edge/analytics/engine/semantic/subject";
import {
  createSemanticTemporalDomains,
  type SemanticTemporalDomains,
  semanticTemporalDomainsFromQueryTime,
} from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";
import {
  type FilterDocument,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";
import type { FilterScope } from "@/lib/filter-contract/scope-preference";

export type SemanticScopedSourceProfile =
  | "prepared-scoped-v1"
  | "prepared-page-reader-window-v1"
  | "prepared-scoped-reader-window-v1"
  | "direct-event-records-v1"
  | "direct-event-analytics-v1"
  | "direct-page-analytics-v1"
  | "direct-page-session-compat-v1"
  | "direct-page-entity-only-compat-v1";

export interface SemanticEventNameGate {
  readonly value: string;
  readonly semantics:
    | "prepared-trimmed-label-v1"
    | "prepared-defined-raw-value-v1"
    | "direct-subject-local-exact-name-v1";
}

export const SEMANTIC_POST_OBSERVATION_FILTER =
  "legacy-projected-observation-v1" as const;

/** A value-only second filter applied after the Source's authorized selection. */
export interface SemanticPostObservationFilter {
  readonly semantics: typeof SEMANTIC_POST_OBSERVATION_FILTER;
  readonly filter: FilterDocument;
}

/**
 * A value-only snapshot of the legacy Filter contract applied to one Source.
 * It deliberately has no storage identifiers, SQL, or D1 planning hints.
 */
export interface SemanticScopedSourceSelection {
  readonly version: 1;
  readonly profile: SemanticScopedSourceProfile;
  readonly filter: FilterDocument;
  readonly scope: FilterScope;
  readonly mode: "observation" | "entity";
  readonly entityKind?: "session" | "visitor";
  /** Opaque, request-private evaluation result; never identity data. */
  readonly preparedMembership?: PreparedMembership;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly eventNameGate?: SemanticEventNameGate;
  readonly postObservationFilter?: SemanticPostObservationFilter;
  readonly subject: SemanticSubjectDomain;
  /** Upstream authorization proof; subject sites may be a subset. */
  readonly authorizedSiteIds: readonly string[];
  readonly time: SemanticTemporalDomains;
  /** Original prepared time, retained as proof when a Page reader selects a different window. */
  readonly preparationTime?: SemanticTemporalDomains;
}

export interface CreateSemanticScopedSourceSelectionInput {
  readonly profile: SemanticScopedSourceProfile;
  readonly filters: FilterDocument;
  readonly subject: SemanticSubjectDomain;
  readonly time: SemanticTemporalDomains;
  /** Required for prepared-scoped-v1 and must be the exact prepared plan. */
  readonly expectedPlan?: ScopedFilterPlan;
  /** Operation whose scope capability prepared this metadata. */
  readonly preparedPlanOperation?: QueryOperation;
  /** Required by direct-page-entity-only-compat-v1. */
  readonly compatibilityScope?: "session" | "visitor";
  /** Semantic dependencies whose physical results are bound by the Provider at execution. */
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly eventName?: string;
  /** Event analytics preserves the legacy truthy raw value; record detail trims. */
  readonly eventNameInputSemantics?:
    "trimmed-nonempty" | "legacy-truthy-raw" | "defined-raw-value";
  readonly postObservationFilter?: SemanticPostObservationFilter;
}

/**
 * Request-private memberships replace the legacy ID set under the canonical
 * prepared profile and under the reader-window profiles that keep the
 * prepared time as proof while the report reads a different window.
 */
function isDependencyCapableProfile(
  profile: SemanticScopedSourceProfile,
): boolean {
  return (
    profile === "prepared-scoped-v1" ||
    profile === "prepared-page-reader-window-v1" ||
    profile === "prepared-scoped-reader-window-v1"
  );
}

function fail(reason: string): never {
  throw new Error("invalid_semantic_scoped_source_selection:" + reason);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotSubject(
  subject: SemanticSubjectDomain,
): SemanticSubjectDomain {
  return createSemanticSubjectDomain({
    origin: subject.origin,
    siteIds: subject.siteIds,
    ...(subject.teamId ? { teamId: subject.teamId } : {}),
  });
}

function snapshotTime(time: SemanticTemporalDomains): SemanticTemporalDomains {
  return createSemanticTemporalDomains(time);
}

function snapshotQueryTime(time: QueryTime): SemanticTemporalDomains {
  return semanticTemporalDomainsFromQueryTime(time);
}

function snapshotQualificationDependencyRefs(
  refs: unknown,
): readonly QualificationDependencyRef[] | undefined {
  if (refs === undefined) return undefined;
  if (!Array.isArray(refs)) fail("qualification_dependency_refs_invalid");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(refs, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 1)
    fail("qualification_dependency_refs_invalid");
  const snapshot: QualificationDependencyRef[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(refs, String(index));
    if (!descriptor || !("value" in descriptor))
      fail("qualification_dependency_refs_invalid");
    if (!isQualificationDependencyRef(descriptor.value))
      fail("qualification_dependency_refs_invalid");
    snapshot.push(descriptor.value);
  }
  if (new Set(snapshot).size !== snapshot.length)
    fail("qualification_dependency_refs_invalid");
  return Object.freeze(snapshot);
}

function ownDataProperty(
  value: object,
  property: string,
): { readonly present: boolean; readonly value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (!descriptor) return { present: false, value: undefined };
  if (!("value" in descriptor))
    fail("qualification_dependency_accessor_rejected");
  return { present: true, value: descriptor.value };
}

function isEmptyAndFilter(filters: FilterDocument): boolean {
  return (
    filters.root?.kind === "and" &&
    Array.isArray(filters.root.children) &&
    filters.root.children.length === 0
  );
}

function snapshotSelectionFilter(
  profile: SemanticScopedSourceProfile,
  filters: FilterDocument,
): FilterDocument {
  // Legacy direct Session readers treated an empty conjunction as an
  // unqualified Session selection. Keep that internal compatibility shape
  // without allowing it through general user-facing filter normalization.
  return deepFreeze(
    profile === "direct-page-session-compat-v1" && isEmptyAndFilter(filters)
      ? { ...filters, root: { kind: "and", children: [] } }
      : normalizeFilterDocument(filters, analyticsFilterRegistry),
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function snapshotPostObservationFilter(
  value: SemanticPostObservationFilter,
): SemanticPostObservationFilter {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.semantics !== SEMANTIC_POST_OBSERVATION_FILTER ||
    Object.keys(value).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, "semantics") ||
    !Object.prototype.hasOwnProperty.call(value, "filter")
  )
    return fail("post_observation_filter_descriptor_invalid");
  const filter = normalizeFilterDocument(value.filter, analyticsFilterRegistry);
  assertObservationFilterCompatible(filter);
  return deepFreeze({
    semantics: SEMANTIC_POST_OBSERVATION_FILTER,
    filter,
  });
}

/** Create the finite observation-only stage descriptor shared by readers. */
export function createSemanticPostObservationFilter(input: {
  readonly filter: FilterDocument;
}): SemanticPostObservationFilter {
  return snapshotPostObservationFilter({
    semantics: SEMANTIC_POST_OBSERVATION_FILTER,
    filter: input.filter,
  });
}

/** Revalidate a stage descriptor at the logical-source trust boundary. */
export function validateSemanticPostObservationFilter(
  value: SemanticPostObservationFilter,
): void {
  const snapshot = snapshotPostObservationFilter(value);
  if (!sameJsonValue(snapshot, value))
    fail("post_observation_filter_snapshot_not_normalized");
}

function validatePostObservationProfile(
  selection: Pick<
    SemanticScopedSourceSelection,
    "profile" | "filter" | "eventNameGate" | "postObservationFilter"
  >,
): void {
  if (!Object.prototype.hasOwnProperty.call(selection, "postObservationFilter"))
    return;
  const stage = selection.postObservationFilter;
  if (!stage) return fail("post_observation_filter_descriptor_invalid");
  validateSemanticPostObservationFilter(stage);
  if (
    selection.profile === "direct-page-analytics-v1" ||
    selection.profile === "direct-event-analytics-v1"
  ) {
    if (selection.filter.root !== null || selection.eventNameGate !== undefined)
      fail("direct_post_observation_filter_requires_empty_base");
    return;
  }
  if (selection.profile !== "prepared-scoped-reader-window-v1")
    if (selection.profile !== "direct-page-entity-only-compat-v1")
      fail("post_observation_filter_profile_unsupported");
  if (selection.eventNameGate !== undefined)
    fail(
      selection.profile === "prepared-scoped-reader-window-v1"
        ? "prepared_post_observation_filter_event_name_unsupported"
        : "page_entity_compatibility_event_name_unsupported",
    );
  if (
    selection.profile === "direct-page-entity-only-compat-v1" &&
    selection.filter.root === null
  )
    fail("page_entity_compatibility_requires_filter");
}

function canonicalSiteIds(siteIds: readonly string[]): readonly string[] {
  if (
    !Array.isArray(siteIds) ||
    siteIds.length === 0 ||
    siteIds.some((siteId) => typeof siteId !== "string" || siteId.length === 0)
  )
    return fail("invalid_authorized_sites");
  return Object.freeze([...new Set(siteIds)].sort());
}

function snapshotMembership(
  plan: ScopedFilterPlan,
  authorizedSiteIds: ReadonlySet<string>,
): PreparedMembership | undefined {
  const handle = plan.preparedMembership;
  if (handle === undefined) return undefined;
  const siteIds = preparedMembershipSiteIds(handle);
  if (!siteIds) return fail("invalid_prepared_membership");
  if (siteIds.some((siteId) => !authorizedSiteIds.has(siteId)))
    fail("prepared_identity_outside_authorization");
  if (plan.mode === "entity" && plan.membership.kind !== "entity")
    return fail("entity_matches_without_entity_membership");
  return handle;
}

function sameResolvedPlan(
  actual: ScopedFilterPlan,
  expected: ScopedFilterPlan,
): boolean {
  const actualEntity =
    actual.membership.kind === "entity"
      ? actual.membership.entityKind
      : undefined;
  const expectedEntity =
    expected.membership.kind === "entity"
      ? expected.membership.entityKind
      : undefined;
  return (
    actual.scope === expected.scope &&
    actual.mode === expected.mode &&
    actual.membership.kind === expected.membership.kind &&
    actualEntity === expectedEntity &&
    actual.expansion === expected.expansion
  );
}

function sameResolvedSelection(
  actual: ScopedFilterPlan,
  expected: Pick<
    SemanticScopedSourceSelection,
    "scope" | "mode" | "entityKind"
  >,
): boolean {
  return (
    actual.scope === expected.scope &&
    actual.mode === expected.mode &&
    (actual.membership.kind === "entity") === (expected.mode === "entity") &&
    (actual.membership.kind !== "entity" ||
      actual.membership.entityKind === expected.entityKind)
  );
}

export function createSemanticScopedSourceSelection(
  input: CreateSemanticScopedSourceSelectionInput,
): SemanticScopedSourceSelection {
  const filters = snapshotSelectionFilter(input.profile, input.filters);
  const postObservationFilter = input.postObservationFilter
    ? snapshotPostObservationFilter(input.postObservationFilter)
    : undefined;
  const subject = snapshotSubject(input.subject);
  const time = snapshotTime(input.time);
  const metadata = scopedFilterMetadata(input.filters);
  const dependencyProperty = ownDataProperty(
    input,
    "qualificationDependencyRefs",
  );
  const qualificationDependencyRefs = snapshotQualificationDependencyRefs(
    dependencyProperty.value,
  );
  let scope: FilterScope;
  let mode: "observation" | "entity";
  let entityKind: "session" | "visitor" | undefined;
  let authorizedSiteIds: readonly string[];
  let preparedMembership: PreparedMembership | undefined;
  let preparationTime: SemanticTemporalDomains | undefined;

  if (
    input.profile === "prepared-scoped-v1" ||
    input.profile === "prepared-page-reader-window-v1" ||
    input.profile === "prepared-scoped-reader-window-v1"
  ) {
    if (
      !metadata ||
      !input.expectedPlan ||
      metadata.plan !== input.expectedPlan
    )
      return fail("prepared_plan_identity_mismatch");
    if (metadata.resolvedScope !== metadata.plan.scope)
      return fail("prepared_scope_mismatch");
    const resolvedTime = snapshotQueryTime(metadata.time);
    if (input.profile === "prepared-scoped-v1") {
      if (!sameJsonValue(resolvedTime, time))
        return fail("prepared_time_mismatch");
    } else if (input.profile === "prepared-page-reader-window-v1") {
      if (
        input.eventName !== undefined ||
        input.eventNameInputSemantics !== undefined
      )
        return fail("page_reader_window_event_name_unsupported");
      preparationTime = resolvedTime;
    } else {
      if (
        input.eventName !== undefined ||
        input.eventNameInputSemantics !== undefined
      )
        return fail("prepared_scoped_reader_window_event_name_unsupported");
      preparationTime = resolvedTime;
    }
    authorizedSiteIds = canonicalSiteIds(metadata.siteIds);
    const authorized = new Set(authorizedSiteIds);
    const subjectSites = new Set(subject.siteIds);
    if ([...subjectSites].some((siteId) => !authorized.has(siteId)))
      return fail("subject_outside_prepared_authorization");
    scope = metadata.plan.scope;
    mode = metadata.plan.mode;
    entityKind =
      metadata.plan.membership.kind === "entity"
        ? metadata.plan.membership.entityKind
        : undefined;
    const independentlyResolved = createScopedFilterPlan(
      input.preparedPlanOperation ?? "event-records",
      filters,
      metadata.requestedScope,
    );
    if (
      !independentlyResolved ||
      !sameResolvedPlan(independentlyResolved, input.expectedPlan)
    )
      return fail("prepared_plan_mismatch");
    if (
      filters.root &&
      filterDocumentUsesAdvancedExpressions(filters) &&
      input.expectedPlan.preparedMembership === undefined &&
      qualificationDependencyRefs === undefined
    )
      return fail("prepared_advanced_matches_missing");
    if (
      input.expectedPlan.preparedMembership !== undefined &&
      qualificationDependencyRefs !== undefined
    )
      return fail("prepared_matches_and_qualification_dependency_conflict");
    if (
      qualificationDependencyRefs !== undefined &&
      (!isDependencyCapableProfile(input.profile) ||
        (input.expectedPlan.mode === "entity"
          ? input.expectedPlan.membership.kind !== "entity" ||
            input.expectedPlan.scope === "event"
          : input.expectedPlan.scope !== "event" ||
            input.expectedPlan.mode !== "observation" ||
            input.expectedPlan.membership.kind === "entity") ||
        !qualificationDependencyRefsMatchScope(
          qualificationDependencyRefs,
          input.expectedPlan.mode,
        ) ||
        !filters.root ||
        !filterDocumentUsesAdvancedExpressions(filters))
    )
      return fail("qualification_dependency_semantics_mismatch");
    preparedMembership = snapshotMembership(input.expectedPlan, authorized);
  } else if (
    input.profile === "direct-event-records-v1" ||
    input.profile === "direct-event-analytics-v1"
  ) {
    if (metadata || input.expectedPlan)
      return fail("direct_profile_has_prepared_metadata");
    if (filters.root && filterDocumentUsesAdvancedExpressions(filters))
      return fail("direct_profile_requires_prepared_advanced_matches");
    scope = "event";
    mode = "observation";
    authorizedSiteIds = canonicalSiteIds(subject.siteIds);
  } else if (input.profile === "direct-page-analytics-v1") {
    if (metadata || input.expectedPlan)
      return fail("direct_profile_has_prepared_metadata");
    if (filters.root && filterDocumentUsesAdvancedExpressions(filters))
      return fail("direct_profile_requires_prepared_advanced_matches");
    if (input.eventName !== undefined)
      return fail("page_selection_event_name_unsupported");
    scope = "event";
    mode = "observation";
    authorizedSiteIds = canonicalSiteIds(subject.siteIds);
  } else if (input.profile === "direct-page-session-compat-v1") {
    if (metadata || input.expectedPlan)
      return fail("direct_profile_has_prepared_metadata");
    if (!filters.root) return fail("session_compatibility_requires_filter");
    if (filterDocumentUsesAdvancedExpressions(filters))
      return fail("session_compatibility_requires_prepared_advanced_matches");
    if (
      input.eventName !== undefined ||
      input.eventNameInputSemantics !== undefined
    )
      return fail("session_compatibility_event_name_unsupported");
    if (subject.siteIds.length !== 1)
      return fail("session_compatibility_requires_single_site");
    const compatibilityPlan = createScopedFilterPlan(
      "dimension",
      filters,
      "session",
    );
    if (
      !compatibilityPlan ||
      compatibilityPlan.scope !== "session" ||
      compatibilityPlan.mode !== "entity" ||
      compatibilityPlan.membership.kind !== "entity" ||
      compatibilityPlan.membership.entityKind !== "session"
    )
      return fail("session_compatibility_plan_mismatch");
    scope = compatibilityPlan.scope;
    mode = compatibilityPlan.mode;
    entityKind = compatibilityPlan.membership.entityKind;
    authorizedSiteIds = canonicalSiteIds(subject.siteIds);
  } else if (input.profile === "direct-page-entity-only-compat-v1") {
    if (metadata || input.expectedPlan)
      return fail("compatibility_profile_has_prepared_metadata");
    if (!filters.root) return fail("page_entity_compatibility_requires_filter");
    if (filterDocumentUsesAdvancedExpressions(filters))
      return fail(
        "page_entity_compatibility_requires_prepared_advanced_matches",
      );
    if (
      input.eventName !== undefined ||
      input.eventNameInputSemantics !== undefined
    )
      return fail("page_entity_compatibility_event_name_unsupported");
    if (
      input.compatibilityScope !== "session" &&
      input.compatibilityScope !== "visitor"
    )
      return fail("page_entity_compatibility_scope_required");
    if (subject.siteIds.length !== 1)
      return fail("page_entity_compatibility_requires_single_site");
    const compatibilityPlan = createScopedFilterPlan(
      "goal-summary",
      filters,
      input.compatibilityScope,
    );
    if (
      !compatibilityPlan ||
      compatibilityPlan.scope !== input.compatibilityScope ||
      compatibilityPlan.mode !== "entity" ||
      compatibilityPlan.membership.kind !== "entity" ||
      compatibilityPlan.membership.entityKind !== input.compatibilityScope ||
      factEntityKindsForFilter(filters.root).size !== 0
    )
      return fail("page_entity_compatibility_plan_mismatch");
    scope = compatibilityPlan.scope;
    mode = compatibilityPlan.mode;
    entityKind = compatibilityPlan.membership.entityKind;
    authorizedSiteIds = canonicalSiteIds(subject.siteIds);
  } else {
    return fail("unknown_profile");
  }

  if (
    input.eventNameInputSemantics !== undefined &&
    input.eventNameInputSemantics !== "trimmed-nonempty" &&
    input.eventNameInputSemantics !== "legacy-truthy-raw" &&
    input.eventNameInputSemantics !== "defined-raw-value"
  )
    return fail("invalid_event_name_input_semantics");
  const eventNameSemantics =
    input.eventNameInputSemantics ?? "trimmed-nonempty";
  const normalizedEventName =
    eventNameSemantics === "trimmed-nonempty"
      ? input.eventName?.trim() || undefined
      : input.eventName || undefined;
  const shouldGateDefinedRawValue =
    eventNameSemantics === "defined-raw-value" &&
    input.profile === "prepared-scoped-v1" &&
    input.eventName !== undefined;
  const eventNameGate =
    normalizedEventName || shouldGateDefinedRawValue
      ? {
          value: shouldGateDefinedRawValue
            ? input.eventName!
            : normalizedEventName!,
          semantics:
            input.profile === "prepared-scoped-v1"
              ? shouldGateDefinedRawValue
                ? ("prepared-defined-raw-value-v1" as const)
                : ("prepared-trimmed-label-v1" as const)
              : ("direct-subject-local-exact-name-v1" as const),
        }
      : undefined;

  const selection = deepFreeze({
    version: 1 as const,
    profile: input.profile,
    filter: filters,
    scope,
    mode,
    ...(entityKind ? { entityKind } : {}),
    ...(preparedMembership ? { preparedMembership } : {}),
    ...(qualificationDependencyRefs ? { qualificationDependencyRefs } : {}),
    ...(eventNameGate ? { eventNameGate } : {}),
    ...(postObservationFilter ? { postObservationFilter } : {}),
    subject,
    authorizedSiteIds,
    time,
    ...(preparationTime ? { preparationTime } : {}),
  });
  validatePostObservationProfile(selection);
  return selection;
}

export function validateSemanticScopedSourceSelection(
  selection: SemanticScopedSourceSelection,
  context: {
    readonly subject: SemanticSubjectDomain;
    readonly time: SemanticTemporalDomains;
  },
): void {
  if (
    !selection ||
    typeof selection !== "object" ||
    selection.version !== 1 ||
    ![
      "prepared-scoped-v1",
      "prepared-page-reader-window-v1",
      "prepared-scoped-reader-window-v1",
      "direct-event-records-v1",
      "direct-event-analytics-v1",
      "direct-page-analytics-v1",
      "direct-page-session-compat-v1",
      "direct-page-entity-only-compat-v1",
    ].includes(selection.profile) ||
    !["event", "session", "visitor"].includes(selection.scope) ||
    !["observation", "entity"].includes(selection.mode)
  )
    fail("invalid_descriptor");
  if (Object.prototype.hasOwnProperty.call(selection, "postObservationFilter"))
    validatePostObservationProfile(selection);
  const compatibilityEmptyAnd =
    selection.profile === "direct-page-session-compat-v1" &&
    isEmptyAndFilter(selection.filter);
  const normalized = compatibilityEmptyAnd
    ? selection.filter
    : normalizeFilterDocument(selection.filter, analyticsFilterRegistry);
  if (!sameJsonValue(normalized, selection.filter))
    fail("filter_snapshot_not_normalized");
  if (
    !sameJsonValue(snapshotSubject(selection.subject), context.subject) ||
    !sameJsonValue(snapshotTime(selection.time), context.time)
  )
    fail("logical_context_mismatch");
  const dependencyProperty = ownDataProperty(
    selection,
    "qualificationDependencyRefs",
  );
  const qualificationDependencyRefs = snapshotQualificationDependencyRefs(
    dependencyProperty.value,
  );
  if (
    dependencyProperty.value !== undefined &&
    (!isDependencyCapableProfile(selection.profile) ||
      (selection.mode === "entity"
        ? selection.scope === "event" || selection.entityKind === undefined
        : selection.scope !== "event") ||
      !qualificationDependencyRefsMatchScope(
        selection.qualificationDependencyRefs ?? [],
        selection.mode,
      ) ||
      selection.preparedMembership !== undefined ||
      !selection.filter.root ||
      !filterDocumentUsesAdvancedExpressions(selection.filter) ||
      Object.prototype.hasOwnProperty.call(selection, "postObservationFilter"))
  )
    fail("qualification_dependency_semantics_mismatch");
  const authorized = canonicalSiteIds(selection.authorizedSiteIds);
  if (!sameJsonValue(authorized, selection.authorizedSiteIds))
    fail("authorization_snapshot_not_canonical");
  const authorizedSet = new Set(authorized);
  if (context.subject.siteIds.some((siteId) => !authorizedSet.has(siteId)))
    fail("subject_outside_prepared_authorization");
  if (selection.profile === "prepared-scoped-v1") {
    if (Object.prototype.hasOwnProperty.call(selection, "preparationTime"))
      fail("unexpected_preparation_time");
    const resolved = createScopedFilterPlan(
      "event-records",
      selection.filter,
      selection.scope,
    );
    if (!resolved || !sameResolvedSelection(resolved, selection))
      fail("prepared_plan_mismatch");
    if (
      selection.filter.root &&
      filterDocumentUsesAdvancedExpressions(selection.filter) &&
      selection.preparedMembership === undefined &&
      qualificationDependencyRefs === undefined
    )
      fail("prepared_advanced_matches_missing");
  }
  if (
    selection.profile === "prepared-page-reader-window-v1" ||
    selection.profile === "prepared-scoped-reader-window-v1"
  ) {
    if (!selection.preparationTime) fail("prepared_time_snapshot_missing");
    let normalizedPreparationTime: SemanticTemporalDomains;
    try {
      normalizedPreparationTime = snapshotTime(selection.preparationTime);
    } catch {
      return fail("preparation_time_snapshot_invalid");
    }
    if (!sameJsonValue(normalizedPreparationTime, selection.preparationTime))
      fail("preparation_time_snapshot_invalid");
    const resolved = createScopedFilterPlan(
      "event-records",
      selection.filter,
      selection.scope,
    );
    if (!resolved || !sameResolvedSelection(resolved, selection))
      fail("prepared_plan_mismatch");
    if (
      selection.filter.root &&
      filterDocumentUsesAdvancedExpressions(selection.filter) &&
      selection.preparedMembership === undefined &&
      qualificationDependencyRefs === undefined
    )
      fail("prepared_advanced_matches_missing");
    if (selection.eventNameGate !== undefined)
      fail(
        selection.profile === "prepared-page-reader-window-v1"
          ? "page_reader_window_event_name_unsupported"
          : "prepared_scoped_reader_window_event_name_unsupported",
      );
  } else if (
    Object.prototype.hasOwnProperty.call(selection, "preparationTime")
  ) {
    fail("unexpected_preparation_time");
  }
  if (
    (selection.profile === "direct-event-records-v1" ||
      selection.profile === "direct-event-analytics-v1" ||
      selection.profile === "direct-page-analytics-v1") &&
    (selection.scope !== "event" ||
      selection.mode !== "observation" ||
      selection.entityKind !== undefined ||
      selection.preparedMembership !== undefined ||
      filterDocumentUsesAdvancedExpressions(selection.filter))
  )
    fail("invalid_direct_profile");
  if (selection.profile === "direct-page-session-compat-v1") {
    const compatibilityPlan = createScopedFilterPlan(
      "dimension",
      selection.filter,
      "session",
    );
    if (
      !compatibilityPlan ||
      selection.filter.root === null ||
      selection.scope !== "session" ||
      selection.mode !== "entity" ||
      selection.entityKind !== "session" ||
      selection.preparedMembership !== undefined ||
      selection.eventNameGate !== undefined ||
      selection.subject.siteIds.length !== 1 ||
      !sameJsonValue(selection.authorizedSiteIds, selection.subject.siteIds) ||
      filterDocumentUsesAdvancedExpressions(selection.filter) ||
      !sameResolvedSelection(compatibilityPlan, selection)
    )
      fail("invalid_session_compatibility_profile");
  }
  if (selection.profile === "direct-page-entity-only-compat-v1") {
    const compatibilityPlan = createScopedFilterPlan(
      "goal-summary",
      selection.filter,
      selection.scope,
    );
    if (
      !compatibilityPlan ||
      selection.filter.root === null ||
      (selection.scope !== "session" && selection.scope !== "visitor") ||
      selection.mode !== "entity" ||
      selection.entityKind !== selection.scope ||
      selection.preparedMembership !== undefined ||
      selection.eventNameGate !== undefined ||
      selection.subject.siteIds.length !== 1 ||
      !sameJsonValue(selection.authorizedSiteIds, selection.subject.siteIds) ||
      filterDocumentUsesAdvancedExpressions(selection.filter) ||
      factEntityKindsForFilter(selection.filter.root).size !== 0 ||
      !sameResolvedSelection(compatibilityPlan, selection)
    )
      fail("invalid_page_entity_compatibility_profile");
  }
  if (
    selection.profile === "direct-page-analytics-v1" &&
    selection.eventNameGate !== undefined
  )
    fail("page_selection_event_name_unsupported");
  if (
    (selection.mode === "entity") !==
    (selection.entityKind === "session" || selection.entityKind === "visitor")
  )
    fail("invalid_entity_kind");
  if (selection.eventNameGate) {
    if (typeof selection.eventNameGate.value !== "string")
      fail("invalid_event_name_gate_value");
    if (
      selection.profile === "prepared-scoped-v1" ||
      selection.profile === "prepared-page-reader-window-v1" ||
      selection.profile === "prepared-scoped-reader-window-v1"
        ? selection.eventNameGate.semantics !== "prepared-trimmed-label-v1" &&
          selection.eventNameGate.semantics !== "prepared-defined-raw-value-v1"
        : selection.eventNameGate.semantics !==
          "direct-subject-local-exact-name-v1"
    )
      fail("event_name_profile_mismatch");
  }
  if (selection.preparedMembership !== undefined) {
    const siteIds = preparedMembershipSiteIds(selection.preparedMembership);
    if (!siteIds || siteIds.some((siteId) => !authorizedSet.has(siteId)))
      fail("invalid_prepared_membership_snapshot");
  }
}

export function snapshotSemanticScopedSourceSelection(
  selection: SemanticScopedSourceSelection,
  context: LogicalPlanContext,
): SemanticScopedSourceSelection {
  validateSemanticScopedSourceSelection(selection, context);
  const compatibilityEmptyAnd =
    selection.profile === "direct-page-session-compat-v1" &&
    isEmptyAndFilter(selection.filter);
  return deepFreeze({
    ...selection,
    filter: deepFreeze(
      compatibilityEmptyAnd
        ? selection.filter
        : normalizeFilterDocument(selection.filter, analyticsFilterRegistry),
    ),
    subject: snapshotSubject(selection.subject),
    authorizedSiteIds: canonicalSiteIds(selection.authorizedSiteIds),
    time: snapshotTime(selection.time),
    ...(selection.preparationTime
      ? { preparationTime: snapshotTime(selection.preparationTime) }
      : {}),
    // The handle is opaque and already frozen; copying it would sever its
    // registration, so the selection keeps the very same object.
    ...(selection.preparedMembership
      ? { preparedMembership: selection.preparedMembership }
      : {}),
    ...(selection.eventNameGate
      ? { eventNameGate: Object.freeze({ ...selection.eventNameGate }) }
      : {}),
    ...(selection.postObservationFilter
      ? {
          postObservationFilter: snapshotPostObservationFilter(
            selection.postObservationFilter,
          ),
        }
      : {}),
  });
}
