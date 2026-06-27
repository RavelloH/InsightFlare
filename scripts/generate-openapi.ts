#!/usr/bin/env tsx

import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { resolve } from "path";
import YAML from "yaml";

type HttpMethod = "get" | "post" | "patch" | "delete";

interface Operation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  security?: Array<Record<string, unknown>>;
  parameters?: unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
}

interface OpenAPISpec {
  openapi: string;
  info: Record<string, unknown>;
  servers: Array<{ url: string; description: string }>;
  security: Array<Record<string, unknown>>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<
    string,
    Partial<Record<HttpMethod, Operation>> & { parameters?: unknown[] }
  >;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
    parameters: Record<string, unknown>;
    responses: Record<string, unknown>;
  };
}

const json = "application/json";

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function response(description: string, schema: string, example?: unknown) {
  return {
    description,
    content: {
      [json]: {
        schema: ref(schema),
        ...(example ? { example } : {}),
      },
    },
  };
}

function requestBody(schema: string, description?: string) {
  return {
    required: true,
    ...(description ? { description } : {}),
    content: { [json]: { schema: ref(schema) } },
  };
}

function envelope(dataSchema: unknown, description = "Response envelope.") {
  return {
    description,
    allOf: [
      ref("SuccessEnvelope"),
      {
        type: "object",
        description,
        properties: {
          data: dataSchema,
        },
      },
    ],
  };
}

function listEnvelope(
  itemSchema: unknown,
  description = "Response envelope for list results.",
) {
  return {
    description,
    allOf: [
      ref("ListEnvelope"),
      {
        type: "object",
        description,
        properties: {
          data: {
            type: "array",
            items: itemSchema,
          },
        },
      },
    ],
  };
}

function paginatedEnvelope(
  itemSchema: unknown,
  description = "Response envelope for paginated list results.",
) {
  return {
    description,
    allOf: [
      ref("PaginatedEnvelope"),
      {
        type: "object",
        description,
        properties: {
          data: {
            type: "array",
            items: itemSchema,
          },
        },
      },
    ],
  };
}

function ok(schema: string, description = "Successful response") {
  return response(description, schema);
}

function schemaRefName(schema: unknown): string | null {
  if (!schema || typeof schema !== "object" || !("$ref" in schema)) {
    return null;
  }
  return (
    String((schema as { $ref: string }).$ref)
      .split("/")
      .at(-1) ?? null
  );
}

function jsonContent(container: unknown) {
  if (!container || typeof container !== "object") return null;
  return (container as { content?: Record<string, unknown> }).content?.[
    json
  ] as
    | {
        schema?: unknown;
        example?: unknown;
        examples?: Record<string, unknown>;
      }
    | undefined;
}

function errorResponses(...codes: string[]) {
  const map: Record<string, unknown> = {};
  for (const code of codes) {
    const name =
      code === "400"
        ? "BadRequest"
        : code === "401"
          ? "Unauthorized"
          : code === "403"
            ? "Forbidden"
            : code === "404"
              ? "NotFound"
              : code === "409"
                ? "Conflict"
                : code === "413"
                  ? "PayloadTooLarge"
                  : "InternalError";
    map[code] = { $ref: `#/components/responses/${name}` };
  }
  return map;
}

function op(input: Operation): Operation {
  return input;
}

function queryParam(name: string, schema: unknown, description: string) {
  return { name, in: "query", schema, description };
}

function timeParams(includeInterval = false) {
  const defaultHint =
    " If from, to, and preset are omitted, analytics endpoints default to the last 7 days ending at request time.";
  return [
    queryParam(
      "from",
      { type: "string", format: "date-time" },
      `Inclusive ISO 8601 start time.${defaultHint}`,
    ),
    queryParam(
      "to",
      { type: "string", format: "date-time" },
      `Exclusive ISO 8601 end time.${defaultHint}`,
    ),
    queryParam(
      "preset",
      ref("Preset"),
      `Named time range preset. Mutually exclusive with from and to.${defaultHint}`,
    ),
    queryParam(
      "timeZone",
      { type: "string", maxLength: 80, default: "UTC" },
      "IANA time zone used to resolve presets. Defaults to UTC.",
    ),
    ...(includeInterval
      ? [
          queryParam(
            "interval",
            {
              type: "string",
              enum: ["minute", "hour", "day", "week", "month"],
              default: "day",
            },
            "Time bucket granularity.",
          ),
        ]
      : []),
  ];
}

function filterParam() {
  return {
    name: "filter",
    in: "query",
    style: "deepObject",
    explode: true,
    schema: ref("FilterObject"),
    description: "Simple equality filters as filter[field]=value.",
  };
}

function metricParam() {
  return {
    name: "metrics",
    in: "query",
    style: "form",
    explode: false,
    schema: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "views",
          "sessions",
          "visitors",
          "bounces",
          "bounceRate",
          "avgDurationMs",
          "viewsPerSession",
          "events",
        ],
      },
    },
    description: "Comma-separated metrics to include.",
  };
}

function cursorParams() {
  return [
    queryParam(
      "limit",
      { type: "integer", minimum: 1, maximum: 1000, default: 100 },
      "Maximum number of results.",
    ),
    queryParam(
      "cursor",
      { type: "string", maxLength: 512 },
      "Opaque pagination cursor from the previous response.",
    ),
  ];
}

function sortParam() {
  return queryParam(
    "sort",
    { type: "string", maxLength: 120 },
    "Sort field. Prefix with '-' for descending order.",
  );
}

const sampleSiteId = "550e8400-e29b-41d4-a716-446655440000";
const sampleTeamId = "550e8400-e29b-41d4-a716-446655440001";
const sampleTokenId = "550e8400-e29b-41d4-a716-446655440002";
const sampleEventId = "6f5d9b2c-b1d5-4d75-89aa-0b71ec1f9c00";
const sampleVisitorId = "0a1c1f5b-f529-44be-9f29-9b0b358c0001";
const sampleSessionId = "de0b8cf1-7fc6-40bd-8127-4c8e9f1c0001";
const sampleFunnelId = "7c10f7f2-0f8a-4788-b59d-289e69e95000";
const sampleGeneratedAt = "2026-06-26T12:00:00Z";
const sampleTimeRange = {
  from: "2026-05-27T00:00:00Z",
  to: "2026-06-26T00:00:00Z",
  timeZone: "Asia/Shanghai",
};

function meta(extra: Record<string, unknown> = {}) {
  return {
    requestId: "req_abc123",
    generatedAt: sampleGeneratedAt,
    ...extra,
  };
}

function success(data: unknown, extraMeta: Record<string, unknown> = {}) {
  return { data, meta: meta(extraMeta) };
}

function list(data: unknown[], extraMeta: Record<string, unknown> = {}) {
  return { data, meta: meta(extraMeta) };
}

function paginated(data: unknown[]) {
  return {
    data,
    pagination: {
      limit: 100,
      nextCursor: "cur_next_abc",
      hasMore: true,
    },
    meta: meta(),
  };
}

const siteExample = {
  id: sampleSiteId,
  name: "Example Blog",
  domain: "example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: sampleGeneratedAt,
  sharing: { publicEnabled: true, publicSlug: "example-blog" },
  links: {
    self: `/api/v1/sites/${sampleSiteId}`,
    tracking: `/api/v1/sites/${sampleSiteId}/tracking`,
    privacy: `/api/v1/sites/${sampleSiteId}/privacy`,
    sharing: `/api/v1/sites/${sampleSiteId}/sharing`,
    analyticsSchema: `/api/v1/sites/${sampleSiteId}/analytics/schema`,
    analyticsOverview: `/api/v1/sites/${sampleSiteId}/analytics/overview`,
    events: `/api/v1/sites/${sampleSiteId}/events`,
    visitors: `/api/v1/sites/${sampleSiteId}/visitors`,
    sessions: `/api/v1/sites/${sampleSiteId}/sessions`,
    realtimeSnapshot: `/api/v1/sites/${sampleSiteId}/realtime/snapshot`,
  },
};

const overviewMetricsExample = {
  views: 12500,
  sessions: 8300,
  visitors: 6100,
  bounces: 3200,
  bounceRate: 0.386,
  avgDurationMs: 506000,
  viewsPerSession: 1.51,
  approximateVisitors: false,
};

const eventExample = {
  id: sampleEventId,
  siteId: sampleSiteId,
  eventName: "signup",
  occurredAt: sampleGeneratedAt,
  sessionId: sampleSessionId,
  visitorId: sampleVisitorId,
  data: { plan: "pro" },
};

const visitorExample = {
  visitorId: sampleVisitorId,
  firstSeenAt: "2026-06-26T11:00:00Z",
  lastSeenAt: sampleGeneratedAt,
  views: 4,
  sessions: 1,
  events: 2,
  links: {
    self: `/api/v1/sites/${sampleSiteId}/visitors/${sampleVisitorId}`,
    sessions: `/api/v1/sites/${sampleSiteId}/visitors/${sampleVisitorId}/sessions`,
    events: `/api/v1/sites/${sampleSiteId}/visitors/${sampleVisitorId}/events`,
  },
};

const sessionExample = {
  sessionId: sampleSessionId,
  visitorId: sampleVisitorId,
  startedAt: "2026-06-26T11:45:00Z",
  endedAt: null,
  views: 3,
  events: 1,
  links: {
    self: `/api/v1/sites/${sampleSiteId}/sessions/${sampleSessionId}`,
    events: `/api/v1/sites/${sampleSiteId}/sessions/${sampleSessionId}/events`,
  },
};

const funnelExample = {
  id: sampleFunnelId,
  siteId: sampleSiteId,
  name: "Signup funnel",
  description: "Pricing page to signup conversion.",
  steps: [
    { type: "pageview", value: "/pricing", label: "Pricing" },
    { type: "event", value: "signup", label: "Signup" },
  ],
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: sampleGeneratedAt,
  links: {
    self: `/api/v1/sites/${sampleSiteId}/funnels/${sampleFunnelId}`,
    analysis: `/api/v1/sites/${sampleSiteId}/funnels/${sampleFunnelId}/analysis`,
  },
};

const funnelAnalysisExample = {
  steps: [
    {
      index: 0,
      label: "Pricing",
      type: "pageview",
      sessions: 1000,
      visitors: 920,
      conversionRate: 1,
      stepConversionRate: 1,
      dropOffSessions: 350,
      dropOffRate: 0.35,
    },
    {
      index: 1,
      label: "Signup",
      type: "event",
      sessions: 650,
      visitors: 610,
      conversionRate: 0.65,
      stepConversionRate: 0.65,
      dropOffSessions: 0,
      dropOffRate: 0,
    },
  ],
  summary: {
    totalSessions: 1000,
    convertedSessions: 650,
    totalVisitors: 920,
    convertedVisitors: 610,
    overallConversionRate: 0.65,
    largestDropOffStepIndex: 1,
  },
};

function buildSchemas(): Record<string, unknown> {
  const iso = { type: "string", format: "date-time" };
  const uuid = { type: "string", format: "uuid" };
  return {
    Meta: {
      type: "object",
      description: "Response metadata.",
      required: ["generatedAt"],
      properties: {
        requestId: {
          type: "string",
          description: "Request correlation identifier.",
        },
        generatedAt: {
          ...iso,
          description: "Response generation time in UTC.",
        },
        timeRange: ref("TimeRange"),
        interval: {
          type: "string",
          enum: ["minute", "hour", "day", "week", "month"],
        },
        partialFailure: { type: "boolean" },
      },
      additionalProperties: true,
    },
    LinkMap: {
      type: "object",
      description: "Machine-readable links for resource discovery.",
      additionalProperties: { type: "string" },
    },
    SuccessEnvelope: {
      type: "object",
      description: "Standard successful response envelope.",
      required: ["data", "meta"],
      properties: {
        data: {},
        links: ref("LinkMap"),
        meta: ref("Meta"),
      },
      additionalProperties: false,
    },
    ListEnvelope: {
      type: "object",
      description: "Standard list response envelope.",
      required: ["data", "meta"],
      properties: {
        data: { type: "array", items: {} },
        links: ref("LinkMap"),
        meta: ref("Meta"),
      },
      additionalProperties: false,
    },
    Pagination: {
      type: "object",
      description: "Cursor pagination state.",
      required: ["limit", "nextCursor", "hasMore"],
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        nextCursor: { type: ["string", "null"], maxLength: 512 },
        hasMore: { type: "boolean" },
      },
    },
    PaginatedEnvelope: {
      type: "object",
      description: "Standard cursor-paginated list response envelope.",
      required: ["data", "pagination", "meta"],
      properties: {
        data: { type: "array", items: {} },
        pagination: ref("Pagination"),
        links: ref("LinkMap"),
        meta: ref("Meta"),
      },
      additionalProperties: false,
    },
    ErrorResponse: {
      type: "object",
      description: "Standard error response envelope.",
      example: {
        error: {
          code: "validation_failed",
          message: "Invalid request body.",
          details: { field: "steps" },
          help: {
            token: "/api/v1/token",
            documentation: "/.well-known/openapi.json",
          },
        },
        meta: meta(),
      },
      required: ["error", "meta"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: {
              type: "string",
              enum: [
                "invalid_request",
                "invalid_json",
                "validation_failed",
                "invalid_api_key",
                "api_key_expired",
                "api_key_revoked",
                "insufficient_scope",
                "site_not_found",
                "resource_not_found",
                "conflict",
                "payload_too_large",
                "internal_error",
              ],
            },
            message: { type: "string" },
            details: { type: "object", additionalProperties: true },
            help: {
              type: "object",
              properties: {
                token: { type: "string" },
                documentation: { type: "string" },
              },
            },
          },
        },
        meta: ref("Meta"),
      },
    },
    Preset: {
      type: "string",
      description:
        "Named time range preset. today: current calendar day in timeZone. yesterday: previous calendar day. last_7_days and last_30_days end at request time. this_week/last_week and this_month/last_month use calendar boundaries in timeZone.",
      enum: [
        "today",
        "yesterday",
        "last_7_days",
        "last_30_days",
        "this_week",
        "last_week",
        "this_month",
        "last_month",
      ],
    },
    TimeRange: {
      type: "object",
      description: "Resolved inclusive/exclusive time range.",
      required: ["from", "to", "timeZone"],
      properties: {
        from: { ...iso, description: "Inclusive start time." },
        to: { ...iso, description: "Exclusive end time." },
        timeZone: { type: "string", maxLength: 80 },
      },
    },
    TimeRangeInput: {
      type: "object",
      description:
        "Optional time range input. If from, to, and preset are omitted, analytics endpoints default to the last 7 days ending at request time. The default timeZone is UTC.",
      properties: {
        from: {
          ...iso,
          description: "Inclusive ISO 8601 start time.",
        },
        to: {
          ...iso,
          description: "Exclusive ISO 8601 end time.",
        },
        preset: ref("Preset"),
        timeZone: {
          type: "string",
          maxLength: 80,
          default: "UTC",
          description: "IANA time zone used to resolve presets.",
        },
      },
    },
    FilterObject: {
      type: "object",
      description: "Simple equality filters keyed by stable dimension name.",
      additionalProperties: { type: "string", maxLength: 500 },
    },
    ComplexFilter: {
      type: "object",
      description:
        "Advanced filter rule for explore and search endpoints. Operators: eq equals; neq does not equal; in is one of; notIn is not one of; contains includes substring; startsWith/endsWith match string edges; gt/gte/lt/lte compare ordered values; exists/notExists ignore value.",
      required: ["field", "op"],
      properties: {
        field: {
          type: "string",
          maxLength: 120,
          description: "Stable filter field path.",
        },
        op: {
          type: "string",
          description:
            "Filter operator. exists and notExists ignore value; in and notIn expect an array-compatible value.",
          enum: [
            "eq",
            "neq",
            "in",
            "notIn",
            "contains",
            "startsWith",
            "endsWith",
            "gt",
            "gte",
            "lt",
            "lte",
            "exists",
            "notExists",
          ],
        },
        value: {},
      },
    },
    MetricDefinition: {
      type: "object",
      description: "Metric available for analytics queries.",
      required: ["key", "label", "type", "description"],
      properties: {
        key: { type: "string" },
        label: { type: "string" },
        type: { type: "string", enum: ["integer", "rate", "duration_ms"] },
        description: { type: "string" },
      },
    },
    DimensionDefinition: {
      type: "object",
      description: "Dimension available for analytics breakdowns and filters.",
      required: ["key", "label", "type"],
      properties: {
        key: { type: "string" },
        label: { type: "string" },
        type: { type: "string" },
        description: { type: "string" },
      },
    },
    SiteAccess: {
      type: "object",
      description: "Sites this token may access.",
      required: ["mode", "siteIds"],
      properties: {
        mode: {
          type: "string",
          enum: ["all", "restricted"],
          description:
            "all means the token can access all current and future team sites; restricted means only listed siteIds.",
        },
        siteIds: { type: "array", items: uuid },
      },
    },
    Token: {
      type: "object",
      description: "Non-secret metadata for the current API token.",
      required: ["id", "name", "status", "team", "scopes", "siteAccess"],
      properties: {
        id: uuid,
        name: { type: "string", maxLength: 120 },
        status: {
          type: "string",
          enum: ["active", "expired", "revoked"],
          description:
            "active can be used; expired passed expiresAt; revoked was disabled.",
        },
        createdAt: iso,
        expiresAt: { type: ["string", "null"], format: "date-time" },
        lastUsedAt: { type: ["string", "null"], format: "date-time" },
        team: {
          type: "object",
          required: ["id", "name"],
          properties: { id: uuid, name: { type: "string", maxLength: 120 } },
        },
        scopes: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "site:read",
              "site:write",
              "site_config:read",
              "site_config:write",
              "analytics:read",
            ],
          },
        },
        siteAccess: ref("SiteAccess"),
      },
    },
    TokenResponse: envelope(ref("Token")),
    TokenCheckRequest: {
      type: "object",
      description:
        "Bulk permission check request for scopes and optional site access.",
      required: ["checks"],
      properties: {
        checks: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            required: ["scope"],
            properties: {
              scope: { type: "string", maxLength: 80 },
              siteId: uuid,
            },
          },
        },
      },
    },
    TokenCheckResponse: envelope({
      type: "object",
      properties: {
        checks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              scope: { type: "string" },
              siteId: uuid,
              allowed: { type: "boolean" },
              reason: {
                type: "string",
                enum: ["missing_scope", "site_not_allowed", "token_inactive"],
              },
            },
          },
        },
      },
    }),
    CapabilitiesFeatures: {
      type: "object",
      description: "Feature availability flags for the current token.",
      required: [
        "sites",
        "tracking",
        "privacy",
        "sharing",
        "analytics",
        "events",
        "visitors",
        "sessions",
        "funnels",
        "performance",
        "realtime",
        "exports",
        "batch",
      ],
      properties: {
        sites: { type: "boolean" },
        tracking: { type: "boolean" },
        privacy: { type: "boolean" },
        sharing: { type: "boolean" },
        analytics: { type: "boolean" },
        events: { type: "boolean" },
        visitors: { type: "boolean" },
        sessions: { type: "boolean" },
        funnels: { type: "boolean" },
        performance: { type: "boolean" },
        realtime: { type: "boolean" },
        exports: { type: "boolean" },
        batch: { type: "boolean" },
      },
      additionalProperties: false,
    },
    CapabilitiesLimits: {
      type: "object",
      description: "Runtime limits exposed to clients.",
      required: [
        "batchMaxRequests",
        "defaultTimeRangeDays",
        "maxTimeRangeDays",
        "defaultPageLimit",
        "maxPageLimit",
      ],
      properties: {
        batchMaxRequests: { type: "integer", minimum: 1 },
        defaultTimeRangeDays: { type: "integer", minimum: 1 },
        maxTimeRangeDays: { type: "integer", minimum: 1 },
        defaultPageLimit: { type: "integer", minimum: 1 },
        maxPageLimit: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    Capabilities: {
      type: "object",
      description: "Runtime capabilities available to the current token.",
      required: ["apiVersion", "features", "limits", "links"],
      properties: {
        apiVersion: { type: "string" },
        features: ref("CapabilitiesFeatures"),
        limits: ref("CapabilitiesLimits"),
        links: ref("LinkMap"),
      },
      additionalProperties: false,
    },
    CapabilitiesResponse: envelope(ref("Capabilities")),
    RootDiscoveryResponse: envelope({
      type: "object",
      description: "API root discovery response with stable links.",
      properties: {
        version: { type: "string" },
        service: { type: "string" },
        links: ref("LinkMap"),
      },
    }),
    Team: {
      type: "object",
      properties: {
        id: uuid,
        name: { type: "string", maxLength: 120 },
        createdAt: iso,
        links: ref("LinkMap"),
      },
    },
    TeamResponse: envelope(ref("Team")),
    Site: {
      type: "object",
      description: "Tracked site resource.",
      required: [
        "id",
        "name",
        "domain",
        "createdAt",
        "updatedAt",
        "sharing",
        "links",
      ],
      properties: {
        id: uuid,
        name: { type: "string", maxLength: 120 },
        domain: { type: "string", maxLength: 255 },
        createdAt: iso,
        updatedAt: iso,
        sharing: ref("SharingSettings"),
        links: ref("LinkMap"),
      },
    },
    SiteCreateInput: {
      type: "object",
      description: "Input for creating a site in the current team.",
      required: ["name", "domain"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        domain: { type: "string", minLength: 1, maxLength: 255 },
        sharing: ref("SharingSettings"),
      },
    },
    SiteUpdateInput: {
      type: "object",
      description: "Partial update for site metadata and sharing settings.",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        domain: { type: "string", minLength: 1, maxLength: 255 },
        sharing: ref("SharingSettings"),
      },
    },
    SiteResponse: envelope(ref("Site")),
    SiteListResponse: listEnvelope(ref("Site")),
    TrackingSettings: {
      type: "object",
      description: "Tracking settings for the client script.",
      properties: {
        trackPageviews: { type: "boolean" },
        trackQuery: { type: "boolean" },
        trackHash: { type: "boolean" },
        trackCustomEvents: { type: "boolean" },
        trackEngagement: { type: "boolean" },
        trackWebVitals: { type: "boolean" },
        autoTrackOutboundLinks: { type: "boolean" },
        trackingStrength: {
          type: "string",
          enum: ["strong", "smart", "weak"],
          description:
            "Privacy-aware tracking mode. strong collects the richest allowed context; smart balances analytics and privacy; weak minimizes collection for stricter privacy needs.",
        },
        allowedDomains: {
          type: "array",
          items: { type: "string", maxLength: 255 },
        },
        excludedPaths: {
          type: "array",
          items: { type: "string", maxLength: 2048 },
        },
      },
    },
    TrackingSettingsResponse: envelope(ref("TrackingSettings")),
    TrackingScriptResponse: envelope({
      type: "object",
      properties: {
        siteId: uuid,
        src: { type: "string", format: "uri" },
        snippet: { type: "string" },
      },
    }),
    PrivacySettings: {
      type: "object",
      description: "Privacy settings for visitor data handling.",
      properties: {
        respectDoNotTrack: { type: "boolean" },
        anonymizeIp: { type: "boolean" },
        euMode: { type: "boolean" },
        visitorTokenMode: { type: "string", enum: ["daily"] },
        dataRetentionDays: { type: "integer", minimum: 1 },
      },
    },
    PrivacySettingsResponse: envelope(ref("PrivacySettings")),
    SharingSettings: {
      type: "object",
      description: "Public sharing settings for a site.",
      properties: {
        publicEnabled: { type: "boolean" },
        publicSlug: { type: ["string", "null"], maxLength: 80 },
      },
    },
    SharingSettingsResponse: envelope(ref("SharingSettings")),
    AnalyticsSchemaResponse: envelope({
      type: "object",
      description:
        "Schema discovery response listing supported metrics, dimensions, filters, operators, intervals, and presets.",
      properties: {
        metrics: { type: "array", items: ref("MetricDefinition") },
        dimensions: { type: "array", items: ref("DimensionDefinition") },
        filters: { type: "array", items: { type: "string" } },
        operators: { type: "array", items: { type: "string" } },
        intervals: { type: "array", items: { type: "string" } },
        presets: { type: "array", items: ref("Preset") },
        timeRange: {
          type: "object",
          properties: {
            earliestAvailableAt: {
              type: ["string", "null"],
              format: "date-time",
            },
            latestAvailableAt: iso,
          },
        },
        links: ref("LinkMap"),
      },
    }),
    OverviewMetrics: {
      type: "object",
      description: "Aggregate analytics metrics for a time range.",
      properties: {
        views: { type: "integer" },
        sessions: { type: "integer" },
        visitors: { type: "integer" },
        bounces: { type: "integer" },
        bounceRate: { type: "number", minimum: 0, maximum: 1 },
        avgDurationMs: {
          type: "number",
          description: "Average session duration in milliseconds.",
        },
        viewsPerSession: { type: "number" },
        approximateVisitors: { type: "boolean" },
      },
    },
    AnalyticsOverviewResponse: envelope(ref("OverviewMetrics")),
    TimeseriesPoint: {
      type: "object",
      description: "One time bucket of analytics metrics.",
      properties: {
        start: iso,
        end: iso,
        views: { type: "integer" },
        sessions: { type: "integer" },
        visitors: { type: "integer" },
        events: { type: "integer" },
      },
    },
    AnalyticsTimeseriesResponse: listEnvelope(ref("TimeseriesPoint")),
    BreakdownRow: {
      type: "object",
      description: "One analytics breakdown row.",
      properties: {
        key: { type: "string" },
        label: { type: "string" },
        views: { type: "integer" },
        sessions: { type: "integer" },
        visitors: { type: "integer" },
        events: { type: "integer" },
      },
    },
    AnalyticsBreakdownResponse: listEnvelope(ref("BreakdownRow")),
    AnalyticsCrossBreakdownCell: {
      type: "object",
      description: "One cell in a two-dimensional analytics breakdown.",
      properties: {
        secondaryKey: {
          type: "string",
          description: "Machine-readable secondary dimension value.",
        },
        secondaryLabel: {
          type: "string",
          description: "Human-readable secondary dimension label.",
        },
        value: { type: "number", description: "Aggregated metric value." },
      },
    },
    AnalyticsCrossBreakdownRow: {
      type: "object",
      description: "One row in a two-dimensional analytics breakdown.",
      properties: {
        primaryKey: {
          type: "string",
          description: "Machine-readable primary dimension value.",
        },
        primaryLabel: {
          type: "string",
          description: "Human-readable primary dimension label.",
        },
        values: {
          type: "array",
          items: ref("AnalyticsCrossBreakdownCell"),
        },
      },
    },
    AnalyticsCrossBreakdownResponse: {
      allOf: [
        ref("SuccessEnvelope"),
        {
          type: "object",
          description: "Two-dimensional analytics breakdown.",
          properties: {
            data: {
              type: "array",
              items: ref("AnalyticsCrossBreakdownRow"),
            },
            meta: {
              allOf: [
                ref("Meta"),
                {
                  type: "object",
                  properties: {
                    primary: {
                      type: "string",
                      description: "Primary dimension.",
                    },
                    secondary: {
                      type: "string",
                      description: "Secondary dimension.",
                    },
                    metric: {
                      type: "string",
                      description: "Aggregated metric.",
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    },
    AnalyticsExploreRequest: {
      type: "object",
      description: "Advanced multidimensional analytics query.",
      properties: {
        timeRange: ref("TimeRangeInput"),
        metrics: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          description:
            "Metrics to aggregate. Use analytics/schema to discover supported metrics.",
          items: { type: "string", maxLength: 80 },
        },
        dimensions: {
          type: "array",
          maxItems: 5,
          description:
            "Dimensions to group by. Use analytics/schema to discover supported dimensions.",
          items: { type: "string", maxLength: 120 },
        },
        filters: { type: "array", items: ref("ComplexFilter") },
        orderBy: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string", maxLength: 120 },
              direction: { type: "string", enum: ["asc", "desc"] },
            },
          },
        },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
    },
    AnalyticsCompareResponse: envelope({
      type: "object",
      description: "Period-over-period analytics comparison.",
      properties: {
        current: ref("OverviewMetrics"),
        previous: ref("OverviewMetrics"),
        change: {
          type: "object",
          description:
            "Relative changes as 0-based rates. Example: 0.12 means +12%.",
          additionalProperties: { type: "number" },
        },
      },
    }),
    AnalyticsExploreRow: {
      type: "object",
      description: "One row returned by an analytics explore query.",
      additionalProperties: true,
    },
    AnalyticsExploreResponse: envelope({
      type: "object",
      description: "Advanced analytics query result.",
      properties: {
        rows: { type: "array", items: ref("AnalyticsExploreRow") },
        metrics: { type: "array", items: { type: "string" } },
        dimensions: { type: "array", items: { type: "string" } },
        filters: { type: "array", items: ref("ComplexFilter") },
      },
    }),
    RetentionCohortsResponse: envelope({
      type: "object",
      description: "Visitor retention cohort response.",
      properties: {
        interval: {
          type: "string",
          enum: ["minute", "hour", "day", "week", "month"],
        },
        cohorts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start: iso,
              size: { type: "integer", minimum: 0 },
              periods: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    index: { type: "integer", minimum: 0 },
                    visitors: { type: "integer", minimum: 0 },
                    rate: { type: "number", minimum: 0, maximum: 1 },
                  },
                },
              },
            },
          },
        },
      },
    }),
    EventsSummaryResponse: envelope({
      type: "object",
      description: "Summary of custom event activity.",
      required: ["events", "eventTypes", "sessions", "visitors"],
      properties: {
        events: {
          type: "integer",
          minimum: 0,
          description: "Total custom events.",
        },
        eventTypes: {
          type: "integer",
          minimum: 0,
          description: "Number of distinct event names.",
        },
        sessions: {
          type: "integer",
          minimum: 0,
          description: "Number of sessions with custom events.",
        },
        visitors: {
          type: "integer",
          minimum: 0,
          description: "Number of visitors with custom events.",
        },
        avgEventsPerSession: {
          type: "number",
          minimum: 0,
          description: "Average custom event count per session.",
        },
      },
    }),
    EventRecord: {
      type: "object",
      additionalProperties: true,
      properties: {
        id: uuid,
        eventName: { type: "string", maxLength: 120 },
        occurredAt: iso,
      },
    },
    EventListResponse: paginatedEnvelope(ref("EventRecord")),
    EventResponse: envelope(ref("EventRecord")),
    EventFieldDefinition: {
      type: "object",
      description: "Observed custom event payload field.",
      required: ["path", "valueTypes"],
      properties: {
        path: {
          type: "string",
          maxLength: 240,
          description: "Dot-notation path inside the event payload.",
        },
        valueTypes: {
          type: "array",
          description: "Observed JSON value types for this field.",
          items: {
            type: "string",
            enum: ["string", "number", "boolean", "null", "object", "array"],
          },
        },
        examples: {
          type: "array",
          description: "Example observed values.",
          items: {},
        },
      },
    },
    EventType: {
      type: "object",
      description: "Details and aggregate metrics for one custom event type.",
      required: ["name", "events", "sessions", "visitors"],
      properties: {
        name: {
          type: "string",
          maxLength: 120,
          description: "Event name.",
        },
        label: {
          type: "string",
          maxLength: 120,
          description: "Human-readable event label.",
        },
        events: {
          type: "integer",
          minimum: 0,
          description: "Total event count.",
        },
        sessions: {
          type: "integer",
          minimum: 0,
          description: "Number of sessions containing this event.",
        },
        visitors: {
          type: "integer",
          minimum: 0,
          description: "Number of visitors triggering this event.",
        },
        avgEventsPerSession: {
          type: "number",
          minimum: 0,
          description: "Average event count per session.",
        },
        firstSeenAt: {
          type: ["string", "null"],
          format: "date-time",
          description: "First observed time for this event type.",
        },
        lastSeenAt: {
          type: ["string", "null"],
          format: "date-time",
          description: "Last observed time for this event type.",
        },
        fields: {
          type: "array",
          description: "Observed payload fields for this event type.",
          items: ref("EventFieldDefinition"),
        },
        links: ref("LinkMap"),
      },
    },
    EventTypeResponse: envelope(
      ref("EventType"),
      "Response envelope for one custom event type.",
    ),
    EventPayloadFilter: {
      type: "object",
      description: "Filter applied to custom event payload fields.",
      required: ["path", "op"],
      properties: {
        path: {
          type: "string",
          maxLength: 240,
          description: "Dot-notation path inside the event payload.",
        },
        op: {
          type: "string",
          description:
            "Payload filter operator. eq/neq compare equality, in/notIn compare sets, contains/startsWith/endsWith compare strings, gt/gte/lt/lte compare ordered values, exists/notExists ignore value.",
          enum: [
            "eq",
            "neq",
            "in",
            "notIn",
            "contains",
            "startsWith",
            "endsWith",
            "gt",
            "gte",
            "lt",
            "lte",
            "exists",
            "notExists",
          ],
        },
        value: {
          description:
            "Comparison value. Required unless op is exists or notExists.",
        },
      },
      additionalProperties: false,
    },
    EventSearchRequest: {
      type: "object",
      description: "Request for searching event records with complex filters.",
      properties: {
        timeRange: ref("TimeRangeInput"),
        eventName: {
          type: "string",
          maxLength: 120,
          description: "Optional event name filter.",
        },
        payloadFilters: {
          type: "array",
          items: ref("EventPayloadFilter"),
        },
        filters: {
          type: "array",
          items: ref("ComplexFilter"),
        },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
        cursor: { type: "string", maxLength: 512 },
      },
      additionalProperties: false,
    },
    Visitor: {
      type: "object",
      description: "Visitor resource.",
      additionalProperties: true,
      properties: {
        visitorId: { type: "string", maxLength: 160 },
        firstSeenAt: iso,
        lastSeenAt: iso,
        views: { type: "integer", minimum: 0 },
        sessions: { type: "integer", minimum: 0 },
        events: { type: "integer", minimum: 0 },
        links: ref("LinkMap"),
      },
    },
    VisitorListResponse: paginatedEnvelope(ref("Visitor")),
    VisitorResponse: envelope(ref("Visitor")),
    Session: {
      type: "object",
      description: "Session resource.",
      additionalProperties: true,
      properties: {
        sessionId: { type: "string", maxLength: 160 },
        visitorId: { type: "string", maxLength: 160 },
        startedAt: iso,
        endedAt: { type: ["string", "null"], format: "date-time" },
        views: { type: "integer", minimum: 0 },
        events: { type: "integer", minimum: 0 },
        links: ref("LinkMap"),
      },
    },
    SessionListResponse: paginatedEnvelope(ref("Session")),
    SessionResponse: envelope(ref("Session")),
    TeamUsageResponse: envelope({
      type: "object",
      description: "Usage information for the current team.",
      required: ["sites"],
      properties: {
        sites: { type: "integer", minimum: 0 },
      },
    }),
    PerformanceSummaryResponse: envelope({
      type: "object",
      description:
        "Core Web Vitals summary in milliseconds for TTFB/FCP/LCP/INP and unitless CLS.",
      additionalProperties: true,
    }),
    PerformanceMetricPoint: {
      type: "object",
      description: "Performance metric point.",
      additionalProperties: true,
      properties: {
        start: iso,
        end: iso,
        ttfb: {
          type: "number",
          description: "Time to first byte in milliseconds.",
        },
        fcp: {
          type: "number",
          description: "First contentful paint in milliseconds.",
        },
        lcp: {
          type: "number",
          description: "Largest contentful paint in milliseconds.",
        },
        cls: { type: "number", description: "Cumulative layout shift." },
        inp: {
          type: "number",
          description: "Interaction to next paint in milliseconds.",
        },
      },
    },
    PerformanceTimeseriesResponse: listEnvelope(ref("PerformanceMetricPoint")),
    PerformanceBreakdownRow: {
      type: "object",
      description: "Performance breakdown row.",
      additionalProperties: true,
      properties: {
        key: { type: "string" },
        label: { type: "string" },
        ttfb: { type: "number" },
        fcp: { type: "number" },
        lcp: { type: "number" },
        cls: { type: "number" },
        inp: { type: "number" },
      },
    },
    PerformanceBreakdownResponse: listEnvelope(ref("PerformanceBreakdownRow")),
    FunnelStepInput: {
      type: "object",
      description: "One step in a funnel definition.",
      required: ["type", "value"],
      properties: {
        type: {
          type: "string",
          enum: ["pageview", "event"],
          description:
            "Step matching type. pageview matches a page path; event matches a custom event name.",
        },
        value: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Page path or event name to match.",
        },
        label: {
          type: "string",
          maxLength: 120,
          description: "Optional display label.",
        },
      },
      additionalProperties: false,
    },
    FunnelCreateInput: {
      type: "object",
      description: "Input for creating a saved funnel.",
      required: ["name", "steps"],
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Human-readable funnel name.",
        },
        description: {
          type: ["string", "null"],
          maxLength: 500,
          description: "Optional funnel description.",
        },
        steps: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          items: ref("FunnelStepInput"),
        },
      },
      additionalProperties: false,
    },
    FunnelUpdateInput: {
      type: "object",
      description: "Partial update for a saved funnel.",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: ["string", "null"], maxLength: 500 },
        steps: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          items: ref("FunnelStepInput"),
        },
      },
      additionalProperties: false,
    },
    FunnelAnalysisRequest: {
      type: "object",
      description:
        "Request for ad-hoc funnel analysis. Use query parameters (from, to, preset, timeZone) for time range.",
      required: ["steps"],
      properties: {
        steps: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          items: ref("FunnelStepInput"),
        },
      },
      additionalProperties: false,
    },
    FunnelStep: {
      type: "object",
      description: "One saved funnel step.",
      required: ["type", "value"],
      properties: {
        type: { type: "string", enum: ["pageview", "event"] },
        value: { type: "string", maxLength: 500 },
        label: { type: "string", maxLength: 120 },
      },
    },
    Funnel: {
      type: "object",
      description: "Saved funnel definition.",
      required: ["id", "siteId", "name", "steps", "createdAt", "updatedAt"],
      properties: {
        id: uuid,
        siteId: uuid,
        name: { type: "string", maxLength: 200 },
        description: { type: ["string", "null"], maxLength: 500 },
        steps: { type: "array", items: ref("FunnelStep") },
        createdAt: iso,
        updatedAt: iso,
        links: ref("LinkMap"),
      },
    },
    FunnelResponse: envelope(ref("Funnel")),
    FunnelListResponse: listEnvelope(ref("Funnel")),
    FunnelAnalysisStep: {
      type: "object",
      description: "Funnel analysis metrics for one step.",
      properties: {
        index: { type: "integer", minimum: 0 },
        label: { type: "string" },
        type: { type: "string", enum: ["pageview", "event"] },
        sessions: { type: "integer", minimum: 0 },
        visitors: { type: "integer", minimum: 0 },
        conversionRate: { type: "number" },
        stepConversionRate: { type: "number" },
        dropOffSessions: { type: "integer", minimum: 0 },
        dropOffRate: { type: "number" },
      },
    },
    FunnelAnalysisSummary: {
      type: "object",
      properties: {
        totalSessions: { type: "integer", minimum: 0 },
        convertedSessions: { type: "integer", minimum: 0 },
        totalVisitors: { type: "integer", minimum: 0 },
        convertedVisitors: { type: "integer", minimum: 0 },
        overallConversionRate: { type: "number" },
        largestDropOffStepIndex: { type: ["integer", "null"] },
      },
    },
    FunnelAnalysis: {
      type: "object",
      description: "Funnel analysis result.",
      properties: {
        steps: { type: "array", items: ref("FunnelAnalysisStep") },
        summary: ref("FunnelAnalysisSummary"),
      },
    },
    FunnelAnalysisResponse: envelope(ref("FunnelAnalysis")),
    SavedFunnelAnalysisResponse: envelope({
      type: "object",
      description: "Saved funnel with current analysis result.",
      properties: {
        funnel: ref("Funnel"),
        analysis: ref("FunnelAnalysis"),
      },
    }),
    RealtimeEventListResponse: listEnvelope(ref("EventRecord")),
    RealtimeSessionListResponse: listEnvelope(ref("Session")),
    ActiveVisitorsResponse: envelope({
      type: "object",
      required: ["activeVisitors"],
      properties: {
        activeVisitors: { type: "integer", minimum: 0 },
      },
    }),
    RealtimeSnapshotResponse: envelope({
      type: "object",
      properties: {
        activeVisitors: { type: "integer" },
        events: { type: "array", items: ref("EventRecord") },
        sessions: { type: "array", items: ref("Session") },
      },
    }),
    BatchRequest: {
      type: "object",
      required: ["requests"],
      properties: {
        requests: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            required: ["id", "method", "path"],
            properties: {
              id: { type: "string", maxLength: 80 },
              method: { type: "string", enum: ["GET"] },
              path: { type: "string", maxLength: 2048 },
              query: {
                type: "object",
                additionalProperties: { type: "string", maxLength: 500 },
              },
            },
          },
        },
      },
    },
    BatchResponse: envelope({
      type: "object",
      properties: {
        responses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "integer" },
              body: {},
            },
          },
        },
      },
    }),
    HealthResponse: {
      type: "object",
      description: "Service health response.",
      properties: {
        status: { type: "string", enum: ["healthy"] },
        timestamp: iso,
      },
    },
    CollectPage: {
      type: "object",
      description: "Page context for a collect payload.",
      properties: {
        url: {
          type: "string",
          maxLength: 2048,
          description: "Full page URL.",
        },
        path: { type: "string", maxLength: 2048, description: "Page path." },
        title: { type: "string", maxLength: 300, description: "Page title." },
        referrer: {
          type: ["string", "null"],
          maxLength: 2048,
          description: "Full referrer URL, if available.",
        },
        hostname: {
          type: "string",
          maxLength: 255,
          description: "Page hostname.",
        },
        query: {
          type: "string",
          maxLength: 2048,
          description: "URL query string.",
        },
        hash: {
          type: "string",
          maxLength: 512,
          description: "URL hash fragment.",
        },
      },
    },
    CollectClient: {
      type: "object",
      description: "Browser and device context reported by the client SDK.",
      properties: {
        language: {
          type: "string",
          maxLength: 40,
          description: "Browser language.",
        },
        userAgent: {
          type: "string",
          maxLength: 1024,
          description: "Browser user agent string.",
        },
        screen: {
          type: "object",
          properties: {
            width: { type: "integer", minimum: 0 },
            height: { type: "integer", minimum: 0 },
          },
        },
        viewport: {
          type: "object",
          properties: {
            width: { type: "integer", minimum: 0 },
            height: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    CollectEvent: {
      type: "object",
      description: "Custom event data.",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          maxLength: 120,
          description: "Event name.",
        },
        data: {
          type: "object",
          additionalProperties: true,
          description: "Custom JSON-serializable event payload.",
        },
      },
    },
    CollectEngagement: {
      type: "object",
      description: "Engagement metrics reported by the client SDK.",
      properties: {
        durationMs: {
          type: "integer",
          minimum: 0,
          description: "Engagement duration in milliseconds.",
        },
        scrollDepth: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Maximum scroll depth as a 0-1 ratio.",
        },
      },
    },
    CollectPerformance: {
      type: "object",
      description: "Core Web Vitals and navigation timing data.",
      properties: {
        ttfb: {
          type: "number",
          minimum: 0,
          description: "Time to first byte in milliseconds.",
        },
        fcp: {
          type: "number",
          minimum: 0,
          description: "First contentful paint in milliseconds.",
        },
        lcp: {
          type: "number",
          minimum: 0,
          description: "Largest contentful paint in milliseconds.",
        },
        cls: {
          type: "number",
          minimum: 0,
          description: "Cumulative layout shift.",
        },
        inp: {
          type: "number",
          minimum: 0,
          description: "Interaction to next paint in milliseconds.",
        },
      },
    },
    CollectPayload: {
      type: "object",
      description:
        "Payload sent by the InsightFlare client SDK to ingest pageviews, events, engagement, and performance metrics.",
      required: ["siteId", "type"],
      properties: {
        siteId: {
          type: "string",
          format: "uuid",
          description: "Site identifier.",
        },
        type: {
          type: "string",
          enum: ["pageview", "event", "engagement", "performance"],
          description:
            "Tracking payload type. pageview records a page view; event records a custom user-defined event; engagement records duration or scroll; performance records Core Web Vitals.",
        },
        timestamp: {
          ...iso,
          description:
            "Client-side event time. If omitted, the server receive time may be used.",
        },
        anonymousId: {
          type: "string",
          maxLength: 120,
          description:
            "Anonymous visitor identifier generated by the client SDK.",
        },
        sessionId: {
          type: "string",
          maxLength: 120,
          description: "Client session identifier.",
        },
        page: ref("CollectPage"),
        client: ref("CollectClient"),
        event: ref("CollectEvent"),
        engagement: ref("CollectEngagement"),
        performance: ref("CollectPerformance"),
      },
      additionalProperties: false,
    },
  };
}

function buildPaths(): OpenAPISpec["paths"] {
  const siteParam = { $ref: "#/components/parameters/siteId" };
  const dimensionParam = { $ref: "#/components/parameters/dimension" };
  const eventNameParam = { $ref: "#/components/parameters/eventName" };
  const eventIdParam = { $ref: "#/components/parameters/eventId" };
  const visitorIdParam = { $ref: "#/components/parameters/visitorId" };
  const sessionIdParam = { $ref: "#/components/parameters/sessionId" };

  return {
    "/healthz": {
      get: op({
        operationId: "getHealth",
        summary: "Health check",
        description:
          "Returns service health status. No authentication required.",
        tags: ["Health"],
        security: [],
        responses: {
          "200": response("Service is healthy", "HealthResponse"),
          ...errorResponses("400", "500"),
        },
      }),
    },
    "/collect": {
      post: op({
        operationId: "collectEvent",
        summary: "Collect tracking event",
        description:
          "/collect is the unauthenticated client SDK ingestion endpoint. Successful receipt or silent drop returns 204.",
        tags: ["Ingestion"],
        security: [],
        requestBody: requestBody("CollectPayload"),
        responses: {
          "204": { description: "No Content" },
          ...errorResponses("400", "413"),
        },
      }),
    },
    "/api/v1": {
      get: op({
        operationId: "getApiRoot",
        summary: "API root discovery",
        description:
          "Returns stable machine-readable discovery links. No authentication required.",
        tags: ["Discovery"],
        security: [],
        responses: {
          "200": ok("RootDiscoveryResponse"),
          ...errorResponses("400", "500"),
        },
      }),
    },
    "/api/v1/token": {
      get: op({
        operationId: "getToken",
        summary: "Inspect current token",
        description:
          "Returns non-secret metadata, scopes, team, and site access for the current bearer token.",
        tags: ["Token"],
        responses: { "200": ok("TokenResponse"), ...errorResponses("401") },
      }),
    },
    "/api/v1/token/check": {
      post: op({
        operationId: "checkToken",
        summary: "Check token permissions",
        description:
          "Checks whether the current token has requested scope and optional site permissions.",
        tags: ["Token"],
        requestBody: requestBody("TokenCheckRequest"),
        responses: {
          "200": ok("TokenCheckResponse"),
          ...errorResponses("400", "401"),
        },
      }),
    },
    "/api/v1/capabilities": {
      get: op({
        operationId: "getCapabilities",
        summary: "Get runtime capabilities",
        description:
          "Returns features and limits available to the current token.",
        tags: ["Discovery"],
        responses: {
          "200": ok("CapabilitiesResponse"),
          ...errorResponses("401"),
        },
      }),
    },
    "/api/v1/team": {
      get: op({
        operationId: "getTeam",
        summary: "Get current team",
        description: "Returns the team associated with the current token.",
        tags: ["Team"],
        responses: { "200": ok("TeamResponse"), ...errorResponses("401") },
      }),
    },
    "/api/v1/team/usage": {
      get: op({
        operationId: "getTeamUsage",
        summary: "Get team usage",
        description: "Returns usage information for the current team.",
        tags: ["Team"],
        responses: {
          "200": ok("TeamUsageResponse"),
          ...errorResponses("401"),
        },
      }),
    },
    "/api/v1/team/analytics/overview": {
      get: op({
        operationId: "getTeamAnalyticsOverview",
        summary: "Get team analytics overview",
        description:
          "Aggregates analytics over sites accessible to the current token.",
        tags: ["Analytics"],
        parameters: [...timeParams(), filterParam(), metricParam()],
        responses: {
          "200": ok("AnalyticsOverviewResponse"),
          ...errorResponses("400", "401", "403"),
        },
      }),
    },
    "/api/v1/team/analytics/timeseries": {
      get: op({
        operationId: "getTeamAnalyticsTimeseries",
        summary: "Get team analytics time series",
        description: "Returns time-bucketed analytics over accessible sites.",
        tags: ["Analytics"],
        parameters: [...timeParams(true), filterParam(), metricParam()],
        responses: {
          "200": ok("AnalyticsTimeseriesResponse"),
          ...errorResponses("400", "401", "403"),
        },
      }),
    },
    "/api/v1/team/analytics/sites": {
      get: op({
        operationId: "getTeamAnalyticsSites",
        summary: "Get team analytics by site",
        description: "Breaks down team analytics by accessible site.",
        tags: ["Analytics"],
        parameters: [...timeParams(), metricParam()],
        responses: {
          "200": ok("AnalyticsBreakdownResponse"),
          ...errorResponses("400", "401", "403"),
        },
      }),
    },
    "/api/v1/team/analytics/breakdowns/{dimension}": {
      parameters: [dimensionParam],
      get: op({
        operationId: "getTeamAnalyticsBreakdown",
        summary: "Get team analytics breakdown",
        description: "Breaks down team analytics by a stable dimension.",
        tags: ["Analytics"],
        parameters: [
          ...timeParams(),
          filterParam(),
          metricParam(),
          queryParam(
            "limit",
            { type: "integer", minimum: 1, maximum: 1000 },
            "Maximum rows.",
          ),
        ],
        responses: {
          "200": ok("AnalyticsBreakdownResponse"),
          ...errorResponses("400", "401", "403"),
        },
      }),
    },
    "/api/v1/sites": {
      get: op({
        operationId: "listSites",
        summary: "List sites",
        description: "Returns sites accessible to the current token.",
        tags: ["Sites"],
        responses: {
          "200": ok("SiteListResponse"),
          ...errorResponses("401", "403"),
        },
      }),
      post: op({
        operationId: "createSite",
        summary: "Create site",
        description:
          "Creates a site in the token's team. Supports Idempotency-Key.",
        tags: ["Sites"],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            schema: { type: "string", maxLength: 200 },
            description: "Client-generated idempotency key.",
          },
        ],
        requestBody: requestBody("SiteCreateInput"),
        responses: {
          "201": ok("SiteResponse", "Created site"),
          ...errorResponses("400", "401", "403", "409"),
        },
      }),
    },
    "/api/v1/sites/{siteId}": {
      parameters: [siteParam],
      get: op({
        operationId: "getSite",
        summary: "Get site",
        description: "Returns a site by ID.",
        tags: ["Sites"],
        responses: {
          "200": ok("SiteResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
      patch: op({
        operationId: "updateSite",
        summary: "Update site",
        description: "Updates site metadata.",
        tags: ["Sites"],
        requestBody: requestBody("SiteUpdateInput"),
        responses: {
          "200": ok("SiteResponse"),
          ...errorResponses("400", "401", "403", "404", "409"),
        },
      }),
      delete: op({
        operationId: "deleteSite",
        summary: "Delete site",
        description: "Deletes a site and associated analytics data.",
        tags: ["Sites"],
        responses: {
          "204": { description: "No Content" },
          ...errorResponses("401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/tracking": {
      parameters: [siteParam],
      get: op({
        operationId: "getTrackingSettings",
        summary: "Get tracking settings",
        description: "Returns tracking settings.",
        tags: ["Settings"],
        responses: {
          "200": ok("TrackingSettingsResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
      patch: op({
        operationId: "updateTrackingSettings",
        summary: "Update tracking settings",
        description: "Updates tracking settings.",
        tags: ["Settings"],
        requestBody: requestBody("TrackingSettings"),
        responses: {
          "200": ok("TrackingSettingsResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/tracking/script": {
      parameters: [siteParam],
      get: op({
        operationId: "getTrackingScript",
        summary: "Get tracking script",
        description: "Returns the script URL and HTML snippet.",
        tags: ["Settings"],
        responses: {
          "200": ok("TrackingScriptResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/privacy": {
      parameters: [siteParam],
      get: op({
        operationId: "getPrivacySettings",
        summary: "Get privacy settings",
        description: "Returns privacy settings.",
        tags: ["Settings"],
        responses: {
          "200": ok("PrivacySettingsResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
      patch: op({
        operationId: "updatePrivacySettings",
        summary: "Update privacy settings",
        description: "Updates privacy settings.",
        tags: ["Settings"],
        requestBody: requestBody("PrivacySettings"),
        responses: {
          "200": ok("PrivacySettingsResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/sharing": {
      parameters: [siteParam],
      get: op({
        operationId: "getSharingSettings",
        summary: "Get sharing settings",
        description: "Returns sharing settings.",
        tags: ["Settings"],
        responses: {
          "200": ok("SharingSettingsResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
      patch: op({
        operationId: "updateSharingSettings",
        summary: "Update sharing settings",
        description: "Updates sharing settings.",
        tags: ["Settings"],
        requestBody: requestBody("SharingSettings"),
        responses: {
          "200": ok("SharingSettingsResponse"),
          ...errorResponses("400", "401", "403", "404", "409"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/analytics/schema": {
      parameters: [siteParam],
      get: op({
        operationId: "getAnalyticsSchema",
        summary: "Get analytics schema",
        description:
          "Returns metrics, dimensions, filters, operators, intervals, and presets.",
        tags: ["Analytics"],
        responses: {
          "200": ok("AnalyticsSchemaResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/analytics/overview": {
      parameters: [siteParam],
      get: op({
        operationId: "getAnalyticsOverview",
        summary: "Get analytics overview",
        description: "Returns aggregate analytics metrics.",
        tags: ["Analytics"],
        parameters: [...timeParams(), filterParam(), metricParam()],
        responses: {
          "200": ok("AnalyticsOverviewResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/analytics/timeseries": {
      parameters: [siteParam],
      get: op({
        operationId: "getAnalyticsTimeseries",
        summary: "Get analytics time series",
        description: "Returns time-bucketed analytics metrics.",
        tags: ["Analytics"],
        parameters: [...timeParams(true), filterParam(), metricParam()],
        responses: {
          "200": ok("AnalyticsTimeseriesResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/analytics/breakdowns/{dimension}": {
      parameters: [siteParam, dimensionParam],
      get: op({
        operationId: "getAnalyticsBreakdown",
        summary: "Get analytics breakdown",
        description: "Returns a metric breakdown by dimension.",
        tags: ["Analytics"],
        parameters: [
          ...timeParams(),
          filterParam(),
          metricParam(),
          queryParam(
            "limit",
            { type: "integer", minimum: 1, maximum: 1000, default: 20 },
            "Maximum rows.",
          ),
        ],
        responses: {
          "200": ok("AnalyticsBreakdownResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/analytics/cross-breakdowns": {
      parameters: [siteParam],
      get: op({
        operationId: "getAnalyticsCrossBreakdown",
        summary: "Get analytics cross breakdown",
        description:
          "Returns a two-dimensional analytics breakdown. Supports page, referrer, UTM, client, and geo dimensions. Session and event dimensions are not supported.",
        tags: ["Analytics"],
        parameters: [
          ...timeParams(),
          filterParam(),
          queryParam(
            "primary",
            { type: "string", maxLength: 120 },
            "Primary dimension (e.g. client.browser, geo.country, page.path).",
          ),
          queryParam(
            "secondary",
            { type: "string", maxLength: 120 },
            "Secondary dimension (must differ from primary).",
          ),
          queryParam(
            "metric",
            { type: "string", maxLength: 80 },
            "Metric to aggregate.",
          ),
        ],
        responses: {
          "200": ok("AnalyticsCrossBreakdownResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/analytics/compare": {
      parameters: [siteParam],
      get: op({
        operationId: "compareAnalytics",
        summary: "Compare analytics",
        description: "Compares analytics against another period.",
        tags: ["Analytics"],
        parameters: [
          ...timeParams(),
          filterParam(),
          queryParam(
            "compare",
            { type: "string", maxLength: 80, default: "previous_period" },
            "Comparison mode.",
          ),
        ],
        responses: {
          "200": ok("AnalyticsCompareResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/analytics/explore": {
      parameters: [siteParam],
      post: op({
        operationId: "exploreAnalytics",
        summary: "Explore analytics",
        description:
          "Runs an advanced multidimensional query with complex filters.",
        tags: ["Analytics"],
        requestBody: requestBody("AnalyticsExploreRequest"),
        responses: {
          "200": ok("AnalyticsExploreResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/analytics/retention/cohorts": {
      parameters: [siteParam],
      get: op({
        operationId: "getRetentionCohorts",
        summary: "Get retention cohorts",
        description: "Returns visitor retention cohorts.",
        tags: ["Analytics"],
        parameters: [...timeParams(true), filterParam()],
        responses: {
          "200": ok("RetentionCohortsResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/event-types": {
      parameters: [siteParam],
      get: op({
        operationId: "listEventTypes",
        summary: "List event types",
        description: "Lists custom event types.",
        tags: ["Events"],
        parameters: [
          ...timeParams(),
          queryParam(
            "limit",
            { type: "integer", minimum: 1, maximum: 1000 },
            "Maximum rows.",
          ),
        ],
        responses: {
          "200": ok("AnalyticsBreakdownResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/event-types/{eventName}": {
      parameters: [siteParam, eventNameParam],
      get: op({
        operationId: "getEventType",
        summary: "Get event type",
        description: "Returns details for one event type.",
        tags: ["Events"],
        parameters: timeParams(true),
        responses: {
          "200": ok("EventTypeResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/events": {
      parameters: [siteParam],
      get: op({
        operationId: "listEvents",
        summary: "List events",
        description: "Lists event records with cursor pagination.",
        tags: ["Events"],
        parameters: [
          ...timeParams(),
          filterParam(),
          ...cursorParams(),
          sortParam(),
          queryParam(
            "eventName",
            { type: "string", maxLength: 120 },
            "Event name filter.",
          ),
        ],
        responses: {
          "200": ok("EventListResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/events/summary": {
      parameters: [siteParam],
      get: op({
        operationId: "getEventsSummary",
        summary: "Get events summary",
        description: "Returns event summary metrics.",
        tags: ["Events"],
        parameters: [...timeParams(), filterParam()],
        responses: {
          "200": ok("EventsSummaryResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/events/timeseries": {
      parameters: [siteParam],
      get: op({
        operationId: "getEventsTimeseries",
        summary: "Get events time series",
        description: "Returns event counts over time.",
        tags: ["Events"],
        parameters: [
          ...timeParams(true),
          filterParam(),
          queryParam(
            "eventName",
            { type: "string", maxLength: 120 },
            "Event name filter.",
          ),
        ],
        responses: {
          "200": ok("AnalyticsTimeseriesResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/events/search": {
      parameters: [siteParam],
      post: op({
        operationId: "searchEvents",
        summary: "Search events",
        description: "Searches events using complex payload filters.",
        tags: ["Events"],
        requestBody: requestBody("EventSearchRequest"),
        responses: {
          "200": ok("EventListResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/events/{eventId}": {
      parameters: [siteParam, eventIdParam],
      get: op({
        operationId: "getEvent",
        summary: "Get event",
        description: "Returns one event record.",
        tags: ["Events"],
        responses: {
          "200": ok("EventResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/event-fields/values": {
      parameters: [siteParam],
      get: op({
        operationId: "getEventFieldValues",
        summary: "Get event field values",
        description: "Returns observed values for an event field.",
        tags: ["Events"],
        parameters: [
          ...timeParams(),
          queryParam(
            "eventName",
            { type: "string", maxLength: 120 },
            "Event name.",
          ),
          queryParam(
            "fieldPath",
            { type: "string", maxLength: 240 },
            "Field path.",
          ),
          queryParam(
            "fieldValueType",
            {
              type: "string",
              enum: ["string", "number", "boolean", "null", "object", "array"],
            },
            "Expected value type for the field.",
          ),
          queryParam(
            "search",
            { type: "string", maxLength: 160 },
            "Search text.",
          ),
        ],
        responses: {
          "200": ok("AnalyticsBreakdownResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/visitors": {
      parameters: [siteParam],
      get: op({
        operationId: "listVisitors",
        summary: "List visitors",
        description: "Lists visitors with cursor pagination.",
        tags: ["Visitors"],
        parameters: [
          ...timeParams(),
          filterParam(),
          ...cursorParams(),
          sortParam(),
          queryParam(
            "search",
            { type: "string", maxLength: 160 },
            "Search text.",
          ),
        ],
        responses: {
          "200": ok("VisitorListResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/visitors/{visitorId}": {
      parameters: [siteParam, visitorIdParam],
      get: op({
        operationId: "getVisitor",
        summary: "Get visitor",
        description: "Returns one visitor.",
        tags: ["Visitors"],
        responses: {
          "200": ok("VisitorResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/visitors/{visitorId}/sessions": {
      parameters: [siteParam, visitorIdParam],
      get: op({
        operationId: "listVisitorSessions",
        summary: "List visitor sessions",
        description: "Lists sessions for a visitor.",
        tags: ["Visitors"],
        parameters: [...timeParams(), ...cursorParams()],
        responses: {
          "200": ok("SessionListResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/visitors/{visitorId}/events": {
      parameters: [siteParam, visitorIdParam],
      get: op({
        operationId: "listVisitorEvents",
        summary: "List visitor events",
        description: "Lists events for a visitor.",
        tags: ["Visitors"],
        parameters: [...timeParams(), ...cursorParams()],
        responses: {
          "200": ok("EventListResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/sessions": {
      parameters: [siteParam],
      get: op({
        operationId: "listSessions",
        summary: "List sessions",
        description: "Lists sessions with cursor pagination.",
        tags: ["Sessions"],
        parameters: [
          ...timeParams(),
          filterParam(),
          ...cursorParams(),
          sortParam(),
          queryParam(
            "search",
            { type: "string", maxLength: 160 },
            "Search text.",
          ),
        ],
        responses: {
          "200": ok("SessionListResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/sessions/{sessionId}": {
      parameters: [siteParam, sessionIdParam],
      get: op({
        operationId: "getSession",
        summary: "Get session",
        description: "Returns one session.",
        tags: ["Sessions"],
        responses: {
          "200": ok("SessionResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/sessions/{sessionId}/events": {
      parameters: [siteParam, sessionIdParam],
      get: op({
        operationId: "listSessionEvents",
        summary: "List session events",
        description: "Lists events for a session.",
        tags: ["Sessions"],
        parameters: [...timeParams(), ...cursorParams()],
        responses: {
          "200": ok("EventListResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/funnels": {
      parameters: [siteParam],
      get: op({
        operationId: "listFunnels",
        summary: "List funnels",
        description: "Lists saved funnels.",
        tags: ["Funnels"],
        parameters: timeParams(),
        responses: {
          "200": ok("FunnelListResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
      post: op({
        operationId: "createFunnel",
        summary: "Create funnel",
        description: "Creates a saved funnel.",
        tags: ["Funnels"],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            schema: { type: "string", maxLength: 200 },
            description: "Client-generated idempotency key.",
          },
        ],
        requestBody: requestBody("FunnelCreateInput"),
        responses: {
          "201": ok("FunnelResponse", "Created funnel"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/funnels/analysis": {
      parameters: [siteParam],
      post: op({
        operationId: "analyzeFunnel",
        summary: "Analyze funnel",
        description: "Runs ad-hoc funnel analysis.",
        tags: ["Funnels"],
        requestBody: requestBody("FunnelAnalysisRequest"),
        responses: {
          "200": ok("FunnelAnalysisResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/funnels/{funnelId}": {
      parameters: [siteParam, { $ref: "#/components/parameters/funnelId" }],
      get: op({
        operationId: "getFunnel",
        summary: "Get funnel",
        description: "Returns one saved funnel.",
        tags: ["Funnels"],
        responses: {
          "200": ok("FunnelResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
      patch: op({
        operationId: "updateFunnel",
        summary: "Update funnel",
        description: "Updates one saved funnel.",
        tags: ["Funnels"],
        requestBody: requestBody("FunnelUpdateInput"),
        responses: {
          "200": ok("FunnelResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
      delete: op({
        operationId: "deleteFunnel",
        summary: "Delete funnel",
        description: "Deletes one saved funnel.",
        tags: ["Funnels"],
        responses: {
          "204": { description: "No Content" },
          ...errorResponses("401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/funnels/{funnelId}/analysis": {
      parameters: [siteParam, { $ref: "#/components/parameters/funnelId" }],
      get: op({
        operationId: "getFunnelAnalysis",
        summary: "Get funnel analysis",
        description: "Runs analysis for a saved funnel.",
        tags: ["Funnels"],
        parameters: timeParams(),
        responses: {
          "200": ok("SavedFunnelAnalysisResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/performance/summary": {
      parameters: [siteParam],
      get: op({
        operationId: "getPerformanceSummary",
        summary: "Get performance summary",
        description:
          "Returns Core Web Vitals summary in milliseconds except CLS.",
        tags: ["Performance"],
        parameters: [...timeParams(), filterParam()],
        responses: {
          "200": ok("PerformanceSummaryResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/performance/timeseries": {
      parameters: [siteParam],
      get: op({
        operationId: "getPerformanceTimeseries",
        summary: "Get performance time series",
        description: "Returns Core Web Vitals over time.",
        tags: ["Performance"],
        parameters: [...timeParams(true), filterParam()],
        responses: {
          "200": ok("PerformanceTimeseriesResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/performance/breakdowns/{dimension}": {
      parameters: [siteParam, dimensionParam],
      get: op({
        operationId: "getPerformanceBreakdown",
        summary: "Get performance breakdown",
        description: "Breaks down Core Web Vitals by dimension.",
        tags: ["Performance"],
        parameters: [
          ...timeParams(),
          filterParam(),
          queryParam(
            "metric",
            { type: "string", enum: ["ttfb", "fcp", "lcp", "cls", "inp"] },
            "Performance metric.",
          ),
        ],
        responses: {
          "200": ok("PerformanceBreakdownResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/realtime/active-visitors": {
      parameters: [siteParam],
      get: op({
        operationId: "getRealtimeActiveVisitors",
        summary: "Get active visitors",
        description: "Returns the current active visitor count.",
        tags: ["Realtime"],
        responses: {
          "200": ok("ActiveVisitorsResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/realtime/events": {
      parameters: [siteParam],
      get: op({
        operationId: "getRealtimeEvents",
        summary: "Get realtime events",
        description: "Returns recent realtime events.",
        tags: ["Realtime"],
        parameters: [
          queryParam(
            "limit",
            { type: "integer", minimum: 1, maximum: 1000 },
            "Maximum events.",
          ),
        ],
        responses: {
          "200": ok("RealtimeEventListResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/realtime/sessions": {
      parameters: [siteParam],
      get: op({
        operationId: "getRealtimeSessions",
        summary: "Get realtime sessions",
        description: "Returns recent realtime sessions.",
        tags: ["Realtime"],
        parameters: [
          queryParam(
            "limit",
            { type: "integer", minimum: 1, maximum: 1000 },
            "Maximum sessions.",
          ),
        ],
        responses: {
          "200": ok("RealtimeSessionListResponse"),
          ...errorResponses("400", "401", "403", "404"),
        },
      }),
    },
    "/api/v1/sites/{siteId}/realtime/snapshot": {
      parameters: [siteParam],
      get: op({
        operationId: "getRealtimeSnapshot",
        summary: "Get realtime snapshot",
        description:
          "Returns active visitors, recent events, and recent sessions.",
        tags: ["Realtime"],
        responses: {
          "200": ok("RealtimeSnapshotResponse"),
          ...errorResponses("401", "403", "404"),
        },
      }),
    },
    "/api/v1/batch": {
      post: op({
        operationId: "batch",
        summary: "Execute global batch",
        description: "Executes up to 20 GET subrequests under /api/v1.",
        tags: ["Batch"],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            schema: { type: "string", maxLength: 200 },
            description: "Client-generated idempotency key.",
          },
        ],
        requestBody: requestBody("BatchRequest"),
        responses: {
          "200": ok("BatchResponse"),
          ...errorResponses("400", "401"),
        },
      }),
    },
  };
}

function responseExampleFor(schemaName: string | null, operationId: string) {
  const operationExamples: Record<string, unknown> = {
    getTeamAnalyticsSites: list(
      [
        {
          key: sampleSiteId,
          label: "Example Blog",
          views: 5200,
          sessions: 3200,
          visitors: 2600,
        },
        {
          key: "550e8400-e29b-41d4-a716-446655440010",
          label: "Docs Site",
          views: 3100,
          sessions: 1900,
          visitors: 1500,
        },
      ],
      { timeRange: sampleTimeRange },
    ),
    listEventTypes: list(
      [
        {
          key: "signup",
          label: "Signup",
          events: 450,
          sessions: 210,
          visitors: 190,
        },
        {
          key: "purchase",
          label: "Purchase",
          events: 80,
          sessions: 70,
          visitors: 65,
        },
      ],
      { timeRange: sampleTimeRange },
    ),
    getEventType: success({
      name: "signup",
      label: "Signup",
      events: 450,
      sessions: 210,
      visitors: 190,
      avgEventsPerSession: 2.14,
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: sampleGeneratedAt,
      fields: [
        { path: "plan", valueTypes: ["string"], examples: ["free", "pro"] },
        {
          path: "source",
          valueTypes: ["string"],
          examples: ["pricing_page", "header_cta"],
        },
      ],
      links: {
        events: `/api/v1/sites/${sampleSiteId}/events?eventName=signup`,
        fieldValues: `/api/v1/sites/${sampleSiteId}/event-fields/values?eventName=signup`,
      },
    }),
  };
  const examples: Record<string, unknown> = {
    HealthResponse: { status: "healthy", timestamp: sampleGeneratedAt },
    RootDiscoveryResponse: success({
      version: "1.0.0",
      service: "InsightFlare Analytics API",
      links: {
        self: "/api/v1",
        openapi: "/.well-known/openapi.json",
        skills: "/.well-known/skills.json",
        token: "/api/v1/token",
        capabilities: "/api/v1/capabilities",
        sites: "/api/v1/sites",
      },
    }),
    TokenResponse: success({
      id: sampleTokenId,
      name: "Production API key",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: null,
      lastUsedAt: sampleGeneratedAt,
      team: { id: sampleTeamId, name: "Example Team" },
      scopes: ["site:read", "site_config:read", "analytics:read"],
      siteAccess: { mode: "all", siteIds: [] },
    }),
    TokenCheckResponse: success({
      checks: [
        { scope: "analytics:read", siteId: sampleSiteId, allowed: true },
      ],
    }),
    CapabilitiesResponse: success({
      apiVersion: "1.0.0",
      features: {
        sites: true,
        tracking: true,
        privacy: true,
        sharing: true,
        analytics: true,
        events: true,
        visitors: true,
        sessions: true,
        funnels: true,
        performance: true,
        realtime: true,
        exports: false,
        batch: true,
      },
      limits: {
        batchMaxRequests: 20,
        defaultTimeRangeDays: 7,
        maxTimeRangeDays: 365,
        defaultPageLimit: 100,
        maxPageLimit: 1000,
      },
      links: {
        token: "/api/v1/token",
        sites: "/api/v1/sites",
        batch: "/api/v1/batch",
      },
    }),
    TeamResponse: success({
      id: sampleTeamId,
      name: "Example Team",
      createdAt: "2026-01-01T00:00:00Z",
      links: {
        usage: "/api/v1/team/usage",
        sites: "/api/v1/sites",
        analyticsOverview: "/api/v1/team/analytics/overview",
      },
    }),
    TeamUsageResponse: success({ sites: 3 }),
    SiteResponse: success(siteExample),
    SiteListResponse: list([siteExample]),
    TrackingSettingsResponse: success({
      trackPageviews: true,
      trackQuery: false,
      trackHash: true,
      trackCustomEvents: true,
      trackEngagement: true,
      trackWebVitals: true,
      autoTrackOutboundLinks: true,
      trackingStrength: "smart",
      allowedDomains: ["example.com"],
      excludedPaths: ["/admin"],
    }),
    TrackingScriptResponse: success({
      siteId: sampleSiteId,
      src: "https://insight.ravelloh.com/script.js?siteId=550e8400-e29b-41d4-a716-446655440000",
      snippet:
        '<script async src="https://insight.ravelloh.com/script.js?siteId=550e8400-e29b-41d4-a716-446655440000"></script>',
    }),
    PrivacySettingsResponse: success({
      respectDoNotTrack: true,
      anonymizeIp: true,
      euMode: false,
      visitorTokenMode: "daily",
      dataRetentionDays: 180,
    }),
    SharingSettingsResponse: success({
      publicEnabled: true,
      publicSlug: "example-blog",
    }),
    AnalyticsSchemaResponse: success({
      metrics: [
        {
          key: "views",
          label: "Views",
          type: "integer",
          description: "Total page views.",
        },
        {
          key: "bounceRate",
          label: "Bounce rate",
          type: "rate",
          description: "Single-page session rate as a 0-1 ratio.",
        },
      ],
      dimensions: [
        { key: "page.path", label: "Page path", type: "string" },
        { key: "geo.country", label: "Country", type: "string" },
      ],
      filters: ["page.path", "geo.country"],
      operators: ["eq", "in", "startsWith"],
      intervals: ["hour", "day", "week"],
      presets: ["last_7_days", "last_30_days"],
      timeRange: {
        earliestAvailableAt: "2026-01-01T00:00:00Z",
        latestAvailableAt: sampleGeneratedAt,
      },
      links: {
        overview: `/api/v1/sites/${sampleSiteId}/analytics/overview`,
        timeseries: `/api/v1/sites/${sampleSiteId}/analytics/timeseries`,
      },
    }),
    AnalyticsOverviewResponse: success(overviewMetricsExample, {
      timeRange: sampleTimeRange,
    }),
    AnalyticsTimeseriesResponse: list(
      [
        {
          start: "2026-06-26T00:00:00Z",
          end: "2026-06-27T00:00:00Z",
          views: 420,
          sessions: 260,
          visitors: 210,
          events: 38,
        },
      ],
      { timeRange: sampleTimeRange, interval: "day" },
    ),
    AnalyticsBreakdownResponse: list(
      [
        { key: "__direct__", label: "Direct", views: 5200, sessions: 3200 },
        { key: "__unknown__", label: "Unknown", views: 120, sessions: 88 },
      ],
      { timeRange: sampleTimeRange },
    ),
    AnalyticsCrossBreakdownResponse: {
      data: [
        {
          primaryKey: "US",
          primaryLabel: "United States",
          values: [
            { secondaryKey: "Chrome", secondaryLabel: "Chrome", value: 4200 },
          ],
        },
      ],
      meta: meta({
        timeRange: sampleTimeRange,
        primary: "geo.country",
        secondary: "client.browser",
        metric: "views",
      }),
    },
    AnalyticsCompareResponse: success({
      current: overviewMetricsExample,
      previous: { ...overviewMetricsExample, views: 11000, sessions: 7600 },
      change: { views: 0.136, sessions: 0.092 },
    }),
    AnalyticsExploreResponse: success(
      {
        rows: [{ "page.path": "/pricing", "geo.country": "US", views: 850 }],
        metrics: ["views"],
        dimensions: ["page.path", "geo.country"],
        filters: [{ field: "page.path", op: "startsWith", value: "/pricing" }],
      },
      { timeRange: sampleTimeRange },
    ),
    RetentionCohortsResponse: success({
      interval: "day",
      cohorts: [
        {
          start: "2026-06-01T00:00:00Z",
          size: 1000,
          periods: [
            { index: 0, visitors: 1000, rate: 1 },
            { index: 1, visitors: 340, rate: 0.34 },
          ],
        },
      ],
    }),
    EventsSummaryResponse: success({
      events: 450,
      eventTypes: 8,
      sessions: 210,
      visitors: 190,
      avgEventsPerSession: 2.14,
    }),
    EventListResponse: paginated([eventExample]),
    EventResponse: success(eventExample),
    VisitorListResponse: paginated([visitorExample]),
    VisitorResponse: success(visitorExample),
    SessionListResponse: paginated([sessionExample]),
    SessionResponse: success(sessionExample),
    FunnelListResponse: list([funnelExample]),
    FunnelResponse: success(funnelExample),
    FunnelAnalysisResponse: success(funnelAnalysisExample, {
      timeRange: sampleTimeRange,
    }),
    SavedFunnelAnalysisResponse: success(
      { funnel: funnelExample, analysis: funnelAnalysisExample },
      { timeRange: sampleTimeRange },
    ),
    PerformanceSummaryResponse: success({
      ttfb: 120,
      fcp: 820,
      lcp: 1800,
      cls: 0.04,
      inp: 140,
    }),
    PerformanceTimeseriesResponse: list(
      [
        {
          start: "2026-06-26T00:00:00Z",
          end: "2026-06-27T00:00:00Z",
          ttfb: 120,
          fcp: 820,
          lcp: 1800,
          cls: 0.04,
          inp: 140,
        },
      ],
      { timeRange: sampleTimeRange, interval: "day" },
    ),
    PerformanceBreakdownResponse: list([
      { key: "/pricing", label: "/pricing", lcp: 1800, cls: 0.04 },
    ]),
    ActiveVisitorsResponse: success({ activeVisitors: 12 }),
    RealtimeEventListResponse: list([eventExample]),
    RealtimeSessionListResponse: list([sessionExample]),
    RealtimeSnapshotResponse: success({
      activeVisitors: 12,
      events: [eventExample],
      sessions: [sessionExample],
    }),
    BatchResponse: success({
      responses: [
        { id: "overview", status: 200, body: success(overviewMetricsExample) },
        { id: "countries", status: 200, body: list([]) },
      ],
    }),
  };

  return {
    summary: operationId,
    value:
      operationExamples[operationId] ||
      (schemaName && examples[schemaName]) ||
      success({ message: "Successful response" }),
  };
}

function requestExamplesFor(schemaName: string | null) {
  const examples: Record<string, Record<string, unknown>> = {
    TokenCheckRequest: {
      default: {
        summary: "Check analytics permission",
        value: {
          checks: [{ scope: "analytics:read", siteId: sampleSiteId }],
        },
      },
    },
    SiteCreateInput: {
      default: {
        summary: "Create a site",
        value: {
          name: "Example Blog",
          domain: "example.com",
          sharing: { publicEnabled: true, publicSlug: "example-blog" },
        },
      },
    },
    SiteUpdateInput: {
      default: {
        summary: "Update a site",
        value: {
          name: "Example Blog",
          sharing: { publicEnabled: false, publicSlug: null },
        },
      },
    },
    TrackingSettings: {
      default: {
        summary: "Update tracking settings",
        value: {
          trackQuery: false,
          trackHash: true,
          trackWebVitals: true,
          trackingStrength: "smart",
          allowedDomains: ["example.com"],
          excludedPaths: ["/admin"],
        },
      },
    },
    PrivacySettings: {
      default: {
        summary: "Update privacy settings",
        value: { respectDoNotTrack: true, euMode: false },
      },
    },
    SharingSettings: {
      default: {
        summary: "Update sharing settings",
        value: { publicEnabled: true, publicSlug: "example-blog" },
      },
    },
    AnalyticsExploreRequest: {
      default: {
        summary: "Explore pages by country",
        value: {
          timeRange: sampleTimeRange,
          metrics: ["views"],
          dimensions: ["page.path", "geo.country"],
          filters: [
            { field: "page.path", op: "startsWith", value: "/pricing" },
            { field: "geo.country", op: "in", value: ["US", "CA"] },
          ],
          limit: 100,
        },
      },
    },
    EventSearchRequest: {
      default: {
        summary: "Search signup events",
        value: {
          timeRange: sampleTimeRange,
          eventName: "signup",
          payloadFilters: [{ path: "plan", op: "eq", value: "pro" }],
          filters: [{ field: "page.path", op: "startsWith", value: "/signup" }],
          limit: 100,
        },
      },
    },
    FunnelCreateInput: {
      default: {
        summary: "Create signup funnel",
        value: {
          name: "Signup funnel",
          description: "Pricing page to signup conversion.",
          steps: funnelExample.steps,
        },
      },
    },
    FunnelUpdateInput: {
      default: {
        summary: "Update signup funnel",
        value: {
          name: "Updated signup funnel",
          steps: funnelExample.steps,
        },
      },
    },
    FunnelAnalysisRequest: {
      default: {
        summary: "Analyze an ad-hoc funnel",
        value: {
          steps: funnelExample.steps,
        },
      },
    },
    BatchRequest: {
      default: {
        summary: "Batch overview and country breakdown",
        value: {
          requests: [
            {
              id: "overview",
              method: "GET",
              path: `/api/v1/sites/${sampleSiteId}/analytics/overview`,
              query: { preset: "last_30_days" },
            },
            {
              id: "countries",
              method: "GET",
              path: `/api/v1/sites/${sampleSiteId}/analytics/breakdowns/geo.country`,
              query: { preset: "last_30_days", metrics: "views,sessions" },
            },
          ],
        },
      },
    },
    CollectPayload: {
      pageview: {
        summary: "Pageview payload",
        value: {
          siteId: sampleSiteId,
          type: "pageview",
          timestamp: sampleGeneratedAt,
          anonymousId: "anon_abc123",
          sessionId: "sess_abc123",
          page: {
            url: "https://example.com/posts/hello",
            path: "/posts/hello",
            title: "Hello",
            referrer: "https://google.com",
            hostname: "example.com",
          },
          client: {
            language: "zh-CN",
            screen: { width: 1920, height: 1080 },
            viewport: { width: 1280, height: 720 },
          },
        },
      },
      event: {
        summary: "Custom event payload",
        value: {
          siteId: sampleSiteId,
          type: "event",
          timestamp: "2026-06-26T12:01:00Z",
          anonymousId: "anon_abc123",
          sessionId: "sess_abc123",
          page: {
            url: "https://example.com/signup",
            path: "/signup",
            title: "Signup",
          },
          event: {
            name: "signup",
            data: { plan: "pro", source: "pricing_page" },
          },
        },
      },
    },
  };
  return schemaName ? examples[schemaName] : undefined;
}

function enrichSpecWithExamples(spec: OpenAPISpec) {
  for (const pathItem of Object.values(spec.paths)) {
    for (const method of ["get", "post", "patch", "delete"] as const) {
      const operation = pathItem[method];
      if (!operation) continue;
      const bodyContent = jsonContent(operation.requestBody);
      if (bodyContent?.schema && !bodyContent.examples) {
        const examples = requestExamplesFor(schemaRefName(bodyContent.schema));
        if (examples) bodyContent.examples = examples;
      }
      for (const [status, responseObject] of Object.entries(
        operation.responses,
      )) {
        const content = jsonContent(responseObject);
        if (!content?.schema || content.examples || content.example) continue;
        if (!["200", "201"].includes(status)) continue;
        const schemaName = schemaRefName(content.schema);
        content.examples = {
          default: responseExampleFor(schemaName, operation.operationId),
        };
      }
    }
  }
}

function buildSpec(): OpenAPISpec {
  const errorContent = {
    content: {
      [json]: {
        schema: ref("ErrorResponse"),
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "InsightFlare API",
      description:
        "Privacy-focused web analytics API. Authenticated endpoints require an API key passed as a Bearer token in the Authorization header. All API times are ISO 8601 strings and analytics ranges use [from, to) semantics. If from, to, and preset are omitted, analytics endpoints default to the last 7 days ending at request time. The default timeZone is UTC.",
      version: "1.0.0",
      contact: {
        name: "InsightFlare",
        url: "https://github.com/ravelloh/InsightFlare",
      },
      license: {
        name: "MIT",
        url: "https://github.com/ravelloh/InsightFlare/blob/main/LICENSE",
      },
    },
    servers: [
      { url: "https://insight.ravelloh.com", description: "Production" },
    ],
    security: [{ BearerAuth: [] }],
    tags: [
      { name: "Discovery", description: "API discovery and capabilities" },
      { name: "Token", description: "Token introspection" },
      { name: "Team", description: "Current team resources" },
      { name: "Sites", description: "Site resources" },
      {
        name: "Settings",
        description: "Tracking, privacy, and sharing settings",
      },
      { name: "Analytics", description: "Analytics data primitives" },
      { name: "Events", description: "Event resources" },
      { name: "Visitors", description: "Visitor resources" },
      { name: "Sessions", description: "Session resources" },
      { name: "Funnels", description: "Funnel resources and analysis" },
      { name: "Performance", description: "Core Web Vitals performance data" },
      { name: "Realtime", description: "Realtime activity" },
      { name: "Batch", description: "Global batch requests" },
      { name: "Ingestion", description: "Client SDK event collection" },
      { name: "Health", description: "Health checks" },
    ],
    paths: buildPaths(),
    components: {
      schemas: buildSchemas(),
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "API key passed as a Bearer token in the Authorization header.",
        },
      },
      parameters: {
        siteId: {
          name: "siteId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "Site UUID.",
        },
        dimension: {
          name: "dimension",
          in: "path",
          required: true,
          schema: { type: "string", maxLength: 120 },
          description: "Stable analytics dimension key.",
        },
        eventName: {
          name: "eventName",
          in: "path",
          required: true,
          schema: { type: "string", maxLength: 120 },
          description: "Event name.",
        },
        eventId: {
          name: "eventId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "Event UUID.",
        },
        visitorId: {
          name: "visitorId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "Visitor UUID.",
        },
        sessionId: {
          name: "sessionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "Session UUID.",
        },
        funnelId: {
          name: "funnelId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "Funnel UUID.",
        },
      },
      responses: {
        BadRequest: { description: "Bad request", ...errorContent },
        Unauthorized: { description: "Authentication failed", ...errorContent },
        Forbidden: { description: "Insufficient permissions", ...errorContent },
        NotFound: { description: "Resource not found", ...errorContent },
        Conflict: { description: "Conflict", ...errorContent },
        PayloadTooLarge: { description: "Payload too large", ...errorContent },
        InternalError: { description: "Internal error", ...errorContent },
      },
    },
  };
}

function main() {
  const spec = buildSpec();
  enrichSpecWithExamples(spec);
  const root = resolve(import.meta.dirname, "..");
  const yamlPath = resolve(root, "docs", "openapi.yaml");
  const jsonPath = resolve(root, "docs", "openapi.json");

  writeFileSync(yamlPath, YAML.stringify(spec, { indent: 2 }), "utf8");
  writeFileSync(jsonPath, JSON.stringify(spec, null, 2), "utf8");

  try {
    execSync(`npx prettier --write "${yamlPath}" "${jsonPath}"`, {
      stdio: "pipe",
    });
  } catch {
    // Files are valid even if formatting fails.
  }

  console.log(`Generated ${yamlPath}`);
  console.log(`Generated ${jsonPath}`);
}

main();
