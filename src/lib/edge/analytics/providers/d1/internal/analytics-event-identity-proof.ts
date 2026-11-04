import type { AnyExpression } from "@/lib/db/query/expression";
import { schema } from "@/lib/db/schema";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";

import type {
  AnalyticsDbRelation,
  AnalyticsSourceValue,
} from "./analytics-relational-storage";

/** A liveness request names a canonical Source/key slot, never a SQL expression. */
export interface AnalyticsProviderSourceBindingRequest {
  readonly kind: "event-payload-key";
  readonly id: string;
  readonly sourceId: RelationId;
  readonly eventKeySlot: SlotId;
  readonly includePayloadPropertiesMetadata?: true;
}

export type AnalyticsEventPayloadPropertiesMetadataField =
  "siteId" | "eventNameId" | "occurredAt" | "visitId";

export interface AnalyticsEventPayloadPropertiesMetadataColumns {
  readonly siteId: string;
  readonly eventNameId: string;
  readonly occurredAt: string;
  readonly visitId: string;
}

const eventPayloadPropertiesMetadataColumnAliases: Readonly<
  Record<AnalyticsEventPayloadPropertiesMetadataField, readonly string[]>
> = {
  siteId: ["site_id", "event_site_id"],
  eventNameId: ["event_name_id", "event_event_name_id"],
  occurredAt: ["occurred_at", "event_occurred_at"],
  visitId: ["visit_id", "event_visit_id"],
};

export function analyticsEventPayloadMetadataProviderId(
  requestId: string,
  field: AnalyticsEventPayloadPropertiesMetadataField,
): string {
  return JSON.stringify(["event-payload-metadata", requestId, field]);
}

/** Storage evidence for the private payload join key on one canonical Event row. */
export interface AnalyticsEventPayloadKeySourceBinding {
  readonly kind: "event-payload-key";
  readonly request: AnalyticsProviderSourceBindingRequest;
  readonly relation: AnalyticsDbRelation;
  readonly columns: {
    readonly eventPk: string;
    readonly sitePk: string;
    readonly eventId: string;
    readonly propertiesMetadata?:
      AnalyticsEventPayloadPropertiesMetadataColumns | undefined;
  };
  readonly eventPk: AnyExpression;
  /** Existing Logical projection to reuse when its PK slot is also live. */
  readonly reuseExpression?: AnyExpression | undefined;
  readonly sitePk: AnyExpression;
  readonly eventId: AnyExpression;
  readonly eventKey: AnalyticsSourceValue;
  readonly propertiesMetadata?: {
    readonly siteId: AnyExpression;
    readonly eventNameId: AnyExpression;
    readonly occurredAt: AnyExpression;
    readonly visitId: AnyExpression;
  };
  readonly schema: typeof schema.custom_events;
}

/** Source facts carried forward while a proven Event identity is projected. */
export interface AnalyticsEventDistinctIdentitySeed {
  readonly sourceBinding: AnalyticsEventPayloadKeySourceBinding;
  readonly sourceSignature: string;
  readonly sourceId: RelationId;
  readonly eventKeySlot: SlotId;
  readonly identitySlot: SlotId;
  readonly scopeRelation: RelationId;
  readonly inputRelation: AnalyticsDbRelation;
  readonly inputIdentityColumns: readonly [string, string];
  readonly inputDiscriminatorColumn: string;
}

/** Relation-scoped proof attached to a Provider SlotLayout after projection. */
export interface AnalyticsEventDistinctIdentityLayout {
  readonly sourceBinding: AnalyticsEventPayloadKeySourceBinding;
  readonly sourceSignature: string;
  readonly sourceId: RelationId;
  readonly eventKeySlot: SlotId;
  readonly identitySlot: SlotId;
  readonly scopeRelation: RelationId;
  readonly carrierRelation: AnalyticsDbRelation;
  readonly identityColumns: readonly [string, string];
  readonly discriminatorColumn: string;
}

export interface AnalyticsEventPayloadOccurrenceJoinIdentity {
  readonly eventPk: AnyExpression;
  readonly sitePk: AnyExpression;
  readonly eventId: AnyExpression;
  readonly includeDistinctIdentity: boolean;
}

/** Re-check the generated storage contract when a key proof is consumed. */
export function assertAnalyticsEventPayloadKeySchema(
  evidence: typeof schema.custom_events,
  path: string,
): void {
  const table = schema.custom_events;
  const eventPk = table.columns.event_pk;
  const eventId = table.columns.event_id;
  const sitePk = table.columns.site_pk;
  const siteId = table.columns.site_id;
  const visitId = table.columns.visit_id;
  const eventNameId = table.columns.event_name_id;
  const occurredAt = table.columns.occurred_at;
  const uniqueEventId = table.indexes.some(
    (index) =>
      index.unique &&
      !index.partial &&
      index.columns.length === 1 &&
      index.columns[0] === "event_id",
  );
  if (
    evidence !== table ||
    table.kind !== "table" ||
    table.name !== "custom_events" ||
    table.primaryKey.length !== 1 ||
    table.primaryKey[0] !== "event_pk" ||
    eventPk.table !== "custom_events" ||
    eventPk.sqlName !== "event_pk" ||
    eventPk.affinity !== "integer" ||
    eventPk.nullable ||
    !eventPk.rowidAlias ||
    eventPk.primaryKeyPosition !== 1 ||
    eventId.table !== "custom_events" ||
    eventId.sqlName !== "event_id" ||
    eventId.affinity !== "text" ||
    eventId.nullable ||
    !uniqueEventId ||
    sitePk.table !== "custom_events" ||
    sitePk.sqlName !== "site_pk" ||
    sitePk.affinity !== "integer" ||
    sitePk.nullable ||
    siteId.table !== "custom_events" ||
    siteId.sqlName !== "site_id" ||
    siteId.affinity !== "text" ||
    siteId.nullable ||
    visitId.table !== "custom_events" ||
    visitId.sqlName !== "visit_id" ||
    visitId.affinity !== "text" ||
    visitId.nullable ||
    eventNameId.table !== "custom_events" ||
    eventNameId.sqlName !== "event_name_id" ||
    eventNameId.affinity !== "integer" ||
    eventNameId.nullable ||
    occurredAt.table !== "custom_events" ||
    occurredAt.sqlName !== "occurred_at" ||
    occurredAt.affinity !== "integer" ||
    occurredAt.nullable
  )
    throw new Error(`${path}: Event payload key schema evidence is invalid.`);
}

function hasCurrentPropertiesMetadataColumnProof(
  binding: AnalyticsEventPayloadKeySourceBinding,
): boolean {
  const metadata = binding.propertiesMetadata;
  const columns = binding.columns.propertiesMetadata;
  if (!metadata || !columns)
    return metadata === undefined && columns === undefined;
  return (["siteId", "eventNameId", "occurredAt", "visitId"] as const).every(
    (field) => {
      const name = columns[field];
      return (
        eventPayloadPropertiesMetadataColumnAliases[field].includes(name) &&
        binding.relation.columns[name] === metadata[field]
      );
    },
  );
}

export function assertAnalyticsEventPayloadKeySourceBinding(
  binding: AnalyticsEventPayloadKeySourceBinding,
  path: string,
): void {
  assertAnalyticsEventPayloadKeySchema(binding.schema, path);
  if (
    binding.kind !== "event-payload-key" ||
    binding.request.kind !== "event-payload-key" ||
    !binding.request.id ||
    binding.request.sourceId === undefined ||
    binding.request.eventKeySlot === undefined ||
    binding.relation.columns[binding.columns.eventPk] !== binding.eventPk ||
    binding.relation.columns[binding.columns.sitePk] !== binding.sitePk ||
    binding.relation.columns[binding.columns.eventId] !== binding.eventId ||
    binding.eventKey.kind !== "entity" ||
    binding.eventKey.entity !== "event" ||
    binding.eventKey.nullable ||
    binding.eventKey.keys.length !== 2 ||
    binding.eventKey.keys[0] !== binding.sitePk ||
    binding.eventKey.keys[1] !== binding.eventId ||
    binding.eventPk.resultType.affinity !== "integer" ||
    binding.eventPk.resultType.nullable ||
    binding.sitePk.resultType.affinity !== "integer" ||
    binding.sitePk.resultType.nullable ||
    binding.eventId.resultType.affinity !== "text" ||
    binding.eventId.resultType.nullable ||
    (binding.request.includePayloadPropertiesMetadata === true) !==
      (binding.propertiesMetadata !== undefined) ||
    (binding.request.includePayloadPropertiesMetadata === true) !==
      (binding.columns.propertiesMetadata !== undefined) ||
    !hasCurrentPropertiesMetadataColumnProof(binding) ||
    (binding.propertiesMetadata !== undefined &&
      (binding.propertiesMetadata.siteId.resultType.affinity !== "text" ||
        binding.propertiesMetadata.siteId.resultType.nullable ||
        binding.propertiesMetadata.eventNameId.resultType.affinity !==
          "integer" ||
        binding.propertiesMetadata.eventNameId.resultType.nullable ||
        binding.propertiesMetadata.occurredAt.resultType.affinity !==
          "integer" ||
        binding.propertiesMetadata.occurredAt.resultType.nullable ||
        binding.propertiesMetadata.visitId.resultType.affinity !== "text" ||
        binding.propertiesMetadata.visitId.resultType.nullable))
  )
    throw new Error(`${path}: Provider Event payload key binding is invalid.`);
}

export function assertAnalyticsEventDistinctIdentitySeed(
  seed: AnalyticsEventDistinctIdentitySeed,
  providerId: string,
  identitySlot: SlotId,
  scopeRelation: RelationId,
  input: AnalyticsDbRelation,
  entity: Extract<AnalyticsSourceValue, { readonly kind: "entity" }>,
  discriminator: AnyExpression,
  path: string,
): void {
  assertAnalyticsEventPayloadKeySourceBinding(seed.sourceBinding, path);
  const sitePk = input.columns[seed.inputIdentityColumns[0]];
  const eventId = input.columns[seed.inputIdentityColumns[1]];
  const inputDiscriminator = input.columns[seed.inputDiscriminatorColumn];
  if (
    seed.sourceSignature.length === 0 ||
    seed.sourceId !== seed.sourceBinding.request.sourceId ||
    seed.eventKeySlot !== seed.sourceBinding.request.eventKeySlot ||
    seed.identitySlot !== identitySlot ||
    seed.scopeRelation !== scopeRelation ||
    seed.inputRelation !== input ||
    seed.sourceBinding.request.id !== providerId ||
    entity.entity !== "event" ||
    entity.nullable ||
    entity.keys.length !== 2 ||
    !sitePk ||
    !eventId ||
    !inputDiscriminator ||
    entity.keys[0] !== sitePk ||
    entity.keys[1] !== eventId ||
    discriminator !== inputDiscriminator ||
    sitePk.resultType.affinity !== "integer" ||
    sitePk.resultType.nullable ||
    eventId.resultType.affinity !== "text" ||
    eventId.resultType.nullable ||
    discriminator.resultType.affinity !== "integer" ||
    discriminator.resultType.nullable
  )
    throw new Error(
      `${path}: Event identity projection does not match its source proof.`,
    );
}

export function assertAnalyticsEventDistinctIdentityLayout(
  proof: AnalyticsEventDistinctIdentityLayout,
  current: {
    readonly scopeRelation: RelationId;
    readonly identitySlot: SlotId;
    readonly relation: AnalyticsDbRelation;
    readonly identityColumns: readonly string[];
    readonly keys: readonly AnyExpression[];
  },
  path: string,
): AnyExpression {
  assertAnalyticsEventPayloadKeySourceBinding(proof.sourceBinding, path);
  const sitePk = current.relation.columns[proof.identityColumns[0]];
  const eventId = current.relation.columns[proof.identityColumns[1]];
  const discriminator = current.relation.columns[proof.discriminatorColumn];
  if (
    proof.sourceSignature.length === 0 ||
    proof.sourceId !== proof.sourceBinding.request.sourceId ||
    proof.eventKeySlot !== proof.sourceBinding.request.eventKeySlot ||
    proof.identitySlot !== current.identitySlot ||
    proof.scopeRelation !== current.scopeRelation ||
    proof.carrierRelation !== current.relation ||
    proof.identityColumns.length !== 2 ||
    current.identityColumns.length !== 2 ||
    proof.identityColumns[0] !== current.identityColumns[0] ||
    proof.identityColumns[1] !== current.identityColumns[1] ||
    current.keys.length !== 2 ||
    !sitePk ||
    !eventId ||
    !discriminator ||
    current.keys[0] !== sitePk ||
    current.keys[1] !== eventId ||
    sitePk.resultType.affinity !== "integer" ||
    sitePk.resultType.nullable ||
    eventId.resultType.affinity !== "text" ||
    eventId.resultType.nullable ||
    discriminator.resultType.affinity !== "integer" ||
    discriminator.resultType.nullable
  )
    throw new Error(
      `${path}: Event identity proof does not match its current relation scope.`,
    );
  return discriminator;
}
