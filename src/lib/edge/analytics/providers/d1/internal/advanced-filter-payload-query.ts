import {
  and,
  compileD1Query,
  eq,
  filter,
  gte,
  inList,
  join,
  limit,
  lowerLogicalPlan,
  lt,
  param,
  project,
  scan,
  sort,
} from "@/lib/db";
import { schema } from "@/lib/db";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticSubjectForAuthorizedSubset } from "@/lib/edge/analytics/providers/d1/internal/authorized-site-subject";
import type { D1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

import { queryD1CompiledAll } from "./core-sources";
import { selectEventPayloadNodeRows } from "./event-payload-node-selection";

export interface AdvancedFilterPayloadNode extends Record<string, unknown> {
  readonly event_id: string;
  readonly node_id: number;
  readonly parent_node_id: number | null;
  readonly key_name: string | null;
  readonly array_index: number | null;
  readonly value_type: number;
  readonly string_value: string | null;
  readonly number_value: number | null;
  readonly boolean_value: number | null;
}

export interface AdvancedFilterPayloadRangeQuery {
  readonly env: Env;
  readonly subject: SemanticSubjectDomain;
  readonly siteIds: readonly string[];
  readonly range: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly paths: readonly string[];
  readonly wholePayload: boolean;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}

const ADVANCED_FILTER_PAYLOAD_QUERY_LIMIT = 50_001;

function scopedEvents(input: AdvancedFilterPayloadRangeQuery) {
  const events = scan(schema.custom_events);
  const identities = scan(schema.site_identities);
  const joined = join(
    events,
    identities,
    eq(events.columns.site_pk, identities.columns.site_pk),
  );
  const eligible = filter(
    joined,
    and(
      inList(joined.columns.right_site_id, input.siteIds),
      gte(joined.columns.left_occurred_at, param(input.range.startMs)),
      lt(joined.columns.left_occurred_at, param(input.range.endExclusiveMs)),
    ),
  );
  return project(eligible, {
    event_pk: eligible.columns.left_event_pk,
    event_id: eligible.columns.left_event_id,
    site_pk: eligible.columns.left_site_pk,
    visit_id: eligible.columns.left_visit_id,
  });
}

function selectedNodes(input: AdvancedFilterPayloadRangeQuery) {
  return selectEventPayloadNodeRows(
    scopedEvents(input),
    input.paths,
    input.wholePayload,
  );
}

/** Reads one authorized site subset and half-open range of payload nodes. */
export async function queryAdvancedFilterPayloadNodes(
  input: AdvancedFilterPayloadRangeQuery,
): Promise<AdvancedFilterPayloadNode[]> {
  const subject = semanticSubjectForAuthorizedSubset(
    input.subject,
    input.siteIds,
    "payload",
  );

  const scopedInput = { ...input, siteIds: subject.siteIds };
  const events = scopedEvents(scopedInput);
  const nodeRows = selectedNodes(scopedInput);
  const eventNodes = join(
    events,
    nodeRows,
    eq(events.columns.event_pk, nodeRows.columns.event_pk),
  );
  const eventNodeRows = project(eventNodes, {
    event_pk: eventNodes.columns.left_event_pk,
    event_id: eventNodes.columns.left_event_id,
    site_pk: eventNodes.columns.left_site_pk,
    visit_id: eventNodes.columns.left_visit_id,
    node_id: eventNodes.columns.right_node_id,
    parent_node_id: eventNodes.columns.right_parent_node_id,
    key_id: eventNodes.columns.right_key_id,
    path_id: eventNodes.columns.right_path_id,
    value_type: eventNodes.columns.right_value_type,
    array_index: eventNodes.columns.right_array_index,
  });
  const paths = scan(schema.custom_event_json_paths);
  const withPaths = join(
    eventNodeRows,
    paths,
    and(
      eq(eventNodeRows.columns.path_id, paths.columns.id),
      eq(eventNodeRows.columns.site_pk, paths.columns.site_pk),
    ),
  );
  const eventNodePathRows = project(withPaths, {
    event_pk: withPaths.columns.left_event_pk,
    event_id: withPaths.columns.left_event_id,
    site_pk: withPaths.columns.left_site_pk,
    visit_id: withPaths.columns.left_visit_id,
    node_id: withPaths.columns.left_node_id,
    parent_node_id: withPaths.columns.left_parent_node_id,
    key_id: withPaths.columns.left_key_id,
    path_id: withPaths.columns.left_path_id,
    value_type: withPaths.columns.left_value_type,
    array_index: withPaths.columns.left_array_index,
  });
  const keys = scan(schema.custom_event_json_keys);
  const withKeys = join(
    eventNodePathRows,
    keys,
    and(
      eq(eventNodePathRows.columns.key_id, keys.columns.id),
      eq(eventNodePathRows.columns.site_pk, keys.columns.site_pk),
    ),
    "left",
  );
  const eventNodeKeyRows = project(withKeys, {
    event_pk: withKeys.columns.left_event_pk,
    event_id: withKeys.columns.left_event_id,
    site_pk: withKeys.columns.left_site_pk,
    visit_id: withKeys.columns.left_visit_id,
    node_id: withKeys.columns.left_node_id,
    parent_node_id: withKeys.columns.left_parent_node_id,
    key_name: withKeys.columns.right_key,
    array_index: withKeys.columns.left_array_index,
    value_type: withKeys.columns.left_value_type,
  });
  const values = scan(schema.custom_event_json_values);
  const withValues = join(
    eventNodeKeyRows,
    values,
    and(
      eq(eventNodeKeyRows.columns.event_pk, values.columns.event_pk),
      eq(eventNodeKeyRows.columns.node_id, values.columns.node_id),
    ),
    "left",
  );
  const eventNodeValueRows = project(withValues, {
    event_pk: withValues.columns.left_event_pk,
    event_id: withValues.columns.left_event_id,
    site_pk: withValues.columns.left_site_pk,
    visit_id: withValues.columns.left_visit_id,
    node_id: withValues.columns.left_node_id,
    parent_node_id: withValues.columns.left_parent_node_id,
    key_name: withValues.columns.left_key_name,
    array_index: withValues.columns.left_array_index,
    value_type: withValues.columns.left_value_type,
    string_value: withValues.columns.right_string_value,
    number_value: withValues.columns.right_number_value,
    boolean_value: withValues.columns.right_boolean_value,
  });
  const visits = scan(schema.visits);
  const withOwner = join(
    eventNodeValueRows,
    visits,
    and(
      eq(eventNodeValueRows.columns.site_pk, visits.columns.site_pk),
      eq(eventNodeValueRows.columns.visit_id, visits.columns.visit_id),
    ),
  );
  const output = project(withOwner, {
    event_id: withOwner.columns.left_event_id,
    node_id: withOwner.columns.left_node_id,
    parent_node_id: withOwner.columns.left_parent_node_id,
    key_name: withOwner.columns.left_key_name,
    array_index: withOwner.columns.left_array_index,
    value_type: withOwner.columns.left_value_type,
    string_value: withOwner.columns.left_string_value,
    number_value: withOwner.columns.left_number_value,
    boolean_value: withOwner.columns.left_boolean_value,
  });
  const ordered = sort(output, [
    { expression: output.columns.event_id, direction: "ASC" },
    { expression: output.columns.node_id, direction: "ASC" },
  ]);
  const query = compileD1Query(
    lowerLogicalPlan(limit(ordered, ADVANCED_FILTER_PAYLOAD_QUERY_LIMIT)),
    { tag: currentD1Operation() ?? "analytics.query.all" },
  );
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const rows = await queryD1CompiledAll(input.env, query, input.diagnostics);
  return rows;
}
