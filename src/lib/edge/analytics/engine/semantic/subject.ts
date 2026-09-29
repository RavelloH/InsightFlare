import type {
  QuerySubject,
  SiteId,
  TeamId,
} from "@/lib/edge/analytics/contract/types";

export interface SemanticSubjectDomain {
  readonly origin: "site" | "team";
  readonly siteIds: readonly SiteId[];
  readonly teamId?: TeamId;
}

export class SemanticSubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticSubjectError";
  }
}

export function createSemanticSubjectDomain(input: {
  readonly origin: "site" | "team";
  readonly siteIds: readonly SiteId[];
  readonly teamId?: TeamId;
}): SemanticSubjectDomain {
  if (input.origin === "site" && input.siteIds.length !== 1) {
    throw new SemanticSubjectError(
      "A site subject must contain exactly one authorized site.",
    );
  }
  if (input.origin === "team" && !input.teamId) {
    throw new SemanticSubjectError("A team subject requires a team ID.");
  }
  if (input.origin === "site" && input.teamId === undefined) {
    return Object.freeze({
      origin: "site",
      siteIds: Object.freeze([...new Set(input.siteIds)].sort()),
    });
  }
  return Object.freeze({
    origin: input.origin,
    siteIds: Object.freeze([...new Set(input.siteIds)].sort()),
    ...(input.teamId ? { teamId: input.teamId } : {}),
  });
}

export function semanticSubjectFromQuerySubject(
  subject: QuerySubject,
): SemanticSubjectDomain {
  if (subject.kind === "site") {
    return createSemanticSubjectDomain({
      origin: "site",
      siteIds: [subject.siteId],
      ...(subject.teamId ? { teamId: subject.teamId } : {}),
    });
  }
  return createSemanticSubjectDomain({
    origin: "team",
    teamId: subject.teamId,
    siteIds: subject.authorizedSiteIds,
  });
}

export function isCanonicalSemanticSubjectDomain(
  subject: SemanticSubjectDomain,
): boolean {
  if (subject.origin === "site" && subject.siteIds.length !== 1) return false;
  if (subject.origin === "team" && !subject.teamId) return false;
  const canonical = [...new Set(subject.siteIds)].sort();
  return (
    canonical.length === subject.siteIds.length &&
    canonical.every((siteId, index) => siteId === subject.siteIds[index])
  );
}
