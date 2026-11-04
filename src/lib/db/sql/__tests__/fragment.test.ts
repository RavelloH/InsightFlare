import { describe, expect, it } from "vitest";

import { DatabaseCompilerError } from "@/lib/db/query/errors";
import {
  concat,
  getParameterPlaceholderOffsets,
  join,
  parameter,
  parenthesize,
  text,
} from "@/lib/db/sql/fragment";
import { identifier } from "@/lib/db/sql/identifier";
import { unsafeRawSql } from "@/lib/db/unsafe";

describe("SQL fragments", () => {
  it("keeps values in binding order and quotes identifiers", () => {
    const fragment = concat(
      text("SELECT "),
      identifier('a"b'),
      text(" WHERE id = "),
      parameter("value"),
      text(" AND enabled IN "),
      parenthesize(join([parameter(true), parameter(false)])),
    );
    expect(fragment).toEqual({
      text: 'SELECT "a""b" WHERE id = ? AND enabled IN (?, ?)',
      bindings: ["value", true, false],
    });
  });

  it("tracks typed placeholder offsets across composition without changing fragments", () => {
    const fragment = concat(
      text("SELECT '?' AS literal WHERE left_value = "),
      parameter("left"),
      text(" OR right_value = "),
      parameter("right"),
    );
    expect(getParameterPlaceholderOffsets(fragment)).toEqual([
      fragment.text.indexOf("?", fragment.text.indexOf("literal")),
      fragment.text.lastIndexOf("?"),
    ]);
    expect(fragment).toEqual({
      text: "SELECT '?' AS literal WHERE left_value = ? OR right_value = ?",
      bindings: ["left", "right"],
    });

    const repeatedSeparator = join(
      [parameter("first"), parameter("second")],
      concat(text(" OR value = "), parameter("separator")),
    );
    expect(getParameterPlaceholderOffsets(repeatedSeparator)).toEqual([
      0,
      repeatedSeparator.text.indexOf("?", 1),
      repeatedSeparator.text.lastIndexOf("?"),
    ]);
  });

  it("opts out of exact placeholder tracking for raw fragments with bindings", () => {
    expect(getParameterPlaceholderOffsets(unsafeRawSql("SELECT ?", [7]))).toBe(
      undefined,
    );
    expect(
      getParameterPlaceholderOffsets(unsafeRawSql("SELECT '?'", [])),
    ).toEqual([]);
  });

  it("keeps UTF-16 offsets and copies bindings through composition", () => {
    const source = concat(text("😀"), parameter("source"));
    const combined = concat(source);
    const wrapped = parenthesize(source);

    expect(getParameterPlaceholderOffsets(source)).toEqual([2]);
    expect(getParameterPlaceholderOffsets(wrapped)).toEqual([3]);
    expect(wrapped).toEqual({ text: "(😀?)", bindings: ["source"] });
    expect(Object.keys(wrapped)).toEqual(["text", "bindings"]);
    expect(combined).not.toBe(source);
    expect(combined.bindings).not.toBe(source.bindings);
    expect(wrapped).not.toBe(source);
    expect(wrapped.bindings).not.toBe(source.bindings);

    (source.bindings as unknown as string[])[0] = "changed";
    expect(combined.bindings).toEqual(["source"]);
    expect(wrapped.bindings).toEqual(["source"]);
  });

  it("propagates opaque offsets and ignores an unused opaque join separator", () => {
    const opaque = unsafeRawSql("opaque ?", [7]);
    const composed = concat(text("prefix "), opaque, parameter("tail"));
    const wrapped = parenthesize(composed);
    const joined = join(
      [text("left"), text("right")],
      unsafeRawSql(" / ?", ["separator"]),
    );
    const empty = join([], unsafeRawSql("unused ?", ["unused"]));

    expect(composed).toEqual({
      text: "prefix opaque ??",
      bindings: [7, "tail"],
    });
    expect(getParameterPlaceholderOffsets(composed)).toBeUndefined();
    expect(getParameterPlaceholderOffsets(wrapped)).toBeUndefined();
    expect(joined).toEqual({
      text: "left / ?right",
      bindings: ["separator"],
    });
    expect(getParameterPlaceholderOffsets(joined)).toBeUndefined();
    expect(empty).toEqual({ text: "", bindings: [] });
    expect(getParameterPlaceholderOffsets(empty)).toEqual([]);
  });

  it("preserves concat's sparse-binding skip behavior", () => {
    const sparseBindings = new Array<string>(2);
    const externalFragment = { text: "opaque", bindings: sparseBindings };

    expect(concat(externalFragment, parameter("kept")).bindings).toEqual([
      "kept",
    ]);
    expect(parenthesize(externalFragment).bindings).toEqual([]);
  });

  it("rejects empty and NUL-containing identifiers", () => {
    expect(() => identifier("")).toThrowError(DatabaseCompilerError);
    expect(() => identifier("bad\0name")).toThrowError(
      expect.objectContaining({ code: "invalid_identifier" }),
    );
  });

  it("keeps the raw escape explicit and non-executing", () => {
    expect(unsafeRawSql("SELECT ?", [7])).toEqual({
      text: "SELECT ?",
      bindings: [7],
    });
  });
});
