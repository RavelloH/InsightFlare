import {
  aggregate,
  and,
  caseWhen,
  castInteger,
  count,
  countDistinct,
  eq,
  filter,
  isNotNull,
  neq,
  param,
  project,
  union,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  SqlExpression,
} from "@/lib/db/query/expression";
import type { Relation } from "@/lib/db/query/plan";
import { semanticAttribute } from "@/lib/edge/analytics/engine/semantic/attributes";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

type AnalyticsDbRelation = Relation<
  object,
  Readonly<Record<string, AnyExpression>>
>;

function column(relation: AnalyticsDbRelation, name: string): AnyExpression {
  const expression = relation.columns[name];
  if (!expression)
    throw new Error(
      `Missing D1 scope-fact projection ${JSON.stringify(name)}.`,
    );
  return expression;
}

function textColumn(
  relation: AnalyticsDbRelation,
  name: string,
): SqlExpression<string | null, ExpressionResultType<"text", boolean>> {
  return column(relation, name) as SqlExpression<
    string | null,
    ExpressionResultType<"text", boolean>
  >;
}

function integerColumn(
  relation: AnalyticsDbRelation,
  name: string,
): SqlExpression<number | null, ExpressionResultType<"integer", boolean>> {
  return column(relation, name) as SqlExpression<
    number | null,
    ExpressionResultType<"integer", boolean>
  >;
}

export type AnalyticsScopeFactEntity = "session" | "visitor";
export type AnalyticsScopeFactId =
  | "session.views"
  | "session.events"
  | "session.bounce"
  | "visitor.sessions"
  | "visitor.views"
  | "visitor.events";

export interface AnalyticsScopeFactContract {
  readonly id: AnalyticsScopeFactId;
  readonly entity: AnalyticsScopeFactEntity;
  readonly evaluation: "session-fact" | "visitor-fact";
  readonly valueKind: "number" | "boolean";
  readonly compilerStrategy: string;
  readonly valueColumn: string;
  readonly countColumn?: string;
}

const SCOPE_FACT_CONTRACTS: Readonly<
  Record<AnalyticsScopeFactId, AnalyticsScopeFactContract>
> = Object.freeze({
  "session.views": Object.freeze({
    id: "session.views",
    entity: "session",
    evaluation: "session-fact",
    valueKind: "number",
    compilerStrategy: "fact.session_views",
    valueColumn: "session_views",
  }),
  "session.events": Object.freeze({
    id: "session.events",
    entity: "session",
    evaluation: "session-fact",
    valueKind: "number",
    compilerStrategy: "fact.session_events",
    valueColumn: "session_events",
  }),
  "session.bounce": Object.freeze({
    id: "session.bounce",
    entity: "session",
    evaluation: "session-fact",
    valueKind: "boolean",
    compilerStrategy: "fact.session_bounce",
    valueColumn: "session_bounce",
    countColumn: "__bounce_page_count",
  }),
  "visitor.sessions": Object.freeze({
    id: "visitor.sessions",
    entity: "visitor",
    evaluation: "visitor-fact",
    valueKind: "number",
    compilerStrategy: "fact.visitor_sessions",
    valueColumn: "visitor_sessions",
  }),
  "visitor.views": Object.freeze({
    id: "visitor.views",
    entity: "visitor",
    evaluation: "visitor-fact",
    valueKind: "number",
    compilerStrategy: "fact.visitor_views",
    valueColumn: "visitor_views",
  }),
  "visitor.events": Object.freeze({
    id: "visitor.events",
    entity: "visitor",
    evaluation: "visitor-fact",
    valueKind: "number",
    compilerStrategy: "fact.visitor_events",
    valueColumn: "visitor_events",
  }),
});

const SCOPE_FACT_IDS = new Set<string>(Object.keys(SCOPE_FACT_CONTRACTS));

export function isAnalyticsScopeFactId(
  value: string,
): value is AnalyticsScopeFactId {
  return SCOPE_FACT_IDS.has(value);
}

/** Validate the complete registry/catalog contract before compiling a fact. */
export function analyticsScopeFactContract(
  id: string,
  entity: AnalyticsScopeFactEntity,
  path: string,
): AnalyticsScopeFactContract {
  if (!isAnalyticsScopeFactId(id))
    throw new Error(
      `${path}.values: ${id} is not a supported canonical Session/Visitor fact.`,
    );
  const contract = SCOPE_FACT_CONTRACTS[id];
  const field = analyticsFilterRegistry.get(id);
  const attribute = semanticAttribute(id);
  if (
    !field ||
    !attribute ||
    contract.entity !== entity ||
    field.id !== contract.id ||
    field.valueKind !== contract.valueKind ||
    field.profile !== "trimmed-text" ||
    field.source !== entity ||
    field.conditionEntity !== undefined ||
    field.observationKinds.size !== 0 ||
    field.presence !== "non-null-column" ||
    field.empty !== "unsupported" ||
    field.comparison !== "case-sensitive" ||
    field.operators.has("between") !== (contract.valueKind === "number") ||
    field.evaluation !== contract.evaluation ||
    field.nativeEntity !== entity ||
    field.nullable ||
    field.unit !== undefined ||
    (contract.valueKind === "number"
      ? field.number?.min !== 0 ||
        field.number.step !== 1 ||
        field.number.max !== undefined
      : field.number !== undefined) ||
    field.compilerStrategy !== contract.compilerStrategy ||
    attribute.id !== contract.id ||
    attribute.nativeEntity !== entity ||
    attribute.evaluation !== contract.evaluation ||
    attribute.valueType.kind !== "scalar" ||
    attribute.valueType.scalar !== contract.valueKind ||
    attribute.valueType.unit !== undefined ||
    attribute.nullable ||
    attribute.presence !== "non-null" ||
    attribute.empty !== "unsupported" ||
    attribute.comparison !== "case-sensitive" ||
    attribute.observationKinds.length !== 0
  )
    throw new Error(
      `${path}.values: ${id} no longer matches the canonical D1 scope-fact contract.`,
    );
  return contract;
}

export interface AnalyticsScopeFactActivityRows {
  readonly pages: AnalyticsDbRelation;
  readonly events: AnalyticsDbRelation;
}

export interface AnalyticsScopeFactRelation {
  readonly relation: AnalyticsDbRelation;
  readonly values: ReadonlyMap<AnalyticsScopeFactId, AnyExpression>;
}

/**
 * Build one canonical per-site Session or Visitor fact grain from eligible
 * Page/Event activity bags. Input carriers own authorization, time, and Event
 * owner/dictionary eligibility; this helper only groups raw identities.
 */
export function buildAnalyticsScopeFactRelation(input: {
  readonly entity: AnalyticsScopeFactEntity;
  readonly facts: readonly AnalyticsScopeFactContract[];
  readonly activity: AnalyticsScopeFactActivityRows;
}): AnalyticsScopeFactRelation {
  const identityColumn =
    input.entity === "session" ? "session_id" : "visitor_id";
  const pageActivities = project(input.activity.pages, {
    site_pk: input.activity.pages.columns.site_pk,
    session_id: input.activity.pages.columns.session_id,
    visitor_id: input.activity.pages.columns.visitor_id,
    kind: param("page"),
  });
  const eventActivities = project(input.activity.events, {
    site_pk: input.activity.events.columns.site_pk,
    session_id: input.activity.events.columns.owner_session_id,
    visitor_id: input.activity.events.columns.owner_visitor_id,
    kind: param("event"),
  });
  const activities = union(pageActivities, eventActivities, true);
  const eligible = filter(
    activities,
    and(
      isNotNull(textColumn(activities, identityColumn)),
      neq(textColumn(activities, identityColumn), param("")),
    ),
  );
  const groupBy = {
    site_pk: column(eligible, "site_pk"),
    entity_id: column(eligible, identityColumn),
  };
  const aggregates: Record<string, AnyExpression> = {};
  for (const fact of input.facts) {
    switch (fact.id) {
      case "session.views":
      case "visitor.views":
        aggregates[fact.valueColumn] = count(
          caseWhen(
            [
              {
                when: eq(textColumn(eligible, "kind"), param("page")),
                then: param(1),
              },
            ],
            param(null),
          ),
        );
        break;
      case "session.events":
      case "visitor.events":
        aggregates[fact.valueColumn] = count(
          caseWhen(
            [
              {
                when: eq(textColumn(eligible, "kind"), param("event")),
                then: param(1),
              },
            ],
            param(null),
          ),
        );
        break;
      case "session.bounce":
        aggregates[fact.countColumn!] = count(
          caseWhen(
            [
              {
                when: eq(textColumn(eligible, "kind"), param("page")),
                then: param(1),
              },
            ],
            param(null),
          ),
        );
        break;
      case "visitor.sessions":
        aggregates[fact.valueColumn] = countDistinct(
          caseWhen(
            [
              {
                when: and(
                  isNotNull(textColumn(eligible, "session_id")),
                  neq(textColumn(eligible, "session_id"), param("")),
                ),
                then: textColumn(eligible, "session_id"),
              },
            ],
            param(null),
          ),
        );
        break;
    }
  }
  const grouped = aggregate(eligible, { groupBy, aggregates });
  const projections: Record<string, AnyExpression> = {
    site_pk: grouped.columns.site_pk,
    entity_id: grouped.columns.entity_id,
  };
  const values = new Map<AnalyticsScopeFactId, AnyExpression>();
  for (const fact of input.facts) {
    if (fact.id === "session.bounce") {
      const bounce = castInteger(
        caseWhen(
          [
            {
              when: eq(integerColumn(grouped, fact.countColumn!), param(1)),
              then: param(1),
            },
          ],
          param(0),
        ),
      );
      projections[fact.valueColumn] = bounce;
      continue;
    }
    projections[fact.valueColumn] = grouped.columns[fact.valueColumn]!;
  }
  const relation = project(grouped, projections);
  for (const fact of input.facts) {
    values.set(fact.id, column(relation, fact.valueColumn));
  }
  return { relation, values };
}
