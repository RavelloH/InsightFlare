import {
  and,
  coalesce,
  constant,
  eq,
  filter,
  gte,
  inList,
  isNotNull,
  join,
  limit,
  lt,
  neq,
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
import type { SemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

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
  const sqliteIntegerPrimaryKeyIsNonNullByDefinition =
    attributeId === "event.report.internalPk" &&
    expression.resultType.affinity === "integer";
  if (
    !affinityMatches ||
    (expression.resultType.nullable &&
      !attribute.nullable &&
      !sqliteIntegerPrimaryKeyIsNonNullByDefinition)
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

  lowerSource(
    node: SourceNode,
    path: string,
    requiredSlots: ReadonlySet<SlotId> = new Set(node.output),
  ): LoweredAnalyticsSource {
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
        ["page.observation", "page.session"],
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
      if (
        declaredContracts.some(({ contract }) => contract.activity !== "event")
      )
        throw new Error(
          `${path}.values: An Event source cannot bind Page fields.`,
        );
      this.#requireRelationships(relationships, ["event.observation"], path);
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
        node.selection !== undefined
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
          attributes: requiredEventReportAttributes,
          ownerPageAttributes,
          // A selected Event report has a fixed legacy row domain even when
          // the output demand is only a count or a narrow identity projection.
          // Keep the ID-only name and same-site owner carriers inside the
          // Source relation without exposing them as required output slots.
          includeName:
            node.selection !== undefined ||
            requiredEventReportAttributes.includes("event.report.eventName"),
          includeOwner: node.selection !== undefined || needsOwner,
          includeIdentity:
            node.selection !== undefined ||
            selfRequired ||
            relationships.some(
              (binding) =>
                binding.relationship === "event.observation" &&
                requiredSlots.has(binding.slot),
            ),
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
          // SQLite INTEGER PRIMARY KEY aliases the rowid and is non-NULL by
          // table invariant even though PRAGMA reports it as nullable.
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

    return { relation: carrier, values };
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
  ): AnalyticsDbRelation {
    const columns = [...new Set(["site_pk", ...requiredColumns])].sort();
    const cacheKey = `${String(domain)}:${allowRetainedHistory}:${columns.join(",")}`;
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
      input.allowRetainedHistory,
    ]);
    const existing = this.#eventReportCarriers.get(cacheKey);
    if (existing) return existing;

    const eventColumns = new Set<string>(["occurred_at"]);
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

  #eventPrimaryKey(
    expression: AnyExpression,
    path: string,
  ): SqlExpression<number, ExpressionResultType<"integer", false>> {
    if (expression.resultType.affinity !== "integer")
      throw new Error(
        `${path}.values: Event internal primary key must remain an INTEGER.`,
      );
    // PRAGMA marks INTEGER PRIMARY KEY as nullable; SQLite guarantees the
    // rowid alias is present. COALESCE only carries that invariant into the
    // Generic expression type and is value-preserving for valid rows.
    return coalesce(
      expression as SqlExpression<
        number | null,
        ExpressionResultType<"integer", true>
      >,
      constant(0),
    ) as SqlExpression<number, ExpressionResultType<"integer", false>>;
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
  ): AnalyticsDbRelation {
    const cacheKey = `${String(domain)}:${allowRetainedHistory}`;
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
    const carrier = project(ranged, {
      site_pk: ranged.columns.left_site_pk,
      site_id: ranged.columns.left_site_id,
      event_id: ranged.columns.left_event_id,
      visit_id: ranged.columns.left_visit_id,
      event_name_id: ranged.columns.left_event_name_id,
      occurred_at: ranged.columns.left_occurred_at,
    });
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
  ): AnalyticsDbRelation {
    const canonicalColumns = [...new Set(ownerColumns)].sort();
    const cacheKey = JSON.stringify([
      domain,
      allowRetainedHistory,
      canonicalColumns,
      optionalOwner,
    ]);
    const existing = this.#ownedEventCarriers.get(cacheKey);
    if (existing) return existing;
    const events = this.#events(domain, allowRetainedHistory);
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
      const physical = observationReportColumn(attribute);
      if (physical) pageColumns.add(physical);
    }

    const pages = this.#pages(input.domain, [...pageColumns], true);
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
      ? this.#events(input.domain, true)
      : this.#eventsWithOwner(
          input.domain,
          ownerColumns,
          true,
          input.optionalOwner,
        );
    if (attributes.includes("observation.eventName"))
      events = this.#attachReportName(events);
    if (attributes.includes("observation.sameSiteEventName"))
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
        attribute === "observation.rawSiteId" ||
        attribute === "observation.visitId" ||
        this.#eventReportValueIsNull(attribute)
      )
        continue;
      const physical = observationReportColumn(attribute);
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
    if (attribute === "observation.eventName")
      return column(events, "event_name");
    if (attribute === "observation.visitId") return column(events, "visit_id");
    if (attribute === "observation.rawSiteId") return column(events, "site_id");
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
