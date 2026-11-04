import {
  analyticsFilterDefinition,
  type QueryAudience,
  type QueryInput,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  crossBreakdownPageDimensionSelection,
  PAGE_DIMENSION_SELECTIONS,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import type { DeferredEventQualification } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { readOwnDataProperty } from "@/lib/edge/analytics/providers/d1/internal/overview-previous-time";
import {
  pagesDashboardOwnDataSnapshotsEqual,
  qualificationRequestOwnDataSnapshot,
} from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";

const REQUEST_BRAND = Symbol("insightflare.filter-values-qualification");
const brandedRequests = new WeakSet<object>();
const requestOrigins = new WeakMap<object, object>();

interface FilterValuesQualificationConfigurationBase {
  readonly field: string;
  readonly limit: number;
  readonly cursorToken: string | null;
  readonly search?: string;
  readonly audience: QueryAudience;
}

export type FilterValuesQualificationConfiguration =
  | (FilterValuesQualificationConfigurationBase & {
      readonly reportKind: "page";
      readonly selection: PageDimensionSelection;
    })
  | (FilterValuesQualificationConfigurationBase & {
      readonly reportKind: "session-boundary";
      readonly field: "session.entryPath" | "session.exitPath";
    })
  | (FilterValuesQualificationConfigurationBase & {
      readonly reportKind: "event";
      readonly field: "event.name";
    })
  | (FilterValuesQualificationConfigurationBase & {
      readonly reportKind: "referrer";
      readonly field: "referrer.domain" | "referrer.url";
    });

export type DeferredFilterValuesQualificationInput =
  DeferredEventQualification & {
    readonly operation: "filter-values";
    readonly requestTime: QueryTime;
    readonly filterValuesRequest: FilterValuesQualificationConfiguration;
  };

export interface DeferredFilterValuesQualification {
  readonly operation: "filter-values";
  readonly configuration: FilterValuesQualificationConfiguration;
  readonly filterMode: "split-only" | "allow-whole-filter";
  readonly qualification: DeferredFilterValuesQualificationInput;
  readonly requestSnapshot: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function selectionForField(
  field: string,
  audience: QueryAudience,
): PageDimensionSelection | undefined {
  const definition = analyticsFilterDefinition(field);
  if (
    !definition ||
    definition.source === "payload" ||
    !definition.audiences.has(audience) ||
    definition.suggestionMode === "boolean" ||
    definition.suggestionMode === "none" ||
    field === "event.name" ||
    field === "referrer.domain" ||
    field === "referrer.url" ||
    field === "session.entryPath" ||
    field === "session.exitPath"
  )
    return undefined;
  const selection =
    field === "traffic.channel"
      ? PAGE_DIMENSION_SELECTIONS.trafficChannel
      : crossBreakdownPageDimensionSelection(field);
  return selection ? Object.freeze({ ...selection }) : undefined;
}

/** Parse only own data values while matching site.ts's page and search defaults. */
export function filterValuesQualificationConfigurationFromQuery(
  value: unknown,
): FilterValuesQualificationConfiguration | undefined {
  if (qualificationRequestOwnDataSnapshot(value) === undefined)
    return undefined;
  const field = readOwnDataProperty(value, "field");
  const context = readOwnDataProperty(value, "context");
  const subject = readOwnDataProperty(context.value, "subject");
  const policy = readOwnDataProperty(context.value, "policy");
  const audience = readOwnDataProperty(policy.value, "audience");
  const page = readOwnDataProperty(value, "page");
  const search = readOwnDataProperty(value, "search");
  if (
    !field.valid ||
    typeof field.value !== "string" ||
    !context.valid ||
    !subject.valid ||
    readOwnDataProperty(subject.value, "kind").value !== "site" ||
    !policy.valid ||
    !audience.valid ||
    audience.value !== "private-dashboard" ||
    !page.valid ||
    !search.valid ||
    (search.present &&
      search.value !== undefined &&
      typeof search.value !== "string")
  )
    return undefined;

  let limit = 50;
  let cursorToken: string | null = null;
  if (page.present && page.value !== undefined && page.value !== null) {
    if (!isPlainRecord(page.value)) return undefined;
    const pageLimit = readOwnDataProperty(page.value, "limit");
    const pageCursor = readOwnDataProperty(page.value, "cursor");
    if (!pageLimit.valid || !pageCursor.valid) return undefined;
    limit =
      typeof pageLimit.value === "number" && Number.isFinite(pageLimit.value)
        ? pageLimit.value
        : 50;
    cursorToken =
      typeof pageCursor.value === "string" ? pageCursor.value : null;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    return undefined;

  const audienceValue = audience.value as QueryAudience;
  if (field.value === "event.name") {
    const definition = analyticsFilterDefinition(field.value);
    if (
      !definition ||
      definition.source === "payload" ||
      !definition.audiences.has(audienceValue) ||
      definition.suggestionMode === "boolean" ||
      definition.suggestionMode === "none"
    )
      return undefined;
    return Object.freeze({
      reportKind: "event",
      field: "event.name",
      limit,
      cursorToken,
      ...(search.value !== undefined ? { search: search.value as string } : {}),
      audience: audienceValue,
    });
  }
  if (
    field.value === "session.entryPath" ||
    field.value === "session.exitPath"
  ) {
    const definition = analyticsFilterDefinition(field.value);
    if (
      !definition ||
      definition.source === "payload" ||
      !definition.audiences.has(audienceValue) ||
      definition.suggestionMode === "boolean" ||
      definition.suggestionMode === "none"
    )
      return undefined;
    return Object.freeze({
      reportKind: "session-boundary",
      field: field.value,
      limit,
      cursorToken,
      ...(search.value !== undefined ? { search: search.value as string } : {}),
      audience: audienceValue,
    });
  }
  if (field.value === "referrer.domain" || field.value === "referrer.url") {
    const definition = analyticsFilterDefinition(field.value);
    if (
      !definition ||
      definition.source === "payload" ||
      !definition.audiences.has(audienceValue) ||
      definition.suggestionMode === "boolean" ||
      definition.suggestionMode === "none"
    )
      return undefined;
    return Object.freeze({
      reportKind: "referrer",
      field: field.value,
      limit,
      cursorToken,
      ...(search.value !== undefined ? { search: search.value as string } : {}),
      audience: audienceValue,
    });
  }
  const selection = selectionForField(field.value, audienceValue);
  if (!selection) return undefined;
  return Object.freeze({
    reportKind: "page",
    field: field.value,
    selection,
    limit,
    cursorToken,
    ...(search.value !== undefined ? { search: search.value as string } : {}),
    audience: audienceValue,
  });
}

export function filterValuesQualificationConfigurationsEqual(
  left: FilterValuesQualificationConfiguration,
  right: FilterValuesQualificationConfiguration,
): boolean {
  const sameRequest =
    left.reportKind === right.reportKind &&
    left.field === right.field &&
    left.limit === right.limit &&
    left.cursorToken === right.cursorToken &&
    left.search === right.search &&
    left.audience === right.audience;
  if (!sameRequest) return false;
  if (left.reportKind === "event") return right.reportKind === "event";
  if (left.reportKind === "session-boundary")
    return right.reportKind === "session-boundary";
  if (left.reportKind === "referrer") return right.reportKind === "referrer";
  return (
    right.reportKind === "page" &&
    JSON.stringify(left.selection) === JSON.stringify(right.selection)
  );
}

export function attachFilterValuesQualificationToQuery(
  query: QueryInput & Record<string, unknown>,
  qualification: DeferredFilterValuesQualificationInput,
  configuration: FilterValuesQualificationConfiguration,
): void {
  const current = filterValuesQualificationConfigurationFromQuery(query);
  const snapshot = qualificationRequestOwnDataSnapshot(query);
  if (
    !current ||
    !filterValuesQualificationConfigurationsEqual(current, configuration) ||
    qualification.operation !== "filter-values" ||
    !qualification.filterValuesRequest ||
    !filterValuesQualificationConfigurationsEqual(
      qualification.filterValuesRequest,
      configuration,
    )
  )
    throw new Error(
      "filter_values_qualification_request_configuration_changed",
    );
  if (snapshot === undefined)
    throw new Error("filter_values_qualification_request_snapshot_invalid");
  const request: DeferredFilterValuesQualification = Object.freeze({
    operation: "filter-values",
    configuration,
    filterMode: qualification.filterValuesFilterMode ?? "split-only",
    qualification,
    requestSnapshot: snapshot,
  });
  brandedRequests.add(request);
  requestOrigins.set(request, query);
  Object.defineProperty(query, REQUEST_BRAND, {
    value: request,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

export function deferredFilterValuesQualificationFromQuery(
  value: unknown,
): DeferredFilterValuesQualification | undefined {
  if (!value || typeof value !== "object") return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, REQUEST_BRAND);
  } catch {
    throw new Error("filter_values_qualification_request_untrusted");
  }
  if (!descriptor) return undefined;
  if (descriptor.enumerable || !("value" in descriptor))
    throw new Error("filter_values_qualification_request_untrusted");
  const candidate: unknown = descriptor.value;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !brandedRequests.has(candidate) ||
    requestOrigins.get(candidate) !== value
  )
    throw new Error("filter_values_qualification_request_untrusted");
  const request = candidate as DeferredFilterValuesQualification;
  const configuration = filterValuesQualificationConfigurationFromQuery(value);
  const snapshot = qualificationRequestOwnDataSnapshot(value);
  const filters = readOwnDataProperty(value, "filters");
  const context = readOwnDataProperty(value, "context");
  const subject = readOwnDataProperty(context.value, "subject");
  const siteId = readOwnDataProperty(subject.value, "siteId");
  const time = readOwnDataProperty(value, "time");
  const scopePlan = readOwnDataProperty(value, "scopePlan");
  const deferred = request.qualification;
  if (
    !configuration ||
    !filterValuesQualificationConfigurationsEqual(
      configuration,
      request.configuration,
    ) ||
    snapshot === undefined ||
    snapshot !== request.requestSnapshot ||
    deferred.operation !== "filter-values" ||
    deferred.filterValuesRequest === undefined ||
    !filterValuesQualificationConfigurationsEqual(
      deferred.filterValuesRequest,
      request.configuration,
    ) ||
    request.filterMode !== (deferred.filterValuesFilterMode ?? "split-only") ||
    (request.filterMode !== "split-only" &&
      request.filterMode !== "allow-whole-filter") ||
    deferred.requestTime === undefined ||
    !filters.valid ||
    filters.value !== deferred.filters ||
    !context.valid ||
    !subject.valid ||
    !siteId.valid ||
    siteId.value !== deferred.siteId ||
    !time.valid ||
    !pagesDashboardOwnDataSnapshotsEqual(time.value, deferred.requestTime) ||
    (scopePlan.present &&
      (!scopePlan.valid ||
        !pagesDashboardOwnDataSnapshotsEqual(
          scopePlan.value,
          deferred.metadata.plan,
        )))
  )
    throw new Error("filter_values_qualification_request_changed");
  return request;
}

export function assertFilterValuesQualificationRequest(
  value: unknown,
  query: unknown,
): DeferredFilterValuesQualification {
  if (!value || typeof value !== "object" || !brandedRequests.has(value))
    throw new Error("filter_values_qualification_request_untrusted");
  const origin = requestOrigins.get(value);
  if (
    !origin ||
    origin !== query ||
    deferredFilterValuesQualificationFromQuery(query) !== value
  )
    throw new Error("filter_values_qualification_request_changed");
  return value as DeferredFilterValuesQualification;
}
