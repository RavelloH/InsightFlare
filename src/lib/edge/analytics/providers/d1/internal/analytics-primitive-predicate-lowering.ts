import {
  and,
  callFunction,
  eq,
  inList,
  isNotNull,
  isNull,
  neq,
  not,
  param,
} from "@/lib/db";
import type { Predicate, SqlExpression } from "@/lib/db/query/expression";
import type { schema as analyticsSchema } from "@/lib/db/schema";
import { semanticAttribute } from "@/lib/edge/analytics/engine/semantic/attributes";
import {
  analyticsFilterRegistry,
  filterConditionEntity,
} from "@/lib/filter-contract/filter-registry";
import type { FilterConditionEntity } from "@/lib/filter-contract/filters";

type AnalyticsSchema = typeof analyticsSchema;
type VisitColumns = AnalyticsSchema["visits"]["columns"];
type NativeVisitTextColumn = {
  [Column in keyof VisitColumns]: VisitColumns[Column] extends {
    readonly affinity: "text";
  }
    ? Column
    : never;
}[keyof VisitColumns] &
  string;
type NativeVisitTextStorageMapping = {
  [Column in NativeVisitTextColumn]: {
    readonly storageSource: "visit";
    readonly storageColumn: Column;
    readonly storageNullable: VisitColumns[Column]["nullable"];
  };
}[NativeVisitTextColumn];
type NativeEventNameStorageMapping = {
  readonly storageSource: "event";
  readonly storageColumn: "event_name";
  readonly storageNullable: AnalyticsSchema["custom_event_names"]["columns"]["name"]["nullable"];
};

export type NativePrimitiveFieldId =
  | "page.path"
  | "page.title"
  | "page.hostname"
  | "page.query"
  | "page.hash"
  | "referrer.domain"
  | "referrer.url"
  | "event.name"
  | "utm.source"
  | "utm.medium"
  | "utm.campaign"
  | "utm.term"
  | "utm.content"
  | "client.browser"
  | "client.browserVersion"
  | "client.os"
  | "client.deviceType"
  | "client.language"
  | "geo.country"
  | "geo.region"
  | "geo.city"
  | "geo.continent"
  | "geo.timeZone"
  | "geo.organization"
  | "user.id"
  | "user.name";

interface NativePrimitiveFieldContractBase {
  readonly id: NativePrimitiveFieldId;
  readonly conditionEntity: FilterConditionEntity;
  readonly observationKinds: readonly ("page" | "event")[];
  readonly valueKind: "string" | "enum";
  readonly profile: "trimmed-text" | "case-folded-text" | "direct-referrer";
  readonly comparison: "case-sensitive" | "case-insensitive";
  readonly compilerStrategy:
    | "column.pathname"
    | "column.title"
    | "column.hostname"
    | "column.query_string"
    | "column.hash_fragment"
    | "column.referrer_host"
    | "column.referrer_url"
    | "column.utm_source"
    | "column.utm_medium"
    | "column.utm_campaign"
    | "column.utm_term"
    | "column.utm_content"
    | "column.browser"
    | "column.browser_version"
    | "column.os"
    | "column.device_type"
    | "column.language"
    | "column.country"
    | "column.region"
    | "column.city"
    | "column.continent"
    | "column.timezone"
    | "column.as_organization"
    | "column.user_id"
    | "column.user_name"
    | "event.name";
  /** Logical semantic attribute nullability exposed by the registry/catalog. */
  readonly nullable: boolean;
}

export type NativePrimitiveFieldContract =
  | (NativePrimitiveFieldContractBase & {
      readonly activity: "page";
    } & NativeVisitTextStorageMapping)
  | (NativePrimitiveFieldContractBase & {
      readonly activity: "event";
    } & NativeEventNameStorageMapping);

export type NativePrimitivePredicate =
  | { readonly operator: "eq" | "neq"; readonly value: string }
  | { readonly operator: "in" | "notIn"; readonly values: readonly string[] }
  | { readonly operator: "isNull" | "notNull" };

const TRIMMED_CASE_SENSITIVE_TEXT = {
  valueKind: "string",
  profile: "trimmed-text",
  comparison: "case-sensitive",
} as const;
const CASE_FOLDED_CASE_INSENSITIVE_TEXT = {
  valueKind: "string",
  profile: "case-folded-text",
  comparison: "case-insensitive",
} as const;
const CASE_FOLDED_CASE_INSENSITIVE_ENUM = {
  valueKind: "enum",
  profile: "case-folded-text",
  comparison: "case-insensitive",
} as const;
const DIRECT_REFERRER_CASE_INSENSITIVE_TEXT = {
  valueKind: "string",
  profile: "direct-referrer",
  comparison: "case-insensitive",
} as const;

const FIELD_CONTRACTS: Readonly<
  Record<NativePrimitiveFieldId, NativePrimitiveFieldContract>
> = {
  "page.path": {
    id: "page.path",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "page",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.pathname",
    storageSource: "visit",
    storageColumn: "pathname",
    storageNullable: false,
    nullable: true,
  },
  "page.title": {
    id: "page.title",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "page",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.title",
    storageSource: "visit",
    storageColumn: "title",
    storageNullable: false,
    nullable: true,
  },
  "page.hostname": {
    id: "page.hostname",
    ...CASE_FOLDED_CASE_INSENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "page",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.hostname",
    storageSource: "visit",
    storageColumn: "hostname",
    storageNullable: false,
    nullable: true,
  },
  "page.query": {
    id: "page.query",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "page",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.query_string",
    storageSource: "visit",
    storageColumn: "query_string",
    storageNullable: false,
    nullable: true,
  },
  "page.hash": {
    id: "page.hash",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "page",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.hash_fragment",
    storageSource: "visit",
    storageColumn: "hash_fragment",
    storageNullable: false,
    nullable: true,
  },
  "referrer.domain": {
    id: "referrer.domain",
    ...DIRECT_REFERRER_CASE_INSENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.referrer_host",
    storageSource: "visit",
    storageColumn: "referrer_host",
    storageNullable: false,
    nullable: true,
  },
  "referrer.url": {
    id: "referrer.url",
    ...DIRECT_REFERRER_CASE_INSENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.referrer_url",
    storageSource: "visit",
    storageColumn: "referrer_url",
    storageNullable: false,
    nullable: true,
  },
  "event.name": {
    id: "event.name",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "event",
    conditionEntity: "event",
    observationKinds: ["event"],
    compilerStrategy: "event.name",
    storageSource: "event",
    storageColumn: "event_name",
    storageNullable: false,
    nullable: false,
  },
  "utm.source": {
    id: "utm.source",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.utm_source",
    storageSource: "visit",
    storageColumn: "utm_source",
    storageNullable: false,
    nullable: true,
  },
  "utm.medium": {
    id: "utm.medium",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.utm_medium",
    storageSource: "visit",
    storageColumn: "utm_medium",
    storageNullable: false,
    nullable: true,
  },
  "utm.campaign": {
    id: "utm.campaign",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.utm_campaign",
    storageSource: "visit",
    storageColumn: "utm_campaign",
    storageNullable: false,
    nullable: true,
  },
  "utm.term": {
    id: "utm.term",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.utm_term",
    storageSource: "visit",
    storageColumn: "utm_term",
    storageNullable: false,
    nullable: true,
  },
  "utm.content": {
    id: "utm.content",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.utm_content",
    storageSource: "visit",
    storageColumn: "utm_content",
    storageNullable: false,
    nullable: true,
  },
  "client.browser": {
    id: "client.browser",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.browser",
    storageSource: "visit",
    storageColumn: "browser",
    storageNullable: false,
    nullable: true,
  },
  "client.browserVersion": {
    id: "client.browserVersion",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.browser_version",
    storageSource: "visit",
    storageColumn: "browser_version",
    storageNullable: false,
    nullable: true,
  },
  "client.os": {
    id: "client.os",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.os",
    storageSource: "visit",
    storageColumn: "os",
    storageNullable: false,
    nullable: true,
  },
  "client.language": {
    id: "client.language",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.language",
    storageSource: "visit",
    storageColumn: "language",
    storageNullable: false,
    nullable: true,
  },
  "client.deviceType": {
    id: "client.deviceType",
    ...CASE_FOLDED_CASE_INSENSITIVE_ENUM,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.device_type",
    storageSource: "visit",
    storageColumn: "device_type",
    storageNullable: false,
    nullable: true,
  },
  "geo.country": {
    id: "geo.country",
    ...CASE_FOLDED_CASE_INSENSITIVE_ENUM,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.country",
    storageSource: "visit",
    storageColumn: "country",
    storageNullable: false,
    nullable: true,
  },
  "geo.region": {
    id: "geo.region",
    ...CASE_FOLDED_CASE_INSENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.region",
    storageSource: "visit",
    storageColumn: "region",
    storageNullable: false,
    nullable: true,
  },
  "geo.city": {
    id: "geo.city",
    ...CASE_FOLDED_CASE_INSENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.city",
    storageSource: "visit",
    storageColumn: "city",
    storageNullable: false,
    nullable: true,
  },
  "geo.continent": {
    id: "geo.continent",
    ...CASE_FOLDED_CASE_INSENSITIVE_ENUM,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.continent",
    storageSource: "visit",
    storageColumn: "continent",
    storageNullable: false,
    nullable: true,
  },
  "geo.timeZone": {
    id: "geo.timeZone",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.timezone",
    storageSource: "visit",
    storageColumn: "timezone",
    storageNullable: false,
    nullable: true,
  },
  "geo.organization": {
    id: "geo.organization",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.as_organization",
    storageSource: "visit",
    storageColumn: "as_organization",
    storageNullable: false,
    nullable: true,
  },
  "user.id": {
    id: "user.id",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.user_id",
    storageSource: "visit",
    storageColumn: "user_id",
    storageNullable: true,
    nullable: true,
  },
  "user.name": {
    id: "user.name",
    ...TRIMMED_CASE_SENSITIVE_TEXT,
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.user_name",
    storageSource: "visit",
    storageColumn: "user_name",
    storageNullable: true,
    nullable: true,
  },
};

/**
 * Resolve only fields whose registry and semantic contracts still agree with
 * this adapter's explicitly supported primitive subset.
 */
export function nativePrimitiveFieldContract(
  fieldId: string,
): NativePrimitiveFieldContract | undefined {
  if (!Object.hasOwn(FIELD_CONTRACTS, fieldId)) return undefined;
  const contract = FIELD_CONTRACTS[fieldId as NativePrimitiveFieldId];
  const field = analyticsFilterRegistry.get(contract.id);
  const attribute = semanticAttribute(contract.id);
  const expectedNativeEntity = contract.activity === "page" ? "visit" : "event";
  const expectedFilterObservationKinds = new Set(
    contract.observationKinds.map((kind) =>
      kind === "page" ? "visit" : "event",
    ),
  );
  const expectedSemanticObservationKinds = new Set(contract.observationKinds);
  const filterObservationKindsMatch =
    field !== undefined &&
    field.observationKinds.size === expectedFilterObservationKinds.size &&
    [...expectedFilterObservationKinds].every((kind) =>
      field.observationKinds.has(kind),
    );
  const semanticObservationKindsMatch =
    attribute !== undefined &&
    attribute.observationKinds.length ===
      expectedSemanticObservationKinds.size &&
    attribute.observationKinds.every((kind) =>
      expectedSemanticObservationKinds.has(kind),
    );

  if (
    !field ||
    !attribute ||
    !filterObservationKindsMatch ||
    !semanticObservationKindsMatch ||
    field.valueKind !== contract.valueKind ||
    field.profile !== contract.profile ||
    field.comparison !== contract.comparison ||
    field.compilerStrategy !== contract.compilerStrategy ||
    field.source !== contract.storageSource ||
    field.nativeEntity !== expectedNativeEntity ||
    filterConditionEntity(field) !== contract.conditionEntity ||
    field.evaluation !== "observation" ||
    field.presence !== "non-null-column" ||
    field.empty !== "raw-empty-string" ||
    field.nullable !== contract.nullable ||
    attribute.id !== contract.id ||
    attribute.valueType.kind !== "scalar" ||
    attribute.valueType.scalar !== "string" ||
    attribute.nativeEntity !== contract.activity ||
    attribute.nullable !== contract.nullable ||
    attribute.evaluation !== "observation" ||
    attribute.presence !== "non-null" ||
    attribute.empty !== "empty-string-is-value" ||
    attribute.comparison !== contract.comparison
  ) {
    return undefined;
  }

  return contract;
}

/** Compile native string primitives against the original typed storage column. */
export function lowerNativePrimitivePredicate(
  column: SqlExpression<string | null>,
  primitive: NativePrimitivePredicate,
): Predicate {
  const normalized = callFunction("trim", column);
  const normalizedValues =
    primitive.operator === "eq" || primitive.operator === "neq"
      ? undefined
      : primitive.operator === "in" || primitive.operator === "notIn"
        ? primitive.values.map((value) => value.trim())
        : undefined;

  switch (primitive.operator) {
    case "eq":
      return eq(normalized, param(primitive.value.trim()));
    case "neq":
      return and(
        isNotNull(column),
        neq(normalized, param(primitive.value.trim())),
      );
    case "in":
      return primitive.values.length === 1
        ? eq(normalized, param(normalizedValues![0]!))
        : inList(normalized, normalizedValues!);
    case "notIn":
      return and(isNotNull(column), not(inList(normalized, normalizedValues!)));
    case "isNull":
      return isNull(column);
    case "notNull":
      return isNotNull(column);
  }
}
