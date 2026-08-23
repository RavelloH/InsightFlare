/**
 * Resolve an external site id inside the same D1 statement that reads a
 * site-scoped table. SQLite treats the uncorrelated scalar subquery as a
 * constant, so the outer predicate can use a site_pk index without adding a
 * separate Worker-to-D1 round trip.
 */
export const SITE_PK_FROM_SITE_ID_SQL =
  "(SELECT site_pk FROM site_identities WHERE site_id = ?)";

export function sitePksFromSiteIdsSql(siteCount: number): string {
  if (!Number.isSafeInteger(siteCount) || siteCount <= 0) {
    throw new RangeError("siteCount must be a positive integer");
  }
  const placeholders = Array.from({ length: siteCount }, () => "?").join(", ");
  return `(SELECT site_pk FROM site_identities WHERE site_id IN (${placeholders}))`;
}
