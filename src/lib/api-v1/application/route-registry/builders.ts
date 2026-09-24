// Static route descriptors stay together for API schema generation and policy review.
// Lookup behavior is kept in route-lookups.ts.

import { analyticsOperationById } from "@/lib/edge/analytics/application/operation-registry";

import type {
  ApiV1AnalyticsComparisonRouteDescriptor,
  ApiV1AnalyticsRouteDescriptor,
  ApiV1ApplicationRouteDescriptor,
} from "./types";
export function analyticsRoute<Id extends string>(
  descriptor: ApiV1AnalyticsRouteDescriptor<Id>,
): ApiV1AnalyticsRouteDescriptor<Id>;
export function analyticsRoute<Id extends string>(
  descriptor: ApiV1AnalyticsComparisonRouteDescriptor<Id>,
): ApiV1AnalyticsComparisonRouteDescriptor<Id>;
export function analyticsRoute<Id extends string>(
  descriptor:
    | ApiV1AnalyticsRouteDescriptor<Id>
    | ApiV1AnalyticsComparisonRouteDescriptor<Id>,
) {
  const comparison = [
    "site.analytics.comparison",
    "site.analytics.comparisonBreakdown",
    "team.analytics.comparison",
    "team.analytics.comparisonBreakdown",
  ].includes(descriptor.operationId);
  if (!comparison && !analyticsOperationById(descriptor.operationId)) {
    throw new Error(`Unknown analytics operation: ${descriptor.operationId}`);
  }
  return descriptor;
}
export function applicationRoute<Id extends string>(
  descriptor: ApiV1ApplicationRouteDescriptor<Id>,
): ApiV1ApplicationRouteDescriptor<Id> {
  return descriptor;
}
