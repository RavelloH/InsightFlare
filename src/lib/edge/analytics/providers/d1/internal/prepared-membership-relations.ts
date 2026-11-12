import { valuesRelation } from "@/lib/db";
import {
  createPreparedMembership,
  type PreparedMembership,
  preparedMembershipPayload,
} from "@/lib/edge/analytics/contract/prepared-membership";

import { sqliteBoundText } from "./lowering/scoped-source/selection-compatibility";
import type { AnalyticsDbRelation } from "./analytics-relational-storage";

/** One evaluated identity of an advanced filter. */
export interface PreparedMembershipMatch {
  readonly siteId: string;
  readonly kind: "entity" | "visit" | "event";
  readonly id: string;
}

/** Physical (site_id, <role>_id) relations behind a prepared membership. */
export interface PreparedMembershipRelations {
  readonly entity?: AnalyticsDbRelation;
  readonly visit?: AnalyticsDbRelation;
  readonly event?: AnalyticsDbRelation;
}

interface PreparedMembershipPayload {
  readonly relations: PreparedMembershipRelations;
  /** The evaluated identities, readable only through the registry. */
  readonly matches: readonly PreparedMembershipMatch[];
}

function identityRelation(
  siteIds: readonly string[],
  matches: readonly PreparedMembershipMatch[],
  kind: PreparedMembershipMatch["kind"],
  column: "entity_id" | "visit_id" | "event_id",
): AnalyticsDbRelation {
  const allowed = new Set(siteIds);
  const unique = new Map<string, { siteId: string; id: string }>();
  for (const match of matches) {
    if (!match) throw new Error("prepared_membership_match_invalid");
    if (match.kind !== kind) continue;
    if (
      typeof match.siteId !== "string" ||
      typeof match.id !== "string" ||
      !allowed.has(match.siteId)
    )
      throw new Error("prepared_membership_identity_invalid");
    unique.set(JSON.stringify([match.siteId, match.id]), {
      siteId: match.siteId,
      id: match.id,
    });
  }
  const rows = [...unique.values()].sort(
    (left, right) =>
      left.siteId.localeCompare(right.siteId) ||
      left.id.localeCompare(right.id),
  );
  return valuesRelation(
    {
      site_id: { affinity: "text", nullable: false },
      [column]: { affinity: "text", nullable: false },
    },
    rows.map((row) => ({
      site_id: sqliteBoundText(row.siteId),
      [column]: sqliteBoundText(row.id),
    })),
  ) as AnalyticsDbRelation;
}

/** (site_id, visit_id) relation of the evaluated Page visits. */
export function visitMembershipRelation(
  siteIds: readonly string[],
  matches: readonly PreparedMembershipMatch[],
): AnalyticsDbRelation {
  return identityRelation(siteIds, matches, "visit", "visit_id");
}

/** (site_id, event_id) relation of the evaluated Events. */
export function eventMembershipRelation(
  siteIds: readonly string[],
  matches: readonly PreparedMembershipMatch[],
): AnalyticsDbRelation {
  return identityRelation(siteIds, matches, "event", "event_id");
}

/** (site_id, entity_id) relation of the evaluated sessions or visitors. */
export function entityMembershipRelation(
  siteIds: readonly string[],
  matches: readonly PreparedMembershipMatch[],
): AnalyticsDbRelation {
  return identityRelation(siteIds, matches, "entity", "entity_id");
}

/**
 * Register the result of one advanced-filter evaluation. Observation plans
 * qualify Page visits and Events; entity plans qualify sessions or visitors.
 */
export function registerPreparedMembership(input: {
  readonly siteIds: readonly string[];
  readonly mode: "observation" | "entity";
  readonly matches: readonly PreparedMembershipMatch[];
}): PreparedMembership {
  const relations: PreparedMembershipRelations =
    input.mode === "observation"
      ? {
          visit: visitMembershipRelation(input.siteIds, input.matches),
          event: eventMembershipRelation(input.siteIds, input.matches),
        }
      : { entity: entityMembershipRelation(input.siteIds, input.matches) };
  const payload: PreparedMembershipPayload = Object.freeze({
    relations: Object.freeze(relations),
    matches: Object.freeze(
      input.matches.map((match) => Object.freeze({ ...match })),
    ),
  });
  return createPreparedMembership({ siteIds: input.siteIds, payload });
}

/** Physical relations behind a handle; undefined for a foreign value. */
export function resolvePreparedMembership(
  handle: unknown,
): PreparedMembershipRelations | undefined {
  const payload = preparedMembershipPayload(handle);
  return payload ? (payload as PreparedMembershipPayload).relations : undefined;
}

/**
 * The identities a handle was registered with. Diagnostic read-back for tests
 * and evidence; plans, selections and lowering never see identities.
 */
export function preparedMembershipMatches(
  handle: unknown,
): readonly PreparedMembershipMatch[] | undefined {
  const payload = preparedMembershipPayload(handle);
  return payload ? (payload as PreparedMembershipPayload).matches : undefined;
}
