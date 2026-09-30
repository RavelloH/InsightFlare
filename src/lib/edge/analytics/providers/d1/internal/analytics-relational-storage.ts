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

function column(relation: AnalyticsDbRelation, name: string): AnyExpression {
  const expression = relation.columns[name];
  if (!expression)
    throw new Error(`Missing D1 storage projection ${JSON.stringify(name)}.`);
  return expression;
}

function requireStorageTextColumn(
  expression: AnyExpression,
  fieldId: string,
): void {
  if (
    expression.resultType.affinity !== "text" ||
    expression.resultType.nullable
  ) {
    throw new Error(
      `Registered field ${fieldId} no longer maps to a non-null D1 TEXT column.`,
    );
  }
}

/** D1-only physical carrier catalog for the currently proven Page/Event subset. */
export class AnalyticsRelationalStorage {
  readonly #siteId: string;
  readonly #time: SemanticTemporalDomains;
  #sitesCache?: AnalyticsDbRelation;
  #pagesCache?: AnalyticsDbRelation;
  readonly #pageCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #eventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #namedEventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #ownedEventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #namedOwnedEventCarriers = new Map<string, AnalyticsDbRelation>();
  readonly #candidateObservationCarriers = new Map<
    boolean,
    AnalyticsDbRelation
  >();

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
    const contracts = attributes.map((binding) => {
      const contract = nativePrimitiveFieldContract(binding.attribute);
      if (!contract)
        throw new Error(
          `${path}.values: No registered D1 primitive storage mapping exists for ${binding.attribute}.`,
        );
      return { binding, contract };
    });
    const pageColumns = this.#requiredPageColumns(
      node,
      contracts,
      requiredSlots,
    );
    let carrier: AnalyticsDbRelation;
    let activity: "page" | "event" | "observation";
    if (node.entity === "page") {
      if (contracts.some(({ contract }) => contract.activity !== "page"))
        throw new Error(
          `${path}.values: A Page source cannot bind Event fields.`,
        );
      this.#requireRelationships(relationships, ["page.session"], path);
      activity = "page";
      carrier = this.#pages(node.temporalDomain, pageColumns);
    } else if (node.entity === "event") {
      if (contracts.some(({ contract }) => contract.activity !== "event"))
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
      const fieldActivity = contracts[0]?.contract.activity;
      if (
        contracts.some(({ contract }) => contract.activity !== fieldActivity)
      ) {
        throw new Error(
          `${path}.values: Mixed Page/Event bindings do not define one native Observation carrier.`,
        );
      }
      if (fieldActivity === undefined) {
        if (node.temporalDomain !== "candidate")
          throw new Error(
            `${path}.temporalDomain: An unqualified Observation source is supported only for the candidate Page/Event union.`,
          );
        activity = "observation";
        carrier = this.#candidateObservations(
          node.values.some(
            (binding) =>
              binding.kind === "self" && requiredSlots.has(binding.slot),
          ),
        );
      } else if (fieldActivity === "page") {
        // Source bindings and the registered native field contract, rather
        // than a parent Filter or metric shape, select native Page evidence.
        activity = "page";
        carrier = this.#pages(node.temporalDomain, pageColumns);
      } else {
        activity = "event";
        const needsSession = relationships.some(
          (binding) => binding.relationship === "observation.session",
        );
        carrier = contracts.some(
          ({ binding }) => binding.attribute === "event.name",
        )
          ? needsSession
            ? this.#eventsWithNameAndOwner(node.temporalDomain)
            : this.#eventsWithName(node.temporalDomain)
          : needsSession
            ? this.#eventsWithOwner(node.temporalDomain)
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
      } else {
        throw new Error(
          `${path}.values: Occurrence-time bindings are outside the current D1 capability set.`,
        );
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

  #sitePages(): AnalyticsDbRelation {
    if (this.#pagesCache) return this.#pagesCache;
    const source = scan(schema.visits);
    const pages = project(source, {
      site_pk: source.columns.site_pk,
      visit_id: source.columns.visit_id,
      session_id: source.columns.session_id,
      visitor_id: source.columns.visitor_id,
    });
    const sites = this.#sites();
    const scoped = join(
      pages,
      sites,
      eq(pages.columns.site_pk, sites.columns.site_pk),
    );
    const validIds = filter(scoped, isNotNull(scoped.columns.left_visit_id));
    this.#pagesCache = project(validIds, {
      site_pk: validIds.columns.left_site_pk,
      visit_id: validIds.columns.left_visit_id,
      session_id: validIds.columns.left_session_id,
      visitor_id: validIds.columns.left_visitor_id,
    });
    return this.#pagesCache;
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

  #attachOwner(events: AnalyticsDbRelation): AnalyticsDbRelation {
    const pages = this.#sitePages();
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
      owner_session_id: joined.columns.right_session_id,
      owner_visitor_id: joined.columns.right_visitor_id,
    };
    if (joined.columns.left_event_name)
      projections.event_name = joined.columns.left_event_name;
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
  ): AnalyticsDbRelation {
    const columns = [...new Set(["site_pk", ...requiredColumns])].sort();
    const cacheKey = `${String(domain)}:${columns.join(",")}`;
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

  #events(domain: SourceNode["temporalDomain"]): AnalyticsDbRelation {
    const existing = this.#eventCarriers.get(domain);
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
    );
    const carrier = project(ranged, {
      site_pk: ranged.columns.left_site_pk,
      site_id: ranged.columns.left_site_id,
      event_id: ranged.columns.left_event_id,
      visit_id: ranged.columns.left_visit_id,
      event_name_id: ranged.columns.left_event_name_id,
      occurred_at: ranged.columns.left_occurred_at,
    });
    this.#eventCarriers.set(domain, carrier);
    return carrier;
  }

  #eventsWithName(domain: SourceNode["temporalDomain"]): AnalyticsDbRelation {
    const existing = this.#namedEventCarriers.get(domain);
    if (existing) return existing;
    const carrier = this.#attachName(this.#events(domain));
    this.#namedEventCarriers.set(domain, carrier);
    return carrier;
  }

  #eventsWithOwner(domain: SourceNode["temporalDomain"]): AnalyticsDbRelation {
    const existing = this.#ownedEventCarriers.get(domain);
    if (existing) return existing;
    const carrier = this.#attachOwner(this.#events(domain));
    this.#ownedEventCarriers.set(domain, carrier);
    return carrier;
  }

  #eventsWithNameAndOwner(
    domain: SourceNode["temporalDomain"],
  ): AnalyticsDbRelation {
    const existing = this.#namedOwnedEventCarriers.get(domain);
    if (existing) return existing;
    const carrier = this.#attachOwner(this.#eventsWithName(domain));
    this.#namedOwnedEventCarriers.set(domain, carrier);
    return carrier;
  }

  #candidateObservations(includeIdentity: boolean): AnalyticsDbRelation {
    const existing = this.#candidateObservationCarriers.get(includeIdentity);
    if (existing) return existing;
    const pages = this.#pages("candidate", [
      "session_id",
      ...(includeIdentity ? ["visit_id"] : []),
    ]);
    const pageProjections: Record<string, AnyExpression> = {
      site_pk: pages.columns.site_pk,
      session_site_pk: pages.columns.site_pk,
      session_id: pages.columns.session_id,
      session_present: this.#sessionPresent(pages.columns.session_id),
    };
    if (includeIdentity) {
      pageProjections.observation_kind = param("page");
      pageProjections.observation_id = pages.columns.visit_id;
    }
    const pageRows = project(pages, pageProjections);

    const events = this.#eventsWithOwner("candidate");
    const eventProjections: Record<string, AnyExpression> = {
      site_pk: events.columns.site_pk,
      session_site_pk: events.columns.site_pk,
      session_id: events.columns.owner_session_id,
      session_present: this.#sessionPresent(events.columns.owner_session_id),
    };
    if (includeIdentity) {
      eventProjections.observation_kind = param("event");
      eventProjections.observation_id = events.columns.event_id;
    }
    const eventRows = project(events, eventProjections);
    // Observation is a bag of activity rows. Keep duplicate projected
    // session keys until an explicit Logical Distinct/Set node removes them.
    const carrier = union(pageRows, eventRows, true);
    this.#candidateObservationCarriers.set(includeIdentity, carrier);
    return carrier;
  }

  #inRange(
    source: AnalyticsDbRelation,
    domain: SourceNode["temporalDomain"],
    occurrence: AnyExpression,
  ): AnalyticsDbRelation {
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
