import {
  isPreparedMembership,
  type PreparedMembership,
} from "@/lib/edge/analytics/contract/prepared-membership";
import {
  type PreparedMembershipMatch,
  preparedMembershipMatches,
  registerPreparedMembership,
} from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";

interface FixtureIdentity {
  readonly siteId: string;
  readonly id: string;
}

export interface PreparedMembershipFixture {
  readonly entityIds?: readonly FixtureIdentity[];
  readonly visitIds?: readonly FixtureIdentity[];
  readonly eventIds?: readonly FixtureIdentity[];
}

/**
 * Register a membership from literal identities, the way the provider does
 * after evaluating an advanced filter. Entity fixtures register an entity plan
 * and visit/event fixtures register an observation plan.
 */
export function preparedMembershipFromIds(
  fixture: PreparedMembershipFixture,
  siteIds?: readonly string[],
): PreparedMembership {
  const matches: PreparedMembershipMatch[] = [
    ...(fixture.entityIds ?? []).map((item) => ({
      siteId: item.siteId,
      kind: "entity" as const,
      id: item.id,
    })),
    ...(fixture.visitIds ?? []).map((item) => ({
      siteId: item.siteId,
      kind: "visit" as const,
      id: item.id,
    })),
    ...(fixture.eventIds ?? []).map((item) => ({
      siteId: item.siteId,
      kind: "event" as const,
      id: item.id,
    })),
  ];
  const observation =
    fixture.visitIds !== undefined || fixture.eventIds !== undefined;
  return registerPreparedMembership({
    siteIds: siteIds ?? [...new Set(matches.map((match) => match.siteId))],
    mode: observation ? "observation" : "entity",
    matches,
  });
}

/** Read the evaluated identities back out of a handle, grouped by role. */
export function preparedMembershipIdentities(handle: unknown): {
  readonly entityIds: readonly FixtureIdentity[];
  readonly visitIds: readonly FixtureIdentity[];
  readonly eventIds: readonly FixtureIdentity[];
} {
  const matches = preparedMembershipMatches(handle) ?? [];
  const pick = (kind: PreparedMembershipMatch["kind"]) =>
    matches
      .filter((match) => match.kind === kind)
      .map((match) => ({ siteId: match.siteId, id: match.id }));
  return {
    entityIds: pick("entity"),
    visitIds: pick("visit"),
    eventIds: pick("event"),
  };
}

/** Accept either an existing handle or literal identities and return a handle. */
export function toPreparedMembership(
  value: PreparedMembership | PreparedMembershipFixture | undefined,
  siteIds?: readonly string[],
): PreparedMembership | undefined {
  if (value === undefined) return undefined;
  return isPreparedMembership(value)
    ? value
    : preparedMembershipFromIds(value, siteIds);
}
