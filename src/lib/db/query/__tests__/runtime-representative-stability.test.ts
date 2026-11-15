// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  aggregate,
  callFunction,
  compileD1Query,
  constant,
  count,
  distinct,
  eq,
  filter,
  max,
  min,
  param,
  project,
  union,
  valuesRelation,
} from "@/lib/db";
import { createRelationScope } from "@/lib/db/query/expression";
import { isRuntimeRepresentativeStable } from "@/lib/db/query/physical/runtime-window-certificate";
const one = () =>
  valuesRelation({ seed: { affinity: "text", nullable: false } }, [
    { seed: "row" },
  ]);
const pair = (reverse = false) => {
  const integer = project(one(), { value: constant(1) });
  const real = project(one(), { value: param(1) });
  return reverse ? union(integer, real, true) : union(real, integer, true);
};
const observed = (rows: any, mode: string) => {
  if (mode === "distinct") return distinct(rows);
  return aggregate(rows, {
    groupBy: mode === "group" ? { value: rows.columns.value } : {},
    aggregates:
      mode === "group"
        ? { total: count() }
        : { value: (mode === "min" ? min : max)(rows.columns.value) },
  } as never);
};
const storageRows = (rows: any) => {
  const report = project(rows, {
    storage: callFunction("storage-class", rows.columns.value),
  });
  const q = compileD1Query(report);
  const db = new DatabaseSync(":memory:");
  try {
    return db
      .prepare(q.sql)
      .all(
        ...(q.bindings ?? []).map((v: any) =>
          typeof v === "boolean" ? Number(v) : v,
        ),
      );
  } finally {
    db.close();
  }
};
describe("runtime representative proof preserves storage observations", () => {
  it.each(["min", "max", "group", "distinct"])(
    "rejects equal INTEGER literal/REAL binding through %s",
    (mode) => {
      const first = pair(),
        reverse = pair(true);
      // This is legal typed SQL, and the observable representative genuinely
      // changes when the two equal numeric storage families arrive reversed.
      const a = observed(first, mode),
        b = observed(reverse, mode);
      expect(storageRows(a)).toEqual([{ storage: "real" }]);
      expect(storageRows(b)).toEqual([{ storage: "integer" }]);
      expect(isRuntimeRepresentativeStable(first, 0)).toBe(false);
      expect(isRuntimeRepresentativeStable(reverse, 0)).toBe(false);
      expect(isRuntimeRepresentativeStable(a, 0)).toBe(false);
    },
  );
  it.each(["min", "max", "group", "distinct"])(
    "retains NULL plus BINARY text through %s",
    (mode) => {
      const rows = union(
        project(one(), { value: constant(null) }),
        project(one(), { value: param("same") }),
        true,
      );
      const observedRows = observed(rows, mode);
      expect(isRuntimeRepresentativeStable(rows, 0)).toBe(true);
      expect(isRuntimeRepresentativeStable(observedRows, 0)).toBe(true);
      expect(
        storageRows(observedRows)
          .map((r: any) => r.storage)
          .sort(),
      ).toEqual(
        mode === "group" || mode === "distinct" ? ["null", "text"] : ["text"],
      );
    },
  );
  it("requires exact fresh source scope, layout and index even for guarded fields", () => {
    const rows = project(one(), { value: constant(1) });
    const canonical = new Map([[rows.node, new Set([0])]]);
    expect(isRuntimeRepresentativeStable(rows, 0, canonical)).toBe(true);
    expect(
      isRuntimeRepresentativeStable(
        { ...rows, scope: createRelationScope() },
        0,
        canonical,
      ),
    ).toBe(false);
    expect(
      isRuntimeRepresentativeStable(
        { ...rows, fields: [{ ...rows.fields[0], name: "other" }] },
        0,
        canonical,
      ),
    ).toBe(false);
    for (const index of [-1, 1, 0.5, NaN])
      expect(isRuntimeRepresentativeStable(rows, index, canonical)).toBe(false);
    const mapped = project(rows, { value: rows.columns.value });
    expect(isRuntimeRepresentativeStable(mapped, 0, canonical)).toBe(true);
    expect(
      isRuntimeRepresentativeStable(
        { ...mapped, scope: rows.scope },
        0,
        canonical,
      ),
    ).toBe(false);
  });
  it("rejects a cyclic relation path rather than reusing another scope's proof", () => {
    const rows = filter(
      project(one(), { value: constant("v") }),
      eq(constant(1), constant(1)),
    );
    const n = rows.node as any;
    const prior = n.input;
    n.input = { node: n, scope: n.scope, fields: n.fields };
    try {
      expect(isRuntimeRepresentativeStable(rows, 0)).toBe(false);
      expect(() => compileD1Query(rows)).toThrow(/cyclic|cycle/i);
    } finally {
      n.input = prior;
    }
  });
});
