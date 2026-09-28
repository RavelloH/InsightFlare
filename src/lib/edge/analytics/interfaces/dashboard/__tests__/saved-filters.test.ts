import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { handleSavedFilters } from "@/lib/edge/analytics/interfaces/dashboard/saved-filters";
import type { Env } from "@/lib/edge/types";

type Binding = string | number | null;
type D1Row = Record<string, unknown>;
interface PreparedCall {
  readonly sql: string;
  readonly bindings: readonly Binding[];
}

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: Binding[],
  ) {}

  async all<T extends D1Row>(): Promise<{ results: T[] }> {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...this.bindings)
        .map((row) => ({ ...row }) as T),
    };
  }

  async first<T extends D1Row>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.bindings);
    return row ? ({ ...row } as T) : null;
  }

  async run(): Promise<{ success: boolean }> {
    this.database.prepare(this.sql).run(...this.bindings);
    return { success: true };
  }
}

class SqliteD1Database {
  readonly database = new DatabaseSync(":memory:");
  readonly operations: PreparedCall[] = [];

  prepare(sql: string) {
    return {
      bind: (...bindings: Binding[]) => {
        this.operations.push({ sql, bindings });
        return new SqliteStatement(this.database, sql, bindings);
      },
    };
  }

  close(): void {
    this.database.close();
  }
}

const session = {
  userId: "user-1",
  username: "owner",
  displayName: "Owner",
  systemRole: "user" as const,
  exp: 9_999_999_999,
};

function request(method: string, body?: unknown, query = ""): Request {
  return new Request(
    `https://app.test/api/private/saved-filters?siteId=site-1${query}`,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
  );
}

function createEnv(): { env: Env; d1: SqliteD1Database } {
  const d1 = new SqliteD1Database();
  d1.database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      password_hash TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      username TEXT UNIQUE,
      system_role TEXT NOT NULL DEFAULT 'user',
      timezone TEXT NOT NULL DEFAULT '',
      notification_preferences_json TEXT NOT NULL DEFAULT '{}',
      preferred_locale TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE saved_filters (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      scope_preference TEXT NOT NULL DEFAULT 'auto',
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      filter_dsl TEXT NOT NULL,
      filter_dsl_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_saved_filters_site_owner_updated
      ON saved_filters(site_id, owner_user_id, updated_at DESC, id DESC);
    CREATE INDEX idx_saved_filters_site_visibility_updated
      ON saved_filters(site_id, visibility, updated_at DESC, id DESC);
    INSERT INTO users (id, email, username, name) VALUES
      ('user-1', 'owner@example.test', 'owner', 'Owner'),
      ('user-2', 'teammate@example.test', 'teammate', 'Teammate');
    INSERT INTO saved_filters (
      id, site_id, owner_user_id, visibility, name, description, filter_dsl,
      filter_dsl_version, created_at, updated_at
    ) VALUES
      ('own-private', 'site-1', 'user-1', 'private', 'Own private', '', 'page.path eq "/docs"', 1, 10, 10),
      ('team-shared', 'site-1', 'user-2', 'team', 'Team shared', 'Shared description', 'geo.country eq "cn"', 1, 20, 20),
      ('other-private', 'site-1', 'user-2', 'private', 'Other private', '', 'client.browser eq "Chrome"', 1, 30, 30);
  `);
  return {
    env: {
      DB: d1 as unknown as D1Database,
      MAIN_SECRET: "saved-filter-test-secret",
    } as Env,
    d1,
  };
}

function explain(d1: SqliteD1Database, call: PreparedCall): string[] {
  return d1.database
    .prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
    .all(...call.bindings)
    .map((row) => String(row.detail));
}

describe("saved filters", () => {
  const databases: SqliteD1Database[] = [];

  afterEach(() => {
    while (databases.length > 0) databases.pop()?.close();
  });

  function context() {
    const created = createEnv();
    databases.push(created.d1);
    return created;
  }

  it("lists own filters and team-visible filters for the site", async () => {
    const { env } = context();
    const response = await handleSavedFilters(request("GET"), env, {
      siteId: "site-1",
      session,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          id: "team-shared",
          isOwner: false,
          authorName: "Teammate",
          scopePreference: "auto",
        },
        {
          id: "own-private",
          isOwner: true,
          authorName: "Owner",
          scopePreference: "auto",
        },
      ],
      pagination: {
        limit: 100,
        returned: 2,
        hasMore: false,
        nextCursor: null,
      },
    });
  });

  it("preserves raw DSL exactly when creating a valid saved filter", async () => {
    const { env, d1 } = context();
    const filterDsl = 'NOT (page.path eq "/docs" OR page.path eq "/blog")';
    const response = await handleSavedFilters(
      request("POST", {
        name: "Docs or blog",
        description: "Exact source is preserved",
        visibility: "team",
        scopePreference: "event",
        filterDsl,
      }),
      env,
      { siteId: "site-1", session },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      filter: {
        name: "Docs or blog",
        filterDsl,
        visibility: "team",
        scopePreference: "event",
      },
    });
    expect(
      d1.database
        .prepare(
          "SELECT filter_dsl, scope_preference FROM saved_filters WHERE name = ?",
        )
        .get("Docs or blog"),
    ).toEqual({ filter_dsl: filterDsl, scope_preference: "event" });
  });

  it("defaults missing scope, rejects invalid scope, and scopes duplicate checks", async () => {
    const { env } = context();
    const base = { name: "A filter", description: "", visibility: "private" };
    const empty = await handleSavedFilters(
      request("POST", { ...base, filterDsl: "" }),
      env,
      { siteId: "site-1", session },
    );
    const invalid = await handleSavedFilters(
      request("POST", { ...base, filterDsl: 'page.path unknown "/docs"' }),
      env,
      { siteId: "site-1", session },
    );
    const defaulted = await handleSavedFilters(
      request("POST", {
        ...base,
        filterDsl: 'page.path eq "/pricing"',
      }),
      env,
      { siteId: "site-1", session },
    );
    const invalidScope = await handleSavedFilters(
      request("POST", {
        ...base,
        scopePreference: "account",
        filterDsl: 'page.path eq "/pricing"',
      }),
      env,
      { siteId: "site-1", session },
    );
    const duplicate = await handleSavedFilters(
      request("POST", { ...base, filterDsl: 'page.path eq "/docs"' }),
      env,
      { siteId: "site-1", session },
    );
    const differentScope = await handleSavedFilters(
      request("POST", {
        ...base,
        scopePreference: "session",
        filterDsl: 'page.path eq "/docs"',
      }),
      env,
      { siteId: "site-1", session },
    );

    expect(empty.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(defaulted.status).toBe(201);
    await expect(defaulted.json()).resolves.toMatchObject({
      filter: { scopePreference: "auto" },
    });
    expect(invalidScope.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(differentScope.status).toBe(201);
  });

  it("allows shared reads but denies non-owner updates and deletes", async () => {
    const { env } = context();
    const shared = await handleSavedFilters(request("GET"), env, {
      siteId: "site-1",
      session,
      filterId: "team-shared",
    });
    const hidden = await handleSavedFilters(request("GET"), env, {
      siteId: "site-1",
      session,
      filterId: "other-private",
    });
    const update = await handleSavedFilters(
      request("PUT", {
        name: "Nope",
        description: "",
        visibility: "team",
        filterDsl: 'page.path eq "/docs"',
      }),
      env,
      { siteId: "site-1", session, filterId: "team-shared" },
    );
    const deletion = await handleSavedFilters(request("DELETE"), env, {
      siteId: "site-1",
      session,
      filterId: "team-shared",
    });

    expect(shared.status).toBe(200);
    expect(hidden.status).toBe(404);
    expect(update.status).toBe(403);
    expect(deletion.status).toBe(403);
  });

  it("updates and deletes filters owned by the current user", async () => {
    const { env, d1 } = context();
    const update = await handleSavedFilters(
      request("PUT", {
        name: "Updated filter",
        description: "Updated description",
        visibility: "team",
        scopePreference: "visitor",
        filterDsl: 'referrer.domain in ["google.com", "news.example.com"]',
      }),
      env,
      { siteId: "site-1", session, filterId: "own-private" },
    );
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      filter: {
        id: "own-private",
        name: "Updated filter",
        visibility: "team",
        scopePreference: "visitor",
      },
    });
    expect(
      d1.database
        .prepare(
          "SELECT filter_dsl, filter_dsl_version, scope_preference FROM saved_filters WHERE id = ?",
        )
        .get("own-private"),
    ).toEqual({
      filter_dsl: 'referrer.domain in ["google.com", "news.example.com"]',
      filter_dsl_version: 1,
      scope_preference: "visitor",
    });
    const deletion = await handleSavedFilters(request("DELETE"), env, {
      siteId: "site-1",
      session,
      filterId: "own-private",
    });
    expect(deletion.status).toBe(200);
    expect(
      d1.database
        .prepare("SELECT id FROM saved_filters WHERE id = ?")
        .get("own-private"),
    ).toBeUndefined();
  });

  it("matches the legacy SQLite keyset pages and keeps the query count", async () => {
    const { env, d1 } = context();
    d1.database.exec(`
      INSERT INTO saved_filters (
        id, site_id, owner_user_id, visibility, name, description, filter_dsl,
        filter_dsl_version, created_at, updated_at
      ) VALUES
        ('own-tie-a', 'site-1', 'user-1', 'private', 'Own tie A', '', 'page.path eq "/a"', 1, 1, 20),
        ('own-tie-z', 'site-1', 'user-1', 'private', 'Own tie Z', '', 'page.path eq "/z"', 1, 1, 20),
        ('team-tie-m', 'site-1', 'user-2', 'team', 'Team tie M', '', 'page.path eq "/m"', 1, 1, 20),
        ('wrong-site', 'site-1-other', 'user-1', 'team', 'Wrong site', '', 'page.path eq "/wrong-site"', 1, 1, 99);
    `);
    const legacyPage = d1.database
      .prepare(
        `
        SELECT id, updated_at AS updatedAt
        FROM saved_filters
        WHERE site_id = ? AND (owner_user_id = ? OR visibility = 'team')
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `,
      )
      .all("site-1", session.userId, 3) as Array<{
      id: string;
      updatedAt: number;
    }>;
    const first = await handleSavedFilters(
      request("GET", undefined, "&limit=2"),
      env,
      { siteId: "site-1", session },
    );
    const firstBody = (await first.json()) as {
      items: Array<{ id: string; updatedAt: number }>;
      pagination: {
        limit: number;
        returned: number;
        hasMore: boolean;
        nextCursor: string | null;
      };
    };

    expect(firstBody.items.map(({ id }) => id)).toEqual(
      legacyPage.slice(0, 2).map(({ id }) => id),
    );
    expect(firstBody.pagination).toMatchObject({
      limit: 2,
      returned: 2,
      hasMore: true,
    });
    expect(firstBody.pagination.nextCursor).toEqual(expect.any(String));
    expect(d1.operations).toHaveLength(1);
    expect(
      explain(d1, d1.operations[0]!).some((detail) =>
        /idx_saved_filters_site_(owner|visibility)_updated/u.test(detail),
      ),
    ).toBe(true);

    d1.operations.length = 0;
    const cursor = firstBody.pagination.nextCursor;
    const last = firstBody.items.at(-1)!;
    const legacyNext = d1.database
      .prepare(
        `
        SELECT id, updated_at AS updatedAt
        FROM saved_filters
        WHERE site_id = ?
          AND (owner_user_id = ? OR visibility = 'team')
          AND (updated_at < ? OR (updated_at = ? AND id < ?))
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `,
      )
      .all(
        "site-1",
        session.userId,
        last.updatedAt,
        last.updatedAt,
        last.id,
        3,
      ) as Array<{ id: string; updatedAt: number }>;
    const next = await handleSavedFilters(
      request(
        "GET",
        undefined,
        `&limit=2&cursor=${encodeURIComponent(cursor!)}`,
      ),
      env,
      { siteId: "site-1", session },
    );
    const nextBody = (await next.json()) as {
      items: Array<{ id: string; updatedAt: number }>;
      pagination: {
        limit: number;
        returned: number;
        hasMore: boolean;
        nextCursor: string | null;
      };
    };
    expect(nextBody.items.map(({ id }) => id)).toEqual(
      legacyNext.slice(0, 2).map(({ id }) => id),
    );
    expect(nextBody.pagination).toMatchObject({
      limit: 2,
      returned: Math.min(legacyNext.length, 2),
      hasMore: legacyNext.length > 2,
      nextCursor: legacyNext.length > 2 ? expect.any(String) : null,
    });
    expect(d1.operations).toHaveLength(1);
  });

  it("preserves author fallback and CRUD query counts and query plans", async () => {
    const { env, d1 } = context();
    d1.database
      .prepare(
        "UPDATE users SET name = '', username = 'fallback-user' WHERE id = ?",
      )
      .run("user-2");
    const shared = await handleSavedFilters(request("GET"), env, {
      siteId: "site-1",
      session,
      filterId: "team-shared",
    });
    await expect(shared.json()).resolves.toMatchObject({
      filter: { authorName: "fallback-user" },
    });
    expect(d1.operations).toHaveLength(1);
    expect(explain(d1, d1.operations[0]!).join(" ")).toMatch(
      /sqlite_autoindex_saved_filters_1/u,
    );

    d1.operations.length = 0;
    d1.database
      .prepare("UPDATE users SET username = NULL WHERE id = ?")
      .run("user-2");
    const noAuthorName = await handleSavedFilters(request("GET"), env, {
      siteId: "site-1",
      session,
      filterId: "team-shared",
    });
    await expect(noAuthorName.json()).resolves.toMatchObject({
      filter: { authorName: "Unknown" },
    });

    d1.operations.length = 0;
    const filterDsl = 'page.path eq "/created"';
    const duplicate = await handleSavedFilters(
      request("POST", {
        name: "Created",
        description: "",
        visibility: "private",
        filterDsl,
      }),
      env,
      { siteId: "site-1", session },
    );
    expect(duplicate.status).toBe(201);
    expect(d1.operations).toHaveLength(3);
    expect(d1.operations[1]?.sql).toMatch(/^INSERT INTO "saved_filters"/u);

    d1.operations.length = 0;
    const duplicateCreate = await handleSavedFilters(
      request("POST", {
        name: "Created again",
        description: "",
        visibility: "team",
        filterDsl,
      }),
      env,
      { siteId: "site-1", session },
    );
    expect(duplicateCreate.status).toBe(400);
    expect(d1.operations).toHaveLength(1);
    expect(explain(d1, d1.operations[0]!).join(" ")).toMatch(
      /idx_saved_filters_site_owner_updated/u,
    );

    d1.operations.length = 0;
    const updated = await handleSavedFilters(
      request("PUT", {
        name: "Updated",
        description: "",
        visibility: "team",
        filterDsl: 'page.path eq "/created-updated"',
      }),
      env,
      { siteId: "site-1", session, filterId: "own-private" },
    );
    expect(updated.status).toBe(200);
    expect(d1.operations).toHaveLength(4);
    expect(d1.operations[2]?.sql).toMatch(/^UPDATE "saved_filters"/u);

    d1.operations.length = 0;
    const deleted = await handleSavedFilters(request("DELETE"), env, {
      siteId: "site-1",
      session,
      filterId: "own-private",
    });
    expect(deleted.status).toBe(200);
    expect(d1.operations).toHaveLength(2);
    expect(d1.operations[1]?.sql).toMatch(/^DELETE FROM "saved_filters"/u);
  });
});
