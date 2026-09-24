import type { ApiV1RouteVariantId } from "./route-registry";
import {
  apiV1ApplicationRouteRegistry,
  apiV1BatchEligibleRouteIds,
  apiV1BatchRouteRegistry,
  apiV1RouteRegistry,
} from "./route-registry";
const apiV1BatchEligibleRouteIdSet = new Set<string>(
  apiV1BatchEligibleRouteIds,
);
export function isApiV1BatchEligible(routeId: string): boolean {
  return apiV1BatchEligibleRouteIdSet.has(routeId);
}
export function isApiV1RouteVariantId(
  value: string,
): value is ApiV1RouteVariantId {
  return ["default", "previous-period", "explicit"].includes(value);
}
export function apiV1RouteVariantIds(
  route: object,
): readonly ApiV1RouteVariantId[] {
  const variants = (route as { variants?: readonly ApiV1RouteVariantId[] })
    .variants;
  return variants ?? ["default"];
}
export function apiV1ApplicationRouteById(
  id: string,
): (typeof apiV1ApplicationRouteRegistry)[number] | undefined {
  return apiV1ApplicationRouteRegistry.find((route) => route.id === id);
}
export function apiV1BatchRouteById(
  id: string,
): (typeof apiV1BatchRouteRegistry)[number] | undefined {
  return apiV1BatchRouteRegistry.find((route) => route.id === id);
}
export function apiV1AnalyticsRouteById(
  id: string,
):
  | Exclude<
      (typeof apiV1RouteRegistry)[number],
      (typeof apiV1ApplicationRouteRegistry)[number]
    >
  | undefined {
  return apiV1RouteRegistry.find(
    (route) =>
      route.id === id &&
      (route.id.startsWith("site.analytics.") ||
        route.id.startsWith("team.analytics.")),
  ) as
    | Exclude<
        (typeof apiV1RouteRegistry)[number],
        (typeof apiV1ApplicationRouteRegistry)[number]
      >
    | undefined;
}
export function apiV1RouteById(
  id: string,
): (typeof apiV1RouteRegistry)[number] | undefined {
  return apiV1RouteRegistry.find((route) => route.id === id);
}
