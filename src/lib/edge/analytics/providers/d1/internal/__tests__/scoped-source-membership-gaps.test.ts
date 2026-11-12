import { describe, expect, it } from "vitest";

import { entityConditionMatches } from "@/lib/edge/analytics/providers/d1/internal/lowering/scoped-source/membership";
import {
  entityEventMatches,
  entityPageRows,
  eventOwnerPairsForObservationFilter,
} from "@/lib/edge/analytics/providers/d1/internal/lowering/scoped-source/membership";

// These guards run before any storage relation is touched, so the dataset and
// selection can be inert placeholders.
const dataset = {} as never;

describe("scoped-source membership precondition guards", () => {
  it("rejects legacy Filter conditions for unknown fields", () => {
    expect(() =>
      entityConditionMatches(
        {
          kind: "condition",
          target: { kind: "field", field: "no.such.field" },
          operator: "eq",
          value: "x",
        } as never,
        dataset,
        {} as never,
        "session",
      ),
    ).toThrow(new TypeError("Unknown legacy Filter field no.such.field."));
  });

  it("requires an entity kind for entity-mode Event and Page rows", () => {
    expect(() => entityEventMatches(dataset, {} as never)).toThrow(
      new TypeError("Scoped entity mode requires an entity kind."),
    );
    expect(() => entityPageRows(dataset, {} as never)).toThrow(
      new TypeError("Scoped entity mode requires an entity kind."),
    );
  });

  it("returns the supplied owner-pair universe when no Filter restricts Events", () => {
    const universe = { sentinel: true } as never;
    expect(
      eventOwnerPairsForObservationFilter(dataset, {} as never, null, universe),
    ).toBe(universe);
  });
});
