import type { BoundCteDefinition } from "./filter-qualification";
import { boundCte } from "./filter-qualification";

export type SequenceActivityKind = "page" | "event";
export type SequenceAnchorKind = "page" | "event" | "session" | "visitor";

export interface SequenceCollection {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly entityKind: SequenceActivityKind;
}

export interface SequenceMatchCollection {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly entityKind: "sequence";
}

/** Full stable timeline. Match predicates never remove intervening activities. */
export function timelineCte(
  visitRelation: string,
  eventRelation: string,
): BoundCteDefinition {
  return boundCte(
    "scope_filter_timeline",
    `scope_filter_timeline AS (
    SELECT timeline.*,
      ROW_NUMBER() OVER (
        PARTITION BY timeline.site_pk, timeline.session_key
        ORDER BY timeline.activity_time ASC, timeline.kind_rank ASC,
          timeline.activity_id COLLATE BINARY ASC
      ) AS pos_session,
      ROW_NUMBER() OVER (
        PARTITION BY timeline.site_pk, timeline.visitor_id
        ORDER BY timeline.activity_time ASC, timeline.kind_rank ASC,
          timeline.activity_id COLLATE BINARY ASC
      ) AS pos_visitor
    FROM (
      SELECT v.site_pk, v.session_id, v.visitor_id, v.visit_id,
        NULL AS event_pk, 'page' AS activity_kind,
        v.started_at AS activity_time, 0 AS kind_rank,
        v.visit_id AS activity_id,
        COALESCE(NULLIF(v.session_id, ''), v.visit_id) AS session_key
      FROM ${visitRelation} v
      UNION ALL
      SELECT e.site_pk, e.session_id, e.visitor_id, e.visit_id,
        e.event_pk, 'event' AS activity_kind,
        e.occurred_at AS activity_time, 1 AS kind_rank,
        e.event_id AS activity_id,
        COALESCE(NULLIF(e.session_id, ''), e.visit_id) AS session_key
      FROM ${eventRelation} e
    ) timeline
  )`,
  );
}

function position(anchor: SequenceAnchorKind): "pos_session" | "pos_visitor" {
  return anchor === "visitor" ? "pos_visitor" : "pos_session";
}

function anchorIdentity(
  anchor: SequenceAnchorKind,
): "visitor_id" | "session_key" {
  return anchor === "visitor" ? "visitor_id" : "session_key";
}

/** Enumerate *all* strictly increasing N-step combinations in SQL. */
export function compileSequenceMatches(
  steps: readonly SequenceCollection[],
  anchor: SequenceAnchorKind,
): SequenceMatchCollection {
  if (steps.length < 2)
    throw new TypeError("Sequence must contain at least two steps.");
  const ordinal = position(anchor);
  const identity = anchorIdentity(anchor);
  const select: string[] = [];
  const source: string[] = [];
  const bindings: Array<string | number | null> = [];

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    if (step.entityKind !== "page" && step.entityKind !== "event") {
      throw new TypeError("Sequence steps must be occurrence collections.");
    }
    const item = `sequence_item_${index + 1}`;
    const activity = `sequence_activity_${index + 1}`;
    const key =
      step.entityKind === "event"
        ? `${activity}.event_pk = ${item}.event_pk`
        : `${activity}.visit_id = ${item}.visit_id`;
    source.push(`${index === 0 ? "FROM" : "CROSS JOIN"} (${step.sql}) ${item}
      INNER JOIN scope_filter_timeline ${activity}
        ON ${activity}.site_pk = ${item}.site_pk
       AND ${activity}.activity_kind = '${step.entityKind}'
       AND ${key}`);
    bindings.push(...step.bindings);
    select.push(`json_object('kind', ${activity}.activity_kind,
      'time', ${activity}.activity_time,
      'site_pk', ${activity}.site_pk,
      'event_pk', ${activity}.event_pk,
      'visit_id', ${activity}.visit_id)`);
  }

  const first = "sequence_activity_1";
  const last = `sequence_activity_${steps.length}`;
  const constraints: string[] = [];
  for (let index = 2; index <= steps.length; index++) {
    const current = `sequence_activity_${index}`;
    const previous = `sequence_activity_${index - 1}`;
    constraints.push(`${current}.site_pk = ${first}.site_pk`);
    constraints.push(`${current}.${identity} = ${first}.${identity}`);
    constraints.push(`${current}.${ordinal} > ${previous}.${ordinal}`);
  }
  return {
    entityKind: "sequence",
    sql: `SELECT ${first}.site_pk, ${first}.${identity} AS anchor_id,
        ${first}.activity_time AS start_ms,
        ${last}.activity_time AS end_ms,
        json_array(${select.join(", ")}) AS sequence_steps,
        json_array(${steps.map((_, i) => `sequence_activity_${i + 1}.${ordinal}`).join(", ")}) AS sequence_positions
      ${source.join("\n")}
      WHERE ${constraints.join(" AND ")}`,
    bindings,
  };
}

export function compileAdjacentMatches(
  sequence: SequenceMatchCollection,
): SequenceMatchCollection {
  return {
    entityKind: "sequence",
    sql: `SELECT match.* FROM (${sequence.sql}) match
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(match.sequence_positions) position
        WHERE CAST(position.key AS INTEGER) > 0
          AND CAST(position.value AS INTEGER) !=
            CAST(json_extract(match.sequence_positions,
              '$[' || (CAST(position.key AS INTEGER)-1) || ']') AS INTEGER) + 1
      )`,
    bindings: sequence.bindings,
  };
}

export function compileWithoutMatches(
  sequence: SequenceMatchCollection,
  excluded: SequenceCollection,
  anchor: SequenceAnchorKind,
): SequenceMatchCollection {
  const ordinal = position(anchor);
  const key = excluded.entityKind === "event" ? "event_pk" : "visit_id";
  return {
    entityKind: "sequence",
    sql: `SELECT match.* FROM (${sequence.sql}) match
      WHERE NOT EXISTS (
        SELECT 1 FROM (${excluded.sql}) excluded_item
        INNER JOIN scope_filter_timeline excluded_timeline
          ON excluded_timeline.site_pk = excluded_item.site_pk
         AND excluded_timeline.activity_kind = '${excluded.entityKind}'
         AND excluded_timeline.${key} = excluded_item.${key}
        WHERE excluded_timeline.site_pk = match.site_pk
          AND excluded_timeline.${ordinal} >
            CAST(json_extract(match.sequence_positions, '$[0]') AS INTEGER)
          AND excluded_timeline.${ordinal} <
            CAST(json_extract(match.sequence_positions,
              '$[' || (json_array_length(match.sequence_positions)-1) || ']') AS INTEGER)
          AND excluded_timeline.${anchorIdentity(anchor)} = match.anchor_id
      )`,
    bindings: [...sequence.bindings, ...excluded.bindings],
  };
}
