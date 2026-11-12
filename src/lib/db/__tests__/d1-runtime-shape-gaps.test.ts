import { describe, expect, it, vi } from "vitest";

import {
  createDatabaseRuntime,
  type DatabasePhysicalPlanShape,
  type DatabaseQueryObservation,
  type DatabaseQueryObserver,
} from "@/lib/db";

function createDatabase() {
  const result = {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 1,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0,
    },
    results: [{ value: 1 }],
  } satisfies D1Result<{ value: number }>;
  const prepared = {
    bind: vi.fn(() => prepared),
    all: vi.fn(async () => result),
    first: vi.fn(async () => ({ value: 1 })),
    run: vi.fn(async () => result),
  };
  const database = {
    prepare: vi.fn(() => prepared),
    batch: vi.fn(async (statements: unknown[]) => statements.map(() => result)),
    exec: vi.fn(async () => ({ count: 1, duration: 0 })),
  } as unknown as D1Database;
  return { database, prepared };
}

function observer(
  events: DatabaseQueryObservation[],
  indexes: (count: number) => number[],
): DatabaseQueryObserver {
  return {
    begin({ operation, statementCount }) {
      return {
        statementIndexes: indexes(statementCount),
        includeBatchSummary: operation === "batch",
        record(event) {
          events.push(event);
        },
        release() {},
      };
    },
  };
}

async function hashOf(
  shape: unknown,
  sql = "SELECT ?",
): Promise<string | null> {
  const events: DatabaseQueryObservation[] = [];
  const { database } = createDatabase();
  const runtime = createDatabaseRuntime(database, {
    observer: observer(events, () => [0]),
  });
  await runtime.all({
    sql,
    bindings: ["private-value"],
    physicalPlanShape: shape as DatabasePhysicalPlanShape,
  });
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(JSON.stringify(events)).not.toContain("private-value");
  return events[0]?.physicalPlanHash ?? null;
}

const factLocal = [
  {
    tableName: "visits",
    indexName: "idx_visits_a_b",
    keyColumns: [
      { name: "site_pk", leftIndex: 0, rightIndex: 0 },
      { name: "hour", leftIndex: 1, rightIndex: 1 },
    ],
  },
];
const conditional = [
  {
    tableName: "archive_objects",
    indexName: "idx_archive_objects_site_pk_hour",
    keyColumns: [
      { name: "site_pk", leftIndex: 10, rightIndex: 10 },
      { name: "start_hour", leftIndex: 2, rightIndex: 2 },
    ],
    selectedKey: { name: "site_pk", leftIndex: 10, rightIndex: 10 },
    guardConjunctCount: 1,
  },
];
const pipeline = [
  {
    nodeKinds: ["filter", "project"],
    outputColumnIndexes: [0, 1],
    filterColumnIndexes: [[0]],
  },
];
const lexicographic = [{ direction: ">", componentCount: 2, emissionCount: 1 }];

const base: Record<string, unknown> = {
  factLocalIndexedJoinStrategies: factLocal,
  conditionalLookupCount: 1,
  conditionalLookupStrategies: conditional,
  selfMembershipCount: 1,
  rowPipelineChoices: pipeline,
  lexicographicComparisonCount: 1,
  lexicographicComparisons: lexicographic,
  semiMembershipCount: 1,
  semiMemberships: [{ keyCount: 1, emissionCount: 1 }],
};

const fieldsByVersion: Record<number, string[]> = {
  6: [
    "factLocalIndexedJoinStrategies",
    "conditionalLookupCount",
    "conditionalLookupStrategies",
  ],
  7: [
    "factLocalIndexedJoinStrategies",
    "conditionalLookupCount",
    "conditionalLookupStrategies",
    "selfMembershipCount",
  ],
  8: [
    "factLocalIndexedJoinStrategies",
    "conditionalLookupCount",
    "conditionalLookupStrategies",
    "selfMembershipCount",
    "rowPipelineChoices",
  ],
  9: [
    "factLocalIndexedJoinStrategies",
    "conditionalLookupCount",
    "conditionalLookupStrategies",
    "selfMembershipCount",
    "rowPipelineChoices",
    "lexicographicComparisonCount",
    "lexicographicComparisons",
  ],
  10: Object.keys(base),
};

function shapeFor(version: number): Record<string, unknown> {
  const picked: Record<string, unknown> = {
    version,
    cteCount: 1,
    directScanProjectionCount: 1,
    nativeMembershipCount: 0,
    jsonMembershipCount: 0,
    nativeRowRelationCount: 0,
    jsonRowRelationCount: 0,
    rightAnchorJoinOrderCount: 1,
    uniqueLookupJoinOrderCount: 0,
  };
  for (const key of fieldsByVersion[version]!) picked[key] = base[key];
  return picked;
}

describe("physical shape hashing for legacy versions with populated strategies", () => {
  it.each([6, 7, 8, 9, 10])(
    "hashes populated v%i strategies and distinguishes their content",
    async (version) => {
      const shape = shapeFor(version);
      const hash = await hashOf(shape);
      expect(hash).toMatch(new RegExp(`^v${version}:[0-9a-f]+$`, "u"));
      expect(await hashOf(shape)).toBe(hash);
      expect(await hashOf(shape, "SELECT ? AS other")).not.toBe(hash);
      expect(
        await hashOf({
          ...shape,
          factLocalIndexedJoinStrategies: [
            { ...factLocal[0]!, indexName: "idx_visits_other" },
          ],
        }),
      ).not.toBe(hash);
      expect(
        await hashOf({
          ...shape,
          conditionalLookupStrategies: [
            { ...conditional[0]!, guardConjunctCount: 2 },
          ],
        }),
      ).not.toBe(hash);
      if (version >= 8)
        expect(
          await hashOf({
            ...shape,
            rowPipelineChoices: [
              { ...pipeline[0]!, outputColumnIndexes: [0, 1, 2] },
            ],
          }),
        ).not.toBe(hash);
    },
  );

  it("hashes populated v11, v12 and v13 shapes through the v10 payload", async () => {
    const v11 = {
      ...shapeFor(10),
      version: 11,
      singletonRankFusionCount: 1,
      singletonRankFusions: [
        {
          partitionFieldCount: 1,
          keyFieldCount: 1,
          consumerCertificateCount: 0,
          emissionCount: 1,
          distinct: true,
        },
      ],
    };
    const v12 = {
      ...shapeFor(10),
      version: 12,
      singletonRankFusionCount: 0,
      singletonRankFusions: [],
      nativeNullOrderingCount: 1,
      nativeNullOrderings: [
        {
          windowIndex: 0,
          pairIndex: 0,
          columnIndex: 1,
          valueDirection: "ASC",
          nullPlacement: "FIRST",
          emissionCount: 1,
        },
      ],
      directMaterializedReferenceCount: 0,
      directMaterializedReferences: [],
    };
    const v13 = {
      ...v12,
      version: 13,
      materializationSelectionCount: 1,
      materializationSelections: [
        {
          definitionIndex: 0,
          kind: "strict-serial-rank-stage",
          choiceIndex: 2,
          emissionCount: 1,
        },
      ],
      derivedSelfMembershipCount: 0,
      derivedSelfMemberships: [],
    };
    expect(await hashOf(v11)).toMatch(/^v11:/u);
    expect(await hashOf(v12)).toMatch(/^v12:/u);
    expect(await hashOf(v13)).toMatch(/^v13:/u);
  });
});

describe("physical shape validation rejects malformed strategy metadata", () => {
  const withField = (field: string, value: unknown) => ({
    ...shapeFor(9),
    [field]: value,
  });
  const key = (name: unknown, l: unknown, r: unknown) => ({
    name,
    leftIndex: l,
    rightIndex: r,
  });

  it("rejects malformed fact-local indexed join strategies", async () => {
    const good = factLocal[0]!;
    const bad: unknown[] = [
      null,
      [],
      { ...good, tableName: "" },
      { ...good, indexName: 3 },
      { ...good, keyColumns: [key("a", 0, 0)] },
      { ...good, keyColumns: "nope" },
      { ...good, keyColumns: [null, key("a", 1, 1)] },
      { ...good, keyColumns: [key("", 0, 0), key("b", 1, 1)] },
      { ...good, keyColumns: [key("a", -1, 0), key("b", 1, 1)] },
      { ...good, keyColumns: [key("a", 0, -1), key("b", 1, 1)] },
      { ...good, keyColumns: [key("a", 0, 0), key("A", 1, 1)] },
      { ...good, keyColumns: [key("a", 0, 0), key("b", 0, 1)] },
      { ...good, keyColumns: [key("a", 0, 0), key("b", 1, 0)] },
    ];
    expect(await hashOf(shapeFor(9))).toMatch(/^v9:/u);
    for (const entry of bad)
      expect(
        await hashOf(withField("factLocalIndexedJoinStrategies", [entry])),
      ).toBeNull();
  });

  it("rejects malformed conditional lookup strategies", async () => {
    const good = conditional[0]!;
    const bad: unknown[] = [
      null,
      [],
      { ...good, tableName: "bad\0name" },
      { ...good, indexName: "\ud800" },
      { ...good, indexName: "\udc00" },
      { ...good, guardConjunctCount: 0 },
      { ...good, keyColumns: [] },
      { ...good, selectedKey: null },
      { ...good, selectedKey: [] },
      { ...good, keyColumns: [null], selectedKey: key("a", 0, 0) },
      { ...good, keyColumns: [key("a", -1, 0)], selectedKey: key("a", 0, 0) },
      { ...good, keyColumns: [key("a", 0, -1)], selectedKey: key("a", 0, 0) },
      {
        ...good,
        keyColumns: [key("A", 0, 0), key("a", 1, 1)],
        selectedKey: key("A", 0, 0),
      },
      {
        ...good,
        keyColumns: [key("a", 0, 0), key("b", 0, 1)],
        selectedKey: key("a", 0, 0),
      },
      {
        ...good,
        keyColumns: [key("a", 0, 0), key("b", 1, 0)],
        selectedKey: key("a", 0, 0),
      },
      { ...good, selectedKey: key("missing", 10, 10) },
      { ...good, selectedKey: key("site_pk", "x", 10) },
    ];
    for (const entry of bad)
      expect(
        await hashOf(withField("conditionalLookupStrategies", [entry])),
      ).toBeNull();
    // A well-formed surrogate pair is a valid identifier.
    expect(
      await hashOf(
        withField("conditionalLookupStrategies", [
          { ...good, tableName: "t\u{1f600}" },
        ]),
      ),
    ).toMatch(/^v9:/u);
  });

  it("rejects malformed row pipelines and lexicographic comparisons", async () => {
    const good = pipeline[0]!;
    const badPipelines: unknown[] = [
      null,
      { ...good, nodeKinds: ["filter"] },
      { ...good, nodeKinds: ["filter", "scan"] },
      { ...good, outputColumnIndexes: [] },
      { ...good, outputColumnIndexes: [-1] },
      { ...good, filterColumnIndexes: [] },
      { ...good, filterColumnIndexes: ["x"] },
      { ...good, filterColumnIndexes: [[-1]] },
      { ...good, nodeKinds: new Array(2) },
    ];
    for (const entry of badPipelines)
      expect(await hashOf(withField("rowPipelineChoices", [entry]))).toBeNull();
    for (const entry of [
      null,
      { direction: "=", componentCount: 2, emissionCount: 1 },
      { direction: ">", componentCount: 1, emissionCount: 1 },
      { direction: ">", componentCount: 2, emissionCount: 0 },
    ])
      expect(
        await hashOf(withField("lexicographicComparisons", [entry])),
      ).toBeNull();
    expect(
      await hashOf(withField("lexicographicComparisons", new Array(1))),
    ).toBeNull();
  });

  it("rejects malformed semi-membership and singleton-rank entries", async () => {
    const v10 = shapeFor(10);
    for (const entry of [
      null,
      "x",
      { keyCount: 0, emissionCount: 1 },
      { keyCount: 1, emissionCount: 0 },
    ])
      expect(await hashOf({ ...v10, semiMemberships: [entry] })).toBeNull();
    const fusion = {
      partitionFieldCount: 1,
      keyFieldCount: 1,
      consumerCertificateCount: 0,
      emissionCount: 1,
      distinct: true,
    };
    const v11 = { ...v10, version: 11, singletonRankFusionCount: 1 };
    expect(await hashOf({ ...v11, singletonRankFusions: [fusion] })).toMatch(
      /^v11:/u,
    );
    const getter = {};
    Object.defineProperty(getter, "partitionFieldCount", {
      enumerable: true,
      get: () => 1,
    });
    for (const entry of [
      null,
      [],
      Object.create({}),
      { ...fusion, extra: 1 },
      { ...fusion, distinct: false },
      { ...fusion, partitionFieldCount: 0 },
      { ...fusion, keyFieldCount: 0 },
      { ...fusion, consumerCertificateCount: -1 },
      { ...fusion, emissionCount: 0 },
      getter,
      new Proxy(
        { ...fusion },
        {
          ownKeys() {
            throw new Error("hostile");
          },
        },
      ),
    ])
      expect(
        await hashOf({ ...v11, singletonRankFusions: [entry] }),
      ).toBeNull();
  });

  it("rejects malformed v12 native-null and materialized-reference entries", async () => {
    const ordering = {
      windowIndex: 0,
      pairIndex: 0,
      columnIndex: 1,
      valueDirection: "ASC",
      nullPlacement: "FIRST",
      emissionCount: 1,
    };
    const reference = { definitionIndex: 0, fieldCount: 1, emissionCount: 1 };
    const ok = {
      ...shapeFor(10),
      version: 12,
      singletonRankFusionCount: 0,
      singletonRankFusions: [],
      nativeNullOrderingCount: 1,
      nativeNullOrderings: [ordering],
      directMaterializedReferenceCount: 1,
      directMaterializedReferences: [reference],
    };
    expect(await hashOf(ok)).toMatch(/^v12:/u);
    for (const entry of [
      null,
      [],
      { ...ordering, extra: 1 },
      { ...ordering, windowIndex: -1 },
      { ...ordering, pairIndex: -1 },
      { ...ordering, columnIndex: -1 },
      { ...ordering, nullPlacement: "MIDDLE" },
      new Proxy(
        { ...ordering },
        {
          ownKeys() {
            throw new Error("hostile");
          },
        },
      ),
    ])
      expect(await hashOf({ ...ok, nativeNullOrderings: [entry] })).toBeNull();
    for (const entry of [
      null,
      [],
      { ...reference, extra: 1 },
      { ...reference, definitionIndex: -1 },
      { ...reference, fieldCount: 0 },
    ])
      expect(
        await hashOf({ ...ok, directMaterializedReferences: [entry] }),
      ).toBeNull();
    expect(
      await hashOf({
        ...ok,
        nativeNullOrderingCount: 2,
        nativeNullOrderings: [ordering, ordering],
      }),
    ).toBeNull();
    expect(
      await hashOf({
        ...ok,
        directMaterializedReferenceCount: 2,
        directMaterializedReferences: [reference, reference],
      }),
    ).toBeNull();
  });
});

describe("observer session selection", () => {
  it("caps batch member selection and ignores invalid or duplicate indexes", async () => {
    const events: DatabaseQueryObservation[] = [];
    const { database } = createDatabase();
    const runtime = createDatabaseRuntime(database, {
      observer: observer(events, (count) => [
        -1,
        0,
        0,
        1.5,
        count + 5,
        ...Array.from({ length: count }, (_u, index) => index),
      ]),
    });
    await runtime.batch(
      Array.from({ length: 40 }, (_u, index) => ({ sql: `SELECT ${index}` })),
    );
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const statementEvents = events.filter(
      (event) => event.operation === "batch" && event.batchIndex !== null,
    );
    const distinct = new Set(
      statementEvents.map((event) =>
        event.operation === "batch" ? event.batchIndex : -1,
      ),
    );
    expect(statementEvents.length).toBe(32);
    expect(distinct.size).toBe(32);
  });

  it("emits no statement event when the session does not select index 0", async () => {
    const events: DatabaseQueryObservation[] = [];
    const { database } = createDatabase();
    const runtime = createDatabaseRuntime(database, {
      observer: observer(events, () => [1]),
    });
    await runtime.first({ sql: "SELECT 1" });
    await runtime.run({ sql: "SELECT 1" });
    await runtime.all({ sql: "SELECT 1" });
    await runtime.exec("SELECT 1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual([]);
  });

  it("runs unobserved when the observer declines to open a session", async () => {
    const { database } = createDatabase();
    const runtime = createDatabaseRuntime(database, {
      observer: { begin: () => undefined } as unknown as DatabaseQueryObserver,
    });
    await expect(runtime.all({ sql: "SELECT 1" })).resolves.toMatchObject({
      success: true,
    });
  });
});

describe("v4 physical shape hashing", () => {
  it("hashes validated v4 metadata and rejects negative join-order counts", async () => {
    const shape = {
      version: 4,
      cteCount: 1,
      directScanProjectionCount: 1,
      nativeMembershipCount: 0,
      jsonMembershipCount: 0,
      nativeRowRelationCount: 0,
      jsonRowRelationCount: 0,
      rightAnchorJoinOrderCount: 1,
      uniqueLookupJoinOrderCount: 1,
    };
    const hash = await hashOf(shape);
    expect(hash).toMatch(/^v4:[0-9a-f]+$/u);
    expect(await hashOf({ ...shape, uniqueLookupJoinOrderCount: 2 })).not.toBe(
      hash,
    );
    expect(
      await hashOf({ ...shape, uniqueLookupJoinOrderCount: -1 }),
    ).toBeNull();
  });
});
