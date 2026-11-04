import type { SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query, project, scan, valuesRelation } from "@/lib/db";
import type { AnyExpression } from "@/lib/db/query/expression";
import { schema } from "@/lib/db/schema";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import {
  buildComparisonDomainAggregate,
  normalizeAsciiCaseFoldedText,
} from "@/lib/edge/analytics/providers/d1/internal/comparison-domain-admission";

function executeAll(
  database: ReturnType<typeof createMigratedDatabase>,
  query: ReturnType<typeof compileD1Query>,
): readonly Record<string, unknown>[] {
  return database
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Record<
    string,
    unknown
  >[];
}

function comparisonAggregate(
  relation: AnalyticsDbRelation,
  value: AnyExpression,
) {
  return buildComparisonDomainAggregate({
    relation,
    values: [
      {
        fieldId: "geo.country",
        outputName: "invalidComparisonGeoCountryCount",
        value,
      },
    ],
  });
}

describe("qualified Geo comparison domain admission", () => {
  it("normalizes only ASCII TEXT without NUL and counts every invalid value", () => {
    const database = createMigratedDatabase();
    try {
      const insert = database.prepare(
        "INSERT INTO site_identities (site_id) VALUES (?)",
      );
      for (const value of ["US", "\tUS\n\v\f\r ", "é", "\u00a0US", "a\0b"])
        insert.run(value);
      insert.run(new Uint8Array([0x55, 0x53]));

      const source = scan(schema.site_identities);
      const value = source.columns.site_id as AnyExpression;
      const projected = compileD1Query(
        project(source, {
          normalized: normalizeAsciiCaseFoldedText(value),
        }),
      );
      const normalizedRows = executeAll(database, projected).map(
        ({ normalized }) => normalized,
      );
      expect(normalizedRows.filter((value) => value === "us")).toHaveLength(2);
      expect(normalizedRows.filter((value) => value === null)).toHaveLength(4);

      const aggregate = comparisonAggregate(
        source as unknown as AnalyticsDbRelation,
        value,
      );
      const counter = compileD1Query(
        project(aggregate, {
          invalid: aggregate.columns.invalidComparisonGeoCountryCount,
        }),
      );
      expect(executeAll(database, counter)).toEqual([{ invalid: 4 }]);
    } finally {
      database.close();
    }
  });

  it("keeps NULL outside the mismatch count", () => {
    const database = createMigratedDatabase();
    try {
      const source = valuesRelation(
        { value: { affinity: "text", nullable: true } },
        [{ value: null }],
      );
      const aggregate = comparisonAggregate(
        source as unknown as AnalyticsDbRelation,
        source.columns.value as AnyExpression,
      );
      const query = compileD1Query(
        project(aggregate, {
          invalid: aggregate.columns.invalidComparisonGeoCountryCount,
        }),
      );
      expect(executeAll(database, query)).toEqual([{ invalid: 0 }]);
    } finally {
      database.close();
    }
  });
});
