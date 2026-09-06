import { z } from "zod";

import { type ApiV1ErrorCode, apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import {
  apiV1RouteRegistry,
  isApiV1BatchEligible,
} from "@/lib/api-v1/route-registry";
import {
  ApiV1ErrorEnvelopeSchema,
  ApiV1ResponseMetaSchema,
} from "@/lib/api-v1/wire";

type JsonSchema = Record<string, unknown>;
type HttpMethod = "get" | "post" | "patch" | "delete";

export type ApiV1OpenApiOperation = {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  security: Array<Record<string, string[]>>;
  parameters?: Array<Record<string, unknown>>;
  requestBody?: Record<string, unknown>;
  responses: Record<string, unknown>;
  "x-api-v1-lifecycle": "exposed";
  "x-api-v1-scopes": string[];
  "x-required-scopes": string[];
  "x-api-v1-batch-eligible": boolean;
  "x-api-v1-conditional-scopes"?: unknown;
};

export type ApiV1OpenApiPaths = Record<
  string,
  Partial<Record<HttpMethod, ApiV1OpenApiOperation>>
>;

const json = "application/json";
const httpMethods: Record<string, HttpMethod> = {
  GET: "get",
  POST: "post",
  PATCH: "patch",
  DELETE: "delete",
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonSchema(schema: z.ZodType): JsonSchema {
  const result = z.toJSONSchema(schema) as JsonSchema;
  delete result.$schema;
  return result;
}

function optionalJsonSchema(
  schema: z.ZodType | undefined,
): JsonSchema | undefined {
  if (!schema) return undefined;
  try {
    return jsonSchema(schema);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Undefined cannot be represented in JSON Schema"
    ) {
      return undefined;
    }
    throw error;
  }
}

function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function objectProperties(schema: JsonSchema): Record<string, JsonSchema> {
  const properties = schema.properties;
  return properties &&
    typeof properties === "object" &&
    !Array.isArray(properties)
    ? (properties as Record<string, JsonSchema>)
    : {};
}

function requiredProperties(schema: JsonSchema): Set<string> {
  return new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
  );
}

function pathParameters(
  path: string,
  schema: JsonSchema,
  pathParameterSchemas?: Readonly<Record<string, z.ZodType>>,
): Array<Record<string, unknown>> {
  const properties = objectProperties(schema);
  return pathParameterNames(path).map((name) => ({
    name,
    in: "path",
    required: true,
    schema: clone(
      pathParameterSchemas?.[name]
        ? jsonSchema(pathParameterSchemas[name])
        : (properties[name] ?? { type: "string", minLength: 1 }),
    ),
    description: `${name} path parameter.`,
  }));
}

function schemaWithoutPathParameters(
  path: string,
  schema: JsonSchema,
): JsonSchema {
  const result = clone(schema);
  const names = new Set(pathParameterNames(path));
  const properties = Object.fromEntries(
    Object.entries(objectProperties(result)).filter(
      ([name]) => !names.has(name),
    ),
  );
  if (Object.keys(properties).length > 0 || "properties" in result) {
    result.properties = properties;
  }
  const required = new Set(
    [...requiredProperties(result)].filter((name) => !names.has(name)),
  );
  if (required.size > 0) result.required = [...required];
  else delete result.required;
  return result;
}

function queryParameters(
  path: string,
  schema: JsonSchema,
): Array<Record<string, unknown>> {
  const pathNames = new Set(pathParameterNames(path));
  const required = requiredProperties(schema);
  return Object.entries(objectProperties(schema)).flatMap(
    ([name, parameterSchema]) => {
      if (pathNames.has(name)) return [];
      if (name === "page" && parameterSchema.type === "object") {
        const pageProperties = objectProperties(parameterSchema);
        if (pageProperties.limit || pageProperties.cursor) {
          return [
            ...(pageProperties.limit
              ? [
                  {
                    name: "limit",
                    in: "query",
                    required: false,
                    schema: clone(pageProperties.limit),
                    description: "Maximum number of results.",
                  },
                ]
              : []),
            ...(pageProperties.cursor
              ? [
                  {
                    name: "cursor",
                    in: "query",
                    required: false,
                    schema: clone(pageProperties.cursor),
                    description:
                      "Opaque pagination cursor from the previous response.",
                  },
                ]
              : []),
          ];
        }
      }
      return [
        {
          name,
          in: "query",
          required: required.has(name),
          schema: clone(parameterSchema),
          description: `${name} query parameter.`,
        },
      ];
    },
  );
}

function tagForOperation(operationId: string): string {
  if (operationId.includes(".performance")) return "Performance";
  if (operationId.includes(".realtime")) return "Realtime";
  if (
    operationId.includes(".events") ||
    operationId.includes(".eventDetail") ||
    operationId.includes(".eventTypes") ||
    operationId.includes(".eventFields") ||
    operationId.includes(".eventField")
  ) {
    return "Events";
  }
  if (operationId.includes(".visitor")) return "Visitors";
  if (operationId.includes(".session")) return "Sessions";
  if (operationId.includes(".funnelAnalysis")) return "Funnels";
  if (
    operationId.startsWith("site.analytics.") ||
    operationId.startsWith("team.analytics.")
  ) {
    return "Analytics";
  }
  if (operationId.startsWith("core.token")) return "Token";
  if (operationId.startsWith("core.team")) return "Team";
  if (operationId.startsWith("core.")) return "Discovery";
  if (operationId === "batch") return "Batch";
  if (operationId.startsWith("sites.")) return "Sites";
  if (operationId.startsWith("settings.")) return "Settings";
  if (operationId.startsWith("funnels.")) return "Funnels";
  return "Sites";
}

function summaryForOperation(operationId: string): string {
  return `API v1 ${operationId.replaceAll(".", " ")} operation`;
}

function descriptionForOperation(routeId: string): string {
  if (routeId === "site.analytics.performanceBreakdown") {
    return "Breaks down Core Web Vitals by page.path or geo.country. Other dimensions are not supported and return validation_failed.";
  }
  if (routeId === "site.analytics.eventsTimeseries") {
    return "Returns event counts at time points. series contains top-N event-type aggregates for the whole window; points contains the time buckets. The request limit controls top-N event types, not the number of points.";
  }
  if (routeId === "site.analytics.eventsSearch") {
    return "Searches event records. Use page.limit for page size; it supports values from 1 through 200 and is independent of the events timeseries top-N limit.";
  }
  return "Typed API v1 operation. Authenticate with an API key through the BearerAuth security scheme.";
}

function successStatus(method: string, operationId: string): string {
  if (method === "DELETE") return "204";
  if (operationId === "sites.create" || operationId === "funnels.create") {
    return "201";
  }
  return "200";
}

function errorResponse(
  codes: readonly ApiV1ErrorCode[],
): Record<string, unknown> {
  const first = codes[0] ?? "internal_error";
  const definition = apiV1ErrorRegistry[first];
  return {
    description: `API v1 error: ${codes.join(", ")}.`,
    headers: {
      "X-Request-Id": {
        required: true,
        schema: { type: "string", minLength: 1 },
      },
    },
    content: {
      [json]: {
        schema: jsonSchema(ApiV1ErrorEnvelopeSchema),
        example: {
          error: {
            code: first,
            message: definition.message,
            retryable: definition.retryable,
          },
          meta: { requestId: "req_01J7EXAMPLE" },
        },
      },
    },
  };
}

function errorResponses(
  codes: readonly ApiV1ErrorCode[],
): Record<string, unknown> {
  const byStatus = new Map<string, ApiV1ErrorCode[]>();
  for (const code of new Set<ApiV1ErrorCode>([
    ...codes,
    "method_not_allowed",
  ])) {
    const status = String(apiV1ErrorRegistry[code].status);
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus.entries()].map(([status, statusCodes]) => [
      status,
      errorResponse(statusCodes),
    ]),
  );
}

function isEmptySchema(schema: JsonSchema): boolean {
  return (
    schema.type === "object" &&
    Object.keys(objectProperties(schema)).length === 0 &&
    !Array.isArray(schema.oneOf) &&
    !Array.isArray(schema.anyOf) &&
    !Array.isArray(schema.allOf) &&
    typeof schema.$ref !== "string"
  );
}

function successResponseSchema(schema: z.ZodType): JsonSchema {
  const data = jsonSchema(schema);
  const properties = objectProperties(data);
  if (properties.data && properties.meta) return data;
  return {
    type: "object",
    properties: {
      data,
      meta: jsonSchema(ApiV1ResponseMetaSchema),
    },
    required: ["data", "meta"],
    additionalProperties: false,
  };
}

/** Build API v1 OpenAPI operations directly from the executable route registry. */
export function buildApiV1OpenApiPaths(): ApiV1OpenApiPaths {
  const paths: ApiV1OpenApiPaths = {};
  for (const route of apiV1RouteRegistry) {
    if (route.lifecycle !== "exposed") continue;
    const method = httpMethods[route.method];
    const requestSchema = optionalJsonSchema(
      "requestSchema" in route ? route.requestSchema : undefined,
    );
    const operationId = "operationId" in route ? route.operationId : route.id;
    const status = successStatus(route.method, operationId);
    const parameters =
      route.method === "GET" && requestSchema
        ? [
            ...pathParameters(
              route.path,
              requestSchema,
              "pathParameterSchemas" in route
                ? (route.pathParameterSchemas as Readonly<
                    Record<string, z.ZodType>
                  >)
                : undefined,
            ),
            ...queryParameters(route.path, requestSchema),
          ]
        : requestSchema
          ? pathParameters(
              route.path,
              requestSchema,
              "pathParameterSchemas" in route
                ? (route.pathParameterSchemas as Readonly<
                    Record<string, z.ZodType>
                  >)
                : undefined,
            )
          : [];
    const bodySchema = requestSchema
      ? schemaWithoutPathParameters(route.path, requestSchema)
      : undefined;
    const operation: ApiV1OpenApiOperation = {
      operationId,
      summary: summaryForOperation(operationId),
      description: descriptionForOperation(route.id),
      tags: [tagForOperation(operationId)],
      security: [{ BearerAuth: [] }],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.method !== "GET" && bodySchema && !isEmptySchema(bodySchema)
        ? {
            requestBody: {
              required: true,
              content: { [json]: { schema: bodySchema } },
            },
          }
        : {}),
      responses: {
        [status]:
          status === "204"
            ? { description: "Successful response with no content." }
            : {
                description: "Successful response.",
                headers: {
                  "X-Request-Id": {
                    required: true,
                    schema: { type: "string", minLength: 1 },
                  },
                },
                content: {
                  [json]: {
                    schema: successResponseSchema(route.responseSchema),
                  },
                },
              },
        ...errorResponses(route.declaredErrors),
      },
      "x-api-v1-lifecycle": "exposed",
      "x-api-v1-scopes": [...route.scopes],
      "x-required-scopes": [...route.scopes],
      "x-api-v1-batch-eligible": isApiV1BatchEligible(route.id),
      ...("conditionalScopes" in route && route.conditionalScopes
        ? { "x-api-v1-conditional-scopes": route.conditionalScopes }
        : {}),
    };
    paths[route.path] ??= {};
    paths[route.path][method] = operation;
  }
  return paths;
}
