import { describe, expect, it } from "vitest";

import {
  eq,
  filter,
  lowerLogicalPlan,
  param,
  project,
  recursiveClosure,
  scan,
  semiJoin,
} from "@/lib/db";
import { compileD1Expression } from "@/lib/db/query/compiler";
import { DatabaseCompilerError } from "@/lib/db/query/errors";
import type { SqlExpression } from "@/lib/db/query/expression";
import {
  analyzeSemiMembershipEligibilityForDiagnostics,
  lowerLogicalQuerySource,
  recursiveClosureCount,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import type { QuerySource } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

function messageOf(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseCompilerError);
    return (error as Error).message;
  }
  throw new Error("expected the callback to throw");
}

const compile = (expression: object) =>
  compileD1Expression(expression as unknown as SqlExpression, new Map());

describe("expression rendering guards", () => {
  it("renders safe constants and rejects constants that cannot be inlined", () => {
    const constant = (value: unknown) => ({
      kind: "constant",
      value,
      resultType: { affinity: "unknown", nullable: false },
    });
    expect(compile(constant(7)).text).toBe("7");
    expect(compile(constant(-0)).text).toBe("0");
    expect(compile(constant(null)).text).toBe("NULL");
    expect(compile(constant("\u{1f600}")).text).toContain("\u{1f600}");
    expect(messageOf(() => compile(constant(2 ** 60)))).toMatch(
      /SQL constants must be safe integers/,
    );
    expect(messageOf(() => compile(constant(1.5)))).toMatch(
      /SQL constants must be safe integers/,
    );
    for (const value of ["\ud800", "\ud800x", "x\udc00"])
      expect(messageOf(() => compile(constant(value)))).toMatch(
        /SQL text constants must contain well-formed UTF-16/,
      );
    expect(messageOf(() => compile(constant("a\0b")))).toMatch(/NUL/);
  });

  it("rejects text pattern functions without a string parameter pattern", () => {
    const column = {
      kind: "parameter",
      value: "abc",
      resultType: { affinity: "text", nullable: false },
    };
    const call = (name: string, args: unknown[]) => ({
      kind: "function",
      name,
      arguments: args,
      resultType: { affinity: "integer", nullable: false },
    });
    for (const name of [
      "text-contains",
      "text-starts-with",
      "text-ends-with",
    ]) {
      const expected = new RegExp(
        `${name}\\(\\) must have a TEXT input and string parameter`,
      );
      expect(messageOf(() => compile(call(name, [column])))).toMatch(expected);
      expect(
        messageOf(() =>
          compile(
            call(name, [
              column,
              { ...column, kind: "constant", value: "needle" },
            ]),
          ),
        ),
      ).toMatch(expected);
      expect(
        messageOf(() =>
          compile(call(name, [column, { ...column, value: 12 }])),
        ),
      ).toMatch(expected);
    }
    expect(
      compile(call("text-contains", [column, { ...column, value: "" }])).text,
    ).toMatch(/IS NOT NULL OR NULL/);
  });
});

describe("physical plan entry-point guards", () => {
  const identities = scan(schema.site_identities);
  const rightScan = scan(schema.site_identities);
  const right = filter(
    rightScan,
    eq(rightScan.columns.site_id, param("site-1")),
  );
  const semi = semiJoin(
    identities,
    right,
    eq(identities.columns.site_pk, right.columns.site_pk),
  );

  it("rejects structurally invalid or inconsistent physical plans", () => {
    const physical = lowerLogicalPlan(semi);
    expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();
    for (const bad of [
      null,
      {},
      { root: null },
      { root: "node" },
      { ...physical, root: 5 },
    ])
      expect(messageOf(() => validatePhysicalQueryPlan(bad as never))).toMatch(
        /Invalid physical query plan/,
      );
    expect(
      messageOf(() =>
        validatePhysicalQueryPlan({ ...physical, scope: rightScan.scope }),
      ),
    ).toMatch(/Physical query root metadata does not match its logical node/);
    expect(
      messageOf(() =>
        validatePhysicalQueryPlan({ ...physical, fields: [] } as never),
      ),
    ).toMatch(/Physical query root metadata does not match its logical node/);
    expect(
      messageOf(() =>
        validatePhysicalQueryPlan({
          ...physical,
          fields: "nope",
        } as never),
      ),
    ).toMatch(/Physical query root metadata does not match its logical node/);
  });

  it("rejects query sources whose metadata drifted from the logical node", () => {
    const source: QuerySource = {
      node: semi.node,
      scope: rightScan.scope,
      fields: semi.fields,
    };
    expect(messageOf(() => lowerLogicalQuerySource(source))).toMatch(
      /Query source metadata does not match its logical node/,
    );
    expect(
      messageOf(() =>
        lowerLogicalQuerySource({
          node: semi.node,
          scope: semi.node.scope,
          fields: semi.fields.slice(1),
        }),
      ),
    ).toMatch(/Query source metadata does not match its logical node/);
  });

  it("reports semi membership eligibility decisions for diagnostics", () => {
    const decisions = analyzeSemiMembershipEligibilityForDiagnostics(semi.node);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.node.kind).toBe("semi-join");
    expect(decisions[0]?.candidateIndex).toBe(0);
    expect(
      analyzeSemiMembershipEligibilityForDiagnostics(identities.node),
    ).toEqual([]);
  });

  it("counts each recursive closure once even when a plan shares it", () => {
    const edges = (site: string, node: number, parent: number | null) =>
      project(filter(identities, eq(identities.columns.site_id, param(site))), {
        namespace: param("ns"),
        nodeId: param(node),
        parentNodeId: param<number | null>(parent),
      });
    const closure = recursiveClosure(
      edges("a", 1, 2),
      edges("b", 2, null),
      (current, candidate) => eq(current.parentNodeId, candidate.nodeId),
    );
    expect(recursiveClosureCount(identities.node)).toBe(0);
    expect(recursiveClosureCount(closure.node)).toBe(1);
  });
});
