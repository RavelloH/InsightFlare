import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  compileFilterDocument,
  normalizeFilterDocument,
} from "@/lib/edge/query-contract";

function document(root: unknown) {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

describe("filter SQL compiler", () => {
  it("matches strict root-or-subdomain predicates with generic JSON-bound OR sets", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE visits (id TEXT PRIMARY KEY, referrer_host TEXT);
      `);
      const insert = database.prepare(
        "INSERT INTO visits (id, referrer_host) VALUES (?, ?)",
      );
      for (const [id, referrerHost] of [
        ["root", "google.com"],
        ["subdomain", "www.google.com"],
        ["regional-subdomain", "www.google.com.hk"],
        ["other-root", "bing.com"],
        ["other-subdomain", "cn.bing.com"],
        ["case-and-space", "  WWW.Google.Com  "],
        ["false-prefix", "evilgoogle.com"],
        ["false-suffix", "evil.google.com.evil"],
        ["literal-percent", "sub.literal%domain.test"],
        ["literal-underscore", "sub.literal_domain.test"],
        ["literal-backslash", "sub.literal\\domain.test"],
        ["direct", "__direct__"],
        ["empty", ""],
        ["null", null],
      ] as const) {
        insert.run(id, referrerHost);
      }

      const roots = [
        "google.com",
        "google.com.hk",
        "bing.com",
        "literal%domain.test",
        "literal_domain.test",
        "literal\\domain.test",
      ];
      const normalized = "LOWER(TRIM(COALESCE(referrer_host, '')))";
      const baselineClause = roots
        .map(() => `(${normalized} = ? OR ${normalized} LIKE ? ESCAPE '\\')`)
        .join(" OR ");
      const baselineBindings = roots.flatMap((root) => [
        root,
        `%.${root.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}`,
      ]);
      const escapedRoot = `REPLACE(REPLACE(REPLACE(roots.value, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;
      const optimizedClause = `(
        ${normalized} IN (SELECT value FROM json_each(?))
        OR EXISTS (
          SELECT 1
          FROM json_each(?) AS roots
          WHERE ${normalized} LIKE '%' || ${escapedRoot} ESCAPE '\\'
        )
      )`;

      const queryIds = (clause: string, bindings: readonly string[]) =>
        database
          .prepare(`SELECT id FROM visits WHERE ${clause} ORDER BY id`)
          .all(...bindings)
          .map((row) => (row as { id: string }).id);
      const baseline = queryIds(baselineClause, baselineBindings);
      const optimized = queryIds(optimizedClause, [
        JSON.stringify(roots),
        JSON.stringify(roots.map((root) => `.${root}`)),
      ]);
      const compiled = compileFilterDocument(
        document({
          kind: "or",
          children: roots.flatMap((root) => [
            {
              kind: "condition",
              target: { kind: "field", field: "referrer.domain" },
              operator: "eq",
              value: root,
            },
            {
              kind: "condition",
              target: { kind: "field", field: "referrer.domain" },
              operator: "endsWith",
              value: `.${root}`,
            },
          ]),
        }),
      );
      const compiledIds = database
        .prepare(
          `SELECT id FROM visits AS visit_source ${compiled.clause} ORDER BY id`,
        )
        .all(...compiled.bindings)
        .map((row) => (row as { id: string }).id);

      expect(optimized).toEqual(baseline);
      expect(compiledIds).toEqual(baseline);
      expect(compiled.clause).toContain("json_each(?)");
      expect(compiled.bindings).toHaveLength(7);
      expect(
        new Set([
          ...compiled.bindings.flatMap((binding) =>
            typeof binding === "string" && binding.startsWith("[")
              ? JSON.parse(binding)
              : [binding],
          ),
        ]),
      ).toEqual(new Set([...roots, ...roots.map((root) => `.${root}`)]));
      expect(optimized).toEqual([
        "case-and-space",
        "literal-backslash",
        "literal-percent",
        "literal-underscore",
        "other-root",
        "other-subdomain",
        "regional-subdomain",
        "root",
        "subdomain",
      ]);
      expect(
        database
          .prepare(
            `EXPLAIN QUERY PLAN SELECT id FROM visits WHERE ${optimizedClause}`,
          )
          .all(JSON.stringify(roots), JSON.stringify(roots))
          .map((row) => (row as { detail: string }).detail)
          .join("\n"),
      ).toContain("SCAN roots VIRTUAL TABLE");
    } finally {
      database.close();
    }
  });

  it("preserves SQLite results when finite-set logic is normalized", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("CREATE TABLE visits (id TEXT PRIMARY KEY, pathname TEXT)");
      const insert = database.prepare(
        "INSERT INTO visits (id, pathname) VALUES (?, ?)",
      );
      for (const [id, pathname] of [
        ["docs", "/docs"],
        ["pricing", "/pricing"],
        ["guide", "/guide"],
        ["home", "/home"],
        ["internal", "/internal"],
        ["preview", "/preview"],
        ["other", "/other"],
      ]) {
        insert.run(id, pathname);
      }
      const raw = {
        version: 1,
        root: {
          kind: "and",
          children: [
            {
              kind: "or",
              children: [
                {
                  kind: "condition",
                  target: { kind: "field", field: "page.path" },
                  operator: "eq",
                  value: "/docs",
                },
                {
                  kind: "condition",
                  target: { kind: "field", field: "page.path" },
                  operator: "in",
                  value: ["/pricing", "/guide"],
                },
              ],
            },
            {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "notIn",
              value: ["/internal"],
            },
            {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "notIn",
              value: ["/preview"],
            },
          ],
        },
      } as const;
      const normalized = document(raw.root);
      const compiled = compileFilterDocument(normalized);
      const ids = (sql: string, bindings: readonly string[]) =>
        database
          .prepare(sql)
          .all(...bindings)
          .map((row) => (row as { id: string }).id);
      const baseline = ids(
        `SELECT id FROM visits WHERE
          (TRIM(COALESCE(pathname, '')) = ? OR TRIM(COALESCE(pathname, '')) IN (?, ?))
          AND TRIM(COALESCE(pathname, '')) NOT IN (?)
          AND TRIM(COALESCE(pathname, '')) NOT IN (?)
          ORDER BY id`,
        ["/docs", "/pricing", "/guide", "/internal", "/preview"],
      );
      const optimized = ids(
        `SELECT id FROM visits AS visit_source ${compiled.clause} ORDER BY id`,
        compiled.bindings as readonly string[],
      );

      expect(optimized).toEqual(baseline);
      expect(optimized).toEqual(["docs", "guide", "pricing"]);
      expect(compiled.bindings).toHaveLength(5);
      expect(compiled.clause).toContain(" IN (?");
      expect(compiled.clause).toContain("NOT IN (?, ?)");
    } finally {
      database.close();
    }
  });

  it("lowers compatible OR leaves by typed AST shape rather than field identity", () => {
    const result = compileFilterDocument(
      document({
        kind: "or",
        children: [
          {
            kind: "condition",
            target: { kind: "field", field: "page.path" },
            operator: "eq",
            value: "/docs",
          },
          {
            kind: "condition",
            target: { kind: "field", field: "page.path" },
            operator: "eq",
            value: "/pricing",
          },
          {
            kind: "condition",
            target: { kind: "field", field: "page.title" },
            operator: "contains",
            value: "Pricing",
          },
          {
            kind: "condition",
            target: { kind: "field", field: "page.title" },
            operator: "contains",
            value: "Compare",
          },
        ],
      }),
      { alias: "vs" },
    );

    expect(result.clause).toContain(
      "TRIM(COALESCE(vs.pathname, '')) IN (?, ?)",
    );
    expect(result.clause).toContain("FROM json_each(?) AS filter_or_like_0");
    expect(result.bindings).toHaveLength(3);
  });

  it("lowers startsWith OR leaves with the same escaped JSON set", () => {
    const result = compileFilterDocument(
      document({
        kind: "or",
        children: [
          {
            kind: "condition",
            target: { kind: "field", field: "page.path" },
            operator: "startsWith",
            value: "/docs",
          },
          {
            kind: "condition",
            target: { kind: "field", field: "page.path" },
            operator: "startsWith",
            value: "/guide",
          },
        ],
      }),
    );

    expect(result.clause).toContain("LIKE");
    expect(result.clause).toContain(" || '%'");
    expect(result.bindings).toHaveLength(1);
  });

  it("falls back per leaf when an OR group contains non-vector conditions", () => {
    const result = compileFilterDocument(
      document({
        kind: "or",
        children: [
          {
            kind: "not",
            child: {
              kind: "condition",
              target: { kind: "field", field: "page.path" },
              operator: "eq",
              value: "/private",
            },
          },
          {
            kind: "condition",
            target: { kind: "field", field: "session.entryPath" },
            operator: "eq",
            value: "/landing",
          },
          {
            kind: "condition",
            target: { kind: "field", field: "session.entryPath" },
            operator: "eq",
            value: "/home",
          },
        ],
      }),
    );

    expect(result.clause).toContain("NOT (");
    expect(result.clause).toContain("ROW_NUMBER() OVER");
    expect(result.clause).not.toContain("json_each(?)");
  });

  it("compiles nested visit predicates with bound values and escaped LIKE", () => {
    const result = compileFilterDocument(
      document({
        kind: "and",
        children: [
          {
            kind: "condition",
            target: { kind: "field", field: "geo.country" },
            operator: "eq",
            value: "US",
          },
          {
            kind: "not",
            child: {
              kind: "condition",
              target: { kind: "field", field: "page.title" },
              operator: "contains",
              value: "100%_ready\\go",
            },
          },
        ],
      }),
      { alias: "vs" },
    );

    expect(result.clause).toContain("WHERE (");
    expect(result.clause).toContain(
      "LOWER(TRIM(COALESCE(vs.country, ''))) = ?",
    );
    expect(result.clause).toContain("LIKE ? ESCAPE '\\'");
    expect(result.clause).toContain("NOT (");
    expect(result.bindings).toEqual(["%100\\%\\_ready\\\\go%", "us"]);
  });

  it("compresses large sets into one json_each binding", () => {
    const values = Array.from({ length: 8 }, (_, index) => `/path-${index}`);
    const result = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "field", field: "page.path" },
        operator: "in",
        value: values,
      }),
      { alias: "vs" },
    );

    expect(result.clause).toContain(
      "TRIM(COALESCE(vs.pathname, '')) IN (SELECT value FROM json_each(?))",
    );
    expect(result.clause).not.toContain("pathname IN (?,");
    expect(result.bindings).toEqual([JSON.stringify(values)]);
  });

  it("keeps payload set type checks while compressing string sets", () => {
    const values = Array.from({ length: 8 }, (_, index) => `value-${index}`);
    const result = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "event-payload", path: "/plan" },
        operator: "in",
        value: values,
      }),
      { alias: "es", eventAlias: "es" },
    );

    expect(result.clause).toContain("json_each(?)");
    expect(result.bindings).toEqual(["/plan", JSON.stringify(values), 1]);
  });

  it("keeps small direct sets scalar-bound", () => {
    const result = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "field", field: "page.path" },
        operator: "in",
        value: ["/docs", "/pricing"],
      }),
    );

    expect(result.clause).toContain(" IN (?, ?)");
    expect(result.clause).not.toContain("json_each(?)");
    expect(result.bindings).toEqual(["/docs", "/pricing"]);
  });

  it("keeps small payload NOT IN sets typed and rejects mixed payload sets", () => {
    const result = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "event-payload", path: "/plan" },
        operator: "notIn",
        value: ["free", "trial"],
      }),
      { alias: "es", eventAlias: "es" },
    );
    expect(result.clause).toContain("NOT IN (?, ?)");
    expect(result.bindings).toEqual(["/plan", "free", "trial", 1]);

    expect(() =>
      compileFilterDocument(
        document({
          kind: "condition",
          target: { kind: "event-payload", path: "/score" },
          operator: "in",
          value: ["free", 1],
        }),
      ),
    ).toThrow("one JSON type");

    expect(() =>
      compileFilterDocument(
        document({
          kind: "condition",
          target: { kind: "event-payload", path: "/score" },
          operator: "contains",
          value: 42,
        }),
      ),
    ).toThrow("requires a string");
  });

  it("binds true JSON payload values as booleans", () => {
    const result = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "event-payload", path: "/enabled" },
        operator: "eq",
        value: true,
      }),
      { alias: "es", eventAlias: "es" },
    );
    expect(result.bindings).toEqual(["/enabled", 3, 1]);
  });

  it("compiles null payload sets and typed payload ranges", () => {
    expect(() =>
      compileFilterDocument(
        document({
          kind: "condition",
          target: { kind: "event-payload", path: "/nullable" },
          operator: "in",
          value: [null],
        }),
        { alias: "es", eventAlias: "es" },
      ),
    ).toThrow("non-null scalar");

    const range = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "event-payload", path: "/score" },
        operator: "between",
        value: [10, 20],
      }),
      { alias: "es", eventAlias: "es" },
    );
    expect(range.clause).toContain("BETWEEN");
    expect(range.bindings).toEqual(["/score", 2, 10, 20]);
  });

  it("keeps payload missing, JSON null, empty, false, and zero distinct", () => {
    const result = compileFilterDocument(
      document({
        kind: "and",
        children: [
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/missing" },
            operator: "notExists",
          },
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/null" },
            operator: "isNull",
          },
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/empty" },
            operator: "isEmpty",
          },
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/paid" },
            operator: "eq",
            value: false,
          },
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/score" },
            operator: "eq",
            value: 0,
          },
        ],
      }),
      { alias: "es", eventAlias: "es" },
    );

    expect(result.clause).toContain("NOT EXISTS");
    expect(result.clause).toContain("value_type = 0");
    expect(result.clause).toContain("string_value = ''");
    expect(result.clause).toContain("boolean_value = ?");
    expect(result.clause).toContain("number_value = ?");
    expect(result.bindings).toEqual([
      "/empty",
      "/missing",
      "/null",
      "/paid",
      3,
      0,
      "/score",
      2,
      0,
    ]);
  });

  it("uses the stable session-boundary strategy and rejects dynamic aliases", () => {
    const entry = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "field", field: "session.entryPath" },
        operator: "eq",
        value: "/pricing",
      }),
      { alias: "visit_source" },
    );
    expect(entry.clause).toContain("ROW_NUMBER() OVER");
    expect(entry.clause).toContain(
      "ORDER BY edge.started_at ASC, edge.visit_id ASC",
    );
    expect(entry.bindings).toEqual(["/pricing"]);
    expect(() =>
      compileFilterDocument(
        document({
          kind: "condition",
          target: { kind: "field", field: "page.path" },
          operator: "eq",
          value: "/",
        }),
        {
          alias: "vs; drop table visits",
        },
      ),
    ).toThrow(/internal SQL identifier/);
  });

  it("compiles the direct referrer sentinel as an empty stored referrer", () => {
    const result = compileFilterDocument(
      document({
        kind: "condition",
        target: { kind: "field", field: "referrer.domain" },
        operator: "eq",
        value: "__direct__",
      }),
      { alias: "vs" },
    );
    expect(result.clause).toContain(
      "LOWER(TRIM(COALESCE(vs.referrer_host, ''))) = ''",
    );
    expect(result.bindings).toEqual([]);
  });

  it("keeps the direct referrer sentinel in generic OR lowering", () => {
    const result = compileFilterDocument(
      document({
        kind: "or",
        children: [
          {
            kind: "condition",
            target: { kind: "field", field: "referrer.domain" },
            operator: "eq",
            value: "__direct__",
          },
          {
            kind: "condition",
            target: { kind: "field", field: "referrer.domain" },
            operator: "eq",
            value: "google.com",
          },
        ],
      }),
    );

    expect(result.clause).toContain("IN (?, ?)");
    expect(result.bindings).toEqual(["", "google.com"]);
  });
});
