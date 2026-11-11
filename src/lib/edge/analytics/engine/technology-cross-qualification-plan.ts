import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountQualificationPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  PAGE_DIMENSION_SELECTIONS,
  type PageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { appendPageDimensionQualificationSource } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { qualificationPlanMetadata } from "@/lib/edge/analytics/engine/qualification-plan-metadata";
import type { QualifiedSourceFilterMode } from "@/lib/edge/analytics/engine/qualified-page-source";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import {
  appendTechnologyCrossBreakdownReport,
  TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS,
  TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS,
  TECHNOLOGY_CROSS_BROWSER_OTHER_PRIMARY_TOKEN,
  TECHNOLOGY_CROSS_BROWSER_OTHER_SECONDARY_TOKEN,
  TECHNOLOGY_CROSS_BROWSER_UNKNOWN_TOKEN,
  TECHNOLOGY_CROSS_CLIENT_OTHER_PRIMARY_TOKEN,
  TECHNOLOGY_CROSS_CLIENT_OTHER_SECONDARY_TOKEN,
  TECHNOLOGY_CROSS_CLIENT_UNKNOWN_TOKEN,
  type TechnologyCrossBreakdownTokens,
} from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const TECHNOLOGY_CROSS_QUALIFICATION_CONTROL_OUTPUT =
  "technology-cross-qualification-controls";
export const TECHNOLOGY_BROWSER_CROSS_QUALIFICATION_CONTROL_OUTPUT =
  "technology-browser-cross-qualification-controls";

export { TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS };

export const TECHNOLOGY_BROWSER_CROSS_REPORT_OUTPUT_IDS = [
  TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.operatingSystem.primary,
  TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.operatingSystem.secondary,
  TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.operatingSystem.pairs,
  TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.deviceType.primary,
  TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.deviceType.secondary,
  TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.deviceType.pairs,
] as const;

export interface TechnologyCrossDimensionQualificationConfiguration {
  readonly primaryDimension: string;
  readonly secondaryDimension: string;
  readonly primarySelection: PageDimensionSelection;
  readonly secondarySelection: PageDimensionSelection;
  readonly primaryFallbackKeyBase: string;
  readonly secondaryFallbackKeyBase: string;
  readonly primaryLimit: number;
  readonly secondaryLimit: number;
}

export interface TechnologyBrowserCrossQualificationConfiguration {
  readonly family: "browser";
  readonly variant: "browser";
  readonly browserLimitPresent: boolean;
  readonly browserLimit: number | null | undefined;
  readonly osLimitPresent: boolean;
  readonly osLimit: number | null | undefined;
  readonly deviceTypeLimitPresent: boolean;
  readonly deviceTypeLimit: number | null | undefined;
}

export type TechnologyCrossQualificationConfiguration =
  | TechnologyCrossDimensionQualificationConfiguration
  | TechnologyBrowserCrossQualificationConfiguration;

export type TechnologyCrossQualificationPlan = AnalyticsQualificationPlan<
  "session" | "visitor" | "event"
> & {
  readonly reportOutputIds: readonly [string, string, string];
};

export type TechnologyBrowserCrossQualificationPlan =
  AnalyticsQualificationPlan<"session" | "visitor" | "event"> & {
    readonly reportOutputIds: typeof TECHNOLOGY_BROWSER_CROSS_REPORT_OUTPUT_IDS;
  };

const CROSS_ATTRIBUTES = [
  "page.report.sessionId",
  "page.report.visitorId",
] as const satisfies readonly SemanticAttributeId[];

const CROSS_TOKENS: TechnologyCrossBreakdownTokens = {
  unknown: TECHNOLOGY_CROSS_CLIENT_UNKNOWN_TOKEN,
  otherPrimary: TECHNOLOGY_CROSS_CLIENT_OTHER_PRIMARY_TOKEN,
  otherSecondary: TECHNOLOGY_CROSS_CLIENT_OTHER_SECONDARY_TOKEN,
};

const BROWSER_CROSS_TOKENS: TechnologyCrossBreakdownTokens = {
  unknown: TECHNOLOGY_CROSS_BROWSER_UNKNOWN_TOKEN,
  otherPrimary: TECHNOLOGY_CROSS_BROWSER_OTHER_PRIMARY_TOKEN,
  otherSecondary: TECHNOLOGY_CROSS_BROWSER_OTHER_SECONDARY_TOKEN,
};

const GENERIC_CONFIGURATION_FIELDS = [
  "primaryDimension",
  "secondaryDimension",
  "primarySelection",
  "secondarySelection",
  "primaryFallbackKeyBase",
  "secondaryFallbackKeyBase",
  "primaryLimit",
  "secondaryLimit",
] as const;

const BROWSER_CONFIGURATION_FIELDS = [
  "family",
  "variant",
  "browserLimitPresent",
  "browserLimit",
  "osLimitPresent",
  "osLimit",
  "deviceTypeLimitPresent",
  "deviceTypeLimit",
] as const;

const STORED_SELECTION_FIELDS = [
  "id",
  "kind",
  "attribute",
  "normalization",
] as const;
const DERIVED_SELECTION_FIELDS = ["id", "kind", "dimension"] as const;

function ownEnumerableDataFields(
  value: unknown,
  expectedFields: readonly string[],
): ReadonlyMap<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedFields.length ||
      keys.some((key) => typeof key !== "string") ||
      expectedFields.some((key) => !keys.includes(key))
    )
      return undefined;
    const fields = new Map<string, unknown>();
    for (const key of expectedFields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
      fields.set(key, descriptor.value);
    }
    return fields;
  } catch {
    return undefined;
  }
}

function safeSelectionFields(
  value: unknown,
): ReadonlyMap<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  try {
    const kind = Object.getOwnPropertyDescriptor(value, "kind");
    if (!kind || !kind.enumerable || !("value" in kind)) return undefined;
    const fields = ownEnumerableDataFields(
      value,
      kind.value === "stored"
        ? STORED_SELECTION_FIELDS
        : kind.value === "derived"
          ? DERIVED_SELECTION_FIELDS
          : [],
    );
    if (!fields) return undefined;
    for (const field of fields.values()) {
      if (typeof field !== "string") return undefined;
    }
    return fields;
  } catch {
    return undefined;
  }
}

function sameSelection(left: unknown, right: unknown): boolean {
  const leftFields = safeSelectionFields(left);
  const rightFields = safeSelectionFields(right);
  if (!leftFields || !rightFields) return false;
  for (const [key, value] of leftFields) {
    if (!Object.is(value, rightFields.get(key))) return false;
  }
  return true;
}

/** Safely compares request-local Cross configs by own data values, independent of key order. */
export function sameTechnologyCrossQualificationConfiguration(
  left: unknown,
  right: TechnologyCrossQualificationConfiguration,
): boolean {
  const fields =
    "family" in right && right.family === "browser"
      ? BROWSER_CONFIGURATION_FIELDS
      : GENERIC_CONFIGURATION_FIELDS;
  const leftFields = ownEnumerableDataFields(left, fields);
  const rightFields = ownEnumerableDataFields(right, fields);
  if (!leftFields || !rightFields) return false;
  if (fields === BROWSER_CONFIGURATION_FIELDS) {
    return fields.every((key) =>
      Object.is(leftFields.get(key), rightFields.get(key)),
    );
  }
  for (const key of [
    "primaryDimension",
    "secondaryDimension",
    "primaryFallbackKeyBase",
    "secondaryFallbackKeyBase",
    "primaryLimit",
    "secondaryLimit",
  ]) {
    if (!Object.is(leftFields.get(key), rightFields.get(key))) return false;
  }
  return (
    sameSelection(
      leftFields.get("primarySelection"),
      rightFields.get("primarySelection"),
    ) &&
    sameSelection(
      leftFields.get("secondarySelection"),
      rightFields.get("secondarySelection"),
    )
  );
}

/** Builds one prepared Page bag, all three original Cross outputs, and controls. */
export function buildTechnologyCrossQualificationPlan(input: {
  readonly configuration: TechnologyCrossDimensionQualificationConfiguration;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountQualificationPlanInput;
  readonly eventCandidateReportProjection?: "page-visits";
}): TechnologyCrossQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "cross-dimension",
    preparedTimePolicy: "reader-window-v1",
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    filterMode: input.eventCandidateReportProjection
      ? "allow-whole-filter"
      : input.filterMode,
    scopePlan: input.scopePlan,
    count: input.count,
    ...(input.eventCandidateReportProjection
      ? { eventCandidateReportProjection: input.eventCandidateReportProjection }
      : {}),
    selections: [
      input.configuration.primarySelection,
      input.configuration.secondarySelection,
    ],
    additionalAttributes: CROSS_ATTRIBUTES,
  });
  appendTechnologyCrossBreakdownReport({
    builder: source.builder,
    pages: source.qualifiedPages,
    family: "client",
    primarySelection: input.configuration.primarySelection,
    secondarySelection: input.configuration.secondarySelection,
    primaryLimit: input.configuration.primaryLimit,
    secondaryLimit: input.configuration.secondaryLimit,
    tokens: CROSS_TOKENS,
  });
  const controlFields = Object.keys(source.qualification.controls.slots).map(
    (name) => ({ name, slot: name }),
  );
  source.builder.output(
    TECHNOLOGY_CROSS_QUALIFICATION_CONTROL_OUTPUT,
    source.qualification.controls,
    controlFields,
  );
  return {
    plan: source.builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: source.qualification.matches.id,
    controlsRelationId: source.qualification.controls.id,
    groupedSummaryRelationId: source.qualification.groupedSummary.id,
    controlOutputId: TECHNOLOGY_CROSS_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: Object.values(TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS) as [
      string,
      string,
      string,
    ],
    numericCompatibilityFields: source.qualification.numericCompatibilityFields,
    scope: source.qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
    ...qualificationPlanMetadata(
      source.qualification,
      source.eventCandidateReportProjection,
    ),
  };
}

/** Builds both browser matrices against one prepared Page and Count relation. */
export function buildTechnologyBrowserCrossQualificationPlan(input: {
  readonly configuration: TechnologyBrowserCrossQualificationConfiguration;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountQualificationPlanInput;
  readonly eventCandidateReportProjection?: "page-visits";
}): TechnologyBrowserCrossQualificationPlan {
  const source = appendPageDimensionQualificationSource({
    semanticOperation: "cross-dimension",
    preparedTimePolicy: "reader-window-v1",
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    filterMode: input.eventCandidateReportProjection
      ? "allow-whole-filter"
      : input.filterMode,
    scopePlan: input.scopePlan,
    count: input.count,
    ...(input.eventCandidateReportProjection
      ? { eventCandidateReportProjection: input.eventCandidateReportProjection }
      : {}),
    selections: [
      PAGE_DIMENSION_SELECTIONS.browser,
      PAGE_DIMENSION_SELECTIONS.operatingSystem,
      PAGE_DIMENSION_SELECTIONS.deviceType,
    ],
    additionalAttributes: CROSS_ATTRIBUTES,
  });
  appendTechnologyCrossBreakdownReport({
    builder: source.builder,
    pages: source.qualifiedPages,
    family: "browser",
    primarySelection: PAGE_DIMENSION_SELECTIONS.browser,
    secondarySelection: PAGE_DIMENSION_SELECTIONS.operatingSystem,
    primaryLimit: input.configuration.browserLimit ?? 8,
    secondaryLimit: input.configuration.osLimit ?? 6,
    tokens: BROWSER_CROSS_TOKENS,
    outputIds: TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.operatingSystem,
  });
  appendTechnologyCrossBreakdownReport({
    builder: source.builder,
    pages: source.qualifiedPages,
    family: "browser",
    primarySelection: PAGE_DIMENSION_SELECTIONS.browser,
    secondarySelection: PAGE_DIMENSION_SELECTIONS.deviceType,
    primaryLimit: input.configuration.browserLimit ?? 8,
    secondaryLimit: input.configuration.deviceTypeLimit ?? 5,
    tokens: BROWSER_CROSS_TOKENS,
    outputIds: TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.deviceType,
  });
  const controlFields = Object.keys(source.qualification.controls.slots).map(
    (name) => ({ name, slot: name }),
  );
  source.builder.output(
    TECHNOLOGY_BROWSER_CROSS_QUALIFICATION_CONTROL_OUTPUT,
    source.qualification.controls,
    controlFields,
  );
  return {
    plan: source.builder.finish(),
    primaryReportSourceRelationId: source.pageSource.pages.id,
    matchesRelationId: source.qualification.matches.id,
    controlsRelationId: source.qualification.controls.id,
    groupedSummaryRelationId: source.qualification.groupedSummary.id,
    controlOutputId: TECHNOLOGY_BROWSER_CROSS_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: TECHNOLOGY_BROWSER_CROSS_REPORT_OUTPUT_IDS,
    numericCompatibilityFields: source.qualification.numericCompatibilityFields,
    scope: source.qualification.scope,
    reportSourceRelations: source.reportSourceRelations,
    ...qualificationPlanMetadata(
      source.qualification,
      source.eventCandidateReportProjection,
    ),
  };
}
