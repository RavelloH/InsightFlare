import {
  and,
  antiJoin,
  coalesce,
  constant,
  distinct,
  eq,
  filter,
  isNotNull,
  join,
  or,
  param,
  type Predicate,
  project,
  trimSpaces,
  union,
} from "@/lib/db";
import {
  type AnyExpression,
  type ExpressionResultType,
  type SqlExpression,
} from "@/lib/db/query/expression";
import { factEntityKindsForFilter } from "@/lib/edge/analytics/contract";
import { planObservationFilter } from "@/lib/edge/analytics/contract/observation-planner";
import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import {
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { type SemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { lowerLegacyRelationalPredicate } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-relational-predicates";
import {
  type LegacyScalarFilterContext,
  LegacyScalarFilterLoweringError,
  legacyTextVectorConditionGroupKey,
  lowerLegacyScalarFilterDocument,
  lowerLegacyScalarValueCondition,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scalar-filter-lowering";
import { buildLegacyScopeFactRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scope-facts";
import {
  type AnalyticsLegacyScopedDataset,
  buildLegacyScopedDataset,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-dataset";
import {
  type AnalyticsLegacyEventColumnName,
  type AnalyticsLegacyEventRow,
  type AnalyticsLegacyFactRelation,
  type AnalyticsLegacyFilterField,
  type AnalyticsLegacyPageRow,
  type AnalyticsLegacyScopedPredicateContext,
  type AnalyticsLegacyText,
  type AnalyticsLegacyVisitColumnName,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-types";
import { type AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import { resolvePreparedMembership } from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import { analyticsFilterDefinition } from "@/lib/filter-contract/filter-registry";
import {
  type FilterCondition,
  type FilterExpression,
} from "@/lib/filter-contract/filters";

import type { AnalyticsScopedSourceContext } from "./context";
import {
  emptyIdentities,
  entityColumnName,
  entityId,
  type EntityKind,
  eventIdentityRows,
  type IdentityRelation,
  joinMembership,
  matchingIdentity,
  nonBlank,
  relationColumn,
} from "./primitives";
import {
  canReuseRowLocalEventMatches,
  entityQualificationCacheKey,
  legacyDirectEventRecordVisitColumnSet,
  pageEventOwnerPairCacheKey,
  withoutEventNameGate,
} from "./selection-compatibility";

export function entityRowsFromPage(
  pages: AnalyticsLegacyPageRow,
  kind: EntityKind,
): IdentityRelation {
  const matchingPages = filter(pages.relation, nonBlank(entityId(pages, kind)));
  return distinct(
    project(matchingPages, {
      site_pk: matchingPages.columns.site_pk!,
      entity_id: matchingPages.columns[entityColumnName(pages, kind)]!,
    }),
  );
}

export function entityRowsFromEvent(
  events: AnalyticsLegacyEventRow,
  kind: EntityKind,
): IdentityRelation {
  const matchingEvents = filter(
    events.relation,
    nonBlank(entityId(events, kind)),
  );
  return distinct(
    project(matchingEvents, {
      site_pk: matchingEvents.columns.site_pk!,
      entity_id: matchingEvents.columns[entityColumnName(events, kind)]!,
    }),
  );
}

export function entityUniverse(
  dataset: AnalyticsLegacyScopedDataset,
  kind: EntityKind,
): IdentityRelation {
  return distinct(
    union(
      entityRowsFromPage(dataset.readPages, kind),
      entityRowsFromEvent(dataset.readEvents, kind),
    ),
  );
}

export function scalarContext(
  selection: SemanticScopedSourceSelection,
  row: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow,
  relationalContext: AnalyticsLegacyScopedPredicateContext,
): LegacyScalarFilterContext {
  const visitColumns: Record<string, AnyExpression> = {};
  for (const [name, expression] of Object.entries(
    "eventPk" in row ? row.ownerVisitColumns : row.visitColumns,
  )) {
    if (!expression) continue;
    if (
      selection.profile === "direct-event-records-v1" &&
      !legacyDirectEventRecordVisitColumnSet.has(name)
    )
      continue;
    visitColumns[name] = expression;
  }
  return {
    visitColumns,
    assertFieldAvailable: (field, location) => {
      if (
        selection.profile === "direct-event-records-v1" &&
        (field.id === "client.screenWidth" ||
          field.id === "client.screenHeight")
      )
        throw new LegacyScalarFilterLoweringError(
          "missing_dependency",
          location,
          `The visit column ${field.compilerStrategy.slice("column.".length)} was not supplied by the current scope.`,
        );
    },
    ...("eventPk" in row ? { eventName: row.eventName } : {}),
    resolveTypedCondition: (condition, location) => {
      if (condition.target.kind === "event-payload") {
        if (!("eventPk" in row))
          throw new TypeError(
            "Event-payload predicates require an Event source.",
          );
        return lowerLegacyRelationalPredicate({
          condition,
          context: relationalContext,
          source: row,
        });
      }
      if (condition.target.kind !== "field")
        throw new TypeError(
          "The Filter condition requires prepared Advanced matches.",
        );
      const definition = analyticsFilterDefinition(condition.target.field);
      if (!definition)
        throw new TypeError(
          `Unknown legacy Filter field ${condition.target.field}.`,
        );
      if (
        selection.profile === "direct-event-records-v1" &&
        (definition.compilerStrategy === "session.boundary.entry" ||
          definition.compilerStrategy === "session.boundary.exit")
      )
        throw new LegacyScalarFilterLoweringError(
          "missing_dependency",
          `${location}.target.field`,
          `The legacy direct Event source did not project ${condition.target.field}.`,
        );
      if (
        definition.compilerStrategy === "session.boundary.entry" ||
        definition.compilerStrategy === "session.boundary.exit"
      )
        return lowerLegacyRelationalPredicate({
          condition,
          context: relationalContext,
          source: row,
        });
      return undefined;
    },
  };
}

export function filterExpression(
  row: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow,
  expression: FilterExpression,
  input: {
    readonly selection: SemanticScopedSourceSelection;
    readonly context: AnalyticsLegacyScopedPredicateContext;
  },
): AnalyticsDbRelation {
  const predicate = filterPredicate(row, expression, input);
  if (!predicate) return row.relation;
  return filter(row.relation, predicate);
}

export function filterPredicate(
  row: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow,
  expression: FilterExpression,
  input: {
    readonly selection: SemanticScopedSourceSelection;
    readonly context: AnalyticsLegacyScopedPredicateContext;
  },
): Predicate | undefined {
  return lowerLegacyScalarFilterDocument(
    { version: 1, root: expression },
    scalarContext(input.selection, row, input.context),
  );
}

export function selectedPageOrEventEntities(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  expression: FilterExpression,
  kind: EntityKind,
): IdentityRelation {
  const context: AnalyticsLegacyScopedPredicateContext = {
    selection,
    storage: dataset.storage,
    readPages: dataset.readPages,
    candidatePages: dataset.candidatePages,
    readEvents: dataset.readEvents,
  };
  const vectorGroupDefinition =
    expression.kind === "or" && expression.children.length > 1
      ? (() => {
          const first = expression.children[0]!;
          const key = legacyTextVectorConditionGroupKey(first);
          if (
            !key ||
            expression.children.some(
              (child) => legacyTextVectorConditionGroupKey(child) !== key,
            ) ||
            first.kind !== "condition" ||
            first.target.kind !== "field"
          )
            return undefined;
          return analyticsFilterDefinition(first.target.field);
        })()
      : undefined;
  const definition =
    expression.kind === "condition" && expression.target.kind === "field"
      ? analyticsFilterDefinition(expression.target.field)
      : vectorGroupDefinition;
  const boundary =
    definition?.compilerStrategy === "session.boundary.entry" ||
    definition?.compilerStrategy === "session.boundary.exit";
  const payload =
    expression.kind === "condition" &&
    expression.target.kind === "event-payload";
  const pageApplicable =
    boundary ||
    (definition?.observationKinds.has("visit") ?? false) ||
    (definition === undefined && expression.kind !== "condition");
  const eventApplicable =
    payload ||
    boundary ||
    (definition?.observationKinds.has("event") ?? false) ||
    (definition === undefined && expression.kind !== "condition");
  const parts: IdentityRelation[] = [];
  if (pageApplicable) {
    const matchedPages = filterExpression(dataset.readPages, expression, {
      selection,
      context,
    });
    const nonBlankPages = filter(
      matchedPages,
      nonBlank(
        matchedPages.columns[entityColumnName(dataset.readPages, kind)]!,
      ),
    );
    parts.push(
      distinct(
        project(nonBlankPages, {
          site_pk: nonBlankPages.columns.site_pk!,
          entity_id:
            nonBlankPages.columns[entityColumnName(dataset.readPages, kind)]!,
        }),
      ),
    );
  }
  if (eventApplicable) {
    const matchedEvents = filterExpression(dataset.readEvents, expression, {
      selection,
      context,
    });
    const eventIdValue =
      matchedEvents.columns[entityColumnName(dataset.readEvents, kind)]!;
    const nonBlankEvents = filter(matchedEvents, nonBlank(eventIdValue));
    parts.push(
      distinct(
        project(nonBlankEvents, {
          site_pk: nonBlankEvents.columns.site_pk!,
          entity_id:
            nonBlankEvents.columns[entityColumnName(dataset.readEvents, kind)]!,
        }),
      ),
    );
  }
  if (parts.length === 0) return emptyIdentities(entityUniverse(dataset, kind));
  return distinct(
    parts.slice(1).reduce((left, right) => union(left, right), parts[0]!),
  );
}

export function bridgeFactMatches(
  fact: AnalyticsLegacyFactRelation,
  nativeKind: EntityKind,
  targetKind: EntityKind,
  dataset: AnalyticsLegacyScopedDataset,
): IdentityRelation {
  if (nativeKind === targetKind)
    return distinct(
      project(fact.relation, {
        site_pk: fact.sitePk,
        entity_id: fact.entityId,
      }),
    );
  const parts: IdentityRelation[] = [];
  for (const row of [dataset.readPages, dataset.readEvents] as const) {
    const nativeId = entityId(row, nativeKind);
    const targetId = entityId(row, targetKind);
    const valid = filter(
      row.relation,
      and(nonBlank(nativeId), nonBlank(targetId)),
    );
    const validNativeId = valid.columns[entityColumnName(row, nativeKind)]!;
    const matched = joinMembership(
      valid,
      fact.relation,
      and(
        eq(
          valid.columns.site_pk! as AnyExpression,
          fact.sitePk as AnyExpression,
        ),
        eq(validNativeId as AnyExpression, fact.entityId as AnyExpression),
      ),
    );
    parts.push(
      distinct(
        project(matched, {
          site_pk: matched.columns.site_pk!,
          entity_id: matched.columns[entityColumnName(row, targetKind)]!,
        }),
      ),
    );
  }
  return distinct(union(parts[0]!, parts[1]!));
}

export function entityConditionMatches(
  condition: FilterCondition,
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  targetKind: EntityKind,
): IdentityRelation {
  if (condition.target.kind === "field") {
    const field = analyticsFilterDefinition(condition.target.field);
    if (!field)
      throw new TypeError(
        `Unknown legacy Filter field ${condition.target.field}.`,
      );
    if (field.compilerStrategy.startsWith("fact.")) {
      const nativeKind = field.nativeEntity;
      if (nativeKind !== "session" && nativeKind !== "visitor")
        throw new TypeError(`Invalid entity fact field ${field.id}.`);
      const context: AnalyticsLegacyScopedPredicateContext = {
        selection,
        storage: dataset.storage,
        readPages: dataset.readPages,
        candidatePages: dataset.candidatePages,
        readEvents: dataset.readEvents,
      };
      const facts = buildLegacyScopeFactRelation({
        context,
        entityKind: nativeKind,
        requiredFacts: [field.compilerStrategy],
      });
      const predicate = lowerLegacyScalarValueCondition(
        condition,
        facts.values[field.compilerStrategy]!,
        "entity-fact-v1",
      );
      const matchingFacts = filter(facts.relation, predicate);
      const matching: AnalyticsLegacyFactRelation = {
        relation: matchingFacts,
        sitePk: matchingFacts.columns
          .site_pk as AnalyticsLegacyFactRelation["sitePk"],
        rawSiteId: matchingFacts.columns
          .raw_site_id as AnalyticsLegacyFactRelation["rawSiteId"],
        entityId: matchingFacts.columns
          .entity_id as AnalyticsLegacyFactRelation["entityId"],
        values: facts.values,
      };
      return bridgeFactMatches(matching, nativeKind, targetKind, dataset);
    }
  }
  return selectedPageOrEventEntities(dataset, selection, condition, targetKind);
}

export function lowerEntityExpression(
  expression: FilterExpression,
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  kind: EntityKind,
  universe: IdentityRelation,
): IdentityRelation {
  if (expression.kind === "condition")
    return entityConditionMatches(expression, dataset, selection, kind);
  if (expression.kind === "not") {
    const excluded = lowerEntityExpression(
      expression.child,
      dataset,
      selection,
      kind,
      universe,
    );
    return distinct(
      antiJoin(universe, excluded, matchingIdentity(universe, excluded)),
    );
  }
  if (expression.kind === "or") {
    const groups = new Map<string, number[]>();
    for (const [index, child] of expression.children.entries()) {
      const key = legacyTextVectorConditionGroupKey(child);
      if (!key) continue;
      const indexes = groups.get(key) ?? [];
      indexes.push(index);
      groups.set(key, indexes);
    }
    const consumed = new Set<string>();
    const children: IdentityRelation[] = [];
    for (const child of expression.children) {
      const key = legacyTextVectorConditionGroupKey(child);
      const indexes = key ? groups.get(key) : undefined;
      if (key && indexes && indexes.length > 1) {
        if (consumed.has(key)) continue;
        consumed.add(key);
        children.push(
          selectedPageOrEventEntities(
            dataset,
            selection,
            {
              kind: "or",
              children: indexes.map(
                (groupIndex) => expression.children[groupIndex]!,
              ),
            },
            kind,
          ),
        );
        continue;
      }
      children.push(
        lowerEntityExpression(child, dataset, selection, kind, universe),
      );
    }
    return distinct(
      children
        .slice(1)
        .reduce((left, right) => union(left, right), children[0]!),
    );
  }
  const children = expression.children.map((child) =>
    lowerEntityExpression(child, dataset, selection, kind, universe),
  );
  let result = children[0]!;
  for (const next of children.slice(1))
    result = distinct(
      joinMembership(result, next, matchingIdentity(result, next)),
    );
  return result;
}

export function applyNameGate(
  rows: AnalyticsLegacyEventRow,
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
): AnalyticsLegacyEventRow {
  const gate = selection.eventNameGate;
  if (!gate) return rows;
  if (
    gate.semantics === "prepared-trimmed-label-v1" ||
    gate.semantics === "prepared-defined-raw-value-v1"
  ) {
    const relation = filter(
      rows.relation,
      eq(trimSpaces(coalesce(rows.eventName, constant(""))), param(gate.value)),
    );
    return { ...rows, relation };
  }
  const localNames = filter(
    dataset.subjectEventNames,
    eq(
      dataset.subjectEventNames.columns.name! as SqlExpression<
        string,
        ExpressionResultType<"text", false>
      >,
      param(gate.value),
    ),
  );
  const localIds = distinct(
    project(localNames, { id: localNames.columns.id! }),
  );
  const relation = joinMembership(
    rows.relation,
    localIds,
    eq(rows.nameId, localIds.columns.id!),
  );
  return { ...rows, relation };
}

type QualifiedRole = "event" | "visit" | "entity";

const ROLE_COLUMN: Readonly<Record<QualifiedRole, string>> = {
  event: "event_id",
  visit: "visit_id",
  entity: "entity_id",
};

const ROLE_DEPENDENCY: Readonly<Record<QualifiedRole, string>> = {
  event: EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  visit: EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
  entity: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
};

/**
 * The qualified identities of one role for a Source, keyed (site_pk, <id>).
 * They come from the request-private prepared membership the provider
 * registered, or from the relation an owner bound to the frozen plan; both
 * are physical (site_id, <id>) relations joined to this dataset's site keys.
 * Undefined when the Source carries neither.
 */
function qualifiedRelation(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  role: QualifiedRole,
  qualificationRelations: ReadonlyMap<string, AnalyticsDbRelation> | undefined,
): IdentityRelation | undefined {
  let relation: AnalyticsDbRelation | undefined;
  if (selection.preparedMembership) {
    const registered = resolvePreparedMembership(selection.preparedMembership);
    if (!registered) throw new Error("prepared_membership_unregistered");
    relation = registered[role];
    if (!relation) throw new Error("prepared_membership_role_missing");
  } else if (selection.qualificationDependencyRefs) {
    const refs = selection.qualificationDependencyRefs;
    if (refs.length !== 1)
      throw new Error(
        "qualification_execution_dependency_cardinality_mismatch",
      );
    if (refs[0] !== ROLE_DEPENDENCY[role])
      throw new Error("qualification_execution_dependency_unexpected");
    relation = qualificationRelations?.get(refs[0]);
    if (!relation)
      throw new Error("qualification_execution_dependency_unbound");
  } else {
    return undefined;
  }
  const column = ROLE_COLUMN[role];
  if (!relation.columns.site_id || !relation.columns[column])
    throw new Error("qualification_execution_relation_schema_mismatch");
  const scoped = join(
    relation,
    dataset.sites,
    eq(relation.columns.site_id, dataset.sites.columns.site_id),
  );
  return distinct(
    project(scoped, {
      site_pk: scoped.columns.right_site_pk!,
      [column]: scoped.columns[`left_${column}`]!,
    }),
  );
}

export function observationEventMatches(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  qualificationRelations?: ReadonlyMap<string, AnalyticsDbRelation>,
): IdentityRelation {
  const context: AnalyticsLegacyScopedPredicateContext = {
    selection,
    storage: dataset.storage,
    readPages: dataset.readPages,
    candidatePages: dataset.candidatePages,
    readEvents: dataset.readEvents,
  };
  let matched: IdentityRelation;
  const qualifiedEvents = qualifiedRelation(
    dataset,
    selection,
    "event",
    qualificationRelations,
  );
  if (qualifiedEvents) {
    const gatedIds = eventIdentityRows(
      applyNameGate(dataset.readEvents, dataset, selection),
    );
    return joinMembership(
      gatedIds,
      qualifiedEvents,
      and(
        eq(gatedIds.columns.site_pk!, qualifiedEvents.columns.site_pk!),
        eq(gatedIds.columns.event_id!, qualifiedEvents.columns.event_id!),
      ),
    );
  } else {
    const plan = planObservationFilter(selection.filter.root).event;
    if (plan.kind === "all") matched = eventIdentityRows(dataset.readEvents);
    else if (plan.kind === "none") {
      const eventRows = eventIdentityRows(dataset.readEvents);
      matched = filter(eventRows, eq(constant(1), constant(0)));
    } else {
      const selectedRows = filterExpression(
        dataset.readEvents,
        plan.expression,
        {
          selection,
          context,
        },
      );
      const selected = project(selectedRows, {
        site_pk: selectedRows.columns.site_pk!,
        event_id: selectedRows.columns.event_id!,
      });
      matched = distinct(selected);
    }
  }
  if (
    !selection.eventNameGate ||
    (selection.eventNameGate.semantics ===
      "direct-subject-local-exact-name-v1" &&
      (selection.profile === "direct-event-records-v1" ||
        selection.profile === "direct-event-analytics-v1") &&
      selection.subject.siteIds.length === 1)
  )
    return matched;

  const gated = applyNameGate(dataset.readEvents, dataset, selection);
  const gatedIds = eventIdentityRows(gated);
  const identityRelation = matched;
  return joinMembership(
    identityRelation,
    gatedIds,
    and(
      eq(identityRelation.columns.site_pk!, gatedIds.columns.site_pk!),
      eq(identityRelation.columns.event_id!, gatedIds.columns.event_id!),
    ),
  );
}

export function entityEventMatches(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  qualifiedEntities?: IdentityRelation,
  qualificationRelations?: ReadonlyMap<string, AnalyticsDbRelation>,
): IdentityRelation {
  const kind = selection.entityKind;
  if (!kind) throw new TypeError("Scoped entity mode requires an entity kind.");
  const hasPreparedEntities =
    selection.preparedMembership !== undefined ||
    selection.qualificationDependencyRefs !== undefined;
  const explicit =
    hasPreparedEntities && !qualifiedEntities
      ? qualifiedRelation(dataset, selection, "entity", qualificationRelations)
      : undefined;
  if (explicit) {
    const gatedEvents = applyNameGate(dataset.readEvents, dataset, selection);
    const entityColumn = entityColumnName(dataset.readEvents, kind);
    const eligibleEvents = filter(
      gatedEvents.relation,
      nonBlank(
        gatedEvents.relation.columns[entityColumn]! as AnalyticsLegacyText,
      ),
    );
    const eventEntityId = eligibleEvents.columns[
      entityColumn
    ] as AnalyticsLegacyText;
    const matches = joinMembership(
      eligibleEvents,
      explicit,
      and(
        eq(eligibleEvents.columns.site_pk!, explicit.columns.site_pk!),
        eq(eventEntityId, explicit.columns.entity_id!),
      ),
    );
    return eventIdentityRows({ ...gatedEvents, relation: matches });
  }

  const universe =
    qualifiedEntities === undefined ? entityUniverse(dataset, kind) : undefined;
  const selected =
    qualifiedEntities ??
    (selection.filter.root
      ? lowerEntityExpression(
          selection.filter.root,
          dataset,
          selection,
          kind,
          universe!,
        )
      : universe!);
  const events = dataset.readEvents;
  const eventRows =
    hasPreparedEntities && qualifiedEntities
      ? {
          ...events,
          relation: filter(events.relation, nonBlank(entityId(events, kind))),
        }
      : events;
  const matchingEventRows = joinMembership(
    eventRows.relation,
    selected,
    and(
      eq(eventRows.relation.columns.site_pk!, selected.columns.site_pk!),
      eq(
        eventRows.relation.columns[entityColumnName(events, kind)]!,
        selected.columns.entity_id!,
      ),
    ),
  );
  const gated = applyNameGate(events, dataset, selection);
  const gatedIds = eventIdentityRows(gated);
  const selectedEventIds = distinct(
    project(matchingEventRows, {
      site_pk: matchingEventRows.columns.site_pk!,
      event_id: matchingEventRows.columns.event_id!,
    }),
  );
  return joinMembership(
    selectedEventIds,
    gatedIds,
    and(
      eq(selectedEventIds.columns.site_pk!, gatedIds.columns.site_pk!),
      eq(selectedEventIds.columns.event_id!, gatedIds.columns.event_id!),
    ),
  );
}

export function pagePairIdentityRows(
  pages: AnalyticsLegacyPageRow,
): IdentityRelation {
  return distinct(
    project(pages.relation, {
      site_pk: pages.relation.columns.site_pk!,
      visit_id: pages.relation.columns.visit_id!,
    }),
  );
}

export function eventOwnerPairIdentityRows(
  events: AnalyticsLegacyEventRow,
): IdentityRelation {
  return distinct(
    project(events.relation, {
      site_pk: events.relation.columns.site_pk!,
      visit_id: events.relation.columns.visit_id!,
    }),
  );
}

export function eventOwnerPairsForObservationFilter(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  expression: FilterExpression | null,
  universe = eventOwnerPairIdentityRows(dataset.readEvents),
): IdentityRelation {
  const plan = planObservationFilter(expression).event;
  if (plan.kind === "all") return universe;
  if (plan.kind === "none") return emptyIdentities(universe);
  const context: AnalyticsLegacyScopedPredicateContext = {
    selection,
    storage: dataset.storage,
    readPages: dataset.readPages,
    candidatePages: dataset.candidatePages,
    readEvents: dataset.readEvents,
  };
  const matching = filterExpression(dataset.readEvents, plan.expression, {
    selection,
    context,
  });
  return distinct(
    project(matching, {
      site_pk: matching.columns.site_pk!,
      visit_id: matching.columns.visit_id!,
    }),
  );
}

export function observationPagePairMatches(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  qualificationRelations?: ReadonlyMap<string, AnalyticsDbRelation>,
): IdentityRelation {
  const qualifiedVisits = qualifiedRelation(
    dataset,
    selection,
    "visit",
    qualificationRelations,
  );
  if (qualifiedVisits) return qualifiedVisits;
  const observation = planObservationFilter(selection.filter.root);
  const pageUniverse = pagePairIdentityRows(dataset.readPages);
  if (observation.visit.kind === "all" && observation.event.kind === "all")
    return pageUniverse;
  const context: AnalyticsLegacyScopedPredicateContext = {
    selection,
    storage: dataset.storage,
    readPages: dataset.readPages,
    candidatePages: dataset.candidatePages,
    readEvents: dataset.readEvents,
  };
  const pagePlan = observation.visit;
  const pageMatches =
    pagePlan.kind === "all"
      ? pageUniverse
      : pagePlan.kind === "none"
        ? emptyIdentities(pageUniverse)
        : (() => {
            const matching = filterExpression(
              dataset.readPages,
              pagePlan.expression,
              { selection, context },
            );
            return distinct(
              project(matching, {
                site_pk: matching.columns.site_pk!,
                visit_id: matching.columns.visit_id!,
              }),
            );
          })();
  const eventPlan = observation.event;
  const eventMatches =
    eventPlan.kind === "none"
      ? emptyIdentities(pageUniverse)
      : eventOwnerPairsForObservationFilter(
          dataset,
          selection,
          selection.filter.root,
        );
  return distinct(union(pageMatches, eventMatches));
}

export function entityPageRows(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  qualifiedEntities?: IdentityRelation,
  qualificationRelations?: ReadonlyMap<string, AnalyticsDbRelation>,
): AnalyticsDbRelation {
  const kind = selection.entityKind;
  if (!kind) throw new TypeError("Scoped entity mode requires an entity kind.");
  const universe =
    qualifiedEntities === undefined ? entityUniverse(dataset, kind) : undefined;
  const selected =
    qualifiedEntities ??
    qualifiedRelation(dataset, selection, "entity", qualificationRelations) ??
    (selection.filter.root
      ? lowerEntityExpression(
          selection.filter.root,
          dataset,
          selection,
          kind,
          universe!,
        )
      : universe!);
  const pageValue = entityId(dataset.candidatePages, kind);
  const nonblankPages = filter(
    dataset.candidatePages.relation,
    nonBlank(pageValue),
  );
  return joinMembership(
    nonblankPages,
    selected,
    and(
      eq(nonblankPages.columns.site_pk!, selected.columns.site_pk!),
      eq(
        nonblankPages.columns[entityColumnName(dataset.candidatePages, kind)]!,
        selected.columns.entity_id!,
      ),
    ),
  );
}

export function pageRowsForVisitIds(
  pages: AnalyticsLegacyPageRow,
  visitIds: IdentityRelation,
): AnalyticsDbRelation {
  return joinMembership(
    pages.relation,
    visitIds,
    and(
      eq(pages.relation.columns.site_pk!, visitIds.columns.site_pk!),
      eq(pages.relation.columns.visit_id!, visitIds.columns.visit_id!),
    ),
  );
}

export function pageRowWithRelation(
  pages: AnalyticsLegacyPageRow,
  relation: AnalyticsDbRelation,
): AnalyticsLegacyPageRow {
  const visitColumns = Object.fromEntries(
    Object.keys(pages.visitColumns).map((name) => [
      name,
      relationColumn(relation, `visit_${name}`),
    ]),
  ) as AnalyticsLegacyPageRow["visitColumns"];
  const filterValues: Partial<
    Record<AnalyticsLegacyFilterField, AnyExpression>
  > = {};
  for (const fieldId of Object.keys(pages.filterValues)) {
    const definition = analyticsFilterDefinition(
      fieldId as AnalyticsLegacyFilterField,
    );
    const strategy = definition?.compilerStrategy;
    if (!strategy?.startsWith("column.")) continue;
    const expression =
      visitColumns[
        strategy.slice("column.".length) as keyof typeof visitColumns
      ];
    if (expression)
      filterValues[fieldId as AnalyticsLegacyFilterField] = expression;
  }
  return {
    ...pages,
    relation,
    sitePk: relationColumn(
      relation,
      "site_pk",
    ) as AnalyticsLegacyPageRow["sitePk"],
    rawSiteId: relationColumn(
      relation,
      "raw_site_id",
    ) as AnalyticsLegacyPageRow["rawSiteId"],
    visitId: relationColumn(
      relation,
      "visit_id",
    ) as AnalyticsLegacyPageRow["visitId"],
    sessionId: relationColumn(
      relation,
      "visit_session_id",
    ) as AnalyticsLegacyPageRow["sessionId"],
    visitorId: relationColumn(
      relation,
      "visit_visitor_id",
    ) as AnalyticsLegacyPageRow["visitorId"],
    startedAt: relationColumn(
      relation,
      "visit_started_at",
    ) as AnalyticsLegacyPageRow["startedAt"],
    pathname: relationColumn(
      relation,
      "visit_pathname",
    ) as AnalyticsLegacyPageRow["pathname"],
    durationMs: relationColumn(
      relation,
      "visit_duration_ms",
    ) as AnalyticsLegacyPageRow["durationMs"],
    visitColumns,
    filterValues,
  };
}

export function directPageRows(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  matchingEventOwnerPairs?: IdentityRelation,
): AnalyticsDbRelation {
  const pagePlan = planObservationFilter(selection.filter.root).visit;
  const eventPlan = planObservationFilter(selection.filter.root).event;
  const pages = dataset.candidatePages;
  const pageTerm = pagePlan.kind !== "all";
  const eventTerm = eventPlan.kind !== "all";
  if (!pageTerm && !eventTerm)
    return pagePlan.kind === "all"
      ? pages.relation
      : filter(pages.relation, eq(constant(1), constant(0)));
  const context: AnalyticsLegacyScopedPredicateContext = {
    selection,
    storage: dataset.storage,
    readPages: dataset.readPages,
    candidatePages: dataset.candidatePages,
    readEvents: dataset.readEvents,
  };
  if (pageTerm && !eventTerm) {
    if (pagePlan.kind === "none")
      return filter(pages.relation, eq(constant(1), constant(0)));
    return filterExpression(pages, pagePlan.expression, { selection, context });
  }
  const eventPairs =
    matchingEventOwnerPairs ??
    (eventPlan.kind === "none"
      ? emptyIdentities(pagePairIdentityRows(pages))
      : eventOwnerPairsForObservationFilter(
          dataset,
          selection,
          selection.filter.root,
        ));
  if (!pageTerm) return pageRowsForVisitIds(pages, eventPairs);

  const joined = join(
    pages.relation,
    eventPairs,
    and(
      eq(pages.relation.columns.site_pk!, eventPairs.columns.site_pk!),
      eq(pages.relation.columns.visit_id!, eventPairs.columns.visit_id!),
    ),
    "left",
  );
  const pageFieldNames = Object.keys(pages.relation.columns);
  const annotated: AnalyticsDbRelation = project(joined, {
    ...Object.fromEntries(
      pageFieldNames.map((name) => [name, joined.columns[`left_${name}`]!]),
    ),
    event_owner_site_pk: joined.columns.right_site_pk!,
  });
  const joinedPages = pageRowWithRelation(pages, annotated);
  const pagePredicate =
    pagePlan.kind === "none"
      ? eq(constant(1), constant(0))
      : (filterPredicate(joinedPages, pagePlan.expression, {
          selection,
          context,
        }) ?? eq(constant(1), constant(1)));
  const selected = filter(
    annotated,
    or(pagePredicate, isNotNull(annotated.columns.event_owner_site_pk!)),
  );
  return project(
    selected,
    Object.fromEntries(
      pageFieldNames.map((name) => [name, selected.columns[name]!]),
    ),
  );
}

/**
 * Legacy unprepared Session-boundary filters first matched candidate Page
 * rows, then expanded the selected raw Session IDs back to the candidate Page
 * bag. This compatibility profile is deliberately distinct from canonical
 * entity filtering, where separate Page facts may satisfy an AND.
 */
export function compatibilitySessionPageRows(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  matchingEventOwnerPairs?: IdentityRelation,
): AnalyticsDbRelation {
  return compatibilityEntityPageRows(
    dataset,
    selection,
    "session",
    matchingEventOwnerPairs,
  );
}

/** Match legacy same-row Page eligibility, then expand its raw entity ID. */
export function compatibilityEntityPageRows(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  kind: EntityKind,
  matchingEventOwnerPairs?: IdentityRelation,
): AnalyticsDbRelation {
  const candidatePages = dataset.candidatePages;
  const entityColumn = entityColumnName(candidatePages, kind);
  const selectedPageBag = directPageRows(
    dataset,
    selection,
    matchingEventOwnerPairs,
  );
  const matchingPages = filter(
    selectedPageBag,
    nonBlank(selectedPageBag.columns[entityColumn]! as AnalyticsLegacyText),
  );
  const matchingEntities: IdentityRelation = distinct(
    project(matchingPages, {
      site_pk: matchingPages.columns.site_pk!,
      entity_id: matchingPages.columns[entityColumn]!,
    }),
  );
  const candidateEntities = filter(
    candidatePages.relation,
    nonBlank(
      candidatePages.relation.columns[entityColumn]! as AnalyticsLegacyText,
    ),
  );
  return joinMembership(
    candidateEntities,
    matchingEntities,
    and(
      eq(candidateEntities.columns.site_pk!, matchingEntities.columns.site_pk!),
      eq(
        candidateEntities.columns[entityColumn]!,
        matchingEntities.columns.entity_id!,
      ),
    ),
  );
}

export function selectedPageRows(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  matchingEventOwnerPairs?: IdentityRelation,
  qualifiedEntities?: IdentityRelation,
  qualificationRelations?: ReadonlyMap<string, AnalyticsDbRelation>,
): AnalyticsLegacyPageRow {
  const relation =
    selection.profile === "direct-page-analytics-v1"
      ? directPageRows(dataset, selection, matchingEventOwnerPairs)
      : selection.profile === "direct-page-entity-only-compat-v1"
        ? compatibilityEntityPageRows(
            dataset,
            selection,
            selection.entityKind!,
            matchingEventOwnerPairs,
          )
        : selection.profile === "direct-page-session-compat-v1"
          ? factEntityKindsForFilter(selection.filter.root).size === 0
            ? compatibilitySessionPageRows(
                dataset,
                selection,
                matchingEventOwnerPairs,
              )
            : entityPageRows(
                dataset,
                selection,
                qualifiedEntities,
                qualificationRelations,
              )
          : selection.mode === "observation"
            ? pageRowsForVisitIds(
                dataset.candidatePages,
                observationPagePairMatches(
                  dataset,
                  selection,
                  qualificationRelations,
                ),
              )
            : entityPageRows(
                dataset,
                selection,
                qualifiedEntities,
                qualificationRelations,
              );
  return pageRowWithRelation(dataset.candidatePages, relation);
}

export function selectedEventRelation(
  report: AnalyticsDbRelation,
  matches: IdentityRelation,
): AnalyticsDbRelation {
  const ownerPresent = report.columns.owner_site_pk;
  if (!ownerPresent)
    throw new Error("legacy_scoped_event_owner_presence_missing");
  const inLegacyReportDomain = filter(report, isNotNull(ownerPresent));
  const matchSet = distinct(
    project(matches, {
      site_pk: matches.columns.site_pk!,
      event_id: matches.columns.event_id!,
    }),
  );
  return joinMembership(
    inLegacyReportDomain,
    matchSet,
    and(
      eq(inLegacyReportDomain.columns.site_pk!, matchSet.columns.site_pk!),
      eq(inLegacyReportDomain.columns.event_id!, matchSet.columns.event_id!),
    ),
  );
}

export function selectedEventRows(
  dataset: AnalyticsLegacyScopedDataset,
  matches: IdentityRelation,
): AnalyticsLegacyEventRow {
  const selected = selectedEventRelation(dataset.readEvents.relation, matches);
  const source = dataset.readEvents;
  const eventColumns = Object.fromEntries(
    Object.keys(source.eventColumns).map((name) => [
      name,
      relationColumn(selected, `event_${name}`),
    ]),
  ) as Partial<Record<AnalyticsLegacyEventColumnName, AnyExpression>>;
  const ownerVisitColumns = Object.fromEntries(
    Object.keys(source.ownerVisitColumns).map((name) => [
      name,
      relationColumn(selected, `owner_${name}`),
    ]),
  ) as Partial<Record<AnalyticsLegacyVisitColumnName, AnyExpression>>;
  const eventName = relationColumn(
    selected,
    "event_name",
  ) as AnalyticsLegacyText;
  const filterValues: Partial<
    Record<AnalyticsLegacyFilterField, AnyExpression>
  > = {};
  for (const field of Object.keys(
    source.filterValues,
  ) as AnalyticsLegacyFilterField[]) {
    const strategy = analyticsFilterDefinition(field)?.compilerStrategy;
    const expression = strategy?.startsWith("column.")
      ? ownerVisitColumns[
          strategy.slice("column.".length) as AnalyticsLegacyVisitColumnName
        ]
      : strategy === "event.name"
        ? eventName
        : undefined;
    if (expression) filterValues[field] = expression;
  }
  return {
    ...source,
    relation: selected,
    sitePk: relationColumn(
      selected,
      "site_pk",
    ) as AnalyticsLegacyEventRow["sitePk"],
    rawSiteId: relationColumn(
      selected,
      "event_site_id",
    ) as AnalyticsLegacyEventRow["rawSiteId"],
    eventPk: relationColumn(
      selected,
      "event_event_pk",
    ) as AnalyticsLegacyEventRow["eventPk"],
    eventId: relationColumn(
      selected,
      "event_event_id",
    ) as AnalyticsLegacyEventRow["eventId"],
    nameId: relationColumn(
      selected,
      "event_event_name_id",
    ) as AnalyticsLegacyEventRow["nameId"],
    visitId: relationColumn(
      selected,
      "event_visit_id",
    ) as AnalyticsLegacyEventRow["visitId"],
    sessionId: relationColumn(
      selected,
      "session_id",
    ) as AnalyticsLegacyEventRow["sessionId"],
    visitorId: relationColumn(
      selected,
      "visitor_id",
    ) as AnalyticsLegacyEventRow["visitorId"],
    occurredAt: relationColumn(
      selected,
      "event_occurred_at",
    ) as AnalyticsLegacyEventRow["occurredAt"],
    eventName,
    eventColumns,
    ownerVisitColumns,
    filterValues,
  };
}

export class ScopedSourceMembership {
  readonly #context: AnalyticsScopedSourceContext;
  constructor(context: AnalyticsScopedSourceContext) {
    this.#context = context;
  }

  matchingPageEventOwnerPairs(
    dataset: AnalyticsLegacyScopedDataset,
    selection: SemanticScopedSourceSelection,
  ): IdentityRelation | undefined {
    const key = pageEventOwnerPairCacheKey(selection);
    if (!key) return undefined;
    const existing = this.#context.pageEventOwnerPairs.get(key);
    if (existing) return existing;
    const matching = eventOwnerPairsForObservationFilter(
      dataset,
      selection,
      selection.filter.root,
    );
    this.#context.pageEventOwnerPairs.set(key, matching);
    return matching;
  }

  matchingEntityQualifications(
    selection: SemanticScopedSourceSelection,
    temporalDomain: SourceNode["temporalDomain"],
  ): IdentityRelation | undefined {
    const key = entityQualificationCacheKey(selection, temporalDomain);
    if (
      !key ||
      (this.#context.entityQualificationSourceCounts.get(key) ?? 0) < 2
    )
      return undefined;
    const existing = this.#context.entityQualifications.get(key);
    if (existing) return existing;

    const kind = selection.entityKind;
    if (!kind)
      throw new TypeError("Scoped entity mode requires an entity kind.");
    const dataset = buildLegacyScopedDataset({
      selection,
      storage: this.#context.storage,
    });
    const universe = entityUniverse(dataset, kind);
    const identities =
      qualifiedRelation(
        dataset,
        selection,
        "entity",
        this.#context.qualificationRelations,
      ) ??
      (selection.filter.root
        ? lowerEntityExpression(
            selection.filter.root,
            dataset,
            selection,
            kind,
            universe,
          )
        : universe);
    this.#context.entityQualifications.set(key, identities);
    return identities;
  }

  matchingEventRows(
    dataset: AnalyticsLegacyScopedDataset,
    selection: SemanticScopedSourceSelection,
    qualifiedEntities?: IdentityRelation,
  ): IdentityRelation {
    if (canReuseRowLocalEventMatches(selection)) {
      const baseSelection = withoutEventNameGate(selection);
      const key = JSON.stringify(baseSelection);
      let baseMatches = this.#context.rowLocalEventMatches.get(key);
      if (!baseMatches) {
        const baseDataset =
          baseSelection === selection
            ? dataset
            : buildLegacyScopedDataset({
                selection: baseSelection,
                storage: this.#context.storage,
              });
        baseMatches = observationEventMatches(baseDataset, baseSelection);
        this.#context.rowLocalEventMatches.set(key, baseMatches);
      }
      if (selection.eventNameGate) {
        const nameGatedIds = eventIdentityRows(dataset.readEvents);
        return joinMembership(
          baseMatches,
          nameGatedIds,
          and(
            eq(baseMatches.columns.site_pk!, nameGatedIds.columns.site_pk!),
            eq(baseMatches.columns.event_id!, nameGatedIds.columns.event_id!),
          ),
        );
      }
      return baseMatches;
    }
    return selection.mode === "entity"
      ? entityEventMatches(
          dataset,
          selection,
          qualifiedEntities,
          this.#context.qualificationRelations,
        )
      : observationEventMatches(
          dataset,
          selection,
          this.#context.qualificationRelations,
        );
  }
}
