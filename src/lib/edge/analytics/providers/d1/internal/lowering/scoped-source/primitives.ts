import {
  and,
  coalesce,
  constant,
  distinct,
  eq,
  filter,
  isNotNull,
  join,
  neq,
  param,
  type Predicate,
  project,
  trimSpaces,
} from "@/lib/db";
import {
  type AnyExpression,
  type ExpressionResultType,
  type SqlExpression,
} from "@/lib/db/query/expression";
import {
  type AnalyticsLegacyEventRow,
  type AnalyticsLegacyPageRow,
  type AnalyticsLegacyText,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-types";
import { type AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

export type EntityKind = "session" | "visitor";

export type IdentityRelation = AnalyticsDbRelation;

export function relationColumn(
  relation: AnalyticsDbRelation,
  name: string,
): AnyExpression {
  const value = (relation.columns as Readonly<Record<string, AnyExpression>>)[
    name
  ];
  if (!value) throw new Error(`Missing scoped Page column ${name}.`);
  return value;
}

export function nonemptyIdentity(value: AnyExpression): Predicate {
  const text = value as SqlExpression<
    string | null,
    ExpressionResultType<"text", boolean>
  >;
  return and(isNotNull(text), neq(text, param("")));
}

export function nonBlank(value: AnyExpression): Predicate {
  const text = value as SqlExpression<
    string | null,
    ExpressionResultType<"text", boolean>
  >;
  return neq(trimSpaces(coalesce(text, constant(""))), constant(""));
}

export function matchingIdentity(
  left: { readonly columns: Readonly<Record<string, AnyExpression>> },
  right: { readonly columns: Readonly<Record<string, AnyExpression>> },
): Predicate {
  return and(
    eq(left.columns.site_pk!, right.columns.site_pk!),
    eq(left.columns.entity_id!, right.columns.entity_id!),
  );
}

/** Join a row bag to a unique membership set without multiplying source rows. */
export function joinMembership(
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

export function emptyIdentities(universe: IdentityRelation): IdentityRelation {
  return filter(universe, eq(constant(1), constant(0)));
}

export function eventIdentityRows(
  events: AnalyticsLegacyEventRow,
): IdentityRelation {
  return distinct(
    project(events.relation, {
      site_pk: events.relation.columns.site_pk!,
      event_id: events.relation.columns.event_id!,
    }),
  );
}

export function entityColumnName(
  row: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow,
  kind: EntityKind,
): string {
  if ("eventPk" in row) return kind === "session" ? "session_id" : "visitor_id";
  return kind === "session" ? "visit_session_id" : "visit_visitor_id";
}

export function entityId(
  row: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow,
  kind: EntityKind,
): AnalyticsLegacyText {
  return kind === "session" ? row.sessionId : row.visitorId;
}
