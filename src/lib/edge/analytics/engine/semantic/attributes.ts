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

export interface SemanticFunctionDerivation {
  readonly kind: "semantic-function";
  readonly function:
    "traffic-channel" | "browser-engine" | "os-version" | "screen-size";
  readonly dependencies: readonly SemanticAttributeId[];
}

export interface SemanticReportRelationshipDerivation {
  readonly kind: "report-relationship";
  readonly relationship: "page.previous";
  readonly selection: "latest-strictly-earlier-same-session-page";
  readonly dependencies: readonly SemanticAttributeId[];
  readonly orderBy: readonly [
    {
      readonly attribute: "page.report.startedAt";
      readonly direction: "desc";
    },
    {
      readonly attribute: "page.report.localId";
      readonly direction: "desc";
    },
  ];
  readonly output: "localId" | "startedAt";
}

export type SemanticDerivation =
  SemanticFunctionDerivation | SemanticReportRelationshipDerivation;

export interface SemanticAttributeDefinition {
  readonly id: SemanticAttributeId;
  readonly valueType: LogicalValueType;
  readonly nativeEntity: AnalyticsEntityKind;
  readonly observationKinds: readonly ObservationKind[];
  readonly nullable: boolean;
  readonly evaluation:
    | "observation"
    | "page-report"
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

interface ObservationAttributeInput {
  readonly name: string;
  readonly scalar: SemanticScalarType;
  readonly nullable: boolean;
  readonly unit?: SemanticUnit;
}

function observationAttribute(
  input: ObservationAttributeInput,
): SemanticAttributeDefinition {
  const isText = input.scalar === "string";
  return Object.freeze({
    id: `observation.${input.name}`,
    valueType: Object.freeze({
      kind: "scalar",
      scalar: input.scalar,
      ...(input.unit ? { unit: input.unit } : {}),
    }),
    nativeEntity: "observation",
    observationKinds: Object.freeze(["event", "page"] as const),
    nullable: input.nullable,
    evaluation: "observation",
    presence: "non-null",
    empty: isText ? "empty-string-is-value" : "unsupported",
    comparison: "case-sensitive",
  });
}

/** Internal report reads for Observation plans; these are not Filter fields. */
export const semanticObservationAttributeCatalog: readonly SemanticAttributeDefinition[] =
  Object.freeze([
    { name: "sessionId", scalar: "string", nullable: false },
    { name: "visitorId", scalar: "string", nullable: false },
    { name: "kind", scalar: "string", nullable: false },
    { name: "id", scalar: "string", nullable: true },
    { name: "eventId", scalar: "string", nullable: true },
    { name: "eventName", scalar: "string", nullable: true },
    { name: "visitId", scalar: "string", nullable: true },
    { name: "userId", scalar: "string", nullable: true },
    { name: "userName", scalar: "string", nullable: true },
    { name: "status", scalar: "string", nullable: true },
    {
      name: "ownerPageStartedAt",
      scalar: "datetime",
      nullable: false,
    },
    { name: "startedAt", scalar: "datetime", nullable: true },
    { name: "lastActivityAt", scalar: "datetime", nullable: true },
    { name: "endedAt", scalar: "datetime", nullable: true },
    { name: "durationMs", scalar: "number", nullable: true, unit: "ms" },
    { name: "pathname", scalar: "string", nullable: false },
    { name: "hash", scalar: "string", nullable: false },
    { name: "title", scalar: "string", nullable: false },
    { name: "hostname", scalar: "string", nullable: false },
    { name: "referrerHost", scalar: "string", nullable: false },
    { name: "referrerUrl", scalar: "string", nullable: false },
    { name: "country", scalar: "string", nullable: false },
    { name: "region", scalar: "string", nullable: false },
    { name: "regionCode", scalar: "string", nullable: false },
    { name: "city", scalar: "string", nullable: false },
    { name: "latitude", scalar: "number", nullable: true },
    { name: "longitude", scalar: "number", nullable: true },
    { name: "browser", scalar: "string", nullable: false },
    { name: "browserVersion", scalar: "string", nullable: false },
    { name: "os", scalar: "string", nullable: false },
    { name: "osVersion", scalar: "string", nullable: false },
    { name: "deviceType", scalar: "string", nullable: false },
    {
      name: "screenWidth",
      scalar: "number",
      nullable: true,
      unit: "px",
    },
    {
      name: "screenHeight",
      scalar: "number",
      nullable: true,
      unit: "px",
    },
    {
      name: "perfTtfbMs",
      scalar: "number",
      nullable: true,
      unit: "ms",
    },
    {
      name: "perfFcpMs",
      scalar: "number",
      nullable: true,
      unit: "ms",
    },
    {
      name: "perfLcpMs",
      scalar: "number",
      nullable: true,
      unit: "ms",
    },
    {
      name: "perfCls",
      scalar: "number",
      nullable: true,
      unit: "ratio",
    },
    {
      name: "perfInpMs",
      scalar: "number",
      nullable: true,
      unit: "ms",
    },
  ] satisfies readonly ObservationAttributeInput[]).map(observationAttribute);

interface PageReportAttributeInput {
  readonly name: string;
  readonly scalar: SemanticScalarType;
  readonly nullable: boolean;
  readonly unit?: SemanticUnit;
  readonly presence?: "non-null" | "derived-value";
  readonly derivation?: SemanticReportRelationshipDerivation;
}

function pageReportAttribute(
  input: PageReportAttributeInput,
): SemanticAttributeDefinition {
  const isText = input.scalar === "string";
  return Object.freeze({
    id: `page.report.${input.name}`,
    valueType: Object.freeze({
      kind: "scalar",
      scalar: input.scalar,
      ...(input.unit ? { unit: input.unit } : {}),
    }),
    nativeEntity: "page",
    observationKinds: Object.freeze(["page"] as const),
    nullable: input.nullable,
    evaluation: "page-report",
    presence: input.presence ?? "non-null",
    empty: isText ? "empty-string-is-value" : "unsupported",
    comparison: "case-sensitive",
    ...(input.derivation
      ? {
          derivation: Object.freeze({
            ...input.derivation,
            dependencies: Object.freeze([...input.derivation.dependencies]),
            orderBy: Object.freeze(
              input.derivation.orderBy.map((key) => Object.freeze({ ...key })),
            ) as SemanticReportRelationshipDerivation["orderBy"],
          }),
        }
      : {}),
  });
}

function previousPageDerivation(
  output: SemanticReportRelationshipDerivation["output"],
): SemanticReportRelationshipDerivation {
  return {
    kind: "report-relationship",
    relationship: "page.previous",
    selection: "latest-strictly-earlier-same-session-page",
    dependencies: [
      "page.report.sessionId",
      "page.report.startedAt",
      "page.report.localId",
    ],
    orderBy: [
      { attribute: "page.report.startedAt", direction: "desc" },
      { attribute: "page.report.localId", direction: "desc" },
    ],
    output,
  };
}

const NUMBER_MS = { scalar: "number", unit: "ms" } as const;
const NUMBER_PX = { scalar: "number", unit: "px" } as const;
const NUMBER_RATIO = { scalar: "number", unit: "ratio" } as const;

/** Internal native Page report fields; these are not Filter Registry capabilities. */
export const semanticPageReportAttributeCatalog: readonly SemanticAttributeDefinition[] =
  Object.freeze(
    (
      [
        { name: "localId", scalar: "string", nullable: true },
        { name: "sessionId", scalar: "string", nullable: false },
        { name: "visitorId", scalar: "string", nullable: false },
        { name: "userId", scalar: "string", nullable: true },
        { name: "userName", scalar: "string", nullable: true },
        { name: "status", scalar: "string", nullable: false },
        {
          name: "previousVisitId",
          scalar: "string",
          nullable: true,
          presence: "derived-value",
        },
        {
          name: "previousVisitStartedAt",
          scalar: "datetime",
          nullable: true,
          presence: "derived-value",
        },
        { name: "startedAt", scalar: "datetime", nullable: false },
        { name: "lastActivityAt", scalar: "datetime", nullable: false },
        { name: "endedAt", scalar: "datetime", nullable: true },
        { name: "finalizedAt", scalar: "datetime", nullable: true },
        { name: "durationMs", ...NUMBER_MS, nullable: true },
        { name: "durationSource", scalar: "string", nullable: true },
        { name: "exitReason", scalar: "string", nullable: true },
        { name: "pathname", scalar: "string", nullable: false },
        { name: "queryString", scalar: "string", nullable: false },
        { name: "hash", scalar: "string", nullable: false },
        { name: "title", scalar: "string", nullable: false },
        { name: "hostname", scalar: "string", nullable: false },
        { name: "referrerUrl", scalar: "string", nullable: false },
        { name: "referrerHost", scalar: "string", nullable: false },
        { name: "utmSource", scalar: "string", nullable: false },
        { name: "utmMedium", scalar: "string", nullable: false },
        { name: "utmCampaign", scalar: "string", nullable: false },
        { name: "utmTerm", scalar: "string", nullable: false },
        { name: "utmContent", scalar: "string", nullable: false },
        { name: "isEU", scalar: "number", nullable: false },
        { name: "country", scalar: "string", nullable: false },
        { name: "region", scalar: "string", nullable: false },
        { name: "regionCode", scalar: "string", nullable: false },
        { name: "city", scalar: "string", nullable: false },
        { name: "continent", scalar: "string", nullable: false },
        { name: "latitude", scalar: "number", nullable: true },
        { name: "longitude", scalar: "number", nullable: true },
        { name: "postalCode", scalar: "string", nullable: false },
        { name: "metroCode", scalar: "string", nullable: false },
        { name: "timezone", scalar: "string", nullable: false },
        { name: "organization", scalar: "string", nullable: false },
        { name: "browser", scalar: "string", nullable: false },
        { name: "browserVersion", scalar: "string", nullable: false },
        { name: "os", scalar: "string", nullable: false },
        { name: "osVersion", scalar: "string", nullable: false },
        { name: "deviceType", scalar: "string", nullable: false },
        { name: "userAgent", scalar: "string", nullable: false },
        { name: "language", scalar: "string", nullable: false },
        { name: "screenWidth", ...NUMBER_PX, nullable: true },
        { name: "screenHeight", ...NUMBER_PX, nullable: true },
        { name: "perfTtfbMs", ...NUMBER_MS, nullable: true },
        { name: "perfFcpMs", ...NUMBER_MS, nullable: true },
        { name: "perfLcpMs", ...NUMBER_MS, nullable: true },
        { name: "perfCls", ...NUMBER_RATIO, nullable: true },
        { name: "perfInpMs", ...NUMBER_MS, nullable: true },
      ] satisfies readonly PageReportAttributeInput[]
    ).map((attribute) => {
      if (attribute.name === "previousVisitId")
        return pageReportAttribute({
          ...attribute,
          derivation: previousPageDerivation("localId"),
        });
      if (attribute.name === "previousVisitStartedAt")
        return pageReportAttribute({
          ...attribute,
          derivation: previousPageDerivation("startedAt"),
        });
      return pageReportAttribute(attribute);
    }),
  );

const pageReportAttributeIds = new Set(
  semanticPageReportAttributeCatalog.map((attribute) => attribute.id),
);

export function isSemanticPageReportAttribute(value: string): boolean {
  return pageReportAttributeIds.has(value);
}

export function assertSemanticPageReportAttributeContracts(
  attributes: readonly SemanticAttributeDefinition[],
  registeredSemanticAttributeIds: Set<string>,
): void {
  for (const attribute of attributes) {
    if (registeredSemanticAttributeIds.has(attribute.id))
      throw new Error(`duplicate_semantic_attribute:${attribute.id}`);
    registeredSemanticAttributeIds.add(attribute.id);
    const isPreviousValue =
      attribute.id === "page.report.previousVisitId" ||
      attribute.id === "page.report.previousVisitStartedAt";
    if (
      !attribute.id.startsWith("page.report.") ||
      attribute.nativeEntity !== "page" ||
      attribute.observationKinds.length !== 1 ||
      attribute.observationKinds[0] !== "page" ||
      attribute.evaluation !== "page-report" ||
      attribute.comparison !== "case-sensitive" ||
      attribute.valueType.kind !== "scalar" ||
      !["string", "number", "datetime"].includes(attribute.valueType.scalar) ||
      attribute.empty !==
        (attribute.valueType.scalar === "string"
          ? "empty-string-is-value"
          : "unsupported") ||
      (isPreviousValue
        ? attribute.presence !== "derived-value" ||
          !attribute.nullable ||
          attribute.derivation?.kind !== "report-relationship" ||
          attribute.derivation.relationship !== "page.previous" ||
          attribute.derivation.selection !==
            "latest-strictly-earlier-same-session-page"
        : attribute.presence !== "non-null")
    )
      throw new Error(`invalid_page_report_attribute_contract:${attribute.id}`);
  }
}

export function assertSemanticObservationAttributeContracts(
  attributes: readonly SemanticAttributeDefinition[],
  registeredSemanticAttributeIds: Set<string>,
): void {
  for (const attribute of attributes) {
    if (registeredSemanticAttributeIds.has(attribute.id))
      throw new Error(`duplicate_semantic_attribute:${attribute.id}`);
    registeredSemanticAttributeIds.add(attribute.id);
    if (
      attribute.nativeEntity !== "observation" ||
      attribute.observationKinds.length !== 2 ||
      !attribute.observationKinds.includes("page") ||
      !attribute.observationKinds.includes("event") ||
      attribute.valueType.kind !== "scalar" ||
      !["string", "number", "datetime"].includes(attribute.valueType.scalar) ||
      attribute.evaluation !== "observation" ||
      attribute.presence !== "non-null" ||
      attribute.empty !==
        (attribute.valueType.scalar === "string"
          ? "empty-string-is-value"
          : "unsupported") ||
      attribute.comparison !== "case-sensitive"
    )
      throw new Error(`invalid_observation_attribute_contract:${attribute.id}`);
  }
}

assertSemanticObservationAttributeContracts(
  semanticObservationAttributeCatalog,
  new Set(semanticAttributeCatalog.map((attribute) => attribute.id)),
);

assertSemanticPageReportAttributeContracts(
  semanticPageReportAttributeCatalog,
  new Set([
    ...semanticAttributeCatalog.map((attribute) => attribute.id),
    ...semanticObservationAttributeCatalog.map((attribute) => attribute.id),
  ]),
);

export function semanticAttribute(
  id: SemanticAttributeId,
): SemanticAttributeDefinition | undefined {
  return (
    semanticAttributeCatalog.find((attribute) => attribute.id === id) ??
    semanticObservationAttributeCatalog.find(
      (attribute) => attribute.id === id,
    ) ??
    semanticPageReportAttributeCatalog.find((attribute) => attribute.id === id)
  );
}

export function isObservationKind(value: unknown): value is ObservationKind {
  return value === "page" || value === "event";
}
