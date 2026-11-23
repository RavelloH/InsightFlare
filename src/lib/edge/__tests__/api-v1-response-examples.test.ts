import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { apiV1RouteRegistry } from "@/lib/api-v1/application/route-registry";
import { ApiV1ResponseMetaSchema } from "@/lib/api-v1/contract/wire";

import { apiV1OperationDocs } from "../../../../scripts/api-v1-operation-docs";
import {
  childExampleContext,
  fitsSchema,
  rootExampleContext,
  ruleExample,
} from "../../../../scripts/api-v1-response-examples";

type OperationObject = {
  operationId?: string;
  responses?: Record<
    string,
    { content?: { "application/json"?: { example?: unknown } } }
  >;
};

const spec = JSON.parse(
  readFileSync(resolve(process.cwd(), "docs/openapi.json"), "utf8"),
) as { paths: Record<string, Record<string, OperationObject>> };

const exposedRoutes = apiV1RouteRegistry.filter(
  (route) => route.lifecycle === "exposed",
);

function successExample(
  route: (typeof exposedRoutes)[number],
): { operationId: string; example: unknown } | undefined {
  const operation = spec.paths[route.path]?.[route.method.toLowerCase()];
  if (!operation) return undefined;
  const response = operation.responses?.["200"] ?? operation.responses?.["201"];
  if (!response) return undefined;
  return {
    operationId: operation.operationId ?? route.id,
    example: response.content?.["application/json"]?.example,
  };
}

/** Mirror of successResponseSchema(): the registry schema is either the whole envelope or its data. */
function parseExample(schema: z.ZodType, example: unknown) {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (shape && "data" in shape && "meta" in shape) {
    return schema.safeParse(example);
  }
  const body = example as { data?: unknown; meta?: unknown };
  const meta = ApiV1ResponseMetaSchema.safeParse(body.meta);
  return meta.success ? schema.safeParse(body.data) : meta;
}

function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, into));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => collectStrings(v, into));
  }
  return into;
}

describe("API v1 response examples", () => {
  const withExamples = exposedRoutes.flatMap((route) => {
    const found = successExample(route);
    return found ? [{ route, ...found }] : [];
  });

  it("publishes a success example for every operation that returns a body", () => {
    expect(withExamples.length).toBeGreaterThan(70);
    for (const { operationId, example } of withExamples) {
      expect(example, operationId).toBeTruthy();
    }
  });

  it("uses examples that the route response schema accepts", () => {
    for (const { route, operationId, example } of withExamples) {
      const schema = (route as { responseSchema?: z.ZodType }).responseSchema;
      if (!schema) continue;
      const result = parseExample(schema, example);
      expect(
        result.success,
        `${operationId}: ${JSON.stringify(result.error?.issues.slice(0, 3))}`,
      ).toBe(true);
    }
  });

  it("no longer uses the placeholder string 'example'", () => {
    for (const { operationId, example } of withExamples) {
      const offenders = collectStrings(example).filter(
        (text) => text === "example" || /^example(?![.\w-])/i.test(text),
      );
      expect(offenders, operationId).toEqual([]);
    }
  });

  it("keeps hand-written response examples valid", () => {
    for (const [operationId, doc] of Object.entries(apiV1OperationDocs)) {
      if (!doc.responseExample) continue;
      const route = exposedRoutes.find(
        (candidate) =>
          ("operationId" in candidate
            ? candidate.operationId
            : candidate.id) === operationId,
      );
      expect(route, operationId).toBeDefined();
      const schema = (route as { responseSchema: z.ZodType }).responseSchema;
      const result = parseExample(schema, doc.responseExample);
      expect(
        result.success,
        `${operationId}: ${JSON.stringify(result.error?.issues.slice(0, 3))}`,
      ).toBe(true);
    }
  });

  it("produces self-consistent metrics in published examples", () => {
    const overview = withExamples.find(
      (entry) => entry.operationId === "site.analytics.overview",
    )?.example as {
      data: {
        views: number;
        sessions: number;
        visitors: number;
        bounces: number;
        bounceRate: number;
      };
      meta: { timeRange: { from: string; to: string } };
    };
    expect(overview.data.views).toBeGreaterThanOrEqual(overview.data.sessions);
    expect(overview.data.sessions).toBeGreaterThanOrEqual(
      overview.data.visitors,
    );
    expect(overview.data.bounceRate).toBeCloseTo(
      overview.data.bounces / overview.data.sessions,
      3,
    );
    expect(Date.parse(overview.meta.timeRange.from)).toBeLessThan(
      Date.parse(overview.meta.timeRange.to),
    );
  });

  it("varies array items by index", () => {
    const breakdown = withExamples.find(
      (entry) => entry.operationId === "site.analytics.breakdown",
    )?.example as { data: { items: Array<{ key: string; views: number }> } };
    const items = breakdown.data.items;
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
    expect(items[0].views).toBeGreaterThan(items[1].views);
  });

  it("orders performance percentiles", () => {
    const summary = withExamples.find(
      (entry) => entry.operationId === "site.analytics.performanceSummary",
    )?.example as {
      data: { metrics: Record<string, Record<string, number>> };
    };
    for (const stats of Object.values(summary.data.metrics)) {
      expect(stats.p50).toBeLessThanOrEqual(stats.p75);
      expect(stats.p75).toBeLessThanOrEqual(stats.p95);
    }
  });
});

describe("response example rules", () => {
  it("only emits rule values that satisfy schema constraints", () => {
    const ctx = childExampleContext(rootExampleContext("sites.get"), "country");
    const value = ruleExample("country", ctx, "string");
    expect(value).toBe("US");
    expect(fitsSchema(value, { type: "string", maxLength: 1 })).toBe(false);
    expect(fitsSchema(0.5, { type: "integer" })).toBe(false);
    expect(fitsSchema(5, { type: "number", exclusiveMinimum: 5 })).toBe(false);
    expect(fitsSchema("abc", { type: "string", pattern: "^[0-9]+$" })).toBe(
      false,
    );
  });
});
