import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Mutation,
  createD1DatabaseClient,
  deleteFrom,
  eq,
  param,
  schema,
  update,
} from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  accountDeletionMutations,
  memberDepartureImpact,
  memberDepartureMutations,
  siteTransferMutations,
} from "@/lib/edge/admin/owned-resources";
import type { Env } from "@/lib/edge/types";

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function fixture() {
  const database = createMigratedDatabase();
  database.function("unixepoch", () => 500);
  databases.add(database);
  const user = database.prepare(
    "INSERT INTO users (id,email,username) VALUES (?,?,?)",
  );
  for (const id of ["owner-a", "owner-b", "member"])
    user.run(id, `${id}@example.test`, id);
  const team = database.prepare(
    "INSERT INTO teams (id,name,slug,owner_user_id) VALUES (?,?,?,?)",
  );
  team.run("team-a", "A", "a", "owner-a");
  team.run("team-b", "B", "b", "owner-b");
  const member = database.prepare(
    "INSERT INTO team_members (team_id,user_id,role) VALUES (?,?,?)",
  );
  member.run("team-a", "owner-a", "owner");
  member.run("team-b", "owner-b", "owner");
  member.run("team-a", "member", "member");
  member.run("team-b", "member", "member");
  const site = database.prepare(
    "INSERT INTO sites (id,team_id,name,domain) VALUES (?,?,?,?)",
  );
  site.run("site-a1", "team-a", "A1", "a1.test");
  site.run("site-a2", "team-a", "A2", "a2.test");
  site.run("site-b1", "team-b", "B1", "b1.test");
  const filter = database.prepare(
    "INSERT INTO saved_filters (id,site_id,owner_user_id,visibility,name,filter_dsl,updated_at) VALUES (?,?,?,?,?,?,1)",
  );
  filter.run("a1-private", "site-a1", "member", "private", "p", "x");
  filter.run("a2-shared", "site-a2", "member", "team", "s", "x");
  filter.run("b1-private", "site-b1", "member", "private", "p", "x");
  filter.run("b1-shared", "site-b1", "member", "team", "s", "x");
  filter.run("a1-other", "site-a1", "owner-a", "team", "o", "x");
  const env = { DB: createSqliteD1Database(database) } as unknown as Env;
  const rows = () =>
    database
      .prepare(
        "SELECT id, owner_user_id AS owner, updated_at AS updatedAt FROM saved_filters ORDER BY id",
      )
      .all();
  return { database, env, rows };
}

describe("owned resource lifecycle", () => {
  it("counts and applies a member departure only inside that team", async () => {
    const { env, rows } = fixture();
    expect(await memberDepartureImpact(env, "team-a", "member")).toEqual({
      deleted: 1,
      transferred: 1,
    });

    await createD1DatabaseClient(env.DB).batch(
      memberDepartureMutations("team-a", "member"),
    );

    expect(rows()).toEqual([
      { id: "a1-other", owner: "owner-a", updatedAt: 1 },
      { id: "a2-shared", owner: "owner-a", updatedAt: 500 },
      { id: "b1-private", owner: "member", updatedAt: 1 },
      { id: "b1-shared", owner: "member", updatedAt: 1 },
    ]);
    expect(await memberDepartureImpact(env, "team-a", "member")).toEqual({
      deleted: 0,
      transferred: 0,
    });
  });

  it("hands shared resources to each site's team owner before deleting an account", async () => {
    const { database, env, rows } = fixture();
    await createD1DatabaseClient(env.DB).batch([
      ...accountDeletionMutations("member"),
      compileD1Mutation(
        deleteFrom(schema.users, (columns) => eq(columns.id, param("member"))),
      ),
    ]);

    expect(rows()).toEqual([
      { id: "a1-other", owner: "owner-a", updatedAt: 1 },
      { id: "a2-shared", owner: "owner-a", updatedAt: 500 },
      { id: "b1-shared", owner: "owner-b", updatedAt: 500 },
    ]);
    expect(
      database.prepare("SELECT id FROM users WHERE id = 'member'").get(),
    ).toBeUndefined();
  });

  it("moves only outsiders' resources when a site changes team", async () => {
    const { database, env, rows } = fixture();
    database
      .prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
      .run("team-b", "member");
    await createD1DatabaseClient(env.DB).batch([
      compileD1Mutation(
        update(schema.sites, (columns) => ({
          set: { team_id: "team-b" },
          where: eq(columns.id, param("site-a1")),
        })),
      ),
      ...siteTransferMutations("site-a1", "team-b"),
    ]);
    expect(rows()).toEqual([
      { id: "a1-other", owner: "owner-b", updatedAt: 500 },
      { id: "a2-shared", owner: "member", updatedAt: 1 },
      { id: "b1-private", owner: "member", updatedAt: 1 },
      { id: "b1-shared", owner: "member", updatedAt: 1 },
    ]);
  });

  it("keeps the restrict guard: without cleanup the account delete fails", () => {
    const { database } = fixture();
    expect(() =>
      database.prepare("DELETE FROM users WHERE id = ?").run("member"),
    ).toThrow(/FOREIGN KEY/);
  });
});
