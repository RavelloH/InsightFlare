/**
 * Human-written documentation for the public API v1 operations.
 *
 * The route registry owns the wire contract (paths, schemas, scopes); this file
 * owns the prose that the OpenAPI generator publishes next to it: operation
 * summaries and descriptions, tag descriptions, descriptions for common request
 * fields and path parameters, and realistic request examples.
 *
 * Entries are keyed by operationId. Every exposed operation must have one, and every request example must
 * parse with the route's request schema (see api-v1-docs.test.ts).
 */
import { ANALYTICS_DIMENSIONS } from "@/lib/edge/analytics/contract/catalog";

export type ApiV1PathParameterDoc = {
  description: string;
  enum?: readonly string[];
};

export type ApiV1OperationDoc = {
  /** Short imperative title, e.g. "Get site analytics overview". */
  summary: string;
  /** What the operation returns or changes, and how to use it. */
  description: string;
  /** Descriptions for request fields that differ from the shared defaults. */
  fields?: Record<string, string>;
  /** Overrides for path parameters (description or allowed values). */
  pathParameters?: Record<string, Partial<ApiV1PathParameterDoc>>;
  /** A realistic request body. Path parameters are not included. */
  requestExample?: Record<string, unknown>;
  /**
   * A hand-written successful response body (`{ data, meta }`) with
   * self-consistent numbers. Used instead of the generated example.
   */
  responseExample?: Record<string, unknown>;
};

/** Tag order and descriptions, as published in the OpenAPI `tags` list. */
export const apiV1TagDocs = [
  {
    name: "Discovery",
    description:
      "Find out what this instance supports: the API root, runtime capabilities, the OpenAPI document, and the Agent skills manifest.",
  },
  {
    name: "Token",
    description:
      "Inspect the API key used for the request and check which scopes and sites it can access.",
  },
  {
    name: "Team",
    description: "Read the team that owns the API key and its usage.",
  },
  {
    name: "Sites",
    description: "List, create, update, and delete the sites of the team.",
  },
  {
    name: "Settings",
    description:
      "Read and update a site's tracking, privacy, and sharing settings, and get its tracking script.",
  },
  {
    name: "Analytics",
    description:
      "Aggregate queries for a site or across the team: overview metrics, time series, breakdowns, comparisons, pages, referrers, channels, retention, and filter discovery.",
  },
  {
    name: "Events",
    description:
      "Custom events: summaries, time series, search, event types, and the fields and values in event payloads.",
  },
  {
    name: "Visitors",
    description:
      "Search visitors and read one visitor's profile, sessions, and events.",
  },
  {
    name: "Sessions",
    description:
      "Search sessions and read one session's details and the events in its journey.",
  },
  {
    name: "Funnels",
    description: "Manage saved funnels and analyze their conversion.",
  },
  {
    name: "Goals",
    description: "Manage goals and read their conversion summary and trend.",
  },
  {
    name: "Saved Filters",
    description: "Read the filters that team members saved in the dashboard.",
  },
  {
    name: "Performance",
    description:
      "Core Web Vitals (TTFB, FCP, LCP, CLS, INP) as a summary, a time series, or a breakdown by page or country.",
  },
  {
    name: "Realtime",
    description:
      "Activity from the last few minutes: active visitors, recent events, and live sessions.",
  },
  {
    name: "Batch",
    description: "Run several read operations in one request.",
  },
  {
    name: "Health",
    description: "Check that the instance is up.",
  },
  {
    name: "Ingestion",
    description:
      "The public endpoints used by the tracking script. They are not meant for API clients.",
  },
] as const;

/** Descriptions shared by every operation that has a field with this name. */
export const apiV1CommonFieldDocs: Record<string, string> = {
  timeRange:
    'Reporting window. Use `{ "kind": "preset", "preset": "last_7_days" }` or an absolute range `{ "kind": "absolute", "from": "…", "to": "…" }` with RFC 3339 timestamps. `timeZone` (IANA name) sets calendar boundaries for presets and buckets.',
  filter:
    'Optional filter: `{ "type": "dsl", "expression": "page.path startsWith \\"/blog\\"" }` uses the filter language, `{ "type": "inline", "expression": … }` passes a structured expression, and `{ "type": "saved", "id": "…" }` references a saved filter (requires `analysis:read`). Team queries accept `dsl` and `inline` only. Use null or omit the field for no filter.',
  scope:
    "Which entity a filter condition selects. `auto` (default) picks the narrowest scope that fits the expression; `event`, `session`, and `visitor` force one.",
  metrics:
    "Metrics to return. Omit to return the default set (views, sessions, visitors, bounces, bounce rate, average duration, views per session).",
  interval:
    "Bucket size of the time series: `minute`, `hour`, `day`, `week`, or `month`. Keep the number of buckets reasonable for the time range.",
  granularity:
    "Cohort size: visitors are grouped by the `minute`, `hour`, `day`, `week`, or `month` of their first visit.",
  limit: "Maximum number of rows to return.",
  page: "Cursor pagination. Pass `limit`, then send `cursor` from the previous response's `pagination.nextCursor` to fetch the next page.",
  search: "Case-insensitive text search.",
  sort: "Sort field and direction.",
  direction: "Sort direction: `asc` or `desc`.",
  version: "Comparison contract version. Always `2`.",
  timeZone:
    "IANA time zone used for both datasets, so presets and trend buckets use the same calendar boundaries.",
  current:
    "The dataset being measured: a time range (absolute or preset) and an optional filter.",
  reference:
    'The dataset to compare against. Besides absolute and preset ranges, `{ "kind": "previous_period" }` uses the period of equal length right before `current`.',
  select:
    "Which metrics to compare, and optionally a trend with an interval and its own metric list.",
  eventName: "Custom event name, as sent by the tracking script.",
  visitorId: "Visitor ID from a visitors, sessions, or events response.",
  sessionId: "Session ID from a sessions, visitors, or events response.",
  eventId: "Event ID from an events or journey response.",
  funnelId: "ID of a saved funnel (see List funnels).",
  goalId: "ID of a goal (see List goals).",
};

/** Descriptions for path parameters. */
export const apiV1PathParameterDocs: Record<string, ApiV1PathParameterDoc> = {
  siteId: { description: "ID of the site (see List sites)." },
  funnelId: { description: "ID of the funnel." },
  goalId: { description: "ID of the goal." },
  savedFilterId: { description: "ID of the saved filter." },
  dimension: {
    description:
      "Dimension to group by. The analytics schema operation lists the dimensions available on this instance.",
    enum: ANALYTICS_DIMENSIONS,
  },
};

/**
 * Request-schema fields that are filled from a differently named path
 * parameter by the dispatcher. They must not be published as query parameters.
 */
export const apiV1PathParameterAliases: Record<
  string,
  Record<string, string>
> = {
  "savedFilters.get": { id: "savedFilterId" },
};

/* ---------- Shared example fragments ---------- */

const last7Days = { kind: "preset", preset: "last_7_days", timeZone: "UTC" };
const november = {
  kind: "absolute",
  from: "2026-11-01T00:00:00Z",
  to: "2026-11-08T00:00:00Z",
  timeZone: "UTC",
};
const lastThirtyMinutes = {
  kind: "absolute",
  from: "2026-11-22T09:30:00Z",
  to: "2026-11-22T10:00:00Z",
};
const blogFilter = { type: "dsl", expression: 'page.path startsWith "/blog"' };

/* ---------- Operations ---------- */

export const apiV1OperationDocs: Record<string, ApiV1OperationDoc> = {
  /* Discovery, token, team */
  "core.root": {
    summary: "Get API root",
    description:
      "Returns the API version and links to the discovery documents. Use it as the entry point when exploring an instance.",
  },
  "core.capabilities": {
    summary: "Get runtime capabilities",
    description:
      "Returns the API version, the optional features enabled on this instance, and request limits. Check it before relying on an optional feature.",
  },
  "core.token.get": {
    summary: "Inspect current token",
    description:
      "Returns the API key used for this request: its team, scopes, and site restrictions.",
  },
  "core.token.check": {
    summary: "Check token permissions",
    description:
      "Checks whether the API key may use each scope, optionally for a specific site, and explains every denial. Use it to fail early before running a set of queries.",
    fields: {
      checks:
        "Scopes to check. Add `siteId` to also check the key's site restriction.",
    },
    requestExample: {
      checks: [
        { scope: "analytics:read", siteId: "site_123" },
        { scope: "site_config:write", siteId: "site_123" },
      ],
    },
  },
  "core.team.get": {
    summary: "Get current team",
    description: "Returns the team that owns the API key.",
  },
  "core.team.usage": {
    summary: "Get team usage",
    description: "Returns the team's usage, such as the number of sites.",
  },

  /* Sites */
  "sites.list": {
    summary: "List sites",
    description:
      "Lists the team's sites that the API key can access, in pages of up to 200.",
  },
  "sites.create": {
    summary: "Create site",
    description:
      "Creates a site in the team and returns it. Install the tracking script from Get tracking script to start collecting data.",
    fields: {
      name: "Display name of the site.",
      domain: "Domain of the website, without protocol, e.g. `example.com`.",
      publicEnabled: "Whether the public shared dashboard is enabled.",
      publicSlug:
        "Slug of the public dashboard URL. Omit it to have one generated.",
    },
    requestExample: {
      name: "Example Docs",
      domain: "docs.example.com",
      publicEnabled: false,
    },
  },
  "sites.get": {
    summary: "Get site",
    description: "Returns one site.",
  },
  "sites.update": {
    summary: "Update site",
    description:
      "Updates a site's name, domain, or public sharing. Send only the fields to change; at least one is required.",
    requestExample: { name: "Example Documentation" },
  },
  "sites.delete": {
    summary: "Delete site",
    description:
      "Deletes the site and all of its analytics data. This cannot be undone.",
  },

  /* Settings */
  "settings.tracking.get": {
    summary: "Get tracking settings",
    description:
      "Returns what the tracking script records for the site: query strings, hashes, Web Vitals, outbound links, tracking strength, allowed domains, and excluded paths.",
  },
  "settings.tracking.update": {
    summary: "Update tracking settings",
    description:
      "Updates the tracking settings. Send only the fields to change. The tracking script picks up the change on its next load.",
    fields: {
      trackingStrength:
        "How visitors are identified: `strong`, `smart` (default), or `weak`. See the tracking settings guide.",
      allowedDomains:
        "Hostnames allowed to send data. Empty allows the site's own domain.",
      excludedPaths: "Path patterns that are never recorded.",
    },
    requestExample: {
      trackQuery: true,
      trackWebVitals: true,
      excludedPaths: ["/admin/*"],
    },
  },
  "settings.privacy.get": {
    summary: "Get privacy settings",
    description:
      "Returns the site's privacy settings, including Do Not Track handling and EU mode. IP anonymization, daily visitor tokens, and the retention period are fixed and returned for reference.",
  },
  "settings.privacy.update": {
    summary: "Update privacy settings",
    description:
      "Updates whether Do Not Track is respected and whether EU mode is on. Send only the fields to change.",
    requestExample: { respectDoNotTrack: true },
  },
  "settings.sharing.get": {
    summary: "Get sharing settings",
    description:
      "Returns whether the site's public dashboard is enabled and its slug.",
  },
  "settings.sharing.update": {
    summary: "Update sharing settings",
    description:
      "Enables or disables the public dashboard, or changes its slug. Send only the fields to change.",
    requestExample: { publicEnabled: true, publicSlug: "example-docs" },
  },
  "settings.trackingScript.get": {
    summary: "Get tracking script",
    description:
      "Returns the tracking script URL and an HTML snippet to paste into the site's pages.",
  },

  /* Site analytics */
  "site.analytics.schema": {
    summary: "Get site analytics schema",
    description:
      "Lists the fields, operators, dimensions, and metrics available for this site's queries. Call it first to discover valid filter fields and breakdown dimensions.",
  },
  "site.analytics.overview": {
    summary: "Get site analytics overview",
    description:
      "Returns aggregate metrics for the time range, such as views, sessions, visitors, bounce rate, and average duration.",
    requestExample: {
      timeRange: last7Days,
      filter: blogFilter,
      metrics: ["views", "visitors", "bounceRate"],
    },
  },
  "site.analytics.timeseries": {
    summary: "Get site analytics time series",
    description:
      "Returns views, sessions, and visitors for each time bucket in the range.",
    requestExample: { timeRange: last7Days, interval: "day" },
  },
  "site.analytics.breakdown": {
    summary: "Get site analytics breakdown",
    description:
      "Groups traffic by one dimension (the path parameter), such as pages, countries, or browsers, and returns the top rows with their metrics.",
    fields: { limit: "Maximum number of rows, 1–200." },
    requestExample: { timeRange: last7Days, limit: 10 },
  },
  "site.analytics.crossBreakdown": {
    summary: "Get site analytics cross breakdown",
    description:
      "Groups traffic by two dimensions: the top values of the primary dimension, each split by the top values of the secondary dimension.",
    fields: {
      primaryDimension: "First dimension, e.g. `geo.country`.",
      secondaryDimension: "Dimension used to split each primary row.",
      primaryLimit: "Number of primary rows, 1–12.",
      secondaryLimit: "Number of secondary rows per primary row, 1–8.",
    },
    requestExample: {
      timeRange: last7Days,
      primaryDimension: "geo.country",
      secondaryDimension: "client.deviceType",
      primaryLimit: 5,
      secondaryLimit: 3,
    },
  },
  "site.analytics.pages": {
    summary: "List site pages",
    description:
      "Lists the site's pages with their views and sessions, sorted by views.",
    fields: {
      includeDetails:
        "Split rows by query string and hash instead of grouping them by path.",
    },
    requestExample: {
      timeRange: last7Days,
      page: { limit: 20 },
      includeDetails: true,
    },
  },
  "site.analytics.referrers": {
    summary: "List site referrers",
    description:
      "Lists the referring domains (or full URLs) that send traffic.",
    fields: {
      sort: "Sort by `views` or `visitors`.",
      includeFullUrl: "Group by full referrer URL instead of domain.",
      search: "Only referrers containing this text.",
    },
    requestExample: {
      timeRange: last7Days,
      sort: "visitors",
      direction: "desc",
      page: { limit: 20 },
    },
  },
  "site.analytics.channels": {
    summary: "List site channels",
    description:
      "Groups traffic into acquisition channels such as direct, organic search, social, and referral.",
    requestExample: { timeRange: last7Days, limit: 10 },
  },
  "site.analytics.filterValues": {
    summary: "Search filter values",
    description:
      "Returns the values seen for a filter field in the time range, with counts. Use it to build a filter or to suggest values.",
    fields: {
      field:
        "A filter field from the analytics schema, e.g. `geo.country`. Event payload fields are not enumerable here; use Search event field values instead.",
    },
    requestExample: {
      timeRange: last7Days,
      field: "referrer.domain",
      search: "goo",
      page: { limit: 20 },
    },
  },
  "site.analytics.retentionCohorts": {
    summary: "Get retention cohorts",
    description:
      "Groups visitors by the period of their first visit and returns the share that came back in each later period.",
    requestExample: { timeRange: november, granularity: "day" },
  },
  "site.analytics.comparison": {
    summary: "Compare site datasets",
    description:
      "Compares metrics between two datasets, each with its own time range and filter, and returns current values, reference values, and their absolute and relative change. Optionally returns a trend for both.",
    requestExample: {
      version: 2,
      timeZone: "UTC",
      current: { timeRange: { kind: "preset", preset: "last_7_days" } },
      reference: { timeRange: { kind: "previous_period" } },
      select: {
        metrics: ["views", "visitors", "bounceRate"],
        trend: { interval: "day", metrics: ["views"] },
      },
    },
  },
  "site.analytics.comparisonBreakdown": {
    summary: "Compare site datasets by dimension",
    description:
      "Compares two datasets row by row for one dimension (the path parameter), e.g. which pages gained or lost the most visitors.",
    fields: {
      limit: "Maximum number of rows, 1–200.",
      sort: "Sort by a current, reference, or change metric, or by `key`.",
    },
    requestExample: {
      version: 2,
      timeZone: "UTC",
      current: { timeRange: { kind: "preset", preset: "this_month" } },
      reference: { timeRange: { kind: "preset", preset: "last_month" } },
      limit: 10,
      sort: { by: "change.visitors.absolute", direction: "desc" },
    },
  },

  /* Team analytics */
  "team.analytics.schema": {
    summary: "Get team analytics schema",
    description:
      "Lists the fields, operators, dimensions, and metrics available for team-wide queries.",
  },
  "team.analytics.overview": {
    summary: "Get team analytics overview",
    description:
      "Returns aggregate metrics across all sites the API key can access.",
    requestExample: { timeRange: last7Days, metrics: ["views", "visitors"] },
  },
  "team.analytics.timeseries": {
    summary: "Get team analytics time series",
    description:
      "Returns views, sessions, and visitors per time bucket across all accessible sites.",
    requestExample: { timeRange: last7Days, interval: "day" },
  },
  "team.analytics.sites": {
    summary: "List team analytics by site",
    description:
      "Returns metrics for each accessible site, optionally with a small trend per site. Use it to build a sites overview.",
    fields: { interval: "Add a trend per site with this bucket size." },
    requestExample: {
      timeRange: last7Days,
      interval: "day",
      page: { limit: 20 },
    },
  },
  "team.analytics.breakdown": {
    summary: "Get team analytics breakdown",
    description:
      "Groups traffic across all accessible sites by one dimension (the path parameter).",
    requestExample: { timeRange: last7Days, limit: 10 },
  },
  "team.analytics.comparison": {
    summary: "Compare team datasets",
    description:
      "Compares metrics between two team-wide datasets, each with its own time range and filter.",
    requestExample: {
      version: 2,
      timeZone: "UTC",
      current: { timeRange: { kind: "preset", preset: "last_30_days" } },
      reference: { timeRange: { kind: "previous_period" } },
      select: { metrics: ["views", "visitors"] },
    },
  },
  "team.analytics.comparisonBreakdown": {
    summary: "Compare team datasets by dimension",
    description:
      "Compares two team-wide datasets row by row for one dimension (the path parameter).",
    requestExample: {
      version: 2,
      timeZone: "UTC",
      current: { timeRange: { kind: "preset", preset: "this_week" } },
      reference: { timeRange: { kind: "preset", preset: "last_week" } },
      limit: 10,
      sort: { by: "change.views.relative", direction: "desc" },
    },
  },

  /* Events */
  "site.analytics.eventsSummary": {
    summary: "Get events summary",
    description:
      "Returns totals for custom events in the range (events, event types, sessions, visitors, and events per session) and the top event and page.",
    requestExample: { timeRange: last7Days },
  },
  "site.analytics.eventsTimeseries": {
    summary: "Get events time series",
    description:
      "Returns event counts at time points. series contains top-N event-type aggregates for the whole window; points contains the time buckets. The request limit controls top-N event types, not the number of points.",
    fields: { limit: "Number of top event types in `series`, 1–12." },
    requestExample: { timeRange: last7Days, interval: "day", limit: 5 },
  },
  "site.analytics.eventsSearch": {
    summary: "Search events",
    description:
      "Searches event records. Use page.limit for page size; it supports values from 1 through 200 and is independent of the events timeseries top-N limit.",
    fields: {
      eventName: "Only events with this name.",
    },
    requestExample: {
      timeRange: last7Days,
      eventName: "signup",
      sort: { field: "occurredAt", direction: "desc" },
      page: { limit: 50 },
    },
  },
  "site.analytics.eventDetail": {
    summary: "Get event",
    description:
      "Returns one event with its payload, page, session, and visitor context.",
    requestExample: { timeRange: last7Days, eventId: "evt_123" },
  },
  "site.analytics.eventTypes": {
    summary: "List event types",
    description:
      "Lists the custom event names seen in the range with their counts.",
    requestExample: { timeRange: last7Days, page: { limit: 20 } },
  },
  "site.analytics.eventTypeDetail": {
    summary: "Get event type",
    description:
      "Returns totals, a trend, and breakdowns by page, country, device, and browser for one event name.",
    fields: { interval: "Bucket size of the trend. Defaults to `day`." },
    requestExample: { timeRange: last7Days, eventName: "signup" },
  },
  "site.analytics.eventFields": {
    summary: "List event fields",
    description:
      "Lists the payload fields of one event name, with their value types and how often they appear.",
    requestExample: { timeRange: last7Days, eventName: "signup" },
  },
  "site.analytics.eventFieldValues": {
    summary: "Search event field values",
    description:
      "Returns the values of one payload field of an event name, with counts.",
    fields: {
      fieldPath: "JSON Pointer to the field, e.g. `/plan`.",
      fieldValueType: "Value type to list, as returned by List event fields.",
    },
    requestExample: {
      timeRange: last7Days,
      eventName: "signup",
      fieldPath: "/plan",
      fieldValueType: "string",
      page: { limit: 25 },
    },
  },

  /* Visitors */
  "site.analytics.visitorsSearch": {
    summary: "Search visitors",
    description:
      "Lists visitors in the range with their first and last visit, sessions, and views.",
    requestExample: {
      timeRange: last7Days,
      sort: { field: "lastSeenAt", direction: "desc" },
      page: { limit: 50 },
    },
  },
  "site.analytics.visitorDetail": {
    summary: "Get visitor",
    description:
      "Returns one visitor's profile: identity (if identified), first and last visit, location, device, and totals.",
    requestExample: { timeRange: last7Days, visitorId: "vis_123" },
  },
  "site.analytics.visitorSessions": {
    summary: "List visitor sessions",
    description: "Lists one visitor's sessions in the range, newest first.",
    requestExample: {
      timeRange: last7Days,
      visitorId: "vis_123",
      page: { limit: 20 },
    },
  },
  "site.analytics.visitorEvents": {
    summary: "List visitor events",
    description:
      "Lists one visitor's page views and custom events in the range, newest first.",
    requestExample: {
      timeRange: last7Days,
      visitorId: "vis_123",
      page: { limit: 100 },
    },
  },

  /* Sessions */
  "site.analytics.sessionsSearch": {
    summary: "Search sessions",
    description:
      "Lists sessions in the range with their entry page, duration, and views.",
    requestExample: {
      timeRange: last7Days,
      sort: { field: "durationMs", direction: "desc" },
      page: { limit: 50 },
    },
  },
  "site.analytics.sessionDetail": {
    summary: "Get session",
    description:
      "Returns one session: its visitor, entry and exit pages, source, device, and duration.",
    requestExample: { timeRange: last7Days, sessionId: "ses_123" },
  },
  "site.analytics.sessionEvents": {
    summary: "List session events",
    description:
      "Lists the page views and custom events of one session in order.",
    requestExample: {
      timeRange: last7Days,
      sessionId: "ses_123",
      page: { limit: 100 },
    },
  },
  "site.analytics.journeyEventDetail": {
    summary: "Get journey event",
    description:
      "Returns one item of a session journey, such as a page view, the session start, or the leave event, with its context.",
    fields: {
      eventKind:
        "Kind of journey item, when the ID alone is ambiguous: `pageview`, `session_start`, or `leave`.",
    },
    requestExample: {
      timeRange: last7Days,
      eventId: "evt_123",
      eventKind: "pageview",
    },
  },

  /* Funnels */
  "funnels.list": {
    summary: "List funnels",
    description: "Lists the site's saved funnels.",
  },
  "funnels.create": {
    summary: "Create funnel",
    description:
      "Creates a funnel. Each step is a filter expression; a visitor or session converts by matching the steps in order within the conversion window.",
    fields: {
      name: "Display name.",
      filterDslVersion: "Filter language version. Always `1`.",
      progressionScope:
        "Whether steps must happen within one `session` or may span a `visitor`'s sessions.",
      conversionWindowMs:
        "For visitor funnels, the maximum time from the first to the last step, in milliseconds, or null for no limit. Session funnels must use null: the session already bounds them.",
      steps: "Ordered steps. Each has an ID, an optional name, and a filter.",
    },
    requestExample: {
      name: "Signup",
      filterDslVersion: 1,
      progressionScope: "visitor",
      conversionWindowMs: 604_800_000,
      steps: [
        {
          id: "pricing",
          name: "Pricing",
          filterDsl: 'page.path eq "/pricing"',
        },
        {
          id: "signup",
          name: "Sign up",
          filterDsl: 'event.name eq "signup"',
        },
      ],
    },
  },
  "funnels.get": {
    summary: "Get funnel",
    description: "Returns one funnel with its steps.",
  },
  "funnels.update": {
    summary: "Update funnel",
    description:
      "Updates a funnel. Send only the fields to change; `steps` replaces the whole list.",
    requestExample: { name: "Signup flow" },
  },
  "funnels.delete": {
    summary: "Delete funnel",
    description: "Deletes a funnel. Collected data is not affected.",
  },
  "site.analytics.funnelAnalysis": {
    summary: "Analyze funnel",
    description:
      "Returns the number of sessions or visitors that reached each step of a saved funnel, and the conversion and drop-off between steps.",
    requestExample: { timeRange: last7Days, funnelId: "fnl_123" },
  },

  /* Goals */
  "goals.list": {
    summary: "List goals",
    description: "Lists the site's goals.",
  },
  "goals.create": {
    summary: "Create goal",
    description:
      "Creates a goal. A goal converts when an event, page view, session, or visitor matches its filter.",
    fields: {
      name: "Display name.",
      filterDsl: "Filter expression that defines a conversion.",
      filterDslVersion: "Filter language version. Always `1`.",
    },
    requestExample: {
      name: "Newsletter signup",
      filterDslVersion: 1,
      filterDsl: 'event.name eq "newsletter_signup"',
    },
  },
  "goals.get": {
    summary: "Get goal",
    description: "Returns one goal.",
  },
  "goals.update": {
    summary: "Update goal",
    description: "Updates a goal. Send only the fields to change.",
    requestExample: { name: "Newsletter subscription" },
  },
  "goals.delete": {
    summary: "Delete goal",
    description: "Deletes a goal. Collected data is not affected.",
  },
  "site.analytics.goalSummary": {
    summary: "Get goal summary",
    description:
      "Returns a goal's conversions and conversion rate by sessions and by visitors.",
    requestExample: { timeRange: last7Days, goalId: "gol_123" },
  },
  "site.analytics.goalTimeseries": {
    summary: "Get goal time series",
    description: "Returns a goal's conversions for each time bucket.",
    requestExample: {
      timeRange: last7Days,
      goalId: "gol_123",
      interval: "day",
    },
  },

  /* Saved filters */
  "savedFilters.list": {
    summary: "List saved filters",
    description:
      "Lists the filters shared with the team for this site. Pass a saved filter's ID as `filter` in analytics queries.",
  },
  "savedFilters.get": {
    summary: "Get saved filter",
    description: "Returns one saved filter with its expression.",
  },

  /* Performance */
  "site.analytics.performanceSummary": {
    summary: "Get performance summary",
    description:
      "Returns Core Web Vitals for the range: average and percentile values of TTFB, FCP, LCP, CLS, and INP, with sample counts.",
    requestExample: { timeRange: last7Days },
  },
  "site.analytics.performanceTimeseries": {
    summary: "Get performance time series",
    description: "Returns Core Web Vitals for each time bucket.",
    requestExample: { timeRange: last7Days, interval: "day" },
  },
  "site.analytics.performanceBreakdown": {
    summary: "Get performance breakdown",
    description:
      "Breaks down Core Web Vitals by page.path or geo.country. Other dimensions are not supported and return validation_failed.",
    fields: {
      metric: "Metric used to rank rows. Defaults to `lcp`.",
      limit: "Maximum number of rows, 1–200.",
    },
    pathParameters: {
      dimension: {
        description: "Dimension to group by: `page.path` or `geo.country`.",
      },
    },
    requestExample: { timeRange: last7Days, metric: "lcp", limit: 20 },
  },

  /* Realtime */
  "site.analytics.realtimeSnapshot": {
    summary: "Get realtime snapshot",
    description:
      "Returns the active visitor count, recent events, and live visits in one response. Use a short time range ending now, such as the last 30 minutes.",
    fields: { limit: "Maximum number of events and sessions, 1–500." },
    requestExample: { timeRange: lastThirtyMinutes, limit: 50 },
  },
  "site.analytics.realtimeActiveVisitors": {
    summary: "Get active visitors",
    description: "Returns the number of visitors active in the time range.",
    requestExample: { timeRange: lastThirtyMinutes },
  },
  "site.analytics.realtimeEvents": {
    summary: "List realtime events",
    description: "Lists the most recent page views and events, newest first.",
    requestExample: { timeRange: lastThirtyMinutes, limit: 50 },
  },
  "site.analytics.realtimeSessions": {
    summary: "List live sessions",
    description: "Lists sessions that were active in the time range.",
    requestExample: { timeRange: lastThirtyMinutes, limit: 50 },
  },

  /* Batch */
  batch: {
    summary: "Run batch",
    description:
      "Runs up to 50 read operations in one request and returns each result under its `id`. Only operations marked as batch-eligible can be included. Each item needs the same scopes as calling it directly.",
    fields: {
      requests:
        "Operations to run. Each has a unique `id`, a `method`, an `/api/v1/…` `path`, and an optional JSON `body`.",
      deadlineMs: "Time budget for the whole batch, up to 30,000 ms.",
    },
    requestExample: {
      requests: [
        {
          id: "overview",
          method: "POST",
          path: "/api/v1/sites/site_123/analytics/overview",
          body: { timeRange: last7Days },
        },
        {
          id: "countries",
          method: "POST",
          path: "/api/v1/sites/site_123/analytics/breakdowns/geo.country",
          body: { timeRange: last7Days, limit: 5 },
        },
      ],
      deadlineMs: 10_000,
    },
  },
};
