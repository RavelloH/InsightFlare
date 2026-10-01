import {
  analyticsFilterRegistry,
  type AnalyticsFilterRegistryField,
  type FilterNativeEntity,
  type FilterObservationKind,
} from "@/lib/filter-contract/filter-registry";

import type { AnalyticsEntityKind, ObservationKind } from "./entities";
import type {
  LogicalValueType,
  SemanticScalarType,
  SemanticUnit,
} from "./value-types";

export type SemanticAttributeId = string;

export type SemanticDerivation = {
  readonly kind: "semantic-function";
  readonly function:
    "traffic-channel" | "browser-engine" | "os-version" | "screen-size";
  readonly dependencies: readonly SemanticAttributeId[];
};

export interface SemanticAttributeDefinition {
  readonly id: SemanticAttributeId;
  readonly valueType: LogicalValueType;
  readonly nativeEntity: AnalyticsEntityKind;
  readonly observationKinds: readonly ObservationKind[];
  readonly nullable: boolean;
  readonly evaluation:
    | "observation"
    | "session-fact"
    | "visitor-fact"
    | "event-payload"
    | "derived";
  readonly presence: "non-null" | "derived-value" | "json-path";
  readonly empty: "empty-string-is-value" | "unsupported";
  readonly comparison: "case-sensitive" | "case-insensitive";
  readonly derivation?: SemanticDerivation;
}

const nativeEntityByFilterEntity: Readonly<
  Record<FilterNativeEntity, AnalyticsEntityKind>
> = {
  visit: "page",
  event: "event",
  session: "session",
  visitor: "visitor",
};

const observationKindByFilterKind: Readonly<
  Record<FilterObservationKind, ObservationKind>
> = {
  visit: "page",
  event: "event",
};

const scalarTypeByFilterKind: Readonly<
  Record<AnalyticsFilterRegistryField["valueKind"], SemanticScalarType>
> = {
  string: "string",
  enum: "string",
  number: "number",
  boolean: "boolean",
  date: "date",
  datetime: "datetime",
  "json-scalar": "json-scalar",
};

const derivationByAttribute: Readonly<Record<string, SemanticDerivation>> = {
  "traffic.channel": {
    kind: "semantic-function",
    function: "traffic-channel",
    dependencies: [
      "referrer.domain",
      "referrer.url",
      "utm.source",
      "utm.medium",
      "utm.campaign",
      "utm.term",
      "utm.content",
    ],
  },
  "client.browserEngine": {
    kind: "semantic-function",
    function: "browser-engine",
    dependencies: ["client.browser"],
  },
  "client.osVersion": {
    kind: "semantic-function",
    function: "os-version",
    dependencies: ["client.os"],
  },
  "client.screenSize": {
    kind: "semantic-function",
    function: "screen-size",
    dependencies: ["client.screenWidth", "client.screenHeight"],
  },
};

function semanticType(field: AnalyticsFilterRegistryField): LogicalValueType {
  const scalar = scalarTypeByFilterKind[field.valueKind];
  const unit = field.unit as SemanticUnit | undefined;
  return {
    kind: "scalar",
    scalar,
    ...(unit ? { unit } : {}),
  };
}

function freezeAttribute(
  field: AnalyticsFilterRegistryField,
): SemanticAttributeDefinition {
  const presenceByFilterSemantics = {
    "non-null-column": "non-null",
    "derived-session-value": "derived-value",
    "json-pointer": "json-path",
  } as const;
  const emptyByFilterSemantics = {
    "raw-empty-string": "empty-string-is-value",
    unsupported: "unsupported",
  } as const;
  const observationKinds = [...field.observationKinds]
    .map((kind) => observationKindByFilterKind[kind])
    .sort();
  const derivation = derivationByAttribute[field.id];
  return Object.freeze({
    id: field.id,
    valueType: Object.freeze(semanticType(field)),
    nativeEntity: nativeEntityByFilterEntity[field.nativeEntity],
    observationKinds: Object.freeze(observationKinds),
    nullable: field.nullable,
    evaluation: field.evaluation,
    presence: presenceByFilterSemantics[field.presence],
    empty: emptyByFilterSemantics[field.empty],
    comparison: field.comparison,
    ...(derivation
      ? {
          derivation: Object.freeze({
            ...derivation,
            dependencies: Object.freeze([...derivation.dependencies]),
          }),
        }
      : {}),
  });
}

/** A derived semantic view; the Filter Registry remains the field source of truth. */
export const semanticAttributeCatalog: readonly SemanticAttributeDefinition[] =
  Object.freeze(
    [...analyticsFilterRegistry.values()]
      .map(freezeAttribute)
      .sort((left, right) => left.id.localeCompare(right.id)),
  );

/** Internal raw identity reads for Observation plans; these are not Filter fields. */
export const semanticObservationAttributeCatalog: readonly SemanticAttributeDefinition[] =
  Object.freeze([
    Object.freeze({
      id: "observation.sessionId",
      valueType: Object.freeze({ kind: "scalar", scalar: "string" }),
      nativeEntity: "observation",
      observationKinds: Object.freeze(["event", "page"] as const),
      nullable: false,
      evaluation: "observation",
      presence: "non-null",
      empty: "empty-string-is-value",
      comparison: "case-sensitive",
    }),
    Object.freeze({
      id: "observation.visitorId",
      valueType: Object.freeze({ kind: "scalar", scalar: "string" }),
      nativeEntity: "observation",
      observationKinds: Object.freeze(["event", "page"] as const),
      nullable: false,
      evaluation: "observation",
      presence: "non-null",
      empty: "empty-string-is-value",
      comparison: "case-sensitive",
    }),
  ] satisfies readonly SemanticAttributeDefinition[]);

const registeredSemanticAttributeIds = new Set(
  semanticAttributeCatalog.map((attribute) => attribute.id),
);
for (const attribute of semanticObservationAttributeCatalog) {
  if (registeredSemanticAttributeIds.has(attribute.id))
    throw new Error(`duplicate_semantic_attribute:${attribute.id}`);
  registeredSemanticAttributeIds.add(attribute.id);
  if (
    attribute.nativeEntity !== "observation" ||
    attribute.observationKinds.length !== 2 ||
    !attribute.observationKinds.includes("page") ||
    !attribute.observationKinds.includes("event") ||
    attribute.valueType.kind !== "scalar" ||
    attribute.valueType.scalar !== "string" ||
    attribute.nullable ||
    attribute.evaluation !== "observation" ||
    attribute.presence !== "non-null" ||
    attribute.empty !== "empty-string-is-value" ||
    attribute.comparison !== "case-sensitive"
  )
    throw new Error(`invalid_observation_attribute_contract:${attribute.id}`);
}

export function semanticAttribute(
  id: SemanticAttributeId,
): SemanticAttributeDefinition | undefined {
  return (
    semanticAttributeCatalog.find((attribute) => attribute.id === id) ??
    semanticObservationAttributeCatalog.find((attribute) => attribute.id === id)
  );
}

export function isObservationKind(value: unknown): value is ObservationKind {
  return value === "page" || value === "event";
}
