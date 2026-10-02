import {
  aggregate,
  and,
  caseWhen,
  castInteger,
  coalesce,
  constant,
  count,
  countDistinct,
  eq,
  filter,
  join,
  neq,
  project,
  sum,
  trimSpaces,
  union,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  SqlExpression,
} from "@/lib/db/query/expression";
import { analyticsFilterDefinition } from "@/lib/filter-contract/filter-registry";

import type {
  AnalyticsLegacyFactRelation,
  AnalyticsLegacyPageRow,
  AnalyticsLegacyScopedPredicateContext,
} from "./analytics-legacy-scoped-types";
import type { AnalyticsDbRelation } from "./analytics-relational-storage";

type EntityKind = "session" | "visitor";

interface LegacyFactSpec {
  readonly strategy: string;
  readonly fieldId: string;
  readonly entity: EntityKind;
  readonly valueColumn: string;
}

const LEGACY_FACTS: Readonly<Record<string, LegacyFactSpec>> = Object.freeze({
  "fact.session_duration_ms": Object.freeze({
    strategy: "fact.session_duration_ms",
    fieldId: "session.durationMs",
    entity: "session",
    valueColumn: "session_duration_ms",
  }),
  "fact.session_views": Object.freeze({
    strategy: "fact.session_views",
    fieldId: "session.views",
    entity: "session",
    valueColumn: "session_views",
  }),
  "fact.session_events": Object.freeze({
    strategy: "fact.session_events",
    fieldId: "session.events",
    entity: "session",
    valueColumn: "session_events",
  }),
  "fact.session_bounce": Object.freeze({
    strategy: "fact.session_bounce",
    fieldId: "session.bounce",
    entity: "session",
    valueColumn: "session_bounce",
  }),
  "fact.visitor_sessions": Object.freeze({
    strategy: "fact.visitor_sessions",
    fieldId: "visitor.sessions",
    entity: "visitor",
    valueColumn: "visitor_sessions",
  }),
  "fact.visitor_views": Object.freeze({
    strategy: "fact.visitor_views",
    fieldId: "visitor.views",
    entity: "visitor",
    valueColumn: "visitor_views",
  }),
  "fact.visitor_events": Object.freeze({
    strategy: "fact.visitor_events",
    fieldId: "visitor.events",
    entity: "visitor",
    valueColumn: "visitor_events",
  }),
});

function column(relation: AnalyticsDbRelation, name: string): AnyExpression {
  const expression = relation.columns[name];
  if (!expression)
    throw new Error(
      `Missing legacy scope-fact projection ${JSON.stringify(name)}.`,
    );
  return expression;
}

function nullableText(expression: AnyExpression): SqlExpression<string | null> {
  if (expression.resultType.affinity !== "text")
    throw new TypeError(
      "Legacy scope-fact identities must have text affinity.",
    );
  return expression as SqlExpression<string | null>;
}

function nonBlank(expression: AnyExpression) {
  const text = nullableText(expression);
  return neq(trimSpaces(coalesce(text, constant(""))), constant(""));
}

function identityPageRows(
  row: AnalyticsLegacyPageRow,
  entityKind: EntityKind,
): AnalyticsDbRelation {
  const entityId = entityKind === "session" ? row.sessionId : row.visitorId;
  const projected = project(row.relation, {
    site_pk: row.sitePk,
    raw_site_id: row.rawSiteId,
    entity_id: entityId,
    session_id: row.sessionId,
    duration_ms: row.durationMs,
  });
  return filter(projected, nonBlank(projected.columns.entity_id));
}

function identityEventRows(
  row: AnalyticsLegacyScopedPredicateContext["readEvents"],
  entityKind: EntityKind,
): AnalyticsDbRelation {
  const entityId = entityKind === "session" ? row.sessionId : row.visitorId;
  const projected = project(row.relation, {
    site_pk: row.sitePk,
    raw_site_id: row.rawSiteId,
    entity_id: entityId,
    session_id: row.sessionId,
  });
  return filter(projected, nonBlank(projected.columns.entity_id));
}

function factSpec(strategy: string, entityKind: EntityKind): LegacyFactSpec {
  const spec = LEGACY_FACTS[strategy];
  if (!spec || spec.entity !== entityKind)
    throw new TypeError(
      `Legacy ${entityKind} scope facts do not support ${strategy}.`,
    );
  const field = analyticsFilterDefinition(spec.fieldId);
  if (
    !field ||
    field.compilerStrategy !== spec.strategy ||
    field.nativeEntity !== spec.entity ||
    field.source !== spec.entity ||
    field.evaluation !== `${spec.entity}-fact`
  )
    throw new Error(
      `The registered contract for ${spec.fieldId} no longer matches ${spec.strategy}.`,
    );
  return spec;
}

function joinFactRelation(
  current: AnalyticsDbRelation,
  factRows: AnalyticsDbRelation,
  factColumns: ReadonlyMap<
    string,
    { readonly source: string; readonly output: string }
  >,
  carriedColumns: readonly string[],
): {
  readonly relation: AnalyticsDbRelation;
  readonly carried: readonly string[];
} {
  const joined = join(
    current,
    factRows,
    and(
      eq(column(current, "site_pk"), column(factRows, "site_pk")),
      eq(column(current, "raw_site_id"), column(factRows, "raw_site_id")),
      eq(column(current, "entity_id"), column(factRows, "entity_id")),
    ),
    "left",
  );
  const projection: Record<string, AnyExpression> = {
    site_pk: column(joined, "left_site_pk"),
    raw_site_id: column(joined, "left_raw_site_id"),
    entity_id: column(joined, "left_entity_id"),
  };
  for (const name of carriedColumns)
    projection[name] = column(joined, `left_${name}`);
  const nextCarried = [...carriedColumns];
  for (const mapping of factColumns.values()) {
    projection[mapping.output] = coalesce(
      column(joined, `right_${mapping.source}`) as SqlExpression<number | null>,
      constant(0),
    );
    if (!nextCarried.includes(mapping.output)) nextCarried.push(mapping.output);
  }
  return { relation: project(joined, projection), carried: nextCarried };
}

/**
 * Build legacy Session/Visitor facts from the eligible raw Page/Event bags.
 * Fact groups deliberately include persisted raw site_id alongside site_pk
 * and the raw entity ID; membership remains the caller's distinct two-key
 * site_pk/entity_id contract.
 */
export function buildLegacyScopeFactRelation(input: {
  readonly context: AnalyticsLegacyScopedPredicateContext;
  readonly entityKind: EntityKind;
  readonly requiredFacts: readonly string[];
}): AnalyticsLegacyFactRelation {
  const requested = [...new Set(input.requiredFacts)].map((strategy) =>
    factSpec(strategy, input.entityKind),
  );
  const strategies = new Set(requested.map((fact) => fact.strategy));
  const pages = identityPageRows(input.context.readPages, input.entityKind);
  const events = identityEventRows(input.context.readEvents, input.entityKind);

  const pageIdentityRows = project(pages, {
    site_pk: pages.columns.site_pk,
    raw_site_id: pages.columns.raw_site_id,
    entity_id: pages.columns.entity_id,
  });
  const eventIdentityRows = project(events, {
    site_pk: events.columns.site_pk,
    raw_site_id: events.columns.raw_site_id,
    entity_id: events.columns.entity_id,
  });
  let relation: AnalyticsDbRelation = union(
    pageIdentityRows,
    eventIdentityRows,
  );
  const carried: string[] = [];

  const requiresPageAggregate =
    (input.entityKind === "session" &&
      (strategies.has("fact.session_duration_ms") ||
        strategies.has("fact.session_views") ||
        strategies.has("fact.session_bounce"))) ||
    (input.entityKind === "visitor" && strategies.has("fact.visitor_views"));
  if (requiresPageAggregate) {
    const aggregates: Record<string, AnyExpression> = {};
    const mappings = new Map<
      string,
      { readonly source: string; readonly output: string }
    >();
    if (input.entityKind === "session") {
      if (strategies.has("fact.session_duration_ms")) {
        aggregates.__duration_sum = sum(
          coalesce(
            pages.columns.duration_ms as SqlExpression<number | null>,
            constant(0),
          ),
        );
        mappings.set("fact.session_duration_ms", {
          source: "__duration_sum",
          output: "session_duration_ms",
        });
      }
      if (
        strategies.has("fact.session_views") ||
        strategies.has("fact.session_bounce")
      ) {
        aggregates.__page_count = count();
        if (strategies.has("fact.session_views"))
          mappings.set("fact.session_views", {
            source: "__page_count",
            output: "session_views",
          });
      }
    } else if (strategies.has("fact.visitor_views")) {
      aggregates.__page_count = count();
      mappings.set("fact.visitor_views", {
        source: "__page_count",
        output: "visitor_views",
      });
    }
    if (strategies.has("fact.session_bounce"))
      mappings.set("fact.session_bounce", {
        source: "__page_count",
        output: "__page_count",
      });
    const pageFacts = aggregate(pages, {
      groupBy: {
        site_pk: pages.columns.site_pk,
        raw_site_id: pages.columns.raw_site_id,
        entity_id: pages.columns.entity_id,
      },
      aggregates,
    });
    const joined = joinFactRelation(relation, pageFacts, mappings, carried);
    relation = joined.relation;
    carried.splice(0, carried.length, ...joined.carried);
  }

  const eventFactStrategy =
    input.entityKind === "session"
      ? "fact.session_events"
      : "fact.visitor_events";
  if (strategies.has(eventFactStrategy)) {
    const eventFacts = aggregate(events, {
      groupBy: {
        site_pk: events.columns.site_pk,
        raw_site_id: events.columns.raw_site_id,
        entity_id: events.columns.entity_id,
      },
      aggregates: { __event_count: count() },
    });
    const joined = joinFactRelation(
      relation,
      eventFacts,
      new Map([
        [
          eventFactStrategy,
          {
            source: "__event_count",
            output:
              input.entityKind === "session"
                ? "session_events"
                : "visitor_events",
          },
        ],
      ]),
      carried,
    );
    relation = joined.relation;
    carried.splice(0, carried.length, ...joined.carried);
  }

  if (strategies.has("fact.visitor_sessions")) {
    const pageSessions = project(pages, {
      site_pk: pages.columns.site_pk,
      raw_site_id: pages.columns.raw_site_id,
      entity_id: pages.columns.entity_id,
      session_id: pages.columns.session_id,
    });
    const eventSessions = project(events, {
      site_pk: events.columns.site_pk,
      raw_site_id: events.columns.raw_site_id,
      entity_id: events.columns.entity_id,
      session_id: events.columns.session_id,
    });
    const sessionUnion = union(pageSessions, eventSessions);
    const sessionEvidence = filter(
      sessionUnion,
      nonBlank(column(sessionUnion, "session_id")),
    );
    const sessionFacts = aggregate(sessionEvidence, {
      groupBy: {
        site_pk: sessionEvidence.columns.site_pk,
        raw_site_id: sessionEvidence.columns.raw_site_id,
        entity_id: sessionEvidence.columns.entity_id,
      },
      aggregates: {
        __visitor_session_count: countDistinct(
          nullableText(sessionEvidence.columns.session_id),
        ),
      },
    });
    const joined = joinFactRelation(
      relation,
      sessionFacts,
      new Map([
        [
          "fact.visitor_sessions",
          {
            source: "__visitor_session_count",
            output: "visitor_sessions",
          },
        ],
      ]),
      carried,
    );
    relation = joined.relation;
    carried.splice(0, carried.length, ...joined.carried);
  }

  if (strategies.has("fact.session_bounce")) {
    const views = column(relation, "__page_count") as SqlExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
    relation = project(relation, {
      site_pk: relation.columns.site_pk,
      raw_site_id: relation.columns.raw_site_id,
      entity_id: relation.columns.entity_id,
      ...Object.fromEntries(
        carried
          .filter((name) => name !== "__page_count")
          .map((name) => [name, column(relation, name)]),
      ),
      session_bounce: castInteger(
        caseWhen(
          [{ when: eq(views, constant(1)), then: constant(1) }],
          constant(0),
        ),
      ),
    });
    carried.splice(
      0,
      carried.length,
      ...carried.filter((name) => name !== "__page_count"),
      "session_bounce",
    );
  }

  const finalProjection: Record<string, AnyExpression> = {
    site_pk: relation.columns.site_pk,
    raw_site_id: relation.columns.raw_site_id,
    entity_id: relation.columns.entity_id,
  };
  for (const fact of requested)
    finalProjection[fact.valueColumn] = column(relation, fact.valueColumn);
  const finalRelation = project(relation, finalProjection);
  const values: Record<string, AnyExpression> = {};
  for (const fact of requested)
    values[fact.strategy] = column(finalRelation, fact.valueColumn);

  return {
    relation: finalRelation,
    sitePk: finalRelation.columns
      .site_pk as AnalyticsLegacyFactRelation["sitePk"],
    rawSiteId: finalRelation.columns
      .raw_site_id as AnalyticsLegacyFactRelation["rawSiteId"],
    entityId: finalRelation.columns
      .entity_id as AnalyticsLegacyFactRelation["entityId"],
    values,
  };
}
