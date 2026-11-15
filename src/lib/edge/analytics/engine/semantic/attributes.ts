import {
  analyticsFilterRegistry,
  type AnalyticsFilterRegistryField,
  type FilterNativeEntity,
  type FilterObservationKind,
} from "@/lib/filter-contract/filter-registry";

import { ADVANCED_COUNT_SELECTOR_FIELDS } from "./count-selector-fields";
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

export interface SemanticOptionalReportRelationshipDerivation {
  readonly kind: "report-relationship";
  readonly relationship: "event.name" | "event.ownerPage";
  readonly cardinality: "zero-or-one";
  readonly sourceAttribute?: SemanticAttributeId;
  readonly dependencies: readonly SemanticAttributeId[];
  readonly value: "attribute" | "presence";
}

export type SemanticDerivation =
  | SemanticFunctionDerivation
  | SemanticReportRelationshipDerivation
  | SemanticOptionalReportRelationshipDerivation;

export interface SemanticAttributeDefinition {
  readonly id: SemanticAttributeId;
  readonly valueType: LogicalValueType;
  readonly nativeEntity: AnalyticsEntityKind;
  readonly observationKinds: readonly ObservationKind[];
  readonly nullable: boolean;
  readonly evaluation:
    | "observation"
    | "page-report"
    | "event-report"
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
const semanticObservationBaseAttributeCatalog: readonly SemanticAttributeDefinition[] =
  Object.freeze([
    { name: "sessionId", scalar: "string", nullable: false },
    { name: "visitorId", scalar: "string", nullable: false },
    { name: "kind", scalar: "string", nullable: false },
    { name: "id", scalar: "string", nullable: true },
    { name: "eventId", scalar: "string", nullable: true },
    { name: "eventName", scalar: "string", nullable: true },
    { name: "sameSiteEventName", scalar: "string", nullable: true },
    { name: "rawSiteId", scalar: "string", nullable: false },
    { name: "siteIdentityConsistent", scalar: "boolean", nullable: false },
    // Actual identity/time storage proof for ordered activity summaries.
    // These internal facts are independent of declared column affinity.
    { name: "sessionOrderCanonical", scalar: "boolean", nullable: false },
    { name: "visitorOrderCanonical", scalar: "boolean", nullable: false },
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
        { name: "rawSiteId", scalar: "string", nullable: false },
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
        : attribute.presence !== "non-null" ||
          attribute.derivation !== undefined)
    )
      throw new Error(`invalid_page_report_attribute_contract:${attribute.id}`);
  }
}

const ACTIVITY_CONTEXT_PAGE_ATTRIBUTE_NAMES = [
  "startedAt",
  "status",
  "lastActivityAt",
  "endedAt",
  "finalizedAt",
  "durationMs",
  "durationSource",
  "exitReason",
  "pathname",
  "queryString",
  "hash",
  "hostname",
  "title",
  "referrerUrl",
  "referrerHost",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
  "isEU",
  "country",
  "region",
  "regionCode",
  "city",
  "continent",
  "latitude",
  "longitude",
  "postalCode",
  "metroCode",
  "timezone",
  "organization",
  "userAgent",
  "browser",
  "browserVersion",
  "os",
  "osVersion",
  "deviceType",
  "screenWidth",
  "screenHeight",
  "language",
  "userId",
  "userName",
  "perfTtfbMs",
  "perfFcpMs",
  "perfLcpMs",
  "perfCls",
  "perfInpMs",
] as const;

function contextPageAttributeName(pageAttributeName: string): string {
  return `contextPage${pageAttributeName[0]?.toUpperCase() ?? ""}${pageAttributeName.slice(1)}`;
}

const semanticObservationContextPageAttributes =
  ACTIVITY_CONTEXT_PAGE_ATTRIBUTE_NAMES.map((name) => {
    const pageAttribute = semanticPageReportAttributeCatalog.find(
      (attribute) => attribute.id === `page.report.${name}`,
    );
    if (!pageAttribute || pageAttribute.valueType.kind !== "scalar")
      throw new Error(`missing_activity_context_page_attribute:${name}`);
    return observationAttribute({
      name: contextPageAttributeName(name),
      scalar: pageAttribute.valueType.scalar,
      nullable: pageAttribute.nullable,
      ...(pageAttribute.valueType.unit
        ? { unit: pageAttribute.valueType.unit }
        : {}),
    });
  });

const semanticObservationStorageClassAttributes =
  ADVANCED_COUNT_SELECTOR_FIELDS.flatMap((field) => {
    const classAttributes =
      field.kind === "string"
        ? [field.stringClassAttribute]
        : [field.safeRangeAttribute, field.exactAggregateAttribute];
    return classAttributes.map((classAttribute) => {
      const prefix = "observation.";
      if (!classAttribute.startsWith(prefix))
        throw new Error(
          `invalid_count_selector_class_attribute:${classAttribute}`,
        );
      return observationAttribute({
        name: classAttribute.slice(prefix.length),
        scalar: "boolean",
        nullable: false,
      });
    });
  });

/** Internal activity context: Page fields on Page rows and their owner Page on Event rows. */
export const semanticObservationAttributeCatalog: readonly SemanticAttributeDefinition[] =
  Object.freeze([
    ...semanticObservationBaseAttributeCatalog,
    ...semanticObservationContextPageAttributes,
    ...semanticObservationStorageClassAttributes,
  ]);

interface EventReportAttributeInput {
  readonly name: string;
  readonly scalar: SemanticScalarType;
  readonly nullable: boolean;
  readonly unit?: SemanticUnit;
  readonly derivation?: SemanticOptionalReportRelationshipDerivation;
}

function eventReportAttribute(
  input: EventReportAttributeInput,
): SemanticAttributeDefinition {
  const isText = input.scalar === "string";
  return Object.freeze({
    id: `event.report.${input.name}`,
    valueType: Object.freeze({
      kind: "scalar",
      scalar: input.scalar,
      ...(input.unit ? { unit: input.unit } : {}),
    }),
    nativeEntity: "event",
    observationKinds: Object.freeze(["event"] as const),
    nullable: input.nullable,
    evaluation: "event-report",
    presence: input.derivation ? "derived-value" : "non-null",
    empty: isText ? "empty-string-is-value" : "unsupported",
    comparison: "case-sensitive",
    ...(input.derivation
      ? {
          derivation: Object.freeze({
            ...input.derivation,
            dependencies: Object.freeze([...input.derivation.dependencies]),
          }),
        }
      : {}),
  });
}

function eventNameDerivation(): SemanticOptionalReportRelationshipDerivation {
  return {
    kind: "report-relationship",
    relationship: "event.name",
    cardinality: "zero-or-one",
    sourceAttribute: "event.report.nameId",
    dependencies: ["event.report.nameId"],
    value: "attribute",
  };
}

function eventOwnerDerivation(
  sourceAttribute: SemanticAttributeId,
): SemanticOptionalReportRelationshipDerivation {
  return {
    kind: "report-relationship",
    relationship: "event.ownerPage",
    cardinality: "zero-or-one",
    sourceAttribute,
    dependencies: [sourceAttribute],
    value: "attribute",
  };
}

const EVENT_OWNER_PAGE_ATTRIBUTE_MAPPINGS = [
  ["ownerSessionId", "page.report.sessionId"],
  ["ownerVisitorId", "page.report.visitorId"],
  ["ownerUserId", "page.report.userId"],
  ["ownerUserName", "page.report.userName"],
  ["ownerStatus", "page.report.status"],
  ["ownerPreviousVisitId", "page.report.previousVisitId"],
  ["ownerPreviousVisitStartedAt", "page.report.previousVisitStartedAt"],
  ["ownerStartedAt", "page.report.startedAt"],
  ["ownerLastActivityAt", "page.report.lastActivityAt"],
  ["ownerEndedAt", "page.report.endedAt"],
  ["ownerFinalizedAt", "page.report.finalizedAt"],
  ["ownerDurationMs", "page.report.durationMs"],
  ["ownerDurationSource", "page.report.durationSource"],
  ["ownerExitReason", "page.report.exitReason"],
  ["ownerPathname", "page.report.pathname"],
  ["ownerQueryString", "page.report.queryString"],
  ["ownerHash", "page.report.hash"],
  ["ownerTitle", "page.report.title"],
  ["ownerHostname", "page.report.hostname"],
  ["ownerReferrerUrl", "page.report.referrerUrl"],
  ["ownerReferrerHost", "page.report.referrerHost"],
  ["ownerUtmSource", "page.report.utmSource"],
  ["ownerUtmMedium", "page.report.utmMedium"],
  ["ownerUtmCampaign", "page.report.utmCampaign"],
  ["ownerUtmTerm", "page.report.utmTerm"],
  ["ownerUtmContent", "page.report.utmContent"],
  ["ownerIsEU", "page.report.isEU"],
  ["ownerCountry", "page.report.country"],
  ["ownerRegion", "page.report.region"],
  ["ownerRegionCode", "page.report.regionCode"],
  ["ownerCity", "page.report.city"],
  ["ownerContinent", "page.report.continent"],
  ["ownerLatitude", "page.report.latitude"],
  ["ownerLongitude", "page.report.longitude"],
  ["ownerPostalCode", "page.report.postalCode"],
  ["ownerMetroCode", "page.report.metroCode"],
  ["ownerTimezone", "page.report.timezone"],
  ["ownerOrganization", "page.report.organization"],
  ["ownerBrowser", "page.report.browser"],
  ["ownerBrowserVersion", "page.report.browserVersion"],
  ["ownerOs", "page.report.os"],
  ["ownerOsVersion", "page.report.osVersion"],
  ["ownerDeviceType", "page.report.deviceType"],
  ["ownerUserAgent", "page.report.userAgent"],
  ["ownerLanguage", "page.report.language"],
  ["ownerScreenWidth", "page.report.screenWidth"],
  ["ownerScreenHeight", "page.report.screenHeight"],
  ["ownerPerfTtfbMs", "page.report.perfTtfbMs"],
  ["ownerPerfFcpMs", "page.report.perfFcpMs"],
  ["ownerPerfLcpMs", "page.report.perfLcpMs"],
  ["ownerPerfCls", "page.report.perfCls"],
  ["ownerPerfInpMs", "page.report.perfInpMs"],
] as const satisfies readonly (readonly [string, SemanticAttributeId])[];

function eventOwnerAttribute(
  name: string,
  sourceAttributeId: SemanticAttributeId,
): SemanticAttributeDefinition {
  const source = semanticPageReportAttributeCatalog.find(
    (attribute) => attribute.id === sourceAttributeId,
  );
  if (!source || source.valueType.kind !== "scalar")
    throw new Error(
      `invalid_event_owner_source_attribute:${sourceAttributeId}`,
    );
  return eventReportAttribute({
    name,
    scalar: source.valueType.scalar,
    nullable: true,
    ...(source.valueType.unit ? { unit: source.valueType.unit } : {}),
    derivation: eventOwnerDerivation(source.id),
  });
}

const eventOwnerPresenceDerivation: SemanticOptionalReportRelationshipDerivation =
  Object.freeze({
    kind: "report-relationship",
    relationship: "event.ownerPage",
    cardinality: "zero-or-one",
    dependencies: Object.freeze([]),
    value: "presence",
  });

/** Internal native Event report fields; these do not extend the Filter Registry. */
export const semanticEventReportAttributeCatalog: readonly SemanticAttributeDefinition[] =
  Object.freeze([
    eventReportAttribute({
      name: "localId",
      scalar: "string",
      nullable: false,
    }),
    eventReportAttribute({
      name: "internalPk",
      scalar: "number",
      nullable: false,
    }),
    eventReportAttribute({
      name: "ownerVisitId",
      scalar: "string",
      nullable: false,
    }),
    eventReportAttribute({
      name: "nameId",
      scalar: "number",
      nullable: false,
    }),
    eventReportAttribute({
      name: "eventName",
      scalar: "string",
      nullable: true,
      derivation: eventNameDerivation(),
    }),
    eventReportAttribute({
      name: "occurredAt",
      scalar: "datetime",
      nullable: false,
    }),
    eventReportAttribute({
      name: "receivedAt",
      scalar: "datetime",
      nullable: false,
    }),
    eventReportAttribute({
      name: "sequence",
      scalar: "number",
      nullable: false,
    }),
    eventReportAttribute({
      name: "nodeCount",
      scalar: "number",
      nullable: false,
    }),
    eventReportAttribute({
      name: "valueCount",
      scalar: "number",
      nullable: false,
    }),
    eventReportAttribute({
      name: "userId",
      scalar: "string",
      nullable: true,
    }),
    eventReportAttribute({
      name: "ownerPresent",
      scalar: "boolean",
      nullable: false,
      derivation: eventOwnerPresenceDerivation,
    }),
    ...EVENT_OWNER_PAGE_ATTRIBUTE_MAPPINGS.map(([name, sourceAttribute]) =>
      eventOwnerAttribute(name, sourceAttribute),
    ),
  ]);

const eventReportAttributeIds = new Set(
  semanticEventReportAttributeCatalog.map((attribute) => attribute.id),
);

export function isSemanticEventReportAttribute(value: string): boolean {
  return eventReportAttributeIds.has(value);
}

export function assertSemanticEventReportAttributeContracts(
  attributes: readonly SemanticAttributeDefinition[],
  registeredSemanticAttributeIds: Set<string>,
): void {
  for (const attribute of attributes) {
    if (registeredSemanticAttributeIds.has(attribute.id))
      throw new Error(`duplicate_semantic_attribute:${attribute.id}`);
    registeredSemanticAttributeIds.add(attribute.id);
    const isName = attribute.id === "event.report.eventName";
    const isOwnerPresence = attribute.id === "event.report.ownerPresent";
    const isOwnerAttribute =
      attribute.id.startsWith("event.report.owner") &&
      !isOwnerPresence &&
      attribute.id !== "event.report.ownerVisitId";
    const derivation = attribute.derivation;
    const hasExpectedOwnerDerivation =
      derivation?.kind === "report-relationship" &&
      derivation.relationship === "event.ownerPage" &&
      derivation.cardinality === "zero-or-one" &&
      derivation.value === "attribute" &&
      typeof derivation.sourceAttribute === "string" &&
      semanticPageReportAttributeCatalog.some(
        (source) => source.id === derivation.sourceAttribute,
      ) &&
      derivation.dependencies.length === 1 &&
      derivation.dependencies[0] === derivation.sourceAttribute;
    const hasExpectedPresenceDerivation =
      derivation?.kind === "report-relationship" &&
      derivation.relationship === "event.ownerPage" &&
      derivation.cardinality === "zero-or-one" &&
      derivation.value === "presence" &&
      derivation.sourceAttribute === undefined &&
      derivation.dependencies.length === 0;
    const hasExpectedNameDerivation =
      derivation?.kind === "report-relationship" &&
      derivation.relationship === "event.name" &&
      derivation.cardinality === "zero-or-one" &&
      derivation.value === "attribute" &&
      derivation.sourceAttribute === "event.report.nameId" &&
      derivation.dependencies.length === 1 &&
      derivation.dependencies[0] === "event.report.nameId";
    const scalarAllowed =
      attribute.valueType.kind === "scalar" &&
      ["string", "number", "datetime", "boolean"].includes(
        attribute.valueType.scalar,
      );
    if (
      !attribute.id.startsWith("event.report.") ||
      attribute.nativeEntity !== "event" ||
      attribute.observationKinds.length !== 1 ||
      attribute.observationKinds[0] !== "event" ||
      attribute.evaluation !== "event-report" ||
      attribute.comparison !== "case-sensitive" ||
      !scalarAllowed ||
      attribute.empty !==
        (attribute.valueType.kind === "scalar" &&
        attribute.valueType.scalar === "string"
          ? "empty-string-is-value"
          : "unsupported") ||
      (isName
        ? !attribute.nullable ||
          attribute.presence !== "derived-value" ||
          !hasExpectedNameDerivation
        : false) ||
      (isOwnerPresence
        ? attribute.valueType.kind !== "scalar" ||
          attribute.valueType.scalar !== "boolean" ||
          attribute.nullable ||
          attribute.presence !== "derived-value" ||
          !hasExpectedPresenceDerivation
        : false) ||
      (isOwnerAttribute
        ? !attribute.nullable ||
          attribute.presence !== "derived-value" ||
          !hasExpectedOwnerDerivation
        : false) ||
      (!isName && !isOwnerPresence && !isOwnerAttribute
        ? attribute.presence !== "non-null" ||
          attribute.derivation !== undefined
        : false)
    )
      throw new Error(
        `invalid_event_report_attribute_contract:${attribute.id}`,
      );
  }
}

export function assertSemanticObservationAttributeContracts(
  attributes: readonly SemanticAttributeDefinition[],
  registeredSemanticAttributeIds: Set<string>,
): void {
  const nonNullBooleanAttributes = new Set([
    "observation.siteIdentityConsistent",
    "observation.sessionOrderCanonical",
    "observation.visitorOrderCanonical",
    ...semanticObservationStorageClassAttributes.map(({ id }) => id),
  ]);
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
      !(
        ["string", "number", "datetime"].includes(attribute.valueType.scalar) ||
        (nonNullBooleanAttributes.has(attribute.id) &&
          attribute.valueType.scalar === "boolean" &&
          !attribute.nullable)
      ) ||
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

assertSemanticEventReportAttributeContracts(
  semanticEventReportAttributeCatalog,
  new Set([
    ...semanticAttributeCatalog.map((attribute) => attribute.id),
    ...semanticObservationAttributeCatalog.map((attribute) => attribute.id),
    ...semanticPageReportAttributeCatalog.map((attribute) => attribute.id),
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
    semanticPageReportAttributeCatalog.find(
      (attribute) => attribute.id === id,
    ) ??
    semanticEventReportAttributeCatalog.find((attribute) => attribute.id === id)
  );
}

export function isObservationKind(value: unknown): value is ObservationKind {
  return value === "page" || value === "event";
}
