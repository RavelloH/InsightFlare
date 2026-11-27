import {
  aggregate,
  and,
  coalesce,
  compileD1Mutation,
  compileD1Query,
  type CompiledMutation,
  count,
  createD1DatabaseClient,
  deleteFrom,
  eq,
  filter,
  inSubquery,
  join,
  limit,
  param,
  project,
  scalar,
  scan,
  schema,
  unixepoch,
  update,
} from "@/lib/db";
import type { SqlExpression } from "@/lib/db/query/expression";
import type { Env } from "@/lib/edge/types";

/**
 * Lifecycle of user-owned team resources (saved filters today, dashboards
 * next). Policy:
 * - leaving a team deletes the member's private resources in that team and
 *   hands team-visible ones to the current team owner;
 * - deleting an account does the same across every team, then deletes the
 *   user in the same D1 batch. `saved_filters.owner_user_id` stays
 *   ON DELETE RESTRICT, so a row created concurrently rolls the batch back
 *   instead of leaving an orphan;
 * - site access changes are reversible and intentionally do nothing here.
 * The new owner always comes from `teams.owner_user_id` inside the
 * statement, never from the client.
 */

function teamSiteIds(teamId: string) {
  const sites = scan(schema.sites);
  const matching = filter(sites, eq(sites.columns.team_id, param(teamId)));
  return project(matching, { id: matching.columns.id });
}

function teamOwnerOf(teamId: string) {
  const teams = scan(schema.teams);
  const matching = filter(teams, eq(teams.columns.id, param(teamId)));
  return scalar(
    limit(
      project(matching, { ownerUserId: matching.columns.owner_user_id }),
      1,
    ),
  );
}

/** Owner of the team that owns `siteId`, correlated to the updated row. */
function siteTeamOwnerOf(siteId: SqlExpression<string>) {
  const sites = scan(schema.sites);
  const teams = scan(schema.teams);
  const joined = join(
    sites,
    teams,
    eq(sites.columns.team_id, teams.columns.id),
    "inner",
  );
  const matching = filter(joined, eq(joined.columns.left_id, siteId));
  return scalar(
    limit(
      project(matching, { ownerUserId: matching.columns.right_owner_user_id }),
      1,
    ),
  );
}

export function memberDepartureMutations(
  teamId: string,
  userId: string,
): CompiledMutation[] {
  return [
    compileD1Mutation(
      deleteFrom(schema.saved_filters, (columns) =>
        and(
          eq(columns.owner_user_id, param(userId)),
          eq(columns.visibility, param("private")),
          inSubquery(columns.site_id, teamSiteIds(teamId)),
        ),
      ),
      { tag: "admin.owned_resources.saved_filters.delete_private" },
    ),
    compileD1Mutation(
      update(schema.saved_filters, (columns) => ({
        // sites.team_id and teams.owner_user_id are NOT NULL foreign keys, so
        // the subquery always resolves; coalesce only narrows the type.
        set: {
          owner_user_id: coalesce(teamOwnerOf(teamId), columns.owner_user_id),
          updated_at: unixepoch(),
        },
        where: and(
          eq(columns.owner_user_id, param(userId)),
          eq(columns.visibility, param("team")),
          inSubquery(columns.site_id, teamSiteIds(teamId)),
        ),
      })),
      { tag: "admin.owned_resources.saved_filters.transfer_shared" },
    ),
  ];
}

/** Must run before the user row is deleted, in the same batch. */
export function accountDeletionMutations(userId: string): CompiledMutation[] {
  return [
    compileD1Mutation(
      deleteFrom(schema.saved_filters, (columns) =>
        and(
          eq(columns.owner_user_id, param(userId)),
          eq(columns.visibility, param("private")),
        ),
      ),
      { tag: "admin.owned_resources.saved_filters.delete_private" },
    ),
    compileD1Mutation(
      update(schema.saved_filters, (columns) => ({
        set: {
          owner_user_id: coalesce(
            siteTeamOwnerOf(columns.site_id),
            columns.owner_user_id,
          ),
          updated_at: unixepoch(),
        },
        where: and(
          eq(columns.owner_user_id, param(userId)),
          eq(columns.visibility, param("team")),
        ),
      })),
      { tag: "admin.owned_resources.saved_filters.transfer_shared" },
    ),
  ];
}

export interface OwnedResourceImpact {
  readonly deleted: number;
  readonly transferred: number;
}

/** Counts what `memberDepartureMutations` would affect, for confirmation UI. */
export async function memberDepartureImpact(
  env: Env,
  teamId: string,
  userId: string,
): Promise<OwnedResourceImpact> {
  const savedFilters = scan(schema.saved_filters);
  const owned = filter(
    savedFilters,
    and(
      eq(savedFilters.columns.owner_user_id, param(userId)),
      inSubquery(savedFilters.columns.site_id, teamSiteIds(teamId)),
    ),
  );
  const grouped = aggregate(owned, {
    groupBy: { visibility: owned.columns.visibility },
    aggregates: { count: count() },
  });
  const rows = await createD1DatabaseClient(env.DB).all(
    compileD1Query(grouped, { tag: "admin.owned_resources.impact" }),
  );
  let deleted = 0;
  let transferred = 0;
  for (const row of rows.results) {
    const total = Number(row.count ?? 0);
    if (row.visibility === "private") deleted += total;
    else if (row.visibility === "team") transferred += total;
  }
  return { deleted, transferred };
}
