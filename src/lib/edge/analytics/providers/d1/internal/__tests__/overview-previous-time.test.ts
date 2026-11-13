import { describe, expect, it, vi } from "vitest";

import type * as mod0 from "@/lib/edge/analytics/contract/helpers";

const control = vi.hoisted(() => ({ throwOnCreate: false }));

vi.mock("@/lib/edge/analytics/contract/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof mod0>();
  return {
    ...actual,
    createQueryTime: (...args: Parameters<typeof actual.createQueryTime>) => {
      if (control.throwOnCreate) throw new RangeError("forced");
      return actual.createQueryTime(...args);
    },
  };
});

import {
  isInvalidOverviewSnapshot,
  readOwnDataProperty,
  serializeOwnDataSnapshot,
  snapshotBoundedOverviewTime,
  snapshotOwnDataValue,
} from "@/lib/edge/analytics/providers/d1/internal/overview-previous-time";

const invalid = (value: unknown) =>
  isInvalidOverviewSnapshot(snapshotOwnDataValue(value));

const throwingProxy = () =>
  new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("boom");
      },
    },
  );

describe("snapshotOwnDataValue", () => {
  it("clones JSON-compatible values", () => {
    expect(snapshotOwnDataValue(undefined)).toBeUndefined();
    expect(snapshotOwnDataValue(null)).toBeNull();
    expect(snapshotOwnDataValue("a")).toBe("a");
    expect(snapshotOwnDataValue(true)).toBe(true);
    expect(snapshotOwnDataValue(3)).toBe(3);
    const cloned = snapshotOwnDataValue({ a: [1, { b: "x" }], c: undefined });
    expect(cloned).toEqual({ a: [1, { b: "x" }], c: undefined });
    expect(Object.getPrototypeOf(cloned)).toBeNull();
    expect(snapshotOwnDataValue(Object.create(null))).toEqual({});
  });

  it("rejects non-JSON primitives and non-finite numbers", () => {
    expect(invalid(Number.NaN)).toBe(true);
    expect(invalid(Number.POSITIVE_INFINITY)).toBe(true);
    expect(invalid(1n)).toBe(true);
    expect(invalid(Symbol("s"))).toBe(true);
    expect(invalid(() => 1)).toBe(true);
  });

  it("rejects cycles, excessive depth and excessive node counts", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(invalid(cyclic)).toBe(true);
    let deep: unknown = 1;
    for (let i = 0; i < 45; i += 1) deep = [deep];
    expect(invalid(deep)).toBe(true);
    expect(invalid(new Array(20_001).fill(0))).toBe(true);
  });

  it("rejects exotic arrays", () => {
    expect(invalid(new Array(2))).toBe(true);
    const extra = [1] as unknown[] & { extra?: number };
    extra.extra = 1;
    expect(invalid(extra)).toBe(true);
    const symbolKey = [1] as unknown[];
    (symbolKey as unknown as Record<symbol, number>)[Symbol("k")] = 1;
    expect(invalid(symbolKey)).toBe(true);
    const accessor = [0];
    Object.defineProperty(accessor, 0, { get: () => 1, enumerable: true });
    expect(invalid(accessor)).toBe(true);
    const hidden = [0];
    Object.defineProperty(hidden, 0, { value: 1, enumerable: false });
    expect(invalid(hidden)).toBe(true);
    expect(invalid([Number.NaN])).toBe(true);
  });

  it("rejects exotic objects", () => {
    expect(invalid(new Date())).toBe(true);
    expect(invalid(new Map())).toBe(true);
    expect(invalid({ [Symbol("k")]: 1 })).toBe(true);
    expect(
      invalid({
        get a() {
          return 1;
        },
      }),
    ).toBe(true);
    expect(
      invalid(Object.defineProperty({}, "a", { value: 1, enumerable: false })),
    ).toBe(true);
    expect(invalid({ a: Number.NaN })).toBe(true);
  });

  it("treats throwing proxies as invalid", () => {
    expect(invalid(throwingProxy())).toBe(true);
  });
});

describe("serializeOwnDataSnapshot", () => {
  it("serializes with sorted keys and null for undefined", () => {
    expect(
      serializeOwnDataSnapshot({
        b: [1, undefined, null],
        a: "x",
        c: undefined,
        d: true,
      }),
    ).toBe('{"a":"x","b":[1,null,null],"d":true}');
    expect(serializeOwnDataSnapshot(undefined)).toBe("null");
    expect(serializeOwnDataSnapshot(null)).toBe("null");
  });

  it("returns undefined for unserializable data", () => {
    expect(serializeOwnDataSnapshot(Number.NaN)).toBeUndefined();
    expect(serializeOwnDataSnapshot(1n)).toBeUndefined();
    expect(serializeOwnDataSnapshot([Number.NaN])).toBeUndefined();
    expect(serializeOwnDataSnapshot({ a: Number.NaN })).toBeUndefined();
    expect(serializeOwnDataSnapshot(new Array(2))).toBeUndefined();
    expect(
      serializeOwnDataSnapshot({
        get a() {
          return 1;
        },
      }),
    ).toBeUndefined();
    let deep: unknown = 1;
    for (let i = 0; i < 45; i += 1) deep = { a: deep };
    expect(serializeOwnDataSnapshot(deep)).toBeUndefined();
    expect(serializeOwnDataSnapshot(new Array(20_001).fill(0))).toBeUndefined();
    expect(serializeOwnDataSnapshot(throwingProxy())).toBeUndefined();
  });
});

describe("readOwnDataProperty", () => {
  it("reports presence and validity", () => {
    expect(readOwnDataProperty(1, "a")).toEqual({
      present: false,
      valid: false,
    });
    expect(readOwnDataProperty(null, "a")).toEqual({
      present: false,
      valid: false,
    });
    expect(readOwnDataProperty({}, "a")).toEqual({
      present: false,
      valid: true,
    });
    expect(readOwnDataProperty({ a: 2 }, "a")).toEqual({
      present: true,
      valid: true,
      value: 2,
    });
    expect(
      readOwnDataProperty(
        {
          get a() {
            return 1;
          },
        },
        "a",
      ),
    ).toEqual({ present: true, valid: false });
    expect(
      readOwnDataProperty(
        Object.defineProperty({}, "a", { value: 1, enumerable: false }),
        "a",
      ),
    ).toEqual({ present: true, valid: false });
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("boom");
        },
      },
    );
    expect(readOwnDataProperty(proxy, "a")).toEqual({
      present: true,
      valid: false,
    });
  });
});

describe("snapshotBoundedOverviewTime", () => {
  const valid = () => ({
    range: { startMs: 1_000, endExclusiveMs: 2_000 },
    reportingTimeZone: "UTC",
    capturedAtMs: 3_000,
  });

  it("returns a frozen QueryTime for exact plain input", () => {
    const snapshot = snapshotBoundedOverviewTime(valid());
    expect(snapshot).toMatchObject({
      range: { startMs: 1_000, endExclusiveMs: 2_000 },
      capturedAtMs: 3_000,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.range)).toBe(true);
    expect(
      snapshotBoundedOverviewTime(Object.assign(Object.create(null), valid())),
    ).toBeDefined();
  });

  it("rejects malformed input", () => {
    expect(snapshotBoundedOverviewTime(null)).toBeUndefined();
    expect(snapshotBoundedOverviewTime([])).toBeUndefined();
    expect(snapshotBoundedOverviewTime(new Date())).toBeUndefined();
    expect(
      snapshotBoundedOverviewTime({ ...valid(), extra: 1 }),
    ).toBeUndefined();
    expect(
      snapshotBoundedOverviewTime({ ...valid(), [Symbol("k")]: 1 }),
    ).toBeUndefined();
    expect(
      snapshotBoundedOverviewTime({
        range: valid().range,
        reportingTimeZone: "UTC",
      }),
    ).toBeUndefined();
    expect(
      snapshotBoundedOverviewTime({
        ...valid(),
        get range() {
          return { startMs: 1, endExclusiveMs: 2 };
        },
      }),
    ).toBeUndefined();
    expect(
      snapshotBoundedOverviewTime({ ...valid(), range: { startMs: 1 } }),
    ).toBeUndefined();
    expect(
      snapshotBoundedOverviewTime({
        ...valid(),
        range: { startMs: 1.5, endExclusiveMs: 2 },
      }),
    ).toBeUndefined();
    expect(
      snapshotBoundedOverviewTime({ ...valid(), capturedAtMs: 1.5 }),
    ).toBeUndefined();
    expect(
      snapshotBoundedOverviewTime({ ...valid(), reportingTimeZone: 1 }),
    ).toBeUndefined();
    expect(
      snapshotBoundedOverviewTime({
        ...valid(),
        reportingTimeZone: "Not/AZone",
      }),
    ).toBeUndefined();
    expect(
      snapshotBoundedOverviewTime({
        ...valid(),
        range: { startMs: 5, endExclusiveMs: 5 },
      }),
    ).toBeUndefined();
    const proxy = new Proxy(valid(), {
      getPrototypeOf() {
        throw new Error("boom");
      },
    });
    expect(snapshotBoundedOverviewTime(proxy)).toBeUndefined();
  });

  it("returns undefined when QueryTime construction throws", () => {
    control.throwOnCreate = true;
    try {
      expect(snapshotBoundedOverviewTime(valid())).toBeUndefined();
    } finally {
      control.throwOnCreate = false;
    }
  });
});
