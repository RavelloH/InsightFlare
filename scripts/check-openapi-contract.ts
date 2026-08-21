#!/usr/bin/env tsx
/* eslint-disable @typescript-eslint/ban-ts-comment -- legacy contract walker migrated from JS; keep runtime logic stable while script structure is unified. */
// @ts-nocheck

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { createScriptLogger } from "./shared/logger";
import {
  readSkillsTemplate,
  renderSkillsManifest,
} from "./skills-manifest";

const root = resolve(import.meta.dirname, "..");
const openapiPath = resolve(root, "docs", "openapi.json");
const skillsPath = resolve(root, "docs", "skills.json");
const rlog = createScriptLogger();

const openapi = JSON.parse(readFileSync(openapiPath, "utf8"));
const skills = JSON.parse(readFileSync(skillsPath, "utf8"));
const skillsTemplate = readSkillsTemplate();
const packageVersion = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
).version;
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

const expectedSkills = renderSkillsManifest(packageVersion, skillsTemplate);
if (JSON.stringify(skills) !== JSON.stringify(expectedSkills)) {
  issues.push("docs/skills.json does not match the rendered skills template");
}

if (skills.manifestVersion !== 1) {
  issues.push("skills.json must declare manifestVersion 1");
}
if (skills.version !== packageVersion) {
  issues.push("skills.json version must match package.json");
}
if (skills.baseUrl !== "${baseUrl}") {
  issues.push("skills.json baseUrl must preserve the runtime baseUrl placeholder");
}
if (skills.openapi?.url !== "/.well-known/openapi.json") {
  issues.push("skills.json must expose the well-known OpenAPI URL");
}
if (
  !skills.openapiGuidance ||
  typeof skills.openapiGuidance.sourceOfTruth !== "string" ||
  !Array.isArray(skills.openapiGuidance.readingRules)
) {
  issues.push("skills.json must define OpenAPI guidance for Agents");
}

const templateText = JSON.stringify(skillsTemplate);
for (const placeholder of templateText.matchAll(/\$\{([^}]+)\}/g)) {
  if (!["baseUrl", "version"].includes(placeholder[1])) {
    issues.push(`skills template contains an unknown placeholder: ${placeholder[0]}`);
  }
}

for (const deprecated of [
  "typedAnalyticsOperations",
  "endpoints",
  "openapiUrl",
  "agentGuidance",
  "errorHandling",
  "common_query_parameters",
  "typical_workflow",
  "implementation_notes",
]) {
  if (Object.hasOwn(skills, deprecated)) {
    issues.push(`skills.json must not expose deprecated manifest field: ${deprecated}`);
  }
}

const publicOperationIds = new Map(
  operations
    .filter(({ operation }) => typeof operation.operationId === "string")
    .map(({ method, path, operation }) => [
      operation.operationId,
      { method, path, operation },
    ]),
);
const referencedOperationIds = new Set();
const referenceOperation = (operationId, location) => {
  if (typeof operationId !== "string" || operationId.length === 0) {
    issues.push(`${location} must contain a non-empty operationId`);
    return;
  }
  if (!publicOperationIds.has(operationId)) {
    issues.push(`${location} references unknown OpenAPI operationId: ${operationId}`);
    return;
  }
  referencedOperationIds.add(operationId);
};
const referenceOperationList = (value, location) => {
  if (!Array.isArray(value)) {
    issues.push(`${location} must be an operationId array`);
    return;
  }
  value.forEach((operationId, index) =>
    referenceOperation(operationId, `${location}[${index}]`),
  );
};

referenceOperationList(
  skills.discovery?.sessionInitialization,
  "skills.discovery.sessionInitialization",
);
referenceOperation(
  skills.discovery?.siteAnalyticsSchema,
  "skills.discovery.siteAnalyticsSchema",
);
referenceOperation(
  skills.discovery?.teamAnalyticsSchema,
  "skills.discovery.teamAnalyticsSchema",
);
referenceOperation(skills.discovery?.health, "skills.discovery.health");

const stateMutationIds = new Set(
  [...publicOperationIds.entries()]
    .filter(([, { method, operation }]) =>
      ["patch", "delete"].includes(method) || Boolean(operation.responses?.["201"]),
    )
    .map(([operationId]) => operationId),
);
const recipes = skills.taskRecipes;
if (!Array.isArray(recipes) || recipes.length === 0) {
  issues.push("skills.json must define taskRecipes");
} else {
  const recipeIds = new Set();
  for (const recipe of recipes) {
    const location = `skills.taskRecipes.${recipe?.id ?? "unknown"}`;
    for (const field of [
      "id",
      "intent",
      "scope",
      "requiredContext",
      "preparation",
      "operations",
      "decisionBranches",
      "result",
    ]) {
      if (!(field in (recipe ?? {}))) {
        issues.push(`${location} is missing ${field}`);
      }
    }
    if (typeof recipe?.id !== "string" || recipe.id.length === 0) {
      issues.push(`${location} must have a non-empty id`);
    } else if (recipeIds.has(recipe.id)) {
      issues.push(`skills.json contains duplicate task recipe id: ${recipe.id}`);
    } else {
      recipeIds.add(recipe.id);
    }
    if (!["site", "team", "integration"].includes(recipe?.scope)) {
      issues.push(`${location} must use site, team, or integration scope`);
    }
    for (const field of ["requiredContext", "decisionBranches"]) {
      if (!Array.isArray(recipe?.[field])) {
        issues.push(`${location}.${field} must be an array`);
      }
    }
    referenceOperationList(recipe?.preparation, `${location}.preparation`);
    referenceOperationList(recipe?.operations, `${location}.operations`);

    const operationIds = [...(recipe?.preparation ?? []), ...(recipe?.operations ?? [])];
    const rawRecipe = JSON.stringify(recipe);
    if (/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//.test(rawRecipe) ||
      /\/api\/|\/collect|\/script\.js/.test(rawRecipe)) {
      issues.push(`${location} must reference operations by operationId, not method or path`);
    }
    if (
      operationIds.some((operationId) => String(operationId).startsWith("site.analytics.")) &&
      !recipe?.preparation?.includes("site.analytics.schema")
    ) {
      issues.push(`${location} must prepare site.analytics.schema before site analytics`);
    }
    if (
      operationIds.some((operationId) => String(operationId).startsWith("team.analytics.")) &&
      !recipe?.preparation?.includes("team.analytics.schema")
    ) {
      issues.push(`${location} must prepare team.analytics.schema before team analytics`);
    }
    if (
      operationIds.some((operationId) => stateMutationIds.has(operationId)) &&
      recipe?.requiresConfirmation !== true
    ) {
      issues.push(`${location} contains a state mutation but does not require confirmation`);
    }
  }
}

for (const operationId of publicOperationIds.keys()) {
  if (!referencedOperationIds.has(operationId)) {
    issues.push(`skills.json does not cover public OpenAPI operationId: ${operationId}`);
  }
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
