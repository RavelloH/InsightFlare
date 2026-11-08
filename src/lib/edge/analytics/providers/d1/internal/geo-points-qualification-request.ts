import {
  EMPTY_FILTER_DOCUMENT,
  type QueryInput,
} from "@/lib/edge/analytics/contract";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { JourneyGeoSummaryLevel } from "@/lib/edge/analytics/engine/journey-geo-report-plan";
import { journeyGeoSummaryLevelFromFilter } from "@/lib/edge/analytics/engine/journey-geo-report-plan";
import type {
  DeferredEventCandidatePageProjectionFor,
  DeferredEventQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { readOwnDataProperty } from "@/lib/edge/analytics/providers/d1/internal/overview-previous-time";
import {
  pagesDashboardOwnDataSnapshotsEqual,
  qualificationRequestOwnDataSnapshot,
} from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const REQUEST_BRAND = Symbol("insightflare.geo-points-qualification");
const brandedRequests = new WeakSet<object>();
const requestOrigins = new WeakMap<object, object>();

export interface GeoPointsQualificationConfiguration {
  readonly limit: number;
  readonly summaryLevel: JourneyGeoSummaryLevel;
}

export type DeferredGeoPointsQualificationInput =
  | (DeferredEventQualification & {
      readonly operation: "geo-points";
      readonly requestTime: QueryTime;
    })
  | DeferredEventCandidatePageProjectionFor<"geo-points">;

export interface DeferredGeoPointsQualification {
  readonly operation: "geo-points";
  readonly configuration: GeoPointsQualificationConfiguration;
  readonly filterMode: "split-only" | "allow-whole-filter";
  readonly qualification: DeferredGeoPointsQualificationInput;
  readonly requestSnapshot: string;
}

function isFilterDocument(value: unknown): value is FilterDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    readOwnDataProperty(value, "version").value === 1 &&
    readOwnDataProperty(value, "root").valid
  );
}

/** Uses the legacy numberField behavior while reading only own data values. */
export function geoPointsLimitFromQuery(value: unknown): number {
  const limit = readOwnDataProperty(value, "limit");
  return limit.valid &&
    typeof limit.value === "number" &&
    Number.isFinite(limit.value)
    ? limit.value
    : 5000;
}

export function geoPointsQualificationConfigurationFromQuery(
  value: unknown,
): GeoPointsQualificationConfiguration | undefined {
  const snapshot = qualificationRequestOwnDataSnapshot(value);
  const filtersProperty = readOwnDataProperty(value, "filters");
  const limitProperty = readOwnDataProperty(value, "limit");
  if (
    snapshot === undefined ||
    !filtersProperty.valid ||
    !limitProperty.valid ||
    (filtersProperty.present &&
      filtersProperty.value !== undefined &&
      !isFilterDocument(filtersProperty.value))
  )
    return undefined;
  const filters =
    filtersProperty.value === undefined
      ? EMPTY_FILTER_DOCUMENT
      : (filtersProperty.value as FilterDocument);
  return Object.freeze({
    limit: geoPointsLimitFromQuery(value),
    summaryLevel: journeyGeoSummaryLevelFromFilter(filters),
  });
}

export function geoPointsQualificationConfigurationsEqual(
  left: GeoPointsQualificationConfiguration,
  right: GeoPointsQualificationConfiguration,
): boolean {
  return (
    Object.is(left.limit, right.limit) &&
    left.summaryLevel === right.summaryLevel
  );
}

export function attachGeoPointsQualificationToQuery(
  query: QueryInput & Record<string, unknown>,
  qualification: DeferredGeoPointsQualificationInput,
  configuration: GeoPointsQualificationConfiguration,
): void {
  const current = geoPointsQualificationConfigurationFromQuery(query);
  const snapshot = qualificationRequestOwnDataSnapshot(query);
  if (
    !current ||
    !geoPointsQualificationConfigurationsEqual(current, configuration)
  )
    throw new Error("geo_points_qualification_request_configuration_changed");
  if (snapshot === undefined)
    throw new Error("geo_points_qualification_request_snapshot_invalid");
  const request: DeferredGeoPointsQualification = Object.freeze({
    operation: "geo-points",
    configuration,
    filterMode: qualification.geoPointsFilterMode ?? "split-only",
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

export function deferredGeoPointsQualificationFromQuery(
  value: unknown,
): DeferredGeoPointsQualification | undefined {
  if (!value || typeof value !== "object") return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, REQUEST_BRAND);
  } catch {
    throw new Error("geo_points_qualification_request_untrusted");
  }
  if (!descriptor) return undefined;
  if (descriptor.enumerable || !("value" in descriptor))
    throw new Error("geo_points_qualification_request_untrusted");
  const request: unknown = descriptor.value;
  if (
    !request ||
    typeof request !== "object" ||
    !brandedRequests.has(request) ||
    requestOrigins.get(request) !== value
  )
    throw new Error("geo_points_qualification_request_untrusted");
  const branded = request as DeferredGeoPointsQualification;
  const configuration = geoPointsQualificationConfigurationFromQuery(value);
  const snapshot = qualificationRequestOwnDataSnapshot(value);
  const filters = readOwnDataProperty(value, "filters");
  const context = readOwnDataProperty(value, "context");
  const subject = readOwnDataProperty(context.value, "subject");
  const siteId = readOwnDataProperty(subject.value, "siteId");
  const time = readOwnDataProperty(value, "time");
  const scopePlan = readOwnDataProperty(value, "scopePlan");
  if (
    !configuration ||
    !geoPointsQualificationConfigurationsEqual(
      configuration,
      branded.configuration,
    ) ||
    snapshot === undefined ||
    snapshot !== branded.requestSnapshot ||
    branded.qualification.operation !== "geo-points" ||
    branded.filterMode !==
      (branded.qualification.geoPointsFilterMode ?? "split-only") ||
    branded.qualification.requestTime === undefined ||
    !filters.valid ||
    !context.valid ||
    !subject.valid ||
    !siteId.valid ||
    siteId.value !== branded.qualification.siteId ||
    !time.valid ||
    !pagesDashboardOwnDataSnapshotsEqual(
      time.value,
      branded.qualification.requestTime,
    ) ||
    (scopePlan.present &&
      (!scopePlan.valid ||
        !pagesDashboardOwnDataSnapshotsEqual(
          scopePlan.value,
          branded.qualification.metadata.plan,
        )))
  )
    throw new Error("geo_points_qualification_request_changed");
  return branded;
}

/** Revalidate the original query brand and snapshot at execution time. */
export function assertGeoPointsQualificationRequest(
  value: unknown,
  query: unknown,
): DeferredGeoPointsQualification {
  if (!value || typeof value !== "object" || !brandedRequests.has(value))
    throw new Error("geo_points_qualification_request_untrusted");
  const origin = requestOrigins.get(value);
  if (
    !origin ||
    origin !== query ||
    deferredGeoPointsQualificationFromQuery(query) !== value
  )
    throw new Error("geo_points_qualification_request_changed");
  return value as DeferredGeoPointsQualification;
}
