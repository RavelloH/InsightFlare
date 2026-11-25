import { statSync } from "node:fs";
import { relative } from "node:path";

import { BaseSequencer, type TestSpecification } from "vitest/node";

interface WeightedFile<T> {
  key: string;
  bytes: number;
  value: T;
}

// Deterministic longest-processing-time-first approximation. File size is a
// cheap, checkout-local proxy, not a measured runtime; the fixed cost accounts
// for collection/setup. No mutable history or network state is needed.
export function partitionTestFiles<T>(
  files: readonly WeightedFile<T>[],
  count: number,
): T[][] {
  if (!Number.isInteger(count) || count < 1 || count > files.length) {
    throw new Error("Invalid test shard count");
  }
  const keys = new Set<string>();
  const weighted = files.map((file) => {
    if (
      keys.has(file.key) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    ) {
      throw new Error("Invalid or duplicate test specification: " + file.key);
    }
    keys.add(file.key);
    return { ...file, weight: 100 + file.bytes ** 0.75 };
  });
  weighted.sort(
    (a, b) =>
      b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const shards = Array.from({ length: count }, () => ({
    weight: 0,
    files: [] as T[],
  }));
  for (const file of weighted) {
    let target = 0;
    for (let i = 1; i < shards.length; i++) {
      if (shards[i]!.weight < shards[target]!.weight) target = i;
    }
    shards[target]!.weight += file.weight;
    shards[target]!.files.push(file.value);
  }
  return shards.map((shard) => shard.files);
}

export class BalancedCISequencer extends BaseSequencer {
  override async shard(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    // All runners see the same specs and immutable checkout, so each computes
    // the same partition independently. Keep Vitest's ordinary execution sort.
    const groups = partitionTestFiles(
      files.map((spec) => ({
        key:
          relative(this.ctx.config.root, spec.moduleId).replace(/\\/g, "/") +
          ":" +
          spec.project.name +
          ":" +
          spec.pool,
        bytes: statSync(spec.moduleId).size,
        value: spec,
      })),
      shard.count,
    );
    const selected = groups[shard.index - 1];
    if (!selected) throw new Error("Invalid test shard index");
    console.log(
      "Balanced CI shard " +
        shard.index +
        "/" +
        shard.count +
        ": " +
        selected.length +
        " of " +
        files.length +
        " specifications",
    );
    return selected;
  }
}
