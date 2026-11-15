import { dimensionPageSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";

/** Closed reader vocabulary only; no audience, site, or qualification authority. */
export const PAGE_MEMBERSHIP_DIMENSIONS = Object.freeze([
  "page.path",
  "page.title",
  "page.hostname",
  "page.query",
  "page.hash",
  "referrer.domain",
  "referrer.url",
  "utm.source",
  "utm.medium",
  "utm.campaign",
  "utm.term",
  "utm.content",
  "client.browser",
  "browser",
  "client.browserVersion",
  "client.browserEngine",
  "client.os",
  "operatingSystem",
  "client.osVersion",
  "osVersion",
  "client.deviceType",
  "deviceType",
  "client.language",
  "language",
  "client.screenSize",
  "screenSize",
  "geo.country",
  "geo.region",
  "geo.city",
  "geo.continent",
  "geo.timeZone",
  "geo.organization",
  "user.id",
  "user.name",
  "country",
  "geo.timezone",
  "traffic.channel",
] as const);
export type PageMembershipDimension =
  (typeof PAGE_MEMBERSHIP_DIMENSIONS)[number];
export function pageMembershipDimensionContract(value: string) {
  if (!PAGE_MEMBERSHIP_DIMENSIONS.some((dimension) => dimension === value))
    return undefined;
  const selection = dimensionPageSelection(value);
  if (!selection) return undefined;
  return {
    readerProfile: "dimension-page-v1" as const,
    outputId: "dimension-page" as const,
    dimension: value as PageMembershipDimension,
    selection,
    sourceRole: "page" as const,
    maxPlans: 1 as const,
    maxSources: 1 as const,
  };
}
