#!/usr/bin/env tsx
/* eslint-disable @typescript-eslint/ban-ts-comment -- legacy contract walker migrated from JS; keep runtime logic stable while script structure is unified. */
// @ts-nocheck

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { createScriptLogger } from "./shared/logger";
import { buildApiV1OpenApiPaths } from "./api-v1-openapi";

const root = resolve(import.meta.dirname, "..");
const openapiPath = resolve(root, "docs", "openapi.json");
const skillsPath = resolve(root, "docs", "skills.json");
const rlog = createScriptLogger();

const openapi = JSON.parse(readFileSync(openapiPath, "utf8"));
const apiV1Openapi = { paths: buildApiV1OpenApiPaths() };
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
  const page = schema.properties?.page;
  if (page && typeof page === "object") {
    const resolvedPage = page.$ref ? resolvePointer(page.$ref) : page;
    const pageProperties = resolvedPage?.properties;
    if (
      pageProperties?.nextCursor &&
      pageProperties?.hasMore &&
      (pageProperties?.kind?.const === "keyset" ||
        pageProperties?.kind?.enum?.includes("keyset"))
    ) {
      return true;
    }
  }
  if (schema.properties) {
    return Object.values(schema.properties).some((value) =>
      schemaContainsPagination(value, new Set(seen)),
    );
  }
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
      if (parameter.name === "Idempotency-Key") {
        issues.push(`${key} must not expose Idempotency-Key`);
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
      path.startsWith("/api/v1") &&
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

    if (path.startsWith("/api/v1") && !operation.responses?.["405"]) {
      issues.push(`${key} must document the standard 405 error response`);
    }

    if (!Object.prototype.hasOwnProperty.call(operation, "x-required-scopes")) {
      issues.push(`${key} is missing x-required-scopes`);
    } else if (!Array.isArray(operation["x-required-scopes"])) {
      issues.push(`${key} x-required-scopes must be an array`);
    } else if (
      !(operation.security && operation.security.length === 0) &&
      operation["x-required-scopes"].length === 0 &&
      path.startsWith("/api/v1") &&
      !Array.isArray(operation["x-api-v1-scopes"])
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
const typedEventTypeDetail =
  openapi.paths?.["/api/v1/sites/{siteId}/analytics/event-types/detail"]?.post;
if (
  typedEventTypeDetail?.["x-api-v1-lifecycle"] !== "exposed" ||
  !successJsonContent(
    "/api/v1/sites/{siteId}/analytics/event-types/detail",
    "post",
  )?.schema
) {
  issues.push("typed event type detail operation must expose a success schema");
}

const openapiOperations = [
  ...operations.map(({ method, path }) => ({ method, path })),
  ...Object.entries(apiV1Openapi.paths ?? {}).flatMap(([path, pathItem]) =>
    Object.keys(pathItem ?? {})
      .filter((method) => httpMethods.has(method))
      .map((method) => ({ method: method.toUpperCase(), path })),
  ),
];

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
  rlog.error("OpenAPI contract check failed:");
  for (const issue of issues) {
    rlog.error(`- ${issue}`);
  }
  process.exit(1);
}

rlog.success(
  `OpenAPI contract check passed (${operations.length} operations, ${
    Object.keys(openapi.components?.schemas ?? {}).length
  } schemas).`,
);
