import { describe, expect, it } from "vitest";

import { eq, filter, inSubquery, param, project, scan, union } from "@/lib/db";
import {
  buildPhysicalParentIndex,
  collectPhysicalSubtreeNodes,
  deduplicateDependencies,
  samePhysicalDistinctUnionConsumerCertificate,
  samePhysicalSingletonRankBoundaryDependencies,
} from "@/lib/db/query/physical/consumer-equivalence";
import type { LogicalQueryNode } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

type Certificate = Parameters<
  typeof samePhysicalDistinctUnionConsumerCertificate
>[0];
type Dependency = Parameters<typeof deduplicateDependencies>[0][number];

const nodeA = scan(schema.site_identities).node;
const nodeB = scan(schema.site_identities).node;
const nodeC = scan(schema.site_identities).node;

function origin(scanNode: LogicalQueryNode = nodeA, columnName = "site_pk") {
  return {
    scan: scanNode,
    tableName: "site_identities",
    columnName,
    affinity: "integer",
    collation: "BINARY",
  };
}

function certificate(): Certificate {
  return {
    union: nodeA,
    representationLaw: "binary-integer",
    fields: [
      {
        index: 0,
        name: "site_pk",
        affinity: "integer",
        leftOrigin: origin(nodeA),
        rightOrigin: origin(nodeB),
      },
    ],
    consumerEdges: [
      { parent: nodeA, child: nodeB, via: "input", phase: "union" },
    ],
    joinEqualities: [
      {
        join: nodeC,
        equalities: [
          {
            leftIndex: 0,
            rightIndex: 1,
            affinity: "integer",
            leftOrigin: origin(nodeA),
          },
        ],
      },
    ],
    droppedBy: [nodeB],
  } as unknown as Certificate;
}

function mutate(change: (value: Record<string, any>) => void): Certificate {
  const clone = certificate() as unknown as Record<string, any>;
  change(clone);
  return clone as unknown as Certificate;
}

describe("distinct union consumer certificate comparison", () => {
  it("accepts an identical certificate and rejects each forged component", () => {
    expect(
      samePhysicalDistinctUnionConsumerCertificate(
        certificate(),
        certificate(),
      ),
    ).toBe(true);
    const forgeries: Array<(value: Record<string, any>) => void> = [
      (value) => (value.union = nodeB),
      (value) => (value.representationLaw = "other"),
      (value) => value.fields.push(value.fields[0]),
      (value) => (value.fields[0].index = 3),
      (value) => (value.fields[0].name = "renamed"),
      (value) => (value.fields[0].affinity = "text"),
      (value) => (value.fields[0].leftOrigin.scan = nodeC),
      (value) => (value.fields[0].leftOrigin.tableName = "other"),
      (value) => (value.fields[0].leftOrigin.columnName = "other"),
      (value) => (value.fields[0].leftOrigin.affinity = "text"),
      (value) => (value.fields[0].leftOrigin.collation = "NOCASE"),
      (value) => (value.fields[0].rightOrigin.scan = nodeC),
      (value) => (value.fields[0].rightOrigin.tableName = "other"),
      (value) => (value.fields[0].rightOrigin.columnName = "other"),
      (value) => (value.fields[0].rightOrigin.affinity = "text"),
      (value) => (value.fields[0].rightOrigin.collation = "NOCASE"),
      (value) => value.consumerEdges.push(value.consumerEdges[0]),
      (value) => (value.consumerEdges[0].parent = nodeC),
      (value) => (value.consumerEdges[0].child = nodeC),
      (value) => (value.consumerEdges[0].via = "left"),
      (value) => (value.consumerEdges[0].phase = "join"),
      (value) => value.joinEqualities.push(value.joinEqualities[0]),
      (value) => (value.joinEqualities[0].join = nodeA),
      (value) => value.joinEqualities[0].equalities.push({}),
      (value) => (value.joinEqualities[0].equalities[0].leftIndex = 9),
      (value) => (value.joinEqualities[0].equalities[0].rightIndex = 9),
      (value) => (value.joinEqualities[0].equalities[0].affinity = "text"),
      (value) =>
        (value.joinEqualities[0].equalities[0].leftOrigin.scan = nodeC),
      (value) =>
        (value.joinEqualities[0].equalities[0].leftOrigin.tableName = "other"),
      (value) =>
        (value.joinEqualities[0].equalities[0].leftOrigin.columnName = "other"),
      (value) =>
        (value.joinEqualities[0].equalities[0].leftOrigin.affinity = "text"),
      (value) =>
        (value.joinEqualities[0].equalities[0].leftOrigin.collation = "NOCASE"),
      (value) => value.droppedBy.push(nodeC),
      (value) => (value.droppedBy[0] = nodeC),
    ];
    for (const [index, forge] of forgeries.entries())
      expect(
        samePhysicalDistinctUnionConsumerCertificate(
          mutate(forge),
          certificate(),
        ),
        `forgery ${index}`,
      ).toBe(false);
    // Shortened actual arrays are rejected from either direction.
    expect(
      samePhysicalDistinctUnionConsumerCertificate(
        certificate(),
        mutate((value) => value.fields.push(value.fields[0])),
      ),
    ).toBe(false);
  });
});

describe("singleton rank dependency helpers", () => {
  const dependency = (
    overrides: Partial<Record<string, unknown>> = {},
  ): Dependency =>
    ({
      node: nodeA,
      definitionName: "shared_0",
      producerIndex: 0,
      consumerProducer: nodeB,
      consumerProducerIndex: 1,
      ...overrides,
    }) as unknown as Dependency;

  it("compares dependencies field by field", () => {
    expect(
      samePhysicalSingletonRankBoundaryDependencies(
        [dependency()],
        [dependency()],
      ),
    ).toBe(true);
    for (const override of [
      { node: nodeC },
      { definitionName: "other" },
      { producerIndex: 4 },
      { consumerProducer: nodeC },
      { consumerProducerIndex: 7 },
    ])
      expect(
        samePhysicalSingletonRankBoundaryDependencies(
          [dependency(override)],
          [dependency()],
        ),
      ).toBe(false);
    expect(
      samePhysicalSingletonRankBoundaryDependencies([], [dependency()]),
    ).toBe(false);
  });

  it("deduplicates by definition and producer, ordering deterministically", () => {
    const result = deduplicateDependencies([
      dependency({ definitionName: "b", producerIndex: 2 }),
      dependency({ definitionName: "a", producerIndex: 2 }),
      dependency({ definitionName: "a", producerIndex: 2, node: nodeC }),
      dependency({ definitionName: "z", producerIndex: 0 }),
      dependency({
        definitionName: "a",
        producerIndex: 2,
        consumerProducerIndex: 5,
      }),
    ]);
    expect(
      result.map(
        ({ definitionName, producerIndex, consumerProducerIndex }) =>
          `${definitionName}:${producerIndex}:${consumerProducerIndex}`,
      ),
    ).toEqual(["z:0:1", "a:2:1", "a:2:5", "b:2:1"]);
    expect(
      result.find(({ definitionName }) => definitionName === "a")?.node,
    ).toBe(nodeA);
  });
});

describe("physical subtree traversal", () => {
  it("collects relation children and expression subqueries once", () => {
    const users = scan(schema.users);
    const members = scan(schema.users);
    const memberIds = project(members, { id: members.columns.id });
    const selected = filter(users, inSubquery(users.columns.id, memberIds));
    const all = union(
      project(selected, { id: selected.columns.id }),
      project(selected, { id: selected.columns.id }),
      true,
    );
    const nodes = collectPhysicalSubtreeNodes(all.node);
    expect(nodes.has(all.node)).toBe(true);
    expect(nodes.has(memberIds.node)).toBe(true);
    expect(nodes.has(members.node)).toBe(true);
    // Shared children are visited once.
    expect([...nodes].filter((node) => node === selected.node)).toHaveLength(1);
    const index = buildPhysicalParentIndex(all.node);
    expect(index.incoming.get(memberIds.node)?.[0]).toMatchObject({
      parent: selected.node,
      kind: "expression-query",
    });
    expect(index.incoming.get(selected.node)).toHaveLength(2);
  });

  it("reports cyclic relations instead of recursing forever", () => {
    const users = scan(schema.users);
    const selected = filter(users, eq(users.columns.id, param("u")));
    const node = selected.node as unknown as { input: unknown };
    const original = node.input;
    node.input = {
      node: selected.node,
      scope: selected.scope,
      fields: selected.fields,
    };
    try {
      expect(() => collectPhysicalSubtreeNodes(selected.node)).toThrowError(
        "physical_relation_cycle",
      );
    } finally {
      node.input = original;
    }
  });
});
