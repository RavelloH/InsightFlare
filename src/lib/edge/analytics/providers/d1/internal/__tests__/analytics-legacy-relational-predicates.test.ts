import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  filter,
  param,
  project,
  scan,
} from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { schema } from "@/lib/db/schema";
import { lowerLegacyRelationalPredicate } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-relational-predicates";
import type {
  AnalyticsLegacyEventRow,
  AnalyticsLegacyPageRow,
  AnalyticsLegacyScopedPredicateContext,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-types";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import type {
  FilterCondition,
  FilterValue,
} from "@/lib/filter-contract/filters";

const SITE_ID = "legacy-relational-site";
let db: DatabaseSync;
let sitePk: number;

function pageRow(relation = scan(schema.visits)): AnalyticsLegacyPageRow {
  return {
    relation: relation as unknown as AnalyticsDbRelation,
    sitePk: relation.columns
      .site_pk as unknown as AnalyticsLegacyPageRow["sitePk"],
    rawSiteId: relation.columns
      .site_id as unknown as AnalyticsLegacyPageRow["rawSiteId"],
    visitId: relation.columns
      .visit_id as unknown as AnalyticsLegacyPageRow["visitId"],
    sessionId: relation.columns
      .session_id as unknown as AnalyticsLegacyPageRow["sessionId"],
    visitorId: relation.columns
      .visitor_id as unknown as AnalyticsLegacyPageRow["visitorId"],
    startedAt: relation.columns
      .started_at as unknown as AnalyticsLegacyPageRow["startedAt"],
    pathname: relation.columns
      .pathname as unknown as AnalyticsLegacyPageRow["pathname"],
    durationMs: relation.columns
      .duration_ms as unknown as AnalyticsLegacyPageRow["durationMs"],
    visitColumns: relation.columns,
    filterValues: {},
  };
}

function eventRow(
  relation = scan(schema.custom_events),
): AnalyticsLegacyEventRow {
  return {
    relation: relation as unknown as AnalyticsDbRelation,
    sitePk: relation.columns
      .site_pk as unknown as AnalyticsLegacyEventRow["sitePk"],
    rawSiteId: relation.columns
      .site_id as unknown as AnalyticsLegacyEventRow["rawSiteId"],
    eventPk: relation.columns
      .event_pk as unknown as AnalyticsLegacyEventRow["eventPk"],
    eventId: relation.columns
      .event_id as unknown as AnalyticsLegacyEventRow["eventId"],
    nameId: relation.columns
      .event_name_id as unknown as AnalyticsLegacyEventRow["nameId"],
    visitId: relation.columns
      .visit_id as unknown as AnalyticsLegacyEventRow["visitId"],
    sessionId: relation.columns
      .visit_id as unknown as AnalyticsLegacyEventRow["sessionId"],
    visitorId: relation.columns
      .visit_id as unknown as AnalyticsLegacyEventRow["visitorId"],
    occurredAt: relation.columns
      .occurred_at as unknown as AnalyticsLegacyEventRow["occurredAt"],
    eventName: param("legacy-event"),
    eventColumns: relation.columns,
    ownerVisitColumns: {},
    filterValues: {},
  };
}

function scopedContext(): AnalyticsLegacyScopedPredicateContext {
  const pages = pageRow();
  const events = eventRow();
  return {
    selection: {} as never,
    storage: {} as never,
    readPages: pages,
    candidatePages: pages,
    readEvents: events,
  };
}

function insertPage(input: {
  readonly visitId: string | null;
  readonly sessionId: string | null;
  readonly startedAt: number;
  readonly pathname: string;
  readonly rawSiteId?: string;
  readonly durationMs?: number | string | null;
}): void {
  db.prepare(
    `
    INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, pathname, hostname, duration_ms, site_pk
    ) VALUES (?, ?, 'visitor-a', ?, 'complete', ?, ?, ?, 'example.test', ?, ?)
  `,
  ).run(
    input.visitId,
    input.rawSiteId ?? SITE_ID,
    input.sessionId,
    input.startedAt,
    input.startedAt,
    input.pathname,
    input.durationMs ?? null,
    sitePk,
  );
}

function insertEvent(eventPk: number, eventId: string, visitId: string): void {
  db.prepare(
    `
    INSERT INTO custom_events (
      event_pk, event_id, site_id, site_pk, visit_id, event_name_id,
      occurred_at, received_at, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, 1, 100, 100, 0, 0)
  `,
  ).run(eventPk, eventId, SITE_ID, sitePk, visitId);
}

function addPayloadValue(input: {
  readonly eventPk: number;
  readonly nodeId: number;
  readonly pathId: number;
  readonly path: string;
  readonly type: 0 | 1 | 2 | 3;
  readonly value: string | number | boolean | null;
}): void {
  db.prepare(
    `
    INSERT INTO custom_event_json_paths (id, site_id, site_pk, path, last_seen_at)
    VALUES (?, ?, ?, ?, 100)
    ON CONFLICT(id) DO NOTHING
  `,
  ).run(input.pathId, SITE_ID, sitePk, input.path);
  db.prepare(
    `
    INSERT INTO custom_event_json_nodes (
      event_pk, node_id, parent_node_id, key_id, path_id, value_type,
      array_index, depth
    ) VALUES (?, ?, NULL, NULL, ?, ?, NULL, 1)
  `,
  ).run(input.eventPk, input.nodeId, input.pathId, input.type);
  db.prepare(
    `
    INSERT INTO custom_event_json_values (
      event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
      value_type, string_value, number_value, boolean_value, site_pk
    ) VALUES (?, ?, ?, 1, ?, 100, ?, ?, ?, ?, ?)
  `,
  ).run(
    input.eventPk,
    input.nodeId,
    SITE_ID,
    input.pathId,
    input.type,
    typeof input.value === "string" ? input.value : null,
    typeof input.value === "number" ? input.value : null,
    typeof input.value === "boolean" ? (input.value ? 1 : 0) : null,
    sitePk,
  );
}

function condition(
  target:
    | { readonly kind: "field"; readonly field: string }
    | { readonly kind: "event-payload"; readonly path: string },
  operator: FilterCondition["operator"],
  value?: FilterValue | readonly FilterValue[],
): FilterCondition {
  return {
    kind: "condition",
    target,
    operator,
    ...(value === undefined ? {} : { value }),
  } as FilterCondition;
}

async function loweredIds(input: {
  readonly condition: FilterCondition;
  readonly source: AnalyticsLegacyPageRow | AnalyticsLegacyEventRow;
  readonly key: "visit_id" | "event_id";
}): Promise<(string | null)[]> {
  const predicate = lowerLegacyRelationalPredicate({
    condition: input.condition,
    context: scopedContext(),
    source: input.source,
  });
  const filtered = filter(input.source.relation, predicate);
  const selected = project(filtered, {
    result_id: filtered.columns[input.key] as never,
  });
  const result = await createD1DatabaseClient(createSqliteD1Database(db)).all(
    compileD1Query(selected),
  );
  const ids: Array<string | null> = [];
  for (const row of result.results as unknown as readonly {
    readonly result_id: unknown;
  }[]) {
    if (row.result_id === null || typeof row.result_id === "string")
      ids.push(row.result_id);
  }
  return ids.sort((left, right) =>
    left === null
      ? right === null
        ? 0
        : -1
      : right === null
        ? 1
        : left.localeCompare(right),
  );
}

function oldBoundaryIds(
  kind: "entry" | "exit",
  path: string,
): (string | null)[] {
  const rank = kind === "entry" ? "entry_rank" : "exit_rank";
  const pathColumn = kind === "entry" ? "entry_path" : "exit_path";
  const direction = kind === "entry" ? "ASC" : "DESC";
  const rows = db
    .prepare(
      `
    SELECT outer_page.visit_id
    FROM visits AS outer_page
    WHERE (outer_page.site_pk, outer_page.session_id) IN (
      SELECT site_pk, session_id
      FROM (
        SELECT site_pk, session_id,
          MAX(CASE WHEN ${rank} = 1 THEN pathname END) AS ${pathColumn}
        FROM (
          SELECT edge.site_pk, edge.session_id, edge.pathname,
            ROW_NUMBER() OVER (
              PARTITION BY edge.site_pk, edge.session_id
              ORDER BY edge.started_at ${direction}, edge.visit_id ${direction}
            ) AS ${rank}
          FROM visits AS edge
          WHERE TRIM(COALESCE(edge.session_id, '')) != ''
        ) session_edges
        GROUP BY site_pk, session_id
      ) session_boundaries
      WHERE ${pathColumn} = ?
    )
    ORDER BY outer_page.visit_id
  `,
    )
    .all(path) as Array<{ visit_id: string | null }>;
  return rows.map((row) => row.visit_id);
}

function payloadType(value: FilterValue): 0 | 1 | 2 | 3 {
  if (value === null) return 0;
  if (typeof value === "string") return 1;
  if (typeof value === "number") return 2;
  return 3;
}

function oldPayloadIds(
  path: string,
  operator: FilterCondition["operator"],
  value?: FilterValue | readonly FilterValue[],
): string[] {
  const bindings: Array<string | number | null> = [path];
  let clause = "";
  if (operator === "exists" || operator === "notExists") {
    clause = "1";
  } else if (operator === "isNull") {
    clause = "payload_value.value_type = 0";
  } else if (operator === "notNull") {
    clause = "payload_value.value_type != 0";
  } else if (operator === "isEmpty") {
    clause = "payload_value.value_type = 1 AND payload_value.string_value = ''";
  } else if (operator === "notEmpty") {
    clause =
      "payload_value.value_type = 1 AND payload_value.string_value != ''";
  } else {
    const values = Array.isArray(value) ? [...value] : [value!];
    const type = payloadType(values[0]!);
    const typeColumn =
      type === 1
        ? "payload_value.string_value"
        : type === 2
          ? "payload_value.number_value"
          : type === 3
            ? "payload_value.boolean_value"
            : "payload_value.value_type";
    if (operator === "in" || operator === "notIn") {
      const notIn = operator === "notIn";
      if (values.length >= 8) {
        clause = `payload_value.value_type = ? AND payload_value.${
          type === 1
            ? "string_value"
            : type === 2
              ? "number_value"
              : type === 3
                ? "boolean_value"
                : "value_type"
        } ${notIn ? "NOT IN" : "IN"} (SELECT value FROM json_each(?))`;
        bindings.push(
          type,
          JSON.stringify(
            values.map((item) =>
              typeof item === "boolean" ? (item ? 1 : 0) : item,
            ),
          ),
        );
      } else {
        clause = `payload_value.value_type = ? AND ${typeColumn} ${notIn ? "NOT IN" : "IN"} (${values.map(() => "?").join(", ")})`;
        bindings.push(
          type,
          ...values.map((item) =>
            typeof item === "boolean" ? (item ? 1 : 0) : item,
          ),
        );
      }
    } else if (operator === "eq" || operator === "neq") {
      const sqlOperator = operator === "eq" ? "=" : "!=";
      if (values[0] === null) {
        clause = `payload_value.value_type ${sqlOperator} 0`;
      } else {
        clause = `payload_value.value_type = ? AND ${typeColumn} ${sqlOperator} ?`;
        bindings.push(
          type,
          typeof values[0] === "boolean" ? (values[0] ? 1 : 0) : values[0]!,
        );
      }
    } else {
      throw new Error(`No frozen oracle for ${operator}.`);
    }
  }
  const notExists = operator === "notExists";
  const rows = db
    .prepare(
      `
    SELECT event.event_id
    FROM custom_events AS event
    WHERE ${notExists ? "NOT " : ""}EXISTS (
      SELECT 1
      FROM custom_event_json_values AS payload_value
      INNER JOIN custom_event_json_paths AS payload_path
        ON payload_path.id = payload_value.path_id
      WHERE payload_value.event_pk = event.event_pk
        AND payload_value.site_pk = event.site_pk
        AND payload_path.site_pk = event.site_pk
        AND payload_path.path = ?
        AND (${clause})
    )
    ORDER BY event.event_id
  `,
    )
    .all(...bindings) as Array<{ event_id: string }>;
  return rows.map((row) => row.event_id);
}

describe("legacy relational predicate lowering", () => {
  beforeAll(() => {
    db = createMigratedDatabase();
    db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(SITE_ID);
    sitePk = (
      db
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as {
        site_pk: number;
      }
    ).site_pk;
    db.prepare(
      "INSERT INTO custom_event_names (id, site_id, site_pk, name, last_seen_at) VALUES (1, ?, ?, 'legacy-event', 100)",
    ).run(SITE_ID, sitePk);
    insertPage({
      visitId: null,
      sessionId: "boundary-session",
      startedAt: 10,
      pathname: "/null-first",
    });
    insertPage({
      visitId: "a",
      sessionId: "boundary-session",
      startedAt: 10,
      pathname: "/a-second",
    });
    insertPage({
      visitId: "z",
      sessionId: "boundary-session",
      startedAt: 20,
      pathname: "/z-exit",
    });
    insertPage({
      visitId: null,
      sessionId: "boundary-session",
      startedAt: 20,
      pathname: "/null-last",
    });
    insertPage({
      visitId: "event-owner",
      sessionId: "payload-session",
      startedAt: 30,
      pathname: "/owner",
    });

    insertEvent(1, "payload-null", "event-owner");
    insertEvent(2, "payload-empty", "event-owner");
    insertEvent(3, "payload-nul", "event-owner");
    insertEvent(4, "payload-multi", "event-owner");
    insertEvent(5, "payload-set7", "event-owner");
    insertEvent(6, "payload-set8", "event-owner");
    insertEvent(7, "payload-number", "event-owner");
    insertEvent(8, "payload-bool", "event-owner");
    addPayloadValue({
      eventPk: 1,
      nodeId: 1,
      pathId: 1,
      path: "/nullable",
      type: 0,
      value: null,
    });
    addPayloadValue({
      eventPk: 2,
      nodeId: 1,
      pathId: 2,
      path: "/empty",
      type: 1,
      value: "",
    });
    addPayloadValue({
      eventPk: 3,
      nodeId: 1,
      pathId: 3,
      path: "/nul",
      type: 1,
      value: "before\u0000after",
    });
    addPayloadValue({
      eventPk: 4,
      nodeId: 1,
      pathId: 4,
      path: "/multi",
      type: 1,
      value: "alpha",
    });
    addPayloadValue({
      eventPk: 4,
      nodeId: 2,
      pathId: 4,
      path: "/multi",
      type: 1,
      value: "beta",
    });
    for (let index = 0; index < 7; index++)
      addPayloadValue({
        eventPk: 5,
        nodeId: index + 1,
        pathId: 5,
        path: "/set7",
        type: 1,
        value: `v${index}`,
      });
    for (let index = 0; index < 8; index++)
      addPayloadValue({
        eventPk: 6,
        nodeId: index + 1,
        pathId: 6,
        path: "/set8",
        type: 1,
        value: `v${index}`,
      });
    addPayloadValue({
      eventPk: 7,
      nodeId: 1,
      pathId: 7,
      path: "/number",
      type: 2,
      value: 4.5,
    });
    addPayloadValue({
      eventPk: 8,
      nodeId: 1,
      pathId: 8,
      path: "/bool",
      type: 3,
      value: true,
    });
  });

  afterAll(() => db.close());

  it("matches the frozen entry/exit SQL including NULL visit-id rank ties", async () => {
    const pages = pageRow();
    for (const [kind, field, path] of [
      ["entry", "session.entryPath", "/null-first"],
      ["exit", "session.exitPath", "/z-exit"],
    ] as const) {
      const expected = oldBoundaryIds(kind, path);
      const actual = await loweredIds({
        condition: condition({ kind: "field", field }, "eq", path),
        source: pages,
        key: "visit_id",
      });
      expect(actual).toEqual(expected);
      expect(actual).toEqual([null, null, "a", "z"]);
    }
  });

  it("matches frozen normalized-payload SQL for presence, raw values, and 7/8-item sets", async () => {
    const events = eventRow();
    const cases: ReadonlyArray<{
      readonly path: string;
      readonly operator: FilterCondition["operator"];
      readonly value?: FilterValue | readonly FilterValue[];
    }> = [
      { path: "/missing", operator: "exists" },
      { path: "/missing", operator: "notExists" },
      { path: "/nullable", operator: "isNull" },
      { path: "/nullable", operator: "notNull" },
      { path: "/empty", operator: "isEmpty" },
      { path: "/empty", operator: "notEmpty" },
      { path: "/nul", operator: "eq", value: "before\u0000after" },
      { path: "/multi", operator: "eq", value: "beta" },
      {
        path: "/set7",
        operator: "in",
        value: ["v0", "v1", "v2", "v3", "v4", "v5", "v6"],
      },
      {
        path: "/set8",
        operator: "in",
        value: ["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"],
      },
      { path: "/number", operator: "eq", value: 4.5 },
      { path: "/bool", operator: "eq", value: true },
    ];
    for (const item of cases) {
      const expected = oldPayloadIds(item.path, item.operator, item.value);
      const actual = await loweredIds({
        condition: condition(
          { kind: "event-payload", path: item.path },
          item.operator,
          item.value,
        ),
        source: events,
        key: "event_id",
      });
      expect(actual).toEqual(expected);
    }
  });

  it("lowers payload comparisons and rejects invalid legacy relations", async () => {
    const events = eventRow();
    const cases: ReadonlyArray<{
      readonly condition: FilterCondition;
      readonly expected: readonly string[];
    }> = [
      {
        condition: condition(
          { kind: "event-payload", path: "/number" },
          "gt",
          4,
        ),
        expected: ["payload-number"],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/number" },
          "neq",
          4.5,
        ),
        expected: [],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/number" },
          "gte",
          4.5,
        ),
        expected: ["payload-number"],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/number" },
          "lt",
          4.5,
        ),
        expected: [],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/number" },
          "lte",
          4.5,
        ),
        expected: ["payload-number"],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/number" },
          "between",
          [4, 5],
        ),
        expected: ["payload-number"],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/nullable" },
          "eq",
          null,
        ),
        expected: ["payload-null"],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/nullable" },
          "in",
          [null],
        ),
        expected: [],
      },
      {
        condition: condition({ kind: "event-payload", path: "/bool" }, "in", [
          true,
        ]),
        expected: ["payload-bool"],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/set7" },
          "notIn",
          ["v0"],
        ),
        expected: ["payload-set7"],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/set8" },
          "notIn",
          ["v7"],
        ),
        expected: ["payload-set8"],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/multi" },
          "contains",
          "bet",
        ),
        expected: ["payload-multi"],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/multi" },
          "startsWith",
          "al",
        ),
        expected: ["payload-multi"],
      },
      {
        condition: condition(
          { kind: "event-payload", path: "/multi" },
          "endsWith",
          "ta",
        ),
        expected: ["payload-multi"],
      },
    ];

    for (const item of cases)
      await expect(
        loweredIds({
          condition: item.condition,
          source: events,
          key: "event_id",
        }),
      ).resolves.toEqual(item.expected);

    expect(() =>
      lowerLegacyRelationalPredicate({
        condition: condition(
          { kind: "event-payload", path: "/nullable" },
          "eq",
          { unsupported: true } as never,
        ),
        context: scopedContext(),
        source: events,
      }),
    ).toThrow("unsupported_filter_condition_value");
    expect(() =>
      lowerLegacyRelationalPredicate({
        condition: condition({ kind: "event-payload", path: "/number" }, "in", [
          "one",
          1,
        ]),
        context: scopedContext(),
        source: events,
      }),
    ).toThrow("Payload set filters require values of one JSON type.");
    expect(() =>
      lowerLegacyRelationalPredicate({
        condition: condition(
          { kind: "event-payload", path: "/number" },
          "between",
          [null, null],
        ),
        context: scopedContext(),
        source: events,
      }),
    ).toThrow("Payload BETWEEN values must be non-null scalars.");
    expect(() =>
      lowerLegacyRelationalPredicate({
        condition: condition(
          { kind: "event-payload", path: "/number" },
          "contains",
          4,
        ),
        context: scopedContext(),
        source: events,
      }),
    ).toThrow("Payload string matching requires a string.");
    expect(() =>
      lowerLegacyRelationalPredicate({
        condition: condition(
          { kind: "event-payload", path: "/number" },
          "unsupported" as never,
          "value",
        ),
        context: scopedContext(),
        source: events,
      }),
    ).toThrow("Unsupported payload operator unsupported.");
    expect(() =>
      lowerLegacyRelationalPredicate({
        condition: condition(
          { kind: "event-payload", path: "/nullable" },
          "eq",
          true,
        ),
        context: scopedContext(),
        source: pageRow(),
      }),
    ).toThrow("Event-payload predicates require an Event source.");
    expect(() =>
      lowerLegacyRelationalPredicate({
        condition: condition(
          { kind: "field", field: "session.durationMs" },
          "gt",
          1,
        ),
        context: scopedContext(),
        source: events,
      }),
    ).toThrow("Unsupported legacy relational field session.durationMs.");
  });
});
