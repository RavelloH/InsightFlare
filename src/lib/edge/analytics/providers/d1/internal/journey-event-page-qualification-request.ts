import type { QueryInput, QueryTime } from "@/lib/edge/analytics/contract";
import { scopedFilterMetadata } from "@/lib/edge/analytics/contract/scoped-filter";
import { resolveQualifiedSourceFilters } from "@/lib/edge/analytics/engine/qualified-page-source";
import type { DeferredEventQualification } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { qualificationRequestOwnDataSnapshot } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export type JourneyEventPageOperation = "visitor-events" | "session-events";

export interface JourneyEventPageQualificationConfiguration {
  readonly operation: JourneyEventPageOperation;
  readonly target: string;
  readonly page: { readonly limit: number; readonly cursor: string | null };
  readonly audience: "private-dashboard";
  readonly filterMode?: "allow-whole-filter";
}

export type DeferredJourneyEventPageQualificationInput =
  DeferredEventQualification & {
    readonly operation: JourneyEventPageOperation;
    readonly requestTime: QueryTime;
    readonly requestScopePlan: NonNullable<
      DeferredEventQualification["requestScopePlan"]
    >;
    readonly journeyEventPageRequest: JourneyEventPageQualificationConfiguration;
  };

export interface DeferredJourneyEventPageQualification {
  readonly operation: JourneyEventPageOperation;
  readonly configuration: JourneyEventPageQualificationConfiguration;
  readonly qualification: DeferredJourneyEventPageQualificationInput;
  readonly requestSnapshot: string;
}

const REQUEST_BRAND = Symbol("insightflare.journey-event-page-qualification");
const brandedRequests = new WeakSet<object>();
const requestOrigins = new WeakMap<object, object>();

type OwnData = {
  readonly valid: boolean;
  readonly present: boolean;
  readonly value?: unknown;
};

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (!plainRecord(value)) return undefined;
  try {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key === "symbol") {
        if (!descriptor || descriptor.enumerable || !("value" in descriptor))
          return undefined;
        continue;
      }
      if (
        !allowedKeys.includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      )
        return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function own(value: unknown, key: string): OwnData {
  if (!value || typeof value !== "object")
    return { valid: false, present: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { valid: true, present: false };
    if (!descriptor.enumerable || !("value" in descriptor))
      return { valid: false, present: true };
    return { valid: true, present: true, value: descriptor.value };
  } catch {
    return { valid: false, present: true };
  }
}

const TOP_LEVEL_KEYS = [
  "context",
  "time",
  "filters",
  "scopePlan",
  "scopePreference",
  "page",
  "limit",
  "cursor",
  "visitorId",
  "sessionId",
  "search",
  "sort",
  "current",
  "reference",
  "comparison",
  "mode",
  "analysisContext",
  "goalId",
  "funnelId",
] as const;

/** Accept only the private, same-site, own-data page request used by Events. */
export function journeyEventPageQualificationConfigurationFromQuery(
  value: unknown,
  operation: JourneyEventPageOperation,
): JourneyEventPageQualificationConfiguration | undefined {
  if (qualificationRequestOwnDataSnapshot(value) === undefined)
    return undefined;
  const query = exactDataRecord(value, TOP_LEVEL_KEYS);
  if (!query) return undefined;

  const context = own(query, "context");
  const time = own(query, "time");
  const filters = own(query, "filters");
  const scopePlan = own(query, "scopePlan");
  const page = own(query, "page");
  const limit = own(query, "limit");
  const cursor = own(query, "cursor");
  const visitorId = own(query, "visitorId");
  const sessionId = own(query, "sessionId");
  if (
    !context.valid ||
    !time.valid ||
    !time.present ||
    !filters.valid ||
    !filters.present ||
    !scopePlan.valid ||
    !scopePlan.present ||
    scopePlan.value === undefined ||
    !page.valid ||
    !limit.valid ||
    !cursor.valid ||
    !visitorId.valid ||
    !sessionId.valid ||
    [
      "search",
      "sort",
      "current",
      "reference",
      "comparison",
      "mode",
      "analysisContext",
      "goalId",
      "funnelId",
      "limit",
      "cursor",
    ].some((key) => {
      const field = own(query, key);
      return !field.valid || (field.present && field.value !== undefined);
    })
  )
    return undefined;

  const contextRecord = exactDataRecord(context.value, ["subject", "policy"]);
  const subjectRead = own(contextRecord, "subject");
  const policyRead = own(contextRecord, "policy");
  const subject = exactDataRecord(subjectRead.value, ["kind", "siteId"]);
  const subjectKind = own(subject, "kind");
  const subjectSiteId = own(subject, "siteId");
  const audience = own(policyRead.value, "audience");
  const targetRead = operation === "visitor-events" ? visitorId : sessionId;
  const otherTargetRead =
    operation === "visitor-events" ? sessionId : visitorId;
  if (
    !contextRecord ||
    !subjectRead.valid ||
    !policyRead.valid ||
    !subject ||
    !subjectKind.valid ||
    !subjectSiteId.valid ||
    !audience.valid ||
    subjectKind.value !== "site" ||
    typeof subjectSiteId.value !== "string" ||
    audience.value !== "private-dashboard" ||
    !targetRead.present ||
    typeof targetRead.value !== "string" ||
    targetRead.value.length === 0 ||
    (otherTargetRead.present && otherTargetRead.value !== undefined)
  )
    return undefined;

  const filterDocument = filters.value as FilterDocument;
  const metadata = scopedFilterMetadata(filterDocument);
  const filterResolution = resolveQualifiedSourceFilters(
    filterDocument,
    "allow-whole-filter",
  );
  if (
    !metadata ||
    !filterDocumentUsesAdvancedExpressions(filterDocument) ||
    metadata.plan.preparedMembership !== undefined ||
    (metadata.resolvedScope !== "visitor" &&
      metadata.resolvedScope !== "session") ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== subjectSiteId.value ||
    filterResolution.kind !== "supported"
  )
    return undefined;

  const timeRecord = exactDataRecord(time.value, [
    "range",
    "readRange",
    "filterRange",
    "filterRangeEmpty",
    "fullHistory",
    "reportingTimeZone",
    "capturedAtMs",
  ]);
  if (!timeRecord) return undefined;

  let pageRecord: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  if (page.present && page.value !== undefined && page.value !== null) {
    const candidate = exactDataRecord(page.value, ["limit", "cursor"]);
    if (!candidate) return undefined;
    pageRecord = candidate;
  }
  const pageLimit = own(pageRecord, "limit");
  const pageCursor = own(pageRecord, "cursor");
  if (
    !pageLimit.valid ||
    !pageCursor.valid ||
    (pageLimit.present &&
      pageLimit.value !== undefined &&
      pageLimit.value !== null &&
      (typeof pageLimit.value !== "number" ||
        !Number.isSafeInteger(pageLimit.value) ||
        pageLimit.value < 1)) ||
    (pageCursor.present &&
      pageCursor.value !== undefined &&
      pageCursor.value !== null &&
      typeof pageCursor.value !== "string")
  )
    return undefined;
  const resolvedLimit = pageLimit.value ?? 100;
  const resolvedCursor = pageCursor.value ?? null;
  if (
    typeof resolvedLimit !== "number" ||
    !Number.isSafeInteger(resolvedLimit) ||
    resolvedLimit < 1 ||
    (resolvedCursor !== null && typeof resolvedCursor !== "string")
  )
    return undefined;

  return Object.freeze({
    operation,
    target: targetRead.value,
    page: Object.freeze({ limit: resolvedLimit, cursor: resolvedCursor }),
    audience: "private-dashboard",
    ...(filterResolution.mode === "whole-filter"
      ? { filterMode: "allow-whole-filter" as const }
      : {}),
  });
}

export function journeyEventPageQualificationConfigurationsEqual(
  left: JourneyEventPageQualificationConfiguration,
  right: JourneyEventPageQualificationConfiguration,
): boolean {
  return (
    left.operation === right.operation &&
    left.target === right.target &&
    left.page.limit === right.page.limit &&
    left.page.cursor === right.page.cursor &&
    left.audience === right.audience &&
    left.filterMode === right.filterMode
  );
}

export function attachJourneyEventPageQualificationToQuery(
  query: QueryInput & Record<string, unknown>,
  qualification: DeferredJourneyEventPageQualificationInput,
  configuration: JourneyEventPageQualificationConfiguration,
): void {
  const current = journeyEventPageQualificationConfigurationFromQuery(
    query,
    configuration.operation,
  );
  const snapshot = qualificationRequestOwnDataSnapshot(query);
  if (
    !current ||
    !journeyEventPageQualificationConfigurationsEqual(current, configuration)
  )
    throw new Error(
      "journey_event_page_qualification_request_configuration_changed",
    );
  if (snapshot === undefined)
    throw new Error(
      "journey_event_page_qualification_request_snapshot_invalid",
    );
  const request: DeferredJourneyEventPageQualification = Object.freeze({
    operation: configuration.operation,
    configuration,
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

export function deferredJourneyEventPageQualificationFromQuery(
  input: unknown,
  expectedOperation?: JourneyEventPageOperation,
): DeferredJourneyEventPageQualification | undefined {
  if (!input || typeof input !== "object") return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, REQUEST_BRAND);
  } catch {
    throw new Error("journey_event_page_qualification_request_changed");
  }
  if (!descriptor) return undefined;
  if (!descriptor.enumerable && "value" in descriptor) {
    const candidate: unknown = descriptor.value;
    if (!candidate || typeof candidate !== "object") return undefined;
    const request = candidate as DeferredJourneyEventPageQualification;
    if (!brandedRequests.has(request) || requestOrigins.get(request) !== input)
      throw new Error("journey_event_page_qualification_request_changed");
    const operation = request.operation;
    const current = journeyEventPageQualificationConfigurationFromQuery(
      input,
      operation,
    );
    const snapshot = qualificationRequestOwnDataSnapshot(input);
    if (
      (expectedOperation !== undefined && operation !== expectedOperation) ||
      request.qualification.operation !== operation ||
      !current ||
      !journeyEventPageQualificationConfigurationsEqual(
        current,
        request.configuration,
      ) ||
      snapshot !== request.requestSnapshot
    )
      throw new Error("journey_event_page_qualification_request_changed");
    return request;
  }
  throw new Error("journey_event_page_qualification_request_changed");
}
