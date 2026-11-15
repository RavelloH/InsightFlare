/** Actual storage proof for finite ordered activity summaries. Declared
 * affinity never admits a row; INTEGER timestamps must fit JS safe integers.
 * Every operation is total even for NULL, BLOB, REAL and malformed TEXT. */
import {
  and,
  callFunction,
  coalesce,
  constant,
  eq,
  gte,
  lte,
  param,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  SqlExpression,
} from "@/lib/db/query/expression";
export function canonicalOrderedActivityStorage(
  id: AnyExpression,
  scopeId: AnyExpression,
  time: AnyExpression,
) {
  return coalesce(
    and(
      eq(callFunction("storage-class", id as SqlExpression), param("text")),
      eq(
        callFunction("storage-class", scopeId as SqlExpression),
        param("text"),
      ),
      eq(
        callFunction("storage-class", time as SqlExpression),
        param("integer"),
      ),
      gte(
        time as SqlExpression<
          number | null,
          ExpressionResultType<"integer", boolean>
        >,
        constant(-Number.MAX_SAFE_INTEGER),
      ),
      lte(
        time as SqlExpression<
          number | null,
          ExpressionResultType<"integer", boolean>
        >,
        constant(Number.MAX_SAFE_INTEGER),
      ),
    ),
    constant(0),
  );
}
