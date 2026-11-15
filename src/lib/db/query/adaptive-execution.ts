import { assertD1StatementBudget } from "@/lib/db/d1-budget";
import type { CompiledQuery } from "@/lib/db/query/compiled";
import type { DatabaseBinding, DatabaseRuntime } from "@/lib/db/types";

export interface AdaptiveQueryLayout {
  readonly tagField: string;
  readonly guardField: string;
  readonly ordinalField: string;
  readonly fields: readonly string[];
}

interface Recipe {
  readonly original: CompiledQuery<object>;
  readonly query: CompiledQuery<object>;
  readonly layout: AdaptiveQueryLayout;
  readonly originalShape: string | undefined;
}

const recipes = new WeakMap<object, Recipe>();

function protocolError(): never {
  throw new Error("database_adaptive_query_protocol_invalid");
}

function copyBinding(value: DatabaseBinding): DatabaseBinding {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (!ArrayBuffer.isView(value)) return value;
  // structuredClone keeps SharedArrayBuffer storage shared. Private parameters
  // must instead own immutable bytes for the entire asynchronous execution.
  return value.buffer instanceof ArrayBuffer
    ? structuredClone(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
        .buffer;
}

function snapshot(query: CompiledQuery<object>): CompiledQuery<object> {
  return Object.freeze({
    kind: "query" as const,
    sql: query.sql,
    ...(query.bindings === undefined
      ? {}
      : { bindings: Object.freeze(query.bindings.map(copyBinding)) }),
    ...(query.tag === undefined ? {} : { tag: query.tag }),
    ...(query.physicalPlanShape === undefined
      ? {}
      : { physicalPlanShape: structuredClone(query.physicalPlanShape) }),
  });
}

function sameBinding(a: DatabaseBinding, b: DatabaseBinding): boolean {
  if (Object.is(a, b)) return true;
  const bytes = (v: DatabaseBinding): Uint8Array | undefined =>
    v instanceof ArrayBuffer
      ? new Uint8Array(v)
      : ArrayBuffer.isView(v)
        ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
        : undefined;
  const left = bytes(a),
    right = bytes(b);
  return (
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function unchanged(query: CompiledQuery<object>, recipe: Recipe): boolean {
  const expected = recipe.original;
  let sameShape: boolean;
  try {
    sameShape =
      JSON.stringify(query.physicalPlanShape) === recipe.originalShape;
  } catch {
    return false;
  }
  return (
    query.kind === "query" &&
    query.sql === expected.sql &&
    query.tag === expected.tag &&
    sameShape &&
    (query.bindings === undefined
      ? expected.bindings === undefined
      : expected.bindings !== undefined &&
        query.bindings.length === expected.bindings.length &&
        expected.bindings.every(
          (value, index) =>
            Object.hasOwn(query.bindings!, index) &&
            sameBinding(query.bindings![index]!, value),
        ))
  );
}

/** Compiler-only attachment after fresh physical proof. The public query stays
 * ordinary SQL, so clones and callers outside the typed all() client stay safe. */
export function registerAdaptiveQueryExecutionForCompiler(
  original: CompiledQuery<object>,
  input: {
    readonly query: CompiledQuery<object>;
    readonly layout: AdaptiveQueryLayout;
  },
): void {
  if (recipes.has(original))
    throw new Error("database_adaptive_query_already_registered");
  const { layout } = input;
  const names = [
    layout.tagField,
    layout.guardField,
    layout.ordinalField,
    ...layout.fields,
  ];
  if (
    original.kind !== "query" ||
    input.query.kind !== "query" ||
    layout.fields.length === 0 ||
    names.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length
  )
    protocolError();
  // A compiler must decline an oversized optimization before attachment.
  assertD1StatementBudget(original);
  assertD1StatementBudget(input.query);
  recipes.set(original, {
    original: snapshot(original),
    originalShape: JSON.stringify(original.physicalPlanShape),
    query: snapshot(input.query),
    layout: Object.freeze({
      ...layout,
      fields: Object.freeze([...layout.fields]),
    }),
  });
}

function decode(
  result: D1Result<Record<string, unknown>>,
  layout: AdaptiveQueryLayout,
): { readonly useFast: boolean; readonly rows: Record<string, unknown>[] } {
  if (!Array.isArray(result.results)) protocolError();
  const expected = new Set([
    layout.tagField,
    layout.guardField,
    layout.ordinalField,
    ...layout.fields,
  ]);
  let guard: 0 | 1 | undefined;
  let controlSeen = false;
  const rows: Record<string, unknown>[] = [];
  for (const row of result.results) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).length !== expected.size ||
      Object.keys(row).some((key) => !expected.has(key))
    )
      protocolError();
    if (row[layout.tagField] === 0) {
      if (
        controlSeen ||
        rows.length > 0 ||
        row[layout.ordinalField] !== 0 ||
        (row[layout.guardField] !== 0 && row[layout.guardField] !== 1) ||
        layout.fields.some((field) => row[field] !== null)
      )
        protocolError();
      controlSeen = true;
      guard = row[layout.guardField] as 0 | 1;
    } else if (row[layout.tagField] === 1) {
      if (
        !controlSeen ||
        guard !== 1 ||
        row[layout.guardField] !== null ||
        row[layout.ordinalField] !== rows.length + 1
      )
        protocolError();
      rows.push(
        Object.fromEntries(layout.fields.map((field) => [field, row[field]])),
      );
    } else protocolError();
  }
  if (!controlSeen) protocolError();
  return { useFast: guard === 1, rows };
}

function mergedCostMeta(probe: D1Result, fallback: D1Result): D1Result["meta"] {
  const a = probe.meta as unknown as Record<string, unknown> | undefined,
    b = fallback.meta as unknown as Record<string, unknown> | undefined;
  const merged: Record<string, unknown> = { ...b };
  const add = (
    left: unknown,
    right: unknown,
    integer: boolean,
  ): number | undefined => {
    if (
      typeof left !== "number" ||
      typeof right !== "number" ||
      !Number.isFinite(left) ||
      !Number.isFinite(right) ||
      left < 0 ||
      right < 0
    )
      return undefined;
    const sum = left + right;
    return Number.isFinite(sum) &&
      (!integer ||
        (Number.isSafeInteger(left) &&
          Number.isSafeInteger(right) &&
          Number.isSafeInteger(sum)))
      ? sum
      : undefined;
  };
  for (const field of ["rows_read", "rows_written", "duration"] as const) {
    const value = add(a?.[field], b?.[field], field !== "duration");
    if (value === undefined) Reflect.deleteProperty(merged, field);
    else merged[field] = value;
  }
  // Some adapters retain the REST timing extension. It is additive only when
  // both physical operations expose it; other final-result fields are retained.
  if ((a && "timings" in a) || (b && "timings" in b)) {
    const timingA = a?.timings as Record<string, unknown> | undefined,
      timingB = b?.timings as Record<string, unknown> | undefined;
    const timings = { ...timingB };
    const sqlDuration = add(
      timingA?.sql_duration_ms,
      timingB?.sql_duration_ms,
      false,
    );
    if (sqlDuration === undefined) delete timings.sql_duration_ms;
    else timings.sql_duration_ms = sqlDuration;
    merged.timings = timings;
  }
  return merged as unknown as D1Result["meta"];
}

/** Undefined means ordinary execution. Each chosen operation passes through the
 * existing runtime, keeping physical budgets, failures and observations intact. */
export function tryExecuteAdaptiveQuery<Row extends object>(
  runtime: DatabaseRuntime,
  query: CompiledQuery<Row>,
): Promise<D1Result<Row>> | undefined {
  const recipe = recipes.get(query);
  if (!recipe || !unchanged(query, recipe)) return undefined;
  return (async () => {
    const result = await runtime.all<Record<string, unknown>>(recipe.query);
    if ((result as { readonly success?: unknown }).success === false)
      return result as D1Result<Row>;
    const decoded = decode(result, recipe.layout);
    if (decoded.useFast)
      return { ...result, results: decoded.rows } as D1Result<Row>;
    // No catch: thrown database errors and returned failures never become a
    // successful empty result or select another execution alternative.
    const fallback = await runtime.all<Row>(recipe.original);
    return { ...fallback, meta: mergedCostMeta(result, fallback) };
  })();
}
