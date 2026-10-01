import {
  and,
  eq,
  filter,
  insert,
  isNull,
  limit,
  lt,
  or,
  param,
  project,
  scan,
  schema,
  sort,
  update,
} from "@/lib/db";

export interface AnalysisDefinitionCursor {
  readonly createdAt: number;
  readonly id: string;
}

export interface AnalysisDefinitionInsert {
  readonly id: string;
  readonly siteId: string;
  readonly kind: "goal" | "funnel";
  readonly name: string;
  readonly configJson: string;
  readonly configVersion: number;
  readonly timestamp: number;
}

export function analysisDefinitionsPageQuery(input: {
  readonly kind: "goal" | "funnel";
  readonly siteId: string;
  readonly limit: number;
  readonly cursor?: AnalysisDefinitionCursor | null;
}) {
  const definitions = scan(schema.analysis_definitions);
  const active = filter(
    definitions,
    and(
      eq(definitions.columns.site_id, param(input.siteId)),
      eq(definitions.columns.kind, param(input.kind)),
      isNull(definitions.columns.archived_at),
    ),
  );
  const matching = input.cursor
    ? filter(
        active,
        or(
          lt(active.columns.created_at, param(input.cursor.createdAt)),
          and(
            eq(active.columns.created_at, param(input.cursor.createdAt)),
            lt(active.columns.id, param(input.cursor.id)),
          ),
        ),
      )
    : active;
  const ordered = sort(matching, [
    { expression: matching.columns.created_at, direction: "DESC" },
    { expression: matching.columns.id, direction: "DESC" },
  ]);
  const bounded = limit(ordered, input.limit);
  return project(bounded, {
    id: bounded.columns.id,
    site_id: bounded.columns.site_id,
    name: bounded.columns.name,
    config_json: bounded.columns.config_json,
    config_version: bounded.columns.config_version,
    created_at: bounded.columns.created_at,
    updated_at: bounded.columns.updated_at,
  });
}

export function analysisDefinitionByIdQuery(input: {
  readonly kind: "goal" | "funnel";
  readonly siteId: string;
  readonly id: string;
}) {
  const definitions = scan(schema.analysis_definitions);
  const matching = filter(
    definitions,
    and(
      eq(definitions.columns.id, param(input.id)),
      eq(definitions.columns.site_id, param(input.siteId)),
      eq(definitions.columns.kind, param(input.kind)),
      isNull(definitions.columns.archived_at),
    ),
  );
  const bounded = limit(matching, 1);
  return project(bounded, {
    id: bounded.columns.id,
    site_id: bounded.columns.site_id,
    name: bounded.columns.name,
    config_json: bounded.columns.config_json,
    config_version: bounded.columns.config_version,
    created_at: bounded.columns.created_at,
    updated_at: bounded.columns.updated_at,
  });
}

export function insertAnalysisDefinition(input: AnalysisDefinitionInsert) {
  return insert(schema.analysis_definitions, {
    id: input.id,
    site_id: input.siteId,
    kind: input.kind,
    name: input.name,
    config_json: input.configJson,
    config_version: input.configVersion,
    created_at: input.timestamp,
    updated_at: input.timestamp,
  });
}

export function updateAnalysisDefinition(input: {
  readonly kind: "goal" | "funnel";
  readonly siteId: string;
  readonly id: string;
  readonly name: string;
  readonly configJson: string;
  readonly configVersion: number;
  readonly timestamp: number;
}) {
  return update(schema.analysis_definitions, (columns) => ({
    set: {
      name: input.name,
      config_json: input.configJson,
      config_version: input.configVersion,
      updated_at: input.timestamp,
    },
    where: and(
      eq(columns.id, param(input.id)),
      eq(columns.site_id, param(input.siteId)),
      eq(columns.kind, param(input.kind)),
      isNull(columns.archived_at),
    ),
  }));
}

export function archiveAnalysisDefinition(input: {
  readonly kind: "goal" | "funnel";
  readonly siteId: string;
  readonly id: string;
  readonly timestamp: number;
}) {
  return update(schema.analysis_definitions, (columns) => ({
    set: { archived_at: input.timestamp, updated_at: input.timestamp },
    where: and(
      eq(columns.id, param(input.id)),
      eq(columns.site_id, param(input.siteId)),
      eq(columns.kind, param(input.kind)),
      isNull(columns.archived_at),
    ),
  }));
}
