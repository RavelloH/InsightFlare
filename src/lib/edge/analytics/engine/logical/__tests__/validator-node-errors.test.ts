import { describe, expect, it } from "vitest";

import {
  type LogicalPlan,
  LogicalPlanError,
  validateLogicalPlan,
} from "@/lib/edge/analytics/engine/logical";

import {
  edit,
  editSlot,
  H,
  type Handle,
  nodeIndex,
  type Obj,
  slotsOf,
  W,
} from "./validator-fixtures";

function expectIssue(
  plan: LogicalPlan,
  code: string,
  message: string,
  path?: string,
): void {
  try {
    validateLogicalPlan(plan);
  } catch (error) {
    expect(error).toBeInstanceOf(LogicalPlanError);
    const issues = (error as LogicalPlanError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(code);
    expect(issues[0]!.message).toContain(message);
    if (path !== undefined) expect(issues[0]!.path).toBe(path);
    return;
  }
  throw new Error("expected_logical_plan_error");
}

const exprSlot = (id: string) => ({ kind: "slot", slot: id });
const stringLiteral = {
  kind: "literal",
  value: "x",
  valueType: { kind: "scalar", scalar: "string" },
};
const nodeOf = (handle: Handle) => W.plan.nodes[nodeIndex(handle)] as Obj;
const flipNullable = (slot: Obj) => {
  slot.nullable = !slot.nullable;
};

describe("logical plan validator sources", () => {
  const sourceCases: readonly (readonly [
    string,
    Handle,
    (node: Obj, plan: Obj) => void,
    string,
    string,
  ])[] = [
    [
      "selection on non page/event source",
      H.sessions,
      (node) => {
        node.selection = { profile: "prepared-scoped-v1" };
      },
      "invalid-source",
      "only on Page and Event Sources",
    ],
    [
      "page profile on event source",
      H.eventsOnly,
      (node) => {
        node.selection = { profile: "direct-page-analytics-v1" };
      },
      "invalid-source",
      "profile does not match its Source entity",
    ],
    [
      "unknown page profile",
      H.pages,
      (node) => {
        node.selection = { profile: "bogus" };
      },
      "invalid-source",
      "profile does not match its Source entity",
    ],
    [
      "event name gate on prepared page selection",
      H.pages,
      (node) => {
        node.selection = {
          profile: "prepared-scoped-v1",
          eventNameGate: "pricing",
        };
      },
      "invalid-source",
      "page_selection_event_name_unsupported",
    ],
    [
      "incomplete scoped selection",
      H.pages,
      (node) => {
        node.selection = { profile: "prepared-scoped-v1" };
      },
      "invalid-source",
      "",
    ],
    [
      "unknown entity",
      H.pages,
      (node) => {
        node.entity = "bogus";
      },
      "invalid-source",
      "Unknown source entity",
    ],
    [
      "unknown temporal domain",
      H.pages,
      (node) => {
        node.temporalDomain = "nowhere";
      },
      "invalid-source",
      "temporal domain is invalid",
    ],
    [
      "missing self binding",
      H.pages,
      (node) => {
        node.values = node.values.filter((v: Obj) => v.kind !== "self");
      },
      "invalid-source",
      "exactly one self entity slot",
    ],
    [
      "reordered source output",
      H.pages,
      (node) => {
        node.output = [...node.output].reverse();
      },
      "invalid-source",
      "Source output must match its value bindings",
    ],
    [
      "unknown relationship binding",
      H.pages,
      (node) => {
        node.values[1] = {
          kind: "related-entity",
          slot: node.values[1].slot,
          relationship: "bogus",
        };
      },
      "invalid-source",
      "Relationship is not available",
    ],
    [
      "related entity slot type mismatch",
      H.pages,
      (node) => {
        node.values[1] = {
          kind: "related-entity",
          slot: node.values[1].slot,
          relationship: "page.session",
        };
      },
      "invalid-source",
      "Related entity slot type or nullability is invalid",
    ],
    [
      "unknown attribute binding",
      H.pages,
      (node) => {
        node.values[1] = { ...node.values[1], attribute: "bogus" };
      },
      "invalid-source",
      "Unknown attribute bogus",
    ],
    [
      "attribute from another entity",
      H.pages,
      (node) => {
        node.values[1] = {
          ...node.values[1],
          attribute: "event.report.ownerSessionId",
        };
      },
      "invalid-source",
      "Attribute is not available on this source entity",
    ],
    [
      "attribute metadata drift",
      H.pages,
      (node) => {
        node.values[1] = {
          ...node.values[1],
          attribute: "page.report.durationMs",
        };
      },
      "invalid-source",
      "Attribute slot metadata differs",
    ],
  ];

  it.each(sourceCases)("rejects %s", (_name, handle, mutate, code, message) => {
    expectIssue(edit(handle, mutate), code, message);
  });

  it("rejects an occurrence time slot that is not a non-null datetime", () => {
    const node = nodeOf(H.pages);
    const binding = node.values.find((v: Obj) => v.kind === "occurrence-time");
    expectIssue(
      editSlot(
        edit(H.pages, () => undefined),
        binding.slot,
        flipNullable,
      ),
      "invalid-source",
      "Occurrence time is only available",
    );
  });

  it("rejects a nullable self entity slot", () => {
    const plan = edit(H.pages, () => undefined);
    const self = (plan.nodes[nodeIndex(H.pages)] as Obj).values[0].slot;
    expectIssue(
      editSlot(plan, self, flipNullable),
      "invalid-source",
      "Self binding must be a non-null entity slot",
    );
  });
});

describe("logical plan validator relation nodes", () => {
  it("rejects invalid relationship lookups", () => {
    expectIssue(
      edit(H.lookup, (n) => {
        n.relationship = "bogus";
      }),
      "invalid-topology",
      "unknown semantic relationship",
    );
    expectIssue(
      edit(H.lookup, (n) => {
        n.timeSemantics = "activity";
      }),
      "invalid-topology",
      "identity semantics",
    );
    expectIssue(
      edit(H.lookup, (n) => {
        n.input = "missing";
      }),
      "invalid-topology",
      "must appear earlier",
    );
    expectIssue(
      edit(H.lookup, (n) => {
        n.input = H.pages.id;
      }),
      "invalid-grain",
      "relationship source entity grain",
    );
    expectIssue(
      edit(H.lookup, (n) => {
        n.inputKey = n.relatedSlot;
      }),
      "invalid-topology",
      "input entity grain key",
    );
    expectIssue(
      editSlot(
        edit(H.lookup, () => undefined),
        nodeOf(H.lookup).relatedSlot,
        flipNullable,
      ),
      "invalid-expression",
      "differs from the semantic catalog",
    );
  });

  it("rejects non-boolean and invisible filter predicates", () => {
    expectIssue(
      edit(H.filtered, (n) => {
        n.predicate = stringLiteral;
      }),
      "invalid-expression",
      "Filter predicate must be boolean",
    );
    expectIssue(
      edit(H.filtered, (n) => {
        n.predicate = exprSlot(slotsOf(H.grouped, "views"));
      }),
      "invisible-slot",
      "not visible from this relation",
    );
  });

  it("rejects mismatched node outputs and grains", () => {
    expectIssue(
      edit(H.filtered, (n) => {
        n.output = n.output.slice(1);
      }),
      "invalid-topology",
      "Node output does not match derived visible slots",
    );
    expectIssue(
      edit(H.filtered, (n) => {
        n.output = [...n.output].reverse();
      }),
      "invalid-topology",
      "Node output does not match derived visible slots",
    );
    expectIssue(
      edit(H.filtered, (n) => {
        n.grain = { kind: "bag" };
      }),
      "invalid-grain",
      "Declared grain does not match node semantics",
    );
    expectIssue(
      edit(H.sorted, (n) => {
        n.output = [...n.output, "ghost"];
      }),
      "invalid-topology",
      "is not declared",
    );
  });

  it("rejects invalid payload occurrence expansions", () => {
    expectIssue(
      edit(H.occurrences, (n) => {
        n.input = H.pages.id;
      }),
      "invalid-grain",
      "one selected Event Entity relation",
    );
    expectIssue(
      edit(H.occurrences, (n) => {
        n.fields = [];
        n.output = [];
      }),
      "invalid-topology",
      "at least one finite output field",
    );
    expectIssue(
      edit(H.occurrences, (n) => {
        n.fields[0] = { ...n.fields[0], field: "bogus" };
      }),
      "invalid-topology",
      "unique registered names",
    );
    expectIssue(
      edit(H.occurrences, (n) => {
        n.fields[1] = { ...n.fields[1], field: n.fields[0].field };
      }),
      "invalid-topology",
      "unique registered names",
    );
    expectIssue(
      editSlot(
        edit(H.occurrences, () => undefined),
        nodeOf(H.occurrences).fields[0].slot,
        flipNullable,
      ),
      "invalid-expression",
      "differs from its finite schema",
    );
  });

  it("rejects invalid payload property reads", () => {
    expectIssue(
      edit(H.properties, (n) => {
        n.paths = [...n.paths].reverse();
      }),
      "invalid-topology",
      "sorted finite set",
    );
    expectIssue(
      edit(H.properties, (n) => {
        n.input = H.pages.id;
      }),
      "invisible-slot",
      "not visible from this relation",
    );
    expectIssue(
      edit(H.properties, (n) => {
        n.properties = n.properties.slice(1);
      }),
      "invalid-topology",
      "Properties must match the finite path set",
    );
    expectIssue(
      edit(H.properties, (n) => {
        n.properties[0] = { ...n.properties[0], path: "/other" };
      }),
      "invalid-topology",
      "registered path and finite schema",
    );
    expectIssue(
      edit(H.properties, (n) => {
        n.properties[0].fields[1] = {
          ...n.properties[0].fields[1],
          field: n.properties[0].fields[0].field,
        };
      }),
      "invalid-topology",
      "unique registered outputs",
    );
    expectIssue(
      editSlot(
        edit(H.properties, () => undefined),
        nodeOf(H.properties).properties[0].fields[0].slot,
        flipNullable,
      ),
      "invalid-expression",
      "Property slot schema or Event lineage",
    );
  });

  it("rejects projections that drift from their inputs", () => {
    const path = nodeOf(H.projected).projections[1].slot;
    expectIssue(
      editSlot(
        edit(H.projected, () => undefined),
        path,
        flipNullable,
      ),
      "invalid-expression",
      "nullability does not match",
    );
    expectIssue(
      editSlot(
        edit(H.projected, () => undefined),
        path,
        (slot) => {
          slot.type = { kind: "scalar", scalar: "number" };
        },
      ),
      "invalid-expression",
      "slot type does not match",
    );
    expectIssue(
      edit(H.projected, (n) => {
        n.projections = n.projections.slice(1);
        n.output = n.output.slice(1);
      }),
      "invalid-grain",
      "preserve every input grain key",
    );
  });

  it("rejects aggregates that drift from their inputs", () => {
    const node = nodeOf(H.grouped);
    expectIssue(
      editSlot(
        edit(H.grouped, () => undefined),
        node.groups[0].slot,
        flipNullable,
      ),
      "invalid-expression",
      "nullability does not match",
    );
    expectIssue(
      editSlot(
        edit(H.grouped, () => undefined),
        node.measures[1].output,
        (slot) => {
          slot.type = { kind: "scalar", scalar: "string" };
        },
      ),
      "invalid-expression",
      "slot type does not match",
    );
    expectIssue(
      edit(H.grouped, (n) => {
        n.measures[1].input = n.groups[0].expression;
      }),
      "invalid-expression",
      "SUM and AVG require numeric values",
    );
    expectIssue(
      edit(H.grouped, (n) => {
        n.measures[2].input = exprSlot(slotsOf(H.pages, "entity"));
      }),
      "invalid-expression",
      "MIN and MAX require scalar values",
    );
  });

  it("rejects invalid sample statistics", () => {
    const node = nodeOf(H.stats);
    const bare = () => edit(H.stats, () => undefined);
    expectIssue(
      edit(H.stats, (n) => {
        n.groups[0].name = "samples";
      }),
      "invalid-topology",
      "names must be non-empty and unique",
    );
    expectIssue(
      edit(H.stats, (n) => {
        n.groups[0].expression = exprSlot(slotsOf(H.pages, "entity"));
      }),
      "invalid-expression",
      "must be scalar or bucket values",
    );
    expectIssue(
      editSlot(bare(), node.groups[0].slot, (slot) => {
        slot.lineage = { kind: "derived", operation: "group", inputs: [] };
      }),
      "invalid-expression",
      "Group output lineage does not match",
    );
    expectIssue(
      edit(H.stats, (n) => {
        n.value = n.groups[0].expression;
      }),
      "invalid-expression",
      "numeric scalar value",
    );
    expectIssue(
      editSlot(bare(), node.samplesOutput, flipNullable),
      "invalid-expression",
      "Sample count must be a non-null",
    );
    expectIssue(
      editSlot(bare(), node.averageOutput, flipNullable),
      "invalid-expression",
      "Average must preserve",
    );
    expectIssue(
      edit(H.stats, (n) => {
        n.percentiles[0].name = "avg";
      }),
      "invalid-topology",
      "Percentiles require a unique output name",
    );
    for (const percentile of [101, 50.5]) {
      expectIssue(
        edit(H.stats, (n) => {
          n.percentiles[0].percentile = percentile;
        }),
        "invalid-topology",
        "integer from 0 through 100",
      );
    }
    expectIssue(
      editSlot(bare(), node.percentiles[0].output, flipNullable),
      "invalid-expression",
      "Quantile output must preserve",
    );
  });

  it("rejects distinct outputs that differ from their inputs", () => {
    expectIssue(
      editSlot(
        edit(H.distinct, () => undefined),
        nodeOf(H.distinct).keys[0].output,
        (slot) => {
          slot.type = { kind: "scalar", scalar: "number" };
        },
      ),
      "invalid-expression",
      "Distinct output metadata does not match",
    );
    expectIssue(
      edit(H.distinct, (n) => {
        n.keys[0].input = slotsOf(H.grouped, "views");
      }),
      "invisible-slot",
      "not visible",
    );
  });

  it("rejects invalid row concatenation", () => {
    expectIssue(
      edit(H.appended, (n) => {
        n.inputs = [n.inputs[0]];
      }),
      "invalid-topology",
      "at least two inputs",
    );
    expectIssue(
      edit(H.appended, (n) => {
        n.columns = [];
      }),
      "invalid-topology",
      "at least one output column",
    );
    expectIssue(
      edit(H.appended, (n) => {
        n.columns[0].name = "";
      }),
      "invalid-topology",
      "names must be non-empty and unique",
    );
    expectIssue(
      edit(H.appended, (n) => {
        n.columns[0].inputs = [n.columns[0].inputs[0]];
      }),
      "invalid-topology",
      "map one slot from each input",
    );
    expectIssue(
      edit(H.appended, (n) => {
        n.inputs[1] = H.grouped.id;
        n.columns[0].inputs[1] = slotsOf(H.grouped, "path");
      }),
      "invalid-expression",
      "exactly matching scalar or bucket values",
    );
    expectIssue(
      editSlot(
        edit(H.appended, () => undefined),
        nodeOf(H.appended).columns[0].output,
        flipNullable,
      ),
      "invalid-expression",
      "type, nullability, or provenance",
    );
  });

  it("rejects invalid set operations", () => {
    expectIssue(
      edit(H.union, (n) => {
        n.operation = "bogus";
      }),
      "invalid-topology",
      "Set operation kind is invalid",
    );
    expectIssue(
      edit(H.union, (n) => {
        n.inputs = [n.inputs[0]];
      }),
      "invalid-topology",
      "at least two input relations",
    );
    expectIssue(
      edit(H.union, (n) => {
        n.operation = "difference";
        n.inputs = [...n.inputs, n.inputs[0]];
      }),
      "invalid-topology",
      "Difference requires exactly two",
    );
    expectIssue(
      edit(H.union, (n, plan) => {
        n.inputs[1] = H.appended.id;
        // Move the set operation after the bag relation so topology stays valid.
        plan.nodes.push(...plan.nodes.splice(plan.nodes.indexOf(n), 1));
      }),
      "invalid-grain",
      "cannot consume bag-grain relations",
    );
    expectIssue(
      edit(H.union, (n) => {
        n.inputs[1] = H.scalarA.id;
      }),
      "invalid-grain",
      "compatible output and grain shapes",
    );
    expectIssue(
      edit(H.union, (n) => {
        n.output = n.output.slice(0, -1);
      }),
      "invalid-topology",
      "Set output arity must match",
    );
    expectIssue(
      editSlot(
        edit(H.union, () => undefined),
        nodeOf(H.union).output[1],
        flipNullable,
      ),
      "invalid-expression",
      "Set output metadata must represent all inputs",
    );
  });

  it("rejects invalid membership joins and joins", () => {
    expectIssue(
      edit(H.semi, (n) => {
        n.keys = [];
      }),
      "invalid-join",
      "require keys unless the right relation is scalar",
    );
    expectIssue(
      edit(H.semi, (n) => {
        n.keys = [n.keys[0], n.keys[0]];
      }),
      "invalid-join",
      "must not repeat",
    );
    expectIssue(
      edit(H.semi, (n) => {
        n.keys[0].right = slotsOf(H.groupedB, "views");
      }),
      "invalid-join",
      "types must match exactly",
    );
    expectIssue(
      edit(H.semi, (n) => {
        n.keys[0].left = "ghost";
      }),
      "invisible-slot",
      "not visible",
    );
    expectIssue(
      edit(H.inner, (n) => {
        n.keys = [];
      }),
      "invalid-join",
      "do not cover right grain",
    );
    expectIssue(
      edit(H.inner, (n) => {
        n.rightAliases = [{ source: "a", alias: "b" }];
      }),
      "invalid-join",
      "Inner joins do not alias right slots",
    );
    expectIssue(
      edit(H.left, (n) => {
        n.rightAliases = n.rightAliases.slice(1);
      }),
      "invalid-join",
      "must alias every right output slot",
    );
    expectIssue(
      edit(H.left, (n) => {
        n.rightAliases[0] = {
          ...n.rightAliases[0],
          source: n.rightAliases[1].source,
        };
      }),
      "invalid-join",
      "preserve right output order",
    );
    expectIssue(
      editSlot(
        edit(H.left, () => undefined),
        nodeOf(H.left).rightAliases[0].alias,
        (slot) => {
          slot.nullable = false;
        },
      ),
      "invalid-join",
      "nullable aliases of source slots",
    );
  });

  it("rejects invalid ordered member selections", () => {
    const entity = slotsOf(H.pages, "entity");
    const cases: readonly (readonly [(n: Obj) => void, string, string])[] = [
      [
        (n) => {
          n.groups = [];
        },
        "invalid-topology",
        "at least one group key",
      ],
      [
        (n) => {
          n.groups = [n.groups[0], n.groups[0]];
        },
        "invalid-topology",
        "group keys must not repeat",
      ],
      [
        (n) => {
          n.groups = [entity];
        },
        "invalid-expression",
        "groups require scalar slots",
      ],
      [
        (n) => {
          n.order = [];
        },
        "invalid-topology",
        "at least one order key",
      ],
      [
        (n) => {
          n.order = [n.order[0], n.order[0]];
        },
        "invalid-topology",
        "order keys must not repeat",
      ],
      [
        (n) => {
          n.order[0].slot = entity;
        },
        "invalid-expression",
        "ordering requires scalar slots",
      ],
      [
        (n) => {
          n.order[0].direction = "up";
        },
        "invalid-topology",
        "direction is invalid",
      ],
      [
        (n) => {
          n.order[0].nulls = "middle";
        },
        "invalid-topology",
        "null ordering is invalid",
      ],
    ];
    for (const [mutate, code, message] of cases) {
      expectIssue(edit(H.ordered, mutate), code, message);
    }
  });

  it("rejects invalid ranked member selections", () => {
    const cases: readonly (readonly [(n: Obj) => void, string, string])[] = [
      [
        (n) => {
          n.input = H.pages.id;
        },
        "invalid-grain",
        "non-empty keyed grain",
      ],
      [
        (n) => {
          n.groups = [n.groups[0], n.groups[0]];
        },
        "invalid-topology",
        "partition keys must not repeat",
      ],
      [
        (n) => {
          n.order = [];
        },
        "invalid-topology",
        "at least one order key",
      ],
      [
        (n) => {
          n.order = [n.order[0], n.order[0]];
        },
        "invalid-topology",
        "order keys must not repeat",
      ],
      [
        (n) => {
          n.order[0].direction = "up";
        },
        "invalid-topology",
        "direction is invalid",
      ],
      [
        (n) => {
          n.order[0].nulls = "middle";
        },
        "invalid-topology",
        "null ordering is invalid",
      ],
      [
        (n) => {
          n.groups = [];
          n.order = [n.order[0]];
        },
        "invalid-grain",
        "cover the complete scalar input grain",
      ],
    ];
    for (const [mutate, code, message] of cases) {
      expectIssue(edit(H.ranked, mutate), code, message);
    }
    expectIssue(
      editSlot(
        edit(H.ranked, () => undefined),
        nodeOf(H.ranked).rankSlot,
        flipNullable,
      ),
      "invalid-expression",
      "Rank output must be a new",
    );
  });

  it("rejects invalid sort and limit nodes", () => {
    expectIssue(
      edit(H.sorted, (n) => {
        n.keys[0].direction = "up";
      }),
      "invalid-topology",
      "Sort direction is invalid",
    );
    expectIssue(
      edit(H.sorted, (n) => {
        n.keys[0].nulls = "middle";
      }),
      "invalid-topology",
      "Sort null ordering is invalid",
    );
    expectIssue(
      edit(H.sorted, (n) => {
        n.keys[0].slot = "ghost";
      }),
      "invisible-slot",
      "not visible",
    );
    for (const count of [-1, 1.5]) {
      expectIssue(
        edit(H.limited, (n) => {
          n.count = count;
        }),
        "invalid-topology",
        "non-negative integer",
      );
    }
  });
});
