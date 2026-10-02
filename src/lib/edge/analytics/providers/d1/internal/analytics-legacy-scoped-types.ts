import type {
  AnyExpression,
  ExpressionResultType,
  Predicate,
  SqlExpression,
} from "@/lib/db/query/expression";
import type { schema } from "@/lib/db/schema/generated";
import type { SemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import type { RegisteredFilterField } from "@/lib/filter-contract/filter-registry";
import type { FilterCondition } from "@/lib/filter-contract/filters";

import type {
  AnalyticsDbRelation,
  AnalyticsRelationalStorageContext,
} from "./analytics-relational-storage";

export type AnalyticsLegacyVisitColumnName = Extract<
  keyof typeof schema.visits.columns,
  string
>;

export type AnalyticsLegacyEventColumnName = Extract<
  keyof typeof schema.custom_events.columns,
  string
>;

export type AnalyticsLegacyFilterField = RegisteredFilterField["id"];

export type AnalyticsLegacyText = SqlExpression<
  string,
  ExpressionResultType<"text", false>
>;

export type AnalyticsLegacyNullableText = SqlExpression<
  string | null,
  ExpressionResultType<"text", true>
>;

export type AnalyticsLegacyNumber = SqlExpression<
  number,
  ExpressionResultType<"integer" | "real" | "numeric", false>
>;

export type AnalyticsLegacyNullableNumber = SqlExpression<
  number | null,
  ExpressionResultType<"integer" | "real" | "numeric", true>
>;

export interface AnalyticsLegacyPageRow {
  readonly relation: AnalyticsDbRelation;
  readonly sitePk: AnalyticsLegacyNumber;
  /** Persisted visits.site_id; deliberately distinct from sitePk identity. */
  readonly rawSiteId: AnalyticsLegacyText;
  /** SQLite visits.visit_id is nullable and remains nullable here. */
  readonly visitId: AnalyticsLegacyNullableText;
  readonly sessionId: AnalyticsLegacyText;
  readonly visitorId: AnalyticsLegacyText;
  readonly startedAt: AnalyticsLegacyNumber;
  readonly pathname: AnalyticsLegacyText;
  readonly durationMs: AnalyticsLegacyNullableNumber;
  readonly visitColumns: Readonly<
    Partial<Record<AnalyticsLegacyVisitColumnName, AnyExpression>>
  >;
  readonly filterValues: Readonly<
    Partial<Record<AnalyticsLegacyFilterField, AnyExpression>>
  >;
}

export interface AnalyticsLegacyEventRow {
  readonly relation: AnalyticsDbRelation;
  readonly sitePk: AnalyticsLegacyNumber;
  /** Persisted custom_events.site_id; never canonicalized to the request site. */
  readonly rawSiteId: AnalyticsLegacyText;
  readonly eventPk: AnalyticsLegacyNumber;
  readonly eventId: AnalyticsLegacyText;
  readonly nameId: AnalyticsLegacyNumber;
  readonly visitId: AnalyticsLegacyNullableText;
  readonly sessionId: AnalyticsLegacyText;
  readonly visitorId: AnalyticsLegacyText;
  readonly occurredAt: AnalyticsLegacyNumber;
  readonly eventName: AnalyticsLegacyText;
  readonly eventColumns: Readonly<
    Partial<Record<AnalyticsLegacyEventColumnName, AnyExpression>>
  >;
  readonly ownerVisitColumns: Readonly<
    Partial<Record<AnalyticsLegacyVisitColumnName, AnyExpression>>
  >;
  readonly filterValues: Readonly<
    Partial<Record<AnalyticsLegacyFilterField, AnyExpression>>
  >;
}

/**
 * Inputs shared by the relational-predicate/fact helpers and the scoped
 * dataset builder. The page relations are row bags; identity results are
 * separate, site-qualified relations and never replace these bags.
 */
export interface AnalyticsLegacyScopedPredicateContext {
  readonly selection: SemanticScopedSourceSelection;
  readonly storage: AnalyticsRelationalStorageContext;
  readonly readPages: AnalyticsLegacyPageRow;
  readonly candidatePages: AnalyticsLegacyPageRow;
  readonly readEvents: AnalyticsLegacyEventRow;
}

export interface AnalyticsLegacyFactRelation {
  readonly relation: AnalyticsDbRelation;
  readonly sitePk: AnalyticsLegacyNumber;
  readonly rawSiteId: AnalyticsLegacyText;
  readonly entityId: AnalyticsLegacyText;
  readonly values: Readonly<Record<string, AnyExpression>>;
}

export interface AnalyticsLegacyRelationalPredicateInput {
  readonly condition: FilterCondition;
  readonly context: AnalyticsLegacyScopedPredicateContext;
  readonly source: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow;
}

export type AnalyticsLegacyRelationalPredicateBuilder = (
  input: AnalyticsLegacyRelationalPredicateInput,
) => Predicate;
