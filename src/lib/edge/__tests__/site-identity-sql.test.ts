import { describe, expect, it } from "vitest";

import {
  SITE_PK_FROM_SITE_ID_SQL,
  sitePksFromSiteIdsSql,
} from "@/lib/edge/site-identity-sql";

describe("site identity SQL", () => {
  it("builds site_pk lookups from external site IDs", () => {
    expect(SITE_PK_FROM_SITE_ID_SQL).toBe(
      "(SELECT site_pk FROM site_identities WHERE site_id = ?)",
    );
    expect(sitePksFromSiteIdsSql(3)).toBe(
      "(SELECT site_pk FROM site_identities WHERE site_id IN (?, ?, ?))",
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid site count of %s",
    (siteCount) => {
      expect(() => sitePksFromSiteIdsSql(siteCount)).toThrow(RangeError);
    },
  );
});
