import {
  and,
  coalesce,
  distinct,
  eq,
  filter,
  gte,
  inList,
  join,
  lt,
  param,
  project,
  scalar,
  scan,
  trimSpaces,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  SqlExpression,
} from "@/lib/db/query/expression";
import { schema } from "@/lib/db/schema";
import type { SemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import {
  analyticsFilterDefinition,
  analyticsFilterRegistry,
} from "@/lib/filter-contract/filter-registry";
import type { FilterExpression } from "@/lib/filter-contract/filters";

import {
  type AnalyticsLegacyEventColumnName,
  type AnalyticsLegacyEventRow,
  type AnalyticsLegacyFilterField,
  type AnalyticsLegacyNullableNumber,
  type AnalyticsLegacyNullableText,
  type AnalyticsLegacyNumber,
  type AnalyticsLegacyPageRow,
  type AnalyticsLegacyText,
  type AnalyticsLegacyVisitColumnName,
} from "./analytics-legacy-scoped-types";
import {
  type AnalyticsDbRelation,
  type AnalyticsRelationalStorageContext,
  normalizeAnalyticsRelationalSiteIds,
} from "./analytics-relational-storage";

function column(
  relation: { readonly columns: Readonly<Record<string, AnyExpression>> },
  name: string,
): AnyExpression {
  const expression = relation.columns[name];
  if (!expression)
    throw new Error(
      `Missing legacy Source column ${name}; available: ${Object.keys(relation.columns).join(",")}.`,
    );
  return expression;
}

function integer(
  expression: AnyExpression,
): SqlExpression<number, ExpressionResultType<"integer", false>> {
  return expression as SqlExpression<
    number,
    ExpressionResultType<"integer", false>
  >;
}

export interface AnalyticsLegacyScopedDataset {
  readonly sites: AnalyticsDbRelation;
  readonly subjectEventNames: AnalyticsDbRelation;
  readonly readPages: AnalyticsLegacyPageRow;
  readonly candidatePages: AnalyticsLegacyPageRow;
  readonly readEvents: AnalyticsLegacyEventRow;
  readonly storage: AnalyticsRelationalStorageContext;
}

/** Visit columns exposed by the legacy Event-page source and its Filter-only projection. */
export const LEGACY_DIRECT_EVENT_RECORD_VISIT_COLUMNS = Object.freeze([
  "visit_id",
  "visitor_id",
  "session_id",
  "pathname",
  "hostname",
  "title",
  "referrer_host",
  "country",
  "region",
  "city",
  "browser",
  "browser_version",
  "os",
  "os_version",
  "device_type",
  "query_string",
  "hash_fragment",
  "referrer_url",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "language",
  "screen_width",
  "screen_height",
  "continent",
  "timezone",
  "as_organization",
] as const);
const legacyDirectEventRecordVisitColumnSet = new Set<string>(
  LEGACY_DIRECT_EVENT_RECORD_VISIT_COLUMNS,
);

function requiredLegacyVisitColumnNames(
  selection: SemanticScopedSourceSelection,
): readonly string[] {
  const required = new Set([
    "site_pk",
    "site_id",
    "visit_id",
    "visitor_id",
    "session_id",
    "started_at",
    "duration_ms",
    "pathname",
  ]);
  const addColumn = (name: string): void => {
    if (
      selection.profile === "direct-event-records-v1" &&
      !legacyDirectEventRecordVisitColumnSet.has(name)
    )
      return;
    if (
      selection.profile === "direct-event-records-v1" &&
      name.startsWith("perf_")
    )
      return;
    required.add(name);
  };
  const addStrategyColumns = (strategy: string | undefined): void => {
    if (!strategy) return;
    if (strategy.startsWith("column.")) {
      addColumn(strategy.slice("column.".length));
      return;
    }
    const dependencies: Readonly<Record<string, readonly string[]>> = {
      "derived.trafficChannel": [
        "referrer_host",
        "utm_source",
        "utm_medium",
        "utm_campaign",
      ],
      "derived.browserEngine": ["browser", "os"],
      "derived.osVersion": ["os", "os_version"],
      "derived.screenSize": ["screen_width", "screen_height"],
    };
    for (const name of dependencies[strategy] ?? []) addColumn(name);
  };
  const visitFilter = (expression: FilterExpression | null): void => {
    if (!expression) return;
    if (expression.kind === "condition") {
      if (expression.target.kind !== "field") return;
      const definition = analyticsFilterDefinition(expression.target.field);
      addStrategyColumns(definition?.compilerStrategy);
      return;
    }
    if (expression.kind === "not") {
      visitFilter(expression.child);
      return;
    }
    for (const child of expression.children) visitFilter(child);
  };
  visitFilter(selection.filter.root);
  return [...required]
    .filter((name) => Object.hasOwn(schema.visits.columns, name))
    .sort();
}

function selectColumns(
  source: { readonly columns: Readonly<Record<string, AnyExpression>> },
  names: readonly string[],
): Record<string, AnyExpression> {
  return Object.fromEntries(names.map((name) => [name, column(source, name)]));
}

const LEGACY_EVENT_COLUMNS = [
  "event_pk",
  "event_id",
  "site_id",
  "site_pk",
  "visit_id",
  "event_name_id",
  "occurred_at",
  "received_at",
  "sequence",
  "node_count",
  "value_count",
  "ae_synced_at",
] as const;

function filterValues(
  visitColumns: Readonly<
    Partial<Record<AnalyticsLegacyVisitColumnName, AnyExpression>>
  >,
  eventName?: AnyExpression,
): Readonly<Partial<Record<AnalyticsLegacyFilterField, AnyExpression>>> {
  const values: Partial<Record<AnalyticsLegacyFilterField, AnyExpression>> = {};
  for (const field of analyticsFilterRegistry.values()) {
    const strategy = field.compilerStrategy;
    if (strategy.startsWith("column.")) {
      const expression =
        visitColumns[
          strategy.slice("column.".length) as AnalyticsLegacyVisitColumnName
        ];
      if (expression) values[field.id] = expression;
    } else if (strategy === "event.name" && eventName) {
      values[field.id] = eventName;
    }
  }
  return values;
}

function buildSites(siteIds: readonly string[]): AnalyticsDbRelation {
  const source = scan(schema.site_identities);
  const selected = filter(source, inList(source.columns.site_id, siteIds));
  return project(selected, {
    site_pk: selected.columns.site_pk,
    site_id: selected.columns.site_id,
  });
}

function buildPages(
  sites: AnalyticsDbRelation,
  selection: SemanticScopedSourceSelection,
): AnalyticsLegacyPageRow {
  const source = scan(schema.visits);
  const visitColumns = selectColumns(
    source,
    requiredLegacyVisitColumnNames(selection),
  );
  const visits = project(source, visitColumns);
  const scoped: AnalyticsDbRelation = join(
    visits,
    sites,
    eq(visits.columns.site_pk, sites.columns.site_pk),
  );
  const range = selection.time.candidate;
  const ranged = filter(
    scoped,
    and(
      gte(
        integer(column(scoped, "left_started_at")),
        param(Number(range.startMs)),
      ),
      lt(
        integer(column(scoped, "left_started_at")),
        param(Number(range.endExclusiveMs)),
      ),
    ),
  );
  const projections: Record<string, AnyExpression> = {
    site_pk: column(ranged, "left_site_pk"),
    raw_site_id: column(ranged, "left_site_id"),
    visit_id: column(ranged, "left_visit_id"),
  };
  for (const name of Object.keys(visitColumns))
    projections[`visit_${name}`] = column(ranged, `left_${name}`);
  const relation: AnalyticsDbRelation = project(ranged, projections);
  const columns = Object.fromEntries(
    Object.keys(visitColumns).map((name) => [
      name,
      column(relation, `visit_${name}`),
    ]),
  ) as Partial<Record<AnalyticsLegacyVisitColumnName, AnyExpression>>;
  const pathname = columns.pathname;
  const sessionId = columns.session_id;
  const visitorId = columns.visitor_id;
  const startedAt = columns.started_at;
  const durationMs = columns.duration_ms;
  if (!pathname || !sessionId || !visitorId || !startedAt || !durationMs)
    throw new Error("legacy_scoped_page_projection_incomplete");
  return {
    relation,
    sitePk: relation.columns.site_pk as AnalyticsLegacyNumber,
    rawSiteId: relation.columns.raw_site_id as AnalyticsLegacyText,
    visitId: relation.columns.visit_id as AnalyticsLegacyNullableText,
    sessionId: sessionId as AnalyticsLegacyText,
    visitorId: visitorId as AnalyticsLegacyText,
    startedAt: startedAt as AnalyticsLegacyNumber,
    pathname: pathname as AnalyticsLegacyText,
    durationMs: durationMs as AnalyticsLegacyNullableNumber,
    visitColumns: columns,
    filterValues: filterValues(columns),
  };
}

function buildEventNames(sites: AnalyticsDbRelation): AnalyticsDbRelation {
  const source = scan(schema.custom_event_names);
  const names = project(source, {
    id: source.columns.id,
    site_pk: source.columns.site_pk,
    name: source.columns.name,
  });
  const scoped: AnalyticsDbRelation = join(
    names,
    sites,
    eq(names.columns.site_pk, sites.columns.site_pk),
  );
  return project(scoped, {
    site_pk: scoped.columns.left_site_pk,
    id: scoped.columns.left_id,
    name: scoped.columns.left_name,
  });
}

function buildEvents(
  sites: AnalyticsDbRelation,
  subjectEventNames: AnalyticsDbRelation,
  selection: SemanticScopedSourceSelection,
): AnalyticsLegacyEventRow {
  const source = scan(schema.custom_events);
  const eventColumnSource = Object.fromEntries(
    LEGACY_EVENT_COLUMNS.map((name) => [name, column(source, name)]),
  );
  const eventSource = project(source, eventColumnSource);
  const scoped = join(
    eventSource,
    sites,
    eq(eventSource.columns.site_pk, sites.columns.site_pk),
  );
  let authorized: AnalyticsDbRelation = project(scoped, {
    site_pk: column(scoped, "left_site_pk"),
    ...Object.fromEntries(
      Object.keys(eventColumnSource).map((name) => [
        `event_${name}`,
        column(scoped, `left_${name}`),
      ]),
    ),
  });
  const nameGate = selection.eventNameGate;
  if (
    nameGate &&
    (selection.profile === "direct-event-records-v1" ||
      selection.profile === "direct-event-analytics-v1") &&
    selection.subject.siteIds.length === 1
  ) {
    const matchingNames = filter(
      subjectEventNames,
      nameGate.semantics === "prepared-trimmed-label-v1"
        ? eq(
            trimSpaces(
              coalesce(
                subjectEventNames.columns.name as SqlExpression<
                  string | null,
                  ExpressionResultType<"text", boolean>
                >,
                param(""),
              ),
            ),
            param(nameGate.value),
          )
        : eq(
            subjectEventNames.columns.name as SqlExpression<
              string,
              ExpressionResultType<"text", false>
            >,
            param(nameGate.value),
          ),
    );
    if (selection.profile === "direct-event-records-v1") {
      const matchingNameId = scalar(
        project(matchingNames, { value: matchingNames.columns.id! }),
      );
      authorized = filter(
        authorized,
        eq(authorized.columns.event_event_name_id!, matchingNameId),
      );
    } else {
      const matchingNameIds = distinct(
        project(matchingNames, { id: matchingNames.columns.id! }),
      );
      const matchedEvents = join(
        matchingNameIds,
        authorized,
        eq(
          matchingNameIds.columns.id!,
          authorized.columns.event_event_name_id!,
        ),
      );
      authorized = project(matchedEvents, {
        site_pk: matchedEvents.columns.right_site_pk!,
        ...Object.fromEntries(
          Object.keys(eventColumnSource).map((name) => [
            `event_${name}`,
            matchedEvents.columns[`right_event_${name}`]!,
          ]),
        ),
      });
    }
  }
  const range = selection.time.candidate;
  const ranged = filter(
    authorized,
    and(
      gte(
        integer(column(authorized, "event_occurred_at")),
        param(Number(range.startMs)),
      ),
      lt(
        integer(column(authorized, "event_occurred_at")),
        param(Number(range.endExclusiveMs)),
      ),
    ),
  );

  // The legacy report uses an ID-only name join and a same-site owner visit
  // inner join. Keep both associations in this Source even when only a few
  // filter fields are projected downstream.
  const nameSource = scan(schema.custom_event_names);
  const names = project(nameSource, {
    id: nameSource.columns.id,
    name: nameSource.columns.name,
  });
  const named: AnalyticsDbRelation = join(
    ranged,
    names,
    eq(
      column(ranged, "event_event_name_id") as AnyExpression,
      names.columns.id as AnyExpression,
    ),
  );
  const eventValues: Record<string, AnyExpression> = {
    site_pk: column(named, "left_site_pk"),
    ...Object.fromEntries(
      Object.keys(eventColumnSource).map((name) => [
        `event_${name}`,
        column(named, `left_event_${name}`),
      ]),
    ),
    event_name: column(named, "right_name"),
  };
  const namedEvents: AnalyticsDbRelation = project(named, eventValues);

  const ownersSource = scan(schema.visits);
  const ownerValues = selectColumns(
    ownersSource,
    requiredLegacyVisitColumnNames(selection),
  );
  const owners: AnalyticsDbRelation = project(ownersSource, {
    site_pk: ownersSource.columns.site_pk,
    visit_id: ownersSource.columns.visit_id,
    ...Object.fromEntries(
      Object.keys(ownerValues).map((name) => [name, ownerValues[name]!]),
    ),
  });
  const owned: AnalyticsDbRelation = join(
    namedEvents,
    owners,
    and(
      eq(column(namedEvents, "site_pk"), column(owners, "site_pk")),
      eq(column(namedEvents, "event_visit_id"), column(owners, "visit_id")),
    ),
  );

  const projections: Record<string, AnyExpression> = {
    site_pk: column(owned, "left_site_pk"),
    raw_site_id: column(owned, "left_event_site_id"),
    event_pk: column(owned, "left_event_event_pk"),
    event_id: column(owned, "left_event_event_id"),
    name_id: column(owned, "left_event_event_name_id"),
    visit_id: column(owned, "left_event_visit_id"),
    session_id: column(owned, "right_session_id"),
    visitor_id: column(owned, "right_visitor_id"),
    occurred_at: column(owned, "left_event_occurred_at"),
    event_name: column(owned, "left_event_name"),
  };
  for (const name of Object.keys(eventColumnSource))
    projections[`event_${name}`] = column(owned, `left_event_${name}`);
  for (const name of Object.keys(ownerValues))
    projections[`owner_${name}`] = column(owned, `right_${name}`);
  const relation: AnalyticsDbRelation = project(owned, projections);

  const eventColumns = Object.fromEntries(
    Object.keys(eventColumnSource).map((name) => [
      name,
      column(relation, `event_${name}`),
    ]),
  ) as Partial<Record<AnalyticsLegacyEventColumnName, AnyExpression>>;
  const ownerVisitColumns = Object.fromEntries(
    Object.keys(ownerValues).map((name) => [
      name,
      column(relation, `owner_${name}`),
    ]),
  ) as Partial<Record<AnalyticsLegacyVisitColumnName, AnyExpression>>;
  const eventName = relation.columns.event_name;
  return {
    relation,
    sitePk: relation.columns.site_pk as AnalyticsLegacyNumber,
    rawSiteId: relation.columns.raw_site_id as AnalyticsLegacyText,
    eventPk: relation.columns.event_pk as AnalyticsLegacyNumber,
    eventId: relation.columns.event_id as AnalyticsLegacyText,
    nameId: relation.columns.name_id as AnalyticsLegacyNumber,
    visitId: relation.columns.visit_id as AnalyticsLegacyNullableText,
    sessionId: relation.columns.session_id as AnalyticsLegacyText,
    visitorId: relation.columns.visitor_id as AnalyticsLegacyText,
    occurredAt: relation.columns.occurred_at as AnalyticsLegacyNumber,
    eventName: eventName as AnalyticsLegacyText,
    eventColumns,
    ownerVisitColumns,
    filterValues: filterValues(ownerVisitColumns, eventName),
  };
}

/** Build the authorized, half-open candidate Page/Event row bags for one Source. */
export function buildLegacyScopedDataset(input: {
  readonly selection: SemanticScopedSourceSelection;
  readonly storage: AnalyticsRelationalStorageContext;
}): AnalyticsLegacyScopedDataset {
  const siteIds = normalizeAnalyticsRelationalSiteIds(input.storage);
  if (
    siteIds.length !== input.selection.subject.siteIds.length ||
    siteIds.some(
      (siteId, index) => siteId !== input.selection.subject.siteIds[index],
    )
  )
    throw new Error("legacy_scoped_storage_sites_must_match_semantic_subject");
  const sites = buildSites(siteIds);
  const subjectEventNames = buildEventNames(sites);
  const pages = buildPages(sites, input.selection);
  const events = buildEvents(sites, subjectEventNames, input.selection);
  return {
    sites,
    subjectEventNames,
    readPages: pages,
    candidatePages: pages,
    readEvents: events,
    storage: input.storage,
  };
}
