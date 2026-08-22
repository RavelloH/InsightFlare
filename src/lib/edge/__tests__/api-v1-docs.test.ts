import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

import { buildApiV1OpenApiPaths } from "../../../../scripts/api-v1-openapi";
import {
  readSkillsTemplate,
  renderSkillsManifest,
  serializeSkillsManifest,
} from "../../../../scripts/skills-manifest";

const root = process.cwd();

type JsonContent = {
  schema?: JsonSchemaObject;
  example?: unknown;
  examples?: Record<string, unknown>;
};

type OperationObject = {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  tags?: string[];
  "x-api-v1-lifecycle"?: string;
  "x-api-v1-scopes"?: string[];
  "x-internal"?: boolean;
  requestBody?: { content?: { "application/json"?: JsonContent } };
  responses?: Record<
    string,
    { content?: { "application/json"?: JsonContent } }
  >;
  parameters?: unknown[];
};

type OpenApiSpec = {
  tags?: Array<{ name: string }>;
  paths: Record<string, Record<string, OperationObject>>;
  components: {
    schemas: Record<string, JsonSchemaObject>;
    responses?: Record<string, unknown>;
    parameters?: Record<string, JsonSchemaObject>;
    securitySchemes?: Record<string, unknown>;
  };
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
    expect(raw).not.toContain("ComplexFilter");
    expect(raw).not.toContain("EventPayloadFilter");
    expect(raw).not.toContain("Idempotency-Key");

    expect(
      Object.keys(spec.components.schemas).some((name) => name.includes("___")),
    ).toBe(false);
    expect(spec.components.schemas.ErrorResponse).toBeDefined();
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
    walk(spec, (value) => {
      if (!value || typeof value !== "object" || !("$ref" in value)) return;
      const ref = String((value as { $ref: string }).$ref);
      if (ref.endsWith("/ErrorResponse")) errorResponseRefs += 1;
    });
    expect(errorResponseRefs).toBeGreaterThan(0);
  });

  it("renders the Agent manifest from its canonical template", () => {
    const manifest = readJson<Record<string, unknown>>("docs/skills.json");
    const template = readSkillsTemplate();
    const version = readJson<{ version: string }>("package.json").version;
    const raw = JSON.stringify(manifest);

    expect(manifest).toEqual(renderSkillsManifest(version, template));
    expect(serializeSkillsManifest(manifest)).toBe(
      readFileSync(resolve(root, "docs/skills.json"), "utf8"),
    );
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.version).toBe(version);
    expect(manifest.baseUrl).toBe("${baseUrl}");
    expect(manifest.openapi).toMatchObject({
      url: "/.well-known/openapi.json",
    });
    expect(manifest.openapiGuidance).toMatchObject({
      sourceOfTruth: expect.any(String),
      readingRules: expect.any(Array),
    });
    expect(Array.isArray(manifest.taskRecipes)).toBe(true);
    expect(() =>
      renderSkillsManifest(version, { version: "${unsupported}" }),
    ).toThrow("Unknown skills template placeholder");
    expect(raw).not.toContain("queryName");
    expect(raw).not.toContain("Unix milliseconds");
    expect(raw).not.toContain('"ok"');
    expect(raw).not.toContain("typedAnalyticsOperations");
    expect(raw).not.toContain('"$ref"');
    expect(raw).not.toContain('"requestBody"');
  });

  it("publishes the registry-owned typed API v1 operations in the main contract", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");
    const typedPaths = buildApiV1OpenApiPaths();

    for (const [path, typedPathItem] of Object.entries(typedPaths)) {
      for (const method of ["get", "post", "patch", "delete"] as const) {
        const typedOperation = typedPathItem[method];
        if (!typedOperation) continue;
        const operation = spec.paths[path]?.[method];
        expect(operation, `${method.toUpperCase()} ${path}`).toBeDefined();
        expect(operation?.operationId).toBe(typedOperation.operationId);
        expect(operation?.["x-api-v1-lifecycle"]).toBe("exposed");
        expect(operation?.["x-api-v1-scopes"]).toEqual(
          typedOperation["x-api-v1-scopes"],
        );
      }
    }

    const overview =
      spec.paths["/api/v1/sites/{siteId}/analytics/overview"]?.post;
    expect(
      overview?.requestBody?.content?.["application/json"]?.schema,
    ).toBeDefined();
    expect(
      overview?.responses?.["200"]?.content?.["application/json"]?.schema,
    ).toBeDefined();
    expect(overview?.["x-api-v1-scopes"]).toEqual(["analytics:read"]);

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

    expect(spec.components.securitySchemes?.BearerAuth).toBeDefined();
    expect(spec.components.securitySchemes?.DashboardSession).toBeUndefined();
  });

  it("publishes only supported external non-v1 integrations", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");

    expect(spec.paths["/collect"]?.post?.security).toEqual([]);
    expect(spec.paths["/collect"]?.post?.tags).toContain("Ingestion");
    expect(spec.paths["/api/private/session"]).toBeUndefined();
    expect(spec.paths["/api/private/admin/api-keys"]).toBeUndefined();
    expect(spec.paths["/api/public/session"]).toBeUndefined();
    expect(spec.paths["/api/public/share/{slug}/site"]).toBeUndefined();
    expect(spec.paths["/__e2e__/clock"]).toBeUndefined();
    expect(spec.components.securitySchemes?.DashboardSession).toBeUndefined();
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
      spec.paths[path]?.post?.responses?.["200"]?.content?.["application/json"]
        ?.schema;

    expect(
      responseSchema("/api/v1/sites/{siteId}/analytics/cross-breakdowns"),
    ).toEqual(expect.any(Object));
    expect(
      responseSchema("/api/v1/sites/{siteId}/analytics/events/summary"),
    ).toEqual(expect.any(Object));
    expect(JSON.stringify(spec.paths)).not.toContain(
      "#/components/schemas/GenericObjectResponse",
    );
  });

  it("uses examples from the active typed API v1 contract", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");
    const overview =
      spec.paths["/api/v1/sites/{siteId}/analytics/overview"]?.post;
    const overviewRequest =
      overview?.requestBody?.content?.["application/json"]?.example;
    const overviewResponse = defaultExampleValue(overview) as {
      data?: { service?: string };
      meta?: { requestId?: string };
    };

    expect(overviewRequest).toEqual(
      expect.objectContaining({ timeRange: expect.any(Object) }),
    );
    expect(overviewResponse.meta?.requestId).toBeTruthy();
    expect(JSON.stringify(overviewRequest)).not.toContain("__direct__");
    expect(JSON.stringify(overviewResponse)).not.toContain("__unknown__");
  });

  it("constrains typed analytics request bodies", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");
    const overview =
      spec.paths["/api/v1/sites/{siteId}/analytics/overview"]?.post?.requestBody
        ?.content?.["application/json"]?.schema;
    const search =
      spec.paths["/api/v1/sites/{siteId}/analytics/events/search"]?.post
        ?.requestBody?.content?.["application/json"]?.schema;

    expect(overview?.properties?.metrics).toEqual(
      expect.objectContaining({
        minItems: 1,
        maxItems: 20,
      }),
    );
    expect(overview?.properties?.metrics?.items).toEqual(
      expect.objectContaining({ type: "string" }),
    );
    expect(search?.properties?.page).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          limit: expect.objectContaining({ minimum: 1, maximum: 200 }),
        }),
      }),
    );
  });

  it("documents typed filters, saved filters, and response envelopes", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");
    const overview =
      spec.paths["/api/v1/sites/{siteId}/analytics/overview"]?.post;
    const eventSearch =
      spec.paths["/api/v1/sites/{siteId}/analytics/events/search"]?.post;
    const funnel = spec.paths["/api/v1/sites/{siteId}/funnels"]?.post;

    expect(JSON.stringify(overview?.requestBody)).toContain('"inline"');
    expect(JSON.stringify(overview?.requestBody)).toContain('"saved"');
    expect(
      eventSearch?.requestBody?.content?.["application/json"]?.schema,
    ).toBeDefined();
    expect(
      funnel?.requestBody?.content?.["application/json"]?.schema,
    ).toBeDefined();

    for (const [path, item] of Object.entries(spec.paths)) {
      if (!path.startsWith("/api/v1")) continue;
      for (const operation of Object.values(item)) {
        if (!operation?.operationId) continue;
        expect(
          operation.responses?.["405"],
          `${operation.operationId} 405`,
        ).toBeDefined();
      }
    }
  });

  it("covers public operations with operationId-based recipes", () => {
    const spec = readJson<OpenApiSpec>("docs/openapi.json");
    const manifest = readJson<{
      discovery: {
        sessionInitialization: string[];
        siteAnalyticsSchema: string;
        teamAnalyticsSchema: string;
        health: string;
      };
      taskRecipes: Array<{
        scope: "site" | "team" | "integration";
        preparation: string[];
        operations: string[];
        requiresConfirmation?: boolean;
      }>;
    }>("docs/skills.json");
    const publicOperationIds = new Set(
      Object.values(spec.paths).flatMap((item) =>
        Object.values(item)
          .map((operation) => operation?.operationId)
          .filter((operationId): operationId is string => Boolean(operationId)),
      ),
    );
    const referenced = new Set([
      ...manifest.discovery.sessionInitialization,
      manifest.discovery.siteAnalyticsSchema,
      manifest.discovery.teamAnalyticsSchema,
      manifest.discovery.health,
      ...manifest.taskRecipes.flatMap((recipe) => [
        ...recipe.preparation,
        ...recipe.operations,
      ]),
    ]);

    expect(
      [...referenced].every((operationId) =>
        publicOperationIds.has(operationId),
      ),
    ).toBe(true);
    expect(
      [...publicOperationIds].filter(
        (operationId) => !referenced.has(operationId),
      ),
    ).toEqual([]);

    for (const recipe of manifest.taskRecipes) {
      const raw = JSON.stringify(recipe);
      const operationIds = [...recipe.preparation, ...recipe.operations];
      expect(raw).not.toMatch(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//);
      expect(raw).not.toMatch(/\/api\/|\/collect|\/script\.js/);
      expect(["site", "team", "integration"]).toContain(recipe.scope);
      if (operationIds.some((id) => id.startsWith("site.analytics."))) {
        expect(recipe.preparation).toContain("site.analytics.schema");
      }
      if (operationIds.some((id) => id.startsWith("team.analytics."))) {
        expect(recipe.preparation).toContain("team.analytics.schema");
      }
      if (
        operationIds.some((id) =>
          [
            "sites.create",
            "sites.update",
            "sites.delete",
            "funnels.create",
            "funnels.update",
            "funnels.delete",
            "settings.privacy.update",
            "settings.sharing.update",
            "settings.tracking.update",
          ].includes(id),
        )
      ) {
        expect(recipe.requiresConfirmation).toBe(true);
      }
    }
  });
});
