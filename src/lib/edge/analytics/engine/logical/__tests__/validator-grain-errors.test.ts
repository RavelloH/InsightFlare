import { describe, expect, it } from "vitest";

import {
  type LogicalPlan,
  LogicalPlanError,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine/logical";

import {
  clone,
  createBuilder,
  edit,
  H,
  moveLast,
  type Obj,
  slotsOf,
  W,
} from "./validator-fixtures";

function expectIssue(plan: LogicalPlan, code: string, message: string): void {
  try {
    validateLogicalPlan(plan);
  } catch (error) {
    expect(error).toBeInstanceOf(LogicalPlanError);
    const issues = (error as LogicalPlanError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(code);
    expect(issues[0]!.message).toContain(message);
    return;
  }
  throw new Error("expected_logical_plan_error");
}

describe("logical plan validator grain and topology rules", () => {
  it("accepts projections over keyed and event relations", () => {
    const keyed = W.plan.nodes.find((node) => node.id === H.projectedKeyed.id);
    expect(keyed?.grain.kind).toBe("keyed");
    expect(H.projectedEvents.grain.kind).toBe("entity");
    expect(H.projectedScalar.grain.kind).toBe("scalar");
    expect(validateLogicalPlan(clone(W.plan))).toBeDefined();
  });

  it("rejects keyed grains without keys", () => {
    expectIssue(
      edit(H.distinct, (n) => {
        n.keys = [];
        n.output = [];
        n.grain = { kind: "keyed", keys: [] };
      }),
      "invalid-grain",
      "Keyed grain must contain unique visible keys",
    );
  });

  it("rejects duplicated node output slots", () => {
    expectIssue(
      edit(H.filtered, (n) => {
        n.output = [n.output[0], n.output[0]];
      }),
      "invalid-topology",
      "Output slot is duplicated",
    );
  });

  it("rejects joins whose right side is a bag", () => {
    expectIssue(
      edit(H.inner, (n) => {
        n.right = H.appended.id;
        n.keys = [
          {
            left: slotsOf(H.grouped, "views"),
            right: slotsOf(H.appended, "n"),
          },
        ];
      }),
      "invalid-join",
      "do not cover right grain",
    );
  });

  it("rejects joins to keyed relations with non scalar keys", () => {
    expectIssue(
      edit(H.inner, (n, plan) => {
        n.left = H.pages.id;
        n.right = H.entityKeyed.id;
        n.keys = [
          {
            left: slotsOf(H.pages, "entity"),
            right: slotsOf(H.entityKeyed, "entity"),
          },
          {
            left: slotsOf(H.pages, "attribute:page.report.pathname"),
            right: slotsOf(H.entityKeyed, "path"),
          },
        ];
        moveLast(plan, n);
      }),
      "invalid-join",
      "scalar or bucket grain and key slots",
    );
  });

  it("rejects source bindings and outputs that are not declared", () => {
    expectIssue(
      edit(H.pages, (n) => {
        n.values[1] = { ...n.values[1], slot: "ghost" };
      }),
      "invalid-source",
      "Source binding slot is not declared",
    );
    expectIssue(
      edit(H.projected, (n) => {
        n.projections[0] = { ...n.projections[0], slot: "ghost" };
      }),
      "invalid-topology",
      "Projection output slot is not declared",
    );
    expectIssue(
      edit(H.grouped, (n) => {
        n.groups[0] = { ...n.groups[0], slot: "ghost" };
      }),
      "invalid-topology",
      "Group output slot is not declared",
    );
    expectIssue(
      edit(H.grouped, (n) => {
        n.measures[0] = { ...n.measures[0], output: "ghost" };
      }),
      "invalid-topology",
      "Measure output slot is not declared",
    );
    expectIssue(
      edit(H.distinct, (n) => {
        n.keys[0] = { ...n.keys[0], output: "ghost" };
      }),
      "invalid-topology",
      "Distinct output slot is not declared",
    );
  });

  it("rejects payload property reads over non-transparent Event relations", () => {
    expectIssue(
      edit(H.properties, (n) => {
        n.input = H.projectedEvents.id;
        n.eventKey = slotsOf(H.projectedEvents, "entity");
      }),
      "invalid-source",
      "canonical Event entity relation",
    );
  });

  it("rejects set operations with mismatched positional types or grain keys", () => {
    expectIssue(
      edit(H.union2, (n) => {
        n.inputs[1] = H.setB.id;
      }),
      "invalid-expression",
      "Set input slot types must match by position",
    );
    expectIssue(
      edit(H.union2, (n) => {
        n.inputs = [H.ordered.id, H.ordered2.id];
      }),
      "invalid-grain",
      "grain keys must occupy matching output positions",
    );
  });

  it("rejects ranked members over non-scalar keyed grains", () => {
    const entity = slotsOf(H.entityKeyed, "entity");
    expectIssue(
      edit(H.ranked, (n) => {
        n.input = H.entityKeyed.id;
        n.groups = [entity];
      }),
      "invalid-expression",
      "partition keys must be scalar slots",
    );
    expectIssue(
      edit(H.ranked, (n) => {
        n.input = H.entityKeyed.id;
        n.groups = [];
        n.order = [{ slot: entity, direction: "asc", nulls: "last" }];
      }),
      "invalid-expression",
      "order keys must be scalar slots",
    );
  });
});

describe("logical analysis-result import grain rules", () => {
  it("rejects child outputs whose relation is neither scalar nor keyed", () => {
    const child = createBuilder();
    const pages = child.source("page", { attributes: ["page.path"] });
    const grouped = child.aggregate(
      pages,
      { key: child.slot(pages, "attribute:page.path") },
      [{ name: "rows", kind: "count-rows" }],
    );
    child.output("rollup", grouped, [
      { name: "key", slot: "key" },
      { name: "rows", slot: "rows" },
    ]);
    const childPlan = child.finish();

    const parent = createBuilder();
    const imported = parent.importAnalysisResult(childPlan, "rollup", [
      { field: "key" },
      { field: "rows" },
    ]);
    parent.output("imported", imported, [
      { name: "key", slot: "key" },
      { name: "rows", slot: "rows" },
    ]);
    const plan = clone(parent.finish()) as Obj;
    const node = plan.nodes.find(
      (item: Obj) => item.kind === "analysis-result",
    );
    const source = node.childPlan.nodes.find(
      (item: Obj) => item.kind === "source",
    );
    node.childPlan.outputs[0] = {
      id: "rollup",
      relation: source.id,
      fields: [{ name: "key", slot: source.values[0].slot }],
    };
    expectIssue(
      plan as LogicalPlan,
      "invalid-grain",
      "Only scalar or keyed analysis results may be imported",
    );
  });
});
