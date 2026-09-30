import {
  compileD1Mutation,
  type CompiledMutation,
  D1_MAX_BOUND_PARAMETERS,
  deleteFrom,
  filter,
  inList,
  inSubquery,
  project,
  scan,
  schema,
} from "@/lib/db";
import { sitePksForSiteIds } from "@/lib/edge/sites/identity-query";

export const MAX_SITE_IDS_PER_D1_QUERY = D1_MAX_BOUND_PARAMETERS;

function eventPksForSiteIds(siteIds: readonly string[]) {
  const sitePks = sitePksForSiteIds(siteIds);
  const events = scan(schema.custom_events);
  const matchingEvents = filter(
    events,
    inSubquery(events.columns.site_pk, sitePks),
  );
  return project(matchingEvents, {
    event_pk: matchingEvents.columns.event_pk,
  });
}

export function teamDeletionMutations(
  siteIds: readonly string[],
): CompiledMutation[] {
  const chunks: string[][] = [];
  for (
    let index = 0;
    index < siteIds.length;
    index += MAX_SITE_IDS_PER_D1_QUERY
  )
    chunks.push(siteIds.slice(index, index + MAX_SITE_IDS_PER_D1_QUERY));

  const buildForChunk: Array<(chunk: string[]) => CompiledMutation> = [
    (chunk) =>
      compileD1Mutation(
        deleteFrom(schema.custom_event_json_values, (columns) =>
          inSubquery(columns.site_pk, sitePksForSiteIds(chunk)),
        ),
        { tag: "admin.teams.delete_site_settings" },
      ),
    (chunk) =>
      compileD1Mutation(
        deleteFrom(schema.custom_event_json_nodes, (columns) =>
          inSubquery(columns.event_pk, eventPksForSiteIds(chunk)),
        ),
        { tag: "admin.teams.delete_site_settings" },
      ),
    (chunk) =>
      compileD1Mutation(
        deleteFrom(schema.custom_events, (columns) =>
          inSubquery(columns.site_pk, sitePksForSiteIds(chunk)),
        ),
        { tag: "admin.teams.delete_site_settings" },
      ),
    (chunk) =>
      compileD1Mutation(
        deleteFrom(schema.custom_event_names, (columns) =>
          inSubquery(columns.site_pk, sitePksForSiteIds(chunk)),
        ),
        { tag: "admin.teams.delete_site_settings" },
      ),
    (chunk) =>
      compileD1Mutation(
        deleteFrom(schema.custom_event_json_keys, (columns) =>
          inSubquery(columns.site_pk, sitePksForSiteIds(chunk)),
        ),
        { tag: "admin.teams.delete_site_settings" },
      ),
    (chunk) =>
      compileD1Mutation(
        deleteFrom(schema.custom_event_json_paths, (columns) =>
          inSubquery(columns.site_pk, sitePksForSiteIds(chunk)),
        ),
        { tag: "admin.teams.delete_site_settings" },
      ),
    (chunk) =>
      compileD1Mutation(
        deleteFrom(schema.visits, (columns) =>
          inSubquery(columns.site_pk, sitePksForSiteIds(chunk)),
        ),
        { tag: "admin.teams.delete_site_settings" },
      ),
    (chunk) =>
      compileD1Mutation(
        deleteFrom(schema.visit_hourly_rollups, (columns) =>
          inSubquery(columns.site_pk, sitePksForSiteIds(chunk)),
        ),
        { tag: "admin.teams.delete_site_settings" },
      ),
    (chunk) =>
      compileD1Mutation(
        deleteFrom(schema.visit_hourly_aggregation_state, (columns) =>
          inSubquery(columns.site_pk, sitePksForSiteIds(chunk)),
        ),
        { tag: "admin.teams.delete_site_settings" },
      ),
    (chunk) =>
      compileD1Mutation(
        deleteFrom(schema.configs, (columns) =>
          inList(
            columns.config_key,
            chunk.map((siteId) => `site:${siteId}`),
          ),
        ),
        { tag: "admin.teams.delete_site_settings" },
      ),
  ];

  return buildForChunk.flatMap((build) => chunks.map(build));
}
