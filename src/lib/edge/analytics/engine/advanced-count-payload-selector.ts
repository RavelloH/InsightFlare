import type {
  FilterExpression,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

function visitTargetForPayload(
  target: FilterTargetExpression,
  paths: Set<string>,
  registeredStringLiterals?: { value: boolean },
): void {
  if (target.kind === "event-payload") paths.add(target.path);
  if (target.kind === "selector") {
    visitTargetForPayload(target.collection, paths, registeredStringLiterals);
    visitPayloadExpression(target.predicate, paths, registeredStringLiterals);
  } else if (target.kind === "reducer") {
    visitTargetForPayload(target.input, paths, registeredStringLiterals);
  } else if (target.kind === "arithmetic") {
    visitTargetForPayload(target.left, paths, registeredStringLiterals);
    visitTargetForPayload(target.right, paths, registeredStringLiterals);
  } else if (target.kind === "member") {
    visitTargetForPayload(target.object, paths, registeredStringLiterals);
  } else if (target.kind === "projection") {
    visitTargetForPayload(target.collection, paths, registeredStringLiterals);
  } else if (target.kind === "window") {
    visitTargetForPayload(target.collection, paths, registeredStringLiterals);
    visitTargetForPayload(target.anchor, paths, registeredStringLiterals);
  } else if (target.kind === "periods") {
    visitTargetForPayload(target.collection, paths, registeredStringLiterals);
  } else if (
    target.kind === "context-intrinsic" &&
    target.intrinsic === "same"
  ) {
    visitTargetForPayload(target.input, paths, registeredStringLiterals);
  } else if (target.kind === "occurrence-time") {
    visitTargetForPayload(target.input, paths, registeredStringLiterals);
  } else if (target.kind === "bucket") {
    visitTargetForPayload(target.input, paths, registeredStringLiterals);
  }
}

function visitPayloadExpression(
  expression: FilterExpression,
  paths: Set<string>,
  registeredStringLiterals?: { value: boolean },
): void {
  if (expression.kind === "not") {
    visitPayloadExpression(expression.child, paths, registeredStringLiterals);
    return;
  }
  if (expression.kind === "and" || expression.kind === "or") {
    expression.children.forEach((child) =>
      visitPayloadExpression(child, paths, registeredStringLiterals),
    );
    return;
  }
  if (expression.kind !== "condition") return;
  if (registeredStringLiterals && expression.target.kind === "field") {
    const values = Array.isArray(expression.value)
      ? expression.value
      : [expression.value];
    if (
      values.some(
        (value) => typeof value === "string" && !isAsciiCodeUnitString(value),
      )
    )
      registeredStringLiterals.value = false;
  }
  visitTargetForPayload(expression.target, paths, registeredStringLiterals);
}

function isAsciiCodeUnitString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1)
    if (value.charCodeAt(index) > 0x7f) return false;
  return true;
}

/** Paths in the complete count tree, after selector support has been checked. */
export function advancedCountPayloadPaths(
  expression: FilterExpression,
): readonly string[] {
  const paths = new Set<string>();
  visitPayloadExpression(expression, paths);
  return [...paths].sort();
}

/** True when every registered string literal in a payload count tree is ASCII. */
export function advancedCountRegisteredStringLiteralsAreAscii(
  expression: FilterExpression,
): boolean {
  const registeredStringLiterals = { value: true };
  visitPayloadExpression(expression, new Set(), registeredStringLiterals);
  return registeredStringLiterals.value;
}
