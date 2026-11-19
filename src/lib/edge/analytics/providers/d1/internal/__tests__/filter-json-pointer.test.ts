// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  compileExactJsonPointerPredicate,
  jsonPointerSegments,
} from "@/lib/edge/analytics/providers/d1/internal/filter-json-pointer";
import { expandCustomEventData } from "@/lib/edge/ingest/custom-event-json";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

type SqliteRecord = Record<string, unknown>;

function databaseWithExpandedPayloads(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE custom_event_json_keys(id INTEGER PRIMARY KEY, site_pk INTEGER, key TEXT);
    CREATE TABLE custom_event_json_nodes(
      event_pk INTEGER, node_id INTEGER, parent_node_id INTEGER, key_id INTEGER,
      path_id INTEGER, value_type INTEGER, member_order INTEGER, array_index INTEGER, depth INTEGER,
      PRIMARY KEY(event_pk, node_id)
    );
    CREATE TABLE custom_event_json_values(
      event_pk INTEGER, node_id INTEGER, site_pk INTEGER, value_type INTEGER,
      string_value TEXT, number_value REAL, boolean_value INTEGER
    );
    CREATE TABLE events(event_pk INTEGER PRIMARY KEY, site_pk INTEGER);
    INSERT INTO events VALUES(101,1),(201,2);
  `);
  let nextKey = 1;
  const keys = new Map<string, number>();
  const addKey = database.prepare(
    "INSERT INTO custom_event_json_keys VALUES (?, ?, ?)",
  );
  const addNode = database.prepare(
    "INSERT INTO custom_event_json_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const addValue = database.prepare(
    "INSERT INTO custom_event_json_values VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const payloads = [
    [
      101,
      1,
      {
        "0": "literal-zero",
        "*": "literal-star",
        items: [
          { sku: "A", "0": "numeric-key", "*": "asterisk-key" },
          { sku: "B" },
        ],
        orders: [{ items: [{ sku: "C" }, { sku: "D" }] }],
        nested: { "a/b": 7, "~tag": 8 },
        nil: null,
        empty: [],
        enabled: false,
      },
    ],
    [
      201,
      2,
      {
        items: [{ sku: "X" }, { sku: "Y" }],
        nil: 2,
      },
    ],
  ] as const;
  for (const [eventPk, sitePk, payload] of payloads) {
    const expanded = expandCustomEventData(payload);
    if (!expanded.ok) throw new Error(expanded.error);
    for (const key of expanded.data.keys) {
      const id = nextKey++;
      keys.set(`${sitePk}/${key}`, id);
      addKey.run(id, sitePk, key);
    }
    for (const node of expanded.data.nodes) {
      addNode.run(
        eventPk,
        node.nodeId,
        node.parentNodeId,
        node.key === null ? null : (keys.get(`${sitePk}/${node.key}`) ?? null),
        1,
        node.valueType,
        node.memberOrder,
        node.arrayIndex,
        node.depth,
      );
    }
    for (const value of expanded.data.values) {
      addValue.run(
        eventPk,
        value.nodeId,
        sitePk,
        value.valueType,
        value.stringValue,
        value.numberValue,
        value.booleanValue,
      );
    }
  }
  return database;
}

function matchedEventPks(database: DatabaseSync, expression: string): number[] {
  const doc = parseFilterDsl(expression, analyticsFilterRegistry);
  if (!doc.root || doc.root.kind !== "condition") {
    throw new TypeError("Pointer test requires one Filter Condition.");
  }
  const compiled = compileExactJsonPointerPredicate(doc.root, "e");
  const rows = database
    .prepare(
      `SELECT e.event_pk FROM events e WHERE ${compiled.sql} ORDER BY e.event_pk`,
    )
    .all(...compiled.bindings) as SqliteRecord[];
  return rows.map((row) => Number(row.event_pk));
}

describe("P2 exact event JSON Pointer in SQLite", () => {
  it("decodes RFC 6901 tokens and only accepts canonical array subscripts", () => {
    expect(jsonPointerSegments("/")).toEqual([]);
    expect(jsonPointerSegments("/items/0/a~1b/~0tag/01/*")).toEqual([
      { member: "items", arrayIndex: null },
      { member: "0", arrayIndex: 0 },
      { member: "a/b", arrayIndex: null },
      { member: "~tag", arrayIndex: null },
      { member: "01", arrayIndex: null },
      { member: "*", arrayIndex: null },
    ]);
    expect(() => jsonPointerSegments("/bad~2escape")).toThrow();
    expect(() => jsonPointerSegments("not-a-pointer")).toThrow();
  });

  it("distinguishes distinct array positions, escaped object keys, and literal '*'", () => {
    const db = databaseWithExpandedPayloads();
    try {
      expect(
        matchedEventPks(db, 'event.payload("/items/0/sku") eq "A"'),
      ).toEqual([101]);
      expect(
        matchedEventPks(db, 'event.payload("/items/1/sku") eq "B"'),
      ).toEqual([101]);
      expect(
        matchedEventPks(db, 'event.payload("/items/0/sku") eq "X"'),
      ).toEqual([201]);
      expect(
        matchedEventPks(db, 'event.payload("/items/01/sku") exists'),
      ).toEqual([]);
      expect(
        matchedEventPks(db, 'event.payload("/items/*/sku") exists'),
      ).toEqual([]);
      expect(
        matchedEventPks(db, 'event.payload("/items/0/0") eq "numeric-key"'),
      ).toEqual([101]);
      expect(
        matchedEventPks(db, 'event.payload("/items/0/*") eq "asterisk-key"'),
      ).toEqual([101]);
      expect(
        matchedEventPks(db, 'event.payload("/0") eq "literal-zero"'),
      ).toEqual([101]);
      expect(
        matchedEventPks(db, 'event.payload("/*") eq "literal-star"'),
      ).toEqual([101]);
      expect(matchedEventPks(db, 'event.payload("/nested/a~1b") eq 7')).toEqual(
        [101],
      );
      expect(
        matchedEventPks(db, 'event.payload("/nested/~0tag") eq 8'),
      ).toEqual([101]);
      expect(
        matchedEventPks(db, 'event.payload("/orders/0/items/1/sku") eq "D"'),
      ).toEqual([101]);
    } finally {
      db.close();
    }
  });

  it("keeps JSON null, Missing, false, empty container and site identities distinct", () => {
    const db = databaseWithExpandedPayloads();
    try {
      expect(matchedEventPks(db, 'event.payload("/nil") isNull')).toEqual([
        101,
      ]);
      expect(matchedEventPks(db, 'event.payload("/nil") notNull')).toEqual([
        201,
      ]);
      expect(matchedEventPks(db, 'event.payload("/nil") notExists')).toEqual(
        [],
      );
      expect(
        matchedEventPks(db, 'event.payload("/missing") notExists'),
      ).toEqual([101, 201]);
      expect(matchedEventPks(db, 'event.payload("/missing") isNull')).toEqual(
        [],
      );
      expect(matchedEventPks(db, 'event.payload("/empty") exists')).toEqual([
        101,
      ]);
      expect(matchedEventPks(db, 'event.payload("/empty") isEmpty')).toEqual([
        101,
      ]);
      expect(matchedEventPks(db, 'event.payload("/enabled") eq false')).toEqual(
        [101],
      );
      expect(matchedEventPks(db, 'event.payload("/enabled") eq true')).toEqual(
        [],
      );
    } finally {
      db.close();
    }
  });

  it("uses typed scalar, membership, BETWEEN, and string matching comparisons", () => {
    const db = databaseWithExpandedPayloads();
    try {
      expect(
        matchedEventPks(db, 'event.payload("/nested/a~1b") between [5, 8]'),
      ).toEqual([101]);
      expect(
        matchedEventPks(db, 'event.payload("/nested/a~1b") in [7, 8]'),
      ).toEqual([101]);
      expect(
        matchedEventPks(db, 'event.payload("/nested/a~1b") notIn [7, 8]'),
      ).toEqual([]);
      expect(
        matchedEventPks(db, 'event.payload("/items/0/sku") startsWith "A"'),
      ).toEqual([101]);
      expect(
        matchedEventPks(db, 'event.payload("/items/0/sku") endsWith "X"'),
      ).toEqual([201]);
    } finally {
      db.close();
    }
  });
});
