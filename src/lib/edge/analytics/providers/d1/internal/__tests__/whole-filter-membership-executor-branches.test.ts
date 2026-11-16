// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

import {
  createQueryTime,
  createTimeRange,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import { createScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import type { Env } from "@/lib/edge/types";
import type {
  FilterDocument,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  activities: vi.fn(),
  payloads: vi.fn(),
  evaluate: vi.fn(),
}));

vi.mock("@/lib/edge/analytics/engine/whole-filter-membership-jobs", () => ({
  planWholeFilterMembershipJobs: mocks.plan,
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/advanced-filter-activity-query",
  () => ({ queryAdvancedFilterActivityRange: mocks.activities }),
);
vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/advanced-filter-payload-query",
  () => ({ queryAdvancedFilterPayloadNodes: mocks.payloads }),
);
vi.mock(
  import("@/lib/filter-contract/filter-evaluator"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    evaluateFilterDocument: mocks.evaluate,
  }),
);

import { evaluateWholeFilterMembership } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";

const siteId = "site-a" as SiteId;
const subject = createSemanticSubjectDomain({
  origin: "site",
  siteIds: [siteId],
});
const time = createQueryTime(1_000, 2_000, "UTC", 5_000);
const coverage = new Map([[siteId as string, 500]]);
const env = {} as Env;

const field = (id: string) => ({ kind: "field", field: id });
const payload = (path: string) => ({ kind: "event-payload", path });

function document(...targets: unknown[]): FilterDocument {
  return {
    version: 1,
    root: {
      kind: "and",
      children: targets.map((target) => ({
        kind: "condition",
        target: target as FilterTargetExpression,
        operator: "exists",
      })),
    },
  } as unknown as FilterDocument;
}

function run(
  filters: FilterDocument,
  overrides: Partial<{
    time: QueryTime;
    signal: AbortSignal;
    scope: "session" | "event";
  }> = {},
) {
  const plan = createScopedFilterPlan(
    "channels",
    filters,
    overrides.scope ?? "session",
  );
  if (!plan) throw new Error("scope plan expected");
  return evaluateWholeFilterMembership({
    env,
    subject,
    siteIds: [siteId],
    filters,
    plan,
    time: overrides.time ?? time,
    coverage,
    signal: overrides.signal,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.plan.mockReturnValue({
    execution: { decision: { strategy: "bounded-core", coreBounds: {} } },
    jobs: [{ kind: "bounded-original-core", bounds: {} }],
  });
  mocks.activities.mockResolvedValue([]);
  mocks.payloads.mockResolvedValue([]);
  mocks.evaluate.mockReturnValue({
    matchingVisitIds: [],
    matchingEventIds: [],
    matchingScopeEntityIds: [],
  });
});

it("collects payload paths through every nested target kind", async () => {
  const filters = document(
    { kind: "member", object: payload("/m"), member: "payload" },
    { kind: "context-intrinsic", intrinsic: "same", input: payload("/same") },
    { kind: "context-intrinsic", intrinsic: "other", input: payload("/skip") },
    { kind: "occurrence-time", input: payload("/occ") },
    {
      kind: "selector",
      collection: payload("/sel"),
      predicate: {
        kind: "not",
        child: {
          kind: "condition",
          target: payload("/pred"),
          operator: "exists",
        },
      },
    },
    { kind: "projection", collection: payload("/proj-a"), member: "path" },
    { kind: "reducer", input: payload("/red") },
    { kind: "arithmetic", left: payload("/l"), right: payload("/r") },
    { kind: "bucket", input: payload("/bucket") },
    { kind: "window", collection: payload("/wc"), anchor: payload("/wa") },
    { kind: "periods", collection: payload("/per") },
    { kind: "sequence", steps: [payload("/s1"), payload("/s2")] },
    { kind: "adjacent", sequence: payload("/adj") },
    { kind: "without", sequence: payload("/ws"), excluded: payload("/wx") },
    field("page.path"),
    payload("/inner"),
  );
  // A comparison value which is itself a target is traversed as well.
  (filters.root as unknown as { children: unknown[] }).children.push({
    kind: "condition",
    target: field("page.path"),
    operator: "eq",
    value: payload("/value-target"),
  });
  await run(filters);
  expect(mocks.payloads).toHaveBeenCalledTimes(1);
  const call = mocks.payloads.mock.calls[0]![0];
  expect(call.wholePayload).toBe(true);
  expect(call.paths).toEqual(
    [
      "/m",
      "/same",
      "/occ",
      "/sel",
      "/pred",
      "/proj-a",
      "/red",
      "/l",
      "/r",
      "/bucket",
      "/wc",
      "/wa",
      "/per",
      "/s1",
      "/s2",
      "/adj",
      "/ws",
      "/wx",
      "/inner",
      "/value-target",
    ].sort(),
  );
  expect(call.paths).not.toContain("/skip");
});

it("requests the whole payload for a path-less payload projection only", async () => {
  await run(
    document({
      kind: "projection",
      collection: field("x"),
      member: "payload",
    }),
  );
  expect(mocks.payloads.mock.calls[0]![0]).toMatchObject({
    paths: [],
    wholePayload: true,
  });
  mocks.payloads.mockClear();
  await run(
    document({
      kind: "projection",
      collection: field("x"),
      member: "payload",
      path: "/p",
    }),
  );
  expect(mocks.payloads.mock.calls[0]![0]).toMatchObject({
    paths: ["/p"],
    wholePayload: false,
  });
});

it("rejects an activity result above the activity limit", async () => {
  mocks.activities.mockResolvedValue(
    Array.from({ length: 20_001 }, () => ({})),
  );
  await expect(run(document(field("page.path")))).rejects.toMatchObject({
    domainError: {
      issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
    },
  });
});

it("rejects a payload node result above the node limit", async () => {
  mocks.payloads.mockResolvedValue(Array.from({ length: 50_001 }, () => ({})));
  await expect(run(document(payload("/p")))).rejects.toMatchObject({
    domainError: {
      issues: [{ path: "filters", code: "filter_payload_node_limit_exceeded" }],
    },
  });
});

it("observes an already aborted signal before any activity or payload read", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    run(document(payload("/p")), { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.activities).not.toHaveBeenCalled();
  expect(mocks.payloads).not.toHaveBeenCalled();
});

it("rejects a read range extending past the captured instant", async () => {
  await expect(
    run(document(field("page.path")), {
      time: { ...time, readRange: createTimeRange(1_000, 9_000) },
    }),
  ).rejects.toMatchObject({
    domainError: {
      issues: [
        { path: "readRange", code: "filter_evaluation_range_unavailable" },
      ],
    },
  });
  expect(mocks.activities).not.toHaveBeenCalled();
});

it("skips evaluation for a site whose explicit filter range is inverted", async () => {
  const result = await run(document(field("page.path")), {
    time: { ...time, filterRange: { startMs: 1_800, endExclusiveMs: 1_200 } },
  });
  expect(result).toEqual([]);
  expect(mocks.evaluate).not.toHaveBeenCalled();
});

it("maps evaluator limit errors to input errors and rethrows others", async () => {
  mocks.evaluate.mockImplementation(() => {
    throw new Error("filter_evaluation_range_unavailable");
  });
  await expect(run(document(field("page.path")))).rejects.toMatchObject({
    domainError: {
      issues: [
        { path: "readRange", code: "filter_evaluation_range_unavailable" },
      ],
    },
  });
  for (const code of [
    "filter_activity_limit_exceeded",
    "filter_sequence_match_limit_exceeded",
    "filter_sequence_work_limit_exceeded",
  ]) {
    mocks.evaluate.mockImplementation(() => {
      throw new Error(code);
    });
    await expect(run(document(field("page.path")))).rejects.toMatchObject({
      domainError: { issues: [{ path: "filters", code }] },
    });
  }
  const unexpected = new Error("boom");
  mocks.evaluate.mockImplementation(() => {
    throw unexpected;
  });
  await expect(run(document(field("page.path")))).rejects.toBe(unexpected);
  mocks.evaluate.mockImplementation(() => {
    throw "not-an-error";
  });
  await expect(run(document(field("page.path")))).rejects.toBe("not-an-error");
});

it("reads no payloads for an empty filter root and still evaluates each site", async () => {
  await run({ version: 1, root: null } as unknown as FilterDocument);
  expect(mocks.payloads).not.toHaveBeenCalled();
  expect(mocks.activities).toHaveBeenCalledTimes(1);
  expect(mocks.evaluate).toHaveBeenCalledTimes(1);
});
