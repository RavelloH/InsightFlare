import { describe, expect, it } from "vitest";

import { safeFilterShape } from "@/lib/edge/analytics-engine/filter-shape";
import type {
  FilterDocument,
  FilterExpression,
} from "@/lib/filter-contract/filters";

function doc(value: string, path = "geo.country"): FilterDocument {
  return {
    version: 1,
    root: {
      kind: "and",
      children: [
        {
          kind: "condition",
          target: { kind: "field", field: path as never },
          operator: "eq",
          value,
        },
        {
          kind: "not",
          child: {
            kind: "condition",
            target: { kind: "event-payload", path: "/SECRET-PATH" as never },
            operator: "in",
            value: ["sensitive-one", "sensitive-two"],
          },
        },
      ],
    } as FilterExpression,
  };
}

describe("Filter-SQL privacy-preserving shape projection", () => {
  it("is invariant under sensitive value and JSON pointer changes", () => {
    const a = safeFilterShape(doc("US"));
    const b = safeFilterShape(doc("JP"));
    expect(a).toEqual(b);
    expect(a.family).toBe("mixed");
    expect(a.conditionsBucket).toBe("2");
    expect(a.operatorGroups).toEqual(["equality", "set"]);
    expect(a.fieldGroups).toContain("geo");
    expect(a.fieldGroups).toContain("custom");
    const serialized = JSON.stringify(a);
    for (const secret of [
      "US",
      "JP",
      "/SECRET-PATH",
      "sensitive-one",
      "geo.country",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
  it("coarsens custom/unknown field IDs without copying them", () => {
    const a = safeFilterShape(doc("a", "custom.secret-tenant-field"));
    const b = safeFilterShape(doc("b", "custom.another-secret"));
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain("secret-tenant");
  });
  it("distinguishes no-filter and coarse nested boolean shapes", () => {
    expect(safeFilterShape({ version: 1, root: null }).family).toBe("none");
    const a = safeFilterShape(doc("a"));
    expect(a.maxDepthBucket).toBe("3-4");
    expect(a.code).toMatch(
      /^[a-z-]+\.[aonxc]+\.[0-9+-]+\.[0-9+-]+\.o[0-9a-z]+$/,
    );
    expect(a.booleanGroups).toEqual(["and", "not"]);
  });
});
