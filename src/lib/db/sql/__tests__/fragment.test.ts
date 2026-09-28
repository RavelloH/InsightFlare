import { describe, expect, it } from "vitest";

import { DatabaseCompilerError } from "@/lib/db/query/errors";
import {
  concat,
  join,
  parameter,
  parenthesize,
  text,
  unsafeRawSql,
} from "@/lib/db/sql/fragment";
import { identifier } from "@/lib/db/sql/identifier";

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
