import { DatabaseCompilerError } from "@/lib/db/query/errors";
import type { AnyInListExpression } from "@/lib/db/query/expression";
import type { ValuesRelationNode } from "@/lib/db/query/plan";

import type {
  PhysicalMembershipOptimization,
  PhysicalMembershipOptimizationFacts,
  PhysicalMembershipStrategy,
  PhysicalQueryPlan,
  PhysicalTextRowJsonSegment,
  PhysicalTextRowStrategy,
} from "./contracts";

export const MAX_D1_JSON_MEMBERSHIP_BYTES = 1_000_000;

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function everyDenseMembershipValue(
  values: readonly unknown[],
  predicate: (value: unknown) => boolean,
): boolean {
  for (let index = 0; index < values.length; index++) {
    if (
      !Object.prototype.hasOwnProperty.call(values, index) ||
      !predicate(values[index])
    )
      return false;
  }
  return true;
}

function encodedJsonMembershipValues(
  expression: AnyInListExpression,
): { jsonText: string; jsonUtf8Bytes: number } | undefined {
  const affinity = expression.expression.resultType.affinity;
  const isTextList =
    affinity === "text" &&
    everyDenseMembershipValue(
      expression.values,
      (value) => typeof value === "string" && hasWellFormedUtf16(value),
    );
  const isSafeIntegerList =
    (affinity === "integer" || affinity === "real" || affinity === "numeric") &&
    everyDenseMembershipValue(
      expression.values,
      (value) => typeof value === "number" && Number.isSafeInteger(value),
    );
  if (expression.values.length < 2 || (!isTextList && !isSafeIntegerList))
    return undefined;
  const jsonText = JSON.stringify(expression.values);
  const jsonUtf8Bytes = new TextEncoder().encode(jsonText).byteLength;
  return jsonUtf8Bytes <= MAX_D1_JSON_MEMBERSHIP_BYTES
    ? { jsonText, jsonUtf8Bytes }
    : undefined;
}

function encodedJsonTextRows(
  node: ValuesRelationNode,
): readonly PhysicalTextRowJsonSegment[] | undefined {
  if (node.rows.length === 0) return undefined;
  const segments: PhysicalTextRowJsonSegment[] = [];
  let tuples: string[] = [];
  let tupleBytes = 0;
  for (const row of node.rows) {
    const tuple = JSON.stringify(row);
    const bytes = new TextEncoder().encode(tuple).byteLength;
    if (bytes + 2 > MAX_D1_JSON_MEMBERSHIP_BYTES) return undefined;
    const nextBytes = tupleBytes + bytes + (tuples.length === 0 ? 0 : 1) + 2;
    if (tuples.length > 0 && nextBytes > MAX_D1_JSON_MEMBERSHIP_BYTES) {
      const jsonText = `[${tuples.join(",")}]`;
      segments.push({
        jsonText,
        jsonUtf8Bytes: new TextEncoder().encode(jsonText).byteLength,
      });
      tuples = [];
      tupleBytes = 0;
    }
    tuples.push(tuple);
    tupleBytes += bytes + (tuples.length === 1 ? 0 : 1);
  }
  if (tuples.length > 0) {
    const jsonText = `[${tuples.join(",")}]`;
    segments.push({
      jsonText,
      jsonUtf8Bytes: new TextEncoder().encode(jsonText).byteLength,
    });
  }
  return segments.every(
    (segment) => segment.jsonUtf8Bytes <= MAX_D1_JSON_MEMBERSHIP_BYTES,
  )
    ? segments
    : undefined;
}

/** Select the generic D1 physical representation from measured final-shape costs. */
export function optimizePhysicalMembershipBudget<Row extends object>(
  plan: PhysicalQueryPlan<Row>,
  facts: PhysicalMembershipOptimizationFacts,
  bindingLimit: number,
): PhysicalQueryPlan<Row> {
  if (
    !Number.isInteger(facts.nativeBindingCount) ||
    facts.nativeBindingCount < 0 ||
    !Number.isInteger(bindingLimit) ||
    bindingLimit < 0
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Invalid physical membership budget facts",
    );

  const usage = facts.usage.map((item) => {
    if (!item || !item.expression || item.expression.kind !== "in-list")
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Invalid physical membership expression facts",
      );
    if (!Number.isInteger(item.occurrences) || item.occurrences < 1)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Invalid physical membership occurrence count",
      );
    return item;
  });
  const rowUsage = (facts.rowUsage ?? []).map((item) => {
    if (!item || !item.node || item.node.kind !== "values-relation")
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Invalid physical text row relation facts",
      );
    if (!Number.isInteger(item.occurrences) || item.occurrences < 1)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Invalid physical text row relation occurrence count",
      );
    return item;
  });

  const savingsByExpression = new Map<AnyInListExpression, number>();
  const encodingByExpression = new Map<
    AnyInListExpression,
    { readonly jsonText: string; readonly jsonUtf8Bytes: number } | undefined
  >();
  const savingsByRowNode = new Map<ValuesRelationNode, number>();
  const encodingByRowNode = new Map<
    ValuesRelationNode,
    readonly PhysicalTextRowJsonSegment[] | undefined
  >();
  let remaining = facts.nativeBindingCount;
  if (remaining > bindingLimit) {
    const rowCandidates = rowUsage.map((item, order) => {
      const encoding = encodedJsonTextRows(item.node);
      encodingByRowNode.set(item.node, encoding);
      return {
        ...item,
        order: usage.length + order,
        kind: "text-row" as const,
        saving: encoding
          ? item.occurrences *
            (item.node.rows.length * item.node.columns.length - encoding.length)
          : 0,
      };
    });
    const candidates = [
      ...usage.map((item, order) => ({
        ...item,
        order,
        kind: "membership" as const,
        saving: item.occurrences * (item.expression.values.length - 1),
      })),
      ...rowCandidates,
    ]
      .filter((item) => item.saving > 0)
      .sort(
        (left, right) => right.saving - left.saving || left.order - right.order,
      );
    for (const candidate of candidates) {
      if (remaining <= bindingLimit) break;
      if (candidate.kind === "membership") {
        let encoding = encodingByExpression.get(candidate.expression);
        if (!encoding && !encodingByExpression.has(candidate.expression)) {
          encoding = encodedJsonMembershipValues(candidate.expression);
          encodingByExpression.set(candidate.expression, encoding);
        }
        if (!encoding) continue;
        savingsByExpression.set(candidate.expression, candidate.saving);
        remaining -= candidate.saving;
      } else {
        const encoding = encodingByRowNode.get(candidate.node);
        if (!encoding) continue;
        savingsByRowNode.set(candidate.node, candidate.saving);
        remaining -= candidate.saving;
      }
    }
  }

  const strategies: PhysicalMembershipStrategy[] = usage.map((item) => {
    const nativeBindingsSaved = savingsByExpression.get(item.expression) ?? 0;
    if (nativeBindingsSaved === 0)
      return {
        expression: item.expression,
        occurrences: item.occurrences,
        strategy: "native",
        nativeBindingsSaved: 0,
      };
    const encoding = encodingByExpression.get(item.expression);
    if (!encoding)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Selected physical membership has no safe JSON encoding",
      );
    return {
      expression: item.expression,
      occurrences: item.occurrences,
      strategy: "json-text",
      jsonText: encoding.jsonText,
      jsonUtf8Bytes: encoding.jsonUtf8Bytes,
      nativeBindingsSaved,
    };
  });
  const rowStrategies: PhysicalTextRowStrategy[] = rowUsage.map((item) => {
    const nativeBindingsSaved = savingsByRowNode.get(item.node) ?? 0;
    if (nativeBindingsSaved === 0)
      return {
        node: item.node,
        occurrences: item.occurrences,
        strategy: "native",
        nativeBindingsSaved: 0,
      };
    const jsonSegments = encodingByRowNode.get(item.node);
    if (!jsonSegments)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Selected physical text row relation has no safe JSON encoding",
      );
    return {
      node: item.node,
      occurrences: item.occurrences,
      strategy: "json-rows",
      jsonSegments,
      nativeBindingsSaved,
    };
  });
  const packedRows = new Set(
    rowStrategies
      .filter((strategy) => strategy.strategy === "json-rows")
      .map((strategy) => strategy.node),
  );
  const tupleMemberships = (
    plan.positiveTupleMembershipCandidates ?? []
  ).filter(
    (candidate) =>
      candidate.membershipSource === "dynamic-distinct" ||
      (candidate.valuesRelation !== undefined &&
        packedRows.has(candidate.valuesRelation)),
  );

  return {
    ...plan,
    membershipOptimization: {
      nativeBindingCount: facts.nativeBindingCount,
      selectedBindingCount: remaining,
      strategies,
      rowStrategies,
      tupleMemberships,
    },
  };
}

export function hasSamePhysicalMembershipOptimization(
  actual: PhysicalMembershipOptimization | undefined,
  expected: PhysicalMembershipOptimization,
): boolean {
  const actualRowStrategies = actual?.rowStrategies ?? [];
  const expectedRowStrategies = expected.rowStrategies ?? [];
  const actualTupleMemberships = actual?.tupleMemberships ?? [];
  const expectedTupleMemberships = expected.tupleMemberships ?? [];
  if (
    !actual ||
    actual.nativeBindingCount !== expected.nativeBindingCount ||
    actual.selectedBindingCount !== expected.selectedBindingCount ||
    !Array.isArray(actual.strategies) ||
    actual.strategies.length !== expected.strategies.length ||
    !Array.isArray(actualRowStrategies) ||
    actualRowStrategies.length !== expectedRowStrategies.length ||
    !Array.isArray(actualTupleMemberships) ||
    actualTupleMemberships.length !== expectedTupleMemberships.length
  )
    return false;
  return (
    actual.strategies.every((item, index) => {
      const canonical = expected.strategies[index];
      return (
        !!item &&
        typeof item === "object" &&
        !!canonical &&
        item.expression === canonical.expression &&
        item.occurrences === canonical.occurrences &&
        item.strategy === canonical.strategy &&
        item.jsonText === canonical.jsonText &&
        item.jsonUtf8Bytes === canonical.jsonUtf8Bytes &&
        item.nativeBindingsSaved === canonical.nativeBindingsSaved
      );
    }) &&
    actualRowStrategies.every((item, index) => {
      const canonical = expectedRowStrategies[index];
      return (
        !!item &&
        typeof item === "object" &&
        !!canonical &&
        item.node === canonical.node &&
        item.occurrences === canonical.occurrences &&
        item.strategy === canonical.strategy &&
        item.nativeBindingsSaved === canonical.nativeBindingsSaved &&
        Array.isArray(item.jsonSegments) ===
          Array.isArray(canonical.jsonSegments) &&
        (item.jsonSegments ?? []).length ===
          (canonical.jsonSegments ?? []).length &&
        (item.jsonSegments ?? []).every(
          (segment: PhysicalTextRowJsonSegment, segmentIndex: number) => {
            const expectedSegment = canonical.jsonSegments?.[segmentIndex];
            return (
              !!expectedSegment &&
              segment.jsonText === expectedSegment.jsonText &&
              segment.jsonUtf8Bytes === expectedSegment.jsonUtf8Bytes
            );
          },
        )
      );
    }) &&
    actualTupleMemberships.every((item, index) => {
      const canonical = expectedTupleMemberships[index];
      return (
        !!item &&
        !!canonical &&
        item.project === canonical.project &&
        item.join === canonical.join &&
        item.membershipSource === canonical.membershipSource &&
        item.valuesRelation === canonical.valuesRelation &&
        item.leftKeyIndexes.length === canonical.leftKeyIndexes.length &&
        item.leftKeyIndexes.every(
          (column: number, columnIndex: number) =>
            column === canonical.leftKeyIndexes[columnIndex],
        ) &&
        item.rightKeyIndexes.length === canonical.rightKeyIndexes.length &&
        item.rightKeyIndexes.every(
          (column: number, columnIndex: number) =>
            column === canonical.rightKeyIndexes[columnIndex],
        )
      );
    })
  );
}
