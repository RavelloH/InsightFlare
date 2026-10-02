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
  not,
  or,
  param,
  type Predicate,
  project,
  semiJoin,
  trimSpaces,
  union,
  valuesRelation,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  SqlExpression,
} from "@/lib/db/query/expression";
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
  lowerLegacyScalarContextCondition,
  lowerLegacyScalarValueCondition,
} from "./analytics-legacy-scalar-filter-lowering";
import { buildLegacyScopeFactRelation } from "./analytics-legacy-scope-facts";
import {
  type AnalyticsLegacyScopedDataset,
  buildLegacyScopedDataset,
} from "./analytics-legacy-scoped-dataset";
import type {
  AnalyticsLegacyEventRow,
  AnalyticsLegacyFactRelation,
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

type EntityKind = "session" | "visitor";
type IdentityRelation = AnalyticsDbRelation;

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
): LegacyScalarFilterContext {
  const visitColumns: Record<string, AnyExpression> = {};
  for (const [name, expression] of Object.entries(
    "eventPk" in row ? row.ownerVisitColumns : row.visitColumns,
  )) {
    if (!expression) continue;
    // The legacy direct reader's projection omitted performance values. Keep
    // that located missing-dependency behavior while prepared Sources expose
    // the registered schema fields.
    if (
      selection.profile === "direct-event-records-v1" &&
      name.startsWith("perf_")
    )
      continue;
    visitColumns[name] = expression;
  }
  return {
    visitColumns,
    ...("eventPk" in row ? { eventName: row.eventName } : {}),
  };
}

function lowerCondition(
  condition: FilterCondition,
  input: {
    readonly selection: SemanticScopedSourceSelection;
    readonly context: AnalyticsLegacyScopedPredicateContext;
    readonly source: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow;
  },
): Predicate {
  if (condition.target.kind === "event-payload") {
    if (!("eventPk" in input.source))
      throw new TypeError("Event-payload predicates require an Event source.");
    return lowerLegacyRelationalPredicate({
      condition,
      context: input.context,
      source: input.source,
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
    definition.compilerStrategy === "session.boundary.entry" ||
    definition.compilerStrategy === "session.boundary.exit"
  )
    return lowerLegacyRelationalPredicate({
      condition,
      context: input.context,
      source: input.source,
    });
  return lowerLegacyScalarContextCondition(
    condition,
    scalarContext(input.selection, input.source),
  );
}

function lowerExpression(
  expression: FilterExpression,
  input: {
    readonly selection: SemanticScopedSourceSelection;
    readonly context: AnalyticsLegacyScopedPredicateContext;
    readonly source: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow;
  },
): Predicate {
  if (expression.kind === "condition") return lowerCondition(expression, input);
  if (expression.kind === "not")
    return not(lowerExpression(expression.child, input));
  const children = expression.children.map((child) =>
    lowerExpression(child, input),
  );
  return expression.kind === "and"
    ? children.slice(1).reduce((left, right) => and(left, right), children[0]!)
    : children.slice(1).reduce((left, right) => or(left, right), children[0]!);
}

function filterExpression(
  row: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow,
  expression: FilterExpression,
  input: {
    readonly selection: SemanticScopedSourceSelection;
    readonly context: AnalyticsLegacyScopedPredicateContext;
  },
): AnalyticsDbRelation {
  return filter(
    row.relation,
    lowerExpression(expression, { ...input, source: row }),
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
  const definition =
    expression.kind === "condition" && expression.target.kind === "field"
      ? analyticsFilterDefinition(expression.target.field)
      : undefined;
  const boundary =
    definition?.compilerStrategy === "session.boundary.entry" ||
    definition?.compilerStrategy === "session.boundary.exit";
  const payload =
    expression.kind === "condition" &&
    expression.target.kind === "event-payload";
  const pageApplicable =
    boundary ||
    (definition?.observationKinds.has("visit") ?? false) ||
    expression.kind !== "condition";
  const eventApplicable =
    payload ||
    boundary ||
    (definition?.observationKinds.has("event") ?? false) ||
    expression.kind !== "condition";
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
    const matched = semiJoin(
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
  const children = expression.children.map((child) =>
    lowerEntityExpression(child, dataset, selection, kind, universe),
  );
  if (expression.kind === "or")
    return distinct(
      children
        .slice(1)
        .reduce((left, right) => union(left, right), children[0]!),
    );
  let result = children[0]!;
  for (const next of children.slice(1))
    result = distinct(semiJoin(result, next, matchingIdentity(result, next)));
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
      site_id: identity.siteId,
      kind: identity.kind,
      entity_id: identity.id,
    })),
  );
  const selected = filter(input, eq(input.columns.kind, param(kind)));
  const scoped = join(
    selected,
    dataset.sites,
    eq(selected.columns.site_id, dataset.sites.columns.site_id),
  );
  return distinct(
    project(scoped, {
      site_pk: scoped.columns.right_site_pk,
      entity_id: scoped.columns.left_entity_id,
    }),
  );
}

function applyNameGate(
  rows: AnalyticsLegacyEventRow,
  dataset: AnalyticsLegacyScopedDataset,
  selection: SemanticScopedSourceSelection,
): AnalyticsLegacyEventRow {
  const gate = selection.eventNameGate;
  if (!gate) return rows;
  if (gate.semantics === "prepared-trimmed-label-v1") {
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
  const relation = semiJoin(
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
    const eventRows = eventIdentityRows(dataset.readEvents);
    matched = semiJoin(
      eventRows,
      explicit,
      and(
        eq(eventRows.columns.site_pk!, explicit.columns.site_pk!),
        eq(eventRows.columns.event_id!, explicit.columns.entity_id!),
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
  const gated = applyNameGate(dataset.readEvents, dataset, selection);
  const gatedIds = eventIdentityRows(gated);
  const identityRelation = matched;
  return semiJoin(
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
  const universe = entityUniverse(dataset, kind);
  const explicit = selection.preparedMatches
    ? explicitIdentityRelation(
        dataset,
        selection.preparedMatches.identities,
        kind,
      )
    : undefined;
  const selected = explicit
    ? semiJoin(universe, explicit, matchingIdentity(universe, explicit))
    : selection.filter.root
      ? lowerEntityExpression(
          selection.filter.root,
          dataset,
          selection,
          kind,
          universe,
        )
      : universe;
  const events = dataset.readEvents;
  const matchingEventRows = semiJoin(
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
  return semiJoin(
    selectedEventIds,
    gatedIds,
    and(
      eq(selectedEventIds.columns.site_pk!, gatedIds.columns.site_pk!),
      eq(selectedEventIds.columns.event_id!, gatedIds.columns.event_id!),
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

  constructor(storage: AnalyticsRelationalStorageContext) {
    this.#storage = storage;
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
    if (
      !node.values.some(
        (binding) =>
          binding.kind === "attribute" &&
          binding.attribute === "event.report.internalPk",
      )
    )
      throw new Error(
        `${path}.selection: Scoped Event report Sources require the hidden internal primary key.`,
      );

    const dataset = buildLegacyScopedDataset({
      selection,
      storage: this.#storage,
    });
    const matches =
      selection.mode === "entity"
        ? entityEventMatches(dataset, selection)
        : observationEventMatches(dataset, selection);
    const report = source.relation;
    const sitePk = report.columns.site_pk;
    const eventId = report.columns.event_id;
    const ownerPresent = report.columns.owner_site_pk;
    const eventName = report.columns.event_name;
    if (!sitePk || !eventId || !ownerPresent || !eventName)
      throw new Error(
        `${path}.selection: The report carrier is missing a legacy owner/name dependency.`,
      );
    const inLegacyReportDomain = filter(
      report,
      and(isNotNull(ownerPresent), isNotNull(eventName)),
    );
    const selected = semiJoin(
      inLegacyReportDomain,
      matches,
      and(
        eq(inLegacyReportDomain.columns.site_pk!, matches.columns.site_pk!),
        eq(inLegacyReportDomain.columns.event_id!, matches.columns.event_id!),
      ),
    );
    return {
      relation: selected,
      values: remapEventSourceValues(node, selected, source.values),
    };
  }
}
