import type { ExpressionAffinity } from "@/lib/db/query/expression";
import type {
  LogicalQueryNode,
  OutputField,
  QuerySource,
} from "@/lib/db/query/plan";
import type { SchemaColumnReference } from "@/lib/db/schema/types";

export type SemiMembershipStorageClass =
  "integer" | "real" | "text" | "blob" | "null";

export interface SemiMembershipDomainStep {
  readonly nodeKind: LogicalQueryNode["kind"];
  readonly outputIndex: number;
  readonly outputName: string | undefined;
  readonly sourceIndex?: number;
  readonly sourceName?: string;
}

export interface SemiMembershipComparisonDomain {
  readonly affinity: ExpressionAffinity;
  readonly storageClasses: readonly SemiMembershipStorageClass[];
  readonly path: readonly SemiMembershipDomainStep[];
}

export type SemiMembershipDomainAnalysis =
  | {
      readonly kind: "proven";
      readonly domain: SemiMembershipComparisonDomain;
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly at: SemiMembershipDomainStep;
    };

function sameOutputField(
  left: OutputField | undefined,
  right: OutputField | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.name === right.name &&
    left.affinity === right.affinity &&
    left.nullable === right.nullable,
  );
}

function sourceStep(
  source: QuerySource,
  index: number,
  sourceIndex?: number,
  sourceName?: string,
): SemiMembershipDomainStep {
  return {
    nodeKind: source.node.kind,
    outputIndex: index,
    outputName: source.fields[index]?.name,
    ...(sourceIndex === undefined ? {} : { sourceIndex }),
    ...(sourceName === undefined ? {} : { sourceName }),
  };
}

function rejected(
  source: QuerySource,
  index: number,
  reason: string,
): SemiMembershipDomainAnalysis {
  return { kind: "rejected", reason, at: sourceStep(source, index) };
}

function resolvedTableColumn(
  source: Extract<LogicalQueryNode, { kind: "scan" }>,
  index: number,
): SchemaColumnReference | undefined {
  if (source.table.kind !== "table") return undefined;
  const [propertyName, column] =
    Object.entries(source.table.columns)[index] ?? [];
  const field = source.fields[index];
  if (
    !propertyName ||
    !column ||
    !field ||
    column.kind !== "column" ||
    propertyName !== column.propertyName ||
    column.table !== source.table.name ||
    field.name !== propertyName ||
    field.affinity !== column.affinity ||
    field.nullable !== column.nullable ||
    declaredAffinity(column.declaredType) !== column.affinity
  )
    return undefined;
  return column;
}

function declaredAffinity(
  declaredType: string,
): SchemaColumnReference["affinity"] {
  const type = declaredType.toUpperCase();
  if (type.includes("INT")) return "integer";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT"))
    return "text";
  if (type.includes("BLOB") || type.length === 0) return "blob";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB"))
    return "real";
  return "numeric";
}

function validRowidAliasColumn(
  source: Extract<LogicalQueryNode, { kind: "scan" }>,
  index: number,
): boolean {
  const column = resolvedTableColumn(source, index);
  return Boolean(
    column &&
    column.rowidAlias === true &&
    column.declaredType.trim().toUpperCase() === "INTEGER" &&
    column.affinity === "integer" &&
    !column.nullable &&
    column.primaryKeyPosition === 1 &&
    source.table.kind === "table" &&
    source.table.primaryKey.length === 1 &&
    source.table.primaryKey[0] === column.sqlName,
  );
}

function validTextValuesDomain(
  source: Extract<LogicalQueryNode, { kind: "values-relation" }>,
  index: number,
): readonly SemiMembershipStorageClass[] | undefined {
  const column = source.columns[index];
  const field = source.fields[index];
  if (
    !column ||
    !field ||
    column.name !== field.name ||
    column.nullable !== field.nullable ||
    field.affinity !== "text"
  )
    return undefined;

  const classes = new Set<SemiMembershipStorageClass>();
  for (const row of source.rows) {
    if (!Array.isArray(row) || row.length !== source.columns.length)
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(row, index);
    if (!descriptor || !("value" in descriptor)) return undefined;
    if (typeof descriptor.value === "string") classes.add("text");
    else if (descriptor.value === null && column.nullable) classes.add("null");
    else return undefined;
  }
  return [...classes].sort();
}

function expressionDomain(
  source: Extract<LogicalQueryNode, { kind: "project" }>,
  index: number,
): readonly SemiMembershipStorageClass[] | undefined {
  const projection = source.projections[index];
  const field = source.fields[index];
  const expression = projection?.expression;
  if (!projection || !field || projection.name !== field.name || !expression)
    return undefined;

  if (expression.kind === "parameter") {
    if (
      (typeof expression.value !== "string" && expression.value !== null) ||
      expression.resultType.affinity !==
        (expression.value === null ? "unknown" : "text") ||
      expression.resultType.nullable !== (expression.value === null) ||
      field.affinity !== expression.resultType.affinity ||
      field.nullable !== expression.resultType.nullable
    )
      return undefined;
    return [expression.value === null ? "null" : "text"];
  }

  if (expression.kind === "constant") {
    if (
      (typeof expression.value !== "string" && expression.value !== null) ||
      expression.resultType.affinity !==
        (expression.value === null ? "unknown" : "text") ||
      expression.resultType.nullable !== (expression.value === null) ||
      field.affinity !== expression.resultType.affinity ||
      field.nullable !== expression.resultType.nullable
    )
      return undefined;
    return [expression.value === null ? "null" : "text"];
  }

  return undefined;
}

function withNull(
  classes: readonly SemiMembershipStorageClass[],
): readonly SemiMembershipStorageClass[] {
  return [...new Set([...classes, "null" as const])].sort();
}

function analyzeDomain(
  source: QuerySource,
  index: number,
  active: Set<LogicalQueryNode>,
): SemiMembershipDomainAnalysis {
  const node = source.node;
  const step = sourceStep(source, index);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= source.fields.length ||
    active.has(node)
  )
    return {
      kind: "rejected",
      reason: "invalid or recursive output index",
      at: step,
    };

  active.add(node);
  const finish = (result: SemiMembershipDomainAnalysis) => {
    active.delete(node);
    if (result.kind === "rejected") return result;
    return {
      kind: "proven" as const,
      domain: {
        ...result.domain,
        path: [step, ...result.domain.path],
      },
    };
  };
  const passthrough = (
    input: QuerySource,
    inputIndex: number,
    _reason: string,
  ): SemiMembershipDomainAnalysis => {
    return analyzeDomain(input, inputIndex, active);
  };

  let result: SemiMembershipDomainAnalysis;
  const field = source.fields[index];
  switch (node.kind) {
    case "scan": {
      if (validRowidAliasColumn(node, index)) {
        result = {
          kind: "proven",
          domain: {
            affinity: "integer",
            storageClasses: ["integer"],
            path: [],
          },
        };
        break;
      }
      const column = resolvedTableColumn(node, index);
      if (column?.affinity === "text") {
        result = {
          kind: "proven",
          domain: {
            affinity: field!.affinity,
            storageClasses: column.nullable
              ? ["blob", "null", "text"]
              : ["blob", "text"],
            path: [],
          },
        };
        break;
      }
      result = rejected(
        source,
        index,
        "catalog source is neither an exact INTEGER rowid alias nor a verified TEXT-affinity table column",
      );
      break;
    }
    case "values-relation": {
      const storageClasses = validTextValuesDomain(node, index);
      result = storageClasses
        ? {
            kind: "proven",
            domain: { affinity: field!.affinity, storageClasses, path: [] },
          }
        : rejected(
            source,
            index,
            "finite values output is not a dense, metadata-matched string/NULL column",
          );
      break;
    }
    case "filter":
    case "distinct":
    case "sort":
    case "limit":
      result = sameOutputField(field, node.input.fields[index])
        ? passthrough(node.input, index, "unverified passthrough")
        : rejected(
            source,
            index,
            "output field does not match its input field",
          );
      break;
    case "project": {
      const projection = node.projections[index];
      const expression = projection?.expression;
      if (
        projection &&
        field &&
        projection.name === field.name &&
        expression?.kind === "column" &&
        expression.scope === node.input.scope &&
        Number.isSafeInteger(expression.index) &&
        expression.index >= 0 &&
        expression.index < node.input.fields.length &&
        expression.name === node.input.fields[expression.index]?.name &&
        expression.resultType.affinity ===
          node.input.fields[expression.index]?.affinity &&
        expression.resultType.nullable ===
          node.input.fields[expression.index]?.nullable &&
        sameOutputField(field, {
          name: projection.name,
          affinity: expression.resultType.affinity,
          nullable: expression.resultType.nullable,
        })
      ) {
        result = passthrough(
          node.input,
          expression.index,
          "project is not a scope/index-checked direct-column passthrough",
        );
        break;
      }
      const storageClasses = expressionDomain(node, index);
      result = storageClasses
        ? {
            kind: "proven",
            domain: { affinity: field!.affinity, storageClasses, path: [] },
          }
        : rejected(
            source,
            index,
            "project output is neither an exact direct-column passthrough nor a verified text/NULL parameter or constant",
          );
      break;
    }
    case "join": {
      if (index < node.left.fields.length) {
        const inputField = node.left.fields[index];
        result =
          field?.name === `left_${inputField?.name}` &&
          field?.affinity === inputField?.affinity &&
          field?.nullable === inputField?.nullable
            ? passthrough(node.left, index, "left join output mismatch")
            : rejected(
                source,
                index,
                "left join output is not a mapped left field",
              );
      } else {
        const rightIndex = index - node.left.fields.length;
        const inputField = node.right.fields[rightIndex];
        const fieldMatches =
          field?.name === `right_${inputField?.name}` &&
          field?.affinity === inputField?.affinity &&
          (field?.nullable === inputField?.nullable ||
            (node.joinType === "left" && field?.nullable === true));
        const inputResult = fieldMatches
          ? analyzeDomain(node.right, rightIndex, active)
          : rejected(
              source,
              index,
              "right join output is not a mapped right field",
            );
        result =
          inputResult.kind === "proven" && node.joinType === "left"
            ? {
                kind: "proven",
                domain: {
                  ...inputResult.domain,
                  storageClasses: withNull(inputResult.domain.storageClasses),
                },
              }
            : inputResult;
      }
      break;
    }
    case "semi-join":
    case "anti-join":
      result = sameOutputField(field, node.left.fields[index])
        ? passthrough(node.left, index, "membership output mismatch")
        : rejected(
            source,
            index,
            "membership output is not a mapped left field",
          );
      break;
    case "union": {
      if (
        !node.all ||
        !sameOutputField(field, node.left.fields[index]) ||
        !sameOutputField(field, node.right.fields[index])
      ) {
        result = rejected(
          source,
          index,
          "UNION output is not an aligned UNION ALL field",
        );
        break;
      }
      const left = analyzeDomain(node.left, index, active);
      const right = analyzeDomain(node.right, index, active);
      if (left.kind === "rejected") result = left;
      else if (right.kind === "rejected") result = right;
      else {
        result = {
          kind: "proven",
          domain: {
            affinity: field!.affinity,
            storageClasses: [
              ...new Set([
                ...left.domain.storageClasses,
                ...right.domain.storageClasses,
              ]),
            ].sort(),
            path: [
              {
                ...step,
                sourceIndex: index,
                sourceName: node.left.fields[index]?.name,
              },
              ...left.domain.path,
              {
                ...step,
                sourceIndex: index,
                sourceName: node.right.fields[index]?.name,
              },
              ...right.domain.path,
            ],
          },
        };
      }
      break;
    }
    case "window":
      result =
        index < node.input.fields.length &&
        sameOutputField(field, node.input.fields[index])
          ? passthrough(node.input, index, "window input passthrough mismatch")
          : rejected(
              source,
              index,
              "computed window output has no comparison-domain proof",
            );
      break;
    case "aggregate": {
      const group = node.groups[index];
      const expression = group?.expression;
      const inputIndex = expression?.kind === "column" ? expression.index : -1;
      const inputField = node.input.fields[inputIndex];
      if (
        group &&
        expression?.kind === "column" &&
        group.name === field?.name &&
        expression.scope === node.input.scope &&
        Number.isSafeInteger(inputIndex) &&
        inputIndex >= 0 &&
        inputIndex < node.input.fields.length &&
        expression.name === inputField?.name &&
        expression.resultType.affinity === inputField?.affinity &&
        expression.resultType.nullable === inputField?.nullable &&
        sameOutputField(field, {
          name: group.name,
          affinity: expression.resultType.affinity,
          nullable: expression.resultType.nullable,
        })
      ) {
        result = passthrough(
          node.input,
          inputIndex,
          "group key mapping mismatch",
        );
      } else {
        result = rejected(
          source,
          index,
          "aggregate output is not a metadata-matched direct GROUP BY column",
        );
      }
      break;
    }
    case "recursive-closure":
    case "json-scalar-array":
      result = rejected(
        source,
        index,
        "node output has no comparison-domain proof",
      );
      break;
  }
  return finish(result);
}

export function semiMembershipComparisonDomain(
  source: QuerySource,
  index: number,
): SemiMembershipDomainAnalysis {
  return analyzeDomain(source, index, new Set());
}

export type SemiMembershipCollationAnalysis =
  | {
      readonly kind: "binary";
      readonly path: readonly SemiMembershipDomainStep[];
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly at: SemiMembershipDomainStep;
    };

function analyzeBinaryCollation(
  source: QuerySource,
  index: number,
  active: Set<LogicalQueryNode>,
): SemiMembershipCollationAnalysis {
  const node = source.node;
  const step = sourceStep(source, index);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= source.fields.length ||
    active.has(node)
  )
    return {
      kind: "rejected",
      reason: "invalid or recursive output index",
      at: step,
    };
  active.add(node);
  const finish = (result: SemiMembershipCollationAnalysis) => {
    active.delete(node);
    return result.kind === "binary"
      ? { kind: "binary" as const, path: [step, ...result.path] }
      : result;
  };
  const passthrough = (
    input: QuerySource,
    inputIndex: number,
  ): SemiMembershipCollationAnalysis => {
    return analyzeBinaryCollation(input, inputIndex, active);
  };

  let result: SemiMembershipCollationAnalysis;
  switch (node.kind) {
    case "scan":
      result =
        node.table.defaultCollation === "BINARY" &&
        resolvedTableColumn(node, index)
          ? { kind: "binary", path: [] }
          : {
              kind: "rejected",
              reason: "catalog column collation is not verified as BINARY",
              at: step,
            };
      break;
    case "values-relation":
      result = validTextValuesDomain(node, index)
        ? { kind: "binary", path: [] }
        : {
            kind: "rejected",
            reason: "finite values output collation is not verified",
            at: step,
          };
      break;
    case "filter":
    case "distinct":
    case "sort":
    case "limit":
      result = sameOutputField(source.fields[index], node.input.fields[index])
        ? passthrough(node.input, index)
        : {
            kind: "rejected",
            reason: "output field does not preserve input collation",
            at: step,
          };
      break;
    case "window":
      result =
        index < node.input.fields.length &&
        sameOutputField(source.fields[index], node.input.fields[index])
          ? passthrough(node.input, index)
          : {
              kind: "rejected",
              reason: "computed window output collation is not proven",
              at: step,
            };
      break;
    case "project": {
      const expression = node.projections[index]?.expression;
      if (
        expression?.kind === "column" &&
        expression.scope === node.input.scope &&
        Number.isSafeInteger(expression.index) &&
        expression.index >= 0 &&
        expression.index < node.input.fields.length &&
        expression.name === node.input.fields[expression.index]?.name &&
        expression.resultType.affinity ===
          node.input.fields[expression.index]?.affinity &&
        expression.resultType.nullable ===
          node.input.fields[expression.index]?.nullable &&
        sameOutputField(source.fields[index], {
          name: node.projections[index]?.name ?? "",
          affinity: expression.resultType.affinity,
          nullable: expression.resultType.nullable,
        })
      ) {
        result = passthrough(node.input, expression.index);
      } else {
        const domain = expressionDomain(node, index);
        result = domain
          ? { kind: "binary", path: [] }
          : {
              kind: "rejected",
              reason:
                "project expression collation is not a direct BINARY column or scalar text/NULL",
              at: step,
            };
      }
      break;
    }
    case "join":
      if (index < node.left.fields.length) {
        result =
          source.fields[index]?.name === `left_${node.left.fields[index]?.name}`
            ? passthrough(node.left, index)
            : {
                kind: "rejected",
                reason:
                  "left join output does not preserve its input collation",
                at: step,
              };
      } else {
        const rightIndex = index - node.left.fields.length;
        result =
          source.fields[index]?.name ===
          `right_${node.right.fields[rightIndex]?.name}`
            ? passthrough(node.right, rightIndex)
            : {
                kind: "rejected",
                reason:
                  "right join output does not preserve its input collation",
                at: step,
              };
      }
      break;
    case "semi-join":
    case "anti-join":
      result = sameOutputField(source.fields[index], node.left.fields[index])
        ? passthrough(node.left, index)
        : {
            kind: "rejected",
            reason: "membership output does not preserve its left collation",
            at: step,
          };
      break;
    case "union":
      if (
        !node.all ||
        !sameOutputField(source.fields[index], node.left.fields[index]) ||
        !sameOutputField(source.fields[index], node.right.fields[index])
      ) {
        result = {
          kind: "rejected",
          reason: "UNION output does not align a UNION ALL BINARY column",
          at: step,
        };
        break;
      }
      {
        const left = analyzeBinaryCollation(node.left, index, active);
        const right = analyzeBinaryCollation(node.right, index, active);
        result = left.kind === "rejected" ? left : right;
        if (left.kind === "binary" && right.kind === "binary")
          result = { kind: "binary", path: [...left.path, ...right.path] };
      }
      break;
    case "aggregate": {
      const group = node.groups[index];
      const expression = group?.expression;
      const inputIndex = expression?.kind === "column" ? expression.index : -1;
      result =
        group &&
        expression?.kind === "column" &&
        group.name === source.fields[index]?.name &&
        expression.scope === node.input.scope &&
        Number.isSafeInteger(inputIndex) &&
        inputIndex >= 0 &&
        inputIndex < node.input.fields.length &&
        expression.name === node.input.fields[inputIndex]?.name &&
        expression.resultType.affinity ===
          node.input.fields[inputIndex]?.affinity &&
        expression.resultType.nullable ===
          node.input.fields[inputIndex]?.nullable &&
        sameOutputField(source.fields[index], {
          name: group.name,
          affinity: expression.resultType.affinity,
          nullable: expression.resultType.nullable,
        })
          ? passthrough(node.input, inputIndex)
          : {
              kind: "rejected",
              reason: "aggregate output is not a direct GROUP BY column",
              at: step,
            };
      break;
    }
    case "recursive-closure":
    case "json-scalar-array":
      result = {
        kind: "rejected",
        reason: "node output collation is not proven",
        at: step,
      };
      break;
  }
  return finish(result);
}

export function semiMembershipBinaryCollation(
  source: QuerySource,
  index: number,
): SemiMembershipCollationAnalysis {
  return analyzeBinaryCollation(source, index, new Set());
}

export function isTextComparisonStorageClass(
  storageClass: SemiMembershipStorageClass,
): boolean {
  return (
    storageClass === "text" ||
    storageClass === "blob" ||
    storageClass === "null"
  );
}
