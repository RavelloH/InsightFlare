import {
  createScopedFilterPlan,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { LogicalPlanContext } from "@/lib/edge/analytics/engine/logical/plan";
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
  | "direct-event-records-v1"
  | "direct-event-analytics-v1"
  | "direct-page-analytics-v1"
  | "direct-page-session-compat-v1";

export type SemanticScopedIdentityKind =
  "page" | "event" | "session" | "visitor";

export interface SemanticScopedIdentity {
  readonly siteId: string;
  readonly kind: SemanticScopedIdentityKind;
  readonly id: string;
}

export interface SemanticPreparedMatches {
  readonly identities: readonly SemanticScopedIdentity[];
}

export interface SemanticEventNameGate {
  readonly value: string;
  readonly semantics:
    | "prepared-trimmed-label-v1"
    | "prepared-defined-raw-value-v1"
    | "direct-subject-local-exact-name-v1";
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
  readonly preparedMatches?: SemanticPreparedMatches;
  readonly eventNameGate?: SemanticEventNameGate;
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
  readonly eventName?: string;
  /** Event analytics preserves the legacy truthy raw value; record detail trims. */
  readonly eventNameInputSemantics?:
    "trimmed-nonempty" | "legacy-truthy-raw" | "defined-raw-value";
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

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function snapshotMatches(
  plan: ScopedFilterPlan,
  authorizedSiteIds: ReadonlySet<string>,
  subjectSiteIds: ReadonlySet<string>,
): SemanticPreparedMatches | undefined {
  if (plan.advancedMatches === undefined) return undefined;
  const identities: SemanticScopedIdentity[] = [];
  const append = (
    kind: SemanticScopedIdentityKind,
    values: readonly { readonly siteId: string; readonly id: string }[] = [],
  ) => {
    for (const item of values) {
      if (
        !item ||
        typeof item.siteId !== "string" ||
        typeof item.id !== "string" ||
        item.siteId.length === 0
      )
        fail("invalid_prepared_identity");
      if (!authorizedSiteIds.has(item.siteId))
        fail("prepared_identity_outside_authorization");
      if (subjectSiteIds.has(item.siteId))
        identities.push({ siteId: item.siteId, kind, id: item.id });
    }
  };
  const matches = plan.advancedMatches;
  if (plan.mode === "observation") {
    append("page", matches.visitIds);
    append("event", matches.eventIds);
  } else {
    if (plan.membership.kind !== "entity")
      return fail("entity_matches_without_entity_membership");
    append(plan.membership.entityKind, matches.entityIds);
  }
  const unique = new Map<string, SemanticScopedIdentity>();
  for (const identity of identities) {
    const key = JSON.stringify([identity.siteId, identity.kind, identity.id]);
    unique.set(key, identity);
  }
  return {
    identities: Object.freeze(
      [...unique.values()].sort(
        (left, right) =>
          left.siteId.localeCompare(right.siteId) ||
          left.kind.localeCompare(right.kind) ||
          left.id.localeCompare(right.id),
      ),
    ),
  };
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
  const filters = deepFreeze(
    normalizeFilterDocument(input.filters, analyticsFilterRegistry),
  );
  const subject = snapshotSubject(input.subject);
  const time = snapshotTime(input.time);
  const metadata = scopedFilterMetadata(input.filters);
  let scope: FilterScope;
  let mode: "observation" | "entity";
  let entityKind: "session" | "visitor" | undefined;
  let authorizedSiteIds: readonly string[];
  let preparedMatches: SemanticPreparedMatches | undefined;
  let preparationTime: SemanticTemporalDomains | undefined;

  if (
    input.profile === "prepared-scoped-v1" ||
    input.profile === "prepared-page-reader-window-v1"
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
    } else {
      if (
        input.eventName !== undefined ||
        input.eventNameInputSemantics !== undefined
      )
        return fail("page_reader_window_event_name_unsupported");
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
      "event-records",
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
      input.expectedPlan.advancedMatches === undefined
    )
      return fail("prepared_advanced_matches_missing");
    preparedMatches = snapshotMatches(
      input.expectedPlan,
      authorized,
      subjectSites,
    );
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

  return deepFreeze({
    version: 1 as const,
    profile: input.profile,
    filter: filters,
    scope,
    mode,
    ...(entityKind ? { entityKind } : {}),
    ...(preparedMatches ? { preparedMatches } : {}),
    ...(eventNameGate ? { eventNameGate } : {}),
    subject,
    authorizedSiteIds,
    time,
    ...(preparationTime ? { preparationTime } : {}),
  });
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
      "direct-event-records-v1",
      "direct-event-analytics-v1",
      "direct-page-analytics-v1",
      "direct-page-session-compat-v1",
    ].includes(selection.profile) ||
    !["event", "session", "visitor"].includes(selection.scope) ||
    !["observation", "entity"].includes(selection.mode)
  )
    fail("invalid_descriptor");
  const normalized = normalizeFilterDocument(
    selection.filter,
    analyticsFilterRegistry,
  );
  if (!sameJsonValue(normalized, selection.filter))
    fail("filter_snapshot_not_normalized");
  if (
    !sameJsonValue(snapshotSubject(selection.subject), context.subject) ||
    !sameJsonValue(snapshotTime(selection.time), context.time)
  )
    fail("logical_context_mismatch");
  const authorized = canonicalSiteIds(selection.authorizedSiteIds);
  if (!sameJsonValue(authorized, selection.authorizedSiteIds))
    fail("authorization_snapshot_not_canonical");
  const authorizedSet = new Set(authorized);
  const subjectSiteIds = new Set<string>(context.subject.siteIds);
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
      selection.preparedMatches === undefined
    )
      fail("prepared_advanced_matches_missing");
  }
  if (selection.profile === "prepared-page-reader-window-v1") {
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
      selection.preparedMatches === undefined
    )
      fail("prepared_advanced_matches_missing");
    if (selection.eventNameGate !== undefined)
      fail("page_reader_window_event_name_unsupported");
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
      selection.preparedMatches !== undefined ||
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
      selection.preparedMatches !== undefined ||
      selection.eventNameGate !== undefined ||
      selection.subject.siteIds.length !== 1 ||
      !sameJsonValue(selection.authorizedSiteIds, selection.subject.siteIds) ||
      filterDocumentUsesAdvancedExpressions(selection.filter) ||
      !sameResolvedSelection(compatibilityPlan, selection)
    )
      fail("invalid_session_compatibility_profile");
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
      selection.profile === "prepared-page-reader-window-v1"
        ? selection.eventNameGate.semantics !== "prepared-trimmed-label-v1" &&
          selection.eventNameGate.semantics !== "prepared-defined-raw-value-v1"
        : selection.eventNameGate.semantics !==
          "direct-subject-local-exact-name-v1"
    )
      fail("event_name_profile_mismatch");
  }
  for (const identity of selection.preparedMatches?.identities ?? []) {
    if (
      !identity ||
      typeof identity.siteId !== "string" ||
      typeof identity.id !== "string" ||
      !["page", "event", "session", "visitor"].includes(identity.kind) ||
      !authorizedSet.has(identity.siteId) ||
      !subjectSiteIds.has(identity.siteId)
    )
      fail("invalid_prepared_identity_snapshot");
    if (
      selection.mode === "observation" &&
      identity.kind !== "page" &&
      identity.kind !== "event"
    )
      fail("invalid_observation_identity_kind");
    if (selection.mode === "entity" && identity.kind !== selection.entityKind)
      fail("invalid_entity_identity_kind");
  }
}

export function snapshotSemanticScopedSourceSelection(
  selection: SemanticScopedSourceSelection,
  context: LogicalPlanContext,
): SemanticScopedSourceSelection {
  validateSemanticScopedSourceSelection(selection, context);
  return deepFreeze({
    ...selection,
    filter: deepFreeze(
      normalizeFilterDocument(selection.filter, analyticsFilterRegistry),
    ),
    subject: snapshotSubject(selection.subject),
    authorizedSiteIds: canonicalSiteIds(selection.authorizedSiteIds),
    time: snapshotTime(selection.time),
    ...(selection.preparationTime
      ? { preparationTime: snapshotTime(selection.preparationTime) }
      : {}),
    ...(selection.preparedMatches
      ? {
          preparedMatches: {
            identities: Object.freeze(
              selection.preparedMatches.identities.map((identity) =>
                Object.freeze({ ...identity }),
              ),
            ),
          },
        }
      : {}),
    ...(selection.eventNameGate
      ? { eventNameGate: Object.freeze({ ...selection.eventNameGate }) }
      : {}),
  });
}
