import { coalesce, constant, isNotNull } from "@/lib/db";
import { type AnyExpression } from "@/lib/db/query/expression";
import { type SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import { semanticAttribute } from "@/lib/edge/analytics/engine/semantic/attributes";
import {
  type AnalyticsEventPayloadKeySourceBinding,
  type AnalyticsEventPayloadPropertiesMetadataColumns,
  assertAnalyticsEventPayloadKeySchema,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-event-identity-proof";
import {
  type AnalyticsDbRelation,
  type AnalyticsSourceValue,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import { analyticsPageReportStorageColumn } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

import { nonemptyIdentity, relationColumn } from "./primitives";

export function eventAttributeColumn(
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
  if (attributeId === "event.report.internalPk") {
    const eventPk =
      relation.columns.event_pk ?? relation.columns.event_event_pk;
    return eventPk ? coalesce(eventPk, constant(0)) : undefined;
  }
  if (attributeId === "event.report.ownerPresent")
    return relation.columns.owner_site_pk
      ? isNotNull(relation.columns.owner_site_pk)
      : undefined;
  const direct = directColumns[attributeId];
  if (direct) {
    return relation.columns[direct] ?? relation.columns[`event_${direct}`];
  }

  const definition = semanticAttribute(attributeId);
  const derivation = definition?.derivation;
  if (
    derivation?.kind === "report-relationship" &&
    derivation.relationship === "event.ownerPage" &&
    derivation.sourceAttribute
  ) {
    const physicalName = analyticsPageReportStorageColumn(
      derivation.sourceAttribute,
    );
    if (!physicalName) return undefined;
    const column = relation.columns[`owner_${physicalName}`];
    if (column) return column;
  }
  return undefined;
}

export function pageAttributeColumn(
  attributeId: string,
  relation: AnalyticsDbRelation,
): AnyExpression | undefined {
  const physical = analyticsPageReportStorageColumn(attributeId);
  return physical ? relation.columns[`visit_${physical}`] : undefined;
}

export function remapPageSourceValues(
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
      value.entity === "page"
    ) {
      remapped.set(binding.slot, {
        ...value,
        keys: [relation.columns.site_pk!, relation.columns.visit_id!],
        present: isNotNull(relation.columns.site_pk!),
      });
      continue;
    }
    if (binding.kind === "attribute" && value.kind === "scalar") {
      const expression = pageAttributeColumn(binding.attribute, relation);
      if (!expression)
        throw new Error(
          `Scoped Page source cannot remap attribute ${binding.attribute}.`,
        );
      remapped.set(binding.slot, { ...value, value: expression });
      continue;
    }
    if (
      binding.kind === "related-entity" &&
      value.kind === "entity" &&
      ((binding.relationship === "page.session" &&
        value.entity === "session") ||
        (binding.relationship === "page.visitor" && value.entity === "visitor"))
    ) {
      const idColumn =
        binding.relationship === "page.session"
          ? relationColumn(relation, "visit_session_id")
          : relationColumn(relation, "visit_visitor_id");
      remapped.set(binding.slot, {
        ...value,
        keys: [relationColumn(relation, "site_pk"), idColumn],
        present: nonemptyIdentity(idColumn),
      });
      continue;
    }
    throw new Error(
      `Scoped Page source cannot remap the ${binding.kind} binding for ${String(binding.slot)}.`,
    );
  }
  return remapped;
}

export function remapEventSourceValues(
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
    if (
      binding.kind === "related-entity" &&
      value.kind === "entity" &&
      ((binding.relationship === "event.session" &&
        value.entity === "session") ||
        (binding.relationship === "event.visitor" &&
          value.entity === "visitor"))
    ) {
      const idColumn = relationColumn(
        relation,
        binding.relationship === "event.session"
          ? "owner_session_id"
          : "owner_visitor_id",
      );
      remapped.set(binding.slot, {
        ...value,
        keys: [relationColumn(relation, "site_pk"), idColumn],
        present: nonemptyIdentity(idColumn),
      });
      continue;
    }
    throw new Error(
      `Scoped Event source cannot remap the ${binding.kind} binding for ${String(binding.slot)}.`,
    );
  }
  return remapped;
}

export const EVENT_REPORT_PROPERTIES_METADATA_COLUMNS: AnalyticsEventPayloadPropertiesMetadataColumns =
  {
    siteId: "site_id",
    eventNameId: "event_name_id",
    occurredAt: "occurred_at",
    visitId: "visit_id",
  };

export const POST_OBSERVATION_EVENT_PROPERTIES_METADATA_COLUMNS: AnalyticsEventPayloadPropertiesMetadataColumns =
  {
    siteId: "event_site_id",
    eventNameId: "event_event_name_id",
    occurredAt: "event_occurred_at",
    visitId: "event_visit_id",
  };

export function remapEventPayloadKeyBindings(
  node: SourceNode,
  path: string,
  relation: AnalyticsDbRelation,
  values: ReadonlyMap<
    SourceNode["values"][number]["slot"],
    AnalyticsSourceValue
  >,
  bindings: readonly AnalyticsEventPayloadKeySourceBinding[],
  metadataColumnNames: AnalyticsEventPayloadPropertiesMetadataColumns,
): readonly AnalyticsEventPayloadKeySourceBinding[] {
  return bindings.map((binding) => {
    assertAnalyticsEventPayloadKeySchema(binding.schema, path);
    const eventPkColumn = relation.columns.event_pk
      ? "event_pk"
      : relation.columns.event_event_pk
        ? "event_event_pk"
        : undefined;
    const eventIdColumn = relation.columns.event_id
      ? "event_id"
      : relation.columns.event_event_id
        ? "event_event_id"
        : undefined;
    const eventPk = eventPkColumn ? relation.columns[eventPkColumn] : undefined;
    const eventId = eventIdColumn ? relation.columns[eventIdColumn] : undefined;
    const sitePk = relation.columns.site_pk;
    const eventKey = values.get(binding.request.eventKeySlot);
    const eventPkSlot = node.values.find(
      (candidate) =>
        candidate.kind === "attribute" &&
        candidate.attribute === "event.report.internalPk",
    )?.slot;
    const reuseValue =
      eventPkSlot === undefined ? undefined : values.get(eventPkSlot);
    if (
      !eventPk ||
      !eventId ||
      !sitePk ||
      !eventKey ||
      eventKey.kind !== "entity" ||
      eventKey.entity !== "event" ||
      eventKey.nullable ||
      eventKey.keys.length !== 2 ||
      eventKey.keys[0] !== sitePk ||
      eventKey.keys[1] !== eventId ||
      eventPk.resultType.affinity !== "integer" ||
      eventPk.resultType.nullable ||
      eventId.resultType.affinity !== "text" ||
      eventId.resultType.nullable ||
      sitePk.resultType.affinity !== "integer" ||
      sitePk.resultType.nullable
    )
      throw new Error(
        `${path}: Selected Event key carrier no longer maps the canonical Event row.`,
      );
    const currentMetadataColumn = (name: string, field: string): string => {
      if (!relation.columns[name])
        throw new Error(
          `${path}: Selected Event source is missing its current ${field} Properties metadata column (${name}).`,
        );
      return name;
    };
    const propertiesMetadataColumns =
      binding.request.includePayloadPropertiesMetadata === true
        ? {
            siteId: currentMetadataColumn(metadataColumnNames.siteId, "siteId"),
            eventNameId: currentMetadataColumn(
              metadataColumnNames.eventNameId,
              "eventNameId",
            ),
            occurredAt: currentMetadataColumn(
              metadataColumnNames.occurredAt,
              "occurredAt",
            ),
            visitId: currentMetadataColumn(
              metadataColumnNames.visitId,
              "visitId",
            ),
          }
        : undefined;
    const propertiesMetadata = propertiesMetadataColumns
      ? {
          siteId: relation.columns[propertiesMetadataColumns.siteId]!,
          eventNameId: relation.columns[propertiesMetadataColumns.eventNameId]!,
          occurredAt: relation.columns[propertiesMetadataColumns.occurredAt]!,
          visitId: relation.columns[propertiesMetadataColumns.visitId]!,
        }
      : undefined;
    return {
      ...binding,
      relation,
      columns: {
        eventPk: eventPkColumn!,
        sitePk: "site_pk",
        eventId: eventIdColumn!,
        ...(propertiesMetadataColumns
          ? { propertiesMetadata: propertiesMetadataColumns }
          : {}),
      },
      eventPk,
      reuseExpression:
        reuseValue?.kind === "scalar" ? reuseValue.value : undefined,
      sitePk,
      eventId,
      eventKey,
      ...(propertiesMetadata ? { propertiesMetadata } : {}),
    };
  });
}
