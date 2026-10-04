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
  neq,
  or,
  param,
  type Predicate,
  project,
  trimSpaces,
  union,
  valuesRelation,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  SqlExpression,
} from "@/lib/db/query/expression";
import { factEntityKindsForFilter } from "@/lib/edge/analytics/contract";
import { planObservationFilter } from "@/lib/edge/analytics/contract/observation-planner";
import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import { semanticAttribute } from "@/lib/edge/analytics/engine/semantic/attributes";
import type { SemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { analyticsFilterDefinition } from "@/lib/filter-contract/filter-registry";
import type {
  FilterCondition,
  FilterExpression,
} from "@/lib/filter-contract/filters";

import { lowerLegacyRelationalPredicate } from "./analytics-legacy-relational-predicates";
import {
  type LegacyScalarFilterContext,
  LegacyScalarFilterLoweringError,
  legacyTextVectorConditionGroupKey,
  lowerLegacyScalarFilterDocument,
  lowerLegacyScalarValueCondition,
} from "./analytics-legacy-scalar-filter-lowering";
import { buildLegacyScopeFactRelation } from "./analytics-legacy-scope-facts";
import {
  type AnalyticsLegacyScopedDataset,
  buildLegacyScopedDataset,
  LEGACY_DIRECT_EVENT_RECORD_VISIT_COLUMNS,
} from "./analytics-legacy-scoped-dataset";
import type {
  AnalyticsLegacyEventRow,
  AnalyticsLegacyFactRelation,
  AnalyticsLegacyFilterField,
  AnalyticsLegacyPageRow,
  AnalyticsLegacyScopedPredicateContext,
  AnalyticsLegacyText,
} from "./analytics-legacy-scoped-types";
import type {
  AnalyticsDbRelation,
  AnalyticsRelationalStorageContext,
  AnalyticsSourceValue,
  LoweredAnalyticsSource,
} from "./analytics-relational-storage";
import { analyticsPageReportStorageColumn } from "./analytics-relational-storage";

type EntityKind = "session" | "visitor";
type IdentityRelation = AnalyticsDbRelation;
function relationColumn(
  relation: AnalyticsDbRelation,
  name: string,
): AnyExpression {
  const value = (relation.columns as Readonly<Record<string, AnyExpression>>)[
    name
  ];
  if (!value) throw new Error(`Missing scoped Page column ${name}.`);
  return value;
}

const rowLocalDerivedStrategies = new Set([
  "derived.trafficChannel",
  "derived.browserEngine",
  "derived.osVersion",
  "derived.screenSize",
]);
const PAGE_EVENT_OWNER_PAIR_EQUIVALENCE =
  "direct-page-row-local-event-owner-pairs-v1";
const legacyDirectEventRecordVisitColumnSet = new Set<string>(
  LEGACY_DIRECT_EVENT_RECORD_VISIT_COLUMNS,
);

function isRowLocalFilter(expression: FilterExpression | null): boolean {
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

function canReuseRowLocalEventMatches(
  selection: SemanticScopedSourceSelection,
): boolean {
  return (
    selection.profile === "direct-event-analytics-v1" &&
    selection.mode === "observation" &&
    selection.scope === "event" &&
    selection.preparedMatches === undefined &&
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
    selection.preparedMatches !== undefined ||
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

function withoutEventNameGate(
  selection: SemanticScopedSourceSelection,
): SemanticScopedSourceSelection {
  if (!selection.eventNameGate) return selection;
  const { eventNameGate: _eventNameGate, ...baseSelection } = selection;
  return baseSelection;
}

function nonBlank(value: AnyExpression): Predicate {
  const text = value as SqlExpression<
    string | null,
    ExpressionResultType<"text", boolean>
  >;
  return neq(trimSpaces(coalesce(text, constant(""))), constant(""));
}

function matchingIdentity(
  left: { readonly columns: Readonly<Record<string, AnyExpression>> },
  right: { readonly columns: Readonly<Record<string, AnyExpression>> },
): Predicate {
  return and(
    eq(left.columns.site_pk!, right.columns.site_pk!),
    eq(left.columns.entity_id!, right.columns.entity_id!),
  );
}

/** Join a row bag to a unique membership set without multiplying source rows. */
function joinMembership(
  left: AnalyticsDbRelation,
  right: AnalyticsDbRelation,
  on: Predicate,
): AnalyticsDbRelation {
  const joined = join(left, right, on);
  return project(
    joined,
    Object.fromEntries(
      Object.keys(left.columns).map((name) => [
        name,
        joined.columns[`left_${name}`]!,
      ]),
    ),
  );
}

function emptyIdentities(universe: IdentityRelation): IdentityRelation {
  return filter(universe, eq(constant(1), constant(0)));
}

function eventIdentityRows(events: AnalyticsLegacyEventRow): IdentityRelation {
  return distinct(
    project(events.relation, {
      site_pk: events.relation.columns.site_pk!,
      event_id: events.relation.columns.event_id!,
    }),
  );
}

function entityColumnName(
  row: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow,
  kind: EntityKind,
): string {
  if ("eventPk" in row) return kind === "session" ? "session_id" : "visitor_id";
  return kind === "session" ? "visit_session_id" : "visit_visitor_id";
}

function entityId(
  row: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow,
  kind: EntityKind,
): AnalyticsLegacyText {
  return kind === "session" ? row.sessionId : row.visitorId;
}

function entityRowsFromPage(
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

function entityRowsFromEvent(
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

function entityUniverse(
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

function scalarContext(
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
    resolveTypedCondition: (condition) => {
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

function filterExpression(
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

function filterPredicate(
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

function selectedPageOrEventEntities(
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

function bridgeFactMatches(
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

function entityConditionMatches(
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

function lowerEntityExpression(
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

function explicitIdentityRelation(
  dataset: AnalyticsLegacyScopedDataset,
  identities: readonly {
    readonly siteId: string;
    readonly kind: string;
    readonly id: string;
  }[],
  kind: string,
): AnalyticsDbRelation {
  const input = valuesRelation(
    {
      site_id: { affinity: "text", nullable: false },
      kind: { affinity: "text", nullable: false },
      entity_id: { affinity: "text", nullable: false },
    },
    identities.map((identity) => ({
      site_id: sqliteBoundText(identity.siteId),
      kind: sqliteBoundText(identity.kind),
      entity_id: sqliteBoundText(identity.id),
    })),
  );
  const selected = filter(input, eq(input.columns.kind, param(kind)));
  const scoped = join(
    selected,
    dataset.sites,
    eq(selected.columns.site_id, dataset.sites.columns.site_id),
  );
  // Prepared identities form a complete (site, entity) set before they are
  // used as a membership RHS, so duplicates cannot multiply source rows.
  return distinct(
    project(scoped, {
      site_pk: scoped.columns.right_site_pk,
      entity_id: scoped.columns.left_entity_id,
    }),
  );
}

/** Match SQLite's text binding replacement for isolated UTF-16 surrogates. */
function sqliteBoundText(value: string): string {
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

function applyNameGate(
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

function observationEventMatches(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
): IdentityRelation {
  const context: AnalyticsLegacyScopedPredicateContext = {
    selection,
    storage: dataset.storage,
    readPages: dataset.readPages,
    candidatePages: dataset.candidatePages,
    readEvents: dataset.readEvents,
  };
  let matched: IdentityRelation;
  if (selection.preparedMatches) {
    const explicit = explicitIdentityRelation(
      dataset,
      selection.preparedMatches.identities,
      "event",
    );
    const gatedIds = eventIdentityRows(
      applyNameGate(dataset.readEvents, dataset, selection),
    );
    return joinMembership(
      gatedIds,
      explicit,
      and(
        eq(gatedIds.columns.site_pk!, explicit.columns.site_pk!),
        eq(gatedIds.columns.event_id!, explicit.columns.entity_id!),
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

function entityEventMatches(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
): IdentityRelation {
  const kind = selection.entityKind;
  if (!kind) throw new TypeError("Scoped entity mode requires an entity kind.");
  if (selection.preparedMatches) {
    const explicit = explicitIdentityRelation(
      dataset,
      selection.preparedMatches.identities,
      kind,
    );
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

  const universe = entityUniverse(dataset, kind);
  const selected = selection.filter.root
    ? lowerEntityExpression(
        selection.filter.root,
        dataset,
        selection,
        kind,
        universe,
      )
    : universe;
  const events = dataset.readEvents;
  const matchingEventRows = joinMembership(
    events.relation,
    selected,
    and(
      eq(events.relation.columns.site_pk!, selected.columns.site_pk!),
      eq(
        events.relation.columns[entityColumnName(events, kind)]!,
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

function pagePairIdentityRows(pages: AnalyticsLegacyPageRow): IdentityRelation {
  return distinct(
    project(pages.relation, {
      site_pk: pages.relation.columns.site_pk!,
      visit_id: pages.relation.columns.visit_id!,
    }),
  );
}

function eventOwnerPairIdentityRows(
  events: AnalyticsLegacyEventRow,
): IdentityRelation {
  return distinct(
    project(events.relation, {
      site_pk: events.relation.columns.site_pk!,
      visit_id: events.relation.columns.visit_id!,
    }),
  );
}

function eventOwnerPairsForObservationFilter(
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

function observationPagePairMatches(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
): IdentityRelation {
  if (selection.preparedMatches) {
    const explicit = explicitIdentityRelation(
      dataset,
      selection.preparedMatches.identities,
      "page",
    );
    return project(explicit, {
      site_pk: explicit.columns.site_pk!,
      visit_id: explicit.columns.entity_id!,
    });
  }
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

function entityPageRows(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
): AnalyticsDbRelation {
  const kind = selection.entityKind;
  if (!kind) throw new TypeError("Scoped entity mode requires an entity kind.");
  const universe = entityUniverse(dataset, kind);
  const selected = selection.preparedMatches
    ? explicitIdentityRelation(
        dataset,
        selection.preparedMatches.identities,
        kind,
      )
    : selection.filter.root
      ? lowerEntityExpression(
          selection.filter.root,
          dataset,
          selection,
          kind,
          universe,
        )
      : universe;
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

function pageRowsForVisitIds(
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

function pageRowWithRelation(
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

function directPageRows(
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
function compatibilitySessionPageRows(
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
  matchingEventOwnerPairs?: IdentityRelation,
): AnalyticsDbRelation {
  const candidatePages = dataset.candidatePages;
  const sessionColumn = entityColumnName(candidatePages, "session");
  const selectedPageBag = directPageRows(
    dataset,
    selection,
    matchingEventOwnerPairs,
  );
  const matchingPages = filter(
    selectedPageBag,
    nonBlank(selectedPageBag.columns[sessionColumn]! as AnalyticsLegacyText),
  );
  const matchingSessions: IdentityRelation = distinct(
    project(matchingPages, {
      site_pk: matchingPages.columns.site_pk!,
      entity_id: matchingPages.columns[sessionColumn]!,
    }),
  );
  const candidateSessions = filter(
    candidatePages.relation,
    nonBlank(candidatePages.sessionId),
  );
  return joinMembership(
    candidateSessions,
    matchingSessions,
    and(
      eq(candidateSessions.columns.site_pk!, matchingSessions.columns.site_pk!),
      eq(
        candidateSessions.columns[sessionColumn]!,
        matchingSessions.columns.entity_id!,
      ),
    ),
  );
}

function eventAttributeColumn(
  attributeId: string,
  relation: AnalyticsDbRelation,
): AnyExpression | undefined {
  const directColumns: Readonly<Record<string, string>> = {
    "event.report.localId": "event_id",
    "event.report.nameId": "event_name_id",
    "event.report.eventName": "event_name",
    "event.report.ownerVisitId": "visit_id",
    "event.report.occurredAt": "occurred_at",
    "event.report.receivedAt": "received_at",
    "event.report.sequence": "sequence",
    "event.report.nodeCount": "node_count",
    "event.report.valueCount": "value_count",
    "event.report.userId": "user_id",
  };
  if (attributeId === "event.report.internalPk")
    return coalesce(relation.columns.event_pk!, constant(0));
  if (attributeId === "event.report.ownerPresent")
    return relation.columns.owner_site_pk
      ? isNotNull(relation.columns.owner_site_pk)
      : undefined;
  const direct = directColumns[attributeId];
  if (direct) return relation.columns[direct];

  const definition = semanticAttribute(attributeId);
  const derivation = definition?.derivation;
  if (
    derivation?.kind === "report-relationship" &&
    derivation.relationship === "event.ownerPage" &&
    derivation.sourceAttribute
  ) {
    const sourceName = derivation.sourceAttribute.slice("page.report.".length);
    const physicalName = sourceName.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`,
    );
    const column = relation.columns[`owner_${physicalName}`];
    if (column) return column;
  }
  return undefined;
}

function pageAttributeColumn(
  attributeId: string,
  relation: AnalyticsDbRelation,
): AnyExpression | undefined {
  const physical = analyticsPageReportStorageColumn(attributeId);
  return physical ? relation.columns[`visit_${physical}`] : undefined;
}

function remapPageSourceValues(
  node: SourceNode,
  relation: AnalyticsDbRelation,
  values: ReadonlyMap<
    SourceNode["values"][number]["slot"],
    AnalyticsSourceValue
  >,
): ReadonlyMap<SourceNode["values"][number]["slot"], AnalyticsSourceValue> {
  const remapped = new Map<
    SourceNode["values"][number]["slot"],
    AnalyticsSourceValue
  >();
  for (const binding of node.values) {
    const value = values.get(binding.slot);
    if (!value) continue;
    if (
      binding.kind === "self" &&
      value.kind === "entity" &&
      value.entity === "page"
    ) {
      remapped.set(binding.slot, {
        ...value,
        keys: [relation.columns.site_pk!, relation.columns.visit_id!],
        present: isNotNull(relation.columns.site_pk!),
      });
      continue;
    }
    if (binding.kind === "attribute" && value.kind === "scalar") {
      const expression = pageAttributeColumn(binding.attribute, relation);
      if (!expression)
        throw new Error(
          `Scoped Page source cannot remap attribute ${binding.attribute}.`,
        );
      remapped.set(binding.slot, { ...value, value: expression });
      continue;
    }
    throw new Error(
      `Scoped Page source cannot remap the ${binding.kind} binding for ${String(binding.slot)}.`,
    );
  }
  return remapped;
}

function remapEventSourceValues(
  node: SourceNode,
  relation: AnalyticsDbRelation,
  values: ReadonlyMap<
    SourceNode["values"][number]["slot"],
    AnalyticsSourceValue
  >,
): ReadonlyMap<SourceNode["values"][number]["slot"], AnalyticsSourceValue> {
  const remapped = new Map<
    SourceNode["values"][number]["slot"],
    AnalyticsSourceValue
  >();
  for (const binding of node.values) {
    const value = values.get(binding.slot);
    if (!value) continue;
    if (
      binding.kind === "self" &&
      value.kind === "entity" &&
      value.entity === "event"
    ) {
      remapped.set(binding.slot, {
        ...value,
        keys: [relation.columns.site_pk!, relation.columns.event_id!],
        present: isNotNull(relation.columns.site_pk!),
      });
      continue;
    }
    if (binding.kind === "attribute" && value.kind === "scalar") {
      const expression = eventAttributeColumn(binding.attribute, relation);
      remapped.set(binding.slot, {
        ...value,
        ...(expression ? { value: expression } : {}),
      });
      continue;
    }
    throw new Error(
      `Scoped Event source cannot remap the ${binding.kind} binding for ${String(binding.slot)}.`,
    );
  }
  return remapped;
}

/**
 * Apply the immutable legacy Filter selection to an Event report Source.
 * The Source's output layout comes from the regular semantic storage path;
 * this module supplies only its row membership.
 */
export class AnalyticsLegacyScopedStorage {
  readonly #storage: AnalyticsRelationalStorageContext;
  readonly #rowLocalEventMatches = new Map<string, IdentityRelation>();
  readonly #pageEventOwnerPairs = new Map<string, IdentityRelation>();

  constructor(storage: AnalyticsRelationalStorageContext) {
    this.#storage = storage;
  }

  #matchingPageEventOwnerPairs(
    dataset: AnalyticsLegacyScopedDataset,
    selection: SemanticScopedSourceSelection,
  ): IdentityRelation | undefined {
    const key = pageEventOwnerPairCacheKey(selection);
    if (!key) return undefined;
    const existing = this.#pageEventOwnerPairs.get(key);
    if (existing) return existing;
    const matching = eventOwnerPairsForObservationFilter(
      dataset,
      selection,
      selection.filter.root,
    );
    this.#pageEventOwnerPairs.set(key, matching);
    return matching;
  }

  lowerSelectedReportSource(
    node: SourceNode,
    path: string,
    source: LoweredAnalyticsSource,
  ): LoweredAnalyticsSource {
    if (!node.selection) return source;
    if (node.entity === "page")
      return this.lowerPageReportSource(node, path, source);
    if (node.entity === "event")
      return this.lowerEventReportSource(node, path, source);
    throw new Error(
      `${path}.selection: Scoped selection is supported only on Page and Event report Sources.`,
    );
  }

  lowerPageReportSource(
    node: SourceNode,
    path: string,
    source: LoweredAnalyticsSource,
  ): LoweredAnalyticsSource {
    const selection = node.selection;
    if (!selection) return source;
    if (node.entity !== "page")
      throw new Error(
        `${path}.selection: Scoped Page selection requires a Page report Source.`,
      );
    if (node.temporalDomain !== "candidate")
      throw new Error(
        `${path}.temporalDomain: Scoped Page report Sources currently require the candidate domain.`,
      );
    if (
      selection.profile !== "direct-page-analytics-v1" &&
      selection.profile !== "direct-page-session-compat-v1" &&
      selection.profile !== "prepared-scoped-v1"
    )
      throw new Error(`${path}.selection: Invalid Page source profile.`);
    if (selection.eventNameGate)
      throw new Error(
        `${path}.selection: Page report Sources do not support Event-name gates.`,
      );

    const pageAttributes = node.values.flatMap((binding) =>
      binding.kind === "attribute" ? [binding.attribute] : [],
    );
    const dataset = buildLegacyScopedDataset({
      selection,
      storage: this.#storage,
      requiredPageAttributes: pageAttributes,
    });
    const matchingEventOwnerPairs = this.#matchingPageEventOwnerPairs(
      dataset,
      selection,
    );
    const relation =
      selection.profile === "direct-page-analytics-v1"
        ? directPageRows(dataset, selection, matchingEventOwnerPairs)
        : selection.profile === "direct-page-session-compat-v1"
          ? factEntityKindsForFilter(selection.filter.root).size === 0
            ? compatibilitySessionPageRows(
                dataset,
                selection,
                matchingEventOwnerPairs,
              )
            : entityPageRows(dataset, selection)
          : selection.mode === "observation"
            ? pageRowsForVisitIds(
                dataset.candidatePages,
                observationPagePairMatches(dataset, selection),
              )
            : entityPageRows(dataset, selection);
    return {
      relation,
      values: remapPageSourceValues(node, relation, source.values),
    };
  }

  lowerEventReportSource(
    node: SourceNode,
    path: string,
    source: LoweredAnalyticsSource,
  ): LoweredAnalyticsSource {
    const selection = node.selection;
    if (!selection) return source;
    if (node.entity !== "event")
      throw new Error(
        `${path}.selection: Scoped selection is currently supported only on Event report Sources.`,
      );
    if (node.temporalDomain !== "candidate")
      throw new Error(
        `${path}.temporalDomain: Scoped Event report Sources currently require the candidate domain.`,
      );
    const dataset = buildLegacyScopedDataset({
      selection,
      storage: this.#storage,
    });
    let matches: IdentityRelation;
    if (canReuseRowLocalEventMatches(selection)) {
      const baseSelection = withoutEventNameGate(selection);
      const key = JSON.stringify(baseSelection);
      let baseMatches = this.#rowLocalEventMatches.get(key);
      if (!baseMatches) {
        const baseDataset =
          baseSelection === selection
            ? dataset
            : buildLegacyScopedDataset({
                selection: baseSelection,
                storage: this.#storage,
              });
        baseMatches = observationEventMatches(baseDataset, baseSelection);
        this.#rowLocalEventMatches.set(key, baseMatches);
      }
      if (selection.eventNameGate) {
        const nameGatedIds = eventIdentityRows(dataset.readEvents);
        matches = joinMembership(
          baseMatches,
          nameGatedIds,
          and(
            eq(baseMatches.columns.site_pk!, nameGatedIds.columns.site_pk!),
            eq(baseMatches.columns.event_id!, nameGatedIds.columns.event_id!),
          ),
        );
      } else {
        matches = baseMatches;
      }
    } else {
      matches =
        selection.mode === "entity"
          ? entityEventMatches(dataset, selection)
          : observationEventMatches(dataset, selection);
    }
    const report = source.relation;
    const sitePk = report.columns.site_pk;
    const eventId = report.columns.event_id;
    const ownerPresent = report.columns.owner_site_pk;
    const eventName = report.columns.event_name;
    if (!sitePk || !eventId || !ownerPresent || !eventName)
      throw new Error(
        `${path}.selection: The report carrier is missing a legacy owner/name dependency.`,
      );
    // The legacy Event source inner-joins the event-name dictionary, but it
    // does not require the stored label itself to be non-NULL. Keep owner
    // presence here; consumers such as summaries need raw NULL labels to
    // remain in the row domain for COUNT(*) while applying their own
    // COALESCE/TRIM behavior.
    const inLegacyReportDomain = filter(report, isNotNull(ownerPresent));
    const matchSet = distinct(
      project(matches, {
        site_pk: matches.columns.site_pk!,
        event_id: matches.columns.event_id!,
      }),
    );
    const selected = joinMembership(
      inLegacyReportDomain,
      matchSet,
      and(
        eq(inLegacyReportDomain.columns.site_pk!, matchSet.columns.site_pk!),
        eq(inLegacyReportDomain.columns.event_id!, matchSet.columns.event_id!),
      ),
    );
    return {
      relation: selected,
      values: remapEventSourceValues(node, selected, source.values),
    };
  }
}
