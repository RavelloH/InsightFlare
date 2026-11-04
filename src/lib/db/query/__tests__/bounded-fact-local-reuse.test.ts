import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { introspectSchema } from "@/../scripts/schema/introspect";
import {
  aggregate,
  and,
  antiJoin,
  callFunction,
  caseWhen,
  compileD1Query,
  constant,
  count,
  eq,
  filter,
  gt,
  inSubquery,
  join,
  limit,
  lte,
  project,
  recursiveClosure,
  scan,
  semiJoin,
  union,
  unixepoch,
} from "@/lib/db";
import {
  type BoundedAdmissionIncomingEdge,
  boundedAdmissionReuseCandidates,
} from "@/lib/db/query/bounded-admission-reuse";
import { boundedFactLocalReuseCandidates } from "@/lib/db/query/bounded-fact-local-reuse";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import type { LogicalQueryNode } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
import type { SchemaObjectReference } from "@/lib/db/schema/types";

const databases = new Set<DatabaseSync>();
const testSchemaObjectNames = new Set<string>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  const mutableSchema = schema as unknown as Record<string, unknown>;
  for (const name of testSchemaObjectNames)
    Reflect.deleteProperty(mutableSchema, name);
  testSchemaObjectNames.clear();
});

function database(): DatabaseSync {
  const result = createMigratedDatabase();
  databases.add(result);
  return result;
}

function introspectedTableReference(
  db: DatabaseSync,
  tableName: string,
): SchemaObjectReference {
  const table = introspectSchema(db).find(
    (object) => object.name === tableName && object.kind === "table",
  );
  if (!table) throw new Error(`test_table_missing:${tableName}`);
  const reference: SchemaObjectReference = {
    kind: table.kind,
    name: table.name,
    defaultCollation: table.defaultCollation,
    columns: Object.fromEntries(
      table.columns.map((column) => [
        column.propertyName,
        { kind: "column", table: table.name, ...column },
      ]),
    ),
    primaryKey: table.primaryKey,
    indexes: table.indexes,
    foreignKeys: table.foreignKeys,
  };
  Object.assign(schema, { [table.name]: reference });
  testSchemaObjectNames.add(table.name);
  return reference;
}

function seedDomain(
  db: DatabaseSync,
  domainId: string,
  visitCount: number,
): void {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(domainId);
  const identity = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(domainId) as { readonly site_pk: number } | undefined;
  if (!identity) throw new Error("fact_local_site_identity_missing");
  const insertVisit = db.prepare(
    `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, duration_source, pathname, hostname, site_pk
    ) VALUES (?, ?, ?, ?, 'complete', ?, ?, 'timer', '/', 'example.test', ?)`,
  );
  for (let index = 0; index < visitCount; index += 1) {
    insertVisit.run(
      `${domainId}-visit-${index}`,
      domainId,
      `${domainId}-visitor-${index}`,
      `${domainId}-session-${index}`,
      index + 1,
      index + 1,
      identity.site_pk,
    );
  }
}

function seedCustomEventTrees(db: DatabaseSync, domainId: string): void {
  const site = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(domainId) as { readonly site_pk: number } | undefined;
  if (!site) throw new Error("fact_local_site_identity_missing");
  const eventNameId = Number(
    db
      .prepare(
        "INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, 1, ?) RETURNING id",
      )
      .get(domainId, "indexed tree", site.site_pk)?.id,
  );
  const pathId = Number(
    db
      .prepare(
        "INSERT INTO custom_event_json_paths (site_id, path, last_seen_at, site_pk) VALUES (?, ?, 1, ?) RETURNING id",
      )
      .get(domainId, "/indexed", site.site_pk)?.id,
  );
  const visits = db
    .prepare("SELECT visit_id FROM visits WHERE site_id = ? ORDER BY visit_id")
    .all(domainId) as { readonly visit_id: string }[];
  const insertEvent = db.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, visit_id, event_name_id, occurred_at, received_at,
      node_count, value_count, site_pk
    ) VALUES (?, ?, ?, ?, 1, 1, 3, 0, ?) RETURNING event_pk`,
  );
  const insertNode = db.prepare(
    `INSERT INTO custom_event_json_nodes (
      event_pk, node_id, parent_node_id, path_id, value_type, depth
    ) VALUES (?, ?, ?, ?, 1, ?)`,
  );
  for (const [index, visit] of visits.entries()) {
    const eventPk = Number(
      insertEvent.get(
        `${domainId}-indexed-event-${index}`,
        domainId,
        visit.visit_id,
        eventNameId,
        site.site_pk,
      )?.event_pk,
    );
    insertNode.run(eventPk, 0, null, pathId, 0);
    insertNode.run(eventPk, 1, 0, pathId, 1);
    insertNode.run(eventPk, 2, 0, pathId, 1);
  }
}

function runAll(
  db: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
): Record<string, unknown>[] {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Record<
    string,
    unknown
  >[];
}

function rowBag(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function relationChildren(node: LogicalQueryNode): readonly LogicalQueryNode[] {
  switch (node.kind) {
    case "scan":
    case "values-relation":
    case "json-scalar-array":
      return [];
    case "filter":
    case "project":
    case "aggregate":
    case "distinct":
    case "window":
    case "sort":
    case "limit":
      return [node.input.node];
    case "recursive-closure":
      return [node.seed.node, node.candidates.node];
    case "join":
    case "semi-join":
    case "anti-join":
    case "union":
      return [node.left.node, node.right.node];
  }
}

function graphAnalysis(root: LogicalQueryNode): {
  readonly nodes: readonly LogicalQueryNode[];
  readonly incomingCounts: Map<LogicalQueryNode, number>;
  readonly incoming: Map<LogicalQueryNode, BoundedAdmissionIncomingEdge[]>;
} {
  const nodes: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (active.has(node)) throw new Error("cycle_in_test_fixture");
    if (visited.has(node)) return;
    active.add(node);
    for (const child of relationChildren(node)) visit(child);
    active.delete(node);
    visited.add(node);
    nodes.push(node);
  };
  visit(root);

  const incomingCounts = new Map<LogicalQueryNode, number>([[root, 1]]);
  const incoming = new Map<LogicalQueryNode, BoundedAdmissionIncomingEdge[]>();
  for (const parent of nodes)
    for (const child of relationChildren(parent)) {
      incomingCounts.set(child, (incomingCounts.get(child) ?? 0) + 1);
      incoming.set(child, [
        ...(incoming.get(child) ?? []),
        { parent, kind: "relation" },
      ]);
    }
  return { nodes, incomingCounts, incoming };
}

function fixture(
  domainId = "fact-local-site",
  options: { readonly includeMembershipAncestors?: boolean } = {},
) {
  const source = scan(schema.visits);
  const scopedRows = filter(
    source,
    eq(source.columns.site_id, constant(domainId)),
  );
  const selectedRows = project(scopedRows, {
    eventKey: scopedRows.columns.site_id,
    eventSite: scopedRows.columns.visit_id,
  });
  const bounded = limit(selectedRows, 4);
  const counter = aggregate(bounded, {
    groupBy: {},
    aggregates: { rowCount: count() },
  });
  const admission = filter(counter, lte(counter.columns.rowCount, constant(3)));
  const globalTrue = eq(constant(1), constant(1));
  const admittedRows = join(bounded, admission, globalTrue);
  const otherRows = join(scopedRows, admission, globalTrue);
  const control = project(counter, {
    rowKind: constant(0),
    rowCount: counter.columns.rowCount,
  });
  const carrier = project(admittedRows, {
    eventKey: admittedRows.columns.left_eventKey,
    eventSite: admittedRows.columns.left_eventSite,
  });
  const identityCarrier = project(carrier, {
    eventKey: carrier.columns.eventKey,
    eventSite: carrier.columns.eventSite,
  });
  const rootStats = aggregate(identityCarrier, {
    groupBy: { eventKey: identityCarrier.columns.eventKey },
    aggregates: { eventCount: count() },
  });
  const fullRootLookup = join(
    identityCarrier,
    rootStats,
    eq(identityCarrier.columns.eventKey, rootStats.columns.eventKey),
  );
  const validRootChild = filter(
    rootStats,
    gt(rootStats.columns.eventCount, constant(1_000_000)),
  );
  const fullRootBranch = project(fullRootLookup, {
    eventKey: fullRootLookup.columns.left_eventKey,
    rowCount: fullRootLookup.columns.right_eventCount,
  });
  const validChildBranch = project(validRootChild, {
    eventKey: validRootChild.columns.eventKey,
    rowCount: validRootChild.columns.eventCount,
  });
  const admittedRowsBranch = project(otherRows, {
    eventKey: otherRows.columns.left_site_id,
    rowCount: constant(0),
  });
  const admittedCarrierBranch = project(carrier, {
    eventKey: carrier.columns.eventKey,
    rowCount: constant(0),
  });
  const membershipAncestors = options.includeMembershipAncestors
    ? (() => {
        const nullableCarrier = project(carrier, {
          eventKey: caseWhen([
            {
              when: eq(
                carrier.columns.eventSite,
                constant(`${domainId}-visit-0`),
              ),
              then: carrier.columns.eventKey,
            },
          ]),
          eventSite: carrier.columns.eventSite,
        });
        const roleUnion = union(carrier, nullableCarrier, true);
        const membershipRight = scan(schema.visits);
        const membershipCondition = and(
          eq(roleUnion.columns.eventKey, membershipRight.columns.site_id),
          eq(roleUnion.columns.eventSite, membershipRight.columns.visit_id),
          eq(membershipRight.columns.status, constant("complete")),
        );
        const semi = semiJoin(roleUnion, membershipRight, membershipCondition);
        const anti = antiJoin(roleUnion, membershipRight, membershipCondition);
        const membershipRows = union(semi, anti, true);
        const membershipBranch = project(membershipRows, {
          eventKey: constant("__membership__"),
          rowCount: constant(0),
        });
        return {
          roleUnion,
          semi,
          anti,
          semiKeys: project(semi, { eventKey: semi.columns.eventKey }),
          antiKeys: project(anti, { eventKey: anti.columns.eventKey }),
          membershipBranch,
        };
      })()
    : undefined;
  const controlBranch = project(control, {
    eventKey: constant("__control__"),
    rowCount: control.columns.rowCount,
  });
  const closureSeed = project(scopedRows, {
    closureKey: scopedRows.columns.site_id,
  });
  const closureCandidates = project(scopedRows, {
    closureKey: scopedRows.columns.site_id,
  });
  const closure = recursiveClosure(
    closureSeed,
    closureCandidates,
    (current, candidate) => eq(current.closureKey, candidate.closureKey),
  );
  const recursiveBranch = project(closure, {
    eventKey: constant("__recursive__"),
    rowCount: constant(0),
  });
  const factInput = membershipAncestors
    ? union(
        union(membershipAncestors.membershipBranch, admittedRowsBranch, true),
        union(controlBranch, recursiveBranch, true),
        true,
      )
    : union(
        union(
          union(fullRootBranch, validChildBranch, true),
          union(admittedRowsBranch, admittedCarrierBranch, true),
          true,
        ),
        union(controlBranch, recursiveBranch, true),
        true,
      );
  const owner = aggregate(factInput, {
    groupBy: {
      eventKey: factInput.columns.eventKey,
      kind: constant(1),
    },
    aggregates: { rowCount: count() },
  });
  const controlOutput = project(owner, {
    eventKey: owner.columns.eventKey,
    kind: owner.columns.kind,
    rowCount: owner.columns.rowCount,
  });
  const lookupRows = scan(schema.visits);
  const lookupKeys = project(lookupRows, {
    eventKey: lookupRows.columns.site_id,
    kind: constant(1),
  });
  const ownerLookup = join(
    lookupKeys,
    owner,
    and(
      eq(lookupKeys.columns.eventKey, owner.columns.eventKey),
      eq(lookupKeys.columns.kind, owner.columns.kind),
    ),
    "left",
  );
  const lookupOutput = project(ownerLookup, {
    eventKey: ownerLookup.columns.left_eventKey,
    kind: ownerLookup.columns.left_kind,
    rowCount: ownerLookup.columns.right_rowCount,
  });
  const root = union(controlOutput, limit(lookupOutput, 2), true);
  return {
    root,
    owner,
    bounded,
    counter,
    admittedRows,
    carrier,
    identityCarrier,
    rootStats,
    fullRootBranch,
    membershipAncestors,
  };
}

function analysisFor(graph: ReturnType<typeof fixture>) {
  const { nodes, incomingCounts, incoming } = graphAnalysis(graph.root.node);
  const boundedAdmissions = boundedAdmissionReuseCandidates({
    nodes,
    incomingCounts,
    incoming,
    maximumFields: 16,
    inspectLocalStableExpression: () => ({ valid: true, columns: [] }),
  });
  return {
    nodes,
    incomingCounts,
    incoming,
    boundedAdmissions,
    sharedBoundaries: new Set<LogicalQueryNode>([
      graph.bounded.node,
      graph.counter.node,
      graph.owner.node,
    ]),
  };
}

interface IndexedFactTarget {
  readonly table: SchemaObjectReference;
  readonly equalities: readonly [
    readonly ["eventPk" | "parentNodeId", string],
    readonly ["eventPk" | "parentNodeId", string],
  ];
}

function indexedFactFixture(
  domainId = "fact-local-indexed-site",
  indexedTarget?: IndexedFactTarget,
) {
  const visits = scan(schema.visits);
  const scopedVisits = filter(
    visits,
    eq(visits.columns.site_id, constant(domainId)),
  );
  const selectedVisits = project(scopedVisits, {
    eventKey: scopedVisits.columns.site_id,
    visitId: scopedVisits.columns.visit_id,
  });
  const bounded = limit(selectedVisits, 4);
  const counter = aggregate(bounded, {
    groupBy: {},
    aggregates: { rowCount: count() },
  });
  const admission = filter(counter, lte(counter.columns.rowCount, constant(3)));
  const globalTrue = eq(constant(1), constant(1));
  const admittedVisits = join(bounded, admission, globalTrue);

  const events = scan(schema.custom_events);
  const scopedEvents = filter(
    events,
    eq(events.columns.site_id, constant(domainId)),
  );
  const nodes = scan(schema.custom_event_json_nodes);
  const eventNodes = join(
    scopedEvents,
    nodes,
    eq(scopedEvents.columns.event_pk, nodes.columns.event_pk),
  );
  const admittedNodes = join(eventNodes, admission, globalTrue);
  const carrier = project(admittedNodes, {
    eventPk: admittedNodes.columns.left_right_event_pk,
    parentNodeId: admittedNodes.columns.left_right_parent_node_id,
    roleMarker: constant(1),
  });
  const makeIndexedBranch = (projectRight: boolean) => {
    if (indexedTarget) {
      const target = scan(indexedTarget.table as never);
      const targetColumns = target.columns as unknown as Record<
        string,
        typeof carrier.columns.eventPk
      >;
      const [firstEquality, secondEquality] = indexedTarget.equalities;
      const indexed = join(
        carrier,
        target,
        and(
          eq(
            carrier.columns[firstEquality[0]],
            targetColumns[firstEquality[1]]!,
          ),
          eq(
            carrier.columns[secondEquality[0]],
            targetColumns[secondEquality[1]]!,
          ),
        ),
      );
      return project(indexed, {
        eventKey: constant("__indexed__"),
        rowCount: constant(0),
      });
    }
    const children = scan(schema.custom_event_json_nodes);
    const projectedChildren = projectRight
      ? project(children, {
          parentNodeId: children.columns.parent_node_id,
          eventPk: children.columns.event_pk,
        })
      : undefined;
    if (projectedChildren) {
      const indexed = join(
        carrier,
        projectedChildren,
        and(
          eq(carrier.columns.eventPk, projectedChildren.columns.eventPk),
          eq(
            carrier.columns.parentNodeId,
            projectedChildren.columns.parentNodeId,
          ),
        ),
      );
      return project(indexed, {
        eventKey: constant("__indexed__"),
        rowCount: constant(0),
      });
    }
    const indexed = join(
      carrier,
      children,
      and(
        eq(carrier.columns.eventPk, children.columns.event_pk),
        eq(carrier.columns.parentNodeId, children.columns.parent_node_id),
      ),
    );
    return project(indexed, {
      eventKey: constant("__indexed__"),
      rowCount: constant(0),
    });
  };
  const first = makeIndexedBranch(false);
  const second = makeIndexedBranch(true);
  const admittedBranch = project(admittedVisits, {
    eventKey: admittedVisits.columns.left_eventKey,
    rowCount: constant(0),
  });
  const controlBranch = project(counter, {
    eventKey: constant("__control__"),
    rowCount: counter.columns.rowCount,
  });
  const closureSeed = project(scopedVisits, {
    closureKey: scopedVisits.columns.site_id,
  });
  const closureCandidates = project(scopedVisits, {
    closureKey: scopedVisits.columns.site_id,
  });
  const closure = recursiveClosure(
    closureSeed,
    closureCandidates,
    (current, candidate) => eq(current.closureKey, candidate.closureKey),
  );
  const recursiveBranch = project(closure, {
    eventKey: constant("__recursive__"),
    rowCount: constant(0),
  });
  const factInput = union(
    union(admittedBranch, union(first, second, true), true),
    union(controlBranch, recursiveBranch, true),
    true,
  );
  const owner = aggregate(factInput, {
    groupBy: {
      eventKey: factInput.columns.eventKey,
      kind: constant(1),
    },
    aggregates: { rowCount: count() },
  });
  const controlOutput = project(owner, {
    eventKey: owner.columns.eventKey,
    kind: owner.columns.kind,
    rowCount: owner.columns.rowCount,
  });
  const lookupRows = scan(schema.visits);
  const lookupKeys = project(lookupRows, {
    eventKey: lookupRows.columns.site_id,
    kind: constant(1),
  });
  const ownerLookup = join(
    lookupKeys,
    owner,
    and(
      eq(lookupKeys.columns.eventKey, owner.columns.eventKey),
      eq(lookupKeys.columns.kind, owner.columns.kind),
    ),
    "left",
  );
  const lookupOutput = project(ownerLookup, {
    eventKey: ownerLookup.columns.left_eventKey,
    kind: ownerLookup.columns.left_kind,
    rowCount: ownerLookup.columns.right_rowCount,
  });
  const root = union(controlOutput, limit(lookupOutput, 2), true);
  return { root, owner, bounded, counter, carrier, first, second };
}

function localCandidates(
  graph: ReturnType<typeof fixture>,
  overrides: {
    readonly incoming?: Map<LogicalQueryNode, BoundedAdmissionIncomingEdge[]>;
    readonly incomingCounts?: Map<LogicalQueryNode, number>;
    readonly sharedBoundaries?: ReadonlySet<LogicalQueryNode>;
  } = {},
) {
  const analysis = analysisFor(graph);
  return boundedFactLocalReuseCandidates({
    root: graph.root.node,
    nodes: analysis.nodes,
    incomingCounts: overrides.incomingCounts ?? analysis.incomingCounts,
    incoming: overrides.incoming ?? analysis.incoming,
    completeFacts: new Set([graph.owner.node]),
    boundedAdmissions: analysis.boundedAdmissions,
    sharedBoundaries: overrides.sharedBoundaries ?? analysis.sharedBoundaries,
    maximumFields: 16,
  });
}

function localCandidatesWithSyntheticAncestor(
  graph: ReturnType<typeof fixture>,
  ancestor: LogicalQueryNode,
) {
  const analysis = analysisFor(graph);
  const incoming = new Map(analysis.incoming);
  const candidateParents = [
    ...(incoming.get(graph.carrier.node) ?? []),
    { parent: ancestor, kind: "relation" as const },
  ];
  incoming.set(graph.carrier.node, candidateParents);
  incoming.set(ancestor, [{ parent: graph.owner.node, kind: "relation" }]);
  const incomingCounts = new Map(analysis.incomingCounts);
  incomingCounts.set(graph.carrier.node, candidateParents.length);
  incomingCounts.set(ancestor, 1);
  return localCandidates(graph, { incoming, incomingCounts });
}

function invalidAncestor(
  kind: "limit" | "window" | "sort" | "recursive-closure",
): LogicalQueryNode {
  return { kind } as LogicalQueryNode;
}

describe("bounded complete-fact local reuse", () => {
  it("reuses closed root stats only under one admitted complete fact", () => {
    const graph = fixture();
    const analysis = analysisFor(graph);
    const candidates = localCandidates(graph);

    expect(analysis.boundedAdmissions.has(graph.bounded.node)).toBe(true);
    expect(candidates.get(graph.rootStats.node)).toMatchObject({
      owner: graph.owner.node,
      candidateKind: "grouped-summary",
    });
    expect(candidates.get(graph.carrier.node)).toMatchObject({
      owner: graph.owner.node,
      candidateKind: "carrier",
    });
    expect(candidates.has(graph.identityCarrier.node)).toBe(false);
    expect(candidates.has(graph.fullRootBranch.node)).toBe(false);
  });

  it("materializes nested same-owner source and summary with SQLite bag equality", () => {
    const graph = fixture();
    const physical = lowerLogicalPlan(graph.root);
    const carrierDefinition = physical.sharedRelations.find(
      ({ node }) => node === graph.carrier.node,
    );
    const rootStatsDefinition = physical.sharedRelations.find(
      ({ node }) => node === graph.rootStats.node,
    );
    const identityCarrierDefinition = physical.sharedRelations.find(
      ({ node }) => node === graph.identityCarrier.node,
    );
    const ownerDefinition = physical.sharedRelations.find(
      ({ node }) => node === graph.owner.node,
    );

    expect(carrierDefinition?.materialization).toBe("materialized");
    expect(identityCarrierDefinition).toBeUndefined();
    expect(rootStatsDefinition?.materialization).toBe("materialized");
    expect(rootStatsDefinition?.dependencies).toContain(
      carrierDefinition?.name,
    );
    expect(ownerDefinition?.dependencies).toContain(rootStatsDefinition?.name);

    const db = database();
    seedDomain(db, "fact-local-site", 3);
    const optimized = compileD1Query(physical);
    const unoptimized = compileD1QueryUnoptimizedForTest(graph.root);
    const optimizedRows = runAll(db, optimized);
    const unoptimizedRows = runAll(db, unoptimized);
    expect(rowBag(optimizedRows)).toEqual(rowBag(unoptimizedRows));
    expect(optimizedRows.length).toBeGreaterThan(0);
  });

  it("drives a fact-local carrier into a matching composite index and preserves duplicate and NULL bags", () => {
    const domainId = "fact-local-indexed-site";
    const foreignDomainId = "fact-local-indexed-foreign";
    const graph = indexedFactFixture(domainId);
    const physical = lowerLogicalPlan(graph.root);
    const strategies = physical.joinOrderStrategies.filter(
      (strategy) => strategy.kind === "fact-local-indexed",
    );
    expect(strategies).toHaveLength(2);
    expect(strategies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "fact-local-indexed",
          driver: "left",
          tableName: "custom_event_json_nodes",
          indexName: "idx_custom_event_nodes_event_parent",
          owner: graph.owner.node,
          keyColumns: [
            { name: "event_pk", leftIndex: 0, rightIndex: 0 },
            { name: "parent_node_id", leftIndex: 1, rightIndex: 2 },
          ],
        }),
      ]),
    );
    const forged = {
      ...physical,
      joinOrderStrategies: physical.joinOrderStrategies.map((strategy) =>
        strategy.kind === "fact-local-indexed"
          ? { ...strategy, driver: "right", indexName: "forged-index" }
          : strategy,
      ),
    };
    expect(() => compileD1Query(forged as never)).toThrow(
      /join order strategies are inconsistent/u,
    );

    const db = database();
    seedDomain(db, domainId, 3);
    seedCustomEventTrees(db, domainId);
    seedDomain(db, foreignDomainId, 1);
    seedCustomEventTrees(db, foreignDomainId);
    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(graph.root);
    expect(optimized.physicalPlanShape).toMatchObject({
      version: 8,
      factLocalIndexedJoinStrategies: [
        {
          tableName: "custom_event_json_nodes",
          indexName: "idx_custom_event_nodes_event_parent",
          keyColumns: [
            { name: "event_pk", leftIndex: 0, rightIndex: 0 },
            { name: "parent_node_id", leftIndex: 1, rightIndex: 2 },
          ],
        },
        {
          tableName: "custom_event_json_nodes",
          indexName: "idx_custom_event_nodes_event_parent",
          keyColumns: [
            { name: "event_pk", leftIndex: 0, rightIndex: 1 },
            { name: "parent_node_id", leftIndex: 1, rightIndex: 0 },
          ],
        },
      ],
    });
    const optimizedRows = runAll(db, optimized);
    expect(rowBag(optimizedRows)).toEqual(rowBag(runAll(db, mechanical)));
    expect(optimizedRows).toContainEqual({
      eventKey: "__indexed__",
      kind: 1,
      rowCount: 24,
    });
    const planRows = db
      .prepare(`EXPLAIN QUERY PLAN ${optimized.sql}`)
      .all(...((optimized.bindings ?? []) as SQLInputValue[])) as {
      readonly detail: string;
    }[];
    expect(
      planRows.filter(({ detail }) =>
        /USING (?:COVERING )?INDEX idx_custom_event_nodes_event_parent \(event_pk=\? AND parent_node_id=\?\)/u.test(
          detail,
        ),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps an empty site-local carrier empty when other sites have indexed rows", () => {
    const domainId = "fact-local-indexed-empty";
    const foreignDomainId = "fact-local-indexed-empty-foreign";
    const graph = indexedFactFixture(domainId);
    const physical = lowerLogicalPlan(graph.root);
    expect(
      physical.joinOrderStrategies.filter(
        (strategy) => strategy.kind === "fact-local-indexed",
      ),
    ).toHaveLength(2);

    const db = database();
    seedDomain(db, domainId, 2);
    seedDomain(db, foreignDomainId, 1);
    seedCustomEventTrees(db, foreignDomainId);
    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(graph.root);
    const optimizedRows = runAll(db, optimized);
    expect(rowBag(optimizedRows)).toEqual(rowBag(runAll(db, mechanical)));
    expect(optimizedRows).not.toContainEqual(
      expect.objectContaining({ eventKey: "__indexed__" }),
    );
  });

  it("rejects a real SQLite Unicode lookalike index prefix", () => {
    const db = database();
    db.exec(`
      CREATE TABLE unicode_prefix_target (
        "K" INTEGER NOT NULL,
        "K" INTEGER NOT NULL,
        b INTEGER NOT NULL
      );
      CREATE INDEX idx_unicode_lookalike_prefix
        ON unicode_prefix_target ("K", b);
    `);
    const target = introspectedTableReference(db, "unicode_prefix_target");
    const targetColumns = Object.values(target.columns).map(
      ({ sqlName }) => sqlName,
    );
    const targetIndex = target.indexes.find(
      ({ name }) => name === "idx_unicode_lookalike_prefix",
    );
    expect(targetColumns).toEqual(["K", "K", "b"]);
    expect(targetIndex?.columns).toEqual(["K", "b"]);

    const graph = indexedFactFixture("unicode-prefix-reject", {
      table: target,
      equalities: [
        ["eventPk", "K"],
        ["parentNodeId", "b"],
      ],
    });
    expect(
      lowerLogicalPlan(graph.root).joinOrderStrategies.filter(
        (strategy) => strategy.kind === "fact-local-indexed",
      ),
    ).toEqual([]);
  });

  it("keeps ASCII prefixes and distinct SQLite K and Kelvin-sign keys eligible", () => {
    const db = database();
    db.exec(`
      CREATE TABLE ascii_prefix_target (
        "K" INTEGER NOT NULL,
        b INTEGER NOT NULL
      );
      CREATE INDEX idx_ascii_prefix ON ascii_prefix_target ("K", b);
      CREATE TABLE unicode_distinct_target (
        "K" INTEGER NOT NULL,
        "K" INTEGER NOT NULL,
        b INTEGER NOT NULL
      );
      CREATE INDEX idx_unicode_distinct_prefix
        ON unicode_distinct_target ("K", "K");
    `);

    const asciiTarget = introspectedTableReference(db, "ascii_prefix_target");
    const asciiGraph = indexedFactFixture("ascii-prefix-positive", {
      table: asciiTarget,
      equalities: [
        ["eventPk", "K"],
        ["parentNodeId", "b"],
      ],
    });
    const asciiStrategies = lowerLogicalPlan(
      asciiGraph.root,
    ).joinOrderStrategies.filter(
      (strategy) => strategy.kind === "fact-local-indexed",
    );
    expect(asciiStrategies).toHaveLength(2);
    expect(
      asciiStrategies.every(
        ({ indexName }) => indexName === "idx_ascii_prefix",
      ),
    ).toBe(true);

    const unicodeTarget = introspectedTableReference(
      db,
      "unicode_distinct_target",
    );
    expect(
      unicodeTarget.indexes.find(
        ({ name }) => name === "idx_unicode_distinct_prefix",
      )?.columns,
    ).toEqual(["K", "K"]);
    const unicodeGraph = indexedFactFixture("unicode-distinct-positive", {
      table: unicodeTarget,
      equalities: [
        ["eventPk", "K"],
        ["parentNodeId", "K"],
      ],
    });
    const unicodeStrategies = lowerLogicalPlan(
      unicodeGraph.root,
    ).joinOrderStrategies.filter(
      (strategy) => strategy.kind === "fact-local-indexed",
    );
    expect(unicodeStrategies).toHaveLength(2);
    expect(
      unicodeStrategies.every(
        ({ indexName }) => indexName === "idx_unicode_distinct_prefix",
      ),
    ).toBe(true);
  });

  it.each(["incomplete key", "residual predicate"] as const)(
    "rejects a fact-local indexed join with an %s",
    (mode) => {
      const graph = indexedFactFixture("fact-local-indexed-equality-reject");
      for (const branch of [graph.first, graph.second]) {
        if (
          branch.node.kind !== "project" ||
          branch.node.input.node.kind !== "join"
        )
          throw new Error("indexed_join_fixture_invalid");
        const joinNode = branch.node.input.node;
        const original = joinNode.condition;
        if (original.kind !== "boolean" || original.operator !== "AND")
          throw new Error("indexed_join_condition_invalid");
        const condition =
          mode === "incomplete key"
            ? original.expressions[0]!
            : and(
                original,
                gt(graph.carrier.columns.parentNodeId, constant(0)),
              );
        Object.assign(joinNode, { condition });
      }
      expect(
        lowerLogicalPlan(graph.root).joinOrderStrategies.filter(
          (strategy) => strategy.kind === "fact-local-indexed",
        ),
      ).toEqual([]);
    },
  );

  it.each([
    [
      "index collation mismatch",
      (index: (typeof schema.custom_event_json_nodes.indexes)[number]) => ({
        ...index,
        collations: index.collations?.map((_value, index) =>
          index === 1 ? "NOCASE" : "BINARY",
        ),
      }),
    ],
    [
      "unknown index collation",
      (index: (typeof schema.custom_event_json_nodes.indexes)[number]) => ({
        ...index,
        collations: index.collations?.map(() => null),
      }),
    ],
    [
      "partial index",
      (index: (typeof schema.custom_event_json_nodes.indexes)[number]) => ({
        ...index,
        partial: true,
      }),
    ],
    [
      "expression index",
      (index: (typeof schema.custom_event_json_nodes.indexes)[number]) => ({
        ...index,
        rawExpressionSql: "parent_node_id + 0",
      }),
    ],
    [
      "unknown table collation",
      (index: (typeof schema.custom_event_json_nodes.indexes)[number]) => index,
    ],
  ])("rejects a fact-local lookup with %s", (_label, alterIndex) => {
    const graph = indexedFactFixture("fact-local-indexed-reject");
    const table = schema.custom_event_json_nodes;
    const originalIndexes = table.indexes;
    const originalCollation = table.defaultCollation;
    if (_label === "unknown table collation")
      Object.assign(table, { defaultCollation: "unknown" });
    Object.assign(table, {
      indexes: originalIndexes.map((index) =>
        index.name === "idx_custom_event_nodes_event_parent"
          ? alterIndex(index)
          : index,
      ),
    });
    try {
      expect(
        lowerLogicalPlan(graph.root).joinOrderStrategies.filter(
          (strategy) => strategy.kind === "fact-local-indexed",
        ),
      ).toEqual([]);
    } finally {
      Object.assign(table, { indexes: originalIndexes });
      Object.assign(table, { defaultCollation: originalCollation });
    }
  });

  it("reuses through widened UNION ALL and closed semi/anti ancestors with SQLite bag equality", () => {
    const domainId = "fact-local-membership";
    const graph = fixture(domainId, { includeMembershipAncestors: true });
    const membership = graph.membershipAncestors;
    if (!membership) throw new Error("membership_fixture_missing");
    const roleUnionNode = membership.roleUnion.node;
    if (roleUnionNode.kind !== "union")
      throw new Error("membership_union_fixture_invalid");
    const unionEventKey = membership.roleUnion.fields.find(
      ({ name }) => name === "eventKey",
    );
    const unionLeftEventKey = roleUnionNode.left.fields.find(
      ({ name }) => name === "eventKey",
    );
    const unionRightEventKey = roleUnionNode.right.fields.find(
      ({ name }) => name === "eventKey",
    );

    expect(unionLeftEventKey?.nullable).toBe(false);
    expect(unionRightEventKey?.nullable).toBe(true);
    expect(unionEventKey?.nullable).toBe(true);
    expect(localCandidates(graph).get(graph.carrier.node)).toMatchObject({
      owner: graph.owner.node,
      candidateKind: "carrier",
    });

    const physical = lowerLogicalPlan(graph.root);
    const carrierDefinition = physical.sharedRelations.find(
      ({ node }) => node === graph.carrier.node,
    );
    expect(carrierDefinition?.materialization).toBe("materialized");

    const db = database();
    seedDomain(db, domainId, 3);
    const optimizedRoot = compileD1Query(physical);
    const unoptimizedRoot = compileD1QueryUnoptimizedForTest(graph.root);
    const optimizedRootRows = runAll(db, optimizedRoot);
    const unoptimizedRootRows = runAll(db, unoptimizedRoot);
    expect(rowBag(optimizedRootRows)).toEqual(rowBag(unoptimizedRootRows));

    const semi = compileD1Query(lowerLogicalPlan(membership.semiKeys));
    const unoptimizedSemi = compileD1QueryUnoptimizedForTest(
      membership.semiKeys,
    );
    const semiRows = runAll(db, semi);
    expect(rowBag(semiRows)).toEqual(rowBag(runAll(db, unoptimizedSemi)));
    expect(semiRows.map(({ eventKey }) => eventKey)).toEqual(
      Array.from({ length: 4 }, () => domainId),
    );

    const anti = compileD1Query(lowerLogicalPlan(membership.antiKeys));
    const unoptimizedAnti = compileD1QueryUnoptimizedForTest(
      membership.antiKeys,
    );
    const antiRows = runAll(db, anti);
    expect(rowBag(antiRows)).toEqual(rowBag(runAll(db, unoptimizedAnti)));
    expect(antiRows.map(({ eventKey }) => eventKey)).toEqual([null, null]);
  });

  it("rejects UNION DISTINCT and incorrect widened output fields", () => {
    const graph = fixture();
    const nullableCarrier = project(graph.carrier, {
      eventKey: caseWhen([
        {
          when: eq(
            graph.carrier.columns.eventSite,
            constant("fact-local-site-visit-0"),
          ),
          then: graph.carrier.columns.eventKey,
        },
      ]),
      eventSite: graph.carrier.columns.eventSite,
    });
    const distinctUnion = union(graph.carrier, nullableCarrier, false);
    expect(
      localCandidatesWithSyntheticAncestor(graph, distinctUnion.node).has(
        graph.carrier.node,
      ),
    ).toBe(false);

    const malformedUnion = union(graph.carrier, nullableCarrier, true).node;
    const validFields = malformedUnion.fields;
    const badAlias = validFields.map((field, index) =>
      index === 0 ? { ...field, name: "wrongEventKey" } : field,
    );
    Object.assign(malformedUnion, { fields: badAlias });
    expect(
      localCandidatesWithSyntheticAncestor(graph, malformedUnion).has(
        graph.carrier.node,
      ),
    ).toBe(false);

    const unknownAffinityUnion = union(
      graph.carrier,
      nullableCarrier,
      true,
    ).node;
    Object.assign(unknownAffinityUnion, {
      fields: unknownAffinityUnion.fields.map((field, index) =>
        index === 0 ? { ...field, affinity: "unknown" as const } : field,
      ),
    });
    expect(
      localCandidatesWithSyntheticAncestor(graph, unknownAffinityUnion).has(
        graph.carrier.node,
      ),
    ).toBe(false);

    const wrongNullabilityUnion = union(
      graph.carrier,
      nullableCarrier,
      true,
    ).node;
    Object.assign(wrongNullabilityUnion, {
      fields: wrongNullabilityUnion.fields.map((field, index) =>
        index === 0 ? { ...field, nullable: false } : field,
      ),
    });
    expect(
      localCandidatesWithSyntheticAncestor(graph, wrongNullabilityUnion).has(
        graph.carrier.node,
      ),
    ).toBe(false);
  });

  it("accepts UNION ALL with both nullable states and either branch order", () => {
    const graph = fixture();
    const nullableCarrier = project(graph.carrier, {
      eventKey: caseWhen([
        {
          when: eq(
            graph.carrier.columns.eventSite,
            constant("fact-local-site-visit-0"),
          ),
          then: graph.carrier.columns.eventKey,
        },
      ]),
      eventSite: graph.carrier.columns.eventSite,
    });
    const unions = [
      union(graph.carrier, graph.carrier, true),
      union(nullableCarrier, nullableCarrier, true),
      union(nullableCarrier, graph.carrier, true),
    ];

    for (const ancestor of unions)
      expect(
        localCandidatesWithSyntheticAncestor(graph, ancestor.node).has(
          graph.carrier.node,
        ),
      ).toBe(true);
  });

  it("admits only independently closed, exact-schema membership ancestors", () => {
    const graph = fixture();
    const right = scan(schema.visits);
    const validSemi = semiJoin(
      graph.carrier,
      right,
      and(
        eq(graph.carrier.columns.eventKey, right.columns.site_id),
        eq(right.columns.status, constant("complete")),
      ),
    );
    expect(
      localCandidatesWithSyntheticAncestor(graph, validSemi.node).has(
        graph.carrier.node,
      ),
    ).toBe(true);

    const volatileSemi = semiJoin(
      graph.carrier,
      right,
      eq(unixepoch(), constant(0)),
    );
    expect(
      localCandidatesWithSyntheticAncestor(graph, volatileSemi.node).has(
        graph.carrier.node,
      ),
    ).toBe(false);

    const external = scan(schema.visits);
    const correlatedSemi = semiJoin(
      graph.carrier,
      right,
      and(
        eq(graph.carrier.columns.eventKey, right.columns.site_id),
        eq(external.columns.status, constant("complete")),
      ),
    );
    expect(
      localCandidatesWithSyntheticAncestor(graph, correlatedSemi.node).has(
        graph.carrier.node,
      ),
    ).toBe(false);

    const expressionQuerySemi = semiJoin(
      graph.carrier,
      right,
      inSubquery(
        graph.carrier.columns.eventKey,
        project(right, { onlySite: right.columns.site_id }),
      ),
    );
    expect(
      localCandidatesWithSyntheticAncestor(graph, expressionQuerySemi.node).has(
        graph.carrier.node,
      ),
    ).toBe(false);

    const throwingSemi = semiJoin(
      graph.carrier,
      right,
      and(
        eq(graph.carrier.columns.eventKey, right.columns.site_id),
        eq(callFunction("abs", constant(-1)), constant(1)),
      ),
    );
    expect(
      localCandidatesWithSyntheticAncestor(graph, throwingSemi.node).has(
        graph.carrier.node,
      ),
    ).toBe(false);

    const wrongSchemaSemi = semiJoin(
      graph.carrier,
      right,
      eq(graph.carrier.columns.eventKey, right.columns.site_id),
    ).node;
    Object.assign(wrongSchemaSemi, {
      fields: [...wrongSchemaSemi.fields, ...right.fields.slice(0, 1)],
    });
    expect(
      localCandidatesWithSyntheticAncestor(graph, wrongSchemaSemi).has(
        graph.carrier.node,
      ),
    ).toBe(false);
  });

  it("rejects a nested candidate whose paths split across complete-fact owners", () => {
    const graph = fixture();
    const analysis = analysisFor(graph);
    const candidates = boundedFactLocalReuseCandidates({
      root: graph.root.node,
      nodes: analysis.nodes,
      incomingCounts: analysis.incomingCounts,
      incoming: analysis.incoming,
      completeFacts: new Set([graph.owner.node, graph.rootStats.node]),
      boundedAdmissions: analysis.boundedAdmissions,
      sharedBoundaries: analysis.sharedBoundaries,
      maximumFields: 16,
    });

    expect(candidates.get(graph.rootStats.node)?.owner).toBe(graph.owner.node);
    expect(candidates.has(graph.carrier.node)).toBe(false);
  });

  it("rejects forged cross-owner nested dependencies in a physical plan", () => {
    const first = fixture("fact-local-site-a");
    const second = fixture("fact-local-site-b");
    const combined = union(first.root, second.root, true);
    const physical = lowerLogicalPlan(combined);
    const firstStats = physical.sharedRelations.find(
      ({ node }) => node === first.rootStats.node,
    );
    const secondStats = physical.sharedRelations.find(
      ({ node }) => node === second.rootStats.node,
    );
    if (!firstStats || !secondStats)
      throw new Error("nested_local_summary_definitions_missing");

    const forged = {
      ...physical,
      sharedRelations: physical.sharedRelations.map((definition) =>
        definition.node === first.rootStats.node
          ? {
              ...definition,
              dependencies: [...definition.dependencies, secondStats.name],
            }
          : definition,
      ),
    };
    expect(() => compileD1Query(forged)).toThrow();
  });

  it("rejects a third external consumer and a different shared owner path", () => {
    const graph = fixture();
    const analysis = analysisFor(graph);
    const externalIncoming = new Map(analysis.incoming);
    externalIncoming.set(graph.rootStats.node, [
      ...(externalIncoming.get(graph.rootStats.node) ?? []),
      { parent: graph.root.node, kind: "relation" },
    ]);
    const externalCounts = new Map(analysis.incomingCounts);
    externalCounts.set(
      graph.rootStats.node,
      (externalCounts.get(graph.rootStats.node) ?? 0) + 1,
    );
    expect(
      localCandidates(graph, {
        incoming: externalIncoming,
        incomingCounts: externalCounts,
      }).has(graph.rootStats.node),
    ).toBe(false);

    const anotherOwnerPath = new Set<LogicalQueryNode>([
      ...analysis.sharedBoundaries,
      graph.fullRootBranch.node,
    ]);
    expect(
      localCandidates(graph, { sharedBoundaries: anotherOwnerPath }).has(
        graph.rootStats.node,
      ),
    ).toBe(false);
  });

  it.each(["limit", "window", "sort", "recursive-closure"] as const)(
    "rejects a consumer path crossing %s",
    (kind) => {
      const graph = fixture();
      const analysis = analysisFor(graph);
      const blockedParent = invalidAncestor(kind);
      const incoming = new Map(analysis.incoming);
      incoming.set(graph.fullRootBranch.node, [
        ...(incoming.get(graph.fullRootBranch.node) ?? []),
        { parent: blockedParent, kind: "relation" },
      ]);
      incoming.set(blockedParent, [
        { parent: graph.owner.node, kind: "relation" },
      ]);
      expect(
        localCandidates(graph, { incoming }).has(graph.rootStats.node),
      ).toBe(false);
    },
  );

  it("rejects expression-edge consumers, unsafe ABS, and missing admission evidence", () => {
    const graph = fixture();
    const analysis = analysisFor(graph);
    const expressionIncoming = new Map(analysis.incoming);
    expressionIncoming.set(graph.rootStats.node, [
      ...(expressionIncoming.get(graph.rootStats.node) ?? []),
      { parent: graph.owner.node, kind: "expression" },
    ]);
    const expressionCounts = new Map(analysis.incomingCounts);
    expressionCounts.set(
      graph.rootStats.node,
      (expressionCounts.get(graph.rootStats.node) ?? 0) + 1,
    );
    expect(
      localCandidates(graph, {
        incoming: expressionIncoming,
        incomingCounts: expressionCounts,
      }).has(graph.rootStats.node),
    ).toBe(false);

    const rootStats = graph.rootStats.node;
    if (rootStats.kind !== "aggregate")
      throw new Error("root_stats_fixture_not_aggregate");
    Object.assign(rootStats, {
      groups: rootStats.groups.map((group, index) =>
        index === 0
          ? {
              ...group,
              expression: callFunction("abs", group.expression as never),
            }
          : group,
      ),
    });
    expect(localCandidates(graph).has(rootStats)).toBe(false);

    const withoutAdmission = boundedFactLocalReuseCandidates({
      root: graph.root.node,
      nodes: analysis.nodes,
      incomingCounts: analysis.incomingCounts,
      incoming: analysis.incoming,
      completeFacts: new Set([graph.owner.node]),
      boundedAdmissions: new Map(),
      sharedBoundaries: analysis.sharedBoundaries,
      maximumFields: 16,
    });
    expect(withoutAdmission.has(rootStats)).toBe(false);
  });
});
