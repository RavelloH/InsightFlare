import { describe, expect, it } from "vitest";

import { partitionTestFiles } from "./ci-test-sequencer";

describe("deterministic CI test partition", () => {
  const files = Array.from({ length: 519 }, (_, i) => ({
    key: "test-" + i,
    bytes: i % 5 === 0 ? 100_000 : 300 + i * 11,
    value: i,
  }));

  it.each([1, 4, 6, 8])(
    "assigns every specification exactly once across %i shards",
    (count) => {
      const partitions = partitionTestFiles(files, count);
      expect(partitions).toHaveLength(count);
      expect(partitions.every((group) => group.length > 0)).toBe(true);
      expect(partitions.flat().sort((a, b) => a - b)).toEqual(
        files.map((file) => file.value),
      );
      expect(partitionTestFiles([...files].reverse(), count)).toEqual(
        partitions,
      );
    },
  );

  it("balances heavy and light specifications", () => {
    const inputs = [100_000, 100_000, 1, 1].map((bytes, i) => ({
      key: String(i),
      bytes,
      value: i,
    }));
    expect(partitionTestFiles(inputs, 2)).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it("rejects missing, duplicate or invalid specifications", () => {
    expect(() => partitionTestFiles(files, 0)).toThrow();
    expect(() => partitionTestFiles(files, 520)).toThrow();
    expect(() => partitionTestFiles([files[0]!, files[0]!], 2)).toThrow();
    expect(() =>
      partitionTestFiles([{ key: "bad", bytes: -1, value: 0 }], 1),
    ).toThrow();
  });
});
