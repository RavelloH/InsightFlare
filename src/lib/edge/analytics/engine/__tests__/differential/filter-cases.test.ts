import { describe, expect, it } from "vitest";

import {
  checkDifferentialFilterCase,
  differentialFilterDsl,
  type DifferentialFilterTree,
  generateDifferentialFilterCases,
  minimizeDifferentialFailure,
} from "./filter-cases";

describe("generated filter differential evidence", () => {
  it("accepts a family-specific leaf set and rejects an empty one", () => {
    const cases = generateDifferentialFilterCases(17, 6, ["payload_leaf"]);
    expect(
      cases.every((sample) =>
        differentialFilterDsl(sample.tree).includes("payload_leaf"),
      ),
    ).toBe(true);
    expect(() => generateDifferentialFilterCases(17, 1, [])).toThrow(
      RangeError,
    );
  });
  it("reproduces all boolean shapes from a recorded seed", () => {
    const cases = generateDifferentialFilterCases(0x20261113, 12);
    expect(cases).toEqual(generateDifferentialFilterCases(0x20261113, 12));
    expect(new Set(cases.map((sample) => sample.tree.kind))).toEqual(
      new Set(["not", "and", "or"]),
    );
    expect(cases).not.toEqual(generateDifferentialFilterCases(42, 12));
  });

  it("reduces a mismatch to the leaf that still triggers it", async () => {
    const bad: DifferentialFilterTree = { kind: "leaf", dsl: "bad" };
    const tree: DifferentialFilterTree = {
      kind: "and",
      left: { kind: "not", child: bad },
      right: { kind: "leaf", dsl: "irrelevant" },
    };
    expect(
      await minimizeDifferentialFailure(tree, async (candidate) =>
        differentialFilterDsl(candidate).includes("bad"),
      ),
    ).toEqual(bad);
  });

  it("detects an injected report mutation and records the smallest reproduction", async () => {
    await expect(
      checkDifferentialFilterCase({
        sample: {
          seed: 17,
          index: 2,
          tree: {
            kind: "and",
            left: { kind: "leaf", dsl: 'page.path eq "/trigger"' },
            right: { kind: "leaf", dsl: "count(event) gte 0" },
          },
        },
        reference: async () => ({ totalViews: 1, topSources: [] }),
        candidates: {
          mutated: async (dsl) => ({
            totalViews: dsl.includes("trigger") ? 2 : 1,
            topSources: [],
          }),
        },
      }),
    ).rejects.toThrow(/"seed":17,"case":2,.*"strategy":"mutated"/u);
  });

  it("keeps an unchanged complete DTO green", async () => {
    const reference = async () => ({ totalViews: 0, topSources: [] });
    await expect(
      checkDifferentialFilterCase({
        sample: generateDifferentialFilterCases(0, 1)[0]!,
        reference,
        candidates: { same: reference },
      }),
    ).resolves.toBeUndefined();
  });

  it("shrinks an injected execution error instead of losing its seed", async () => {
    const sample = {
      seed: 91,
      index: 4,
      tree: {
        kind: "and" as const,
        left: { kind: "leaf" as const, dsl: 'page.path eq "/trigger"' },
        right: { kind: "leaf" as const, dsl: "count(event) gte 0" },
      },
    };
    await expect(
      checkDifferentialFilterCase({
        sample,
        reference: async () => 1,
        candidates: {
          broken: async (dsl) => {
            if (dsl.includes("trigger")) throw new TypeError("injected");
            return 1;
          },
        },
      }),
    ).rejects.toThrow(
      /"seed":91,"case":4,.*"strategy":"broken".*"name":"TypeError","message":"injected"/u,
    );
  });

  it("preserves matching domain errors as part of behavior parity", async () => {
    const reference = async () => {
      throw Object.assign(new Error("activity limit exceeded"), {
        code: "filter_evaluation_limit_exceeded",
      });
    };
    await expect(
      checkDifferentialFilterCase({
        sample: generateDifferentialFilterCases(73, 1)[0]!,
        reference,
        candidates: { same: reference },
        expectedError: (error) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "filter_evaluation_limit_exceeded",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails when both runners throw the same setup error without executing", async () => {
    let storageCalls = 0;
    const setup = async (): Promise<void> => {
      throw new TypeError("shared setup bug");
    };
    const shared = async (): Promise<number> => {
      await setup();
      storageCalls += 1;
      return 1;
    };
    await expect(
      checkDifferentialFilterCase({
        sample: generateDifferentialFilterCases(17, 1)[0]!,
        reference: shared,
        candidates: { sql: shared },
      }),
    ).rejects.toThrow(/filter_differential_failure:.*shared setup bug/u);
    expect(storageCalls).toBe(0);
  });

  it("does not treat a shared assertion failure as a declared domain error", async () => {
    const shared = async (): Promise<number> => {
      expect("SQL did not execute").toBe("SQL executed");
      return 1;
    };
    await expect(
      checkDifferentialFilterCase({
        sample: generateDifferentialFilterCases(18, 1)[0]!,
        reference: shared,
        candidates: { sql: shared },
        expectedError: (error) =>
          error instanceof Error && error.message === "activity limit exceeded",
      }),
    ).rejects.toThrow(/filter_differential_failure:/u);
  });
});
