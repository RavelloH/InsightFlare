import {
  and,
  eq,
  filter,
  gte,
  inList,
  isNotNull,
  join,
  lt,
  neq,
  param,
  project,
  scan,
  semiJoin,
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
  semanticAttribute,
  semanticObservationAttributeCatalog,
} from "@/lib/edge/analytics/engine/semantic/attributes";
import type { SemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";

import {
  type NativePrimitiveFieldContract,
  nativePrimitiveFieldContract,
} from "./analytics-primitive-predicate-lowering";

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
      readonly entity: "observation" | "page" | "event" | "session";
      readonly keys: readonly AnyExpression[];
      readonly present: Predicate;
      readonly nullable: boolean;
      readonly candidateBounded: boolean;
    };

export interface LoweredAnalyticsSource {
  readonly relation: AnalyticsDbRelation;
  readonly values: ReadonlyMap<SlotId, AnalyticsSourceValue>;
}

export interface AnalyticsRelationalStorageContext {
  readonly siteId: string;
  readonly time: SemanticTemporalDomains;
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

/** D1-only physical carrier catalog for the currently proven Page/Event subset. */
export class AnalyticsRelationalStorage {
  readonly #siteId: string;
  readonly #time: SemanticTemporalDomains;
  #sitesCache?: AnalyticsDbRelation;
  readonly #sitePageCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #pageCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #eventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #namedEventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #ownedEventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #namedOwnedEventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #candidateObservationCarriers = new Map<
    string,
    AnalyticsDbRelation
  >();
  readonly #reportObservationCarriers = new Map<string, AnalyticsDbRelation>();

  constructor(context: AnalyticsRelationalStorageContext) {
    this.#siteId = context.siteId;
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
    for (const binding of attributes) {
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
    const identityAttributes = requiredAttributes
      .map((binding) => binding.attribute)
      .filter(isObservationIdentityAttribute);
    if (identityAttributes.length > 0 && node.entity !== "observation")
      throw new Error(
        `${path}.values: Raw identity attributes are available only on Observation.`,
      );
    const declaredContracts = attributes.flatMap((binding) => {
      if (isObservationReportAttribute(binding.attribute)) return [];
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
    const pageColumns = this.#requiredPageColumns(
      node,
      contracts,
      requiredSlots,
      identityAttributes,
    );
    const selfRequired = node.values.some(
      (binding) => binding.kind === "self" && requiredSlots.has(binding.slot),
    );
    const needsSessionRelation = relationships.some(
      (binding) =>
        binding.relationship === "observation.session" &&
        requiredSlots.has(binding.slot),
    );
    const needsOwnerJoin = relationships.some(
      (binding) => binding.relationship === "observation.session",
    );
    const includesOccurrenceTime = node.values.some(
      (binding) =>
        binding.kind === "occurrence-time" && requiredSlots.has(binding.slot),
    );
    const declaresOccurrenceTime = node.values.some(
      (binding) => binding.kind === "occurrence-time",
    );
    let carrier: AnalyticsDbRelation;
    let activity: "page" | "event" | "observation";
    if (node.entity === "page") {
      if (
        declaredContracts.some(({ contract }) => contract.activity !== "page")
      )
        throw new Error(
          `${path}.values: A Page source cannot bind Event fields.`,
        );
      this.#requireRelationships(relationships, ["page.session"], path);
      activity = "page";
      carrier = this.#pages(node.temporalDomain, pageColumns);
    } else if (node.entity === "event") {
      if (
        declaredContracts.some(({ contract }) => contract.activity !== "event")
      )
        throw new Error(
          `${path}.values: An Event source cannot bind Page fields.`,
        );
      this.#requireRelationships(relationships, ["event.observation"], path);
      activity = "event";
      carrier =
        contracts.length > 0
          ? this.#eventsWithName(node.temporalDomain)
          : this.#events(node.temporalDomain);
    } else if (node.entity === "observation") {
      this.#requireRelationships(relationships, ["observation.session"], path);
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
          includeOccurrenceTime: includesOccurrenceTime,
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
          identityAttributes,
        });
      } else if (fieldActivity === "page") {
        // Source bindings and the registered native field contract, rather
        // than a parent Filter or metric shape, select native Page evidence.
        activity = "page";
        carrier = this.#pages(node.temporalDomain, pageColumns);
      } else {
        activity = "event";
        const ownerIdentityColumns = this.#ownerIdentityColumns(
          identityAttributes,
          needsSessionRelation,
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
              )
            : this.#eventsWithName(node.temporalDomain)
          : includeOwner
            ? this.#eventsWithOwner(node.temporalDomain, ownerIdentityColumns)
            : this.#events(node.temporalDomain);
      }
    } else {
      throw new Error(
        `${path}.entity: D1 lowering currently supports Page, Event, and Observation carriers only.`,
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
            : param(activity);
        values.set(binding.slot, {
          kind: "entity",
          entity,
          keys:
            entity === "observation"
              ? [sitePk, observationKind, localId]
              : [sitePk, localId],
          present: isNotNull(sitePk),
          nullable: false,
          candidateBounded: node.temporalDomain === "candidate",
        });
      } else if (binding.kind === "related-entity") {
        switch (binding.relationship) {
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
          default:
            throw new Error(
              `${path}.values: Relationship ${binding.relationship} has no D1 source mapping.`,
            );
        }
      } else if (binding.kind === "attribute") {
        if (isObservationIdentityAttribute(binding.attribute)) {
          if (node.entity !== "observation")
            throw new Error(
              `${path}.values: Raw identity attributes are available only on Observation.`,
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
        requireStorageTextColumn(fieldColumn, binding.attribute);
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
      inList(identities.columns.site_id, [this.#siteId]),
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
    const joined = join(
      events,
      pages,
      and(
        eq(events.columns.site_pk, pages.columns.site_pk),
        eq(events.columns.visit_id, pages.columns.visit_id),
      ),
    );
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
    const names = scan(schema.custom_event_names);
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
      )
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
      switch (contract.compilerStrategy) {
        case "column.pathname":
          columns.add("pathname");
          break;
        case "column.title":
          columns.add("title");
          break;
        case "column.query_string":
          columns.add("query_string");
          break;
        case "column.hash_fragment":
          columns.add("hash_fragment");
          break;
        default:
          break;
      }
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
  ): ("session_id" | "visitor_id")[] {
    const requested = new Set(attributes);
    const columns: ("session_id" | "visitor_id")[] = [];
    if (includeSession || requested.has("observation.sessionId"))
      columns.push("session_id");
    if (requested.has("observation.visitorId")) columns.push("visitor_id");
    return columns;
  }

  #eventsWithOwner(
    domain: SourceNode["temporalDomain"],
    ownerColumns: readonly string[],
    allowRetainedHistory = false,
  ): AnalyticsDbRelation {
    const canonicalColumns = [...new Set(ownerColumns)].sort();
    const cacheKey = JSON.stringify([
      domain,
      allowRetainedHistory,
      canonicalColumns,
    ]);
    const existing = this.#ownedEventCarriers.get(cacheKey);
    if (existing) return existing;
    const carrier = this.#attachOwner(
      this.#events(domain, allowRetainedHistory),
      canonicalColumns,
    );
    this.#ownedEventCarriers.set(cacheKey, carrier);
    return carrier;
  }

  #eventsWithNameAndOwner(
    domain: SourceNode["temporalDomain"],
    ownerColumns: readonly string[],
  ): AnalyticsDbRelation {
    const canonicalColumns = [...new Set(ownerColumns)].sort();
    const cacheKey = `${String(domain)}:${canonicalColumns.join(",")}`;
    const existing = this.#namedOwnedEventCarriers.get(cacheKey);
    if (existing) return existing;
    const carrier = this.#attachOwner(
      this.#eventsWithName(domain),
      canonicalColumns,
    );
    this.#namedOwnedEventCarriers.set(cacheKey, carrier);
    return carrier;
  }

  #candidateObservations(input: {
    readonly includeIdentity: boolean;
    readonly includeSession: boolean;
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
      identityAttributes,
    ]);
    const existing = this.#candidateObservationCarriers.get(cacheKey);
    if (existing) return existing;
    const ownerIdentityColumns = this.#ownerIdentityColumns(
      identityAttributes,
      input.includeSession,
    );
    const pageColumns = [
      ...(input.includeSession ||
      identityAttributes.includes("observation.sessionId")
        ? (["session_id"] as const)
        : []),
      ...(identityAttributes.includes("observation.visitorId")
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
      ownerIdentityColumns.length > 0
        ? this.#eventsWithOwner("candidate", ownerIdentityColumns)
        : this.#attachOwner(this.#events("candidate"), ownerIdentityColumns);
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
    readonly includeOccurrenceTime: boolean;
  }): AnalyticsDbRelation {
    const attributes = [...new Set(input.attributes)].sort();
    const cacheKey = JSON.stringify([
      input.domain,
      attributes,
      input.includeIdentity,
      input.includeSession,
      input.includeOccurrenceTime,
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
    if (attributes.includes("observation.visitorId"))
      pageColumns.add("visitor_id");
    for (const attribute of attributes) {
      const physical = observationReportColumnByAttribute[attribute];
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
    );
    let events = this.#eventsWithOwner(input.domain, ownerColumns, true);
    if (attributes.includes("observation.eventName"))
      events = this.#attachReportName(events);
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
  ): string[] {
    const columns = new Set<string>();
    if (includeSession) columns.add("session_id");
    for (const attribute of attributes) {
      if (
        attribute === "observation.id" ||
        attribute === "observation.kind" ||
        attribute === "observation.eventId" ||
        attribute === "observation.eventName" ||
        attribute === "observation.visitId" ||
        this.#eventReportValueIsNull(attribute)
      )
        continue;
      const physical = observationReportColumnByAttribute[attribute];
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
      attribute === "observation.eventName"
    )
      return param(null);
    const physical = observationReportColumnByAttribute[attribute];
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
    if (attribute === "observation.eventName")
      return column(events, "event_name");
    if (attribute === "observation.visitId") return column(events, "visit_id");
    if (this.#eventReportValueIsNull(attribute)) return param(null);
    const physical = observationReportColumnByAttribute[attribute];
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
    const name =
      strategy === "column.pathname"
        ? "pathname"
        : strategy === "column.title"
          ? "title"
          : strategy === "column.query_string"
            ? "query_string"
            : strategy === "column.hash_fragment"
              ? "hash_fragment"
              : strategy === "event.name"
                ? "event_name"
                : undefined;
    if (!name)
      throw new Error(
        `${path}.values: Unsupported field strategy ${strategy}.`,
      );
    const expression = column(source, name);
    requireStorageTextColumn(expression, fieldId);
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
