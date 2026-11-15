import {
  entityMembershipRelation,
  eventMembershipRelation,
  type PreparedMembershipMatch,
  type PreparedMembershipRelations,
  visitMembershipRelation,
} from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";

/** Provider-local physical data; never a semantic selection or lowerer handle. */
export interface WholeOriginalProjection {
  readonly relations: PreparedMembershipRelations;
  readonly siteIds: readonly string[];
  readonly mode: "entity" | "observation";
}

/** Same projection, match-copy and final site validation order as registration.
 * No filter normalization, snapshot, reader construction or new authority. */
export function projectWholeOriginalMembership(input: {
  readonly siteIds: readonly string[];
  readonly mode: "entity" | "observation";
  readonly matches: readonly PreparedMembershipMatch[];
}): WholeOriginalProjection {
  const relations: PreparedMembershipRelations =
    input.mode === "observation"
      ? {
          visit: visitMembershipRelation(input.siteIds, input.matches),
          event: eventMembershipRelation(input.siteIds, input.matches),
        }
      : { entity: entityMembershipRelation(input.siteIds, input.matches) };
  // Keep the old spread/freeze observation before the final site check.
  Object.freeze(input.matches.map((match) => Object.freeze({ ...match })));
  if (
    !Array.isArray(input.siteIds) ||
    input.siteIds.some((id) => typeof id !== "string" || !id)
  )
    throw new Error("prepared_membership_sites_invalid");
  return Object.freeze({
    relations: Object.freeze(relations),
    siteIds: Object.freeze([...new Set(input.siteIds)].sort()),
    mode: input.mode,
  });
}
