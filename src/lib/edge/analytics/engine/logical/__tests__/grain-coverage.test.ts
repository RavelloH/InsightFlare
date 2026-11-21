import { describe, expect, it } from "vitest";

import {
  grainKeys,
  remapGrain,
  sameGrainShape,
} from "@/lib/edge/analytics/engine/logical/grain";
import { slotId } from "@/lib/edge/analytics/engine/logical/ids";

describe("logical grain remapping preserves query identity", () => {
  it("remaps scalar, entity and multi-key grains without changing their semantic shape", () => {
    const oldA = slotId(1),
      oldB = slotId(2);
    const newA = slotId(21),
      newB = slotId(22);
    const map = new Map([
      [oldA, newA],
      [oldB, newB],
    ]);
    const scalar = { kind: "scalar" as const };
    const entity = {
      kind: "entity" as const,
      entity: "session" as const,
      key: oldA,
    };
    const keyed = { kind: "keyed" as const, keys: [oldA, oldB] };
    expect(remapGrain(scalar, map)).toEqual(scalar);
    expect(remapGrain(entity, map)).toEqual({ ...entity, key: newA });
    expect(remapGrain(keyed, map)).toEqual({
      kind: "keyed",
      keys: [newA, newB],
    });
    expect(grainKeys(scalar)).toEqual([]);
    expect(grainKeys(entity)).toEqual([oldA]);
    expect(grainKeys(keyed)).toEqual([oldA, oldB]);
    expect(sameGrainShape(entity, { ...entity, key: newB })).toBe(true);
    expect(sameGrainShape(keyed, { kind: "keyed", keys: [newA, newB] })).toBe(
      true,
    );
    expect(sameGrainShape(scalar, scalar)).toBe(true);
  });

  it("fails closed on unmapped relation keys and differing entity grain shapes", () => {
    const key = slotId(1);
    expect(() =>
      remapGrain({ kind: "entity", entity: "session", key }, new Map()),
    ).toThrow("logical_grain_key_not_mapped");
    expect(() => remapGrain({ kind: "keyed", keys: [key] }, new Map())).toThrow(
      "logical_grain_key_not_mapped",
    );
    expect(
      sameGrainShape({ kind: "scalar" }, { kind: "keyed", keys: [] }),
    ).toBe(false);
    expect(
      sameGrainShape(
        { kind: "entity", entity: "session", key },
        { kind: "entity", entity: "visitor", key },
      ),
    ).toBe(false);
    expect(
      sameGrainShape(
        { kind: "keyed", keys: [key] },
        { kind: "keyed", keys: [key, slotId(2)] },
      ),
    ).toBe(false);
  });
});
