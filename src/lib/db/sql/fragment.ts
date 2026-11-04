import type { DatabaseBinding } from "@/lib/db/types";

export interface SqlFragment {
  readonly text: string;
  readonly bindings: readonly DatabaseBinding[];
}

const placeholderOffsets = new WeakMap<
  SqlFragment,
  readonly number[] | undefined
>();

/** Exact typed-placeholder offsets, or undefined when a raw fragment obscures them. */
export function getParameterPlaceholderOffsets(
  fragment: SqlFragment,
): readonly number[] | undefined {
  return placeholderOffsets.get(fragment);
}

function withPlaceholderOffsets(
  fragment: SqlFragment,
  offsets: readonly number[] | undefined,
): SqlFragment {
  if (offsets !== undefined) placeholderOffsets.set(fragment, offsets);
  return fragment;
}

export function text(value: string): SqlFragment {
  return withPlaceholderOffsets({ text: value, bindings: [] }, []);
}

export function parameter(value: DatabaseBinding): SqlFragment {
  return withPlaceholderOffsets({ text: "?", bindings: [value] }, [0]);
}

export function concat(...parts: readonly SqlFragment[]): SqlFragment {
  let sql = "";
  const bindings: DatabaseBinding[] = [];
  let offsets: number[] | undefined = [];
  let textOffset = 0;
  for (const part of parts) {
    sql += part.text;
    part.bindings.forEach((binding) => bindings.push(binding));
    if (offsets !== undefined) {
      const partOffsets = getParameterPlaceholderOffsets(part);
      if (partOffsets === undefined) offsets = undefined;
      else {
        for (const offset of partOffsets) offsets.push(offset + textOffset);
        textOffset += part.text.length;
      }
    }
  }
  return withPlaceholderOffsets({ text: sql, bindings }, offsets);
}

export function join(
  parts: readonly SqlFragment[],
  separator: SqlFragment = text(", "),
): SqlFragment {
  const sql: string[] = [];
  const bindings: DatabaseBinding[] = [];
  const offsets: number[] = [];
  let textOffset = 0;
  let known = true;
  const append = (fragment: SqlFragment) => {
    sql.push(fragment.text);
    for (const binding of fragment.bindings) bindings.push(binding);
    const fragmentOffsets = getParameterPlaceholderOffsets(fragment);
    if (fragmentOffsets === undefined) known = false;
    else {
      for (const offset of fragmentOffsets) offsets.push(offset + textOffset);
    }
    textOffset += fragment.text.length;
  };
  parts.forEach((part, index) => {
    if (index > 0) append(separator);
    append(part);
  });
  return withPlaceholderOffsets(
    { text: sql.join(""), bindings },
    known ? offsets : undefined,
  );
}

export function parenthesize(part: SqlFragment): SqlFragment {
  const bindings: DatabaseBinding[] = [];
  part.bindings.forEach((binding) => bindings.push(binding));
  const partOffsets = getParameterPlaceholderOffsets(part);
  const offsets =
    partOffsets === undefined
      ? undefined
      : partOffsets.map((offset) => offset + 1);
  return withPlaceholderOffsets({ text: `(${part.text})`, bindings }, offsets);
}

export function unsafeRawSql(
  sql: string,
  bindings: readonly DatabaseBinding[] = [],
): SqlFragment {
  return withPlaceholderOffsets(
    { text: sql, bindings: [...bindings] },
    bindings.length === 0 ? [] : undefined,
  );
}
