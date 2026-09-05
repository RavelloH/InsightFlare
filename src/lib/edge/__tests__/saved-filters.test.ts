import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { handleSavedFilters } from "@/lib/edge/saved-filters";
import type { Env } from "@/lib/edge/types";

type Binding = string | number | null;
type D1Row = Record<string, unknown>;

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

  prepare(sql: string) {
    return {
      bind: (...bindings: Binding[]) =>
        new SqliteStatement(this.database, sql, bindings),
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

function request(method: string, body?: unknown): Request {
  return new Request(
    "https://app.test/api/private/saved-filters?siteId=site-1",
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
      username TEXT NOT NULL,
      name TEXT
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
    INSERT INTO users (id, username, name) VALUES
      ('user-1', 'owner', 'Owner'),
      ('user-2', 'teammate', 'Teammate');
    INSERT INTO saved_filters (
      id, site_id, owner_user_id, visibility, name, description, filter_dsl,
      filter_dsl_version, created_at, updated_at
    ) VALUES
      ('own-private', 'site-1', 'user-1', 'private', 'Own private', '', 'page.path eq "/docs"', 1, 10, 10),
      ('team-shared', 'site-1', 'user-2', 'team', 'Team shared', 'Shared description', 'geo.country eq "cn"', 1, 20, 20),
      ('other-private', 'site-1', 'user-2', 'private', 'Other private', '', 'client.browser eq "Chrome"', 1, 30, 30);
  `);
  return { env: { DB: d1 as unknown as D1Database } as Env, d1 };
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
});
