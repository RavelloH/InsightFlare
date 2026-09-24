export const CROSS_BREAKDOWN_DIMENSIONS = [
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
] as const;

export type CrossBreakdownDimension =
  (typeof CROSS_BREAKDOWN_DIMENSIONS)[number];

export function isCrossBreakdownDimension(
  value: string,
): value is CrossBreakdownDimension {
  return CROSS_BREAKDOWN_DIMENSIONS.includes(value as CrossBreakdownDimension);
}
