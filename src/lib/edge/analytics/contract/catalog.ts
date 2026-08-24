/** Shared analytics protocol catalog. This module is safe for Node-side generators. */
export const TIME_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
] as const;

export type TimePreset = (typeof TIME_PRESETS)[number];

export const INTERVALS = ["minute", "hour", "day", "week", "month"] as const;
export type ApiInterval = (typeof INTERVALS)[number];

export const ANALYTICS_METRICS = [
  "views",
  "sessions",
  "visitors",
  "bounces",
  "bounceRate",
  "avgDurationMs",
  "viewsPerSession",
  "events",
] as const;

export const ANALYTICS_DIMENSIONS = [
  "page.path",
  "page.title",
  "page.hostname",
  "page.query",
  "page.hash",
  "session.entryPath",
  "session.exitPath",
  "referrer.domain",
  "referrer.url",
  "utm.source",
  "utm.medium",
  "utm.campaign",
  "utm.term",
  "utm.content",
  "client.browser",
  "client.browserVersion",
  "client.browserEngine",
  "client.os",
  "client.osVersion",
  "client.deviceType",
  "client.language",
  "client.screenSize",
  "geo.country",
  "geo.region",
  "geo.city",
  "geo.continent",
  "geo.timeZone",
  "geo.organization",
  "event.name",
] as const;

export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];
export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number];
