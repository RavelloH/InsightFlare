import type { DatabaseBinding } from "@/lib/db/types";

export interface SqlFragment {
  readonly text: string;
  readonly bindings: readonly DatabaseBinding[];
}

export function text(value: string): SqlFragment {
  return { text: value, bindings: [] };
}

export function parameter(value: DatabaseBinding): SqlFragment {
  return { text: "?", bindings: [value] };
}

export function concat(...parts: readonly SqlFragment[]): SqlFragment {
  return {
    text: parts.map((part) => part.text).join(""),
    bindings: parts.flatMap((part) => part.bindings),
  };
}

export function join(
  parts: readonly SqlFragment[],
  separator: SqlFragment = text(", "),
): SqlFragment {
  const sql: string[] = [];
  const bindings: DatabaseBinding[] = [];
  parts.forEach((part, index) => {
    if (index > 0) {
      sql.push(separator.text);
      for (const binding of separator.bindings) bindings.push(binding);
    }
    sql.push(part.text);
    for (const binding of part.bindings) bindings.push(binding);
  });
  return { text: sql.join(""), bindings };
}

export function parenthesize(part: SqlFragment): SqlFragment {
  return concat(text("("), part, text(")"));
}

export function unsafeRawSql(
  sql: string,
  bindings: readonly DatabaseBinding[] = [],
): SqlFragment {
  return { text: sql, bindings: [...bindings] };
}
