import {
  and,
  eq,
  filter,
  inList,
  join,
  project,
  recursiveClosure,
  scan,
} from "@/lib/db";
import { schema } from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  SqlExpression,
} from "@/lib/db/query/expression";
import type { Relation } from "@/lib/db/query/plan";

/** Legacy finite path-to-node plus ancestor closure returning keyed rows. */
type EventPkColumn = SqlExpression<
  number | null,
  ExpressionResultType<"integer", boolean>
>;

export function selectEventPayloadNodeRows<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>> & {
    readonly event_pk: EventPkColumn;
  },
>(
  eventKeys: Relation<Row, Columns>,
  requestedPaths: readonly string[],
  wholePayload = false,
) {
  const nodes = scan(schema.custom_event_json_nodes);
  if (wholePayload || requestedPaths.length === 0)
    return project(nodes, {
      event_pk: nodes.columns.event_pk,
      node_id: nodes.columns.node_id,
      parent_node_id: nodes.columns.parent_node_id,
      key_id: nodes.columns.key_id,
      path_id: nodes.columns.path_id,
      value_type: nodes.columns.value_type,
      array_index: nodes.columns.array_index,
    });

  const paths = scan(schema.custom_event_json_paths);
  const nodePaths = join(
    nodes,
    paths,
    eq(nodes.columns.path_id, paths.columns.id),
  );
  const seedEvents = join(
    nodePaths,
    eventKeys,
    eq(nodePaths.columns.left_event_pk, eventKeys.columns.event_pk),
  );
  const seedCandidates = filter(
    seedEvents,
    inList(seedEvents.columns.left_right_path, requestedPaths),
  );
  const seed = project(seedCandidates, {
    event_pk: seedCandidates.columns.left_left_event_pk,
    node_id: seedCandidates.columns.left_left_node_id,
    parent_node_id: seedCandidates.columns.left_left_parent_node_id,
  });
  const candidates = project(nodes, {
    event_pk: nodes.columns.event_pk,
    node_id: nodes.columns.node_id,
    parent_node_id: nodes.columns.parent_node_id,
  });
  const selected = recursiveClosure(seed, candidates, (current, candidate) =>
    and(
      eq(current.event_pk, candidate.event_pk),
      eq(current.parent_node_id, candidate.node_id),
    ),
  );
  const closureNodes = join(
    selected,
    nodes,
    and(
      eq(selected.columns.event_pk, nodes.columns.event_pk),
      eq(selected.columns.node_id, nodes.columns.node_id),
    ),
  );
  return project(closureNodes, {
    event_pk: closureNodes.columns.right_event_pk,
    node_id: closureNodes.columns.right_node_id,
    parent_node_id: closureNodes.columns.right_parent_node_id,
    key_id: closureNodes.columns.right_key_id,
    path_id: closureNodes.columns.right_path_id,
    value_type: closureNodes.columns.right_value_type,
    array_index: closureNodes.columns.right_array_index,
  });
}

/**
 * Selects exact path matches and their same-Event ancestors while carrying the
 * unique base row's complete node facts through the recursive closure. The
 * provider table's NOT NULL `(event_pk, node_id)` primary key in `docs/schema.sql`
 * (also recorded as BINARY in the generated schema) makes the four extra
 * columns functionally determined by that key. This is reserved for the
 * shared Logical storage path; the legacy helper above keeps its original
 * closure and post-closure lookup.
 */
export function selectEventPayloadNodeFacts<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>> & {
    readonly event_pk: EventPkColumn;
  },
>(
  eventKeys: Relation<Row, Columns>,
  requestedPaths: readonly string[],
  wholePayload = false,
) {
  const nodes = scan(schema.custom_event_json_nodes);
  if (wholePayload || requestedPaths.length === 0)
    return project(nodes, {
      event_pk: nodes.columns.event_pk,
      node_id: nodes.columns.node_id,
      parent_node_id: nodes.columns.parent_node_id,
      key_id: nodes.columns.key_id,
      path_id: nodes.columns.path_id,
      value_type: nodes.columns.value_type,
      array_index: nodes.columns.array_index,
    });

  const paths = scan(schema.custom_event_json_paths);
  const nodePaths = join(
    nodes,
    paths,
    eq(nodes.columns.path_id, paths.columns.id),
  );
  const seedEvents = join(
    nodePaths,
    eventKeys,
    eq(nodePaths.columns.left_event_pk, eventKeys.columns.event_pk),
  );
  const seedCandidates = filter(
    seedEvents,
    inList(seedEvents.columns.left_right_path, requestedPaths),
  );
  const seed = project(seedCandidates, {
    event_pk: seedCandidates.columns.left_left_event_pk,
    node_id: seedCandidates.columns.left_left_node_id,
    parent_node_id: seedCandidates.columns.left_left_parent_node_id,
    key_id: seedCandidates.columns.left_left_key_id,
    path_id: seedCandidates.columns.left_left_path_id,
    value_type: seedCandidates.columns.left_left_value_type,
    array_index: seedCandidates.columns.left_left_array_index,
  });
  const candidates = project(nodes, {
    event_pk: nodes.columns.event_pk,
    node_id: nodes.columns.node_id,
    parent_node_id: nodes.columns.parent_node_id,
    key_id: nodes.columns.key_id,
    path_id: nodes.columns.path_id,
    value_type: nodes.columns.value_type,
    array_index: nodes.columns.array_index,
  });
  return recursiveClosure(seed, candidates, (current, candidate) =>
    and(
      eq(current.event_pk, candidate.event_pk),
      eq(current.parent_node_id, candidate.node_id),
    ),
  );
}
