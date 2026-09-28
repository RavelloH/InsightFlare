import {
  eq,
  filter,
  inList,
  param,
  project,
  scalar,
  scan,
  schema,
} from "@/lib/db";

export function sitePkRelationForSiteId(siteId: string) {
  const identities = scan(schema.site_identities);
  const matching = filter(
    identities,
    eq(identities.columns.site_id, param(siteId)),
  );
  return project(matching, { site_pk: matching.columns.site_pk });
}

export function sitePkForSiteId(siteId: string) {
  return scalar(sitePkRelationForSiteId(siteId));
}

export function sitePksForSiteIds(siteIds: readonly string[]) {
  const identities = scan(schema.site_identities);
  const matching = filter(
    identities,
    inList(identities.columns.site_id, siteIds),
  );
  return project(matching, { site_pk: matching.columns.site_pk });
}
