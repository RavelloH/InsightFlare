import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { handleAdminWs } from "@/lib/edge/admin/ws";
import { setE2eClock } from "@/lib/edge/runtime/e2e-clock";
import { deriveSecret, SECRET_PURPOSES } from "@/lib/secrets";

const CLOCK_KEY = "__insightflare_e2e_clock__";

afterEach(() => {
  Reflect.deleteProperty(globalThis, CLOCK_KEY);
});

function bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function toArrayBuffer(input: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(input.length);
  out.set(input);
  return out.buffer;
}

function base64UrlEncode(input: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < input.length; i += 1) {
    binary += String.fromCharCode(input[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function hmacSha256(
  message: string,
  secret: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(bytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(bytes(message)),
  );
  return new Uint8Array(sig);
}

async function sessionToken(
  claims: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const payload = base64UrlEncode(bytes(JSON.stringify(claims)));
  const signature = await hmacSha256(payload, secret);
  return `${payload}.${base64UrlEncode(signature)}`;
}

async function dashboardSecret(root = "root-secret"): Promise<string> {
  return deriveSecret(root, SECRET_PURPOSES.dashboardSession);
}

function dbWithRows(rows: Record<string, unknown>[]) {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => rows.shift() ?? null),
      })),
    })),
  };
}

describe("handleAdminWs", () => {
  it("rejects requests when session secrets or tokens are invalid", async () => {
    const unavailable = await handleAdminWs(
      new Request("https://app.test/api/private/realtime/ws?siteId=site-1"),
      { DB: dbWithRows([]), INGEST_DO: {} } as any,
    );
    expect(unavailable.status).toBe(503);

    const unauthorized = await handleAdminWs(
      new Request("https://app.test/api/private/realtime/ws?siteId=site-1", {
        headers: { authorization: "Bearer invalid" },
      }),
      { MAIN_SECRET: "root", DB: dbWithRows([]), INGEST_DO: {} } as any,
    );
    expect(unauthorized.status).toBe(401);
  });

  it("uses the controlled clock when validating websocket sessions", async () => {
    const root = "root-secret";
    const secret = await dashboardSecret(root);
    const token = await sessionToken(
      {
        userId: "user-1",
        username: "admin",
        systemRole: "admin",
        exp: 1_001,
      },
      secret,
    );
    setE2eClock(1_001_000);

    const response = await handleAdminWs(
      new Request("https://app.test/api/private/realtime/ws?siteId=site-1", {
        headers: { authorization: `Bearer ${token}` },
      }),
      { MAIN_SECRET: root, DB: dbWithRows([]), INGEST_DO: {} } as any,
    );

    expect(response.status).toBe(401);
  });

  it("checks site access and forwards websocket requests to the ingest DO", async () => {
    const root = "root-secret";
    const secret = await dashboardSecret(root);
    const token = await sessionToken(
      {
        userId: "user-1",
        username: "admin",
        systemRole: "admin",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      secret,
    );
    const fetchMock = vi.fn(async (_request: Request) =>
      Promise.resolve(new Response("upgraded")),
    );
    const env = {
      MAIN_SECRET: root,
      DB: dbWithRows([{ id: "site-1" }]),
      INGEST_DO: {
        idFromName: vi.fn(() => "do-id"),
        get: vi.fn(() => ({ fetch: fetchMock })),
      },
    };

    const response = await handleAdminWs(
      new Request("https://app.test/api/private/realtime/ws?siteId=site-1", {
        headers: { authorization: `Bearer ${token}` },
      }),
      env as any,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("upgraded");
    expect(env.INGEST_DO.idFromName).toHaveBeenCalledWith("site-1");
    expect(fetchMock).toHaveBeenCalledWith(expect.any(Request));
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe("https://ingest.internal/ws?siteId=site-1");
  });

  it("returns forbidden for a system admin when the site does not exist", async () => {
    const root = "root-secret";
    const secret = await dashboardSecret(root);
    const token = await sessionToken(
      {
        userId: "user-1",
        username: "admin",
        systemRole: "admin",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      secret,
    );
    const db = dbWithRows([]);

    const response = await handleAdminWs(
      new Request("https://app.test/api/private/realtime/ws?siteId=missing", {
        headers: { authorization: `Bearer ${token}` },
      }),
      { MAIN_SECRET: root, DB: db, INGEST_DO: {} } as any,
    );

    expect(response.status).toBe(403);
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it("rejects missing and unauthorized site ids", async () => {
    const root = "root-secret";
    const secret = await dashboardSecret(root);
    const token = await sessionToken(
      {
        userId: "user-1",
        username: "user",
        systemRole: "user",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      secret,
    );
    const headers = { authorization: `Bearer ${token}` };

    const missing = await handleAdminWs(
      new Request("https://app.test/api/private/realtime/ws", { headers }),
      {
        MAIN_SECRET: root,
        DB: dbWithRows([]),
        INGEST_DO: {},
      } as any,
    );
    expect(missing.status).toBe(400);

    const forbidden = await handleAdminWs(
      new Request("https://app.test/api/private/realtime/ws?siteId=site-1", {
        headers,
      }),
      {
        MAIN_SECRET: root,
        DB: dbWithRows([null as any]),
        INGEST_DO: {},
      } as any,
    );
    expect(forbidden.status).toBe(403);
  });

  it("rejects realtime access for members outside their site range", async () => {
    const root = "root-secret";
    const secret = await dashboardSecret(root);
    const token = await sessionToken(
      {
        userId: "user-1",
        username: "user",
        systemRole: "user",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      secret,
    );

    const denied = await handleAdminWs(
      new Request("https://app.test/api/private/realtime/ws?siteId=site-1", {
        headers: { authorization: `Bearer ${token}` },
      }),
      {
        MAIN_SECRET: root,
        DB: dbWithRows([
          {
            id: "site-1",
            ownerUserId: "owner-1",
            role: "member",
            siteIdsJson: '["site-2"]',
          },
        ]),
        INGEST_DO: {},
      } as any,
    );

    expect(denied.status).toBe(403);
  });

  it("allows realtime access for unrestricted ordinary members", async () => {
    const root = "root-secret";
    const secret = await dashboardSecret(root);
    const token = await sessionToken(
      {
        userId: "user-1",
        username: "user",
        systemRole: "user",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      secret,
    );
    const fetchMock = vi.fn(async (_request: Request) =>
      Promise.resolve(new Response("upgraded")),
    );
    const env = {
      MAIN_SECRET: root,
      DB: dbWithRows([
        {
          id: "site-1",
          ownerUserId: "owner-1",
          role: "member",
          siteIdsJson: "[]",
        },
      ]),
      INGEST_DO: {
        idFromName: vi.fn(() => "do-id"),
        get: vi.fn(() => ({ fetch: fetchMock })),
      },
    };

    const response = await handleAdminWs(
      new Request("https://app.test/api/private/realtime/ws?siteId=site-1", {
        headers: { authorization: `Bearer ${token}` },
      }),
      env as any,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it.each([
    [
      "a team owner",
      {
        id: "site-1",
        ownerUserId: "user-1",
        role: null,
        siteIdsJson: null,
      },
      true,
    ],
    [
      "a team admin",
      {
        id: "site-1",
        ownerUserId: "owner-1",
        role: "admin",
        siteIdsJson: null,
      },
      true,
    ],
    [
      "a limited member allowed on the site",
      {
        id: "site-1",
        ownerUserId: "owner-1",
        role: "member",
        siteIdsJson: '["site-1"]',
      },
      true,
    ],
    [
      "an unrelated member",
      {
        id: "site-1",
        ownerUserId: "owner-1",
        role: null,
        siteIdsJson: null,
      },
      false,
    ],
  ] as const)("preserves site access for %s", async (_name, row, allowed) => {
    const root = "root-secret";
    const secret = await dashboardSecret(root);
    const token = await sessionToken(
      {
        userId: "user-1",
        username: "user",
        systemRole: "user",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      secret,
    );
    const fetchMock = vi.fn(async (_request: Request) => new Response("ok"));

    const response = await handleAdminWs(
      new Request("https://app.test/api/private/realtime/ws?siteId=site-1", {
        headers: { authorization: `Bearer ${token}` },
      }),
      {
        MAIN_SECRET: root,
        DB: dbWithRows([row]),
        INGEST_DO: {
          idFromName: vi.fn(() => "do-id"),
          get: vi.fn(() => ({ fetch: fetchMock })),
        },
      } as any,
    );

    expect(response.status).toBe(allowed ? 200 : 403);
    expect(fetchMock).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it("matches legacy SQL authorization results against migrated D1 queries", async () => {
    const database = createMigratedDatabase();
    try {
      const insertUser = database.prepare(
        "INSERT INTO users (id,email,name,username,system_role,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      );
      for (const [id, username] of [
        ["site-owner", "site-owner"],
        ["team-admin", "team-admin"],
        ["unrestricted", "unrestricted"],
        ["limited-allowed", "limited-allowed"],
        ["limited-denied", "limited-denied"],
        ["unrelated", "unrelated"],
        ["system-admin", "system-admin"],
      ]) {
        insertUser.run(
          id,
          `${username}@example.test`,
          username,
          username,
          id === "system-admin" ? "admin" : "user",
          "UTC",
          1,
          1,
        );
      }
      database
        .prepare(
          "INSERT INTO teams (id,name,slug,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run("team-1", "Team", "team", "site-owner", 1, 1);
      database
        .prepare("INSERT INTO sites (id,team_id,name,domain) VALUES (?,?,?,?)")
        .run("site-1", "team-1", "Site", "site.test");
      const insertMember = database.prepare(
        "INSERT INTO team_members (team_id,user_id,role,site_ids_json,joined_at) VALUES (?,?,?,?,?)",
      );
      insertMember.run("team-1", "team-admin", "admin", "[]", 1);
      insertMember.run("team-1", "unrestricted", "member", "[]", 1);
      insertMember.run("team-1", "limited-allowed", "member", '["site-1"]', 1);
      insertMember.run("team-1", "limited-denied", "member", '["site-2"]', 1);

      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const root = "root-secret";
      const fetchMock = vi.fn(async (_request: Request) => new Response("ok"));
      const env = {
        MAIN_SECRET: root,
        DB: createSqliteD1Database(database, trace),
        INGEST_DO: {
          idFromName: vi.fn(() => "do-id"),
          get: vi.fn(() => ({ fetch: fetchMock })),
        },
      };
      const scenarios: Array<{
        userId: string;
        systemRole?: "admin";
        siteId: string;
      }> = [
        { userId: "system-admin", systemRole: "admin", siteId: "site-1" },
        { userId: "system-admin", systemRole: "admin", siteId: "missing" },
        { userId: "site-owner", siteId: "site-1" },
        { userId: "team-admin", siteId: "site-1" },
        { userId: "unrestricted", siteId: "site-1" },
        { userId: "limited-allowed", siteId: "site-1" },
        { userId: "limited-denied", siteId: "site-1" },
        { userId: "unrelated", siteId: "site-1" },
      ] as const;

      for (const scenario of scenarios) {
        const legacyRow =
          scenario.systemRole === "admin"
            ? database
                .prepare("SELECT id FROM sites WHERE id=? LIMIT 1")
                .get(scenario.siteId)
            : database
                .prepare(
                  `SELECT s.id, t.owner_user_id AS ownerUserId, tm.role,
                          tm.site_ids_json AS siteIdsJson
                   FROM sites s
                   INNER JOIN teams t ON t.id = s.team_id
                   LEFT JOIN team_members tm
                     ON tm.team_id = s.team_id AND tm.user_id = ?
                   WHERE s.id = ?
                   LIMIT 1`,
                )
                .get(scenario.userId, scenario.siteId);
        let legacyAllowed = Boolean(legacyRow);
        if (scenario.systemRole !== "admin" && legacyRow) {
          const row = legacyRow as {
            ownerUserId: string;
            role: string | null;
            siteIdsJson: string | null;
          };
          const siteIds = JSON.parse(row.siteIdsJson || "[]") as string[];
          legacyAllowed =
            row.ownerUserId === scenario.userId ||
            row.role === "owner" ||
            row.role === "admin" ||
            (Boolean(row.role) &&
              (siteIds.length === 0 || siteIds.includes(scenario.siteId)));
        }

        trace.preparedSql.length = 0;
        trace.bindings.length = 0;
        const secret = await dashboardSecret(root);
        const token = await sessionToken(
          {
            userId: scenario.userId,
            username: scenario.userId,
            ...(scenario.systemRole ? { systemRole: scenario.systemRole } : {}),
            exp: Math.floor(Date.now() / 1000) + 60,
          },
          secret,
        );
        const response = await handleAdminWs(
          new Request(
            `https://app.test/api/private/realtime/ws?siteId=${scenario.siteId}`,
            { headers: { authorization: `Bearer ${token}` } },
          ),
          env as any,
        );

        expect(response.status === 200).toBe(legacyAllowed);
        expect(trace.preparedSql).toHaveLength(1);
        expect(trace.bindings[0]).toEqual(
          scenario.systemRole === "admin"
            ? [scenario.siteId, 1]
            : [scenario.userId, scenario.siteId, 1],
        );
      }
    } finally {
      database.close();
    }
  });
});
