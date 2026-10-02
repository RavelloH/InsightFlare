import {
  aggregate,
  and,
  caseWhen,
  coalesce,
  constant,
  eq,
  filter,
  gt,
  gte,
  inList,
  inSubquery,
  isNotNull,
  join,
  jsonScalarArray,
  lt,
  lte,
  max,
  neq,
  not,
  param,
  project,
  rowNumber,
  scalar,
  scan,
  textContains,
  textEndsWith,
  textStartsWith,
  trimSpaces,
  window,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  Predicate,
  SqlExpression,
} from "@/lib/db/query/expression";
import { schema } from "@/lib/db/schema";
import { analyticsFilterDefinition } from "@/lib/filter-contract/filter-registry";
import {
  type FilterCondition,
  type FilterValue,
  legacyConditionValue,
} from "@/lib/filter-contract/filters";

import { lowerLegacyScalarValueCondition } from "./analytics-legacy-scalar-filter-lowering";
import type {
  AnalyticsLegacyEventRow,
  AnalyticsLegacyPageRow,
  AnalyticsLegacyRelationalPredicateInput,
} from "./analytics-legacy-scoped-types";

export const LEGACY_PAYLOAD_JSON_EACH_SET_THRESHOLD = 8;

type LegacyEventRow = AnalyticsLegacyEventRow;
type LegacyPageRow = AnalyticsLegacyPageRow;
type PayloadTextValue = SqlExpression<
  string | null,
  ExpressionResultType<"text", true>
>;
type PayloadNumericValue = SqlExpression<
  number | null,
  ExpressionResultType<"integer" | "real" | "numeric", true>
>;
type PayloadIntegerValue = SqlExpression<
  number,
  ExpressionResultType<"integer", false>
>;

function requiredColumn(
  relation: { readonly columns: Readonly<Record<string, AnyExpression>> },
  name: string,
): AnyExpression {
  const expression = relation.columns[name];
  if (!expression)
    throw new Error(
      `Missing legacy relational projection ${JSON.stringify(name)}.`,
    );
  return expression;
}

function hasEventIdentity(
  source: AnalyticsLegacyRelationalPredicateInput["source"],
): source is LegacyEventRow {
  return "eventPk" in source;
}

function legacyBoundaryPredicate(
  condition: FilterCondition,
  source: LegacyPageRow | LegacyEventRow,
  candidatePages: LegacyPageRow,
  kind: "entry" | "exit",
): Predicate {
  if (source.sitePk.resultType.nullable || source.sessionId.resultType.nullable)
    throw new TypeError(
      "Legacy session-boundary matching requires non-null site/session keys.",
    );

  const direction = kind === "entry" ? "ASC" : "DESC";
  const validPages = filter(
    candidatePages.relation,
    neq(
      trimSpaces(coalesce(candidatePages.sessionId, constant(""))),
      constant(""),
    ),
  );
  const ranked = window(validPages, {
    __legacy_boundary_rank: rowNumber({
      partitionBy: [validPages.columns.site_pk, validPages.columns.session_id],
      orderBy: [
        { expression: validPages.columns.started_at, direction },
        // SQLite's ASC/DESC NULL placement for this nullable tie key is part
        // of the legacy contract, so leave the expression uncoalesced.
        { expression: validPages.columns.visit_id, direction },
      ],
    }),
  });
  const boundaries = aggregate(ranked, {
    groupBy: {
      site_pk: ranked.columns.site_pk,
      session_id: ranked.columns.session_id,
    },
    aggregates: {
      boundary_path: max(
        caseWhen(
          [
            {
              when: eq(ranked.columns.__legacy_boundary_rank, constant(1)),
              then: ranked.columns.pathname,
            },
          ],
          param(null),
        ),
      ),
    },
  });
  const boundaryComparison = lowerLegacyScalarValueCondition(
    condition,
    boundaries.columns.boundary_path,
    "session-boundary-v1",
  );
  const matches = filter(
    boundaries,
    and(
      eq(source.sitePk, boundaries.columns.site_pk),
      eq(source.sessionId, boundaries.columns.session_id),
      boundaryComparison,
    ),
  );
  return isNotNull(scalar(project(matches, { found: constant(1) })));
}

function payloadValueType(value: FilterValue): 0 | 1 | 2 | 3 {
  if (value === null) return 0;
  if (typeof value === "string") return 1;
  if (typeof value === "number") return 2;
  if (typeof value === "boolean") return 3;
  throw new TypeError("Event payload values must be JSON scalars.");
}

function payloadValueColumn(
  rows: {
    readonly columns: Readonly<Record<string, AnyExpression>>;
  },
  value: FilterValue,
): PayloadTextValue | PayloadNumericValue {
  if (typeof value === "string")
    return requiredColumn(rows, "string_value") as PayloadTextValue;
  if (typeof value === "number")
    return requiredColumn(rows, "number_value") as PayloadNumericValue;
  if (typeof value === "boolean")
    return requiredColumn(rows, "boolean_value") as PayloadNumericValue;
  return requiredColumn(rows, "value_type") as PayloadNumericValue;
}

function payloadRows(source: LegacyEventRow, path: string) {
  const values = schema.custom_event_json_values;
  const paths = schema.custom_event_json_paths;
  const valueRows = scan(values);
  const pathRows = scan(paths);
  const valuesWithPaths = join(
    valueRows,
    pathRows,
    and(
      eq(valueRows.columns.path_id, pathRows.columns.id),
      eq(valueRows.columns.site_pk, pathRows.columns.site_pk),
    ),
  );
  const atPath = filter(
    valuesWithPaths,
    and(
      eq(source.eventPk, valuesWithPaths.columns.left_event_pk),
      eq(source.sitePk, valuesWithPaths.columns.left_site_pk),
      eq(source.sitePk, valuesWithPaths.columns.right_site_pk),
      eq(valuesWithPaths.columns.right_path, param(path)),
    ),
  );
  return project(atPath, {
    value_type: atPath.columns.left_value_type,
    string_value: atPath.columns.left_string_value,
    number_value: atPath.columns.left_number_value,
    boolean_value: atPath.columns.left_boolean_value,
  });
}

function payloadExists(
  rows: ReturnType<typeof payloadRows>,
  predicate?: Predicate,
): Predicate {
  const matching = predicate ? filter(rows, predicate) : rows;
  return isNotNull(scalar(project(matching, { found: constant(1) })));
}

function payloadSetPredicate(
  rows: ReturnType<typeof payloadRows>,
  valueColumn: PayloadTextValue | PayloadNumericValue,
  valueType: 0 | 1 | 2 | 3,
  operator: "in" | "notIn",
  values: readonly FilterValue[],
): Predicate {
  if (valueType === 0) {
    // The legacy NULL set compares value_type against NULL in IN/NOT IN, so
    // SQLite yields UNKNOWN and the enclosing EXISTS sees no matching row.
    return eq(constant(0), constant(1));
  }

  const typedValues = values.map((value) => {
    if (typeof value === "boolean") return value ? 1 : 0;
    return value as string | number;
  });
  let membership: Predicate;
  if (values.length >= LEGACY_PAYLOAD_JSON_EACH_SET_THRESHOLD) {
    membership =
      valueType === 1
        ? inSubquery(
            valueColumn as PayloadTextValue,
            jsonScalarArray("text", typedValues as string[]),
          )
        : inSubquery(
            valueColumn as PayloadNumericValue,
            jsonScalarArray("numeric", typedValues as number[]),
          );
  } else {
    membership =
      valueType === 1
        ? inList(valueColumn as PayloadTextValue, typedValues as string[])
        : inList(valueColumn as PayloadNumericValue, typedValues as number[]);
  }
  return operator === "in" ? membership : not(membership);
}

function lowerPayloadPredicate(
  condition: FilterCondition,
  source: LegacyEventRow,
): Predicate {
  if (condition.target.kind !== "event-payload")
    throw new TypeError(
      "Legacy payload lowering requires an event-payload target.",
    );
  const rows = payloadRows(source, condition.target.path);
  const valueType = rows.columns.value_type as SqlExpression<
    number,
    ExpressionResultType<"integer", false>
  >;
  const stringValue = rows.columns.string_value as PayloadTextValue;
  const values = legacyConditionValue(condition.value);
  const exists = (predicate?: Predicate) => payloadExists(rows, predicate);

  switch (condition.operator) {
    case "exists":
      return exists();
    case "notExists":
      return not(exists());
    case "isNull":
      return exists(eq(valueType, constant(0)));
    case "notNull":
      return exists(neq(valueType, constant(0)));
    case "isEmpty":
      return exists(
        and(eq(valueType, constant(1)), eq(stringValue, constant(""))),
      );
    case "notEmpty":
      return exists(
        and(eq(valueType, constant(1)), neq(stringValue, constant(""))),
      );
    default:
      break;
  }

  const operands = Array.isArray(values) ? values : [values];
  const valueTypes = [
    ...new Set(operands.map((value) => payloadValueType(value!))),
  ];
  if (valueTypes.length !== 1)
    throw new TypeError("Payload set filters require values of one JSON type.");
  const type = valueTypes[0]!;
  const fieldValue = payloadValueColumn(rows, operands[0]!);
  const operator = condition.operator;
  const typed = eq(valueType, constant(type));

  if (operator === "between") {
    const first = operands[0]!;
    const last = operands[1]!;
    const low = typeof first === "boolean" ? (first ? 1 : 0) : first;
    const high = typeof last === "boolean" ? (last ? 1 : 0) : last;
    if (low === null || high === null)
      throw new TypeError("Payload BETWEEN values must be non-null scalars.");
    return exists(
      and(
        typed,
        requireComparison(fieldValue, "gte", low),
        requireComparison(fieldValue, "lte", high),
      ),
    );
  }

  if (operator === "in" || operator === "notIn") {
    const matching = payloadSetPredicate(
      rows,
      fieldValue,
      type,
      operator,
      operands as readonly FilterValue[],
    );
    return exists(and(typed, matching));
  }

  const value = operands[0]!;
  if (value === null) {
    const nullComparison = comparisonOperator(operator, valueType, constant(0));
    return exists(nullComparison);
  }
  const binding = typeof value === "boolean" ? (value ? 1 : 0) : value;
  const isStringMatch =
    operator === "contains" ||
    operator === "startsWith" ||
    operator === "endsWith";
  if (isStringMatch && typeof value !== "string")
    throw new TypeError("Payload string matching requires a string.");
  const comparison = comparisonOperator(
    operator,
    fieldValue,
    isStringMatch
      ? (value as string)
      : (param(binding) as unknown as typeof fieldValue),
  );
  return exists(and(typed, comparison));
}

function comparisonOperator(
  operator: FilterCondition["operator"],
  left: PayloadTextValue | PayloadNumericValue | PayloadIntegerValue,
  right:
    | PayloadTextValue
    | PayloadNumericValue
    | PayloadIntegerValue
    | string
    | number,
): Predicate {
  switch (operator) {
    case "eq":
      return eq(left, right as never) as Predicate;
    case "neq":
      return neq(left, right as never) as Predicate;
    case "gt":
      return requireComparison(
        left as PayloadTextValue | PayloadNumericValue,
        "gt",
        right,
      );
    case "gte":
      return requireComparison(
        left as PayloadTextValue | PayloadNumericValue,
        "gte",
        right,
      );
    case "lt":
      return requireComparison(
        left as PayloadTextValue | PayloadNumericValue,
        "lt",
        right,
      );
    case "lte":
      return requireComparison(
        left as PayloadTextValue | PayloadNumericValue,
        "lte",
        right,
      );
    case "contains":
      if (typeof right !== "string")
        throw new TypeError(
          "Payload string matching requires a string pattern.",
        );
      return requireTextMatch(left as PayloadTextValue, right, "contains");
    case "startsWith":
      if (typeof right !== "string")
        throw new TypeError(
          "Payload string matching requires a string pattern.",
        );
      return requireTextMatch(left as PayloadTextValue, right, "startsWith");
    case "endsWith":
      if (typeof right !== "string")
        throw new TypeError(
          "Payload string matching requires a string pattern.",
        );
      return requireTextMatch(left as PayloadTextValue, right, "endsWith");
    default:
      throw new TypeError(`Unsupported payload operator ${operator}.`);
  }
}

function requireComparison(
  left: PayloadTextValue | PayloadNumericValue,
  operator: "gt" | "gte" | "lt" | "lte",
  right: SqlExpression | string | number,
): Predicate {
  const rhs = (typeof right === "object" ? right : param(right)) as unknown as
    PayloadTextValue | PayloadNumericValue;
  switch (operator) {
    case "gt":
      return gt(left, rhs) as Predicate;
    case "gte":
      return gte(left, rhs) as Predicate;
    case "lt":
      return lt(left, rhs) as Predicate;
    case "lte":
      return lte(left, rhs) as Predicate;
  }
}

function requireTextMatch(
  left: PayloadTextValue,
  right: string,
  operator: "contains" | "startsWith" | "endsWith",
): Predicate {
  if (operator === "contains") return textContains(left, right) as Predicate;
  if (operator === "startsWith")
    return textStartsWith(left, right) as Predicate;
  return textEndsWith(left, right) as Predicate;
}

/** Lower one normalized Session-boundary or event-payload legacy leaf. */
export function lowerLegacyRelationalPredicate(
  input: AnalyticsLegacyRelationalPredicateInput,
): Predicate {
  if (input.condition.target.kind === "event-payload") {
    if (!hasEventIdentity(input.source))
      throw new TypeError("Event-payload predicates require an Event source.");
    return lowerPayloadPredicate(input.condition, input.source);
  }

  if (input.condition.target.kind !== "field")
    throw new TypeError("Unsupported legacy relational filter target.");
  const field = analyticsFilterDefinition(input.condition.target.field);
  if (field?.compilerStrategy === "session.boundary.entry")
    return legacyBoundaryPredicate(
      input.condition,
      input.source,
      input.context.candidatePages,
      "entry",
    );
  if (field?.compilerStrategy === "session.boundary.exit")
    return legacyBoundaryPredicate(
      input.condition,
      input.source,
      input.context.candidatePages,
      "exit",
    );
  throw new TypeError(
    `Unsupported legacy relational field ${input.condition.target.field}.`,
  );
}
