import {
  compileD1Mutation,
  type CompiledMutation,
  deleteFrom,
  eq,
  filter,
  inSubquery,
  param,
  project,
  scan,
  schema,
} from "@/lib/db";
import { sitePkForSiteId } from "@/lib/edge/sites/identity-query";

export function siteDeletionMutations(siteId: string): CompiledMutation[] {
  const sitePk = sitePkForSiteId(siteId);
  const events = scan(schema.custom_events);
  const matchingEvents = filter(events, eq(events.columns.site_pk, sitePk));
  const eventPks = project(matchingEvents, {
    event_pk: matchingEvents.columns.event_pk,
  });

  return [
    compileD1Mutation(
      deleteFrom(schema.configs, (columns) =>
        eq(columns.config_key, param(`site:${siteId}`)),
      ),
      { tag: "admin.sites.delete_config" },
    ),
    compileD1Mutation(
      deleteFrom(schema.custom_event_json_values, (columns) =>
        eq(columns.site_pk, sitePk),
      ),
      { tag: "admin.sites.delete_custom_event_json_values" },
    ),
    compileD1Mutation(
      deleteFrom(schema.custom_event_json_nodes, (columns) =>
        inSubquery(columns.event_pk, eventPks),
      ),
      { tag: "admin.sites.delete_custom_event_json_nodes" },
    ),
    compileD1Mutation(
      deleteFrom(schema.custom_events, (columns) =>
        eq(columns.site_pk, sitePk),
      ),
      { tag: "admin.sites.delete_custom_events" },
    ),
    compileD1Mutation(
      deleteFrom(schema.custom_event_names, (columns) =>
        eq(columns.site_pk, sitePk),
      ),
      { tag: "admin.sites.delete_custom_event_names" },
    ),
    compileD1Mutation(
      deleteFrom(schema.custom_event_json_keys, (columns) =>
        eq(columns.site_pk, sitePk),
      ),
      { tag: "admin.sites.delete_custom_event_json_keys" },
    ),
    compileD1Mutation(
      deleteFrom(schema.custom_event_json_paths, (columns) =>
        eq(columns.site_pk, sitePk),
      ),
      { tag: "admin.sites.delete_custom_event_json_paths" },
    ),
    compileD1Mutation(
      deleteFrom(schema.visits, (columns) => eq(columns.site_pk, sitePk)),
      { tag: "admin.sites.delete_visits" },
    ),
    compileD1Mutation(
      deleteFrom(schema.visit_hourly_rollups, (columns) =>
        eq(columns.site_pk, sitePk),
      ),
      { tag: "admin.sites.delete_hourly_rollups" },
    ),
    compileD1Mutation(
      deleteFrom(schema.visit_hourly_aggregation_state, (columns) =>
        eq(columns.site_pk, sitePk),
      ),
      { tag: "admin.sites.delete_hourly_aggregation_state" },
    ),
    compileD1Mutation(
      deleteFrom(schema.sites, (columns) => eq(columns.id, param(siteId))),
      { tag: "admin.sites.delete" },
    ),
  ];
}
