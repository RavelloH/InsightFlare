import { describe, expect, it } from "vitest";

import {
  type LogicalPlan,
  LogicalPlanError,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine/logical";

import {
  clone,
  edit,
  editSlot,
  H,
  type Handle,
  nodeIndex,
  type Obj,
  slotsOf,
  W,
} from "./validator-fixtures";

function issueOf(plan: LogicalPlan) {
  try {
    validateLogicalPlan(plan);
  } catch (error) {
    expect(error).toBeInstanceOf(LogicalPlanError);
    const issues = (error as LogicalPlanError).issues;
    expect(issues).toHaveLength(1);
    return issues[0]!;
  }
  throw new Error("expected_logical_plan_error");
}

function expectIssue(
  plan: LogicalPlan,
  code: string,
  message: string,
  path?: string,
): void {
  const issue = issueOf(plan);
  expect(issue.code).toBe(code);
  expect(issue.message).toContain(message);
  if (path !== undefined) expect(issue.path).toBe(path);
}

describe("logical plan validator fixture", () => {
  it("accepts the unmodified multi-node plan", () => {
    expect(validateLogicalPlan(clone(W.plan))).toBeDefined();
    expect(W.plan.nodes.length).toBeGreaterThan(25);
  });
});

describe("logical plan validator envelope and outputs", () => {
  it("rejects cyclic, accessor-based and malformed envelopes", () => {
    const cyclic = clone(W.plan) as Obj;
    cyclic.self = cyclic;
    expectIssue(cyclic as never, "invalid-envelope", "acyclic");
    const accessor = clone(W.plan) as Obj;
    Object.defineProperty(accessor, "trap", { get: () => 1, enumerable: true });
    expectIssue(accessor as never, "invalid-envelope", "data properties");
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile");
        },
      },
    );
    expectIssue(
      { ...clone(W.plan), proxy } as never,
      "invalid-envelope",
      "not safely inspectable",
    );
    expectIssue(
      { ...clone(W.plan), version: 2 } as never,
      "invalid-envelope",
      "envelope is invalid",
    );
    expectIssue(
      { ...clone(W.plan), nodes: undefined } as never,
      "invalid-envelope",
      "envelope is invalid",
    );
  });

  it("rejects invalid temporal, scope and subject contexts", () => {
    const time = clone(W.plan) as Obj;
    time.context.time = {};
    expectIssue(time as never, "invalid-envelope", "context is invalid");
    const scope = clone(W.plan) as Obj;
    scope.context.scope = { requested: "bogus" };
    expectIssue(scope as never, "invalid-envelope", "Resolved scope");
    const subject = clone(W.plan) as Obj;
    subject.context.subject = { origin: "site", siteIds: ["b", "a"] };
    expectIssue(subject as never, "invalid-envelope", "canonical site IDs");
    const noSubject = clone(W.plan) as Obj;
    noSubject.context.subject = undefined;
    expectIssue(noSubject as never, "invalid-envelope", "canonical site IDs");
  });

  it("rejects duplicate ids and multiple slot producers", () => {
    const slots = clone(W.plan) as Obj;
    slots.slots.push(slots.slots[0]);
    expectIssue(slots as never, "duplicate-id", "slot IDs must be unique");
    const nodes = clone(W.plan) as Obj;
    nodes.nodes.push(nodes.nodes[0]);
    expectIssue(nodes as never, "duplicate-id", "relation IDs must be unique");
    const shared = edit(H.filtered, () => undefined) as Obj;
    shared.nodes[nodeIndex(H.projected)].projections[1].slot =
      shared.nodes[nodeIndex(H.projected)].projections[0].slot;
    expectIssue(shared as never, "duplicate-id", "more than one producer");
  });

  it("validates declared outputs and semantic fields", () => {
    const withOutput = (mutate: (output: Obj) => void) => {
      const plan = clone(W.plan) as Obj;
      mutate(plan.outputs[0]);
      return plan as LogicalPlan;
    };
    expectIssue(
      withOutput((output) => {
        output.id = "";
      }),
      "invalid-output",
      "non-empty and unique",
    );
    const twice = clone(W.plan) as Obj;
    twice.outputs.push(clone(twice.outputs[0]));
    expectIssue(twice as never, "invalid-output", "non-empty and unique");
    expectIssue(
      withOutput((output) => {
        output.relation = "missing";
      }),
      "invalid-output",
      "Output relation does not exist",
    );
    expectIssue(
      withOutput((output) => {
        output.fields[1].name = output.fields[0].name;
      }),
      "invalid-output",
      "field names must be non-empty and unique",
    );
    expectIssue(
      withOutput((output) => {
        output.fields[0].slot = "missing";
      }),
      "invisible-slot",
      "not visible",
    );
    expectIssue(
      withOutput((output) => {
        output.fields[0].semantic = { kind: "dimension", id: "nope" };
      }),
      "invalid-output",
      "Unknown semantic dimension",
    );
    expectIssue(
      withOutput((output) => {
        output.fields[0].semantic = { kind: "dimension", id: "page.path" };
        output.fields[0].slot = slotsOf(H.grouped, "views");
      }),
      "invalid-output",
      "Dimension output slot does not match",
    );
    expectIssue(
      withOutput((output) => {
        output.fields[0].semantic = { kind: "metric", id: "nope" };
      }),
      "invalid-output",
      "registered public metric",
    );
    expectIssue(
      withOutput((output) => {
        output.fields[0].semantic = { kind: "metric", id: "views" };
        output.fields[0].slot = slotsOf(H.grouped, "path");
      }),
      "invalid-output",
      "Metric output slot does not match",
    );
  });
});
