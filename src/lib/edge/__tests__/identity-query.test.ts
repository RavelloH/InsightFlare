import { describe, expect, it } from "vitest";

import { compileD1Query, project, scan, schema } from "@/lib/db";
import {
  sitePkForSiteId,
  sitePkRelationForSiteId,
  sitePksForSiteIds,
} from "@/lib/edge/sites/identity-query";

describe("typed site identity query builders", () => {
  it("builds one-site identity relations without executing D1", () => {
    const relation = sitePkRelationForSiteId("site-1");
    const compiled = compileD1Query(relation);

    expect(relation.fields).toEqual([
      { name: "site_pk", affinity: "integer", nullable: true },
    ]);
    expect(compiled.sql).toContain('"site_identities"');
    expect(compiled.sql).toContain('"_c1" = ?');
    expect(compiled.bindings).toEqual(["site-1"]);
  });

  it("provides scalar and multi-site forms with stable parameter order", () => {
    const identities = scan(schema.site_identities);
    const scalarQuery = compileD1Query(
      project(identities, {
        site_pk: sitePkForSiteId("site-2"),
      }),
    );
    expect(scalarQuery.sql).toContain("(SELECT ");
    expect(scalarQuery.bindings).toEqual(["site-2"]);

    const multiple = compileD1Query(sitePksForSiteIds(["site-b", "site-a"]));
    expect(multiple.sql).toContain("IN (?, ?)");
    expect(multiple.bindings).toEqual(["site-b", "site-a"]);

    const empty = compileD1Query(sitePksForSiteIds([]));
    expect(empty.sql).toContain("(0)");
    expect(empty.bindings).toEqual([]);
  });
});
