import {
  and,
  compileD1Mutation,
  compileD1Query,
  eq,
  excluded,
  filter,
  insert,
  limit,
  onConflictDoUpdate,
  param,
  project,
  scan,
  schema,
} from "@/lib/db";

import type { DictionaryKind } from "./types";

export function customEventDictionaryUpsert(
  kind: DictionaryKind,
  input: {
    readonly siteId: string;
    readonly sitePk: number;
    readonly value: string;
    readonly seenAt: number;
  },
) {
  switch (kind) {
    case "name":
      return compileD1Mutation(
        onConflictDoUpdate(
          insert(schema.custom_event_names, {
            site_id: input.siteId,
            site_pk: input.sitePk,
            name: input.value,
            created_at: input.seenAt,
            last_seen_at: input.seenAt,
          }),
          ["site_pk", "name"],
          {
            last_seen_at: excluded(
              schema.custom_event_names.columns.last_seen_at,
            ),
          },
        ),
        { tag: "ingest.dictionary.name.upsert" },
      );
    case "key":
      return compileD1Mutation(
        onConflictDoUpdate(
          insert(schema.custom_event_json_keys, {
            site_id: input.siteId,
            site_pk: input.sitePk,
            key: input.value,
            created_at: input.seenAt,
            last_seen_at: input.seenAt,
          }),
          ["site_pk", "key"],
          {
            last_seen_at: excluded(
              schema.custom_event_json_keys.columns.last_seen_at,
            ),
          },
        ),
        { tag: "ingest.dictionary.key.upsert" },
      );
    case "path":
      return compileD1Mutation(
        onConflictDoUpdate(
          insert(schema.custom_event_json_paths, {
            site_id: input.siteId,
            site_pk: input.sitePk,
            path: input.value,
            created_at: input.seenAt,
            last_seen_at: input.seenAt,
          }),
          ["site_pk", "path"],
          {
            last_seen_at: excluded(
              schema.custom_event_json_paths.columns.last_seen_at,
            ),
          },
        ),
        { tag: "ingest.dictionary.path.upsert" },
      );
  }
}

export function customEventDictionaryIdQuery(
  kind: DictionaryKind,
  sitePk: number,
  value: string,
) {
  switch (kind) {
    case "name": {
      const names = scan(schema.custom_event_names);
      const matching = filter(
        names,
        and(
          eq(names.columns.site_pk, param(sitePk)),
          eq(names.columns.name, param(value)),
        ),
      );
      return compileD1Query(
        limit(project(matching, { id: matching.columns.id }), 1),
        { tag: "ingest.dictionary.name.first" },
      );
    }
    case "key": {
      const keys = scan(schema.custom_event_json_keys);
      const matching = filter(
        keys,
        and(
          eq(keys.columns.site_pk, param(sitePk)),
          eq(keys.columns.key, param(value)),
        ),
      );
      return compileD1Query(
        limit(project(matching, { id: matching.columns.id }), 1),
        { tag: "ingest.dictionary.key.first" },
      );
    }
    case "path": {
      const paths = scan(schema.custom_event_json_paths);
      const matching = filter(
        paths,
        and(
          eq(paths.columns.site_pk, param(sitePk)),
          eq(paths.columns.path, param(value)),
        ),
      );
      return compileD1Query(
        limit(project(matching, { id: matching.columns.id }), 1),
        { tag: "ingest.dictionary.path.first" },
      );
    }
  }
}
