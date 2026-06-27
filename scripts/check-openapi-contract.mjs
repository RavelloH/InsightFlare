#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const openapiPath = resolve(root, "docs", "openapi.json");
const skillsPath = resolve(root, "docs", "skills.json");

const openapi = JSON.parse(readFileSync(openapiPath, "utf8"));
const skills = JSON.parse(readFileSync(skillsPath, "utf8"));
const issues = [];

const httpMethods = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
]);

function walk(value, visitor, path = []) {
  visitor(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, [...path, index]));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) =>
      walk(item, visitor, [...path, key]),
    );
  }
}

function resolvePointer(pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("#/")) {
    return undefined;
  }
  let current = openapi;
  for (const rawPart of pointer.slice(2).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function dereference(value) {
  return value && typeof value === "object" && "$ref" in value
    ? resolvePointer(value.$ref)
    : value;
}

function refName(value) {
  if (!value || typeof value !== "object" || !("$ref" in value)) return null;
  return String(value.$ref).split("/").at(-1) ?? null;
}

function dereferenceParameter(parameter) {
  return dereference(parameter);
}

function responseSchemas(operation) {
  const schemas = [];
  for (const response of Object.values(operation.responses ?? {})) {
    const resolved = dereference(response);
    const content = resolved?.content?.["application/json"];
    if (content?.schema) schemas.push(content.schema);
  }
  return schemas;
}

function jsonContent(container) {
  if (!container || typeof container !== "object") return undefined;
  return container.content?.["application/json"];
}

function hasExample(content) {
  return Boolean(
    content &&
    (Object.prototype.hasOwnProperty.call(content, "example") ||
      (content.examples && Object.keys(content.examples).length > 0)),
  );
}

function exampleValue(content) {
  if (!content || typeof content !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(content, "example")) {
    return content.example;
  }
  const examples = Object.values(content.examples ?? {});
  const first = examples[0];
  if (first && typeof first === "object" && "value" in first) {
    return first.value;
  }
  return first;
}

function successJsonContent(path, method = "get", status = "200") {
  const operation = openapi.paths?.[path]?.[method];
  const response = dereference(operation?.responses?.[status]);
  return jsonContent(response);
}

function schemaContainsPagination(schema, seen = new Set()) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return false;
    seen.add(schema.$ref);
    return (
      schema.$ref.endsWith("/PaginatedEnvelope") ||
      schemaContainsPagination(resolvePointer(schema.$ref), seen)
    );
  }
  if (schema.properties?.pagination) return true;
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.some((item) => schemaContainsPagination(item, seen));
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.some((item) => schemaContainsPagination(item, seen));
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((item) => schemaContainsPagination(item, seen));
  }
  return false;
}

function templateToRegExp(template) {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\{[^/]+\\\}/g, "[^/]+")}$`);
}

function matchesPathTemplate(template, concretePath) {
  return templateToRegExp(template).test(concretePath);
}

const operationIds = new Map();
const operations = [];

for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
  if (path.includes("queryName")) {
    issues.push(`Path must not contain queryName: ${path}`);
  }
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!httpMethods.has(method)) continue;
    const key = `${method.toUpperCase()} ${path}`;
    operations.push({ method: method.toUpperCase(), path, operation });

    if (!operation.operationId) {
      issues.push(`${key} is missing operationId`);
    } else if (operationIds.has(operation.operationId)) {
      issues.push(
        `Duplicate operationId ${operation.operationId}: ${operationIds.get(
          operation.operationId,
        )} and ${key}`,
      );
    } else {
      operationIds.set(operation.operationId, key);
    }

    const parameters = [
      ...(pathItem.parameters ?? []),
      ...(operation.parameters ?? []),
    ]
      .map(dereferenceParameter)
      .filter(Boolean);
    for (const parameter of parameters) {
      if (parameter.name === "queryName") {
        issues.push(`${key} has forbidden queryName parameter`);
      }
    }

    const hasCursor = parameters.some(
      (parameter) => parameter.in === "query" && parameter.name === "cursor",
    );
    if (method === "get" && hasCursor) {
      const hasPagination = responseSchemas(operation).some((schema) =>
        schemaContainsPagination(schema),
      );
      if (!hasPagination) {
        issues.push(`${key} has cursor parameter but no pagination response`);
      }
    }

    const bodySchema =
      operation.requestBody?.content?.["application/json"]?.schema;
    if (refName(bodySchema) === "GenericObjectResponse") {
      issues.push(`${key} requestBody must not use GenericObjectResponse`);
    }

    if (
      ["post", "patch"].includes(method) &&
      operation.requestBody &&
      !hasExample(jsonContent(operation.requestBody))
    ) {
      issues.push(`${key} requestBody must include at least one example`);
    }

    const successResponse =
      operation.responses?.["200"] ?? operation.responses?.["201"];
    const successContent = jsonContent(dereference(successResponse));
    if (
      method === "get" &&
      path.startsWith("/api/v1") &&
      successContent?.schema &&
      !hasExample(successContent)
    ) {
      issues.push(`${key} success response must include an example`);
    }

    const successSchemaName = refName(successContent?.schema);
    if (
      path.startsWith("/api/v1") &&
      ["200", "201"].some((status) => operation.responses?.[status]) &&
      successSchemaName === "GenericObjectResponse"
    ) {
      issues.push(
        `${key} /api/v1 success response must not use GenericObjectResponse`,
      );
    }

    if (operation.responses?.["429"]) {
      issues.push(`${key} must not declare 429 as a stable origin response`);
    }

    if (!Object.prototype.hasOwnProperty.call(operation, "x-required-scopes")) {
      issues.push(`${key} is missing x-required-scopes`);
    } else if (!Array.isArray(operation["x-required-scopes"])) {
      issues.push(`${key} x-required-scopes must be an array`);
    } else if (
      !(operation.security && operation.security.length === 0) &&
      operation["x-required-scopes"].length === 0 &&
      path.startsWith("/api/v1") &&
      ![
        "/api/v1",
        "/api/v1/token",
        "/api/v1/token/check",
        "/api/v1/capabilities",
      ].includes(path)
    ) {
      issues.push(`${key} authenticated operation should declare a scope`);
    }
  }
}

for (const [name, schema] of Object.entries(
  openapi.components?.schemas ?? {},
)) {
  if (name.includes("___")) {
    issues.push(`Schema name must not contain ___: ${name}`);
  }
  walk(schema, (value, path) => {
    if (
      path.at(-1) === "ok" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      issues.push(`Schema ${name} must not expose ok field`);
    }
  });
}

const publicContract = JSON.stringify({
  paths: openapi.paths,
  components: openapi.components,
  skills,
});
for (const forbidden of [
  "queryName",
  '"ok"',
  "Unix milliseconds",
  "Unix ms",
  "pageSize",
  "sortBy",
  "sortDir",
]) {
  if (publicContract.includes(forbidden)) {
    issues.push(`Public contract contains forbidden text: ${forbidden}`);
  }
}

if (!openapi.info?.description?.includes("ISO 8601 date-time strings")) {
  issues.push("Top-level description must describe ISO 8601 timestamps");
}
if (
  !openapi.info?.description?.includes(
    "outside the standard API error envelope",
  )
) {
  issues.push(
    "Top-level description must explain upstream 429 as non-contract",
  );
}
if (!Array.isArray(openapi["x-possible-upstream-responses"])) {
  issues.push("OpenAPI must expose x-possible-upstream-responses");
}

for (const [name, parameter] of Object.entries(
  openapi.components?.parameters ?? {},
)) {
  if (["FromQueryParam", "ToQueryParam"].includes(name)) {
    if (
      parameter.schema?.type !== "string" ||
      parameter.schema?.format !== "date-time"
    ) {
      issues.push(`${name} must be an ISO 8601 date-time string parameter`);
    }
    if (/unix|millisecond/i.test(parameter.description ?? "")) {
      issues.push(`${name} description must not mention Unix milliseconds`);
    }
  }
}

for (const name of [
  "SiteIdPathParam",
  "FromQueryParam",
  "ToQueryParam",
  "PresetQueryParam",
  "TimeZoneQueryParam",
  "MetricsQueryParam",
  "FilterQueryParam",
  "LimitQueryParam",
  "CursorQueryParam",
]) {
  if (!openapi.components?.parameters?.[name]) {
    issues.push(`Missing reusable parameter ${name}`);
  }
}

const visitorParam = openapi.components?.parameters?.VisitorIdPathParam;
if (visitorParam?.schema?.format === "uuid") {
  issues.push("VisitorIdPathParam must not require uuid format");
}
const sessionParam = openapi.components?.parameters?.SessionIdPathParam;
if (sessionParam?.schema?.format === "uuid") {
  issues.push("SessionIdPathParam must not require uuid format");
}

const complexFilterValue =
  openapi.components?.schemas?.ComplexFilter?.properties?.value;
if (!Array.isArray(complexFilterValue?.oneOf)) {
  issues.push("ComplexFilter.value must define a constrained oneOf schema");
}

const collect = openapi.paths?.["/collect"]?.post;
if (collect?.responses?.["429"]) {
  issues.push("/collect must not declare a 429 response");
}
const collectBodyName = refName(
  collect?.requestBody?.content?.["application/json"]?.schema,
);
if (collectBodyName === "GenericObjectResponse") {
  issues.push("/collect requestBody must not use GenericObjectResponse");
}
const collectPayload = openapi.components?.schemas?.CollectPayload;
if (
  !collectPayload ||
  collectPayload.additionalProperties === true ||
  !collectPayload.properties?.siteId ||
  !collectPayload.properties?.type
) {
  issues.push("CollectPayload must define explicit siteId/type properties");
}

const eventTypesExample = exampleValue(
  successJsonContent("/api/v1/sites/{siteId}/event-types"),
);
const eventTypesExampleText = JSON.stringify(eventTypesExample);
if (
  eventTypesExampleText.includes("__direct__") ||
  eventTypesExampleText.includes("__unknown__")
) {
  issues.push(
    "/event-types example must use event names, not direct/unknown breakdown values",
  );
}

const teamAnalyticsSitesExample = exampleValue(
  successJsonContent("/api/v1/team/analytics/sites"),
);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
for (const row of teamAnalyticsSitesExample?.data ?? []) {
  if (!uuidPattern.test(String(row.key))) {
    issues.push("/team/analytics/sites example keys must be site UUIDs");
    break;
  }
}

const exploreRequest = openapi.components?.schemas?.AnalyticsExploreRequest;
if (exploreRequest?.properties?.metrics?.items?.maxLength !== 80) {
  issues.push("AnalyticsExploreRequest.metrics.items must set maxLength 80");
}
if (exploreRequest?.properties?.dimensions?.items?.maxLength !== 120) {
  issues.push(
    "AnalyticsExploreRequest.dimensions.items must set maxLength 120",
  );
}
if (
  exploreRequest?.properties?.metrics?.minItems !== 1 ||
  exploreRequest?.properties?.metrics?.maxItems !== 20
) {
  issues.push(
    "AnalyticsExploreRequest.metrics must set minItems 1 and maxItems 20",
  );
}
if (exploreRequest?.properties?.dimensions?.maxItems !== 5) {
  issues.push("AnalyticsExploreRequest.dimensions must set maxItems 5");
}

const eventTypeResponseRef = successJsonContent(
  "/api/v1/sites/{siteId}/event-types/{eventName}",
)?.schema;
if (refName(eventTypeResponseRef) === "EventTypeResponse") {
  if (!openapi.components?.schemas?.EventType) {
    issues.push("EventTypeResponse requires EventType schema");
  }
} else {
  issues.push("/event-types/{eventName} must use EventTypeResponse");
}

const openapiOperations = operations.map(({ method, path }) => ({
  method,
  path,
}));

for (const recipe of skills.taskRecipes ?? []) {
  for (const call of recipe.calls ?? []) {
    const [method, rawPath] = String(call).split(/\s+/, 2);
    const path = rawPath?.split("?")[0];
    if (!method || !path) {
      issues.push(`Malformed skills recipe call: ${call}`);
      continue;
    }
    const exists = openapiOperations.some(
      (operation) =>
        operation.method === method.toUpperCase() &&
        matchesPathTemplate(operation.path, path),
    );
    if (!exists) {
      issues.push(`skills.json call does not match OpenAPI path: ${call}`);
    }
  }
}

if (skills.endpoints !== undefined) {
  issues.push(
    "skills.json must remain an agent manifest, not an endpoint catalog",
  );
}

if (issues.length > 0) {
  console.error("OpenAPI contract check failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(
  `OpenAPI contract check passed (${operations.length} operations, ${
    Object.keys(openapi.components?.schemas ?? {}).length
  } schemas).`,
);
