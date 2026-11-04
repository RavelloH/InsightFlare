import type {
  JourneyAnalysisContext,
  QueryAudience,
  QueryInput,
  QueryTime,
  SessionListSortKey,
  SortDirection,
} from "@/lib/edge/analytics/contract";
import type { DeferredEventQualification } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { readOwnDataProperty } from "@/lib/edge/analytics/providers/d1/internal/overview-previous-time";
import {
  pagesDashboardOwnDataSnapshotsEqual,
  qualificationRequestOwnDataSnapshot,
} from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";

const REQUEST_BRAND = Symbol("insightflare.session-list-qualification");
const brandedRequests = new WeakSet<object>();
const requestOrigins = new WeakMap<object, object>();
export type SessionListQualificationOperation = "sessions" | "visitor-sessions";

export interface SessionListQualificationConfiguration {
  readonly operation: SessionListQualificationOperation;
  readonly analysisContext?: JourneyAnalysisContext;
  readonly visitorId?: string;
  readonly sort: {
    readonly field: SessionListSortKey;
    readonly direction: SortDirection;
  };
  readonly search: string | undefined;
  readonly page: { readonly limit: number; readonly cursor: string | null };
  readonly audience: QueryAudience;
}

export type DeferredSessionListQualificationInput =
  DeferredEventQualification & {
    readonly operation: SessionListQualificationOperation;
    readonly requestTime: QueryTime;
    readonly sessionListRequest: SessionListQualificationConfiguration;
  };

export interface DeferredSessionListQualification {
  readonly operation: SessionListQualificationOperation;
  readonly configuration: SessionListQualificationConfiguration;
  readonly qualification: DeferredSessionListQualificationInput;
  readonly requestSnapshot: string;
}

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
      if (!allowedKeys.includes(key)) return undefined;
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function own(value: unknown, key: string): OwnData {
  return readOwnDataProperty(value, key);
}

function journeyAnalysisContextsEqual(
  left: JourneyAnalysisContext | undefined,
  right: JourneyAnalysisContext | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.type !== right.type) return false;
  if (left.type === "goal" && right.type === "goal")
    return left.goalId === right.goalId;
  if (left.type === "funnel" && right.type === "funnel")
    return (
      left.funnelId === right.funnelId &&
      left.stepId === right.stepId &&
      left.outcome === right.outcome
    );
  return false;
}

const API_V1_ROUTE_KEYS = [
  "filter",
  "timeRange",
  "scope",
  "siteId",
  "startMs",
  "endExclusiveMs",
  "timeZone",
] as const;

function apiV1RouteFieldsMatch(
  query: Record<string, unknown>,
  audience: QueryAudience | undefined,
  subjectSiteId: unknown,
  timeValue: unknown,
): boolean {
  const routeFields = API_V1_ROUTE_KEYS.map((key) => own(query, key));
  if (routeFields.some((field) => !field.valid)) return false;
  if (audience !== "api-v1")
    return routeFields.every((field) => !field.present);

  const siteId = own(query, "siteId");
  const startMs = own(query, "startMs");
  const endExclusiveMs = own(query, "endExclusiveMs");
  const timeZone = own(query, "timeZone");
  const timeRange = own(query, "timeRange");
  const filter = own(query, "filter");
  const scope = own(query, "scope");
  const scopePreference = own(query, "scopePreference");
  const range = own(timeValue, "range");
  const rangeStart = own(range.value, "startMs");
  const rangeEnd = own(range.value, "endExclusiveMs");
  const reportingTimeZone = own(timeValue, "reportingTimeZone");
  return (
    siteId.valid &&
    siteId.present &&
    siteId.value === subjectSiteId &&
    startMs.valid &&
    startMs.present &&
    typeof startMs.value === "number" &&
    Number.isSafeInteger(startMs.value) &&
    range.valid &&
    rangeStart.valid &&
    startMs.value === rangeStart.value &&
    endExclusiveMs.valid &&
    endExclusiveMs.present &&
    typeof endExclusiveMs.value === "number" &&
    Number.isSafeInteger(endExclusiveMs.value) &&
    rangeEnd.valid &&
    endExclusiveMs.value === rangeEnd.value &&
    timeZone.valid &&
    timeZone.present &&
    typeof timeZone.value === "string" &&
    reportingTimeZone.valid &&
    timeZone.value === reportingTimeZone.value &&
    timeRange.valid &&
    timeRange.present &&
    plainRecord(timeRange.value) &&
    filter.valid &&
    scope.valid &&
    scopePreference.valid &&
    scopePreference.present &&
    ["auto", "event", "session", "visitor"].includes(
      scopePreference.value as string,
    ) &&
    (!scope.present ||
      scope.value === undefined ||
      scope.value === scopePreference.value)
  );
}

const TOP_LEVEL_KEYS = [
  "context",
  "time",
  "filters",
  "scopePlan",
  "scopePreference",
  "search",
  "page",
  "limit",
  "cursor",
  "sort",
  "current",
  "reference",
  "comparison",
  "mode",
  "analysisContext",
  "filter",
  "timeRange",
  "scope",
  "siteId",
  "startMs",
  "endExclusiveMs",
  "timeZone",
  "sessionId",
  "visitorId",
  "goalId",
  "funnelId",
] as const;

/** Reads only request-owned data and mirrors the existing Session provider defaults. */
export function sessionListQualificationConfigurationFromQuery(
  value: unknown,
  operation: SessionListQualificationOperation = "sessions",
): SessionListQualificationConfiguration | undefined {
  if (qualificationRequestOwnDataSnapshot(value) === undefined)
    return undefined;
  const query = exactDataRecord(value, TOP_LEVEL_KEYS);
  if (!query) return undefined;

  const context = own(query, "context");
  const time = own(query, "time");
  const filters = own(query, "filters");
  const scopePlan = own(query, "scopePlan");
  const search = own(query, "search");
  const page = own(query, "page");
  const limit = own(query, "limit");
  const cursor = own(query, "cursor");
  const sort = own(query, "sort");
  const visitorId = own(query, "visitorId");
  const analysisContext = own(query, "analysisContext");
  let resolvedAnalysisContext: JourneyAnalysisContext | undefined;
  if (!analysisContext.valid) return undefined;
  if (analysisContext.present && analysisContext.value !== undefined) {
    if (operation !== "sessions") return undefined;
    const discriminator = own(analysisContext.value, "type");
    if (!discriminator.valid) return undefined;
    if (discriminator.value === "goal") {
      const record = exactDataRecord(analysisContext.value, ["type", "goalId"]);
      const type = own(record, "type");
      const goalId = own(record, "goalId");
      if (
        !record ||
        !type.valid ||
        !goalId.valid ||
        type.value !== "goal" ||
        typeof goalId.value !== "string" ||
        goalId.value.length === 0
      )
        return undefined;
      resolvedAnalysisContext = Object.freeze({
        type: "goal",
        goalId: goalId.value,
      });
    } else if (discriminator.value === "funnel") {
      const record = exactDataRecord(analysisContext.value, [
        "type",
        "funnelId",
        "stepId",
        "outcome",
      ]);
      const type = own(record, "type");
      const funnelId = own(record, "funnelId");
      const stepId = own(record, "stepId");
      const outcome = own(record, "outcome");
      if (
        !record ||
        !type.valid ||
        !funnelId.valid ||
        !stepId.valid ||
        !outcome.valid ||
        type.value !== "funnel" ||
        typeof funnelId.value !== "string" ||
        funnelId.value.length === 0 ||
        typeof stepId.value !== "string" ||
        stepId.value.length === 0 ||
        (outcome.present &&
          outcome.value !== "converted" &&
          outcome.value !== "dropoff")
      )
        return undefined;
      resolvedAnalysisContext = Object.freeze({
        type: "funnel",
        funnelId: funnelId.value,
        stepId: stepId.value,
        ...(outcome.present
          ? { outcome: outcome.value as "converted" | "dropoff" }
          : {}),
      });
    } else {
      return undefined;
    }
  }
  const visitorIdInvalid =
    operation === "sessions"
      ? !visitorId.valid || (visitorId.present && visitorId.value !== undefined)
      : !visitorId.valid ||
        !visitorId.present ||
        typeof visitorId.value !== "string" ||
        visitorId.value.length === 0;
  const visitorOnlyRequestHasIgnoredFields =
    operation === "visitor-sessions" &&
    [search, limit, cursor, sort].some(
      (field) => field.present && field.value !== undefined,
    );
  if (
    !context.valid ||
    !time.valid ||
    !time.present ||
    !filters.valid ||
    !filters.present ||
    !scopePlan.valid ||
    !scopePlan.present ||
    scopePlan.value === undefined ||
    !search.valid ||
    (search.present &&
      search.value !== undefined &&
      typeof search.value !== "string") ||
    !page.valid ||
    !limit.valid ||
    !cursor.valid ||
    !sort.valid ||
    visitorIdInvalid ||
    visitorOnlyRequestHasIgnoredFields ||
    [
      "current",
      "reference",
      "comparison",
      "mode",
      "sessionId",
      "goalId",
      "funnelId",
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
  const resolvedAudience: QueryAudience | undefined =
    audience.value === "private-dashboard"
      ? "private-dashboard"
      : audience.value === "api-v1" &&
          operation === "sessions" &&
          !analysisContext.present
        ? "api-v1"
        : undefined;
  const funnelScopeMatches =
    resolvedAnalysisContext?.type !== "funnel" ||
    (resolvedAudience === "private-dashboard" &&
      operation === "sessions" &&
      (() => {
        const scope = own(scopePlan.value, "scope");
        return (
          scope.valid &&
          scope.present &&
          (scope.value === "visitor" || scope.value === "session")
        );
      })());
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
    !resolvedAudience ||
    !funnelScopeMatches ||
    !apiV1RouteFieldsMatch(
      query,
      resolvedAudience,
      subjectSiteId.value,
      time.value,
    )
  )
    return undefined;

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
    (limit.present &&
      limit.value !== undefined &&
      limit.value !== null &&
      (typeof limit.value !== "number" ||
        !Number.isSafeInteger(limit.value) ||
        limit.value < 1)) ||
    (pageCursor.present &&
      pageCursor.value !== undefined &&
      pageCursor.value !== null &&
      typeof pageCursor.value !== "string") ||
    (cursor.present &&
      cursor.value !== undefined &&
      cursor.value !== null &&
      typeof cursor.value !== "string")
  )
    return undefined;
  const resolvedLimit =
    pageLimit.value ??
    (operation === "visitor-sessions" ? 100 : (limit.value ?? 80));
  if (
    typeof resolvedLimit !== "number" ||
    !Number.isSafeInteger(resolvedLimit) ||
    resolvedLimit < 1
  )
    return undefined;
  const resolvedCursor = pageCursor.value ?? cursor.value ?? null;
  if (resolvedCursor !== null && typeof resolvedCursor !== "string")
    return undefined;

  let field: SessionListSortKey = "startedAt";
  let direction: SortDirection = "desc";
  if (operation === "sessions" && sort.present && sort.value !== undefined) {
    const sortRecord = exactDataRecord(
      sort.value,
      resolvedAudience === "api-v1"
        ? ["field", "direction"]
        : ["key", "direction"],
    );
    if (!sortRecord) return undefined;
    const key = own(
      sortRecord,
      resolvedAudience === "api-v1" ? "field" : "key",
    );
    const sortDirection = own(sortRecord, "direction");
    if (
      !key.valid ||
      !sortDirection.valid ||
      (key.present &&
        key.value !== undefined &&
        (typeof key.value !== "string" ||
          !["startedAt", "durationMs", "views"].includes(key.value))) ||
      (sortDirection.present &&
        sortDirection.value !== undefined &&
        sortDirection.value !== "asc" &&
        sortDirection.value !== "desc")
    )
      return undefined;
    if (key.value !== undefined) field = key.value as SessionListSortKey;
    if (sortDirection.value === "asc" || sortDirection.value === "desc")
      direction = sortDirection.value;
  }

  return Object.freeze({
    operation,
    ...(resolvedAnalysisContext
      ? { analysisContext: resolvedAnalysisContext }
      : {}),
    ...(operation === "visitor-sessions"
      ? { visitorId: visitorId.value as string }
      : {}),
    sort: Object.freeze({ field, direction }),
    search:
      operation === "sessions" &&
      typeof search.value === "string" &&
      search.value
        ? search.value
        : undefined,
    page: Object.freeze({ limit: resolvedLimit, cursor: resolvedCursor }),
    audience: resolvedAudience,
  });
}

export function sessionListQualificationConfigurationsEqual(
  left: SessionListQualificationConfiguration,
  right: SessionListQualificationConfiguration,
): boolean {
  return (
    left.operation === right.operation &&
    journeyAnalysisContextsEqual(left.analysisContext, right.analysisContext) &&
    left.visitorId === right.visitorId &&
    left.sort.field === right.sort.field &&
    left.sort.direction === right.sort.direction &&
    left.search === right.search &&
    left.page.limit === right.page.limit &&
    left.page.cursor === right.page.cursor &&
    left.audience === right.audience
  );
}

export function attachSessionListQualificationToQuery(
  query: QueryInput & Record<string, unknown>,
  qualification: DeferredSessionListQualificationInput,
  configuration: SessionListQualificationConfiguration,
): void {
  const current = sessionListQualificationConfigurationFromQuery(
    query,
    qualification.operation,
  );
  const snapshot = qualificationRequestOwnDataSnapshot(query);
  if (
    !current ||
    !sessionListQualificationConfigurationsEqual(current, configuration)
  )
    throw new Error("session_list_qualification_request_configuration_changed");
  if (snapshot === undefined)
    throw new Error("session_list_qualification_request_snapshot_invalid");
  const request: DeferredSessionListQualification = Object.freeze({
    operation: qualification.operation,
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

export function deferredSessionListQualificationFromQuery(
  value: unknown,
): DeferredSessionListQualification | undefined {
  if (!value || typeof value !== "object") return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, REQUEST_BRAND);
  } catch {
    throw new Error("session_list_qualification_request_untrusted");
  }
  if (!descriptor) return undefined;
  if (descriptor.enumerable || !("value" in descriptor))
    throw new Error("session_list_qualification_request_untrusted");
  const request: unknown = descriptor.value;
  if (
    !request ||
    typeof request !== "object" ||
    !brandedRequests.has(request) ||
    requestOrigins.get(request) !== value
  )
    throw new Error("session_list_qualification_request_untrusted");
  const branded = request as DeferredSessionListQualification;
  const configuration = sessionListQualificationConfigurationFromQuery(
    value,
    branded.operation,
  );
  const snapshot = qualificationRequestOwnDataSnapshot(value);
  const context = own(value, "context");
  const subject = own(context.value, "subject");
  const siteId = own(subject.value, "siteId");
  const audience = own(own(context.value, "policy").value, "audience");
  const time = own(value, "time");
  const scopePlan = own(value, "scopePlan");
  const filters = own(value, "filters");
  if (
    !configuration ||
    !sessionListQualificationConfigurationsEqual(
      configuration,
      branded.configuration,
    ) ||
    snapshot === undefined ||
    snapshot !== branded.requestSnapshot ||
    branded.qualification.operation !== branded.operation ||
    !branded.qualification.requestTime ||
    !branded.qualification.sessionListRequest ||
    !sessionListQualificationConfigurationsEqual(
      configuration,
      branded.qualification.sessionListRequest,
    ) ||
    !context.valid ||
    !subject.valid ||
    !siteId.valid ||
    siteId.value !== branded.qualification.siteId ||
    !audience.valid ||
    audience.value !== branded.configuration.audience ||
    !time.valid ||
    !pagesDashboardOwnDataSnapshotsEqual(
      time.value,
      branded.qualification.requestTime,
    ) ||
    !scopePlan.valid ||
    !scopePlan.present ||
    !pagesDashboardOwnDataSnapshotsEqual(
      scopePlan.value,
      branded.qualification.metadata.plan,
    ) ||
    !filters.valid ||
    !filters.present
  )
    throw new Error("session_list_qualification_request_changed");
  return branded;
}

export function assertSessionListQualificationRequest(
  value: unknown,
  query: unknown,
): DeferredSessionListQualification {
  if (!value || typeof value !== "object" || !brandedRequests.has(value))
    throw new Error("session_list_qualification_request_untrusted");
  const origin = requestOrigins.get(value);
  if (
    !origin ||
    origin !== query ||
    deferredSessionListQualificationFromQuery(query) !== value
  )
    throw new Error("session_list_qualification_request_changed");
  return value as DeferredSessionListQualification;
}
