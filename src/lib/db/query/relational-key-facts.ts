import type {
  SchemaColumnReference,
  SchemaObjectReference,
  SchemaTableReference,
  SqliteAffinity,
} from "@/lib/db/schema/types";

import type { SqlExpression } from "./expression";
import type {
  LogicalQueryNode,
  QuerySource,
  RowNumberWindowSpec,
} from "./plan";

type ProvenCollation = "BINARY" | "unknown";
type ProvenStorageDomain = SqliteAffinity | "unknown";
type LookupComparisonContract = "catalog-affinity" | "storage-domain" | "none";

interface UniqueKeyFact {
  /** Output field positions whose tuple is unique when required fields are non-null. */
  readonly fields: readonly number[];
  readonly collations: readonly ProvenCollation[];
  readonly requiredNonNull: readonly number[];
  /** Per-field proof that a strict equality lookup uses the same comparator as this key. */
  readonly lookupContracts: readonly LookupComparisonContract[];
}

interface KnownConstant {
  readonly kind: "integer" | "text" | "null";
  readonly value: number | string | null;
}

interface RelationKeyFacts {
  readonly keys: readonly UniqueKeyFact[];
  readonly nonNullFields: ReadonlySet<number>;
  readonly fieldCollations: readonly ProvenCollation[];
  /** Storage classes preserved by SQLite column affinity and direct projections. */
  readonly fieldStorageDomains: readonly ProvenStorageDomain[];
  readonly constants: ReadonlyMap<number, KnownConstant>;
  /** ROW_NUMBER output field -> the direct partition tuple that yields rank one. */
  readonly rowNumberPartitions: ReadonlyMap<number, UniqueKeyFact>;
}

const MAX_KEY_FACTS = 64;
const MAX_KEY_COMBINATIONS = 128;
const STRICT_COMPARISONS = new Set(["=", "<>", ">", ">=", "<", "<="]);

function unknownFacts(source: QuerySource): RelationKeyFacts {
  return {
    keys: [],
    nonNullFields: new Set(
      source.fields.flatMap((field, index) => (field.nullable ? [] : [index])),
    ),
    fieldCollations: source.fields.map(() => "unknown"),
    fieldStorageDomains: source.fields.map(() => "unknown"),
    constants: new Map(),
    rowNumberPartitions: new Map(),
  };
}

function keyId(key: UniqueKeyFact): string {
  return `${key.fields.join(",")}|${key.collations.join(",")}|${key.requiredNonNull.join(",")}|${key.lookupContracts.join(",")}`;
}

function uniqueKeys(keys: readonly UniqueKeyFact[]): UniqueKeyFact[] {
  const seen = new Set<string>();
  const output: UniqueKeyFact[] = [];
  for (const key of keys) {
    if (
      key.fields.length !== key.collations.length ||
      key.fields.length !== key.lookupContracts.length
    )
      continue;
    if (key.fields.some((field) => !Number.isInteger(field) || field < 0))
      continue;
    const id = keyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(key);
    if (output.length >= MAX_KEY_FACTS) break;
  }
  return output;
}

function columnsForTable(
  table: SchemaObjectReference,
): SchemaColumnReference[] {
  return Object.values(table.columns);
}

function tableFieldIndex(
  columns: readonly SchemaColumnReference[],
  name: string,
): number {
  return columns.findIndex(
    (column) => column.sqlName === name || column.propertyName === name,
  );
}

function scanFacts(source: QuerySource): RelationKeyFacts {
  const node = source.node;
  if (node.kind !== "scan" || node.table.kind !== "table")
    return unknownFacts(source);

  const table = node.table as SchemaTableReference;
  const columns = columnsForTable(table);
  const fieldCollations = columns.map<ProvenCollation>(() =>
    table.defaultCollation === "BINARY" ? "BINARY" : "unknown",
  );
  const fieldStorageDomains = columns.map<ProvenStorageDomain>((column) =>
    column.generated
      ? "unknown"
      : column.rowidAlias === true
        ? "integer"
        : column.affinity,
  );
  const nonNullFields = new Set<number>();
  const keys: UniqueKeyFact[] = [];

  for (const [index, column] of columns.entries())
    if (!column.nullable || column.rowidAlias === true)
      nonNullFields.add(index);

  const addKey = (
    fields: readonly number[],
    collations: readonly ProvenCollation[],
  ): void => {
    if (
      fields.length === 0 ||
      fields.length !== collations.length ||
      collations.some((collation) => collation !== "BINARY") ||
      fields.some((field) => field < 0 || field >= columns.length)
    )
      return;
    const requiredNonNull = fields.filter(
      (field) =>
        columns[field]!.nullable && columns[field]!.rowidAlias !== true,
    );
    keys.push({
      fields,
      collations,
      requiredNonNull,
      lookupContracts: fields.map(() => "catalog-affinity"),
    });
  };

  if (table.defaultCollation === "BINARY" && table.primaryKey.length > 0) {
    const primaryFields = table.primaryKey.map((name) =>
      tableFieldIndex(columns, name),
    );
    addKey(
      primaryFields,
      primaryFields.map(() => "BINARY"),
    );
  }

  for (const index of table.indexes) {
    if (
      !index.unique ||
      index.partial ||
      index.rawExpressionSql !== undefined ||
      index.columns.length === 0 ||
      !index.collations ||
      index.collations.length !== index.columns.length
    )
      continue;
    const fields = index.columns.map((name) =>
      name === null ? -1 : tableFieldIndex(columns, name),
    );
    const collations = index.collations.map<ProvenCollation>((collation) =>
      collation === "BINARY" ? "BINARY" : "unknown",
    );
    if (
      fields.some((field) => field < 0) ||
      fields.some((field) => fieldCollations[field] !== "BINARY")
    )
      continue;
    addKey(fields, collations);
  }

  return {
    keys: uniqueKeys(keys),
    nonNullFields,
    fieldCollations,
    fieldStorageDomains,
    constants: new Map(),
    rowNumberPartitions: new Map(),
  };
}

function cloneFacts(
  source: QuerySource,
  facts: RelationKeyFacts,
): RelationKeyFacts {
  return {
    keys: uniqueKeys(facts.keys),
    nonNullFields: new Set(facts.nonNullFields),
    fieldCollations: Array.from(
      { length: source.fields.length },
      (_, index) => facts.fieldCollations[index] ?? "unknown",
    ),
    fieldStorageDomains: Array.from(
      { length: source.fields.length },
      (_, index) => facts.fieldStorageDomains[index] ?? "unknown",
    ),
    constants: new Map(facts.constants),
    rowNumberPartitions: new Map(facts.rowNumberPartitions),
  };
}

function directColumnIndex(
  expression: SqlExpression,
  source: QuerySource,
): number | undefined {
  return expression.kind === "column" &&
    expression.scope === source.scope &&
    Number.isInteger(expression.index) &&
    expression.index >= 0 &&
    expression.index < source.fields.length
    ? expression.index
    : undefined;
}

function knownConstant(expression: SqlExpression): KnownConstant | undefined {
  if (expression.kind !== "parameter" && expression.kind !== "constant")
    return undefined;
  if (expression.value === null) return { kind: "null", value: null };
  if (typeof expression.value === "string")
    return { kind: "text", value: expression.value };
  if (
    typeof expression.value === "number" &&
    Number.isSafeInteger(expression.value) &&
    !Object.is(expression.value, -0)
  )
    return { kind: "integer", value: expression.value };
  return undefined;
}

function isRankOneConstant(expression: SqlExpression): boolean {
  const value = knownConstant(expression);
  return value?.kind === "integer" && value.value === 1;
}

function lookupContractForStorageDomain(
  domain: ProvenStorageDomain,
): LookupComparisonContract {
  return domain === "unknown" ? "none" : "storage-domain";
}

function equalConstants(
  left: KnownConstant | undefined,
  right: KnownConstant | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.kind === right.kind &&
    left.value === right.value
  );
}

function areDistinctUnionTags(
  left: KnownConstant | undefined,
  right: KnownConstant | undefined,
  affinity: QuerySource["fields"][number]["affinity"],
  leftCollation: ProvenCollation,
  rightCollation: ProvenCollation,
): boolean {
  if (
    !left ||
    !right ||
    left.kind !== right.kind ||
    left.kind === "null" ||
    left.value === right.value
  )
    return false;
  if (left.kind === "integer")
    return affinity === "integer" || affinity === "numeric";
  return (
    left.kind === "text" &&
    affinity === "text" &&
    leftCollation === "BINARY" &&
    rightCollation === "BINARY"
  );
}

function isValidKey(key: UniqueKeyFact, facts: RelationKeyFacts): boolean {
  return key.requiredNonNull.every((field) => facts.nonNullFields.has(field));
}

function mapKeyThroughProjection(
  key: UniqueKeyFact,
  inputToOutput: ReadonlyMap<number, readonly number[]>,
  maximum: number,
): UniqueKeyFact[] {
  let candidates: number[][] = [[]];
  for (const field of key.fields) {
    const outputFields = inputToOutput.get(field) ?? [];
    if (outputFields.length === 0) return [];
    const next: number[][] = [];
    for (const candidate of candidates) {
      for (const outputField of outputFields) {
        next.push([...candidate, outputField]);
        if (next.length >= maximum) break;
      }
      if (next.length >= maximum) break;
    }
    candidates = next;
  }

  return candidates.map((fields) => ({
    fields,
    collations: key.collations,
    lookupContracts: key.lookupContracts,
    requiredNonNull: key.fields.flatMap((inputField, index) =>
      key.requiredNonNull.includes(inputField) ? [fields[index]!] : [],
    ),
  }));
}

function projectFacts(
  source: QuerySource,
  node: Extract<LogicalQueryNode, { kind: "project" }>,
  input: RelationKeyFacts,
): RelationKeyFacts {
  const inputToOutput = new Map<number, number[]>();
  const fieldCollations: ProvenCollation[] = [];
  const fieldStorageDomains: ProvenStorageDomain[] = [];
  const nonNullFields = new Set<number>();
  const constants = new Map<number, KnownConstant>();

  for (const [index, { expression }] of node.projections.entries()) {
    const inputIndex = directColumnIndex(expression, node.input);
    if (inputIndex !== undefined) {
      const outputs = inputToOutput.get(inputIndex) ?? [];
      outputs.push(index);
      inputToOutput.set(inputIndex, outputs);
      fieldCollations[index] = input.fieldCollations[inputIndex] ?? "unknown";
      fieldStorageDomains[index] =
        input.fieldStorageDomains[inputIndex] ?? "unknown";
      if (input.nonNullFields.has(inputIndex)) nonNullFields.add(index);
      const value = input.constants.get(inputIndex);
      if (value) constants.set(index, value);
    } else {
      fieldCollations[index] = "unknown";
      if (!expression.resultType.nullable) nonNullFields.add(index);
      const value = knownConstant(expression);
      if (value) {
        constants.set(index, value);
        if (value.kind !== "null") nonNullFields.add(index);
        if (value.kind !== "null") fieldCollations[index] = "BINARY";
        // A SQL literal or parameter has a known runtime value, but a
        // subquery column around it does not gain a stored-column affinity.
        fieldStorageDomains[index] = "unknown";
      } else {
        fieldStorageDomains[index] = "unknown";
      }
    }
  }

  const keys = input.keys.flatMap((key) =>
    mapKeyThroughProjection(key, inputToOutput, MAX_KEY_COMBINATIONS),
  );
  const rowNumberPartitions = new Map<number, UniqueKeyFact>();
  for (const [rankField, partition] of input.rowNumberPartitions) {
    for (const mapped of mapKeyThroughProjection(
      partition,
      inputToOutput,
      MAX_KEY_COMBINATIONS,
    )) {
      const outputRankFields = inputToOutput.get(rankField) ?? [];
      for (const outputRankField of outputRankFields)
        rowNumberPartitions.set(outputRankField, mapped);
    }
  }

  return {
    keys: uniqueKeys(keys),
    nonNullFields,
    fieldCollations: source.fields.map(
      (_field, index) => fieldCollations[index] ?? "unknown",
    ),
    fieldStorageDomains: source.fields.map(
      (_field, index) => fieldStorageDomains[index] ?? "unknown",
    ),
    constants,
    rowNumberPartitions,
  };
}

function collectConjuncts(
  expression: SqlExpression,
  visit: (term: SqlExpression) => void,
): void {
  if (expression.kind === "boolean" && expression.operator === "AND") {
    expression.expressions.forEach((term) => collectConjuncts(term, visit));
    return;
  }
  visit(expression);
}

function filterFacts(
  source: QuerySource,
  node: Extract<LogicalQueryNode, { kind: "filter" }>,
  input: RelationKeyFacts,
): RelationKeyFacts {
  const nonNullFields = new Set(input.nonNullFields);
  collectConjuncts(node.predicate, (term) => {
    if (term.kind === "null-check" && term.not) {
      const field = directColumnIndex(term.expression, node.input);
      if (field !== undefined) nonNullFields.add(field);
      return;
    }
    if (term.kind === "binary" && STRICT_COMPARISONS.has(term.operator)) {
      const left = directColumnIndex(term.left, node.input);
      const right = directColumnIndex(term.right, node.input);
      if (left !== undefined) nonNullFields.add(left);
      if (right !== undefined) nonNullFields.add(right);
    }
  });

  const keys = [...input.keys];
  collectConjuncts(node.predicate, (term) => {
    if (term.kind !== "binary" || term.operator !== "=") return;
    const candidates = [
      [term.left, term.right],
      [term.right, term.left],
    ] as const;
    for (const [column, value] of candidates) {
      const field = directColumnIndex(column, node.input);
      const partition =
        field === undefined ? undefined : input.rowNumberPartitions.get(field);
      if (field !== undefined && partition && isRankOneConstant(value))
        keys.push(partition);
    }
  });

  return {
    ...cloneFacts(source, input),
    keys: uniqueKeys(keys),
    nonNullFields,
  };
}

interface StrictEqualityPair {
  readonly left: number;
  readonly right: number;
}

function strictEqualityPairs(
  expression: SqlExpression,
  left: QuerySource,
  right: QuerySource,
): readonly StrictEqualityPair[] {
  const pairs: StrictEqualityPair[] = [];
  collectConjuncts(expression, (term) => {
    if (term.kind !== "binary" || term.operator !== "=") return;
    const combinations = [
      [term.left, term.right],
      [term.right, term.left],
    ] as const;
    for (const [leftExpression, rightExpression] of combinations) {
      const leftIndex = directColumnIndex(leftExpression, left);
      const rightIndex = directColumnIndex(rightExpression, right);
      if (leftIndex !== undefined && rightIndex !== undefined)
        pairs.push({ left: leftIndex, right: rightIndex });
    }
  });
  return pairs;
}

function strictLookupIsAtMostOne(
  uniqueSide: QuerySource,
  uniqueFacts: RelationKeyFacts,
  otherSide: QuerySource,
  otherFacts: RelationKeyFacts,
  pairs: readonly StrictEqualityPair[],
  uniqueSideIsRight: boolean,
): boolean {
  return uniqueFacts.keys.some((key) =>
    key.fields.every((uniqueField, position) => {
      const pair = pairs.find((candidate) =>
        uniqueSideIsRight
          ? candidate.right === uniqueField
          : candidate.left === uniqueField,
      );
      if (!pair) return false;
      const otherField = uniqueSideIsRight ? pair.left : pair.right;
      const uniqueCollation = key.collations[position];
      if (
        uniqueCollation !== "BINARY" ||
        uniqueFacts.fieldCollations[uniqueField] !== uniqueCollation ||
        otherFacts.fieldCollations[otherField] !== uniqueCollation
      )
        return false;
      const uniqueAffinity = uniqueSide.fields[uniqueField]?.affinity;
      const otherAffinity = otherSide.fields[otherField]?.affinity;
      if (uniqueAffinity !== otherAffinity) return false;

      switch (key.lookupContracts[position]) {
        case "catalog-affinity":
          return true;
        case "storage-domain":
          return (
            uniqueFacts.fieldStorageDomains[uniqueField] !== "unknown" &&
            uniqueFacts.fieldStorageDomains[uniqueField] ===
              otherFacts.fieldStorageDomains[otherField] &&
            uniqueAffinity === uniqueFacts.fieldStorageDomains[uniqueField]
          );
        case "none":
          return false;
      }
    }),
  );
}

function offsetKey(key: UniqueKeyFact, offset: number): UniqueKeyFact {
  return {
    fields: key.fields.map((field) => field + offset),
    collations: key.collations,
    lookupContracts: key.lookupContracts,
    requiredNonNull: key.requiredNonNull.map((field) => field + offset),
  };
}

function joinFacts(
  source: QuerySource,
  node: Extract<LogicalQueryNode, { kind: "join" }>,
  left: RelationKeyFacts,
  right: RelationKeyFacts,
): RelationKeyFacts {
  const offset = node.left.fields.length;
  const pairs = strictEqualityPairs(node.condition, node.left, node.right);
  const rightAtMostOne = strictLookupIsAtMostOne(
    node.right,
    right,
    node.left,
    left,
    pairs,
    true,
  );
  const leftAtMostOne =
    node.joinType === "inner" &&
    strictLookupIsAtMostOne(node.left, left, node.right, right, pairs, false);

  const keys: UniqueKeyFact[] = [];
  if (rightAtMostOne) keys.push(...left.keys);
  if (leftAtMostOne)
    keys.push(...right.keys.map((key) => offsetKey(key, offset)));
  if (node.joinType === "inner") {
    for (const leftKey of left.keys) {
      for (const rightKey of right.keys) {
        keys.push({
          fields: [
            ...leftKey.fields,
            ...rightKey.fields.map((field) => field + offset),
          ],
          collations: [...leftKey.collations, ...rightKey.collations],
          lookupContracts: [
            ...leftKey.lookupContracts,
            ...rightKey.lookupContracts,
          ],
          requiredNonNull: [
            ...leftKey.requiredNonNull,
            ...rightKey.requiredNonNull.map((field) => field + offset),
          ],
        });
        if (keys.length >= MAX_KEY_COMBINATIONS) break;
      }
      if (keys.length >= MAX_KEY_COMBINATIONS) break;
    }
  }

  const nonNullFields = new Set(left.nonNullFields);
  if (node.joinType === "inner")
    for (const field of right.nonNullFields) nonNullFields.add(field + offset);
  const constants = new Map(left.constants);
  if (node.joinType === "inner")
    for (const [field, value] of right.constants)
      constants.set(field + offset, value);

  return {
    keys: uniqueKeys(keys),
    nonNullFields,
    fieldCollations: source.fields.map((_field, index) =>
      index < offset
        ? (left.fieldCollations[index] ?? "unknown")
        : (right.fieldCollations[index - offset] ?? "unknown"),
    ),
    fieldStorageDomains: source.fields.map((_field, index) =>
      index < offset
        ? (left.fieldStorageDomains[index] ?? "unknown")
        : (right.fieldStorageDomains[index - offset] ?? "unknown"),
    ),
    constants,
    // A join may multiply rows, so rank-one partition facts do not cross it.
    rowNumberPartitions: new Map(),
  };
}

function discriminatorKeyFacts(
  source: QuerySource,
  left: RelationKeyFacts,
  right: RelationKeyFacts,
): UniqueKeyFact[] {
  const keys: UniqueKeyFact[] = [];
  for (const leftKey of left.keys) {
    for (const rightKey of right.keys) {
      const keyFields = [...new Set([...leftKey.fields, ...rightKey.fields])];
      const keyCollations = keyFields.map((field) => {
        const leftPosition = leftKey.fields.indexOf(field);
        const rightPosition = rightKey.fields.indexOf(field);
        if (leftPosition >= 0 && rightPosition >= 0) {
          const a = leftKey.collations[leftPosition];
          const b = rightKey.collations[rightPosition];
          return a === b &&
            a === left.fieldCollations[field] &&
            b === right.fieldCollations[field]
            ? a
            : "unknown";
        }
        if (leftPosition >= 0) {
          const a = leftKey.collations[leftPosition];
          return a === left.fieldCollations[field] &&
            a === right.fieldCollations[field]
            ? a
            : "unknown";
        }
        const b = rightKey.collations[rightPosition]!;
        return b === left.fieldCollations[field] &&
          b === right.fieldCollations[field]
          ? b
          : "unknown";
      });
      if (keyCollations.some((collation) => collation !== "BINARY")) continue;

      const requiredNonNull = [
        ...new Set([...leftKey.requiredNonNull, ...rightKey.requiredNonNull]),
      ];
      for (
        let discriminator = 0;
        discriminator < source.fields.length;
        discriminator++
      ) {
        if (keyFields.includes(discriminator)) continue;
        if (
          !areDistinctUnionTags(
            left.constants.get(discriminator),
            right.constants.get(discriminator),
            source.fields[discriminator]!.affinity,
            left.fieldCollations[discriminator] ?? "unknown",
            right.fieldCollations[discriminator] ?? "unknown",
          )
        )
          continue;
        keys.push({
          fields: [...keyFields, discriminator],
          collations: [...keyCollations, "BINARY"],
          lookupContracts: [
            ...keyFields.map((field) => {
              const leftDomain = left.fieldStorageDomains[field] ?? "unknown";
              const rightDomain = right.fieldStorageDomains[field] ?? "unknown";
              return lookupContractForStorageDomain(
                leftDomain === rightDomain ? leftDomain : "unknown",
              );
            }),
            lookupContractForStorageDomain(
              left.fieldStorageDomains[discriminator] ===
                right.fieldStorageDomains[discriminator]
                ? (left.fieldStorageDomains[discriminator] ?? "unknown")
                : "unknown",
            ),
          ],
          requiredNonNull,
        });
        if (keys.length >= MAX_KEY_COMBINATIONS) return keys;
      }
    }
  }
  return keys;
}

function unionFacts(
  source: QuerySource,
  node: Extract<LogicalQueryNode, { kind: "union" }>,
  left: RelationKeyFacts,
  right: RelationKeyFacts,
): RelationKeyFacts {
  if (!node.all) {
    const fields = source.fields.map((_field, index) => index);
    const collations = fields.map((field) =>
      left.fieldCollations[field] === right.fieldCollations[field]
        ? (left.fieldCollations[field] ?? "unknown")
        : "unknown",
    );
    const fieldStorageDomains = fields.map((field) =>
      left.fieldStorageDomains[field] === right.fieldStorageDomains[field]
        ? (left.fieldStorageDomains[field] ?? "unknown")
        : "unknown",
    );
    return {
      keys: [
        {
          fields,
          collations,
          requiredNonNull: [],
          lookupContracts: fieldStorageDomains.map(
            lookupContractForStorageDomain,
          ),
        },
      ],
      nonNullFields: new Set(
        [...left.nonNullFields].filter((field) =>
          right.nonNullFields.has(field),
        ),
      ),
      fieldCollations: collations,
      fieldStorageDomains,
      constants: new Map(
        [...left.constants].filter(([field, value]) =>
          equalConstants(value, right.constants.get(field)),
        ),
      ),
      rowNumberPartitions: new Map(),
    };
  }

  const fieldCollations = source.fields.map((_field, index) =>
    left.fieldCollations[index] === right.fieldCollations[index]
      ? (left.fieldCollations[index] ?? "unknown")
      : "unknown",
  );
  const fieldStorageDomains = source.fields.map((_field, index) =>
    left.fieldStorageDomains[index] === right.fieldStorageDomains[index]
      ? (left.fieldStorageDomains[index] ?? "unknown")
      : "unknown",
  );
  const constants = new Map<number, KnownConstant>();
  for (const [field, value] of left.constants)
    if (equalConstants(value, right.constants.get(field)))
      constants.set(field, value);

  const keys = discriminatorKeyFacts(source, left, right);
  return {
    keys: uniqueKeys(keys),
    nonNullFields: new Set(
      [...left.nonNullFields].filter((field) => right.nonNullFields.has(field)),
    ),
    fieldCollations,
    fieldStorageDomains,
    constants,
    rowNumberPartitions: new Map(),
  };
}

function windowFacts(
  source: QuerySource,
  node: Extract<LogicalQueryNode, { kind: "window" }>,
  input: RelationKeyFacts,
): RelationKeyFacts {
  const keys = [...input.keys];
  const nonNullFields = new Set(input.nonNullFields);
  const fieldCollations = [...input.fieldCollations];
  const fieldStorageDomains = [...input.fieldStorageDomains];
  const constants = new Map(input.constants);
  const rowNumberPartitions = new Map(input.rowNumberPartitions);

  for (const [index, { specification }] of node.windows.entries()) {
    const outputField = node.input.fields.length + index;
    fieldCollations[outputField] = "BINARY";
    if (specification.kind !== "row-number") continue;
    nonNullFields.add(outputField);
    fieldStorageDomains[outputField] = "integer";
    const fields: number[] = [];
    const collations: ProvenCollation[] = [];
    const lookupContracts: LookupComparisonContract[] = [];
    let direct = true;
    for (const expression of specification.partitionBy) {
      const field = directColumnIndex(expression, node.input);
      if (field === undefined) {
        direct = false;
        break;
      }
      fields.push(field);
      collations.push(input.fieldCollations[field] ?? "unknown");
      lookupContracts.push(
        lookupContractForStorageDomain(
          input.fieldStorageDomains[field] ?? "unknown",
        ),
      );
    }
    if (direct)
      rowNumberPartitions.set(outputField, {
        fields,
        collations,
        requiredNonNull: [],
        lookupContracts,
      });
  }

  return {
    keys: uniqueKeys(keys),
    nonNullFields,
    fieldCollations: source.fields.map(
      (_field, index) => fieldCollations[index] ?? "unknown",
    ),
    fieldStorageDomains: source.fields.map(
      (_field, index) => fieldStorageDomains[index] ?? "unknown",
    ),
    constants,
    rowNumberPartitions,
  };
}

function aggregateFacts(
  source: QuerySource,
  node: Extract<LogicalQueryNode, { kind: "aggregate" }>,
  input: RelationKeyFacts,
): RelationKeyFacts {
  if (node.groups.length === 0) {
    return {
      keys: [
        {
          fields: [],
          collations: [],
          requiredNonNull: [],
          lookupContracts: [],
        },
      ],
      nonNullFields: new Set(
        source.fields.flatMap((field, index) =>
          field.nullable ? [] : [index],
        ),
      ),
      fieldCollations: source.fields.map(() => "unknown"),
      fieldStorageDomains: source.fields.map(() => "unknown"),
      constants: new Map(),
      rowNumberPartitions: new Map(),
    };
  }
  const fields = node.groups.map((_group, index) => index);
  const collations = node.groups.map(({ expression }) => {
    const field = directColumnIndex(expression, node.input);
    return field === undefined
      ? "unknown"
      : (input.fieldCollations[field] ?? "unknown");
  });
  const fieldStorageDomains = node.groups.map(({ expression }) => {
    const field = directColumnIndex(expression, node.input);
    return field === undefined
      ? ("unknown" as const)
      : (input.fieldStorageDomains[field] ?? "unknown");
  });
  return {
    keys: [
      {
        fields,
        collations,
        requiredNonNull: [],
        lookupContracts: fieldStorageDomains.map(
          lookupContractForStorageDomain,
        ),
      },
    ],
    nonNullFields: new Set(
      source.fields.flatMap((field, index) => (field.nullable ? [] : [index])),
    ),
    fieldCollations: source.fields.map((_field, index) =>
      index < node.groups.length ? collations[index]! : "unknown",
    ),
    fieldStorageDomains: source.fields.map((_field, index) =>
      index < node.groups.length ? fieldStorageDomains[index]! : "unknown",
    ),
    constants: new Map(),
    rowNumberPartitions: new Map(),
  };
}

function distinctFacts(
  source: QuerySource,
  input: RelationKeyFacts,
): RelationKeyFacts {
  return {
    keys: uniqueKeys([
      ...input.keys,
      {
        fields: source.fields.map((_field, index) => index),
        collations: input.fieldCollations,
        requiredNonNull: [],
        lookupContracts: input.fieldStorageDomains.map(
          lookupContractForStorageDomain,
        ),
      },
    ]),
    nonNullFields: new Set(input.nonNullFields),
    fieldCollations: [...input.fieldCollations],
    fieldStorageDomains: [...input.fieldStorageDomains],
    constants: new Map(input.constants),
    rowNumberPartitions: new Map(),
  };
}

function strictOrderKeyIsCovered(
  source: QuerySource,
  specification: RowNumberWindowSpec,
  facts: RelationKeyFacts,
): boolean {
  const orderedFields = new Set<number>();
  for (const expression of specification.partitionBy) {
    const field = directColumnIndex(expression, source);
    if (field !== undefined) orderedFields.add(field);
  }
  for (const { expression } of specification.orderBy) {
    const field = directColumnIndex(expression, source);
    if (field !== undefined) orderedFields.add(field);
  }

  return facts.keys.some(
    (key) =>
      isValidKey(key, facts) &&
      key.fields.every(
        (field, index) =>
          orderedFields.has(field) &&
          key.collations[index] === "BINARY" &&
          facts.fieldCollations[field] === key.collations[index],
      ),
  );
}

/**
 * Prove that a row-number ordering cannot tie, using only catalog-backed keys,
 * direct-column propagation, strict equality joins, UNION ALL branch tags and
 * rank-one output cardinality. Unknown schema or expression semantics fail closed.
 */
export function hasStableRowNumberOrdering(
  source: QuerySource,
  specification: RowNumberWindowSpec,
): boolean {
  const facts = analyzeRelationalKeyFacts(source);
  return strictOrderKeyIsCovered(source, specification, facts);
}

/** Recompute conservative relational key facts from the original query DAG. */
export function analyzeRelationalKeyFacts(root: QuerySource): RelationKeyFacts {
  const memo = new Map<LogicalQueryNode, RelationKeyFacts>();
  const active = new Set<LogicalQueryNode>();
  const visit = (source: QuerySource): RelationKeyFacts => {
    const node = source.node;
    const cached = memo.get(node);
    if (cached) return cached;
    if (active.has(node)) return unknownFacts(source);
    active.add(node);

    let facts: RelationKeyFacts;
    switch (node.kind) {
      case "scan":
        facts = scanFacts(source);
        break;
      case "values-relation":
        facts = {
          ...unknownFacts(source),
          keys:
            node.rows.length <= 1
              ? [
                  {
                    fields: [],
                    collations: [],
                    requiredNonNull: [],
                    lookupContracts: [],
                  },
                ]
              : [],
          fieldCollations: source.fields.map(() => "unknown"),
          fieldStorageDomains: source.fields.map(() => "unknown"),
        };
        break;
      case "filter":
        facts = filterFacts(source, node, visit(node.input));
        break;
      case "project":
        facts = projectFacts(source, node, visit(node.input));
        break;
      case "join":
        facts = joinFacts(source, node, visit(node.left), visit(node.right));
        break;
      case "semi-join":
      case "anti-join":
        facts = cloneFacts(source, visit(node.left));
        break;
      case "aggregate":
        facts = aggregateFacts(source, node, visit(node.input));
        break;
      case "distinct":
        facts = distinctFacts(source, visit(node.input));
        break;
      case "window":
        facts = windowFacts(source, node, visit(node.input));
        break;
      case "sort":
      case "limit":
        facts = cloneFacts(source, visit(node.input));
        break;
      case "union":
        facts = unionFacts(source, node, visit(node.left), visit(node.right));
        break;
      case "json-scalar-array":
      case "recursive-closure":
        facts = unknownFacts(source);
        break;
      default: {
        const exhaustive: never = node;
        facts = exhaustive;
      }
    }

    active.delete(node);
    memo.set(node, facts);
    return facts;
  };

  return visit(root);
}

export type { ProvenCollation, RelationKeyFacts, UniqueKeyFact };
