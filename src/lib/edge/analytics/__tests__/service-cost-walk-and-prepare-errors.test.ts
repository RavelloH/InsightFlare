import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as CostModule from "@/lib/edge/analytics/application/cost";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { TypedQueryApplicationService } from "@/lib/edge/analytics/application/service";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type * as ScopedFilterModule from "@/lib/edge/analytics/contract/scoped-filter";
import { InvalidCursorError } from "@/lib/pagination";

const hoisted = vi.hoisted(() => ({
  costInputs: [] as Array<Record<string, unknown>>,
  prepare: null as null | ((operation: string, query: unknown) => unknown),
  validations: [] as unknown[],
}));

vi.mock("@/lib/edge/analytics/application/cost", async (importOriginal) => {
  const actual = await importOriginal<typeof CostModule>();
  return {
    ...actual,
    calculateQueryCost: (
      input: Record<string, unknown>,
      policy: Parameters<typeof actual.calculateQueryCost>[1],
    ) => {
      hoisted.costInputs.push(input);
      return actual.calculateQueryCost(input as never, policy);
    },
  };
});
vi.mock(
  "@/lib/edge/analytics/contract/scoped-filter",
  async (importOriginal) => {
    const actual = await importOriginal<typeof ScopedFilterModule>();
    return {
      ...actual,
      prepareScopedQuery: (operation: string, query: unknown) =>
        hoisted.prepare
          ? hoisted.prepare(operation, query)
          : actual.prepareScopedQuery(operation as never, query as never),
    };
  },
);
vi.mock("@/lib/edge/analytics/application/query-validation", () => ({
  validateTypedQueryInput: () => hoisted.validations.shift() ?? null,
}));

const time = createQueryTime(1_000, 2_000, "UTC", 2_000);
const context = siteQueryContext("site-1", "private-dashboard");
const field = (name: string) => ({ kind: "field", field: name });
const cond = (target: unknown, value?: unknown) => ({
  kind: "condition",
  target,
  operator: "eq",
  value,
});

async function run(root: unknown) {
  hoisted.prepare = (_operation, query) => query;
  const service = new TypedQueryApplicationService();
  return service.execute(
    {
      kind: "typed-query",
      operation: "overview",
      query: {
        context,
        time,
        filters: { ...EMPTY_FILTER_DOCUMENT, root },
      } as never,
      providerRegistry: new AnalyticsProviderRegistry().register("overview", {
        execute: (async () => ({
          value: { current: {} },
          source: "raw" as const,
        })) as never,
      }),
    },
    { cost: { rangeMs: 1, provider: "d1" } },
  );
}

describe("TypedQueryApplicationService cost-dimension walk", () => {
  beforeEach(() => {
    hoisted.costInputs.length = 0;
    hoisted.prepare = null;
  });

  it("walks every nested target kind and records depth and node count", async () => {
    const leaf = field("page.path");
    const target = {
      kind: "context-intrinsic",
      intrinsic: "same",
      input: {
        kind: "occurrence-time",
        input: {
          kind: "member",
          object: {
            kind: "selector",
            collection: {
              kind: "projection",
              collection: {
                kind: "reducer",
                input: {
                  kind: "arithmetic",
                  left: { kind: "bucket", input: leaf },
                  right: {
                    kind: "window",
                    collection: leaf,
                    anchor: { kind: "periods", collection: leaf },
                  },
                },
              },
            },
            predicate: cond(leaf, 1),
          },
          member: "x",
        },
      },
    };
    const result = await run(cond(target));
    expect(result.ok).toBe(true);
    const input = hoisted.costInputs[0]!;
    expect(input.expressionDepth).toBeGreaterThanOrEqual(10);
    expect(input.filterComplexity).toBeGreaterThanOrEqual(14);
    expect(input.relationStepCount).toBe(1);
  });

  it("counts relation sequence steps, adjacency, exclusion, and target-valued conditions", async () => {
    const sequence = {
      kind: "sequence",
      steps: [field("a"), field("b"), field("c")],
    };
    const root = {
      kind: "and",
      children: [
        cond({ kind: "adjacent", sequence }, 1),
        cond(
          { kind: "without", sequence, excluded: field("d") },
          { kind: "bucket", input: field("e") },
        ),
        { kind: "not", child: cond(field("f"), ["x"]) },
      ],
    };
    const result = await run(root);
    expect(result.ok).toBe(true);
    const input = hoisted.costInputs[0]!;
    // two 3-step sequences: 1 + 3 + 3
    expect(input.relationStepCount).toBe(7);
    // (3 - 1) ** 3 = 8, then 8 * 8 would exceed; each multiplies
    expect(input.relationMatchScale).toBe(64);
    expect(input.filterComplexity).toBeGreaterThan(10);
  });

  it("caps the relation match scale at one million", async () => {
    const steps = Array.from({ length: 12 }, (_, i) => field(`s${i}`));
    const result = await run(cond({ kind: "sequence", steps }, 1));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "query-cost-exceeded" },
    });
    expect(hoisted.costInputs[0]!.relationMatchScale).toBe(1_000_000);
    expect(hoisted.costInputs[0]!.relationStepCount).toBe(13);
  });
});

describe("TypedQueryApplicationService scoped query preparation errors", () => {
  beforeEach(() => {
    hoisted.costInputs.length = 0;
  });

  it("maps InvalidCursorError from query preparation to invalid-cursor", async () => {
    hoisted.prepare = () => {
      throw new InvalidCursorError("sessions");
    };
    const events: string[] = [];
    const result = await new TypedQueryApplicationService().execute(
      {
        kind: "typed-query",
        operation: "overview",
        query: { context, time, filters: EMPTY_FILTER_DOCUMENT } as never,
        providerRegistry: new AnalyticsProviderRegistry(),
      },
      { onEvent: (event) => events.push(event.phase) },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "invalid-cursor", cursorKind: "sessions" },
    });
    expect(events).toEqual(["start", "failure"]);
  });

  it("maps filter-time and scope planning failures to invalid-input paths", async () => {
    const execute = (thrown: unknown) => {
      hoisted.prepare = () => {
        throw thrown;
      };
      return new TypedQueryApplicationService().execute({
        kind: "typed-query",
        operation: "overview",
        query: { context, time, filters: EMPTY_FILTER_DOCUMENT } as never,
        providerRegistry: new AnalyticsProviderRegistry(),
      });
    };
    expect(await execute(new Error("filter_time_unsupported"))).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_time_unsupported" }],
      },
    });
    expect(await execute("boom")).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [{ path: "scope", code: "invalid_filter_scope" }],
      },
    });
  });

  it("rejects a prepared query that fails the second validation pass", async () => {
    const issue = {
      kind: "invalid-input",
      issues: [{ path: "scope", code: "x" }],
    };
    hoisted.prepare = (_operation, query) => query;
    hoisted.validations = [null, issue];
    const events: string[] = [];
    const result = await new TypedQueryApplicationService().execute(
      {
        kind: "typed-query",
        operation: "overview",
        query: { context, time, filters: EMPTY_FILTER_DOCUMENT } as never,
        providerRegistry: new AnalyticsProviderRegistry(),
      },
      { onEvent: (event) => events.push(event.phase) },
    );
    expect(result).toEqual({ ok: false, error: issue });
    expect(events).toEqual(["start", "failure"]);
  });
});
