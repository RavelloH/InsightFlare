// @vitest-environment node
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { composeBoundCtes } from "@/lib/edge/analytics/providers/d1/internal/filter-qualification";
import { compileCollectionSqlQualification } from "@/lib/edge/analytics/providers/d1/internal/filter-sql-collections";
import { expandCustomEventData } from "@/lib/edge/ingest/custom-event-json";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE custom_event_json_keys(id INTEGER PRIMARY KEY, site_pk INTEGER, key TEXT);
    CREATE TABLE custom_event_json_nodes(
      event_pk INTEGER, node_id INTEGER, parent_node_id INTEGER, key_id INTEGER, path_id INTEGER,
      value_type INTEGER, member_order INTEGER, array_index INTEGER, depth INTEGER
    );
    CREATE TABLE custom_event_json_values(
      event_pk INTEGER, node_id INTEGER, site_pk INTEGER, value_type INTEGER,
      string_value TEXT, number_value REAL, boolean_value INTEGER
    );
  `);
  const addKey = db.prepare("INSERT INTO custom_event_json_keys VALUES(?,?,?)");
  const addNode = db.prepare(
    "INSERT INTO custom_event_json_nodes VALUES(?,?,?,?,?,?,?,?,?)",
  );
  const addValue = db.prepare(
    "INSERT INTO custom_event_json_values VALUES(?,?,?,?,?,?,?)",
  );
  for (const [eventPk, data] of [
    [101, { amount: 5, sku: "pro" }],
    [102, { amount: "5", sku: "pro" }],
    [103, { amount: null, sku: "free" }],
    [104, { sku: "free" }],
  ] as const) {
    const expanded = expandCustomEventData(data);
    if (!expanded.ok) throw new Error(expanded.error);
    const keys = new Map<string, number>();
    for (const [index, key] of expanded.data.keys.entries()) {
      const keyId = eventPk * 100 + index;
      keys.set(key, keyId);
      addKey.run(keyId, 1, key);
    }
    for (const node of expanded.data.nodes) {
      addNode.run(
        eventPk,
        node.nodeId,
        node.parentNodeId,
        node.key === null ? null : keys.get(node.key)!,
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
        1,
        value.valueType,
        value.stringValue,
        value.numberValue,
        value.booleanValue,
      );
    }
  }
  return db;
}

const source = `
  scope_raw_visits(site_pk, site_id, visit_id, session_id, visitor_id, pathname, duration_ms, started_at) AS (
    VALUES (1,'a','v1','s1','u1','/home',10,1)
  ),
  scope_raw_events(site_pk, site_id, event_pk, event_id, visit_id, session_id, visitor_id, pathname, event_name, occurred_at) AS (
    VALUES (1,'a',101,'e1','v1','s1','u1','/home','purchase',2),
           (1,'a',102,'e2','v1','s1','u1','/home','purchase',3),
           (1,'a',103,'e3','v1','s1','u1','/home','view',4),
           (1,'a',104,'e4','v1','s1','u1','/home','view',5)
  )`;

function qualifies(db: DatabaseSync, expression: string): boolean {
  const result = compileCollectionSqlQualification(
    parseFilterDsl(expression, analyticsFilterRegistry),
    "session",
  );
  expect(result.kind).toBe("entity");
  if (result.kind !== "entity") return false;
  const composed = composeBoundCtes(result.ctes);
  const rows = db
    .prepare(
      `WITH ${source}, ${composed.ctes}
    SELECT entity_id FROM ${result.qualifiedEntityRelation}`,
    )
    .all(...composed.bindings.map((item) => item.value));
  return rows.length === 1;
}

describe("P3 typed SQL scalar aggregation", () => {
  it("distinguishes JSON numbers, strings, null and Missing for countDistinct", () => {
    const db = fixture();
    try {
      expect(
        qualifies(db, 'countDistinct(EVENT -> payload("/amount")) eq 3'),
      ).toBe(true);
      expect(
        qualifies(db, 'countDistinct(EVENT -> payload("/amount")) eq 2'),
      ).toBe(false);
      expect(
        qualifies(db, 'countDistinct(EVENT -> payload("/missing")) eq 0'),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("aggregates only numeric JSON projection values", () => {
    const db = fixture();
    try {
      expect(qualifies(db, 'sum(EVENT -> payload("/amount")) eq 5')).toBe(true);
      expect(qualifies(db, 'avg(EVENT -> payload("/amount")) eq 5')).toBe(true);
      expect(qualifies(db, 'sum(EVENT -> payload("/missing")) eq 0')).toBe(
        true,
      );
      expect(qualifies(db, 'avg(EVENT -> payload("/missing")) isNull')).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });

  it("keeps the SELECT-projection JSON bind before filtered FROM binds", () => {
    const db = fixture();
    try {
      expect(
        qualifies(
          db,
          'sum(EVENT { $.name eq "purchase" } -> payload("/amount")) eq 5',
        ),
      ).toBe(true);
      expect(
        qualifies(
          db,
          'countDistinct(EVENT { $.name eq "purchase" } -> payload("/sku")) eq 1',
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});
