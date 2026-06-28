import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

type JsonContent = {
  schema?: { $ref?: string };
  example?: unknown;
  examples?: Record<string, unknown>;
};

type OperationObject = {
  operationId?: string;
  requestBody?: { content?: { "application/json"?: JsonContent } };
  responses?: Record<
    string,
    { content?: { "application/json"?: JsonContent } }
  >;
  parameters?: unknown[];
};

type OpenApiSpec = {
  paths: Record<string, Record<string, OperationObject>>;
  components: { schemas: Record<string, JsonSchemaObject> };
};

type JsonSchemaObject = {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  required?: string[];
  properties?: Record<string, JsonSchemaObject>;
  items?: JsonSchemaObject;
  $ref?: string;
  additionalProperties?: boolean | JsonSchemaObject;
};

function defaultExampleValue(operation?: OperationObject): unknown {
  const content = operation?.responses?.["200"]?.content?.["application/json"];
  const examples = Object.values(content?.examples ?? {});
  const first = examples[0];
  return first && typeof first === "object" && "value" in first
    ? (first as { value: unknown }).value
    : content?.example;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as T;
}

function walk(value: unknown, visit: (value: unknown) => void) {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) walk(item, visit);
  }
}

function pathMatchesTemplate(template: string, path: string): boolean {
  const regex = new RegExp(
    `^${template
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\{[^/]+\\\}/g, "[^/]+")}$`,
  );
  return regex.test(path);
}

describe("api v1 public docs", () => {
  it("generates an OpenAPI contract without deprecated public API shapes", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");
    const raw = JSON.stringify(spec);

    expect(raw).not.toContain("queryName");
    expect(raw).not.toContain("/analytics/{queryName}");
    expect(raw).not.toContain('"ok"');
    expect(raw).not.toContain("Unix milliseconds");
    expect(raw).not.toContain("Unix ms");
    expect(raw).not.toContain("pageSize");
    expect(raw).not.toContain("sortBy");
    expect(raw).not.toContain("sortDir");
    expect(raw).not.toContain("ifk_live_");
    expect(raw).not.toContain("RateLimit");

    expect(
      Object.keys(spec.components.schemas).some((name) => name.includes("___")),
    ).toBe(false);
    expect(spec.components.schemas.ErrorResponse).toBeDefined();
    expect(spec.components.schemas.PaginatedEnvelope).toBeDefined();
    expect(spec.paths["/api/v1/sites/{siteId}/analytics/schema"]).toBeDefined();
    expect(spec.paths["/api/v1/batch"]).toBeDefined();
    expect(spec.paths["/api/v1/sites/{siteId}/config"]).toBeUndefined();
    expect(spec.paths["/api/v1/sites/{siteId}/script-snippet"]).toBeUndefined();

    const operationIds: string[] = [];
    for (const item of Object.values(spec.paths)) {
      for (const operation of Object.values(item)) {
        if (
          operation &&
          typeof operation === "object" &&
          "operationId" in operation
        ) {
          operationIds.push(String(operation.operationId));
        }
      }
    }
    expect(new Set(operationIds).size).toBe(operationIds.length);

    let errorResponseRefs = 0;
    let paginatedRefs = 0;
    walk(spec, (value) => {
      if (!value || typeof value !== "object" || !("$ref" in value)) return;
      const ref = String((value as { $ref: string }).$ref);
      if (ref.endsWith("/ErrorResponse")) errorResponseRefs += 1;
      if (ref.endsWith("/PaginatedEnvelope")) paginatedRefs += 1;
    });
    expect(errorResponseRefs).toBeGreaterThan(0);
    expect(paginatedRefs).toBeGreaterThan(0);
  });

  it("generates a skills manifest for agents rather than an endpoint catalog", () => {
    const manifest = readJson<{
      openapiUrl?: string;
      discovery?: Record<string, string>;
      taskRecipes?: unknown[];
      endpoints?: unknown;
    }>("docs/skills.json");
    const raw = JSON.stringify(manifest);

    expect(manifest.openapiUrl).toBe("/.well-known/openapi.json");
    expect(manifest.discovery).toMatchObject({
      root: "/api/v1",
      token: "/api/v1/token",
      capabilities: "/api/v1/capabilities",
      analyticsSchema: "/api/v1/sites/{siteId}/analytics/schema",
    });
    expect(Array.isArray(manifest.taskRecipes)).toBe(true);
    expect(manifest.endpoints).toBeUndefined();
    expect(raw).not.toContain("queryName");
    expect(raw).not.toContain("Unix milliseconds");
    expect(raw).not.toContain('"ok"');
    expect(raw).not.toContain("overview?compare=previous_period");
  });

  it("keeps OpenAPI request bodies and key responses concrete", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");

    const bodySchema = (method: string, path: string) =>
      spec.paths[path]?.[method]?.requestBody?.content?.["application/json"]
        ?.schema?.$ref;
    const responseSchema = (method: string, path: string, status = "200") =>
      spec.paths[path]?.[method]?.responses?.[status]?.content?.[
        "application/json"
      ]?.schema?.$ref;

    expect(bodySchema("post", "/api/v1/sites/{siteId}/funnels")).toBe(
      "#/components/schemas/FunnelCreateInput",
    );
    expect(bodySchema("post", "/api/v1/sites/{siteId}/funnels/analysis")).toBe(
      "#/components/schemas/FunnelAnalysisRequest",
    );
    expect(
      bodySchema("patch", "/api/v1/sites/{siteId}/funnels/{funnelId}"),
    ).toBe("#/components/schemas/FunnelUpdateInput");
    expect(bodySchema("post", "/api/v1/sites/{siteId}/events/search")).toBe(
      "#/components/schemas/EventSearchRequest",
    );

    expect(
      spec.components.schemas.SiteCreateInput.properties?.sharing,
    ).toBeUndefined();
    expect(
      spec.components.schemas.SiteUpdateInput.properties?.sharing,
    ).toBeUndefined();
    expect(spec.components.schemas.SiteCreateInput.properties).toEqual(
      expect.objectContaining({
        publicEnabled: expect.objectContaining({ type: "boolean" }),
        publicSlug: expect.objectContaining({ type: "string" }),
      }),
    );
    expect(spec.components.schemas.SiteUpdateInput.properties).toEqual(
      expect.objectContaining({
        publicEnabled: expect.objectContaining({ type: "boolean" }),
        publicSlug: expect.objectContaining({ type: "string" }),
      }),
    );

    walk(spec.paths, (value) => {
      if (!value || typeof value !== "object" || !("requestBody" in value)) {
        return;
      }
      expect(
        (
          value as {
            requestBody?: {
              content?: { "application/json"?: { schema?: { $ref?: string } } };
            };
          }
        ).requestBody?.content?.["application/json"]?.schema?.$ref,
      ).not.toBe("#/components/schemas/GenericObjectResponse");
    });

    expect(
      responseSchema("post", "/api/v1/sites/{siteId}/funnels", "201"),
    ).toBe("#/components/schemas/FunnelResponse");
    expect(
      spec.paths["/api/v1/sites/{siteId}/funnels"]?.post?.parameters,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Idempotency-Key",
          in: "header",
        }),
      ]),
    );
    expect(responseSchema("get", "/api/v1/team/usage")).toBe(
      "#/components/schemas/TeamUsageResponse",
    );
    expect(
      responseSchema("get", "/api/v1/sites/{siteId}/analytics/compare"),
    ).toBe("#/components/schemas/AnalyticsCompareResponse");
    expect(
      responseSchema("post", "/api/v1/sites/{siteId}/analytics/explore"),
    ).toBe("#/components/schemas/AnalyticsExploreResponse");
    expect(
      responseSchema("get", "/api/v1/sites/{siteId}/funnels/{funnelId}"),
    ).toBe("#/components/schemas/FunnelResponse");
    expect(
      responseSchema("get", "/api/v1/sites/{siteId}/event-types/{eventName}"),
    ).toBe("#/components/schemas/EventTypeResponse");

    expect(spec.components.schemas.CapabilitiesFeatures).toBeDefined();
    expect(spec.components.schemas.CapabilitiesLimits).toBeDefined();
    expect(spec.components.schemas.EventType).toBeDefined();
    expect(spec.components.schemas.EventFieldDefinition).toBeDefined();
    expect(
      JSON.stringify(spec.components.schemas.CapabilitiesResponse),
    ).toContain("Capabilities");
    expect(JSON.stringify(spec.components.schemas.TimeRangeInput)).toContain(
      "last 7 days",
    );
  });

  it("documents collect payloads with concrete schemas and examples", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");
    const collect = spec.paths["/collect"]?.post;
    const collectPayload = spec.components.schemas.CollectPayload;

    expect(collect?.responses).toBeDefined();
    expect(Object.keys(collect?.responses ?? {}).sort()).toEqual([
      "204",
      "400",
      "413",
    ]);
    expect(collect?.responses?.["429"]).toBeUndefined();
    expect(
      collect?.requestBody?.content?.["application/json"]?.schema?.$ref,
    ).toBe("#/components/schemas/CollectPayload");

    expect(collectPayload.required).toEqual(["siteId", "type"]);
    expect(collectPayload.additionalProperties).toBe(false);
    expect(collectPayload.properties).toEqual(
      expect.objectContaining({
        siteId: expect.objectContaining({ format: "uuid" }),
        type: expect.objectContaining({
          enum: ["pageview", "event", "engagement", "performance"],
        }),
        timestamp: expect.objectContaining({ format: "date-time" }),
        anonymousId: expect.objectContaining({ maxLength: 120 }),
        sessionId: expect.objectContaining({ maxLength: 120 }),
        page: { $ref: "#/components/schemas/CollectPage" },
        client: { $ref: "#/components/schemas/CollectClient" },
        event: { $ref: "#/components/schemas/CollectEvent" },
        engagement: { $ref: "#/components/schemas/CollectEngagement" },
        performance: { $ref: "#/components/schemas/CollectPerformance" },
      }),
    );
    expect(
      spec.components.schemas.CollectEvent.properties?.data
        ?.additionalProperties,
    ).toBe(true);

    const examples =
      collect?.requestBody?.content?.["application/json"]?.examples ?? {};
    expect(Object.keys(examples).sort()).toEqual(["event", "pageview"]);
    const rawExamples = JSON.stringify(examples);
    expect(rawExamples).not.toContain('"ok"');
    expect(/\b\d{13}\b/.test(rawExamples)).toBe(false);
  });

  it("adds examples for core responses and mutating request bodies", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");
    const methods = ["get", "post", "patch", "delete", "put"];

    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of methods) {
        const operation = item[method];
        if (!operation) continue;

        if (
          ["post", "patch"].includes(method) &&
          operation.requestBody?.content?.["application/json"]
        ) {
          const content = operation.requestBody.content["application/json"];
          expect(
            content.example ?? Object.keys(content.examples ?? {}).length,
            `${method.toUpperCase()} ${path} request example`,
          ).toBeTruthy();
        }

        if (method === "get" && path.startsWith("/api/v1")) {
          const success =
            operation.responses?.["200"]?.content?.["application/json"];
          expect(
            success?.example ?? Object.keys(success?.examples ?? {}).length,
            `GET ${path} response example`,
          ).toBeTruthy();
        }
      }
    }
  });

  it("uses concrete schemas for cross-breakdowns and events summary", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");
    const responseSchema = (path: string) =>
      spec.paths[path]?.get?.responses?.["200"]?.content?.["application/json"]
        ?.schema?.$ref;

    expect(
      responseSchema("/api/v1/sites/{siteId}/analytics/cross-breakdowns"),
    ).toBe("#/components/schemas/AnalyticsCrossBreakdownResponse");
    expect(responseSchema("/api/v1/sites/{siteId}/events/summary")).toBe(
      "#/components/schemas/EventsSummaryResponse",
    );
    expect(JSON.stringify(spec.paths)).not.toContain(
      "#/components/schemas/GenericObjectResponse",
    );
  });

  it("keeps final API examples semantically aligned with endpoints", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");
    const eventTypesExample = defaultExampleValue(
      spec.paths["/api/v1/sites/{siteId}/event-types"].get,
    ) as { data?: Array<{ key?: string; events?: number }> };
    const teamSitesExample = defaultExampleValue(
      spec.paths["/api/v1/team/analytics/sites"].get,
    ) as { data?: Array<{ key?: string; label?: string; views?: number }> };
    const eventTypeExample = defaultExampleValue(
      spec.paths["/api/v1/sites/{siteId}/event-types/{eventName}"].get,
    ) as { data?: { name?: string; fields?: unknown[]; links?: unknown } };

    expect(eventTypesExample.data?.map((row) => row.key)).toEqual([
      "signup",
      "purchase",
    ]);
    expect(JSON.stringify(eventTypesExample)).not.toContain("__direct__");
    expect(JSON.stringify(eventTypesExample)).not.toContain("__unknown__");
    expect(eventTypesExample.data?.[0]).toEqual(
      expect.objectContaining({ events: 450, sessions: 210, visitors: 190 }),
    );

    expect(teamSitesExample.data?.[0]).toEqual(
      expect.objectContaining({
        key: "550e8400-e29b-41d4-a716-446655440000",
        label: "Example Blog",
        views: 5200,
      }),
    );
    expect(JSON.stringify(teamSitesExample)).not.toContain("__direct__");
    expect(JSON.stringify(teamSitesExample)).not.toContain("__unknown__");

    expect(eventTypeExample.data).toEqual(
      expect.objectContaining({
        name: "signup",
        events: 450,
        fields: expect.arrayContaining([
          expect.objectContaining({ path: "plan", valueTypes: ["string"] }),
        ]),
        links: expect.any(Object),
      }),
    );
  });

  it("constrains analytics explore metrics and dimensions", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");
    const explore = spec.components.schemas.AnalyticsExploreRequest;

    expect(explore.description).toContain("multidimensional");
    expect(explore.properties?.metrics).toEqual(
      expect.objectContaining({
        minItems: 1,
        maxItems: 20,
        description: expect.stringContaining("analytics/schema"),
      }),
    );
    expect(explore.properties?.metrics?.items).toEqual(
      expect.objectContaining({ type: "string", maxLength: 80 }),
    );
    expect(explore.properties?.dimensions).toEqual(
      expect.objectContaining({
        maxItems: 5,
        description: expect.stringContaining("analytics/schema"),
      }),
    );
    expect(explore.properties?.dimensions?.items).toEqual(
      expect.objectContaining({ type: "string", maxLength: 120 }),
    );
  });

  it("keeps skills calls aligned with OpenAPI path templates", () => {
    const spec = readJson<{
      paths: Record<string, Record<string, unknown>>;
    }>("docs/openapi.json");
    const manifest = readJson<{
      discovery?: Record<string, string>;
      taskRecipes?: Array<{ calls?: string[] }>;
      endpoints?: unknown;
    }>("docs/skills.json");

    const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) =>
          ["get", "post", "patch", "delete", "put"].includes(method),
        )
        .map((method) => ({ method: method.toUpperCase(), path })),
    );
    const hasOperation = (method: string, path: string) =>
      operations.some(
        (operation) =>
          operation.method === method &&
          pathMatchesTemplate(operation.path, path),
      );

    expect(hasOperation("GET", manifest.discovery?.root ?? "")).toBe(true);
    expect(hasOperation("GET", manifest.discovery?.token ?? "")).toBe(true);
    expect(hasOperation("GET", manifest.discovery?.capabilities ?? "")).toBe(
      true,
    );
    expect(hasOperation("GET", manifest.discovery?.analyticsSchema ?? "")).toBe(
      true,
    );

    for (const recipe of manifest.taskRecipes ?? []) {
      for (const call of recipe.calls ?? []) {
        const [method, rawPath] = call.split(/\s+/, 2);
        const path = rawPath.split("?")[0];
        expect(hasOperation(method, path)).toBe(true);
      }
    }
    expect(manifest.endpoints).toBeUndefined();
  });
});
