import { factEntityKindsForFilter } from "@/lib/edge/analytics/contract";
import { planObservationFilter } from "@/lib/edge/analytics/contract/observation-planner";
import { type SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import { type SemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { LEGACY_DIRECT_EVENT_RECORD_VISIT_COLUMNS } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-dataset";
import { analyticsFilterDefinition } from "@/lib/filter-contract/filter-registry";
import { type FilterExpression } from "@/lib/filter-contract/filters";

export const rowLocalDerivedStrategies = new Set([
  "derived.trafficChannel",
  "derived.browserEngine",
  "derived.osVersion",
  "derived.screenSize",
]);

export const PAGE_EVENT_OWNER_PAIR_EQUIVALENCE =
  "direct-page-row-local-event-owner-pairs-v1";

export const ENTITY_QUALIFICATION_EQUIVALENCE =
  "candidate-entity-qualified-identities-v1";

export const legacyDirectEventRecordVisitColumnSet = new Set<string>(
  LEGACY_DIRECT_EVENT_RECORD_VISIT_COLUMNS,
);

export function isRowLocalFilter(expression: FilterExpression | null): boolean {
  if (!expression) return false;
  switch (expression.kind) {
    case "condition": {
      if (expression.target.kind === "event-payload") return true;
      if (expression.target.kind !== "field") return false;
      const definition = analyticsFilterDefinition(expression.target.field);
      if (!definition) return false;
      const strategy = definition.compilerStrategy;
      return (
        strategy.startsWith("column.") ||
        strategy === "event.name" ||
        rowLocalDerivedStrategies.has(strategy)
      );
    }
    case "and":
    case "or":
      return (
        expression.children.length > 0 &&
        expression.children.every(isRowLocalFilter)
      );
    case "not":
      return isRowLocalFilter(expression.child);
  }
}

export function canReuseRowLocalEventMatches(
  selection: SemanticScopedSourceSelection,
): boolean {
  return (
    selection.profile === "direct-event-analytics-v1" &&
    selection.mode === "observation" &&
    selection.scope === "event" &&
    selection.preparedMembership === undefined &&
    selection.subject.siteIds.length === 1 &&
    selection.filter.root !== null &&
    isRowLocalFilter(selection.filter.root) &&
    (!selection.eventNameGate ||
      selection.eventNameGate.semantics ===
        "direct-subject-local-exact-name-v1")
  );
}

/** Returns a cache key only for the proven direct Page owner-pair equivalence class. */
export function pageEventOwnerPairCacheKey(
  selection: SemanticScopedSourceSelection,
): string | null {
  const compatibleProfile =
    (selection.profile === "direct-page-analytics-v1" &&
      selection.scope === "event" &&
      selection.mode === "observation") ||
    (selection.profile === "direct-page-session-compat-v1" &&
      selection.scope === "session" &&
      selection.mode === "entity" &&
      selection.entityKind === "session");
  const root = selection.filter.root;
  if (
    !compatibleProfile ||
    selection.preparedMembership !== undefined ||
    selection.eventNameGate !== undefined ||
    !root ||
    selection.subject.siteIds.length !== 1 ||
    selection.authorizedSiteIds.length !== 1 ||
    selection.authorizedSiteIds[0] !== selection.subject.siteIds[0] ||
    factEntityKindsForFilter(root).size !== 0 ||
    !isRowLocalFilter(root) ||
    planObservationFilter(root).event.kind === "all"
  )
    return null;
  return JSON.stringify({
    equivalence: PAGE_EVENT_OWNER_PAIR_EQUIVALENCE,
    filter: selection.filter,
    subject: selection.subject,
    time: selection.time,
    authorizedSiteIds: selection.authorizedSiteIds,
  });
}

/** Key an instance-local cache only for an exact candidate entity selection. */
export function entityQualificationCacheKey(
  selection: SemanticScopedSourceSelection,
  temporalDomain: SourceNode["temporalDomain"],
): string | null {
  if (
    temporalDomain !== "candidate" ||
    selection.mode !== "entity" ||
    !selection.entityKind ||
    selection.postObservationFilter !== undefined ||
    selection.eventNameGate !== undefined ||
    selection.profile === "direct-page-entity-only-compat-v1"
  )
    return null;
  return JSON.stringify({
    equivalence: ENTITY_QUALIFICATION_EQUIVALENCE,
    temporalDomain,
    selection,
  });
}

export function withoutEventNameGate(
  selection: SemanticScopedSourceSelection,
): SemanticScopedSourceSelection {
  if (!selection.eventNameGate) return selection;
  const { eventNameGate: _eventNameGate, ...baseSelection } = selection;
  return baseSelection;
}

/** Match SQLite's text binding replacement for isolated UTF-16 surrogates. */
export function sqliteBoundText(value: string): string {
  let result: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        if (result !== undefined) result += value.slice(index, index + 2);
        index += 1;
        continue;
      }
      result ??= value.slice(0, index);
      result += "\ufffd";
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      result ??= value.slice(0, index);
      result += "\ufffd";
      continue;
    }
    if (result !== undefined) result += value[index];
  }
  return result ?? value;
}

export function selectionWithoutPostObservationFilter(
  selection: SemanticScopedSourceSelection,
): SemanticScopedSourceSelection {
  const { postObservationFilter: _postObservationFilter, ...baseSelection } =
    selection;
  return baseSelection;
}

export function selectionForPostObservationFilter(
  selection: SemanticScopedSourceSelection,
): SemanticScopedSourceSelection {
  const stage = selection.postObservationFilter;
  if (!stage) throw new Error("legacy_post_observation_filter_missing");
  const {
    preparedMembership: _preparedMembership,
    qualificationDependencyRefs: _qualificationDependencyRefs,
    eventNameGate: _eventNameGate,
    postObservationFilter: _postObservationFilter,
    ...baseSelection
  } = selection;
  return { ...baseSelection, filter: stage.filter };
}

export function postObservationBaseSelectionKey(
  selection: SemanticScopedSourceSelection,
): string {
  const baseSelection = selectionWithoutPostObservationFilter(selection);
  // These two direct profiles have identical unfiltered single-site Page and
  // Event domains. This exception never applies to prepared or filtered data.
  const profile =
    baseSelection.filter.root === null &&
    baseSelection.scope === "event" &&
    baseSelection.mode === "observation" &&
    baseSelection.subject.origin === "site" &&
    baseSelection.subject.siteIds.length === 1 &&
    baseSelection.authorizedSiteIds.length === 1 &&
    baseSelection.authorizedSiteIds[0] === baseSelection.subject.siteIds[0] &&
    !baseSelection.preparedMembership &&
    !baseSelection.eventNameGate &&
    (baseSelection.profile === "direct-page-analytics-v1" ||
      baseSelection.profile === "direct-event-analytics-v1")
      ? "direct-empty-analytics-base-domain-v1"
      : baseSelection.profile;
  return JSON.stringify({ ...baseSelection, profile });
}
