import type {
  Interval,
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import type { DeferredEventQualification } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { parseRetentionGranularity } from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import { readOwnDataProperty } from "@/lib/edge/analytics/providers/d1/internal/overview-previous-time";
import {
  pagesDashboardOwnDataSnapshotsEqual,
  qualificationRequestOwnDataSnapshot,
} from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";

const REQUEST_BRAND = Symbol("insightflare.retention-qualification");
const brandedRequests = new WeakSet<object>();
const requestOrigins = new WeakMap<object, object>();

export type DeferredRetentionQualificationInput = DeferredEventQualification & {
  readonly operation: "retention";
  readonly requestTime: QueryTime;
};

export interface RetentionQualificationConfiguration {
  readonly granularity: Interval;
}

export interface DeferredRetentionQualification {
  readonly operation: "retention";
  readonly configuration: RetentionQualificationConfiguration;
  readonly filterMode: "split-only" | "allow-whole-filter";
  readonly qualification: DeferredRetentionQualificationInput;
  readonly requestSnapshot: string;
}

/** Mirrors stringField(..., "week") while refusing getters and inherited values. */
export function retentionQualificationConfigurationFromQuery(
  value: unknown,
): RetentionQualificationConfiguration | undefined {
  const snapshot = qualificationRequestOwnDataSnapshot(value);
  const granularity = readOwnDataProperty(value, "granularity");
  if (snapshot === undefined || !granularity.valid) return undefined;
  return Object.freeze({
    granularity: parseRetentionGranularity(
      typeof granularity.value === "string" ? granularity.value : null,
    ),
  });
}

export function retentionQualificationConfigurationsEqual(
  left: RetentionQualificationConfiguration,
  right: RetentionQualificationConfiguration,
): boolean {
  return left.granularity === right.granularity;
}

export function attachRetentionQualificationToQuery(
  query: QueryInput & Record<string, unknown>,
  qualification: DeferredRetentionQualificationInput,
  configuration: RetentionQualificationConfiguration,
): void {
  const current = retentionQualificationConfigurationFromQuery(query);
  const snapshot = qualificationRequestOwnDataSnapshot(query);
  if (
    !current ||
    !retentionQualificationConfigurationsEqual(current, configuration)
  )
    throw new Error("retention_qualification_request_configuration_changed");
  if (snapshot === undefined)
    throw new Error("retention_qualification_request_snapshot_invalid");
  const request: DeferredRetentionQualification = Object.freeze({
    operation: "retention",
    configuration,
    filterMode: qualification.retentionFilterMode ?? "split-only",
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

export function deferredRetentionQualificationFromQuery(
  value: unknown,
): DeferredRetentionQualification | undefined {
  if (!value || typeof value !== "object") return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, REQUEST_BRAND);
  } catch {
    throw new Error("retention_qualification_request_untrusted");
  }
  if (!descriptor) return undefined;
  if (descriptor.enumerable || !("value" in descriptor))
    throw new Error("retention_qualification_request_untrusted");
  const request: unknown = descriptor.value;
  if (
    !request ||
    typeof request !== "object" ||
    !brandedRequests.has(request) ||
    requestOrigins.get(request) !== value
  )
    throw new Error("retention_qualification_request_untrusted");
  const branded = request as DeferredRetentionQualification;
  const configuration = retentionQualificationConfigurationFromQuery(value);
  const snapshot = qualificationRequestOwnDataSnapshot(value);
  const filters = readOwnDataProperty(value, "filters");
  const context = readOwnDataProperty(value, "context");
  const subject = readOwnDataProperty(context.value, "subject");
  const siteId = readOwnDataProperty(subject.value, "siteId");
  const audience = readOwnDataProperty(
    readOwnDataProperty(context.value, "policy").value,
    "audience",
  );
  const time = readOwnDataProperty(value, "time");
  const scopePlan = readOwnDataProperty(value, "scopePlan");
  if (
    !configuration ||
    !retentionQualificationConfigurationsEqual(
      configuration,
      branded.configuration,
    ) ||
    snapshot === undefined ||
    snapshot !== branded.requestSnapshot ||
    branded.qualification.operation !== "retention" ||
    branded.filterMode !==
      (branded.qualification.retentionFilterMode ?? "split-only") ||
    branded.qualification.requestTime === undefined ||
    !filters.valid ||
    !context.valid ||
    !subject.valid ||
    !siteId.valid ||
    siteId.value !== branded.qualification.siteId ||
    !audience.valid ||
    audience.value !== "private-dashboard" ||
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
    )
  )
    throw new Error("retention_qualification_request_changed");
  return branded;
}

/** Revalidates both request brand and the exact object passed by middleware. */
export function assertRetentionQualificationRequest(
  value: unknown,
  query: unknown,
): DeferredRetentionQualification {
  if (!value || typeof value !== "object" || !brandedRequests.has(value))
    throw new Error("retention_qualification_request_untrusted");
  const origin = requestOrigins.get(value);
  if (
    !origin ||
    origin !== query ||
    deferredRetentionQualificationFromQuery(query) !== value
  )
    throw new Error("retention_qualification_request_changed");
  return value as DeferredRetentionQualification;
}
