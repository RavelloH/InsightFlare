import type { SemanticPageDimensionId } from "./page-dimensions";

export const EVENT_CONTEXT_CARD_KEYS = [
  "path",
  "query",
  "title",
  "hostname",
  "entry",
  "exit",
  "sourceDomain",
  "sourceLink",
  "browser",
  "osVersion",
  "deviceType",
  "language",
  "screenSize",
  "country",
  "region",
  "city",
  "continent",
  "timezone",
  "organization",
] as const;

export type EventContextCardKey = (typeof EVENT_CONTEXT_CARD_KEYS)[number];

export type EventContextOwnerAttribute =
  | "ownerPathname"
  | "ownerQueryString"
  | "ownerTitle"
  | "ownerHostname"
  | "ownerReferrerHost"
  | "ownerReferrerUrl"
  | "ownerBrowser"
  | "ownerOs"
  | "ownerOsVersion"
  | "ownerDeviceType"
  | "ownerLanguage"
  | "ownerScreenWidth"
  | "ownerScreenHeight"
  | "ownerCountry"
  | "ownerRegionCode"
  | "ownerRegion"
  | "ownerCity"
  | "ownerContinent"
  | "ownerTimezone"
  | "ownerOrganization";

export type EventContextCardDefinition =
  | {
      readonly kind: "owner-raw";
      readonly attribute: EventContextOwnerAttribute;
      readonly includeEmpty: boolean;
      readonly geo: boolean;
    }
  | {
      readonly kind: "owner-trimmed";
      readonly attribute: EventContextOwnerAttribute;
      readonly includeEmpty: false;
      readonly geo: false;
    }
  | {
      readonly kind: "page-dimension";
      readonly dimension: SemanticPageDimensionId;
      readonly includeEmpty: false;
      readonly geo: boolean;
    }
  | {
      readonly kind: "session-boundary";
      readonly direction: "first" | "last";
      readonly includeEmpty: false;
      readonly geo: false;
    };

/** Finite Event-owner card contract; this is not a filter or SQL registry. */
export const EVENT_CONTEXT_CARDS = {
  path: {
    kind: "owner-raw",
    attribute: "ownerPathname",
    includeEmpty: false,
    geo: false,
  },
  query: {
    kind: "owner-raw",
    attribute: "ownerQueryString",
    includeEmpty: false,
    geo: false,
  },
  title: {
    kind: "owner-raw",
    attribute: "ownerTitle",
    includeEmpty: false,
    geo: false,
  },
  hostname: {
    kind: "owner-raw",
    attribute: "ownerHostname",
    includeEmpty: false,
    geo: false,
  },
  entry: {
    kind: "session-boundary",
    direction: "first",
    includeEmpty: false,
    geo: false,
  },
  exit: {
    kind: "session-boundary",
    direction: "last",
    includeEmpty: false,
    geo: false,
  },
  sourceDomain: {
    kind: "owner-raw",
    attribute: "ownerReferrerHost",
    includeEmpty: true,
    geo: false,
  },
  sourceLink: {
    kind: "owner-raw",
    attribute: "ownerReferrerUrl",
    includeEmpty: true,
    geo: false,
  },
  browser: {
    kind: "owner-trimmed",
    attribute: "ownerBrowser",
    includeEmpty: false,
    geo: false,
  },
  osVersion: {
    kind: "page-dimension",
    dimension: "osVersion",
    includeEmpty: false,
    geo: false,
  },
  deviceType: {
    kind: "owner-trimmed",
    attribute: "ownerDeviceType",
    includeEmpty: false,
    geo: false,
  },
  language: {
    kind: "owner-trimmed",
    attribute: "ownerLanguage",
    includeEmpty: false,
    geo: false,
  },
  screenSize: {
    kind: "page-dimension",
    dimension: "screenSize",
    includeEmpty: false,
    geo: false,
  },
  country: {
    kind: "owner-raw",
    attribute: "ownerCountry",
    includeEmpty: false,
    geo: true,
  },
  region: {
    kind: "page-dimension",
    dimension: "geoRegion",
    includeEmpty: false,
    geo: true,
  },
  city: {
    kind: "page-dimension",
    dimension: "geoCity",
    includeEmpty: false,
    geo: true,
  },
  continent: {
    kind: "owner-raw",
    attribute: "ownerContinent",
    includeEmpty: false,
    geo: true,
  },
  timezone: {
    kind: "owner-raw",
    attribute: "ownerTimezone",
    includeEmpty: false,
    geo: true,
  },
  organization: {
    kind: "owner-raw",
    attribute: "ownerOrganization",
    includeEmpty: false,
    geo: true,
  },
} as const satisfies Readonly<
  Record<EventContextCardKey, EventContextCardDefinition>
>;

export const EVENT_CONTEXT_OWNER_DIMENSION_ATTRIBUTES = {
  "page.report.os": "ownerOs",
  "page.report.osVersion": "ownerOsVersion",
  "page.report.screenWidth": "ownerScreenWidth",
  "page.report.screenHeight": "ownerScreenHeight",
  "page.report.country": "ownerCountry",
  "page.report.regionCode": "ownerRegionCode",
  "page.report.region": "ownerRegion",
  "page.report.city": "ownerCity",
} as const satisfies Readonly<
  Record<
    | "page.report.os"
    | "page.report.osVersion"
    | "page.report.screenWidth"
    | "page.report.screenHeight"
    | "page.report.country"
    | "page.report.regionCode"
    | "page.report.region"
    | "page.report.city",
    EventContextOwnerAttribute
  >
>;
