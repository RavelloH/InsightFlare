import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";

export type AuthorizedSiteSubsetPurpose = "activity" | "payload";

/** Preserve the query's semantic origin while narrowing to an authorized chunk. */
export function semanticSubjectForAuthorizedSubset(
  subject: SemanticSubjectDomain,
  siteIds: readonly string[],
  purpose: AuthorizedSiteSubsetPurpose,
): SemanticSubjectDomain {
  const authorizedSiteIds = new Set<string>(subject.siteIds);
  if (
    siteIds.length === 0 ||
    siteIds.some((siteId) => !authorizedSiteIds.has(siteId))
  )
    throw new Error(`advanced_filter_${purpose}_site_subset_unauthorized`);
  if (subject.origin === "site" && siteIds.length !== 1)
    throw new Error(`advanced_filter_${purpose}_site_subset_invalid`);
  return createSemanticSubjectDomain({
    origin: subject.origin,
    siteIds: siteIds as SemanticSubjectDomain["siteIds"],
    ...(subject.teamId ? { teamId: subject.teamId } : {}),
  });
}
