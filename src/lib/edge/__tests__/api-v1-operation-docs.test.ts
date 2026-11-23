import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { apiV1RouteRegistry } from "@/lib/api-v1/application/route-registry";

import { buildApiV1OpenApiPaths } from "../../../../scripts/api-v1-openapi";
import {
  apiV1OperationDocs,
  apiV1PathParameterAliases,
  apiV1TagDocs,
} from "../../../../scripts/api-v1-operation-docs";

/** Placeholder values for path parameters when validating request examples. */
const pathParameterValues: Record<string, string> = {
  siteId: "site_123",
  funnelId: "fnl_123",
  goalId: "gol_123",
  savedFilterId: "flt_123",
  dimension: "page.path",
};

const exposedRoutes = apiV1RouteRegistry.filter(
  (route) => route.lifecycle === "exposed",
);

function operationIdOf(route: (typeof exposedRoutes)[number]): string {
  return "operationId" in route ? route.operationId : route.id;
}

describe("API v1 operation docs", () => {
  it("documents every exposed operation and nothing else", () => {
    const operationIds = exposedRoutes.map(operationIdOf).sort();
    expect(Object.keys(apiV1OperationDocs).sort()).toEqual(operationIds);
  });

  it("publishes human-written summaries and descriptions", () => {
    for (const [operationId, doc] of Object.entries(apiV1OperationDocs)) {
      expect(doc.summary, operationId).not.toMatch(/^API v1 /);
      expect(doc.summary.length, operationId).toBeLessThanOrEqual(60);
      expect(doc.description, operationId).not.toContain(
        "Typed API v1 operation",
      );
      expect(doc.description.length, operationId).toBeGreaterThan(10);
    }
  });

  it("assigns every operation to a documented tag", () => {
    const tags = new Set<string>(apiV1TagDocs.map((tag) => tag.name));
    for (const pathItem of Object.values(buildApiV1OpenApiPaths())) {
      for (const operation of Object.values(pathItem)) {
        expect(tags.has(operation.tags[0]), operation.operationId).toBe(true);
      }
    }
  });

  it("uses request examples that the route accepts", () => {
    for (const route of exposedRoutes) {
      const operationId = operationIdOf(route);
      const example = apiV1OperationDocs[operationId]?.requestExample;
      if (!example) continue;
      expect("requestSchema" in route, operationId).toBe(true);
      const schema = (route as { requestSchema: z.ZodType }).requestSchema;
      const aliases = apiV1PathParameterAliases[operationId] ?? {};
      const pathValues: Record<string, string> = {};
      for (const match of route.path.matchAll(/\{([^}]+)\}/g)) {
        const name = match[1];
        const field =
          Object.entries(aliases).find(
            ([, parameter]) => parameter === name,
          )?.[0] ?? name;
        pathValues[field] = pathParameterValues[name] ?? `${name}_123`;
      }
      const result = schema.safeParse({ ...pathValues, ...example });
      const withoutPath = schema.safeParse(example);
      expect(
        result.success || withoutPath.success,
        `${operationId}: ${JSON.stringify(result.error?.issues ?? [])}`,
      ).toBe(true);
    }
  });

  it("publishes the documented request example in the OpenAPI operation", () => {
    for (const pathItem of Object.values(buildApiV1OpenApiPaths())) {
      for (const operation of Object.values(pathItem)) {
        const example =
          apiV1OperationDocs[operation.operationId]?.requestExample;
        if (!example) continue;
        const content = (
          operation.requestBody as
            { content?: Record<string, { example?: unknown }> } | undefined
        )?.content?.["application/json"];
        expect(content?.example, operation.operationId).toEqual(example);
      }
    }
  });
});
