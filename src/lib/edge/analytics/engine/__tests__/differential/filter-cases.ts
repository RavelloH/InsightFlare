import { isDeepStrictEqual } from "node:util";

export type DifferentialFilterTree =
  | { readonly kind: "leaf"; readonly dsl: string }
  | { readonly kind: "not"; readonly child: DifferentialFilterTree }
  | {
      readonly kind: "and" | "or";
      readonly left: DifferentialFilterTree;
      readonly right: DifferentialFilterTree;
    };

export interface DifferentialFilterCase {
  readonly seed: number;
  readonly index: number;
  readonly tree: DifferentialFilterTree;
}

const LEAVES = [
  'count(event { event.name eq "qualifier" }) gte 1',
  'count(event { event.name eq "other" }) eq 0',
  "count(page) gte 2",
  "count(event) in [0, 1, 2]",
  'page.path neq "/excluded"',
  'page.path eq "/pricing"',
  "count(page) gt 0",
  "count(event) gte 2",
] as const;

/** A fixed seed makes a generated failure independently reproducible. */
export function generateDifferentialFilterCases(
  seed: number,
  count: number,
  leaves: readonly string[] = LEAVES,
): readonly DifferentialFilterCase[] {
  if (leaves.length === 0) throw new RangeError("A filter leaf is required.");
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const leaf = (): DifferentialFilterTree => ({
    kind: "leaf",
    dsl: leaves[next() % leaves.length]!,
  });
  return Array.from({ length: count }, (_, index) => {
    let tree = leaf();
    // Rotate the outer shape so every run covers NOT, AND and OR, rather than
    // relying on a random sample to happen to include all three operators.
    if (index % 3 === 0) tree = { kind: "not", child: tree };
    else
      tree = {
        kind: index % 3 === 1 ? "and" : "or",
        left: tree,
        right: index % 2 === 0 ? { kind: "not", child: leaf() } : leaf(),
      };
    return { seed, index, tree };
  });
}

function renderTree(tree: DifferentialFilterTree): string {
  if (tree.kind === "leaf") return tree.dsl;
  if (tree.kind === "not") return `not (${renderTree(tree.child)})`;
  return `(${renderTree(tree.left)}) ${tree.kind} (${renderTree(tree.right)})`;
}

export function differentialFilterDsl(tree: DifferentialFilterTree): string {
  // This neutral Count gate keeps reduced examples in the same advanced
  // execution family, even when shrinking leaves only a native field leaf.
  return `count(page) gte 0 and (${renderTree(tree)})`;
}

export function* smallerFilterTrees(
  tree: DifferentialFilterTree,
): Generator<DifferentialFilterTree> {
  if (tree.kind === "leaf") return;
  if (tree.kind === "not") {
    yield tree.child;
    for (const child of smallerFilterTrees(tree.child))
      yield { kind: "not", child };
    return;
  }
  yield tree.left;
  yield tree.right;
  for (const left of smallerFilterTrees(tree.left)) yield { ...tree, left };
  for (const right of smallerFilterTrees(tree.right)) yield { ...tree, right };
}

export async function minimizeDifferentialFailure(
  tree: DifferentialFilterTree,
  stillFails: (candidate: DifferentialFilterTree) => Promise<boolean>,
  maxAttempts = 32,
): Promise<DifferentialFilterTree> {
  let smallest = tree;
  let attempts = 0;
  const seen = new Set<string>([differentialFilterDsl(tree)]);
  while (attempts < maxAttempts) {
    let reduced = false;
    for (const candidate of smallerFilterTrees(smallest)) {
      const key = differentialFilterDsl(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      attempts += 1;
      if (await stillFails(candidate)) {
        smallest = candidate;
        reduced = true;
        break;
      }
      if (attempts >= maxAttempts) break;
    }
    if (!reduced) break;
  }
  return smallest;
}

/** Compare complete report values; the caller controls the independent oracle. */
export async function checkDifferentialFilterCase<Value>(input: {
  readonly sample: DifferentialFilterCase;
  readonly reference: (dsl: string) => Promise<Value>;
  readonly candidates: Readonly<
    Record<string, (dsl: string) => Promise<Value>>
  >;
  /** Only explicitly expected domain errors may count as matching behavior. */
  readonly expectedError?: (error: unknown) => boolean;
}): Promise<void> {
  const outcome = async (execute: () => Promise<Value>) => {
    try {
      return { kind: "value" as const, value: await execute() };
    } catch (error) {
      // Error stacks contain execution details rather than public semantics.
      // Keep the error type, message and enumerable domain fields instead.
      return {
        kind: "error" as const,
        expected: input.expectedError?.(error) === true,
        error:
          error instanceof Error
            ? { ...error, name: error.name, message: error.message }
            : error,
      };
    }
  };
  const mismatch = async (tree: DifferentialFilterTree) => {
    const dsl = differentialFilterDsl(tree);
    const reference = await outcome(() => input.reference(dsl));
    for (const [strategy, execute] of Object.entries(input.candidates)) {
      const actual = await outcome(() => execute(dsl));
      if (
        (reference.kind === "error" && !reference.expected) ||
        (actual.kind === "error" && !actual.expected) ||
        !isDeepStrictEqual(actual, reference)
      )
        return { strategy, reference, actual };
    }
    return undefined;
  };
  const first = await mismatch(input.sample.tree);
  if (!first) return;
  const smallest = await minimizeDifferentialFailure(
    input.sample.tree,
    async (tree) => (await mismatch(tree)) !== undefined,
  );
  const final = await mismatch(smallest);
  throw new Error(
    `filter_differential_failure:${JSON.stringify({
      seed: input.sample.seed,
      case: input.sample.index,
      filter: differentialFilterDsl(smallest),
      ...final,
    })}`,
  );
}
