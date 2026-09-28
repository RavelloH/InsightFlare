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
  const result: SqlFragment[] = [];
  parts.forEach((part, index) => {
    if (index > 0) result.push(separator);
    result.push(part);
  });
  return concat(...result);
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
