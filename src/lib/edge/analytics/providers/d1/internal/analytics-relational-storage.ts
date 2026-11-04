import {
  aggregate,
  and,
  antiJoin,
  callFunction,
  caseWhen,
  castInteger,
  castText,
  coalesce,
  constant,
  count,
  eq,
  filter,
  gte,
  inList,
  isNotNull,
  isNull,
  join,
  limit,
  lt,
  lte,
  min,
  neq,
  not,
  or,
  param,
  project,
  scalar,
  scan,
  semiJoin,
  sort,
  union,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  Predicate,
  SqlExpression,
} from "@/lib/db/query/expression";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
import { ADVANCED_FILTER_EXACT_AGGREGATE_VALUE_LIMIT } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import type { SlotId } from "@/lib/edge/analytics/engine/logical/ids";
import type {
  SourceNode,
  SourceValueBinding,
} from "@/lib/edge/analytics/engine/logical/nodes";
import {
  isSemanticEventReportAttribute,
  isSemanticPageReportAttribute,
  semanticAttribute,
  semanticEventReportAttributeCatalog,
  semanticObservationAttributeCatalog,
} from "@/lib/edge/analytics/engine/semantic/attributes";
import {
  advancedCountSelectorBooleanField,
  advancedCountSelectorExactAggregateField,
} from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import type { EventPayloadTopLevelPath } from "@/lib/edge/analytics/engine/semantic/event-payload-logical";
import type { SemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

import type { EventPayloadNodeField } from "./lowering/payload-layout";
import {
  type AnalyticsEventPayloadKeySourceBinding,
  type AnalyticsEventPayloadOccurrenceJoinIdentity,
  type AnalyticsProviderSourceBindingRequest,
  assertAnalyticsEventPayloadKeySchema,
} from "./analytics-event-identity-proof";
import {
  type NativePrimitiveFieldContract,
  nativePrimitiveFieldContract,
} from "./analytics-primitive-predicate-lowering";
import {
  type AnalyticsScopeFactContract,
  analyticsScopeFactContract,
  type AnalyticsScopeFactEntity,
  type AnalyticsScopeFactId,
  buildAnalyticsScopeFactRelation,
  isAnalyticsScopeFactId,
} from "./analytics-scope-fact-storage";
import { selectEventPayloadNodeFacts } from "./event-payload-node-selection";

export type AnalyticsDbRelation = Relation<
  object,
  Readonly<Record<string, AnyExpression>>
>;

export type AnalyticsSourceValue =
  | {
      readonly kind: "scalar";
      readonly value: AnyExpression;
      readonly candidateBounded: false;
    }
  | {
      readonly kind: "entity";
      readonly entity: "observation" | "page" | "event" | "session" | "visitor";
      readonly keys: readonly AnyExpression[];
      readonly present: Predicate;
      readonly nullable: boolean;
      readonly candidateBounded: boolean;
    };

export interface LoweredAnalyticsSource {
  readonly relation: AnalyticsDbRelation;
  readonly values: ReadonlyMap<SlotId, AnalyticsSourceValue>;
  readonly providerBindings: readonly AnalyticsEventPayloadKeySourceBinding[];
}

export type AnalyticsRelationalStorageContext =
  | {
      readonly siteId: string;
      readonly siteIds?: never;
      readonly time: SemanticTemporalDomains;
    }
  | {
      readonly siteId?: never;
      readonly siteIds: readonly string[];
      readonly time: SemanticTemporalDomains;
    };

export function normalizeAnalyticsRelationalSiteIds(
  context: AnalyticsRelationalStorageContext,
): readonly string[] {
  const hasSiteId = context.siteId !== undefined;
  const hasSiteIds = context.siteIds !== undefined;
  if (hasSiteId === hasSiteIds)
    throw new Error(
      "analytics_relational_site_context_requires_siteId_or_siteIds",
    );
  const siteIds = hasSiteIds ? context.siteIds : [context.siteId];
  if (
    !Array.isArray(siteIds) ||
    siteIds.length === 0 ||
    siteIds.some((siteId) => typeof siteId !== "string" || siteId.length === 0)
  )
    throw new Error("analytics_relational_site_context_requires_non_empty_ids");
  return [...new Set(siteIds)].sort();
}

type ObservationIdentityAttribute =
  "observation.sessionId" | "observation.visitorId";

function isObservationIdentityAttribute(
  value: string,
): value is ObservationIdentityAttribute {
  return value === "observation.sessionId" || value === "observation.visitorId";
}

const observationReportAttributeIds = new Set(
  semanticObservationAttributeCatalog.map((attribute) => attribute.id),
);

function isObservationReportAttribute(value: string): boolean {
  return observationReportAttributeIds.has(value);
}

const observationReportColumnByAttribute: Readonly<Record<string, string>> = {
  "observation.sessionId": "session_id",
  "observation.visitorId": "visitor_id",
  "observation.visitId": "visit_id",
  "observation.rawSiteId": "site_id",
  "observation.userId": "user_id",
  "observation.userName": "user_name",
  "observation.status": "status",
  "observation.ownerPageStartedAt": "started_at",
  "observation.startedAt": "started_at",
  "observation.lastActivityAt": "last_activity_at",
  "observation.endedAt": "ended_at",
  "observation.durationMs": "duration_ms",
  "observation.pathname": "pathname",
  "observation.hash": "hash_fragment",
  "observation.title": "title",
  "observation.hostname": "hostname",
  "observation.referrerHost": "referrer_host",
  "observation.referrerUrl": "referrer_url",
  "observation.country": "country",
  "observation.region": "region",
  "observation.regionCode": "region_code",
  "observation.city": "city",
  "observation.latitude": "latitude",
  "observation.longitude": "longitude",
  "observation.browser": "browser",
  "observation.browserVersion": "browser_version",
  "observation.os": "os",
  "observation.osVersion": "os_version",
  "observation.deviceType": "device_type",
  "observation.screenWidth": "screen_width",
  "observation.screenHeight": "screen_height",
  "observation.perfTtfbMs": "perf_ttfb_ms",
  "observation.perfFcpMs": "perf_fcp_ms",
  "observation.perfLcpMs": "perf_lcp_ms",
  "observation.perfCls": "perf_cls",
  "observation.perfInpMs": "perf_inp_ms",
};

const pageReportColumnByAttribute: Readonly<Record<string, string>> = {
  "page.report.rawSiteId": "site_id",
  "page.report.localId": "visit_id",
  "page.report.sessionId": "session_id",
  "page.report.visitorId": "visitor_id",
  "page.report.userId": "user_id",
  "page.report.userName": "user_name",
  "page.report.status": "status",
  "page.report.startedAt": "started_at",
  "page.report.lastActivityAt": "last_activity_at",
  "page.report.endedAt": "ended_at",
  "page.report.finalizedAt": "finalized_at",
  "page.report.durationMs": "duration_ms",
  "page.report.durationSource": "duration_source",
  "page.report.exitReason": "exit_reason",
  "page.report.pathname": "pathname",
  "page.report.queryString": "query_string",
  "page.report.hash": "hash_fragment",
  "page.report.title": "title",
  "page.report.hostname": "hostname",
  "page.report.referrerUrl": "referrer_url",
  "page.report.referrerHost": "referrer_host",
  "page.report.utmSource": "utm_source",
  "page.report.utmMedium": "utm_medium",
  "page.report.utmCampaign": "utm_campaign",
  "page.report.utmTerm": "utm_term",
  "page.report.utmContent": "utm_content",
  "page.report.isEU": "is_eu",
  "page.report.country": "country",
  "page.report.region": "region",
  "page.report.regionCode": "region_code",
  "page.report.city": "city",
  "page.report.continent": "continent",
  "page.report.latitude": "latitude",
  "page.report.longitude": "longitude",
  "page.report.postalCode": "postal_code",
  "page.report.metroCode": "metro_code",
  "page.report.timezone": "timezone",
  "page.report.organization": "as_organization",
  "page.report.browser": "browser",
  "page.report.browserVersion": "browser_version",
  "page.report.os": "os",
  "page.report.osVersion": "os_version",
  "page.report.deviceType": "device_type",
  "page.report.userAgent": "ua_raw",
  "page.report.language": "language",
  "page.report.screenWidth": "screen_width",
  "page.report.screenHeight": "screen_height",
  "page.report.perfTtfbMs": "perf_ttfb_ms",
  "page.report.perfFcpMs": "perf_fcp_ms",
  "page.report.perfLcpMs": "perf_lcp_ms",
  "page.report.perfCls": "perf_cls",
  "page.report.perfInpMs": "perf_inp_ms",
};

/** Returns the generated visits column behind a stored Page report attribute. */
export function analyticsPageReportStorageColumn(
  attributeId: string,
): string | undefined {
  return pageReportColumnByAttribute[attributeId];
}

function observationReportColumn(attributeId: string): string | undefined {
  const direct = observationReportColumnByAttribute[attributeId];
  if (direct) return direct;
  const prefix = "observation.contextPage";
  if (!attributeId.startsWith(prefix)) return undefined;
  const suffix = attributeId.slice(prefix.length);
  if (!suffix) return undefined;
  const pageAttributeId = `page.report.${suffix[0]!.toLowerCase()}${suffix.slice(1)}`;
  return pageReportColumnByAttribute[pageAttributeId];
}

function observationReportSourceColumn(
  attributeId: string,
): string | undefined {
  const direct = observationReportColumn(attributeId);
  if (direct) return direct;
  const selectorField = advancedCountSelectorBooleanField(attributeId);
  return selectorField?.collection === "page"
    ? observationReportColumn(selectorField.valueAttribute)
    : undefined;
}

function countSelectorBooleanValue(
  field: NonNullable<ReturnType<typeof advancedCountSelectorBooleanField>>,
  attributeId: string,
  rawValue: AnyExpression,
): AnyExpression {
  if (field.kind === "string")
    return eq(
      callFunction("storage-class", rawValue as SqlExpression),
      param("text"),
    );
  const storageClass = callFunction("storage-class", rawValue as SqlExpression);
  // The count guard proves this raw value is numeric before a matcher runs.
  // This narrows only the TypeScript comparison contract; SQL keeps the raw
  // column and does not CAST legacy TEXT or BLOB values.
  const numericRawValue = rawValue as SqlExpression<
    number,
    ExpressionResultType<"numeric", boolean>
  >;
  if (advancedCountSelectorExactAggregateField(attributeId)) {
    const integerValue = castInteger(
      numericRawValue,
    ) as unknown as SqlExpression<
      number,
      ExpressionResultType<"numeric", boolean>
    >;
    return coalesce(
      and(
        or(eq(storageClass, param("integer")), eq(storageClass, param("real"))),
        eq(numericRawValue, integerValue),
        gte(
          numericRawValue,
          param(-ADVANCED_FILTER_EXACT_AGGREGATE_VALUE_LIMIT),
        ),
        lte(
          numericRawValue,
          param(ADVANCED_FILTER_EXACT_AGGREGATE_VALUE_LIMIT),
        ),
      ),
      constant(0),
    );
  }
  return coalesce(
    and(
      or(eq(storageClass, param("integer")), eq(storageClass, param("real"))),
      gte(numericRawValue, param(-Number.MAX_SAFE_INTEGER)),
      lte(numericRawValue, param(Number.MAX_SAFE_INTEGER)),
    ),
    constant(0),
  );
}

function requirePageReportValue(
  expression: AnyExpression,
  attributeId: string,
  path: string,
): void {
  const attribute = semanticAttribute(attributeId);
  if (
    !attribute ||
    !isSemanticPageReportAttribute(attributeId) ||
    attribute.nativeEntity !== "page" ||
    attribute.valueType.kind !== "scalar"
  )
    throw new Error(
      `${path}.values: ${attributeId} is not an internal Page report attribute.`,
    );
  const scalar = attribute.valueType.scalar;
  const affinityMatches =
    scalar === "string"
      ? expression.resultType.affinity === "text"
      : scalar === "datetime" || scalar === "date"
        ? expression.resultType.affinity === "integer"
        : scalar === "number"
          ? expression.resultType.affinity === "integer" ||
            expression.resultType.affinity === "real"
          : false;
  if (
    !affinityMatches ||
    (expression.resultType.nullable && !attribute.nullable)
  )
    throw new Error(
      `${path}.values: ${attributeId} no longer matches its registered D1 scalar contract.`,
    );
}

function observationReportOutputColumn(attributeId: string): string {
  const suffix = attributeId.slice("observation.".length);
  return `report_${suffix}`;
}

function requireObservationReportValue(
  expression: AnyExpression,
  attributeId: string,
  path: string,
): void {
  const attribute = semanticAttribute(attributeId);
  if (
    !attribute ||
    !observationReportAttributeIds.has(attributeId) ||
    attribute.nativeEntity !== "observation" ||
    attribute.valueType.kind !== "scalar"
  )
    throw new Error(
      `${path}.values: ${attributeId} is not a report Observation attribute.`,
    );
  const scalar = attribute.valueType.scalar;
  const affinityMatches =
    scalar === "string"
      ? expression.resultType.affinity === "text"
      : scalar === "datetime" || scalar === "date"
        ? expression.resultType.affinity === "integer"
        : scalar === "number"
          ? expression.resultType.affinity === "integer" ||
            expression.resultType.affinity === "real"
          : scalar === "boolean"
            ? expression.resultType.affinity === "integer"
            : false;
  if (!affinityMatches)
    throw new Error(
      `${path}.values: ${attributeId} no longer maps to a compatible D1 scalar affinity.`,
    );
  if (expression.resultType.nullable && !attribute.nullable)
    throw new Error(
      `${path}.values: ${attributeId} can be NULL but its report metadata is non-nullable.`,
    );
}

const eventReportAttributeIds = new Set(
  semanticEventReportAttributeCatalog.map((attribute) => attribute.id),
);

function requireEventReportValue(
  expression: AnyExpression,
  attributeId: string,
  path: string,
): void {
  const attribute = semanticAttribute(attributeId);
  if (
    !attribute ||
    !eventReportAttributeIds.has(attributeId) ||
    attribute.nativeEntity !== "event" ||
    attribute.valueType.kind !== "scalar"
  )
    throw new Error(
      `${path}.values: ${attributeId} is not an internal Event report attribute.`,
    );
  const scalar = attribute.valueType.scalar;
  const affinityMatches =
    scalar === "string"
      ? expression.resultType.affinity === "text"
      : scalar === "datetime" || scalar === "date"
        ? expression.resultType.affinity === "integer"
        : scalar === "number"
          ? expression.resultType.affinity === "integer" ||
            expression.resultType.affinity === "real"
          : scalar === "boolean"
            ? expression.resultType.affinity === "integer"
            : false;
  if (
    !affinityMatches ||
    (expression.resultType.nullable && !attribute.nullable)
  )
    throw new Error(
      `${path}.values: ${attributeId} no longer maps to its registered D1 scalar contract.`,
    );
}

const eventReportColumnByAttribute: Readonly<Record<string, string>> = {
  "event.report.localId": "event_id",
  "event.report.internalPk": "event_pk",
  "event.report.ownerVisitId": "visit_id",
  "event.report.nameId": "event_name_id",
  "event.report.occurredAt": "occurred_at",
  "event.report.receivedAt": "received_at",
  "event.report.sequence": "sequence",
  "event.report.nodeCount": "node_count",
  "event.report.valueCount": "value_count",
  "event.report.userId": "user_id",
};

function column(relation: AnalyticsDbRelation, name: string): AnyExpression {
  const expression = relation.columns[name];
  if (!expression)
    throw new Error(`Missing D1 storage projection ${JSON.stringify(name)}.`);
  return expression;
}

function requireStorageTextColumn(
  expression: AnyExpression,
  fieldId: string,
): SqlExpression<string, ExpressionResultType<"text", false>> {
  if (
    expression.resultType.affinity !== "text" ||
    expression.resultType.nullable
  ) {
    throw new Error(
      `Registered field ${fieldId} no longer maps to a non-null D1 TEXT column.`,
    );
  }
  return expression as SqlExpression<
    string,
    ExpressionResultType<"text", false>
  >;
}

function requireNativePrimitiveStorageColumn(
  expression: AnyExpression,
  contract: NativePrimitiveFieldContract,
  path: string,
): void {
  if (
    expression.resultType.affinity !== "text" ||
    expression.resultType.nullable !== contract.storageNullable
  ) {
    throw new Error(
      `${path}.values: Registered field ${contract.id} no longer maps to a D1 TEXT column with the declared storage nullability.`,
    );
  }
}

function eqAny(left: AnyExpression, right: AnyExpression): Predicate {
  const unknown = (value: AnyExpression) =>
    value as SqlExpression<unknown, ExpressionResultType<"unknown", boolean>>;
  return eq(unknown(left), unknown(right));
}

function isNullAny(value: AnyExpression): Predicate {
  return isNull(value as SqlExpression);
}

/**
 * Assigns each property-statistics input exactly one storage role:
 * all roots, direct children of roots, or exact selected nodes outside those
 * sets. The selected input is the canonical same-Event node relation, so its
 * parent id classifies selected-other rows without repeating its enrichment.
 */
export function buildEventPayloadPropertyRoleRows(
  eventMetadata: AnalyticsDbRelation,
  selectedNodes: AnalyticsDbRelation,
): AnalyticsDbRelation {
  const rootNodes: AnalyticsDbRelation = scan(schema.custom_event_json_nodes);
  const eventRootsJoin: AnalyticsDbRelation = join(
    eventMetadata,
    rootNodes,
    and(
      eqAny(eventMetadata.columns.event_pk, rootNodes.columns.event_pk),
      isNullAny(rootNodes.columns.parent_node_id),
    ),
    "left",
  );
  const selectedNonRoots = filter(
    selectedNodes,
    isNotNull(selectedNodes.columns.parent_node_id as SqlExpression),
  );
  const eventRoots: AnalyticsDbRelation = project(eventRootsJoin, {
    event_pk: eventRootsJoin.columns.left_event_pk,
    site_id: eventRootsJoin.columns.left_site_id,
    site_pk: eventRootsJoin.columns.left_site_pk,
    event_name_id: eventRootsJoin.columns.left_event_name_id,
    occurred_at: eventRootsJoin.columns.left_occurred_at,
    root_node_id: eventRootsJoin.columns.right_node_id,
    root_parent_node_id: eventRootsJoin.columns.right_parent_node_id,
    root_key_id: eventRootsJoin.columns.right_key_id,
    root_path_id: eventRootsJoin.columns.right_path_id,
    root_node_type: eventRootsJoin.columns.right_value_type,
    root_array_index: eventRootsJoin.columns.right_array_index,
  });
  const rootPaths: AnalyticsDbRelation = scan(schema.custom_event_json_paths);
  const rootPathJoin: AnalyticsDbRelation = join(
    eventRoots,
    rootPaths,
    eqAny(eventRoots.columns.root_path_id, rootPaths.columns.id),
    "left",
  );
  const rootPathRows: AnalyticsDbRelation = project(rootPathJoin, {
    event_pk: rootPathJoin.columns.left_event_pk,
    site_id: rootPathJoin.columns.left_site_id,
    site_pk: rootPathJoin.columns.left_site_pk,
    event_name_id: rootPathJoin.columns.left_event_name_id,
    occurred_at: rootPathJoin.columns.left_occurred_at,
    node_id: rootPathJoin.columns.left_root_node_id,
    parent_node_id: rootPathJoin.columns.left_root_parent_node_id,
    key_id: rootPathJoin.columns.left_root_key_id,
    path_id: rootPathJoin.columns.left_root_path_id,
    node_type: rootPathJoin.columns.left_root_node_type,
    array_index: rootPathJoin.columns.left_root_array_index,
    path: rootPathJoin.columns.right_path,
    path_site_id: rootPathJoin.columns.right_site_id,
    path_site_pk: rootPathJoin.columns.right_site_pk,
  });
  const rootPathValid = and(
    eqAny(rootPathRows.columns.node_type, constant(4)),
    eqAny(rootPathRows.columns.path, constant("/")),
    eqAny(rootPathRows.columns.path_site_id, rootPathRows.columns.site_id),
    eqAny(rootPathRows.columns.path_site_pk, rootPathRows.columns.site_pk),
    isNullAny(rootPathRows.columns.key_id),
    isNullAny(rootPathRows.columns.array_index),
  );
  const rootRows: AnalyticsDbRelation = project(rootPathRows, {
    event_pk: rootPathRows.columns.event_pk,
    role_code: constant(0),
    node_id: rootPathRows.columns.node_id,
    parent_node_id: rootPathRows.columns.parent_node_id,
    node_type: castInteger(constant(null)),
    array_index: castInteger(constant(null)),
    key_id: castInteger(constant(null)),
    path_id: castInteger(constant(null)),
    event_site_id: rootPathRows.columns.site_id,
    event_site_pk: rootPathRows.columns.site_pk,
    event_name_id: rootPathRows.columns.event_name_id,
    occurred_at: rootPathRows.columns.occurred_at,
    root_valid: caseWhen(
      [{ when: rootPathValid, then: constant(1) }],
      constant(0),
    ),
  });
  const children: AnalyticsDbRelation = scan(schema.custom_event_json_nodes);
  const rootChildrenJoin: AnalyticsDbRelation = join(
    rootRows,
    children,
    and(
      eqAny(rootRows.columns.event_pk, children.columns.event_pk),
      eqAny(rootRows.columns.node_id, children.columns.parent_node_id),
    ),
  );
  const rootChildRows: AnalyticsDbRelation = project(rootChildrenJoin, {
    event_pk: rootChildrenJoin.columns.left_event_pk,
    role_code: constant(1),
    node_id: rootChildrenJoin.columns.right_node_id,
    parent_node_id: rootChildrenJoin.columns.right_parent_node_id,
    node_type: rootChildrenJoin.columns.right_value_type,
    array_index: rootChildrenJoin.columns.right_array_index,
    key_id: rootChildrenJoin.columns.right_key_id,
    path_id: rootChildrenJoin.columns.right_path_id,
    event_site_id: rootChildrenJoin.columns.left_event_site_id,
    event_site_pk: rootChildrenJoin.columns.left_event_site_pk,
    event_name_id: rootChildrenJoin.columns.left_event_name_id,
    occurred_at: rootChildrenJoin.columns.left_occurred_at,
    root_valid: rootChildrenJoin.columns.left_root_valid,
  });

  const selectedWithParent: AnalyticsDbRelation = selectedNonRoots;
  const selectedParentRoots = rootNodes;
  const selectedOther: AnalyticsDbRelation = antiJoin(
    selectedWithParent,
    selectedParentRoots,
    and(
      eqAny(
        selectedWithParent.columns.event_pk,
        selectedParentRoots.columns.event_pk,
      ),
      eqAny(
        selectedWithParent.columns.parent_node_id,
        selectedParentRoots.columns.node_id,
      ),
      isNullAny(selectedParentRoots.columns.parent_node_id),
    ),
  );
  const selectedOtherRows: AnalyticsDbRelation = project(selectedOther, {
    event_pk: selectedOther.columns.event_pk,
    role_code: constant(2),
    node_id: selectedOther.columns.node_id,
    parent_node_id: selectedOther.columns.parent_node_id,
    node_type: castInteger(constant(null)),
    array_index: castInteger(constant(null)),
    key_id: castInteger(constant(null)),
    path_id: castInteger(constant(null)),
    event_site_id: castText(castInteger(constant(null))),
    event_site_pk: castInteger(constant(null)),
    event_name_id: castInteger(constant(null)),
    occurred_at: castInteger(constant(null)),
    root_valid: constant(0),
  });

  return union(
    union(rootRows, rootChildRows, true),
    selectedOtherRows,
    true,
  ) as AnalyticsDbRelation;
}

/** D1-only physical carrier catalog for the currently proven Page/Event subset. */
export class AnalyticsRelationalStorage {
  readonly #siteIds: readonly string[];
  readonly #time: SemanticTemporalDomains;
  #sitesCache?: AnalyticsDbRelation;
  readonly #sitePageCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #pageCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #eventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #namedEventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #ownedEventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #namedOwnedEventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #eventReportCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #candidateObservationCarriers = new Map<
    string,
    AnalyticsDbRelation
  >();
  readonly #reportObservationCarriers = new Map<string, AnalyticsDbRelation>();

  constructor(context: AnalyticsRelationalStorageContext) {
    this.#siteIds = normalizeAnalyticsRelationalSiteIds(context);
    this.#time = context.time;
  }

  /** Selects exact path matches plus same-Event ancestors from a Logical Event input. */
  eventPayloadNodes(
    selectedEvents: AnalyticsDbRelation,
    eventKeyKeys: readonly AnyExpression[],
    eventPk: AnyExpression,
    propertiesMetadata: {
      readonly siteId: AnyExpression;
      readonly eventNameId: AnyExpression;
      readonly occurredAt: AnyExpression;
      readonly visitId: AnyExpression;
    },
    paths: readonly string[],
    requiredFields: readonly EventPayloadNodeField[],
  ): {
    readonly relation: AnalyticsDbRelation;
    readonly eventMetadata: AnalyticsDbRelation;
  } {
    const eventPkValue = eventPk as SqlExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
    const eventKeys = project(selectedEvents, {
      event_pk: eventPkValue,
      event_id: eventKeyKeys[1]!,
      event_site_id: propertiesMetadata.siteId,
      site_pk: eventKeyKeys[0]!,
      event_name_id: propertiesMetadata.eventNameId,
      occurred_at: propertiesMetadata.occurredAt,
      visit_id: propertiesMetadata.visitId,
      ...Object.fromEntries(
        eventKeyKeys.map((key, index) => [`event_key_${index}`, key]),
      ),
    });
    const eventMetadata = project(eventKeys, {
      event_pk: eventKeys.columns.event_pk,
      site_id: eventKeys.columns.event_site_id,
      site_pk: eventKeys.columns.site_pk,
      event_name_id: eventKeys.columns.event_name_id,
      occurred_at: eventKeys.columns.occurred_at,
    });
    const selectedNodeRows: AnalyticsDbRelation = selectEventPayloadNodeFacts(
      eventKeys,
      paths,
    );
    const eventNodes: AnalyticsDbRelation = join(
      eventKeys,
      selectedNodeRows,
      eq(eventKeys.columns.event_pk, selectedNodeRows.columns.event_pk),
    );
    const eventNodeRows: AnalyticsDbRelation = project(eventNodes, {
      event_pk: eventNodes.columns.left_event_pk,
      event_id: eventNodes.columns.left_event_id,
      event_site_id: eventNodes.columns.left_event_site_id,
      site_pk: eventNodes.columns.left_site_pk,
      event_name_id: eventNodes.columns.left_event_name_id,
      occurred_at: eventNodes.columns.left_occurred_at,
      visit_id: eventNodes.columns.left_visit_id,
      event_key_0: eventNodes.columns.left_event_key_0,
      ...Object.fromEntries(
        eventKeyKeys
          .slice(1)
          .map((_, index) => [
            `event_key_${index + 1}`,
            (eventNodes.columns as Readonly<Record<string, AnyExpression>>)[
              `left_event_key_${index + 1}`
            ]!,
          ]),
      ),
      node_id: eventNodes.columns.right_node_id,
      parent_node_id: eventNodes.columns.right_parent_node_id,
      key_id: eventNodes.columns.right_key_id,
      path_id: eventNodes.columns.right_path_id,
      value_type: eventNodes.columns.right_value_type,
      array_index: eventNodes.columns.right_array_index,
    });
    const pathsTable: AnalyticsDbRelation = scan(
      schema.custom_event_json_paths,
    );
    const withPaths: AnalyticsDbRelation = join(
      eventNodeRows,
      pathsTable,
      and(
        eq(eventNodeRows.columns.path_id, pathsTable.columns.id),
        eq(eventNodeRows.columns.site_pk, pathsTable.columns.site_pk),
        eq(eventNodeRows.columns.event_site_id, pathsTable.columns.site_id),
      ),
    );
    const eventNodePathRows: AnalyticsDbRelation = project(withPaths, {
      event_pk: withPaths.columns.left_event_pk,
      event_id: withPaths.columns.left_event_id,
      event_site_id: withPaths.columns.left_event_site_id,
      site_pk: withPaths.columns.left_site_pk,
      event_name_id: withPaths.columns.left_event_name_id,
      occurred_at: withPaths.columns.left_occurred_at,
      visit_id: withPaths.columns.left_visit_id,
      event_key_0: withPaths.columns.left_event_key_0,
      ...Object.fromEntries(
        eventKeyKeys
          .slice(1)
          .map((_, index) => [
            `event_key_${index + 1}`,
            (withPaths.columns as Readonly<Record<string, AnyExpression>>)[
              `left_event_key_${index + 1}`
            ]!,
          ]),
      ),
      node_id: withPaths.columns.left_node_id,
      parent_node_id: withPaths.columns.left_parent_node_id,
      key_id: withPaths.columns.left_key_id,
      path_id: withPaths.columns.left_path_id,
      path: withPaths.columns.right_path,
      path_site_id: withPaths.columns.right_site_id,
      path_site_pk: withPaths.columns.right_site_pk,
      array_index: withPaths.columns.left_array_index,
      value_type: withPaths.columns.left_value_type,
    });
    const keys: AnalyticsDbRelation = scan(schema.custom_event_json_keys);
    const withKeys: AnalyticsDbRelation = join(
      eventNodePathRows,
      keys,
      and(
        eq(eventNodePathRows.columns.key_id, keys.columns.id),
        eq(eventNodePathRows.columns.site_pk, keys.columns.site_pk),
        eq(eventNodePathRows.columns.event_site_id, keys.columns.site_id),
      ),
      "left",
    );
    const eventNodeKeyRows: AnalyticsDbRelation = project(withKeys, {
      event_pk: withKeys.columns.left_event_pk,
      event_id: withKeys.columns.left_event_id,
      event_site_id: withKeys.columns.left_event_site_id,
      site_pk: withKeys.columns.left_site_pk,
      event_name_id: withKeys.columns.left_event_name_id,
      occurred_at: withKeys.columns.left_occurred_at,
      visit_id: withKeys.columns.left_visit_id,
      event_key_0: withKeys.columns.left_event_key_0,
      ...Object.fromEntries(
        eventKeyKeys
          .slice(1)
          .map((_, index) => [
            `event_key_${index + 1}`,
            (withKeys.columns as Readonly<Record<string, AnyExpression>>)[
              `left_event_key_${index + 1}`
            ]!,
          ]),
      ),
      node_id: withKeys.columns.left_node_id,
      parent_node_id: withKeys.columns.left_parent_node_id,
      key: withKeys.columns.right_key,
      key_site_id: withKeys.columns.right_site_id,
      key_site_pk: withKeys.columns.right_site_pk,
      path_id: withKeys.columns.left_path_id,
      path: withKeys.columns.left_path,
      path_site_id: withKeys.columns.left_path_site_id,
      path_site_pk: withKeys.columns.left_path_site_pk,
      array_index: withKeys.columns.left_array_index,
      value_type: withKeys.columns.left_value_type,
    });
    const structuralFields = new Set<EventPayloadNodeField>([
      "eventKey",
      "eventPk",
      "nodeId",
      "parentNodeId",
      "key",
      "path",
    ]);
    if (
      requiredFields.length > 0 &&
      requiredFields.every((field) => structuralFields.has(field))
    ) {
      const visits: AnalyticsDbRelation = scan(schema.visits);
      const withOwner: AnalyticsDbRelation = join(
        eventNodeKeyRows,
        visits,
        and(
          eq(eventNodeKeyRows.columns.site_pk, visits.columns.site_pk),
          eq(eventNodeKeyRows.columns.visit_id, visits.columns.visit_id),
        ),
      );
      const output: Record<string, AnyExpression> = {};
      if (requiredFields.includes("eventPk"))
        output.eventPk = withOwner.columns.left_event_pk;
      if (requiredFields.includes("nodeId"))
        output.nodeId = withOwner.columns.left_node_id;
      if (requiredFields.includes("parentNodeId"))
        output.parentNodeId = withOwner.columns.left_parent_node_id;
      if (requiredFields.includes("key"))
        output.key = withOwner.columns.left_key;
      if (requiredFields.includes("path"))
        output.path = withOwner.columns.left_path;
      eventKeyKeys.forEach((_, index) => {
        if (requiredFields.includes("eventKey"))
          output[`eventKey${index}`] = (
            withOwner.columns as Readonly<Record<string, AnyExpression>>
          )[`left_event_key_${index}`]!;
      });
      return {
        relation: project(withOwner, output),
        eventMetadata,
      };
    }
    const values: AnalyticsDbRelation = scan(schema.custom_event_json_values);
    const withValues: AnalyticsDbRelation = join(
      eventNodeKeyRows,
      values,
      and(
        eq(eventNodeKeyRows.columns.event_pk, values.columns.event_pk),
        eq(eventNodeKeyRows.columns.node_id, values.columns.node_id),
      ),
      "left",
    );
    const valueRows: AnalyticsDbRelation = project(withValues, {
      event_pk: withValues.columns.left_event_pk,
      event_id: withValues.columns.left_event_id,
      event_site_id: withValues.columns.left_event_site_id,
      site_pk: withValues.columns.left_site_pk,
      event_name_id: withValues.columns.left_event_name_id,
      occurred_at: withValues.columns.left_occurred_at,
      visit_id: withValues.columns.left_visit_id,
      event_key_0: withValues.columns.left_event_key_0,
      ...Object.fromEntries(
        eventKeyKeys
          .slice(1)
          .map((_, index) => [
            `event_key_${index + 1}`,
            (withValues.columns as Readonly<Record<string, AnyExpression>>)[
              `left_event_key_${index + 1}`
            ]!,
          ]),
      ),
      node_id: withValues.columns.left_node_id,
      parent_node_id: withValues.columns.left_parent_node_id,
      key: withValues.columns.left_key,
      key_site_id: withValues.columns.left_key_site_id,
      key_site_pk: withValues.columns.left_key_site_pk,
      path_id: withValues.columns.left_path_id,
      path: withValues.columns.left_path,
      path_site_id: withValues.columns.left_path_site_id,
      path_site_pk: withValues.columns.left_path_site_pk,
      array_index: withValues.columns.left_array_index,
      value_type: withValues.columns.left_value_type,
      value_node_id: withValues.columns.right_node_id,
      value_type_row: withValues.columns.right_value_type,
      value_site_id: withValues.columns.right_site_id,
      value_site_pk: withValues.columns.right_site_pk,
      value_name_id: withValues.columns.right_event_name_id,
      value_path_id: withValues.columns.right_path_id,
      value_occurred_at: withValues.columns.right_occurred_at,
      string_value: withValues.columns.right_string_value,
      number_value: withValues.columns.right_number_value,
      boolean_value: withValues.columns.right_boolean_value,
    });
    const stringClass = callFunction(
      "storage-class",
      valueRows.columns.string_value as SqlExpression,
    );
    const numberClass = callFunction(
      "storage-class",
      valueRows.columns.number_value as SqlExpression,
    );
    const booleanClass = callFunction(
      "storage-class",
      valueRows.columns.boolean_value as SqlExpression,
    );
    const finiteNumber = and(
      gte(
        valueRows.columns.number_value as SqlExpression<
          number | null,
          ExpressionResultType<"numeric", boolean>
        >,
        param(-Number.MAX_VALUE),
      ),
      lte(
        valueRows.columns.number_value as SqlExpression<
          number | null,
          ExpressionResultType<"numeric", boolean>
        >,
        param(Number.MAX_VALUE),
      ),
    );
    const rawShapeValid = or(
      and(
        eqAny(valueRows.columns.value_type, constant(0)),
        isNullAny(valueRows.columns.string_value),
        isNullAny(valueRows.columns.number_value),
        isNullAny(valueRows.columns.boolean_value),
      ),
      and(
        eqAny(valueRows.columns.value_type, constant(1)),
        eqAny(stringClass, constant("text")),
        isNullAny(valueRows.columns.number_value),
        isNullAny(valueRows.columns.boolean_value),
      ),
      and(
        eqAny(valueRows.columns.value_type, constant(2)),
        inList(numberClass, ["integer", "real"]),
        finiteNumber,
        isNullAny(valueRows.columns.string_value),
        isNullAny(valueRows.columns.boolean_value),
      ),
      and(
        eqAny(valueRows.columns.value_type, constant(3)),
        eqAny(booleanClass, constant("integer")),
        inList(
          valueRows.columns.boolean_value as SqlExpression<number | null>,
          [0, 1],
        ),
        isNullAny(valueRows.columns.string_value),
        isNullAny(valueRows.columns.number_value),
      ),
    );
    const valueIdentityValid = and(
      isNotNull(valueRows.columns.value_node_id as SqlExpression),
      eqAny(valueRows.columns.value_type_row, valueRows.columns.value_type),
      eqAny(valueRows.columns.value_site_id, valueRows.columns.event_site_id),
      eqAny(valueRows.columns.value_site_pk, valueRows.columns.site_pk),
      eqAny(valueRows.columns.value_name_id, valueRows.columns.event_name_id),
      eqAny(valueRows.columns.value_path_id, valueRows.columns.path_id),
      eqAny(valueRows.columns.value_occurred_at, valueRows.columns.occurred_at),
    );
    const containerValueCompatible = and(
      or(
        eqAny(valueRows.columns.value_type, constant(4)),
        eqAny(valueRows.columns.value_type, constant(5)),
      ),
      isNullAny(valueRows.columns.value_node_id),
    );
    const scalarValueCompatible = and(
      or(
        eqAny(valueRows.columns.value_type, constant(0)),
        eqAny(valueRows.columns.value_type, constant(1)),
        eqAny(valueRows.columns.value_type, constant(2)),
        eqAny(valueRows.columns.value_type, constant(3)),
      ),
      valueIdentityValid,
      rawShapeValid,
    );
    const valueCompatible = coalesce(
      or(containerValueCompatible, scalarValueCompatible),
      constant(0),
    );
    const compatibleValueRows: AnalyticsDbRelation = project(valueRows, {
      event_pk: valueRows.columns.event_pk,
      site_pk: valueRows.columns.site_pk,
      visit_id: valueRows.columns.visit_id,
      ...Object.fromEntries(
        eventKeyKeys.map((_, index) => [
          `event_key_${index}`,
          (valueRows.columns as Readonly<Record<string, AnyExpression>>)[
            `event_key_${index}`
          ]!,
        ]),
      ),
      node_id: valueRows.columns.node_id,
      parent_node_id: valueRows.columns.parent_node_id,
      key: valueRows.columns.key,
      path: valueRows.columns.path,
      value_type: valueRows.columns.value_type,
      array_index: valueRows.columns.array_index,
      string_value: valueRows.columns.string_value,
      number_value: valueRows.columns.number_value,
      boolean_value: valueRows.columns.boolean_value,
      value_compatible: valueCompatible,
    });
    const visits: AnalyticsDbRelation = scan(schema.visits);
    const withOwner: AnalyticsDbRelation = join(
      compatibleValueRows,
      visits,
      and(
        eq(compatibleValueRows.columns.site_pk, visits.columns.site_pk),
        eq(compatibleValueRows.columns.visit_id, visits.columns.visit_id),
      ),
    );
    const output: Record<string, AnyExpression> = {
      eventPk: withOwner.columns.left_event_pk,
      nodeId: withOwner.columns.left_node_id,
      parentNodeId: withOwner.columns.left_parent_node_id,
      key: withOwner.columns.left_key,
      path: withOwner.columns.left_path,
      valueType: withOwner.columns.left_value_type,
      arrayIndex: withOwner.columns.left_array_index,
      stringValue: withOwner.columns.left_string_value,
      numberValue: withOwner.columns.left_number_value,
      booleanValue: withOwner.columns.left_boolean_value,
      valueCompatible: withOwner.columns.left_value_compatible,
    };
    eventKeyKeys.forEach((_, index) => {
      output[`eventKey${index}`] = (
        withOwner.columns as Readonly<Record<string, AnyExpression>>
      )[`left_event_key_${index}`]!;
    });
    return {
      relation: project(withOwner, output),
      eventMetadata,
    };
  }

  /** Produces one per-Event typed top-level property row with explicit proof controls. */
  eventPayloadProperties(
    eventMetadata: AnalyticsDbRelation,
    selectedNodeRelation: AnalyticsDbRelation,
    selectedNodeValues: {
      readonly eventPk: AnyExpression;
      readonly nodeId: AnyExpression;
      readonly parentNodeId: AnyExpression;
      readonly key: AnyExpression;
      readonly path: AnyExpression;
    },
    paths: readonly EventPayloadTopLevelPath[],
  ): AnalyticsDbRelation {
    const selectedTargetInput: AnalyticsDbRelation = project(
      selectedNodeRelation,
      {
        event_pk: selectedNodeValues.eventPk as SqlExpression<
          number,
          ExpressionResultType<"integer", false>
        >,
        node_id: selectedNodeValues.nodeId,
        parent_node_id: selectedNodeValues.parentNodeId,
        key: selectedNodeValues.key as SqlExpression<
          string | null,
          ExpressionResultType<"text", boolean>
        >,
        path: selectedNodeValues.path as SqlExpression<
          string | null,
          ExpressionResultType<"text", boolean>
        >,
      },
    );
    const roleRows = buildEventPayloadPropertyRoleRows(
      eventMetadata,
      selectedTargetInput,
    );

    // This is the one exact selected-node membership lookup for all three roles.
    const selectedMembershipJoin: AnalyticsDbRelation = join(
      roleRows,
      selectedTargetInput,
      and(
        eqAny(roleRows.columns.event_pk, selectedTargetInput.columns.event_pk),
        eqAny(roleRows.columns.node_id, selectedTargetInput.columns.node_id),
      ),
      "left",
    );
    const selectedRoleRows: AnalyticsDbRelation = project(
      selectedMembershipJoin,
      {
        event_pk: selectedMembershipJoin.columns.left_event_pk,
        role_code: selectedMembershipJoin.columns.left_role_code,
        node_id: selectedMembershipJoin.columns.left_node_id,
        node_type: selectedMembershipJoin.columns.left_node_type,
        array_index: selectedMembershipJoin.columns.left_array_index,
        key_id: selectedMembershipJoin.columns.left_key_id,
        path_id: selectedMembershipJoin.columns.left_path_id,
        event_site_id: selectedMembershipJoin.columns.left_event_site_id,
        event_site_pk: selectedMembershipJoin.columns.left_event_site_pk,
        event_name_id: selectedMembershipJoin.columns.left_event_name_id,
        occurred_at: selectedMembershipJoin.columns.left_occurred_at,
        root_valid: selectedMembershipJoin.columns.left_root_valid,
        selected_node_id: selectedMembershipJoin.columns.right_node_id,
        selected_key: selectedMembershipJoin.columns.right_key,
        selected_path: selectedMembershipJoin.columns.right_path,
      },
    );

    const keyTable: AnalyticsDbRelation = scan(schema.custom_event_json_keys);
    const roleKeyJoin: AnalyticsDbRelation = join(
      selectedRoleRows,
      keyTable,
      eqAny(selectedRoleRows.columns.key_id, keyTable.columns.id),
      "left",
    );
    const keyedRoleRows: AnalyticsDbRelation = project(roleKeyJoin, {
      event_pk: roleKeyJoin.columns.left_event_pk,
      role_code: roleKeyJoin.columns.left_role_code,
      node_id: roleKeyJoin.columns.left_node_id,
      node_type: roleKeyJoin.columns.left_node_type,
      array_index: roleKeyJoin.columns.left_array_index,
      key: roleKeyJoin.columns.right_key,
      key_site_id: roleKeyJoin.columns.right_site_id,
      key_site_pk: roleKeyJoin.columns.right_site_pk,
      path_id: roleKeyJoin.columns.left_path_id,
      event_site_id: roleKeyJoin.columns.left_event_site_id,
      event_site_pk: roleKeyJoin.columns.left_event_site_pk,
      event_name_id: roleKeyJoin.columns.left_event_name_id,
      occurred_at: roleKeyJoin.columns.left_occurred_at,
      root_valid: roleKeyJoin.columns.left_root_valid,
      selected_node_id: roleKeyJoin.columns.left_selected_node_id,
      selected_key: roleKeyJoin.columns.left_selected_key,
      selected_path: roleKeyJoin.columns.left_selected_path,
    });
    const pathTable: AnalyticsDbRelation = scan(schema.custom_event_json_paths);
    const rolePathJoin: AnalyticsDbRelation = join(
      keyedRoleRows,
      pathTable,
      eqAny(keyedRoleRows.columns.path_id, pathTable.columns.id),
      "left",
    );
    const enrichedRoleRows: AnalyticsDbRelation = project(rolePathJoin, {
      event_pk: rolePathJoin.columns.left_event_pk,
      role_code: rolePathJoin.columns.left_role_code,
      node_id: rolePathJoin.columns.left_node_id,
      node_type: rolePathJoin.columns.left_node_type,
      array_index: rolePathJoin.columns.left_array_index,
      key: rolePathJoin.columns.left_key,
      key_site_id: rolePathJoin.columns.left_key_site_id,
      key_site_pk: rolePathJoin.columns.left_key_site_pk,
      path_id: rolePathJoin.columns.left_path_id,
      path: rolePathJoin.columns.right_path,
      path_site_id: rolePathJoin.columns.right_site_id,
      path_site_pk: rolePathJoin.columns.right_site_pk,
      event_site_id: rolePathJoin.columns.left_event_site_id,
      event_site_pk: rolePathJoin.columns.left_event_site_pk,
      event_name_id: rolePathJoin.columns.left_event_name_id,
      occurred_at: rolePathJoin.columns.left_occurred_at,
      root_valid: rolePathJoin.columns.left_root_valid,
      selected_node_id: rolePathJoin.columns.left_selected_node_id,
      selected_key: rolePathJoin.columns.left_selected_key,
      selected_path: rolePathJoin.columns.left_selected_path,
    });

    const candidateRelevantForJoin = or(
      inList(
        enrichedRoleRows.columns.key as SqlExpression<
          string | null,
          ExpressionResultType<"text", boolean>
        >,
        paths.map(({ key }) => key),
      ),
      inList(
        enrichedRoleRows.columns.path as SqlExpression<
          string | null,
          ExpressionResultType<"text", boolean>
        >,
        paths.map(({ path }) => path),
      ),
    );
    const valueTable: AnalyticsDbRelation = scan(
      schema.custom_event_json_values,
    );
    const candidateValuesJoin: AnalyticsDbRelation = join(
      enrichedRoleRows,
      valueTable,
      and(
        eqAny(enrichedRoleRows.columns.event_pk, valueTable.columns.event_pk),
        eqAny(enrichedRoleRows.columns.node_id, valueTable.columns.node_id),
        eqAny(enrichedRoleRows.columns.role_code, constant(1)),
        eqAny(enrichedRoleRows.columns.root_valid, constant(1)),
        candidateRelevantForJoin,
      ),
      "left",
    );
    const candidateValueRows: AnalyticsDbRelation = project(
      candidateValuesJoin,
      {
        event_pk: candidateValuesJoin.columns.left_event_pk,
        role_code: candidateValuesJoin.columns.left_role_code,
        node_id: candidateValuesJoin.columns.left_node_id,
        node_type: candidateValuesJoin.columns.left_node_type,
        node_path_id: candidateValuesJoin.columns.left_path_id,
        key: candidateValuesJoin.columns.left_key,
        key_site_id: candidateValuesJoin.columns.left_key_site_id,
        key_site_pk: candidateValuesJoin.columns.left_key_site_pk,
        path: candidateValuesJoin.columns.left_path,
        path_site_id: candidateValuesJoin.columns.left_path_site_id,
        path_site_pk: candidateValuesJoin.columns.left_path_site_pk,
        event_site_id: candidateValuesJoin.columns.left_event_site_id,
        event_site_pk: candidateValuesJoin.columns.left_event_site_pk,
        event_name_id: candidateValuesJoin.columns.left_event_name_id,
        occurred_at: candidateValuesJoin.columns.left_occurred_at,
        array_index: candidateValuesJoin.columns.left_array_index,
        root_valid: candidateValuesJoin.columns.left_root_valid,
        selected_node_id: candidateValuesJoin.columns.left_selected_node_id,
        selected_key: candidateValuesJoin.columns.left_selected_key,
        selected_path: candidateValuesJoin.columns.left_selected_path,
        value_node_id: candidateValuesJoin.columns.right_node_id,
        value_type: candidateValuesJoin.columns.right_value_type,
        value_site_id: candidateValuesJoin.columns.right_site_id,
        value_site_pk: candidateValuesJoin.columns.right_site_pk,
        value_name_id: candidateValuesJoin.columns.right_event_name_id,
        value_path_id: candidateValuesJoin.columns.right_path_id,
        value_occurred_at: candidateValuesJoin.columns.right_occurred_at,
        string_value: candidateValuesJoin.columns.right_string_value,
        number_value: candidateValuesJoin.columns.right_number_value,
        boolean_value: candidateValuesJoin.columns.right_boolean_value,
      },
    );
    const stringClass = callFunction(
      "storage-class",
      candidateValueRows.columns.string_value as SqlExpression,
    );
    const numberClass = callFunction(
      "storage-class",
      candidateValueRows.columns.number_value as SqlExpression,
    );
    const booleanClass = callFunction(
      "storage-class",
      candidateValueRows.columns.boolean_value as SqlExpression,
    );
    const finiteNumber = and(
      gte(
        candidateValueRows.columns.number_value as SqlExpression<
          number | null,
          ExpressionResultType<"numeric", boolean>
        >,
        param(-Number.MAX_VALUE),
      ),
      lte(
        candidateValueRows.columns.number_value as SqlExpression<
          number | null,
          ExpressionResultType<"numeric", boolean>
        >,
        param(Number.MAX_VALUE),
      ),
    );
    const rawShapeValid = or(
      and(
        eqAny(candidateValueRows.columns.value_type, constant(0)),
        isNullAny(candidateValueRows.columns.string_value),
        isNullAny(candidateValueRows.columns.number_value),
        isNullAny(candidateValueRows.columns.boolean_value),
      ),
      and(
        eqAny(candidateValueRows.columns.value_type, constant(1)),
        eqAny(stringClass, constant("text")),
        isNullAny(candidateValueRows.columns.number_value),
        isNullAny(candidateValueRows.columns.boolean_value),
      ),
      and(
        eqAny(candidateValueRows.columns.value_type, constant(2)),
        inList(numberClass, ["integer", "real"]),
        finiteNumber,
        isNullAny(candidateValueRows.columns.string_value),
        isNullAny(candidateValueRows.columns.boolean_value),
      ),
      and(
        eqAny(candidateValueRows.columns.value_type, constant(3)),
        eqAny(booleanClass, constant("integer")),
        inList(
          candidateValueRows.columns.boolean_value as SqlExpression<
            number | null
          >,
          [0, 1],
        ),
        isNullAny(candidateValueRows.columns.string_value),
        isNullAny(candidateValueRows.columns.number_value),
      ),
    );
    const valueRowValid = and(
      isNotNull(candidateValueRows.columns.value_node_id as SqlExpression),
      eqAny(
        candidateValueRows.columns.value_type,
        candidateValueRows.columns.node_type,
      ),
      eqAny(
        candidateValueRows.columns.value_site_id,
        candidateValueRows.columns.event_site_id,
      ),
      eqAny(
        candidateValueRows.columns.value_site_pk,
        candidateValueRows.columns.event_site_pk,
      ),
      eqAny(
        candidateValueRows.columns.value_name_id,
        candidateValueRows.columns.event_name_id,
      ),
      eqAny(
        candidateValueRows.columns.value_path_id,
        candidateValueRows.columns.node_path_id,
      ),
      eqAny(
        candidateValueRows.columns.value_occurred_at,
        candidateValueRows.columns.occurred_at,
      ),
      rawShapeValid,
    );
    const valueShapeRows: AnalyticsDbRelation = project(candidateValueRows, {
      event_pk: candidateValueRows.columns.event_pk,
      role_code: candidateValueRows.columns.role_code,
      node_id: candidateValueRows.columns.node_id,
      node_type: candidateValueRows.columns.node_type,
      key: candidateValueRows.columns.key,
      path: candidateValueRows.columns.path,
      root_valid: candidateValueRows.columns.root_valid,
      selected_node_id: candidateValueRows.columns.selected_node_id,
      selected_key: candidateValueRows.columns.selected_key,
      selected_path: candidateValueRows.columns.selected_path,
      value_node_id: candidateValueRows.columns.value_node_id,
      string_value: candidateValueRows.columns.string_value,
      number_value: candidateValueRows.columns.number_value,
      boolean_value: candidateValueRows.columns.boolean_value,
      value_row_valid: valueRowValid,
      candidate_shape_valid: and(
        eqAny(
          candidateValueRows.columns.key_site_id,
          candidateValueRows.columns.event_site_id,
        ),
        eqAny(
          candidateValueRows.columns.key_site_pk,
          candidateValueRows.columns.event_site_pk,
        ),
        eqAny(
          candidateValueRows.columns.path_site_id,
          candidateValueRows.columns.event_site_id,
        ),
        eqAny(
          candidateValueRows.columns.path_site_pk,
          candidateValueRows.columns.event_site_pk,
        ),
        isNullAny(candidateValueRows.columns.array_index),
        gte(
          candidateValueRows.columns.node_type as SqlExpression<
            number | null,
            ExpressionResultType<"integer", boolean>
          >,
          constant(0),
        ),
        lte(
          candidateValueRows.columns.node_type as SqlExpression<
            number | null,
            ExpressionResultType<"integer", boolean>
          >,
          constant(5),
        ),
      ),
      candidate_scope_valid: eqAny(
        candidateValueRows.columns.root_valid,
        constant(1),
      ),
    });
    const candidateValid = (key: string, path: string) =>
      and(
        eqAny(valueShapeRows.columns.key, param(key)),
        eqAny(valueShapeRows.columns.path, param(path)),
        valueShapeRows.columns.candidate_shape_valid as Predicate,
      );
    const aggregateInputProjections: Record<string, AnyExpression> = {
      event_pk: valueShapeRows.columns.event_pk,
      role_code: valueShapeRows.columns.role_code,
      node_id: valueShapeRows.columns.node_id,
      node_type: valueShapeRows.columns.node_type,
      root_valid: valueShapeRows.columns.root_valid,
      selected_node_id: valueShapeRows.columns.selected_node_id,
      value_node_id: valueShapeRows.columns.value_node_id,
      value_row_valid: valueShapeRows.columns.value_row_valid,
      string_value: valueShapeRows.columns.string_value,
      number_value: valueShapeRows.columns.number_value,
      boolean_value: valueShapeRows.columns.boolean_value,
    };
    paths.forEach(({ path, key }, index) => {
      const prefix = "property_" + index;
      const candidateMatches = or(
        eqAny(valueShapeRows.columns.key, param(key)),
        eqAny(valueShapeRows.columns.path, param(path)),
      );
      const relevantCandidate = and(
        valueShapeRows.columns.candidate_scope_valid as Predicate,
        candidateMatches,
      );
      const validCandidate = and(
        valueShapeRows.columns.candidate_scope_valid as Predicate,
        candidateValid(key, path),
      );
      aggregateInputProjections[prefix + "_candidate"] = relevantCandidate;
      aggregateInputProjections[prefix + "_candidate_valid"] = validCandidate;
      aggregateInputProjections[prefix + "_value_valid"] = and(
        validCandidate,
        valueShapeRows.columns.value_row_valid as Predicate,
      );
      aggregateInputProjections[prefix + "_selected"] = or(
        eqAny(valueShapeRows.columns.selected_key, param(key)),
        eqAny(valueShapeRows.columns.selected_path, param(path)),
      );
    });
    const aggregateInput: AnalyticsDbRelation = project(
      valueShapeRows,
      aggregateInputProjections,
    );
    const countTrue = (predicate: Predicate) =>
      count(caseWhen([{ when: predicate, then: constant(1) }]));
    const aggregates: Record<string, SqlExpression> = {
      root_count: countTrue(
        and(
          eqAny(aggregateInput.columns.role_code, constant(0)),
          isNotNull(aggregateInput.columns.node_id as SqlExpression),
        ),
      ),
      root_valid_count: countTrue(
        and(
          eqAny(aggregateInput.columns.role_code, constant(0)),
          eqAny(aggregateInput.columns.root_valid, constant(1)),
        ),
      ),
      selected_node_count: count(
        aggregateInput.columns.selected_node_id as SqlExpression,
      ),
    };
    paths.forEach((_, index) => {
      const prefix = "property_" + index;
      const relevantCandidate = aggregateInput.columns[
        prefix + "_candidate"
      ] as Predicate;
      const validCandidate = aggregateInput.columns[
        prefix + "_candidate_valid"
      ] as Predicate;
      const matchingValidValue = aggregateInput.columns[
        prefix + "_value_valid"
      ] as Predicate;
      const selectedMatches = aggregateInput.columns[
        prefix + "_selected"
      ] as Predicate;
      aggregates[prefix + "_candidate_count"] = countTrue(relevantCandidate);
      aggregates[prefix + "_candidate_valid_count"] = countTrue(validCandidate);
      aggregates[prefix + "_candidate_id"] = min(
        caseWhen([
          {
            when: relevantCandidate,
            then: aggregateInput.columns.node_id as SqlExpression,
          },
        ]) as SqlExpression,
      );
      aggregates[prefix + "_candidate_type"] = min(
        caseWhen([
          {
            when: relevantCandidate,
            then: aggregateInput.columns.node_type as SqlExpression,
          },
        ]) as SqlExpression,
      );
      aggregates[prefix + "_value_count"] = countTrue(
        and(
          relevantCandidate,
          isNotNull(aggregateInput.columns.value_node_id as SqlExpression),
        ),
      );
      aggregates[prefix + "_value_valid_count"] = countTrue(matchingValidValue);
      aggregates[prefix + "_string_value"] = min(
        caseWhen([
          {
            when: matchingValidValue,
            then: aggregateInput.columns.string_value as SqlExpression,
          },
        ]) as SqlExpression,
      );
      aggregates[prefix + "_number_value"] = min(
        caseWhen([
          {
            when: matchingValidValue,
            then: aggregateInput.columns.number_value as SqlExpression,
          },
        ]) as SqlExpression,
      );
      aggregates[prefix + "_boolean_value"] = min(
        caseWhen([
          {
            when: matchingValidValue,
            then: aggregateInput.columns.boolean_value as SqlExpression,
          },
        ]) as SqlExpression,
      );
      aggregates[prefix + "_selected_count"] = countTrue(selectedMatches);
      aggregates[prefix + "_selected_id"] = min(
        caseWhen([
          {
            when: selectedMatches,
            then: aggregateInput.columns.selected_node_id as SqlExpression,
          },
        ]) as SqlExpression,
      );
    });
    const propertyStats: AnalyticsDbRelation = aggregate(aggregateInput, {
      groupBy: { event_pk: aggregateInput.columns.event_pk },
      aggregates,
    });
    const propertyColumns = propertyStats.columns as Readonly<
      Record<string, AnyExpression>
    >;
    const rootOkay = and(
      eqAny(propertyColumns.root_count!, constant(1)),
      eqAny(propertyColumns.root_valid_count!, constant(1)),
    );
    const candidateInputPredicates: Predicate[] = paths.map((_, index) =>
      not(
        eqAny(
          propertyColumns["property_" + index + "_candidate_count"]!,
          constant(0),
        ),
      ),
    );
    const anyCandidateInput =
      candidateInputPredicates.length === 0
        ? eqAny(constant(0), constant(1))
        : candidateInputPredicates
            .slice(1)
            .reduce<Predicate>(
              (combined, predicate) => or(combined, predicate),
              candidateInputPredicates[0]!,
            );
    const candidateStatsExist = and(rootOkay, anyCandidateInput);
    const selectedStatsExist = not(
      eqAny(propertyColumns.selected_node_count!, constant(0)),
    );
    const rootCount = propertyColumns.root_count! as SqlExpression;
    const selectedNodeCount =
      propertyColumns.selected_node_count! as SqlExpression;
    const gatedFactProjections: Record<string, AnyExpression> = {
      event_pk: propertyColumns.event_pk!,
      root_count: rootCount,
      selected_node_count: selectedNodeCount,
      empty_tree: and(
        eqAny(rootCount, constant(0)),
        eqAny(selectedNodeCount, constant(0)),
      ),
      root_okay: caseWhen([{ when: rootOkay, then: constant(1) }], constant(0)),
      candidate_stats_exist: caseWhen(
        [{ when: candidateStatsExist, then: constant(1) }],
        constant(0),
      ),
      selected_stats_exist: caseWhen(
        [{ when: selectedStatsExist, then: constant(1) }],
        constant(0),
      ),
    };
    paths.forEach((_, index) => {
      const prefix = "property_" + index;
      for (const field of [
        "candidate_count",
        "candidate_valid_count",
        "candidate_id",
        "candidate_type",
        "value_count",
        "value_valid_count",
        "string_value",
        "number_value",
        "boolean_value",
        "selected_count",
        "selected_id",
      ] as const) {
        gatedFactProjections[prefix + "_" + field] =
          propertyColumns[prefix + "_" + field]!;
      }
    });
    const gatedFacts = project(propertyStats, gatedFactProjections);
    const gatedColumns = gatedFacts.columns as Readonly<
      Record<string, AnyExpression>
    >;
    const propertyFactProjections: Record<string, AnyExpression> = {
      event_pk: gatedColumns.event_pk!,
      empty_tree: gatedColumns.empty_tree!,
      root_okay: gatedColumns.root_okay!,
    };
    paths.forEach((_, index) => {
      const prefix = "property_" + index;
      for (const field of [
        "candidate_count",
        "candidate_valid_count",
        "candidate_id",
        "candidate_type",
        "value_count",
        "value_valid_count",
        "string_value",
        "number_value",
        "boolean_value",
      ] as const) {
        propertyFactProjections[prefix + "_" + field] = caseWhen([
          {
            when: eqAny(gatedColumns.candidate_stats_exist!, constant(1)),
            then: gatedColumns[prefix + "_" + field]! as SqlExpression,
          },
        ]);
      }
      for (const field of ["selected_count", "selected_id"] as const) {
        propertyFactProjections[prefix + "_" + field] = caseWhen([
          {
            when: eqAny(gatedColumns.selected_stats_exist!, constant(1)),
            then: gatedColumns[prefix + "_" + field]! as SqlExpression,
          },
        ]);
      }
    });
    const stablePropertyFacts = project(gatedFacts, propertyFactProjections);
    const stablePropertyColumns = stablePropertyFacts.columns as Readonly<
      Record<string, AnyExpression>
    >;
    const result: Record<string, AnyExpression> = {
      event_pk: stablePropertyColumns.event_pk!,
    };
    paths.forEach((_, index) => {
      const prefix = "property_" + index;
      const candidateCount = coalesce(
        stablePropertyColumns[prefix + "_candidate_count"] as SqlExpression,
        constant(0),
      );
      const candidateValidCount = coalesce(
        stablePropertyColumns[
          prefix + "_candidate_valid_count"
        ] as SqlExpression,
        constant(0),
      );
      const selectedCount = coalesce(
        stablePropertyColumns[prefix + "_selected_count"] as SqlExpression,
        constant(0),
      );
      const valueCount = coalesce(
        stablePropertyColumns[prefix + "_value_count"] as SqlExpression,
        constant(0),
      );
      const candidateId = stablePropertyColumns[
        prefix + "_candidate_id"
      ] as SqlExpression;
      const candidateType = stablePropertyColumns[
        prefix + "_candidate_type"
      ] as SqlExpression;
      const selectedId = stablePropertyColumns[
        prefix + "_selected_id"
      ] as SqlExpression;
      const selectedCandidate = and(
        eqAny(candidateCount, constant(1)),
        eqAny(candidateValidCount, constant(1)),
        eqAny(selectedCount, constant(1)),
        eqAny(candidateId, selectedId),
      );
      const structureOkay = or(
        stablePropertyColumns.empty_tree! as Predicate,
        and(
          stablePropertyColumns.root_okay! as Predicate,
          or(eqAny(candidateCount, constant(0)), selectedCandidate),
        ),
      );
      const containerValueCompatible = and(
        or(
          eqAny(candidateType, constant(4)),
          eqAny(candidateType, constant(5)),
        ),
        eqAny(valueCount, constant(0)),
      );
      const scalarValueCompatible = and(
        or(
          eqAny(candidateType, constant(0)),
          eqAny(candidateType, constant(1)),
          eqAny(candidateType, constant(2)),
          eqAny(candidateType, constant(3)),
        ),
        eqAny(valueCount, constant(1)),
        eqAny(
          stablePropertyColumns[prefix + "_value_valid_count"] as SqlExpression,
          constant(1),
        ),
      );
      const valueOkay = or(
        stablePropertyColumns.empty_tree! as Predicate,
        and(
          structureOkay,
          or(
            eqAny(candidateCount, constant(0)),
            and(
              selectedCandidate,
              or(containerValueCompatible, scalarValueCompatible),
            ),
          ),
        ),
      );
      const present = and(structureOkay, eqAny(candidateCount, constant(1)));
      const safeValue = and(present, valueOkay);
      result[prefix + "_present"] = caseWhen(
        [{ when: present, then: constant(1) }],
        constant(0),
      );
      result[prefix + "_valueType"] = caseWhen([
        { when: present, then: candidateType },
      ]);
      for (const [field, column] of [
        ["stringValue", "string_value"],
        ["numberValue", "number_value"],
        ["booleanValue", "boolean_value"],
      ] as const) {
        result[prefix + "_" + field] = caseWhen([
          {
            when: safeValue,
            then: stablePropertyColumns[prefix + "_" + column] as SqlExpression,
          },
        ]);
      }
      result[prefix + "_structureCompatible"] = coalesce(
        structureOkay,
        constant(0),
      );
      result[prefix + "_valueCompatible"] = coalesce(valueOkay, constant(0));
    });
    return project(stablePropertyFacts, result);
  }
  /** Expands payload rows only from the Event relation already selected upstream. */
  eventPayloadOccurrences(
    selectedEvents: AnalyticsDbRelation,
    identity: AnalyticsEventPayloadOccurrenceJoinIdentity,
  ): AnalyticsDbRelation {
    const eventPkValue = identity.eventPk as SqlExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
    const eventKeys = project(selectedEvents, {
      event_pk: eventPkValue,
      ...(identity.includeDistinctIdentity
        ? {
            site_pk: identity.sitePk as SqlExpression<
              number,
              ExpressionResultType<"integer", false>
            >,
            event_id: identity.eventId as SqlExpression<
              string,
              ExpressionResultType<"text", false>
            >,
          }
        : {}),
    });
    const occurrences = scan(schema.custom_event_json_values);
    const eventOccurrences = join(
      eventKeys,
      occurrences,
      eq(eventKeys.columns.event_pk, occurrences.columns.event_pk),
    );
    const paths = scan(schema.custom_event_json_paths);
    const occurrencesWithPaths = join(
      eventOccurrences,
      paths,
      eq(eventOccurrences.columns.right_path_id, paths.columns.id),
    );
    return project(occurrencesWithPaths, {
      path: occurrencesWithPaths.columns.right_path,
      valueType: occurrencesWithPaths.columns.left_right_value_type,
      occurredAt: occurrencesWithPaths.columns.left_right_occurred_at,
      stringValue: occurrencesWithPaths.columns.left_right_string_value,
      numberValue: occurrencesWithPaths.columns.left_right_number_value,
      booleanValue: occurrencesWithPaths.columns.left_right_boolean_value,
      ...(identity.includeDistinctIdentity
        ? {
            eventSitePk: occurrencesWithPaths.columns.left_left_site_pk,
            eventId: occurrencesWithPaths.columns.left_left_event_id,
            providerEventPk: occurrencesWithPaths.columns.left_left_event_pk,
          }
        : {}),
    });
  }

  lowerSource(
    node: SourceNode,
    path: string,
    requiredSlots: ReadonlySet<SlotId> = new Set(node.output),
    providerRequests: readonly AnalyticsProviderSourceBindingRequest[] = [],
  ): LoweredAnalyticsSource {
    const eventPayloadKeyRequests = providerRequests.filter(
      (request) => request.kind === "event-payload-key",
    );
    const needsEventPayloadPropertiesMetadata = eventPayloadKeyRequests.some(
      (request) => request.includePayloadPropertiesMetadata === true,
    );
    if (
      eventPayloadKeyRequests.length !== providerRequests.length ||
      eventPayloadKeyRequests.some(
        (request, index) =>
          request.sourceId !== node.id ||
          !request.id ||
          eventPayloadKeyRequests
            .slice(0, index)
            .some((prior) => prior.id === request.id),
      )
    )
      throw new Error(`${path}: Provider source binding request is invalid.`);
    for (const request of eventPayloadKeyRequests) {
      if (
        node.entity !== "event" ||
        node.grain.kind !== "entity" ||
        node.grain.entity !== "event" ||
        node.grain.key !== request.eventKeySlot ||
        !node.output.includes(request.eventKeySlot) ||
        !requiredSlots.has(request.eventKeySlot) ||
        !node.values.some(
          (binding) =>
            binding.kind === "self" && binding.slot === request.eventKeySlot,
        )
      )
        throw new Error(
          `${path}: Provider Event payload key request does not match the canonical Source.`,
        );
      assertAnalyticsEventPayloadKeySchema(schema.custom_events, path);
    }
    const relationships = node.values.filter(
      (binding) => binding.kind === "related-entity",
    );
    const attributes = node.values.filter(
      (binding) => binding.kind === "attribute",
    );
    const declaredPageReportAttributes = attributes
      .map((binding) => binding.attribute)
      .filter(isSemanticPageReportAttribute);
    const declaredEventReportAttributes = attributes
      .map((binding) => binding.attribute)
      .filter(isSemanticEventReportAttribute);
    for (const binding of attributes) {
      if (isSemanticPageReportAttribute(binding.attribute)) {
        if (node.entity !== "page")
          throw new Error(
            `${path}.values: Internal Page report attributes are available only on Page.`,
          );
        continue;
      }
      if (isSemanticEventReportAttribute(binding.attribute)) {
        if (node.entity !== "event")
          throw new Error(
            `${path}.values: Internal Event report attributes are available only on Event.`,
          );
        continue;
      }
      if (isObservationReportAttribute(binding.attribute)) {
        if (node.entity !== "observation")
          throw new Error(
            `${path}.values: Report attributes are available only on Observation.`,
          );
        continue;
      }
      if (
        isObservationIdentityAttribute(binding.attribute) &&
        semanticAttribute(binding.attribute)?.nativeEntity === "observation"
      )
        continue;
      if (isAnalyticsScopeFactId(binding.attribute)) {
        if (node.entity !== "session" && node.entity !== "visitor")
          throw new Error(
            `${path}.values: ${binding.attribute} is available only on its native Session or Visitor entity.`,
          );
        analyticsScopeFactContract(binding.attribute, node.entity, path);
        continue;
      }
      if (!nativePrimitiveFieldContract(binding.attribute))
        throw new Error(
          `${path}.values: No registered D1 primitive storage mapping exists for ${binding.attribute}.`,
        );
    }
    const requiredAttributes = attributes.filter((binding) =>
      requiredSlots.has(binding.slot),
    );
    const declaredReportAttributes = attributes
      .map((binding) => binding.attribute)
      .filter(isObservationReportAttribute);
    const requiredReportAttributes = requiredAttributes
      .map((binding) => binding.attribute)
      .filter(isObservationReportAttribute);
    const requiredEventReportAttributes = requiredAttributes
      .map((binding) => binding.attribute)
      .filter(isSemanticEventReportAttribute);
    const identityAttributes = requiredAttributes
      .map((binding) => binding.attribute)
      .filter(isObservationIdentityAttribute);
    if (identityAttributes.length > 0 && node.entity !== "observation")
      throw new Error(
        `${path}.values: Raw identity attributes are available only on Observation.`,
      );
    const declaredContracts = attributes.flatMap((binding) => {
      if (
        isObservationReportAttribute(binding.attribute) ||
        isSemanticPageReportAttribute(binding.attribute) ||
        isSemanticEventReportAttribute(binding.attribute) ||
        isAnalyticsScopeFactId(binding.attribute)
      )
        return [];
      const contract = nativePrimitiveFieldContract(binding.attribute);
      if (!contract)
        throw new Error(
          `${path}.values: No registered D1 primitive storage mapping exists for ${binding.attribute}.`,
        );
      return [{ binding, contract }];
    });
    const contracts = declaredContracts.filter(({ binding }) =>
      requiredSlots.has(binding.slot),
    );
    const pageColumns = new Set(
      this.#requiredPageColumns(
        node,
        contracts,
        requiredSlots,
        identityAttributes,
      ),
    );
    for (const binding of requiredAttributes) {
      if (!isSemanticPageReportAttribute(binding.attribute)) continue;
      const physical = pageReportColumnByAttribute[binding.attribute];
      if (physical) pageColumns.add(physical);
      if (
        binding.attribute === "page.report.previousVisitId" ||
        binding.attribute === "page.report.previousVisitStartedAt"
      ) {
        pageColumns.add("session_id");
        pageColumns.add("started_at");
      }
    }
    const selfRequired = node.values.some(
      (binding) => binding.kind === "self" && requiredSlots.has(binding.slot),
    );
    const declaredScopeFactContracts: AnalyticsScopeFactContract[] =
      node.entity === "session" || node.entity === "visitor"
        ? attributes
            .filter((binding) => isAnalyticsScopeFactId(binding.attribute))
            .map((binding) =>
              analyticsScopeFactContract(
                binding.attribute,
                node.entity as AnalyticsScopeFactEntity,
                path,
              ),
            )
        : [];
    const needsSessionRelation = relationships.some(
      (binding) =>
        binding.relationship === "observation.session" &&
        requiredSlots.has(binding.slot),
    );
    const needsVisitorRelation = relationships.some(
      (binding) =>
        binding.relationship === "observation.visitor" &&
        requiredSlots.has(binding.slot),
    );
    const needsOwnerJoin = relationships.some(
      (binding) => binding.relationship === "observation.session",
    );
    const declaresVisitorRelation = relationships.some(
      (binding) => binding.relationship === "observation.visitor",
    );
    const declaresReportOwnerContext =
      declaredReportAttributes.length > 0 &&
      this.#reportOwnerColumns(declaredReportAttributes, false, false).length >
        0;
    const optionalVisitorOwner = declaresVisitorRelation && !needsOwnerJoin;
    const optionalReportOwner =
      optionalVisitorOwner && !declaresReportOwnerContext;
    const includesOccurrenceTime = node.values.some(
      (binding) =>
        binding.kind === "occurrence-time" && requiredSlots.has(binding.slot),
    );
    const declaresOccurrenceTime = node.values.some(
      (binding) => binding.kind === "occurrence-time",
    );
    let carrier: AnalyticsDbRelation;
    let scopeFactValues: ReadonlyMap<AnalyticsScopeFactId, AnyExpression> =
      new Map();
    let activity: "page" | "event" | "observation" | "session" | "visitor";
    if (node.entity === "page") {
      if (
        declaredPageReportAttributes.length > 0 &&
        declaredContracts.length > 0
      )
        throw new Error(
          `${path}.values: Internal Page report attributes cannot be mixed with native primitive fields.`,
        );
      if (
        declaredContracts.some(({ contract }) => contract.activity !== "page")
      )
        throw new Error(
          `${path}.values: A Page source cannot bind Event fields.`,
        );
      this.#requireRelationships(
        relationships,
        ["page.observation", "page.session", "page.visitor"],
        path,
      );
      activity = "page";
      carrier = this.#pages(
        node.temporalDomain,
        [...pageColumns],
        node.temporalDomain === "read" &&
          declaredPageReportAttributes.length > 0 &&
          this.#time.read.kind === "retained-history",
      );
    } else if (node.entity === "event") {
      const needsEventPayloadKey = eventPayloadKeyRequests.length > 0;
      if (
        declaredContracts.some(({ contract }) => contract.activity !== "event")
      )
        throw new Error(
          `${path}.values: An Event source cannot bind Page fields.`,
        );
      this.#requireRelationships(
        relationships,
        ["event.observation", "event.session", "event.visitor"],
        path,
      );
      activity = "event";
      if (
        declaredEventReportAttributes.length > 0 &&
        declaredContracts.length > 0
      )
        throw new Error(
          `${path}.values: Internal Event report attributes cannot be mixed with native primitive fields.`,
        );
      if (
        declaredEventReportAttributes.length > 0 ||
        node.selection !== undefined ||
        needsEventPayloadKey
      ) {
        const ownerPageAttributes = [
          ...new Set(
            requiredEventReportAttributes.flatMap((attributeId) => {
              const derivation = semanticAttribute(attributeId)?.derivation;
              return derivation?.kind === "report-relationship" &&
                derivation.relationship === "event.ownerPage" &&
                derivation.sourceAttribute
                ? [derivation.sourceAttribute]
                : [];
            }),
          ),
        ];
        const needsOwner = requiredEventReportAttributes.some((attributeId) => {
          const derivation = semanticAttribute(attributeId)?.derivation;
          return (
            derivation?.kind === "report-relationship" &&
            derivation.relationship === "event.ownerPage"
          );
        });
        carrier = this.#eventReport({
          domain: node.temporalDomain,
          attributes: needsEventPayloadKey
            ? [...requiredEventReportAttributes, "event.report.internalPk"]
            : requiredEventReportAttributes,
          ownerPageAttributes,
          // A selected Event report has a fixed legacy row domain even when
          // the output demand is only a count or a narrow identity projection.
          // Keep the ID-only name and same-site owner carriers inside the
          // Source relation without exposing them as required output slots.
          includeName:
            node.selection !== undefined ||
            requiredEventReportAttributes.includes("event.report.eventName") ||
            needsEventPayloadPropertiesMetadata,
          includeOwner:
            node.selection !== undefined ||
            needsOwner ||
            needsEventPayloadPropertiesMetadata,
          includeIdentity:
            node.selection !== undefined ||
            needsEventPayloadKey ||
            selfRequired ||
            relationships.some(
              (binding) =>
                binding.relationship === "event.observation" &&
                requiredSlots.has(binding.slot),
            ),
          includePropertiesMetadata: needsEventPayloadPropertiesMetadata,
          allowRetainedHistory:
            node.temporalDomain === "read" &&
            this.#time.read.kind === "retained-history",
        });
      } else {
        carrier =
          contracts.length > 0
            ? this.#eventsWithName(node.temporalDomain)
            : this.#events(node.temporalDomain);
      }
    } else if (node.entity === "observation") {
      this.#requireRelationships(
        relationships,
        ["observation.session", "observation.visitor"],
        path,
      );
      const fieldActivity = declaredContracts[0]?.contract.activity;
      if (
        declaredContracts.some(
          ({ contract }) => contract.activity !== fieldActivity,
        )
      ) {
        throw new Error(
          `${path}.values: Mixed Page/Event bindings do not define one native Observation carrier.`,
        );
      }
      if (declaredReportAttributes.length > 0 && declaredContracts.length > 0)
        throw new Error(
          `${path}.values: Report Observation attributes cannot be mixed with native primitive fields.`,
        );
      if (declaredReportAttributes.length > 0 || declaresOccurrenceTime) {
        activity = "observation";
        carrier = this.#reportObservations({
          domain: node.temporalDomain,
          attributes: requiredReportAttributes,
          includeIdentity: selfRequired,
          includeSession: needsSessionRelation,
          includeVisitor: needsVisitorRelation,
          includeOccurrenceTime: includesOccurrenceTime,
          optionalOwner: optionalReportOwner,
        });
      } else if (fieldActivity === undefined) {
        if (node.temporalDomain !== "candidate")
          throw new Error(
            `${path}.temporalDomain: An unqualified Observation source is supported only for the candidate Page/Event union.`,
          );
        activity = "observation";
        carrier = this.#candidateObservations({
          includeIdentity: selfRequired,
          includeSession: needsSessionRelation,
          includeVisitor: needsVisitorRelation,
          optionalOwner: optionalVisitorOwner,
          requiresOwnerJoin: needsOwnerJoin || !declaresVisitorRelation,
          identityAttributes,
        });
      } else if (fieldActivity === "page") {
        // Source bindings and the registered native field contract, rather
        // than a parent Filter or metric shape, select native Page evidence.
        activity = "page";
        carrier = this.#pages(node.temporalDomain, [...pageColumns]);
      } else {
        activity = "event";
        const ownerIdentityColumns = this.#ownerIdentityColumns(
          identityAttributes,
          needsSessionRelation,
          needsVisitorRelation,
        );
        const includeOwner = needsOwnerJoin || ownerIdentityColumns.length > 0;
        const needsName = declaredContracts.some(
          ({ binding }) => binding.attribute === "event.name",
        );
        carrier = needsName
          ? includeOwner
            ? this.#eventsWithNameAndOwner(
                node.temporalDomain,
                ownerIdentityColumns,
                optionalVisitorOwner,
              )
            : this.#eventsWithName(node.temporalDomain)
          : includeOwner
            ? this.#eventsWithOwner(
                node.temporalDomain,
                ownerIdentityColumns,
                false,
                optionalVisitorOwner,
              )
            : this.#events(node.temporalDomain);
      }
    } else if (node.entity === "session" || node.entity === "visitor") {
      this.#requireRelationships(relationships, [], path);
      if (declaresOccurrenceTime)
        throw new Error(
          `${path}.values: Occurrence time is not available on Session or Visitor fact sources.`,
        );
      activity = node.entity;
      const pages = this.#pages(node.temporalDomain, [
        "session_id",
        "visitor_id",
      ]);
      const events = this.#eventsWithNameAndOwner(node.temporalDomain, [
        "session_id",
        "visitor_id",
      ]);
      const facts = buildAnalyticsScopeFactRelation({
        entity: node.entity,
        facts: declaredScopeFactContracts,
        activity: { pages, events },
      });
      carrier = facts.relation;
      scopeFactValues = facts.values;
    } else {
      throw new Error(
        `${path}.entity: D1 lowering supports Page, Event, Observation, and canonical Session/Visitor count-fact sources only.`,
      );
    }

    const values = new Map<SlotId, AnalyticsSourceValue>();
    for (const binding of node.values) {
      if (!requiredSlots.has(binding.slot)) continue;
      if (binding.kind === "self") {
        const entity = node.entity;
        const localId =
          entity === "page"
            ? column(carrier, "visit_id")
            : entity === "event"
              ? column(carrier, "event_id")
              : entity === "session" || entity === "visitor"
                ? column(carrier, "entity_id")
                : column(
                    carrier,
                    activity === "observation"
                      ? "observation_id"
                      : activity === "page"
                        ? "visit_id"
                        : "event_id",
                  );
        const sitePk = column(carrier, "site_pk");
        const observationKind =
          activity === "observation"
            ? column(carrier, "observation_kind")
            : param(
                activity === "session" || activity === "visitor"
                  ? "page"
                  : activity,
              );
        values.set(binding.slot, {
          kind: "entity",
          entity,
          keys:
            entity === "observation"
              ? [sitePk, observationKind, localId]
              : [sitePk, localId],
          present:
            entity === "session" || entity === "visitor"
              ? and(isNotNull(sitePk), this.#sessionPresent(localId))
              : isNotNull(sitePk),
          nullable: false,
          candidateBounded: node.temporalDomain === "candidate",
        });
      } else if (binding.kind === "related-entity") {
        switch (binding.relationship) {
          case "page.observation":
            if (node.entity !== "page")
              throw new Error(
                `${path}.values: page.observation is only valid on Page.`,
              );
            values.set(binding.slot, {
              kind: "entity",
              entity: "observation",
              keys: [
                column(carrier, "site_pk"),
                param("page"),
                column(carrier, "visit_id"),
              ],
              present: isNotNull(column(carrier, "visit_id")),
              nullable: false,
              candidateBounded: node.temporalDomain === "candidate",
            });
            break;
          case "page.session":
            if (node.entity !== "page")
              throw new Error(
                `${path}.values: page.session is only valid on Page.`,
              );
            values.set(
              binding.slot,
              this.#sessionValue(
                carrier,
                "session_id",
                "site_pk",
                node.temporalDomain,
              ),
            );
            break;
          case "page.visitor":
            if (node.entity !== "page")
              throw new Error(
                `${path}.values: page.visitor is only valid on Page.`,
              );
            values.set(
              binding.slot,
              this.#visitorValue(
                carrier,
                "site_pk",
                "visitor_id",
                node.temporalDomain,
              ),
            );
            break;
          case "event.observation":
            if (node.entity !== "event")
              throw new Error(
                `${path}.values: event.observation is only valid on Event.`,
              );
            values.set(binding.slot, {
              kind: "entity",
              entity: "observation",
              keys: [
                column(carrier, "site_pk"),
                param("event"),
                column(carrier, "event_id"),
              ],
              present: isNotNull(column(carrier, "event_id")),
              nullable: false,
              candidateBounded: node.temporalDomain === "candidate",
            });
            break;
          case "event.session":
            if (node.entity !== "event")
              throw new Error(
                `${path}.values: event.session is only valid on Event.`,
              );
            values.set(
              binding.slot,
              this.#sessionValue(
                carrier,
                "owner_session_id",
                "site_pk",
                node.temporalDomain,
              ),
            );
            break;
          case "event.visitor":
            if (node.entity !== "event")
              throw new Error(
                `${path}.values: event.visitor is only valid on Event.`,
              );
            values.set(
              binding.slot,
              this.#visitorValue(
                carrier,
                "site_pk",
                "owner_visitor_id",
                node.temporalDomain,
              ),
            );
            break;
          case "observation.session":
            if (node.entity !== "observation")
              throw new Error(
                `${path}.values: observation.session is only valid on Observation.`,
              );
            values.set(
              binding.slot,
              this.#sessionValue(
                carrier,
                activity === "event" ? "owner_session_id" : "session_id",
                activity === "observation" ? "session_site_pk" : "site_pk",
                node.temporalDomain,
              ),
            );
            break;
          case "observation.visitor":
            if (node.entity !== "observation")
              throw new Error(
                `${path}.values: observation.visitor is only valid on Observation.`,
              );
            values.set(
              binding.slot,
              this.#visitorValue(
                carrier,
                "site_pk",
                activity === "observation"
                  ? "visitor_id"
                  : activity === "event"
                    ? "owner_visitor_id"
                    : "visitor_id",
                node.temporalDomain,
              ),
            );
            break;
          default:
            throw new Error(
              `${path}.values: Relationship ${binding.relationship} has no D1 source mapping.`,
            );
        }
      } else if (binding.kind === "attribute") {
        if (isAnalyticsScopeFactId(binding.attribute)) {
          if (node.entity !== "session" && node.entity !== "visitor")
            throw new Error(
              `${path}.values: ${binding.attribute} is available only on its native Session or Visitor entity.`,
            );
          const contract = analyticsScopeFactContract(
            binding.attribute,
            node.entity,
            path,
          );
          const factValue = scopeFactValues.get(contract.id);
          if (
            !factValue ||
            factValue.resultType.affinity !== "integer" ||
            factValue.resultType.nullable
          )
            throw new Error(
              `${path}.values: ${binding.attribute} must lower to a non-null D1 INTEGER count fact.`,
            );
          values.set(binding.slot, {
            kind: "scalar",
            value: factValue,
            candidateBounded: false,
          });
          continue;
        }
        if (isSemanticEventReportAttribute(binding.attribute)) {
          if (node.entity !== "event")
            throw new Error(
              `${path}.values: Internal Event report attributes are available only on Event.`,
            );
          const rawReportValue = this.#eventDetailReportValue(
            carrier,
            binding.attribute,
          );
          const reportValue =
            binding.attribute === "event.report.internalPk"
              ? this.#eventPrimaryKey(rawReportValue, path)
              : rawReportValue;
          requireEventReportValue(reportValue, binding.attribute, path);
          values.set(binding.slot, {
            kind: "scalar",
            value: reportValue,
            candidateBounded: false,
          });
          continue;
        }
        if (isSemanticPageReportAttribute(binding.attribute)) {
          if (node.entity !== "page")
            throw new Error(
              `${path}.values: Internal Page report attributes are available only on Page.`,
            );
          const reportValue =
            binding.attribute === "page.report.previousVisitId"
              ? this.#previousPageValue(carrier, "visit_id")
              : binding.attribute === "page.report.previousVisitStartedAt"
                ? this.#previousPageValue(carrier, "started_at")
                : column(
                    carrier,
                    pageReportColumnByAttribute[binding.attribute]!,
                  );
          requirePageReportValue(reportValue, binding.attribute, path);
          values.set(binding.slot, {
            kind: "scalar",
            value: reportValue,
            candidateBounded: false,
          });
          continue;
        }
        if (isObservationIdentityAttribute(binding.attribute)) {
          if (node.entity !== "observation")
            throw new Error(
              `${path}.values: Raw identity attributes are available only on Observation.`,
            );
          if (activity === "session" || activity === "visitor")
            throw new Error(
              `${path}.values: Session/Visitor count-fact sources do not expose raw Observation identities.`,
            );
          values.set(binding.slot, {
            kind: "scalar",
            value: this.#observationIdentityColumn(
              carrier,
              binding.attribute,
              activity,
              path,
            ),
            candidateBounded: false,
          });
          continue;
        }
        if (isObservationReportAttribute(binding.attribute)) {
          if (node.entity !== "observation")
            throw new Error(
              `${path}.values: Report attributes are available only on Observation.`,
            );
          const reportValue = column(
            carrier,
            observationReportOutputColumn(binding.attribute),
          );
          requireObservationReportValue(reportValue, binding.attribute, path);
          values.set(binding.slot, {
            kind: "scalar",
            value: reportValue,
            candidateBounded: false,
          });
          continue;
        }
        const contract = nativePrimitiveFieldContract(binding.attribute);
        if (!contract)
          throw new Error(
            `${path}.values: Attribute ${binding.attribute} has no registered native D1 contract.`,
          );
        if (contract.activity !== activity && activity !== "observation")
          throw new Error(
            `${path}.values: Attribute ${binding.attribute} does not match the selected native carrier.`,
          );
        const fieldColumn = this.#attributeColumn(
          carrier,
          binding.attribute,
          contract.compilerStrategy,
          path,
        );
        values.set(binding.slot, {
          kind: "scalar",
          value: fieldColumn,
          candidateBounded: false,
        });
      } else if (binding.kind === "occurrence-time") {
        const occurrenceColumn =
          node.entity === "observation"
            ? "occurrence_time"
            : node.entity === "page"
              ? "started_at"
              : "occurred_at";
        const occurrence = column(carrier, occurrenceColumn);
        if (
          occurrence.resultType.affinity !== "integer" ||
          occurrence.resultType.nullable
        )
          throw new Error(
            `${path}.values: Observation occurrence time must remain a non-null D1 INTEGER.`,
          );
        values.set(binding.slot, {
          kind: "scalar",
          value: occurrence,
          candidateBounded: false,
        });
      } else {
        throw new Error(`${path}.values: Unsupported source binding.`);
      }
    }

    const providerBindings = eventPayloadKeyRequests.map((request) => {
      const eventKey = values.get(request.eventKeySlot);
      const eventPkSlot = node.values.find(
        (candidate) =>
          candidate.kind === "attribute" &&
          candidate.attribute === "event.report.internalPk",
      )?.slot;
      const eventPkValue =
        eventPkSlot === undefined ? undefined : values.get(eventPkSlot);
      const eventPk = column(carrier, "event_pk");
      const sitePk = column(carrier, "site_pk");
      const eventId = column(carrier, "event_id");
      if (
        !eventKey ||
        eventKey.kind !== "entity" ||
        eventKey.entity !== "event" ||
        eventKey.nullable ||
        eventKey.keys.length !== 2 ||
        eventKey.keys[0] !== sitePk ||
        eventKey.keys[1] !== eventId ||
        carrier.columns.event_pk !== eventPk ||
        carrier.columns.site_pk !== sitePk ||
        carrier.columns.event_id !== eventId ||
        eventPk.resultType.affinity !== "integer" ||
        eventPk.resultType.nullable ||
        eventId.resultType.affinity !== "text" ||
        eventId.resultType.nullable ||
        sitePk.resultType.affinity !== "integer" ||
        sitePk.resultType.nullable
      )
        throw new Error(
          `${path}: Provider Event payload key does not match the canonical Event identity columns.`,
        );
      return {
        kind: "event-payload-key" as const,
        request,
        relation: carrier,
        columns: {
          eventPk: "event_pk",
          sitePk: "site_pk",
          eventId: "event_id",
          ...(request.includePayloadPropertiesMetadata === true
            ? {
                propertiesMetadata: {
                  siteId: "site_id",
                  eventNameId: "event_name_id",
                  occurredAt: "occurred_at",
                  visitId: "visit_id",
                },
              }
            : {}),
        },
        eventPk,
        ...(eventPkValue?.kind === "scalar"
          ? { reuseExpression: eventPkValue.value }
          : {}),
        sitePk,
        eventId,
        eventKey,
        ...(request.includePayloadPropertiesMetadata === true
          ? {
              propertiesMetadata: {
                siteId: column(carrier, "site_id"),
                eventNameId: column(carrier, "event_name_id"),
                occurredAt: column(carrier, "occurred_at"),
                visitId: column(carrier, "visit_id"),
              },
            }
          : {}),
        schema: schema.custom_events,
      };
    });

    return { relation: carrier, values, providerBindings };
  }

  observationPageIdentityRows(): AnalyticsDbRelation {
    return scan(schema.visits);
  }

  observationEventIdentityRows(): AnalyticsDbRelation {
    return scan(schema.custom_events);
  }

  #sites(): AnalyticsDbRelation {
    if (this.#sitesCache) return this.#sitesCache;
    const identities = scan(schema.site_identities);
    const selected = filter(
      identities,
      inList(identities.columns.site_id, this.#siteIds),
    );
    this.#sitesCache = project(selected, {
      site_pk: selected.columns.site_pk,
      site_id: selected.columns.site_id,
    });
    return this.#sitesCache;
  }

  #sitePages(ownerColumns: readonly string[]): AnalyticsDbRelation {
    const canonicalColumns = [...new Set(ownerColumns)].sort();
    const cacheKey = canonicalColumns.join(",");
    const existing = this.#sitePageCarriers.get(cacheKey);
    if (existing) return existing;
    const source = scan(schema.visits);
    const pageProjections: Record<string, AnyExpression> = {
      site_pk: source.columns.site_pk,
      visit_id: source.columns.visit_id,
    };
    for (const name of canonicalColumns)
      pageProjections[name] = column(source, name);
    const pages = project(source, pageProjections);
    const sites = this.#sites();
    const scoped = join(
      pages,
      sites,
      eq(pages.columns.site_pk, sites.columns.site_pk),
    );
    const validIds = filter(scoped, isNotNull(scoped.columns.left_visit_id));
    const carrierProjections: Record<string, AnyExpression> = {
      site_pk: validIds.columns.left_site_pk,
      visit_id: validIds.columns.left_visit_id,
    };
    for (const name of canonicalColumns)
      carrierProjections[name] = validIds.columns[`left_${name}`]!;
    const carrier = project(validIds, carrierProjections);
    this.#sitePageCarriers.set(cacheKey, carrier);
    return carrier;
  }

  #siteEventNames(): AnalyticsDbRelation {
    const names = scan(schema.custom_event_names);
    const scoped = semiJoin(
      names,
      this.#sites(),
      eq(names.columns.site_pk, this.#sites().columns.site_pk),
    );
    return project(scoped, {
      site_pk: scoped.columns.site_pk,
      id: scoped.columns.id,
      name: scoped.columns.name,
    });
  }

  #attachName(events: AnalyticsDbRelation): AnalyticsDbRelation {
    const names = this.#siteEventNames();
    const joined = join(
      events,
      names,
      and(
        eq(events.columns.site_pk, names.columns.site_pk),
        eq(events.columns.event_name_id, names.columns.id),
      ),
    );
    return project(joined, {
      site_pk: joined.columns.left_site_pk,
      site_id: joined.columns.left_site_id,
      event_id: joined.columns.left_event_id,
      visit_id: joined.columns.left_visit_id,
      event_name_id: joined.columns.left_event_name_id,
      occurred_at: joined.columns.left_occurred_at,
      event_name: joined.columns.right_name,
    });
  }

  #attachOwner(
    events: AnalyticsDbRelation,
    ownerColumns: readonly string[],
  ): AnalyticsDbRelation {
    const canonicalColumns = [...new Set(ownerColumns)].sort();
    const pages = this.#sitePages(canonicalColumns);
    const condition = and(
      eq(events.columns.site_pk, pages.columns.site_pk),
      eq(events.columns.visit_id, pages.columns.visit_id),
    );
    const joined = join(events, pages, condition);
    return this.#projectOwnedEvents(joined, canonicalColumns);
  }

  #attachOptionalOwner(
    events: AnalyticsDbRelation,
    ownerColumns: readonly string[],
  ): AnalyticsDbRelation {
    const canonicalColumns = [...new Set(ownerColumns)].sort();
    const pages = this.#sitePages(canonicalColumns);
    const condition = and(
      eq(events.columns.site_pk, pages.columns.site_pk),
      eq(events.columns.visit_id, pages.columns.visit_id),
    );
    const joined = join(events, pages, condition, "left");
    return this.#projectOwnedEvents(joined, canonicalColumns);
  }

  #projectOwnedEvents(
    joined: AnalyticsDbRelation,
    canonicalColumns: readonly string[],
  ): AnalyticsDbRelation {
    const projections: Record<string, AnyExpression> = {
      site_pk: joined.columns.left_site_pk,
      site_id: joined.columns.left_site_id,
      event_id: joined.columns.left_event_id,
      visit_id: joined.columns.left_visit_id,
      event_name_id: joined.columns.left_event_name_id,
      occurred_at: joined.columns.left_occurred_at,
    };
    if (joined.columns.left_canonical_site_id)
      projections.canonical_site_id = joined.columns.left_canonical_site_id;
    for (const name of canonicalColumns)
      projections[`owner_${name}`] = joined.columns[`right_${name}`]!;
    if (joined.columns.left_event_name)
      projections.event_name = joined.columns.left_event_name;
    return project(joined, projections);
  }

  #attachReportName(events: AnalyticsDbRelation): AnalyticsDbRelation {
    const source = scan(schema.custom_event_names);
    const names = project(source, {
      id: source.columns.id,
      name: source.columns.name,
    });
    const joined = join(
      events,
      names,
      eq(
        events.columns.event_name_id as AnyExpression,
        names.columns.id as AnyExpression,
      ),
      "left",
    );
    const projections: Record<string, AnyExpression> = {};
    for (const name of Object.keys(events.columns))
      projections[name] = joined.columns[`left_${name}`]!;
    projections.event_name = joined.columns.right_name;
    return project(joined, projections);
  }

  #attachSameSiteReportName(events: AnalyticsDbRelation): AnalyticsDbRelation {
    const source = scan(schema.custom_event_names);
    const names = project(source, {
      id: source.columns.id,
      site_pk: source.columns.site_pk,
      name: source.columns.name,
    });
    const joined = join(
      events,
      names,
      and(
        eq(
          events.columns.site_pk as AnyExpression,
          names.columns.site_pk as AnyExpression,
        ),
        eq(
          events.columns.event_name_id as AnyExpression,
          names.columns.id as AnyExpression,
        ),
      ),
      "left",
    );
    const projections: Record<string, AnyExpression> = {};
    for (const name of Object.keys(events.columns))
      projections[name] = joined.columns[`left_${name}`]!;
    projections.activity_event_name = joined.columns.right_name;
    return project(joined, projections);
  }

  #attachReportOwner(
    events: AnalyticsDbRelation,
    ownerColumns: readonly string[],
  ): AnalyticsDbRelation {
    const canonicalColumns = [...new Set(ownerColumns)].sort();
    const source = scan(schema.visits);
    const ownerProjections: Record<string, AnyExpression> = {
      site_pk: source.columns.site_pk,
      visit_id: source.columns.visit_id,
    };
    for (const name of canonicalColumns)
      ownerProjections[name] = column(source, name);
    const pages = project(source, ownerProjections);
    const joined = join(
      events,
      pages,
      and(
        eq(events.columns.site_pk, pages.columns.site_pk),
        eq(events.columns.visit_id, pages.columns.visit_id),
      ),
      "left",
    );
    const projections: Record<string, AnyExpression> = {};
    for (const name of Object.keys(events.columns))
      projections[name] = joined.columns[`left_${name}`]!;
    projections.owner_site_pk = joined.columns.right_site_pk;
    for (const name of canonicalColumns)
      projections[`owner_${name}`] = joined.columns[`right_${name}`]!;
    return project(joined, projections);
  }

  #pages(
    domain: SourceNode["temporalDomain"],
    requiredColumns: readonly string[] = [
      "visit_id",
      "session_id",
      "pathname",
      "title",
      "query_string",
      "hash_fragment",
    ],
    allowRetainedHistory = false,
    includeCanonicalSiteId = false,
  ): AnalyticsDbRelation {
    const columns = [...new Set(["site_pk", ...requiredColumns])].sort();
    const cacheKey = `${String(domain)}:${allowRetainedHistory}:${includeCanonicalSiteId}:${columns.join(",")}`;
    const existing = this.#pageCarriers.get(cacheKey);
    if (existing) return existing;
    const pages = scan(schema.visits);
    const scoped = join(
      pages,
      this.#sites(),
      eq(pages.columns.site_pk, this.#sites().columns.site_pk),
    );
    const ranged = this.#inRange(
      scoped,
      domain,
      scoped.columns.left_started_at,
      allowRetainedHistory,
    );
    const carrierColumns: Record<string, AnyExpression> = {};
    for (const name of columns)
      carrierColumns[name] =
        name === "site_pk"
          ? ranged.columns.left_site_pk
          : name === "canonical_site_id" && includeCanonicalSiteId
            ? ranged.columns.right_site_id
            : ranged.columns[`left_${name}`]!;
    const carrier = project(ranged, carrierColumns);
    this.#pageCarriers.set(cacheKey, carrier);
    return carrier;
  }

  #previousPageValue(
    currentPages: AnalyticsDbRelation,
    outputColumn: "visit_id" | "started_at",
    currentColumns: {
      readonly sitePk: string;
      readonly sessionId: string;
      readonly startedAt: string;
    } = { sitePk: "site_pk", sessionId: "session_id", startedAt: "started_at" },
  ): AnyExpression {
    const previousPages = scan(schema.visits);
    const sameSession = filter(
      previousPages,
      and(
        eq(
          previousPages.columns.site_pk,
          column(currentPages, currentColumns.sitePk),
        ),
        eq(
          previousPages.columns.session_id,
          column(currentPages, currentColumns.sessionId),
        ),
        lt(
          previousPages.columns.started_at,
          column(currentPages, currentColumns.startedAt),
        ),
      ),
    );
    const selected = limit(
      sort(sameSession, [
        { expression: sameSession.columns.started_at, direction: "DESC" },
        { expression: sameSession.columns.visit_id, direction: "DESC" },
      ]),
      1,
    );
    return scalar(project(selected, { value: selected.columns[outputColumn] }));
  }

  #eventReport(input: {
    readonly domain: SourceNode["temporalDomain"];
    readonly attributes: readonly string[];
    readonly ownerPageAttributes: readonly string[];
    readonly includeName: boolean;
    readonly includeOwner: boolean;
    readonly includeIdentity: boolean;
    readonly includePropertiesMetadata: boolean;
    readonly allowRetainedHistory: boolean;
  }): AnalyticsDbRelation {
    const attributes = [...new Set(input.attributes)].sort();
    const ownerPageAttributes = [...new Set(input.ownerPageAttributes)].sort();
    const cacheKey = JSON.stringify([
      input.domain,
      attributes,
      ownerPageAttributes,
      input.includeName,
      input.includeOwner,
      input.includeIdentity,
      input.includePropertiesMetadata,
      input.allowRetainedHistory,
    ]);
    const existing = this.#eventReportCarriers.get(cacheKey);
    if (existing) return existing;

    const eventColumns = new Set<string>(["occurred_at"]);
    if (input.includePropertiesMetadata) eventColumns.add("site_id");
    if (input.includeIdentity) eventColumns.add("event_id");
    for (const attribute of attributes) {
      const physical = eventReportColumnByAttribute[attribute];
      if (physical) eventColumns.add(physical);
    }
    if (input.includeName) eventColumns.add("event_name_id");
    if (input.includeOwner) eventColumns.add("visit_id");
    const source = scan(schema.custom_events);
    const sourceProjections: Record<string, AnyExpression> = {
      site_pk: source.columns.site_pk,
    };
    for (const name of eventColumns)
      sourceProjections[name] = column(source, name);
    const events = project(source, sourceProjections);
    const scoped = join(
      events,
      this.#sites(),
      eq(events.columns.site_pk, this.#sites().columns.site_pk),
    );
    const ranged = this.#inRange(
      scoped,
      input.domain,
      scoped.columns.left_occurred_at,
      input.allowRetainedHistory,
    );
    const baseProjections: Record<string, AnyExpression> = {
      site_pk: ranged.columns.left_site_pk,
    };
    for (const name of eventColumns)
      baseProjections[name] = ranged.columns[`left_${name}`]!;
    let carrier: AnalyticsDbRelation = project(ranged, baseProjections);
    if (input.includeName) carrier = this.#attachReportName(carrier);

    if (input.includeOwner) {
      const ownerColumns = new Set<string>();
      for (const attributeId of ownerPageAttributes) {
        const physical = pageReportColumnByAttribute[attributeId];
        if (physical) ownerColumns.add(physical);
        if (
          attributeId === "page.report.previousVisitId" ||
          attributeId === "page.report.previousVisitStartedAt"
        ) {
          ownerColumns.add("session_id");
          ownerColumns.add("started_at");
        }
      }
      carrier = this.#attachReportOwner(carrier, [...ownerColumns]);
    }
    this.#eventReportCarriers.set(cacheKey, carrier);
    return carrier;
  }

  #eventDetailReportValue(
    events: AnalyticsDbRelation,
    attributeId: string,
  ): AnyExpression {
    if (attributeId === "event.report.eventName")
      return column(events, "event_name");
    if (attributeId === "event.report.ownerPresent")
      return isNotNull(column(events, "owner_site_pk"));
    const attribute = semanticAttribute(attributeId);
    const derivation = attribute?.derivation;
    if (
      derivation?.kind === "report-relationship" &&
      derivation.relationship === "event.ownerPage" &&
      derivation.sourceAttribute
    ) {
      if (
        derivation.sourceAttribute === "page.report.previousVisitId" ||
        derivation.sourceAttribute === "page.report.previousVisitStartedAt"
      )
        return this.#previousPageValue(
          events,
          derivation.sourceAttribute === "page.report.previousVisitId"
            ? "visit_id"
            : "started_at",
          {
            sitePk: "site_pk",
            sessionId: "owner_session_id",
            startedAt: "owner_started_at",
          },
        );
      const physical = pageReportColumnByAttribute[derivation.sourceAttribute];
      if (physical) return column(events, `owner_${physical}`);
    }
    const physical = eventReportColumnByAttribute[attributeId];
    if (physical) return column(events, physical);
    throw new Error(`No D1 Event report mapping exists for ${attributeId}.`);
  }

  #eventPrimaryKey(expression: AnyExpression, path: string): AnyExpression {
    if (
      expression.resultType.affinity !== "integer" ||
      expression.resultType.nullable
    )
      throw new Error(
        `${path}.values: Event internal primary key must remain a non-null INTEGER.`,
      );
    return expression;
  }

  #requiredPageColumns(
    node: SourceNode,
    contracts: readonly {
      readonly binding: Extract<
        SourceValueBinding,
        { readonly kind: "attribute" }
      >;
      readonly contract: NativePrimitiveFieldContract;
    }[],
    requiredSlots: ReadonlySet<SlotId>,
    identityAttributes: readonly ObservationIdentityAttribute[],
  ): readonly string[] {
    const columns = new Set<string>();
    if (
      node.values.some(
        (binding) => binding.kind === "self" && requiredSlots.has(binding.slot),
      ) ||
      (node.entity === "page" &&
        node.values.some(
          (binding) =>
            binding.kind === "related-entity" &&
            binding.relationship === "page.observation" &&
            requiredSlots.has(binding.slot),
        ))
    )
      columns.add("visit_id");
    if (
      node.values.some(
        (binding) =>
          binding.kind === "related-entity" &&
          binding.relationship === "observation.session" &&
          requiredSlots.has(binding.slot),
      ) ||
      (node.entity === "page" &&
        node.values.some(
          (binding) =>
            binding.kind === "related-entity" &&
            binding.relationship === "page.session" &&
            requiredSlots.has(binding.slot),
        ))
    )
      columns.add("session_id");
    if (
      node.values.some(
        (binding) =>
          binding.kind === "related-entity" &&
          binding.relationship === "observation.visitor" &&
          requiredSlots.has(binding.slot),
      )
    )
      columns.add("visitor_id");
    if (
      node.values.some(
        (binding) =>
          binding.kind === "occurrence-time" && requiredSlots.has(binding.slot),
      )
    )
      columns.add("started_at");
    if (identityAttributes.includes("observation.sessionId"))
      columns.add("session_id");
    if (identityAttributes.includes("observation.visitorId"))
      columns.add("visitor_id");
    for (const { binding, contract } of contracts) {
      if (!requiredSlots.has(binding.slot) || contract.activity !== "page")
        continue;
      columns.add(contract.storageColumn);
    }
    return [...columns];
  }

  #events(
    domain: SourceNode["temporalDomain"],
    allowRetainedHistory = false,
    includeCanonicalSiteId = false,
  ): AnalyticsDbRelation {
    const cacheKey = `${String(domain)}:${allowRetainedHistory}:${includeCanonicalSiteId}`;
    const existing = this.#eventCarriers.get(cacheKey);
    if (existing) return existing;
    const source = scan(schema.custom_events);
    const events = project(source, {
      site_pk: source.columns.site_pk,
      site_id: source.columns.site_id,
      event_id: source.columns.event_id,
      visit_id: source.columns.visit_id,
      event_name_id: source.columns.event_name_id,
      occurred_at: source.columns.occurred_at,
    });
    const scoped = join(
      events,
      this.#sites(),
      eq(events.columns.site_pk, this.#sites().columns.site_pk),
    );
    const ranged = this.#inRange(
      scoped,
      domain,
      scoped.columns.left_occurred_at,
      allowRetainedHistory,
    );
    const carrierColumns: Record<string, AnyExpression> = {
      site_pk: ranged.columns.left_site_pk,
      site_id: ranged.columns.left_site_id,
      event_id: ranged.columns.left_event_id,
      visit_id: ranged.columns.left_visit_id,
      event_name_id: ranged.columns.left_event_name_id,
      occurred_at: ranged.columns.left_occurred_at,
    };
    if (includeCanonicalSiteId)
      carrierColumns.canonical_site_id = ranged.columns.right_site_id;
    const carrier = project(ranged, carrierColumns);
    this.#eventCarriers.set(cacheKey, carrier);
    return carrier;
  }

  #eventsWithName(domain: SourceNode["temporalDomain"]): AnalyticsDbRelation {
    const existing = this.#namedEventCarriers.get(domain);
    if (existing) return existing;
    const carrier = this.#attachName(this.#events(domain));
    this.#namedEventCarriers.set(domain, carrier);
    return carrier;
  }

  #ownerIdentityColumns(
    attributes: readonly ObservationIdentityAttribute[],
    includeSession: boolean,
    includeVisitor = false,
  ): ("session_id" | "visitor_id")[] {
    const requested = new Set(attributes);
    const columns: ("session_id" | "visitor_id")[] = [];
    if (includeSession || requested.has("observation.sessionId"))
      columns.push("session_id");
    if (includeVisitor || requested.has("observation.visitorId"))
      columns.push("visitor_id");
    return columns;
  }

  #eventsWithOwner(
    domain: SourceNode["temporalDomain"],
    ownerColumns: readonly string[],
    allowRetainedHistory = false,
    optionalOwner = false,
    includeCanonicalSiteId = false,
  ): AnalyticsDbRelation {
    const canonicalColumns = [...new Set(ownerColumns)].sort();
    const cacheKey = JSON.stringify([
      domain,
      allowRetainedHistory,
      canonicalColumns,
      optionalOwner,
      includeCanonicalSiteId,
    ]);
    const existing = this.#ownedEventCarriers.get(cacheKey);
    if (existing) return existing;
    const events = this.#events(
      domain,
      allowRetainedHistory,
      includeCanonicalSiteId,
    );
    const carrier = optionalOwner
      ? this.#attachOptionalOwner(events, canonicalColumns)
      : this.#attachOwner(events, canonicalColumns);
    this.#ownedEventCarriers.set(cacheKey, carrier);
    return carrier;
  }

  #eventsWithNameAndOwner(
    domain: SourceNode["temporalDomain"],
    ownerColumns: readonly string[],
    optionalOwner = false,
  ): AnalyticsDbRelation {
    const canonicalColumns = [...new Set(ownerColumns)].sort();
    const cacheKey = `${String(domain)}:${canonicalColumns.join(",")}:${optionalOwner}`;
    const existing = this.#namedOwnedEventCarriers.get(cacheKey);
    if (existing) return existing;
    const events = this.#eventsWithName(domain);
    const carrier = optionalOwner
      ? this.#attachOptionalOwner(events, canonicalColumns)
      : this.#attachOwner(events, canonicalColumns);
    this.#namedOwnedEventCarriers.set(cacheKey, carrier);
    return carrier;
  }

  #candidateObservations(input: {
    readonly includeIdentity: boolean;
    readonly includeSession: boolean;
    readonly includeVisitor: boolean;
    readonly optionalOwner: boolean;
    readonly requiresOwnerJoin: boolean;
    readonly identityAttributes: readonly ObservationIdentityAttribute[];
  }): AnalyticsDbRelation {
    const identityAttributes = [
      ...(input.identityAttributes.includes("observation.sessionId")
        ? (["observation.sessionId"] as const)
        : []),
      ...(input.identityAttributes.includes("observation.visitorId")
        ? (["observation.visitorId"] as const)
        : []),
    ];
    const cacheKey = JSON.stringify([
      input.includeIdentity,
      input.includeSession,
      input.includeVisitor,
      input.optionalOwner,
      input.requiresOwnerJoin,
      identityAttributes,
    ]);
    const existing = this.#candidateObservationCarriers.get(cacheKey);
    if (existing) return existing;
    const ownerIdentityColumns = this.#ownerIdentityColumns(
      identityAttributes,
      input.includeSession,
      input.includeVisitor,
    );
    const pageColumns = [
      ...(input.includeSession ||
      identityAttributes.includes("observation.sessionId")
        ? (["session_id"] as const)
        : []),
      ...(input.includeVisitor ||
      identityAttributes.includes("observation.visitorId")
        ? (["visitor_id"] as const)
        : []),
      ...(input.includeIdentity ? (["visit_id"] as const) : []),
    ];
    const pages = this.#pages("candidate", pageColumns);
    const pageProjections: Record<string, AnyExpression> = {
      site_pk: pages.columns.site_pk,
    };
    if (input.includeSession) {
      pageProjections.session_site_pk = pages.columns.site_pk;
      pageProjections.session_id = pages.columns.session_id;
      pageProjections.session_present = this.#sessionPresent(
        pages.columns.session_id,
      );
    }
    if (input.includeVisitor) {
      pageProjections.visitor_id = pages.columns.visitor_id;
    }
    if (identityAttributes.includes("observation.sessionId"))
      pageProjections.raw_session_id = pages.columns.session_id;
    if (identityAttributes.includes("observation.visitorId"))
      pageProjections.raw_visitor_id = pages.columns.visitor_id;
    if (input.includeIdentity) {
      pageProjections.observation_kind = param("page");
      pageProjections.observation_id = pages.columns.visit_id;
    }
    const pageRows = project(pages, pageProjections);

    const events =
      input.requiresOwnerJoin || ownerIdentityColumns.length > 0
        ? this.#eventsWithOwner(
            "candidate",
            ownerIdentityColumns,
            false,
            input.optionalOwner,
          )
        : this.#events("candidate");
    const eventProjections: Record<string, AnyExpression> = {
      site_pk: events.columns.site_pk,
    };
    if (input.includeSession) {
      eventProjections.session_site_pk = events.columns.site_pk;
      eventProjections.session_id = events.columns.owner_session_id;
      eventProjections.session_present = this.#sessionPresent(
        events.columns.owner_session_id,
      );
    }
    if (input.includeVisitor) {
      eventProjections.visitor_id = events.columns.owner_visitor_id;
    }
    if (identityAttributes.includes("observation.sessionId"))
      eventProjections.raw_session_id = events.columns.owner_session_id;
    if (identityAttributes.includes("observation.visitorId"))
      eventProjections.raw_visitor_id = events.columns.owner_visitor_id;
    if (input.includeIdentity) {
      eventProjections.observation_kind = param("event");
      eventProjections.observation_id = events.columns.event_id;
    }
    const eventRows = project(events, eventProjections);
    // Observation is a bag of activity rows. Keep duplicate projected
    // session keys until an explicit Logical Distinct/Set node removes them.
    const carrier = union(pageRows, eventRows, true);
    this.#candidateObservationCarriers.set(cacheKey, carrier);
    return carrier;
  }

  #reportObservations(input: {
    readonly domain: SourceNode["temporalDomain"];
    readonly attributes: readonly string[];
    readonly includeIdentity: boolean;
    readonly includeSession: boolean;
    readonly includeVisitor: boolean;
    readonly includeOccurrenceTime: boolean;
    readonly optionalOwner: boolean;
  }): AnalyticsDbRelation {
    const attributes = [...new Set(input.attributes)].sort();
    const cacheKey = JSON.stringify([
      input.domain,
      attributes,
      input.includeIdentity,
      input.includeSession,
      input.includeVisitor,
      input.includeOccurrenceTime,
      input.optionalOwner,
    ]);
    const existing = this.#reportObservationCarriers.get(cacheKey);
    if (existing) return existing;

    const pageColumns = new Set<string>();
    const includeSiteIdentityConsistency = attributes.includes(
      "observation.siteIdentityConsistent",
    );
    if (includeSiteIdentityConsistency) pageColumns.add("site_id");
    if (
      input.includeIdentity ||
      attributes.includes("observation.id") ||
      attributes.includes("observation.visitId")
    )
      pageColumns.add("visit_id");
    if (input.includeOccurrenceTime) pageColumns.add("started_at");
    if (input.includeSession || attributes.includes("observation.sessionId"))
      pageColumns.add("session_id");
    if (input.includeVisitor || attributes.includes("observation.visitorId"))
      pageColumns.add("visitor_id");
    for (const attribute of attributes) {
      const physical = observationReportSourceColumn(attribute);
      if (physical) pageColumns.add(physical);
    }

    const pages = this.#pages(
      input.domain,
      [
        ...pageColumns,
        ...(includeSiteIdentityConsistency ? ["canonical_site_id"] : []),
      ],
      true,
      includeSiteIdentityConsistency,
    );
    const pageProjections: Record<string, AnyExpression> = {
      site_pk: pages.columns.site_pk,
    };
    if (input.includeIdentity) {
      pageProjections.observation_kind = param("page");
      pageProjections.observation_id = column(pages, "visit_id");
    }
    if (input.includeSession) {
      pageProjections.session_site_pk = pages.columns.site_pk;
      pageProjections.session_id = column(pages, "session_id");
      pageProjections.session_present = this.#sessionPresent(
        column(pages, "session_id"),
      );
    }
    if (input.includeVisitor) {
      pageProjections.visitor_id = column(pages, "visitor_id");
    }
    if (attributes.includes("observation.sessionId"))
      pageProjections.raw_session_id = column(pages, "session_id");
    if (attributes.includes("observation.visitorId"))
      pageProjections.raw_visitor_id = column(pages, "visitor_id");
    if (input.includeOccurrenceTime)
      pageProjections.occurrence_time = column(pages, "started_at");
    for (const attribute of attributes)
      pageProjections[observationReportOutputColumn(attribute)] =
        this.#pageReportValue(pages, attribute);
    const pageRows = project(pages, pageProjections);

    const ownerColumns = this.#reportOwnerColumns(
      attributes,
      input.includeSession,
      input.includeVisitor,
    );
    const canSkipOptionalOwnerLookup =
      input.optionalOwner && ownerColumns.length === 0;
    let events = canSkipOptionalOwnerLookup
      ? this.#events(input.domain, true, includeSiteIdentityConsistency)
      : this.#eventsWithOwner(
          input.domain,
          ownerColumns,
          true,
          input.optionalOwner,
          includeSiteIdentityConsistency,
        );
    if (attributes.includes("observation.eventName"))
      events = this.#attachReportName(events);
    if (
      attributes.includes("observation.sameSiteEventName") ||
      attributes.includes("observation.sameSiteEventNameIsString")
    )
      events = this.#attachSameSiteReportName(events);
    const eventProjections: Record<string, AnyExpression> = {
      site_pk: events.columns.site_pk,
    };
    if (input.includeIdentity) {
      eventProjections.observation_kind = param("event");
      eventProjections.observation_id = column(events, "event_id");
    }
    if (input.includeSession) {
      eventProjections.session_site_pk = events.columns.site_pk;
      eventProjections.session_id = column(events, "owner_session_id");
      eventProjections.session_present = this.#sessionPresent(
        column(events, "owner_session_id"),
      );
    }
    if (input.includeVisitor) {
      eventProjections.visitor_id = column(events, "owner_visitor_id");
    }
    if (attributes.includes("observation.sessionId"))
      eventProjections.raw_session_id = column(events, "owner_session_id");
    if (attributes.includes("observation.visitorId"))
      eventProjections.raw_visitor_id = column(events, "owner_visitor_id");
    if (input.includeOccurrenceTime)
      eventProjections.occurrence_time = column(events, "occurred_at");
    for (const attribute of attributes)
      eventProjections[observationReportOutputColumn(attribute)] =
        this.#eventReportValue(events, attribute);
    const eventRows = project(events, eventProjections);
    const carrier = union(pageRows, eventRows, true);
    this.#reportObservationCarriers.set(cacheKey, carrier);
    return carrier;
  }

  #reportOwnerColumns(
    attributes: readonly string[],
    includeSession: boolean,
    includeVisitor: boolean,
  ): string[] {
    const columns = new Set<string>();
    if (includeSession) columns.add("session_id");
    if (includeVisitor) columns.add("visitor_id");
    for (const attribute of attributes) {
      if (
        attribute === "observation.id" ||
        attribute === "observation.kind" ||
        attribute === "observation.eventId" ||
        attribute === "observation.eventName" ||
        attribute === "observation.sameSiteEventName" ||
        attribute === "observation.sameSiteEventNameIsString" ||
        attribute === "observation.rawSiteId" ||
        attribute === "observation.siteIdentityConsistent" ||
        attribute === "observation.visitId" ||
        this.#eventReportValueIsNull(attribute)
      )
        continue;
      const physical = observationReportSourceColumn(attribute);
      if (physical) columns.add(physical);
    }
    return [...columns];
  }

  #eventReportValueIsNull(attribute: string): boolean {
    return (
      attribute === "observation.eventId" ||
      attribute === "observation.eventName" ||
      attribute === "observation.status" ||
      attribute === "observation.startedAt" ||
      attribute === "observation.lastActivityAt" ||
      attribute === "observation.endedAt" ||
      attribute === "observation.durationMs"
    );
  }

  #pageReportValue(
    pages: AnalyticsDbRelation,
    attribute: string,
  ): AnyExpression {
    if (attribute === "observation.kind") return param("page");
    if (attribute === "observation.id") return column(pages, "visit_id");
    const selectorBooleanField = advancedCountSelectorBooleanField(attribute);
    if (selectorBooleanField?.collection === "page") {
      const physical = observationReportColumn(
        selectorBooleanField.valueAttribute,
      );
      if (!physical)
        throw new Error(
          `No D1 selector compatibility source column exists for ${attribute}.`,
        );
      return countSelectorBooleanValue(
        selectorBooleanField,
        attribute,
        column(pages, physical),
      );
    }
    if (attribute === "observation.sameSiteEventNameIsString")
      return eq(callFunction("storage-class", param(null)), param("text"));
    if (attribute === "observation.siteIdentityConsistent")
      return coalesce(
        eq(column(pages, "site_id"), column(pages, "canonical_site_id")),
        constant(0),
      );
    if (
      attribute === "observation.eventId" ||
      attribute === "observation.eventName" ||
      attribute === "observation.sameSiteEventName"
    )
      return param(null);
    const physical = observationReportColumn(attribute);
    if (!physical)
      throw new Error(
        `No D1 report Observation mapping exists for ${attribute}.`,
      );
    return column(pages, physical);
  }

  #eventReportValue(
    events: AnalyticsDbRelation,
    attribute: string,
  ): AnyExpression {
    if (attribute === "observation.kind") return param("event");
    if (attribute === "observation.id" || attribute === "observation.eventId")
      return column(events, "event_id");
    if (attribute === "observation.sameSiteEventName")
      return column(events, "activity_event_name");
    if (attribute === "observation.sameSiteEventNameIsString")
      return eq(
        callFunction(
          "storage-class",
          column(events, "activity_event_name") as SqlExpression,
        ),
        param("text"),
      );
    const selectorBooleanField = advancedCountSelectorBooleanField(attribute);
    if (selectorBooleanField?.collection === "page") {
      const physical = observationReportColumn(
        selectorBooleanField.valueAttribute,
      );
      if (!physical)
        throw new Error(
          `No D1 selector compatibility source column exists for ${attribute}.`,
        );
      return countSelectorBooleanValue(
        selectorBooleanField,
        attribute,
        column(events, `owner_${physical}`),
      );
    }
    if (attribute === "observation.eventName")
      return column(events, "event_name");
    if (attribute === "observation.visitId") return column(events, "visit_id");
    if (attribute === "observation.rawSiteId") return column(events, "site_id");
    if (attribute === "observation.siteIdentityConsistent")
      return coalesce(
        eq(column(events, "site_id"), column(events, "canonical_site_id")),
        constant(0),
      );
    if (this.#eventReportValueIsNull(attribute)) return param(null);
    const physical = observationReportColumn(attribute);
    if (!physical)
      throw new Error(
        `No D1 report Observation mapping exists for ${attribute}.`,
      );
    return column(events, `owner_${physical}`);
  }

  #inRange(
    source: AnalyticsDbRelation,
    domain: SourceNode["temporalDomain"],
    occurrence: AnyExpression,
    allowRetainedHistory = false,
  ): AnalyticsDbRelation {
    if (
      allowRetainedHistory &&
      domain === "read" &&
      this.#time.read.kind === "retained-history"
    )
      return source;
    const range =
      domain === "candidate"
        ? this.#time.candidate
        : domain === "filter" &&
            this.#time.filter?.startMs !== undefined &&
            this.#time.filter.endExclusiveMs !== undefined
          ? {
              startMs: this.#time.filter.startMs,
              endExclusiveMs: this.#time.filter.endExclusiveMs,
            }
          : domain === "read" && this.#time.read.kind === "bounded"
            ? this.#time.read.range
            : undefined;
    if (!range || !this.#safeRange(range))
      throw new Error(
        `Source temporal domain ${domain} is not a safe bounded D1 range.`,
      );
    const typedOccurrence = occurrence as SqlExpression<
      number | null,
      ExpressionResultType<"integer", boolean>
    >;
    return filter(
      source,
      and(
        gte(typedOccurrence, param(range.startMs)),
        lt(typedOccurrence, param(range.endExclusiveMs)),
      ),
    );
  }

  #safeRange(range: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  }): boolean {
    return (
      Number.isSafeInteger(range.startMs) &&
      Number.isSafeInteger(range.endExclusiveMs) &&
      range.startMs < range.endExclusiveMs
    );
  }

  #sessionPresent(sessionId: AnyExpression): Predicate {
    const typedSessionId = sessionId as SqlExpression<
      string | null,
      ExpressionResultType<"text", boolean>
    >;
    return and(isNotNull(typedSessionId), neq(typedSessionId, param("")));
  }

  #visitorValue(
    source: AnalyticsDbRelation,
    visitorSiteColumn: string,
    visitorColumn: string,
    domain: SourceNode["temporalDomain"],
  ): AnalyticsSourceValue {
    const visitorId = column(source, visitorColumn) as SqlExpression<
      string | null,
      ExpressionResultType<"text", boolean>
    >;
    return {
      kind: "entity",
      entity: "visitor",
      keys: [column(source, visitorSiteColumn), visitorId],
      present: and(isNotNull(visitorId), neq(visitorId, param(""))),
      nullable: true,
      candidateBounded: domain === "candidate",
    };
  }

  #observationIdentityColumn(
    source: AnalyticsDbRelation,
    attributeId: ObservationIdentityAttribute,
    activity: "page" | "event" | "observation",
    path: string,
  ): AnyExpression {
    const attribute = semanticAttribute(attributeId);
    if (
      !attribute ||
      attribute.nativeEntity !== "observation" ||
      attribute.valueType.kind !== "scalar" ||
      attribute.valueType.scalar !== "string" ||
      attribute.nullable
    )
      throw new Error(
        `${path}.values: ${attributeId} no longer has its non-null Observation text contract.`,
      );
    const name =
      attributeId === "observation.sessionId"
        ? activity === "observation"
          ? "raw_session_id"
          : activity === "event"
            ? "owner_session_id"
            : "session_id"
        : activity === "observation"
          ? "raw_visitor_id"
          : activity === "event"
            ? "owner_visitor_id"
            : "visitor_id";
    const expression = column(source, name);
    requireStorageTextColumn(expression, attributeId);
    return expression;
  }

  #sessionValue(
    source: AnalyticsDbRelation,
    sessionColumn: string,
    siteColumn: string,
    domain: SourceNode["temporalDomain"],
  ): AnalyticsSourceValue {
    return {
      kind: "entity",
      entity: "session",
      keys: [column(source, siteColumn), column(source, sessionColumn)],
      present: this.#sessionPresent(column(source, sessionColumn)),
      nullable: true,
      candidateBounded: domain === "candidate",
    };
  }

  #attributeColumn(
    source: AnalyticsDbRelation,
    fieldId: string,
    strategy: string,
    path: string,
  ): AnyExpression {
    const contract = nativePrimitiveFieldContract(fieldId);
    if (!contract || contract.compilerStrategy !== strategy)
      throw new Error(
        `${path}.values: Field ${fieldId} has no matching registered D1 storage strategy.`,
      );
    const expression = column(source, contract.storageColumn);
    requireNativePrimitiveStorageColumn(expression, contract, path);
    return expression;
  }

  #requireRelationships(
    relationships: readonly Extract<
      SourceValueBinding,
      { kind: "related-entity" }
    >[],
    allowed: readonly string[],
    path: string,
  ): void {
    for (const binding of relationships) {
      if (!allowed.includes(binding.relationship))
        throw new Error(
          `${path}.values: Relationship ${binding.relationship} is outside the D1 source capability set.`,
        );
    }
  }
}
