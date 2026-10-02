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
  | "page.query"
  | "page.hash"
  | "event.name"
  | "utm.source"
  | "utm.medium"
  | "utm.campaign"
  | "utm.term"
  | "utm.content"
  | "client.browser"
  | "client.browserVersion"
  | "client.os"
  | "client.language"
  | "geo.timeZone"
  | "geo.organization"
  | "user.id"
  | "user.name";

interface NativePrimitiveFieldContractBase {
  readonly id: NativePrimitiveFieldId;
  readonly conditionEntity: FilterConditionEntity;
  readonly observationKinds: readonly ("page" | "event")[];
  readonly compilerStrategy:
    | "column.pathname"
    | "column.title"
    | "column.query_string"
    | "column.hash_fragment"
    | "column.utm_source"
    | "column.utm_medium"
    | "column.utm_campaign"
    | "column.utm_term"
    | "column.utm_content"
    | "column.browser"
    | "column.browser_version"
    | "column.os"
    | "column.language"
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

const FIELD_CONTRACTS: Readonly<
  Record<NativePrimitiveFieldId, NativePrimitiveFieldContract>
> = {
  "page.path": {
    id: "page.path",
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
    activity: "page",
    conditionEntity: "page",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.title",
    storageSource: "visit",
    storageColumn: "title",
    storageNullable: false,
    nullable: true,
  },
  "page.query": {
    id: "page.query",
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
    activity: "page",
    conditionEntity: "page",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.hash_fragment",
    storageSource: "visit",
    storageColumn: "hash_fragment",
    storageNullable: false,
    nullable: true,
  },
  "event.name": {
    id: "event.name",
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
    activity: "page",
    conditionEntity: "activity",
    observationKinds: ["page", "event"],
    compilerStrategy: "column.language",
    storageSource: "visit",
    storageColumn: "language",
    storageNullable: false,
    nullable: true,
  },
  "geo.timeZone": {
    id: "geo.timeZone",
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
    field.valueKind !== "string" ||
    field.profile !== "trimmed-text" ||
    field.compilerStrategy !== contract.compilerStrategy ||
    field.source !== contract.storageSource ||
    field.nativeEntity !== expectedNativeEntity ||
    filterConditionEntity(field) !== contract.conditionEntity ||
    field.evaluation !== "observation" ||
    field.presence !== "non-null-column" ||
    field.empty !== "raw-empty-string" ||
    field.comparison !== "case-sensitive" ||
    field.nullable !== contract.nullable ||
    attribute.id !== contract.id ||
    attribute.valueType.kind !== "scalar" ||
    attribute.valueType.scalar !== "string" ||
    attribute.nativeEntity !== contract.activity ||
    attribute.nullable !== contract.nullable ||
    attribute.evaluation !== "observation" ||
    attribute.presence !== "non-null" ||
    attribute.empty !== "empty-string-is-value" ||
    attribute.comparison !== "case-sensitive"
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
