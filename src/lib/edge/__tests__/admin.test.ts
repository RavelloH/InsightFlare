import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canAdministerTeam,
  canManageSite,
  canManageTeam,
  canReadSite,
  canReadTeam,
  uniqueTeamSlug,
} from "@/lib/edge/admin-access";
import { requireActor, verifyPassword } from "@/lib/edge/admin-auth";
import {
  type EdgeSessionClaims,
  requireSession,
} from "@/lib/edge/session-auth";
import {
  deleteSiteScriptSettings,
  readSiteScriptSettings,
  readSiteTrackingConfig,
  upsertSiteScriptSettings,
  upsertSiteTrackingConfig,
} from "@/lib/edge/site-settings-store";
import type { Env } from "@/lib/edge/types";
import { privateAdminRoutes } from "@/lib/hono/routes/private/admin";
import { privateSessionRoutes } from "@/lib/hono/routes/private/session";
import { publicSessionRoutes } from "@/lib/hono/routes/public/session";
import { deriveSecret, SECRET_PURPOSES } from "@/lib/secrets";
import { DEFAULT_SITE_SCRIPT_SETTINGS } from "@/lib/site-settings";
import type { DoDiagnosticPayload } from "@/lib/system-performance";

const deriveMockBytes = vi.hoisted(
  () =>
    (password: Uint8Array, nonce: Uint8Array, length: number): Uint8Array => {
      const out = new Uint8Array(length);
      for (let i = 0; i < out.length; i += 1) {
        const passwordByte =
          password.length > 0 ? password[i % password.length] : 0;
        const nonceByte = nonce.length > 0 ? nonce[i % nonce.length] : 0;
        out[i] = (passwordByte + nonceByte + i * 17) & 255;
      }
      return out;
    },
);

vi.mock("@noble/hashes/argon2.js", () => ({
  argon2id: vi.fn(
    (
      password: Uint8Array,
      nonce: Uint8Array,
      options: { dkLen?: number } = {},
    ) => deriveMockBytes(password, nonce, options.dkLen ?? 32),
  ),
}));

vi.mock("@/lib/edge/session-auth", () => ({
  requireSession: vi.fn(),
}));

vi.mock("@/lib/edge/site-settings-store", () => ({
  deleteSiteScriptSettings: vi.fn(),
  readSiteTrackingConfig: vi.fn(),
  readSiteScriptSettings: vi.fn(),
  upsertSiteTrackingConfig: vi.fn(),
  upsertSiteScriptSettings: vi.fn(),
}));

type UserRow = {
  id: string;
  username: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  system_role: string;
  timezone: string;
  preferred_locale?: string | null;
  created_at: number;
  updated_at: number;
};

interface MockStatement {
  sql?: string;
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

interface MockDurableObjectNamespace {
  idFromName: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

type ActualSessionAuth = {
  extractSessionToken: (request: Request) => string;
  requireSession: (
    request: Request,
    env: Env,
  ) => Promise<EdgeSessionClaims | null>;
  verifySessionToken: (
    token: string,
    env: Env,
  ) => Promise<EdgeSessionClaims | null>;
};

const requireSessionMock = vi.mocked(requireSession);
const readSiteScriptSettingsMock = vi.mocked(readSiteScriptSettings);
const upsertSiteScriptSettingsMock = vi.mocked(upsertSiteScriptSettings);
const readSiteTrackingConfigMock = vi.mocked(readSiteTrackingConfig);
const upsertSiteTrackingConfigMock = vi.mocked(upsertSiteTrackingConfig);
const deleteSiteScriptSettingsMock = vi.mocked(deleteSiteScriptSettings);

const adminSession: EdgeSessionClaims = {
  userId: "admin-1",
  username: "admin",
  displayName: "Admin",
  systemRole: "admin",
  exp: 9_999_999_999,
};

const userSession: EdgeSessionClaims = {
  userId: "user-1",
  username: "user",
  displayName: "User",
  systemRole: "user",
  exp: 9_999_999_999,
};

const uuid = (value: string) =>
  value as `${string}-${string}-${string}-${string}-${string}`;

function b64u(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function bytesFromString(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function toArrayBuffer(input: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(input.length);
  out.set(input);
  return out.buffer;
}

async function hmacToken(
  payloadPart: string,
  secret = "session-secret",
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(bytesFromString(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      toArrayBuffer(bytesFromString(payloadPart)),
    ),
  );
  return `${payloadPart}.${b64u(signature)}`;
}

async function sessionToken(
  payload: Record<string, unknown>,
  secret = "session-secret",
): Promise<string> {
  return hmacToken(b64u(bytesFromString(JSON.stringify(payload))), secret);
}

async function sessionSecretFromRoot(root = "main-secret"): Promise<string> {
  return deriveSecret(root, SECRET_PURPOSES.dashboardSession);
}

async function derivedSessionToken(
  payload: Record<string, unknown>,
  root = "main-secret",
): Promise<string> {
  return sessionToken(payload, await sessionSecretFromRoot(root));
}

function argonHash(
  password: string,
  nonce = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  ]),
): string {
  const passwordBytes = new TextEncoder().encode(password);
  const expected = deriveMockBytes(passwordBytes, nonce, 32);
  return `argon2id$v=19$m=4096,t=1,p=1$${b64u(nonce)}$${b64u(expected)}`;
}

function userRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "admin-1",
    username: "admin",
    email: "admin@example.test",
    name: "Admin User",
    password_hash: argonHash("secret-password"),
    system_role: "admin",
    timezone: "UTC",
    created_at: 100,
    updated_at: 200,
    ...overrides,
  };
}

function publicUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    name: row.name || "",
    systemRole: row.system_role === "admin" ? "admin" : "user",
    timeZone: row.timezone || "",
    preferredLocale:
      row.preferred_locale === "en" ||
      row.preferred_locale === "zh" ||
      row.preferred_locale === "ja"
        ? row.preferred_locale
        : "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function statement(
  input: {
    first?: unknown;
    all?: Record<string, unknown>[];
    run?: unknown;
    firstReject?: unknown;
    allReject?: unknown;
    runReject?: unknown;
  } = {},
): MockStatement {
  const stmt = {
    bind: vi.fn(function (this: MockStatement) {
      return this;
    }),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  } satisfies MockStatement;

  if ("firstReject" in input) {
    stmt.first.mockRejectedValue(input.firstReject);
  } else {
    stmt.first.mockResolvedValue("first" in input ? input.first : null);
  }

  if ("allReject" in input) {
    stmt.all.mockRejectedValue(input.allReject);
  } else {
    stmt.all.mockResolvedValue({ results: input.all ?? [] });
  }

  if ("runReject" in input) {
    stmt.run.mockRejectedValue(input.runReject);
  } else {
    stmt.run.mockResolvedValue(input.run ?? { success: true });
  }

  return stmt;
}

function createIngestDo(
  handlers: Record<
    string,
    | { fetch: ReturnType<typeof vi.fn> }
    | (() => { fetch: ReturnType<typeof vi.fn> })
  > = {},
): MockDurableObjectNamespace {
  const idFromName = vi.fn((name: string) => `stub:${name}`);
  const get = vi.fn((id: string) => {
    const siteId = id.replace(/^stub:/, "");
    const handler = handlers[siteId];
    if (!handler) {
      return {
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ ok: false }), { status: 500 }),
          ),
      };
    }
    return typeof handler === "function" ? handler() : handler;
  });
  return { idFromName, get };
}

function createEnv(
  statements: MockStatement[] = [],
  input: {
    env?: Partial<Env>;
    ingestDo?: MockDurableObjectNamespace;
  } = {},
): {
  env: Env;
  prepare: ReturnType<typeof vi.fn>;
  batch: ReturnType<typeof vi.fn>;
  ingestDo: MockDurableObjectNamespace;
} {
  let index = 0;
  const prepare = vi.fn((sql: string) => {
    const stmt = statements[index];
    index += 1;
    if (!stmt) {
      throw new Error(`Unexpected SQL #${index}: ${sql}`);
    }
    stmt.sql = sql;
    return stmt;
  });
  const batch = vi.fn().mockResolvedValue([]);
  const ingestDo = input.ingestDo ?? createIngestDo();
  return {
    env: {
      DB: { prepare, batch } as unknown as D1Database,
      INGEST_DO: ingestDo as unknown as DurableObjectNamespace,
      DAILY_SALT_SECRET: "daily-salt",
      ...input.env,
    } as Env,
    prepare,
    batch,
    ingestDo,
  };
}

function setSession(
  session: EdgeSessionClaims | null = adminSession,
): ReturnType<typeof vi.fn> {
  return requireSessionMock.mockResolvedValue(session);
}

function jsonInit(
  body: Record<string, unknown>,
  method: "POST" | "PATCH" = "POST",
): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function edgeRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://edge.test${path}`, init);
}

async function dispatch(path: string, env: Env, init?: RequestInit) {
  if (path === "/api/public/session") {
    return publicSessionRoutes.fetch(edgeRequest("/", init), env);
  }
  if (path === "/api/private/session") {
    return privateSessionRoutes.fetch(edgeRequest("/", init), env);
  }
  const adminPrefix = "/api/private/admin";
  if (path.startsWith(`${adminPrefix}/`)) {
    return privateAdminRoutes.fetch(
      edgeRequest(path.slice(adminPrefix.length), init),
      env,
    );
  }
  return new Response("Not Found", { status: 404 });
}

function mockUuid(...ids: string[]) {
  const spy = vi.spyOn(crypto, "randomUUID");
  for (const id of ids) spy.mockReturnValueOnce(uuid(id));
  if (ids.length > 0) spy.mockReturnValue(uuid(ids[ids.length - 1]));
  return spy;
}

function diagnosticPayload(
  overrides: Partial<DoDiagnosticPayload> = {},
): DoDiagnosticPayload {
  return {
    ok: true,
    snapshotAt: 1_000,
    thresholds: {
      staleMs: 1,
      timeoutMs: 2,
      hardAgedMs: 3,
      stuckFlushAttempts: 4,
    },
    visits: {
      total: 12,
      byStatus: { open: 4, closed: 8 },
      open: {
        total: 4,
        stale: 1,
        timedOut: 2,
        hardAged: 3,
        futureSkewed: 1,
        oldestStartedAt: 900,
        newestActivityAt: 990,
        futureMaxActivityAt: 1_100,
      },
      dirty: {
        total: 3,
        stuck: 2,
        maxFlushAttempts: 7,
      },
    },
    customEvents: {
      total: 5,
      dirty: 2,
      stuck: 1,
      maxFlushAttempts: 6,
      oldestOccurredAt: 800,
    },
    alarm: {
      scheduledAt: 1_200,
      nextDueAt: 1_200,
      nextDueKind: "flush",
      nextDueEntity: "visit",
    },
    ...overrides,
  };
}

describe("private admin edge handler", () => {
  beforeEach(() => {
    requireSessionMock.mockReset();
    readSiteTrackingConfigMock.mockReset();
    readSiteScriptSettingsMock.mockReset();
    upsertSiteTrackingConfigMock.mockReset();
    upsertSiteScriptSettingsMock.mockReset();
    deleteSiteScriptSettingsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("extracted auth/access helpers", () => {
    it("resolves actors from sessions and rejects missing sessions", async () => {
      setSession(adminSession);
      const actorRow = userRow();
      const { env } = createEnv([statement({ first: actorRow })]);

      const actor = await requireActor(env, edgeRequest("/admin"));

      expect(actor).not.toBeInstanceOf(Response);
      expect(actor).toEqual({ user: actorRow, isAdmin: true });

      setSession(null);
      const rejected = await requireActor(
        createEnv().env,
        edgeRequest("/admin"),
      );

      expect(rejected).toBeInstanceOf(Response);
      expect((rejected as Response).status).toBe(401);
      expect(await (rejected as Response).json()).toMatchObject({
        ok: false,
        error: { message: "Unauthorized" },
      });
    });

    it("verifies extracted argon2 password hashes and rejects mismatches", async () => {
      const stored = argonHash("secret-password");

      await expect(verifyPassword("secret-password", stored)).resolves.toBe(
        true,
      );
      await expect(verifyPassword("wrong-password", stored)).resolves.toBe(
        false,
      );
      await expect(verifyPassword("secret-password", null)).resolves.toBe(
        false,
      );
      await expect(
        verifyPassword("secret-password", "legacy$hash"),
      ).resolves.toBe(false);
      await expect(
        verifyPassword(
          "secret-password",
          "argon2id$v=19$m=4096,t=1,p=9$AQIDBAUGBwg$AQIDBAUGBwgBAgMEBQYHCA",
        ),
      ).resolves.toBe(false);
      await expect(
        verifyPassword(
          "secret-password",
          "argon2id$v=19$m=1,t=1,p=1$AQIDBAUGBwg$AQIDBAUGBwgBAgMEBQYHCA",
        ),
      ).resolves.toBe(false);
      await expect(
        verifyPassword(
          "secret-password",
          "argon2id$v=19$m=4096,t=0,p=1$AQIDBAUGBwg$AQIDBAUGBwgBAgMEBQYHCA",
        ),
      ).resolves.toBe(false);
      await expect(
        verifyPassword(
          "secret-password",
          "argon2id$v=19$m=4096,t=1,p=1$!$AQIDBAUGBwgBAgMEBQYHCA",
        ),
      ).resolves.toBe(false);

      const { argon2id } = await import("@noble/hashes/argon2.js");
      vi.mocked(argon2id).mockImplementationOnce(() => {
        throw new Error("derive failed");
      });
      await expect(
        verifyPassword("secret-password", argonHash("secret-password")),
      ).resolves.toBe(false);
    });

    it("checks team and site access through extracted helpers", async () => {
      const actor = {
        user: userRow({ id: "user-1", system_role: "user" }),
        isAdmin: false,
      };
      const admin = { user: userRow(), isAdmin: true };
      const manageSiteEnv = createEnv([
        statement({ first: { team_id: "team-1" } }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: { role: "admin" } }),
      ]).env;
      const administerTeamEnv = createEnv([
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: { role: "admin" } }),
      ]).env;
      const adminEnv = createEnv([statement({ first: null })]).env;

      await expect(canManageSite(manageSiteEnv, actor, "site-1")).resolves.toBe(
        true,
      );
      await expect(
        canAdministerTeam(administerTeamEnv, actor, "team-1"),
      ).resolves.toBe(false);
      await expect(canManageSite(adminEnv, admin, "site-1")).resolves.toBe(
        false,
      );
    });

    it("covers access helper ownership, missing site, and slug fallbacks", async () => {
      vi.spyOn(Date, "now").mockReturnValue(1_779_708_000_000);
      const actor = {
        user: userRow({ id: "user-1", system_role: "user" }),
        isAdmin: false,
      };
      const ownerTeam = { id: "team-1", ownerUserId: "user-1" };

      await expect(
        canReadTeam(
          createEnv([statement({ first: ownerTeam })]).env,
          actor,
          "team-1",
        ),
      ).resolves.toBe(true);
      await expect(
        canReadTeam(
          createEnv([statement({ first: null }), statement({ first: null })])
            .env,
          actor,
          "team-1",
        ),
      ).resolves.toBe(false);
      await expect(
        canManageTeam(
          createEnv([statement({ first: ownerTeam })]).env,
          actor,
          "team-1",
        ),
      ).resolves.toBe(true);
      await expect(
        canAdministerTeam(
          createEnv([statement({ first: ownerTeam })]).env,
          actor,
          "team-1",
        ),
      ).resolves.toBe(true);
      await expect(
        canReadSite(
          createEnv([statement({ first: null })]).env,
          actor,
          "missing-site",
        ),
      ).resolves.toBe(false);
      await expect(
        canReadSite(
          createEnv([
            statement({ first: { team_id: "team-1" } }),
            statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
            statement({
              first: { role: "member", siteIdsJson: '["site-1"]' },
            }),
          ]).env,
          actor,
          "site-1",
        ),
      ).resolves.toBe(true);
      await expect(
        canReadSite(
          createEnv([
            statement({ first: { team_id: "team-1" } }),
            statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
            statement({
              first: { role: "member", siteIdsJson: '["site-2"]' },
            }),
          ]).env,
          actor,
          "site-1",
        ),
      ).resolves.toBe(false);

      const slugEnv = createEnv([
        statement({ first: null }),
        statement({ first: { ok: 1 } }),
        statement({ first: null }),
      ]).env;

      await expect(uniqueTeamSlug(slugEnv, "")).resolves.toBe(
        "team-1779708000000",
      );
      await expect(uniqueTeamSlug(slugEnv, "Team!", "team-1")).resolves.toBe(
        "team-2",
      );
      await expect(
        uniqueTeamSlug(
          createEnv([statement({ first: { ok: 0 } })]).env,
          "Open Team",
        ),
      ).resolves.toBe("open-team");
    });

    it("verifies real session tokens from bearer and cookie credentials", async () => {
      const {
        extractSessionToken,
        requireSession: requireActualSession,
        verifySessionToken,
      } = await vi.importActual<ActualSessionAuth>("@/lib/edge/session-auth");
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const env = createEnv([], {
        env: { MAIN_SECRET: "main-secret" },
      }).env;
      const claims = {
        userId: "user-1",
        username: "User",
        displayName: "User One",
        systemRole: "admin",
        exp: 1_800_000_100,
      };
      const token = await derivedSessionToken(claims);
      const bearerRequest = edgeRequest("/admin", {
        headers: { authorization: `Bearer ${token}` },
      });
      const cookieRequest = {
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "cookie"
              ? `other=1; if_session=${encodeURIComponent(token)}`
              : "",
        },
      } as Request;
      const unrelatedCookieRequest = {
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "cookie" ? "other=1" : "",
        },
      } as Request;

      expect(extractSessionToken(bearerRequest)).toBe(token);
      expect(extractSessionToken(cookieRequest)).toBe(token);
      expect(extractSessionToken(unrelatedCookieRequest)).toBe("");
      await expect(verifySessionToken(token, env)).resolves.toEqual(claims);
      await expect(requireActualSession(cookieRequest, env)).resolves.toEqual(
        claims,
      );
    });

    it("rejects invalid real session tokens", async () => {
      const { requireSession: requireActualSession, verifySessionToken } =
        await vi.importActual<ActualSessionAuth>("@/lib/edge/session-auth");
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const env = createEnv([], {
        env: { MAIN_SECRET: "main-secret" },
      }).env;
      const validPayload = {
        userId: "user-1",
        username: "User",
        displayName: "User One",
        systemRole: "admin",
        exp: 1_800_000_100,
      };
      const validToken = await derivedSessionToken(validPayload);
      const invalidJsonPayload = b64u(bytesFromString("not-json"));
      const missingFieldsPayload = b64u(bytesFromString("{}"));
      const expiredToken = await derivedSessionToken({
        ...validPayload,
        exp: 1_799_999_999,
      });
      const badRoleToken = await derivedSessionToken({
        ...validPayload,
        systemRole: "superadmin",
      });

      await expect(verifySessionToken("", env)).resolves.toBeNull();
      await expect(verifySessionToken("short", env)).resolves.toBeNull();
      await expect(verifySessionToken("x".repeat(25), env)).resolves.toBeNull();
      await expect(
        verifySessionToken(`${validToken.slice(0, -2)}xx`, env),
      ).resolves.toBeNull();
      await expect(
        verifySessionToken(`${"x".repeat(25)}.!`, env),
      ).resolves.toBeNull();
      await expect(
        verifySessionToken(
          await hmacToken(invalidJsonPayload, await sessionSecretFromRoot()),
          env,
        ),
      ).resolves.toBeNull();
      await expect(
        verifySessionToken(
          await hmacToken(missingFieldsPayload, await sessionSecretFromRoot()),
          env,
        ),
      ).resolves.toBeNull();
      await expect(verifySessionToken(expiredToken, env)).resolves.toBeNull();
      await expect(
        verifySessionToken(badRoleToken, env),
      ).resolves.toMatchObject({
        systemRole: "user",
      });
      await expect(
        requireActualSession(edgeRequest("/admin"), env),
      ).resolves.toBeNull();
    });
  });

  it("returns not found for unknown admin routes without authenticating", async () => {
    const { env, prepare } = createEnv();

    const response = await dispatch("/api/private/admin/unknown", env);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { message: "Not Found" },
    });
    expect(requireSessionMock).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("routes less common admin services through the canonical route table", async () => {
    const { env, prepare } = createEnv();
    setSession(null);

    for (const route of [
      "account-links",
      "team-invites",
      "analytics-engine-config",
      "request-observation",
      "do-diagnostic",
      "e2e/flush",
    ]) {
      const response = await dispatch(`/api/private/admin/${route}`, env);
      expect(response.status).toBe(route === "e2e/flush" ? 404 : 401);
    }

    expect(prepare).not.toHaveBeenCalled();
  });

  describe("auth routes", () => {
    it("returns not found for unsupported login and auth/me methods", async () => {
      const { env, prepare } = createEnv();

      const login = await dispatch("/api/public/session", env, {
        method: "GET",
      });
      const me = await dispatch("/api/private/session", env, {
        method: "POST",
      });

      expect(login.status).toBe(404);
      expect(me.status).toBe(404);
      expect(await login.json()).toMatchObject({
        ok: false,
        error: { message: "Not Found" },
      });
      expect(await me.json()).toMatchObject({
        ok: false,
        error: { message: "Not Found" },
      });
      expect(requireSessionMock).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    });

    it("reports bootstrap failures during login", async () => {
      const { env } = createEnv([
        statement({ firstReject: new Error("boom") }),
      ]);

      const response = await dispatch(
        "/api/public/session",
        env,
        jsonInit({ username: "admin", password: "secret-password" }),
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "login_upstream_failed" },
      });
    });

    it("reports bootstrap reload failures while promoting or creating admins", async () => {
      const existing = userRow({
        id: "user-1",
        username: "bootstrap",
        email: "bootstrap@example.test",
        system_role: "user",
      });

      const promoteFailure = await dispatch(
        "/api/public/session",
        createEnv([
          statement({ first: null }),
          statement({ first: existing }),
          statement(),
          statement({ first: null }),
        ]).env,
        jsonInit({ username: "admin", password: "secret-password" }),
      );

      const createFailure = await dispatch(
        "/api/public/session",
        createEnv([
          statement({ first: null }),
          statement({ first: null }),
          statement(),
          statement({ first: null }),
        ]).env,
        jsonInit({ username: "admin", password: "secret-password" }),
      );

      expect(promoteFailure.status).toBe(500);
      expect(await promoteFailure.json()).toMatchObject({
        ok: false,
        error: { code: "login_upstream_failed" },
      });
      expect(createFailure.status).toBe(500);
      expect(await createFailure.json()).toMatchObject({
        ok: false,
        error: { code: "login_upstream_failed" },
      });
    });

    it("rejects invalid public login input before bootstrap database access", async () => {
      const existing = userRow({
        id: "user-1",
        username: "bootstrap",
        email: "bootstrap@example.test",
        system_role: "user",
      });
      const promoted = userRow({
        ...existing,
        system_role: "admin",
        password_hash: argonHash("bootstrap-secret"),
      });
      const update = statement();
      const ownerUpsert = statement();
      const { env } = createEnv(
        [
          statement({ first: null }),
          statement({ first: existing }),
          update,
          statement({ first: promoted }),
          statement({ first: { id: "team-1" } }),
          ownerUpsert,
        ],
        {
          env: {
            BOOTSTRAP_ADMIN_PASSWORD: "bootstrap-secret",
          },
        },
      );

      const response = await dispatch(
        "/api/public/session",
        env,
        jsonInit({ username: "bo" }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Invalid credentials" },
      });
      expect(update.bind).not.toHaveBeenCalled();
      expect(ownerUpsert.bind).not.toHaveBeenCalled();
    });

    it("creates the bootstrap admin, verifies credentials, and returns profile teams", async () => {
      const createdAdmin = userRow({
        id: "admin-created",
        username: "admin",
        email: "admin@example.test",
        password_hash: argonHash("secret-password"),
      });
      const teamRows = [
        {
          id: "team-1",
          name: "Admin Team",
          slug: "admin-team",
          ownerUserId: "admin-created",
          createdAt: 10,
          updatedAt: 20,
          membershipRole: "admin",
          siteCount: 2,
          memberCount: 3,
        },
      ];
      const { env } = createEnv(
        [
          statement({ first: null }),
          statement({ first: null }),
          statement(),
          statement({ first: createdAdmin }),
          statement({ first: null }),
          statement({ first: null }),
          statement(),
          statement(),
          statement({ first: createdAdmin }),
          statement({ all: teamRows }),
        ],
        {
          env: {
            BOOTSTRAP_ADMIN_PASSWORD: "secret-password",
          },
        },
      );

      const response = await dispatch(
        "/api/public/session",
        env,
        jsonInit({ username: "Admin", password: "secret-password" }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: { next: "/app" },
      });
      expect(response.headers.get("set-cookie")).toContain("if_session=");
    });

    it("logs in existing users without creating a default team", async () => {
      const bootstrapAdmin = userRow({
        id: "admin-existing",
        username: "admin",
        email: "admin@example.test",
        system_role: "admin",
      });
      const existingUser = userRow({
        id: "user-without-team",
        username: "lonely",
        email: "lonely@example.test",
        password_hash: argonHash("secret-password"),
        system_role: "user",
      });
      const bootstrapOwnerUpsert = statement();
      const teamsStatement = statement({ all: [] });
      const { env, prepare } = createEnv([
        statement({ first: bootstrapAdmin }),
        statement({ first: { id: "admin-team" } }),
        bootstrapOwnerUpsert,
        statement({ first: existingUser }),
        teamsStatement,
      ]);

      const response = await dispatch(
        "/api/public/session",
        env,
        jsonInit({ username: "lonely", password: "secret-password" }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: { next: "/app" },
      });
      expect(bootstrapOwnerUpsert.bind).toHaveBeenCalledWith(
        "admin-team",
        "admin-existing",
      );
      expect(teamsStatement.bind).toHaveBeenCalledWith("user-without-team");
      expect(prepare).toHaveBeenCalledTimes(5);
    });

    it("denies login when stored password hashes are malformed or credentials mismatch", async () => {
      const badHashUser = userRow({
        password_hash:
          "argon2id$v=20$m=4096,t=1,p=1$AQIDBAUGBwg$AQIDBAUGBwgBAgMEBQYHCA",
      });
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({ first: { id: "team-1" } }),
        statement(),
        statement({ first: badHashUser }),
      ]);

      const response = await dispatch(
        "/api/public/session",
        env,
        jsonInit({ email: "admin@example.test", password: "secret-password" }),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Invalid credentials" },
      });
    });

    it("returns current user and teams for authenticated auth/me requests", async () => {
      setSession(adminSession);
      const actor = userRow();
      const createdTeams = [
        {
          id: "team-1",
          name: "Team",
          slug: "team",
          membershipRole: "owner",
          siteCount: 1,
          memberCount: 1,
        },
      ];
      const managedTeams = [
        {
          id: "team-2",
          name: "Other",
          slug: "other",
          membershipRole: "admin",
          siteCount: 0,
          memberCount: 2,
        },
      ];
      const memberTeams = [
        {
          id: "team-3",
          name: "Member",
          slug: "member",
          membershipRole: "bogus",
          siteCount: 0,
          memberCount: 3,
        },
      ];
      const systemTeams = [
        ...createdTeams,
        ...managedTeams,
        ...memberTeams,
        {
          id: "team-4",
          name: "System",
          slug: "system",
          membershipRole: null,
          siteCount: 0,
          memberCount: 1,
        },
      ];
      const { env } = createEnv([
        statement({ first: actor }),
        statement({ all: createdTeams }),
        statement({ all: managedTeams }),
        statement({ all: memberTeams }),
        statement({ all: systemTeams }),
      ]);

      const response = await dispatch("/api/private/session", env);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          user: publicUser(actor),
          teams: [
            { ...createdTeams[0], membershipRole: "owner" },
            { ...managedTeams[0], membershipRole: "admin" },
            { ...memberTeams[0], membershipRole: "member" },
            {
              id: "team-4",
              name: "System",
              slug: "system",
              siteCount: 0,
              memberCount: 1,
            },
          ],
          teamGroups: {
            created: [{ ...createdTeams[0], membershipRole: "owner" }],
            managed: [{ ...managedTeams[0], membershipRole: "admin" }],
            member: [{ ...memberTeams[0], membershipRole: "member" }],
          },
        },
      });
      expect(requireSessionMock).toHaveBeenCalledOnce();
    });

    it("rejects absent sessions and stale session user ids", async () => {
      setSession(null);
      const { env: absentEnv } = createEnv();

      const absent = await dispatch("/api/private/session", absentEnv);

      setSession(adminSession);
      const { env: staleEnv } = createEnv([statement({ first: null })]);
      const stale = await dispatch("/api/private/session", staleEnv);

      setSession({ ...adminSession, userId: "" });
      const emptyUserId = await dispatch(
        "/api/private/session",
        createEnv().env,
      );

      expect(absent.status).toBe(401);
      expect(await absent.json()).toMatchObject({
        ok: false,
        error: { message: "Unauthorized" },
      });
      expect(stale.status).toBe(401);
      expect(await stale.json()).toMatchObject({
        ok: false,
        error: { message: "User not found" },
      });
      expect(emptyUserId.status).toBe(401);
      expect(await emptyUserId.json()).toMatchObject({
        ok: false,
        error: { message: "Unauthorized" },
      });
    });
  });

  describe("users route", () => {
    it("denies account management to non-system admins", async () => {
      setSession(userSession);
      const { env, prepare } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
      ]);

      const response = await dispatch("/api/private/admin/users", env);

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Only system admin can manage accounts" },
      });
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it("lists all users for system admins", async () => {
      setSession(adminSession);
      const rows = [
        {
          id: "admin-1",
          username: "admin",
          systemRole: "admin",
          teamCount: 1,
          ownedTeamCount: 1,
        },
      ];
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({ all: rows }),
      ]);

      const response = await dispatch("/api/private/admin/users", env);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, data: rows });
    });

    it("validates user creation payloads before uniqueness checks", async () => {
      setSession(adminSession);
      const { env, prepare } = createEnv([statement({ first: userRow() })]);

      const response = await dispatch(
        "/api/private/admin/users",
        env,
        jsonInit({ username: "a!", email: "bad", password: "short" }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Invalid username" },
      });
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it("rejects invalid user creation email and password payloads", async () => {
      setSession(adminSession);
      const emailEnv = createEnv([statement({ first: userRow() })]).env;
      const invalidEmail = await dispatch(
        "/api/private/admin/users",
        emailEnv,
        jsonInit({
          username: "new-user",
          email: "bad",
          password: "long-enough",
        }),
      );

      const passwordEnv = createEnv([statement({ first: userRow() })]).env;
      const shortPassword = await dispatch(
        "/api/private/admin/users",
        passwordEnv,
        jsonInit({
          username: "new-user",
          email: "new@example.test",
          password: "short",
        }),
      );

      expect(invalidEmail.status).toBe(400);
      expect(await invalidEmail.json()).toMatchObject({
        ok: false,
        error: { message: "A valid email is required" },
      });
      expect(shortPassword.status).toBe(400);
      expect(await shortPassword.json()).toMatchObject({
        ok: false,
        error: { message: "Password must be at least 8 characters" },
      });
    });

    it("creates users with normalized role and a default owner team", async () => {
      setSession(adminSession);
      mockUuid(
        "00000000-0000-4000-8000-000000000101",
        "00000000-0000-4000-8000-000000000102",
      );
      const created = userRow({
        id: "00000000-0000-4000-8000-000000000101",
        username: "new.user",
        email: "new@example.test",
        name: "New User",
        system_role: "user",
      });
      const insertUser = statement();
      const insertTeam = statement();
      const insertMember = statement();
      const { env, batch } = createEnv([
        statement({ first: userRow() }),
        statement({ first: null }),
        statement({ first: null }),
        statement({ first: { ok: 1 } }),
        statement({ first: null }),
        insertUser,
        insertTeam,
        insertMember,
        statement({ first: created }),
      ]);

      const response = await dispatch(
        "/api/private/admin/users",
        env,
        jsonInit({
          username: " New.User ",
          email: " NEW@example.test ",
          name: "New User",
          password: "long-enough",
          systemRole: "manager",
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: publicUser(created),
      });
      expect(insertUser.bind).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000101",
        "new.user",
        "new@example.test",
        "New User",
        expect.stringMatching(/^argon2id\$/),
        "user",
      );
      expect(insertTeam.bind).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000102",
        "New User's team",
        "new-user-team-2",
        "00000000-0000-4000-8000-000000000101",
      );
      expect(insertMember.bind).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000102",
        "00000000-0000-4000-8000-000000000101",
      );
      expect(batch).toHaveBeenCalledOnce();
    });

    it("rejects duplicate usernames and duplicate emails during user creation", async () => {
      setSession(adminSession);
      const { env: usernameEnv } = createEnv([
        statement({ first: userRow() }),
        statement({ first: { ok: 1 } }),
      ]);
      const duplicateUsername = await dispatch(
        "/api/private/admin/users",
        usernameEnv,
        jsonInit({
          username: "admin",
          email: "new@example.test",
          password: "long-enough",
        }),
      );

      const { env: emailEnv } = createEnv([
        statement({ first: userRow() }),
        statement({ first: null }),
        statement({ first: { ok: 1 } }),
      ]);
      const duplicateEmail = await dispatch(
        "/api/private/admin/users",
        emailEnv,
        jsonInit({
          username: "new-user",
          email: "admin@example.test",
          password: "long-enough",
        }),
      );

      expect(duplicateUsername.status).toBe(400);
      expect(await duplicateUsername.json()).toMatchObject({
        ok: false,
        error: { message: "Username already exists" },
      });
      expect(duplicateEmail.status).toBe(400);
      expect(await duplicateEmail.json()).toMatchObject({
        ok: false,
        error: { message: "Email already exists" },
      });
    });

    it("updates users and hashes replacement passwords", async () => {
      setSession(adminSession);
      const existing = userRow({
        id: "target-1",
        username: "old",
        email: "old@example.test",
        name: null,
        system_role: "user",
      });
      const updated = userRow({
        ...existing,
        username: "new",
        email: "new@example.test",
        name: "New Name",
        system_role: "admin",
        updated_at: 300,
      });
      const update = statement();
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({ first: existing }),
        statement({ first: null }),
        statement({ first: null }),
        update,
        statement({ first: updated }),
      ]);

      const response = await dispatch(
        "/api/private/admin/users",
        env,
        jsonInit(
          {
            userId: "target-1",
            username: "New",
            email: "New@Example.Test",
            name: "New Name",
            password: "new-password",
            systemRole: "ADMIN",
          },
          "PATCH",
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: publicUser(updated),
      });
      expect(update.bind).toHaveBeenCalledWith(
        "new",
        "new@example.test",
        "New Name",
        expect.stringMatching(/^argon2id\$/),
        "admin",
        "target-1",
      );
    });

    it("validates user update conflicts, failed reloads, and unsupported methods", async () => {
      setSession(adminSession);
      const existing = userRow({
        id: "target-1",
        username: "old",
        email: "old@example.test",
        system_role: "user",
      });

      const invalidUsernameEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: existing }),
      ]).env;
      const invalidUsername = await dispatch(
        "/api/private/admin/users",
        invalidUsernameEnv,
        jsonInit({ userId: "target-1", username: "x!" }, "PATCH"),
      );

      const invalidEmailEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: existing }),
      ]).env;
      const invalidEmail = await dispatch(
        "/api/private/admin/users",
        invalidEmailEnv,
        jsonInit({ userId: "target-1", email: "bad" }, "PATCH"),
      );

      const duplicateUsernameEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: existing }),
        statement({ first: { ok: 1 } }),
      ]).env;
      const duplicateUsername = await dispatch(
        "/api/private/admin/users",
        duplicateUsernameEnv,
        jsonInit({ userId: "target-1", username: "taken" }, "PATCH"),
      );

      const duplicateEmailEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: existing }),
        statement({ first: null }),
        statement({ first: { ok: 1 } }),
      ]).env;
      const duplicateEmail = await dispatch(
        "/api/private/admin/users",
        duplicateEmailEnv,
        jsonInit({ userId: "target-1", email: "taken@example.test" }, "PATCH"),
      );

      const failedReloadEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: existing }),
        statement({ first: null }),
        statement({ first: null }),
        statement(),
        statement({ first: null }),
      ]).env;
      const failedReload = await dispatch(
        "/api/private/admin/users",
        failedReloadEnv,
        jsonInit({ userId: "target-1" }, "PATCH"),
      );

      const unsupported = await dispatch(
        "/api/private/admin/users",
        createEnv([statement({ first: userRow() })]).env,
        { method: "DELETE" },
      );

      expect(invalidUsername.status).toBe(400);
      expect(await invalidUsername.json()).toMatchObject({
        ok: false,
        error: { message: "Invalid username" },
      });
      expect(invalidEmail.status).toBe(400);
      expect(await invalidEmail.json()).toMatchObject({
        ok: false,
        error: { message: "A valid email is required" },
      });
      expect(duplicateUsername.status).toBe(400);
      expect(await duplicateUsername.json()).toMatchObject({
        ok: false,
        error: { message: "Username already exists" },
      });
      expect(duplicateEmail.status).toBe(400);
      expect(await duplicateEmail.json()).toMatchObject({
        ok: false,
        error: { message: "Email already exists" },
      });
      expect(failedReload.status).toBe(400);
      expect(await failedReload.json()).toMatchObject({
        ok: false,
        error: { message: "Failed to update account" },
      });
      expect(unsupported.status).toBe(405);
      expect(await unsupported.json()).toMatchObject({
        ok: false,
        error: { message: "Method Not Allowed" },
      });
    });

    it("handles user removal guard rails and successful deletion", async () => {
      setSession(adminSession);
      const selfEnv = createEnv([statement({ first: userRow() })]).env;
      const self = await dispatch(
        "/api/private/admin/users",
        selfEnv,
        jsonInit({ intent: "delete", userId: "admin-1" }, "PATCH"),
      );

      const ownerEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: userRow({ id: "target-1" }) }),
        statement({ first: { count: 2 } }),
      ]).env;
      const ownsTeams = await dispatch(
        "/api/private/admin/users",
        ownerEnv,
        jsonInit({ intent: "remove", userId: "target-1" }, "PATCH"),
      );

      const deleteStmt = statement();
      const successEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: userRow({ id: "target-1" }) }),
        statement({ first: { count: 0 } }),
        deleteStmt,
      ]).env;
      const success = await dispatch(
        "/api/private/admin/users",
        successEnv,
        jsonInit({ intent: "remove", userId: "target-1" }, "PATCH"),
      );

      expect(self.status).toBe(400);
      expect(await self.json()).toMatchObject({
        ok: false,
        error: { message: "Cannot delete current user" },
      });
      expect(ownsTeams.status).toBe(400);
      expect(await ownsTeams.json()).toMatchObject({
        ok: false,
        error: { message: "Cannot delete user that owns teams" },
      });
      expect(success.status).toBe(200);
      expect(await success.json()).toMatchObject({
        ok: true,
        data: { userId: "target-1", removed: true },
      });
      expect(deleteStmt.bind).toHaveBeenCalledWith("target-1");
    });

    it("returns user patch validation and missing target errors", async () => {
      setSession(adminSession);
      const missingIdEnv = createEnv([statement({ first: userRow() })]).env;
      const missingId = await dispatch(
        "/api/private/admin/users",
        missingIdEnv,
        jsonInit({ username: "new" }, "PATCH"),
      );

      const missingTargetEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: null }),
      ]).env;
      const missingTarget = await dispatch(
        "/api/private/admin/users",
        missingTargetEnv,
        jsonInit({ userId: "missing-1" }, "PATCH"),
      );

      const failedCreateEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: null }),
        statement({ first: null }),
        statement(),
        statement(),
        statement(),
        statement(),
        statement({ first: null }),
      ]).env;
      const failedCreate = await dispatch(
        "/api/private/admin/users",
        failedCreateEnv,
        jsonInit({
          username: "new-user",
          email: "new@example.test",
          password: "long-enough",
        }),
      );

      expect(missingId.status).toBe(400);
      expect(await missingId.json()).toMatchObject({
        ok: false,
        error: { message: "userId is required" },
      });
      expect(missingTarget.status).toBe(404);
      expect(await missingTarget.json()).toMatchObject({
        ok: false,
        error: { message: "User not found" },
      });
      expect(failedCreate.status).toBe(400);
      expect(await failedCreate.json()).toMatchObject({
        ok: false,
        error: { message: "Failed to create account" },
      });
    });
  });

  describe("profile route", () => {
    it("returns the authenticated profile and teams", async () => {
      setSession(userSession);
      const actor = userRow({ id: "user-1", system_role: "user" });
      const teams = [{ id: "team-1", membershipRole: "admin" }];
      const { env } = createEnv([
        statement({ first: actor }),
        statement({ all: teams }),
      ]);

      const response = await dispatch("/api/private/admin/profile", env);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          user: publicUser(actor),
          teams: [{ ...teams[0], membershipRole: "admin" }],
        },
      });
    });

    it("validates profile time zones and current passwords", async () => {
      setSession(userSession);
      const actor = userRow({
        id: "user-1",
        system_role: "user",
        password_hash: argonHash("old-password"),
      });
      const invalidTimeZoneEnv = createEnv([statement({ first: actor })]).env;
      const invalidTimeZone = await dispatch(
        "/api/private/admin/profile",
        invalidTimeZoneEnv,
        jsonInit({ timeZone: "Mars/Base" }),
      );

      const badPasswordEnv = createEnv([statement({ first: actor })]).env;
      const badPassword = await dispatch(
        "/api/private/admin/profile",
        badPasswordEnv,
        jsonInit({
          currentPassword: "wrong-password",
          password: "new-password",
        }),
      );

      expect(invalidTimeZone.status).toBe(400);
      expect(await invalidTimeZone.json()).toMatchObject({
        ok: false,
        error: { message: "Invalid timezone" },
      });
      expect(badPassword.status).toBe(400);
      expect(await badPassword.json()).toMatchObject({
        ok: false,
        error: { message: "Current password is incorrect" },
      });
    });

    it("validates profile identity conflicts, failed reloads, and unsupported methods", async () => {
      setSession(userSession);
      const actor = userRow({
        id: "user-1",
        username: "old",
        email: "old@example.test",
        system_role: "user",
      });

      const invalidUsername = await dispatch(
        "/api/private/admin/profile",
        createEnv([statement({ first: actor })]).env,
        jsonInit({ username: "x!" }),
      );

      const invalidEmail = await dispatch(
        "/api/private/admin/profile",
        createEnv([statement({ first: actor })]).env,
        jsonInit({ email: "bad" }),
      );

      const shortPassword = await dispatch(
        "/api/private/admin/profile",
        createEnv([statement({ first: actor })]).env,
        jsonInit({ password: "short" }),
      );

      const duplicateUsername = await dispatch(
        "/api/private/admin/profile",
        createEnv([
          statement({ first: actor }),
          statement({ first: { ok: 1 } }),
        ]).env,
        jsonInit({ username: "taken" }),
      );

      const duplicateEmail = await dispatch(
        "/api/private/admin/profile",
        createEnv([
          statement({ first: actor }),
          statement({ first: null }),
          statement({ first: { ok: 1 } }),
        ]).env,
        jsonInit({ email: "taken@example.test" }),
      );

      const failedReload = await dispatch(
        "/api/private/admin/profile",
        createEnv([
          statement({ first: actor }),
          statement({ first: null }),
          statement({ first: null }),
          statement(),
          statement({ first: null }),
        ]).env,
        jsonInit({ name: "New Name" }),
      );

      const unsupported = await dispatch(
        "/api/private/admin/profile",
        createEnv([statement({ first: actor })]).env,
        { method: "DELETE" },
      );

      expect(invalidUsername.status).toBe(400);
      expect(await invalidUsername.json()).toMatchObject({
        ok: false,
        error: { message: "Invalid username" },
      });
      expect(invalidEmail.status).toBe(400);
      expect(await invalidEmail.json()).toMatchObject({
        ok: false,
        error: { message: "A valid email is required" },
      });
      expect(shortPassword.status).toBe(400);
      expect(await shortPassword.json()).toMatchObject({
        ok: false,
        error: { message: "Password must be at least 8 characters" },
      });
      expect(duplicateUsername.status).toBe(400);
      expect(await duplicateUsername.json()).toMatchObject({
        ok: false,
        error: { message: "Username already exists" },
      });
      expect(duplicateEmail.status).toBe(400);
      expect(await duplicateEmail.json()).toMatchObject({
        ok: false,
        error: { message: "Email already exists" },
      });
      expect(failedReload.status).toBe(400);
      expect(await failedReload.json()).toMatchObject({
        ok: false,
        error: { message: "Failed to update profile" },
      });
      expect(unsupported.status).toBe(405);
      expect(await unsupported.json()).toMatchObject({
        ok: false,
        error: { message: "Method Not Allowed" },
      });
    });

    it("updates the profile with normalized identity fields and timezone", async () => {
      setSession(userSession);
      const actor = userRow({
        id: "user-1",
        username: "old",
        email: "old@example.test",
        system_role: "user",
        password_hash: argonHash("old-password"),
      });
      const updated = userRow({
        ...actor,
        username: "new",
        email: "new@example.test",
        name: "New Name",
        timezone: "Asia/Shanghai",
        updated_at: 301,
      });
      const update = statement();
      const { env } = createEnv([
        statement({ first: actor }),
        statement({ first: null }),
        statement({ first: null }),
        update,
        statement({ first: updated }),
      ]);

      const response = await dispatch(
        "/api/private/admin/profile",
        env,
        jsonInit({
          username: " New ",
          email: " New@Example.Test ",
          name: "New Name",
          timeZone: "Asia/Shanghai",
          currentPassword: "old-password",
          password: "new-password",
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: publicUser(updated),
      });
      expect(update.bind).toHaveBeenCalledWith(
        "new",
        "new@example.test",
        "New Name",
        expect.stringMatching(/^argon2id\$/),
        "Asia/Shanghai",
        "",
        "user-1",
      );
    });

    it("updates and validates profile preferred locale", async () => {
      setSession(userSession);

      for (const [inputLocale, savedLocale, expectedLocale] of [
        ["en", "en", "en"],
        ["zh", "zh", "zh"],
        ["", "", ""],
      ] as const) {
        const actor = userRow({
          id: "user-1",
          system_role: "user",
          preferred_locale: "zh",
        });
        const updated = userRow({
          ...actor,
          preferred_locale: savedLocale,
          updated_at: 301,
        });
        const update = statement();
        const { env } = createEnv([
          statement({ first: actor }),
          statement({ first: null }),
          statement({ first: null }),
          update,
          statement({ first: updated }),
        ]);

        const response = await dispatch(
          "/api/private/admin/profile",
          env,
          jsonInit({ preferredLocale: inputLocale }),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          ok: true,
          data: { preferredLocale: expectedLocale },
        });
        expect(update.bind).toHaveBeenCalledWith(
          "admin",
          "admin@example.test",
          "Admin User",
          actor.password_hash,
          "UTC",
          savedLocale,
          "user-1",
        );
      }

      const invalidLocale = await dispatch(
        "/api/private/admin/profile",
        createEnv([statement({ first: userRow({ id: "user-1" }) })]).env,
        jsonInit({ preferredLocale: "fr" }),
      );

      expect(invalidLocale.status).toBe(400);
      expect(await invalidLocale.json()).toMatchObject({
        ok: false,
        error: { message: "Invalid preferred locale" },
      });
    });
  });

  describe("teams route", () => {
    it("lists every team for system admins and memberships for normal users", async () => {
      setSession(adminSession);
      const adminRows = [
        { id: "team-1", name: "Team", membershipRole: "owner" },
        { id: "team-2", name: "Team 2", membershipRole: "ignored" },
      ];
      const adminEnv = createEnv([
        statement({ first: userRow() }),
        statement({ all: adminRows }),
      ]).env;
      const adminResponse = await dispatch(
        "/api/private/admin/teams",
        adminEnv,
      );

      setSession(userSession);
      const userRows = [
        { id: "team-3", name: "Member Team", membershipRole: "admin" },
      ];
      const userEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ all: userRows }),
      ]).env;
      const userResponse = await dispatch("/api/private/admin/teams", userEnv);

      expect(await adminResponse.json()).toMatchObject({
        ok: true,
        data: [
          { ...adminRows[0], membershipRole: "owner" },
          { ...adminRows[1], membershipRole: "member" },
        ],
      });
      expect(await userResponse.json()).toMatchObject({
        ok: true,
        data: [{ ...userRows[0], membershipRole: "admin" }],
      });
    });

    it("creates teams with unique slugs", async () => {
      setSession(userSession);
      mockUuid("00000000-0000-4000-8000-000000000201");
      const insertTeam = statement();
      const insertMember = statement();
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { ok: 1 } }),
        statement({ first: null }),
        insertTeam,
        insertMember,
      ]);

      const response = await dispatch(
        "/api/private/admin/teams",
        env,
        jsonInit({ name: "Product Analytics", slug: "Product Analytics" }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          id: "00000000-0000-4000-8000-000000000201",
          name: "Product Analytics",
          slug: "product-analytics-2",
          ownerUserId: "user-1",
          membershipRole: "owner",
        },
      });
      expect(insertTeam.bind).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000201",
        "Product Analytics",
        "product-analytics-2",
        "user-1",
      );
      expect(insertMember.bind).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000201",
        "user-1",
      );
    });

    it("validates team create and patch identifiers before writes", async () => {
      setSession(userSession);
      const createEnvWithoutName = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
      ]).env;
      const missingName = await dispatch(
        "/api/private/admin/teams",
        createEnvWithoutName,
        jsonInit({ name: "x" }),
      );

      const patchEnvWithoutTeamId = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
      ]).env;
      const missingTeamId = await dispatch(
        "/api/private/admin/teams",
        patchEnvWithoutTeamId,
        jsonInit({ name: "Renamed" }, "PATCH"),
      );

      expect(missingName.status).toBe(400);
      expect(await missingName.json()).toMatchObject({
        ok: false,
        error: { message: "Team name is required" },
      });
      expect(missingTeamId.status).toBe(400);
      expect(await missingTeamId.json()).toMatchObject({
        ok: false,
        error: { message: "teamId is required" },
      });
    });

    it("denies team updates when the actor cannot manage the team", async () => {
      setSession(userSession);
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: null }),
      ]);

      const response = await dispatch(
        "/api/private/admin/teams",
        env,
        jsonInit({ teamId: "team-1", name: "Renamed" }, "PATCH"),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Only team owner can update team" },
      });
    });

    it("returns not found when an updatable team no longer exists", async () => {
      setSession(adminSession);
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({ first: null }),
      ]);

      const response = await dispatch(
        "/api/private/admin/teams",
        env,
        jsonInit({ teamId: "missing-1", name: "Renamed" }, "PATCH"),
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Team not found" },
      });
    });

    it("updates team names and regenerates unique slugs", async () => {
      setSession(userSession);
      vi.spyOn(Date, "now").mockReturnValue(1_779_708_000_000);
      const update = statement();
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({
          first: {
            id: "team-1",
            name: "Old",
            slug: "old",
            ownerUserId: "user-1",
            createdAt: 10,
            updatedAt: 20,
          },
        }),
        statement({ first: null }),
        update,
      ]);

      const response = await dispatch(
        "/api/private/admin/teams",
        env,
        jsonInit(
          { teamId: "team-1", name: "Renamed Team", slug: "Renamed Team" },
          "PATCH",
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          id: "team-1",
          name: "Renamed Team",
          slug: "renamed-team",
          ownerUserId: "user-1",
          createdAt: 10,
          updatedAt: 1_779_708_000,
        },
      });
      expect(update.bind).toHaveBeenCalledWith(
        "Renamed Team",
        "renamed-team",
        "team-1",
      );
    });

    it("transfers team ownership with a D1 batch", async () => {
      setSession(userSession);
      vi.spyOn(Date, "now").mockReturnValue(1_779_708_000_000);
      const ownerUpdate = statement();
      const newOwnerMembership = statement();
      const oldOwnerMembership = statement();
      const { env, batch } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({
          first: {
            id: "team-1",
            name: "Team",
            slug: "team",
            ownerUserId: "user-1",
            createdAt: 10,
            updatedAt: 20,
          },
        }),
        statement({ first: { role: "member" } }),
        ownerUpdate,
        newOwnerMembership,
        oldOwnerMembership,
      ]);

      const response = await dispatch(
        "/api/private/admin/teams",
        env,
        jsonInit(
          {
            intent: "transfer_owner",
            teamId: "team-1",
            newOwnerUserId: "user-2",
          },
          "PATCH",
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          id: "team-1",
          name: "Team",
          slug: "team",
          ownerUserId: "user-2",
          createdAt: 10,
          updatedAt: 1_779_708_000,
          transferred: true,
        },
      });
      expect(ownerUpdate.bind).toHaveBeenCalledWith("user-2", "team-1");
      expect(newOwnerMembership.bind).toHaveBeenCalledWith("team-1", "user-2");
      expect(oldOwnerMembership.bind).toHaveBeenCalledWith("team-1", "user-1");
      expect(batch).toHaveBeenCalledWith([
        ownerUpdate,
        newOwnerMembership,
        oldOwnerMembership,
      ]);
    });

    it("validates team ownership transfer guard rails", async () => {
      setSession(userSession);
      const existing = {
        id: "team-1",
        name: "Team",
        slug: "team",
        ownerUserId: "user-1",
        createdAt: 10,
        updatedAt: 20,
      };

      const sameOwnerEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: existing }),
      ]).env;
      const sameOwner = await dispatch(
        "/api/private/admin/teams",
        sameOwnerEnv,
        jsonInit(
          {
            intent: "transfer_owner",
            teamId: "team-1",
            newOwnerUserId: "user-1",
          },
          "PATCH",
        ),
      );

      const missingTargetEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: existing }),
      ]).env;
      const missingTarget = await dispatch(
        "/api/private/admin/teams",
        missingTargetEnv,
        jsonInit(
          {
            intent: "transfer_owner",
            teamId: "team-1",
          },
          "PATCH",
        ),
      );

      const missingMemberEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: existing }),
        statement({ first: null }),
      ]).env;
      const missingMember = await dispatch(
        "/api/private/admin/teams",
        missingMemberEnv,
        jsonInit(
          {
            intent: "transfer_owner",
            teamId: "team-1",
            newOwnerUserId: "user-2",
          },
          "PATCH",
        ),
      );

      const notOwnerEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: { role: "admin" } }),
        statement({ first: { ...existing, ownerUserId: "owner-1" } }),
      ]).env;
      const notOwner = await dispatch(
        "/api/private/admin/teams",
        notOwnerEnv,
        jsonInit(
          {
            intent: "transfer_owner",
            teamId: "team-1",
            newOwnerUserId: "user-2",
          },
          "PATCH",
        ),
      );

      expect(sameOwner.status).toBe(400);
      expect(await sameOwner.json()).toMatchObject({
        ok: false,
        error: { message: "Already the team owner" },
      });
      expect(missingTarget.status).toBe(400);
      expect(await missingTarget.json()).toMatchObject({
        ok: false,
        error: { message: "newOwnerUserId is required" },
      });
      expect(missingMember.status).toBe(400);
      expect(await missingMember.json()).toMatchObject({
        ok: false,
        error: { message: "Target user is not a team member" },
      });
      expect(notOwner.status).toBe(403);
      expect(await notOwner.json()).toMatchObject({
        ok: false,
        error: { message: "Only the team owner can transfer ownership" },
      });
    });

    it("deletes teams and cascades site data cleanup", async () => {
      setSession(adminSession);
      deleteSiteScriptSettingsMock.mockResolvedValue(undefined);
      const deleteStatements = Array.from({ length: 12 }, () => statement());
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({
          first: {
            id: "team-1",
            name: "Team",
            slug: "team",
            ownerUserId: "user-1",
            createdAt: 10,
            updatedAt: 20,
          },
        }),
        statement({ all: [{ id: "site-1" }, { id: "site-2" }] }),
        ...deleteStatements,
      ]);

      const response = await dispatch(
        "/api/private/admin/teams",
        env,
        jsonInit({ intent: "delete", teamId: "team-1" }, "PATCH"),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: { teamId: "team-1", removed: true },
      });
      expect(deleteStatements[0].bind).toHaveBeenCalledWith("site-1", "site-2");
      expect(deleteStatements[7].bind).toHaveBeenCalledWith("site-1", "site-2");
      expect(deleteStatements[8].bind).toHaveBeenCalledWith("site-1", "site-2");
      expect(deleteStatements[9].bind).toHaveBeenCalledWith(
        "site:site-1",
        "site:site-2",
      );
      expect(deleteStatements[10].bind).toHaveBeenCalledWith("team-1");
      expect(deleteSiteScriptSettingsMock).toHaveBeenCalledWith(env, "site-1");
      expect(deleteSiteScriptSettingsMock).toHaveBeenCalledWith(env, "site-2");
    });

    it("deletes teams without site cleanup when no sites exist", async () => {
      setSession(adminSession);
      const deleteTeam = statement();
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({
          first: {
            id: "team-1",
            name: "Team",
            slug: "team",
            ownerUserId: "user-1",
            createdAt: 10,
            updatedAt: 20,
          },
        }),
        statement({ all: [] }),
        deleteTeam,
      ]);

      const response = await dispatch(
        "/api/private/admin/teams",
        env,
        jsonInit({ intent: "remove", teamId: "team-1" }, "PATCH"),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: { teamId: "team-1", removed: true },
      });
      expect(deleteTeam.bind).toHaveBeenCalledWith("team-1");
      expect(deleteSiteScriptSettingsMock).not.toHaveBeenCalled();
    });
  });

  describe("sites route", () => {
    it("requires team ids when listing sites", async () => {
      setSession(adminSession);
      const { env, prepare } = createEnv([statement({ first: userRow() })]);

      const response = await dispatch("/api/private/admin/sites", env);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Missing teamId" },
      });
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it("lists sites for readable teams", async () => {
      setSession(userSession);
      const rows = [
        {
          id: "site-1",
          teamId: "team-1",
          name: "Docs",
          domain: "docs.example.test",
        },
      ];
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: { role: "member" } }),
        statement({ all: rows }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: { role: "member", siteIdsJson: "[]" } }),
      ]);

      const response = await dispatch(
        "/api/private/admin/sites?teamId=team-1",
        env,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, data: rows });
    });

    it("denies site listing when the team is not readable", async () => {
      setSession(userSession);
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: null }),
      ]);

      const response = await dispatch(
        "/api/private/admin/sites?teamId=team-1",
        env,
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Team access denied" },
      });
    });

    it("creates sites and initializes script settings", async () => {
      setSession(userSession);
      mockUuid("00000000-0000-4000-8000-000000000301");
      upsertSiteScriptSettingsMock.mockResolvedValue(
        DEFAULT_SITE_SCRIPT_SETTINGS,
      );
      const slugCheck = statement({ first: null });
      const insertSite = statement();
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        slugCheck,
        insertSite,
      ]);

      const response = await dispatch(
        "/api/private/admin/sites",
        env,
        jsonInit({
          teamId: "team-1",
          name: "Docs Site",
          domain: "docs.example.test",
          publicEnabled: "yes",
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          id: "00000000-0000-4000-8000-000000000301",
          teamId: "team-1",
          name: "Docs Site",
          domain: "docs.example.test",
          publicEnabled: true,
          publicSlug: "docs-site",
        },
      });
      expect(insertSite.bind).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000301",
        "team-1",
        "Docs Site",
        "docs.example.test",
        1,
        "docs-site",
      );
      expect(upsertSiteScriptSettingsMock).toHaveBeenCalledWith(
        env,
        "00000000-0000-4000-8000-000000000301",
        {
          siteDomain: "docs.example.test",
          settings: DEFAULT_SITE_SCRIPT_SETTINGS,
        },
      );
    });

    it("validates site creation payloads and team permissions", async () => {
      setSession(userSession);
      const missingFieldsEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
      ]).env;
      const missingFields = await dispatch(
        "/api/private/admin/sites",
        missingFieldsEnv,
        jsonInit({ teamId: "team-1", name: "Docs" }),
      );

      const forbiddenEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: null }),
      ]).env;
      const forbidden = await dispatch(
        "/api/private/admin/sites",
        forbiddenEnv,
        jsonInit({
          teamId: "team-1",
          name: "Docs",
          domain: "docs.example.test",
        }),
      );

      expect(missingFields.status).toBe(400);
      expect(await missingFields.json()).toMatchObject({
        ok: false,
        error: { message: "teamId, name and domain are required" },
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({
        ok: false,
        error: { message: "Only team owner can create sites" },
      });
    });

    it("rolls back newly inserted sites when settings initialization fails", async () => {
      setSession(adminSession);
      mockUuid("00000000-0000-4000-8000-000000000302");
      upsertSiteScriptSettingsMock.mockRejectedValue(new Error("kv down"));
      const insertSite = statement();
      const deleteSite = statement();
      const { env } = createEnv([
        statement({ first: userRow() }),
        insertSite,
        deleteSite,
      ]);

      const response = await dispatch(
        "/api/private/admin/sites",
        env,
        jsonInit({
          teamId: "team-1",
          name: "Docs",
          domain: "docs.example.test",
        }),
      );

      expect(response.status).toBe(500);

      expect(insertSite.bind).toHaveBeenCalled();
      expect(deleteSite.bind).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000302",
      );
    });

    it("updates sites across teams and syncs script settings domain", async () => {
      setSession(userSession);
      upsertSiteScriptSettingsMock.mockResolvedValue(
        DEFAULT_SITE_SCRIPT_SETTINGS,
      );
      const update = statement();
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({
          first: {
            id: "site-1",
            teamId: "team-1",
            name: "Old",
            domain: "old.example.test",
            publicEnabled: 0,
            publicSlug: null,
          },
        }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: { id: "team-2", ownerUserId: "user-1" } }),
        update,
      ]);

      const response = await dispatch(
        "/api/private/admin/sites",
        env,
        jsonInit(
          {
            siteId: "site-1",
            teamId: "team-2",
            name: "New Site",
            domain: "new.example.test",
            publicEnabled: false,
            publicSlug: "public-new",
          },
          "PATCH",
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          id: "site-1",
          teamId: "team-2",
          name: "New Site",
          domain: "new.example.test",
          publicEnabled: false,
          publicSlug: "",
        },
      });
      expect(update.bind).toHaveBeenCalledWith(
        "team-2",
        "New Site",
        "new.example.test",
        0,
        null,
        "site-1",
      );
      expect(upsertSiteScriptSettingsMock).toHaveBeenCalledWith(env, "site-1", {
        siteDomain: "new.example.test",
      });
    });

    it("updates sites with public slugs when publishing", async () => {
      setSession(adminSession);
      upsertSiteScriptSettingsMock.mockResolvedValue(
        DEFAULT_SITE_SCRIPT_SETTINGS,
      );
      const slugCheck = statement({ first: null });
      const update = statement();
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({
          first: {
            id: "site-1",
            teamId: "team-1",
            name: "Docs",
            domain: "docs.example.test",
            publicEnabled: 0,
            publicSlug: null,
          },
        }),
        slugCheck,
        update,
      ]);

      const response = await dispatch(
        "/api/private/admin/sites",
        env,
        jsonInit({ siteId: "site-1", publicEnabled: true }, "PATCH"),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          id: "site-1",
          teamId: "team-1",
          name: "Docs",
          domain: "docs.example.test",
          publicEnabled: true,
          publicSlug: "docs",
        },
      });
      expect(update.bind).toHaveBeenCalledWith(
        "team-1",
        "Docs",
        "docs.example.test",
        1,
        "docs",
        "site-1",
      );
    });

    it("returns site patch validation and not found errors", async () => {
      setSession(adminSession);
      const missingIdEnv = createEnv([statement({ first: userRow() })]).env;
      const missingId = await dispatch(
        "/api/private/admin/sites",
        missingIdEnv,
        jsonInit({ name: "Docs" }, "PATCH"),
      );

      const missingSiteEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: null }),
      ]).env;
      const missingSite = await dispatch(
        "/api/private/admin/sites",
        missingSiteEnv,
        jsonInit({ siteId: "missing-1" }, "PATCH"),
      );

      expect(missingId.status).toBe(400);
      expect(await missingId.json()).toMatchObject({
        ok: false,
        error: { message: "siteId is required" },
      });
      expect(missingSite.status).toBe(404);
      expect(await missingSite.json()).toMatchObject({
        ok: false,
        error: { message: "Site not found" },
      });
    });

    it("denies site transfers without target team ownership and rejects unsupported methods", async () => {
      setSession(userSession);
      const transferEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({
          first: {
            id: "site-1",
            teamId: "team-1",
            name: "Docs",
            domain: "docs.example.test",
            publicEnabled: 0,
            publicSlug: null,
          },
        }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: { id: "team-2", ownerUserId: "owner-2" } }),
        statement({ first: null }),
      ]).env;
      const forbiddenTransfer = await dispatch(
        "/api/private/admin/sites",
        transferEnv,
        jsonInit({ siteId: "site-1", teamId: "team-2" }, "PATCH"),
      );

      setSession(adminSession);
      const unsupported = await dispatch(
        "/api/private/admin/sites",
        createEnv([statement({ first: userRow() })]).env,
        { method: "DELETE" },
      );

      expect(forbiddenTransfer.status).toBe(403);
      expect(await forbiddenTransfer.json()).toMatchObject({
        ok: false,
        error: { message: "Only team owner can transfer sites" },
      });
      expect(unsupported.status).toBe(405);
      expect(await unsupported.json()).toMatchObject({
        ok: false,
        error: { message: "Method Not Allowed" },
      });
    });

    it("removes sites and ignores best-effort settings cleanup failures", async () => {
      setSession(adminSession);
      deleteSiteScriptSettingsMock.mockRejectedValue(new Error("kv down"));
      const deleteStatements = Array.from({ length: 12 }, () => statement());
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({
          first: {
            id: "site-1",
            teamId: "team-1",
            name: "Site",
            domain: "site.example.test",
            publicEnabled: 0,
            publicSlug: null,
          },
        }),
        ...deleteStatements,
      ]);

      const response = await dispatch(
        "/api/private/admin/sites",
        env,
        jsonInit({ intent: "remove", siteId: "site-1" }, "PATCH"),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: { siteId: "site-1", teamId: "team-1", removed: true },
      });
      expect(deleteStatements[8].bind).toHaveBeenCalledWith("site-1");
      expect(deleteStatements[9].bind).toHaveBeenCalledWith("site-1");
      expect(deleteStatements[10].bind).toHaveBeenCalledWith("site-1");
      expect(deleteSiteScriptSettingsMock).toHaveBeenCalledWith(env, "site-1");
    });
  });

  describe("members route", () => {
    it("lists members for readable teams", async () => {
      setSession(userSession);
      const rows = [
        {
          teamId: "team-1",
          userId: "user-2",
          role: "member",
          username: "member",
        },
      ];
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: { role: "admin" } }),
        statement({ all: rows }),
      ]);

      const response = await dispatch(
        "/api/private/admin/members?teamId=team-1",
        env,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, data: rows });
    });

    it("validates member listing and add guard rails", async () => {
      setSession(userSession);
      const actor = userRow({ id: "user-1", system_role: "user" });

      const missingTeamId = await dispatch(
        "/api/private/admin/members",
        createEnv([statement({ first: actor })]).env,
      );

      const deniedList = await dispatch(
        "/api/private/admin/members?teamId=team-1",
        createEnv([
          statement({ first: actor }),
          statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
          statement({ first: null }),
        ]).env,
      );

      const missingIdentifier = await dispatch(
        "/api/private/admin/members",
        createEnv([statement({ first: actor })]).env,
        jsonInit({ teamId: "team-1" }),
      );

      const missingTeam = await dispatch(
        "/api/private/admin/members",
        createEnv([statement({ first: actor }), statement({ first: null })])
          .env,
        jsonInit({ teamId: "missing-1", userId: "member-1" }),
      );

      const forbidden = await dispatch(
        "/api/private/admin/members",
        createEnv([
          statement({ first: actor }),
          statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
          statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
          statement({ first: null }),
        ]).env,
        jsonInit({ teamId: "team-1", userId: "member-1" }),
      );

      const missingUser = await dispatch(
        "/api/private/admin/members",
        createEnv([
          statement({ first: actor }),
          statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
          statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
          statement({ first: null }),
        ]).env,
        jsonInit({ teamId: "team-1", userId: "missing-1" }),
      );

      expect(missingTeamId.status).toBe(400);
      expect(await missingTeamId.json()).toMatchObject({
        ok: false,
        error: { message: "Missing teamId" },
      });
      expect(deniedList.status).toBe(403);
      expect(await deniedList.json()).toMatchObject({
        ok: false,
        error: { message: "Team access denied" },
      });
      expect(missingIdentifier.status).toBe(400);
      expect(await missingIdentifier.json()).toMatchObject({
        ok: false,
        error: { message: "teamId and user identifier are required" },
      });
      expect(missingTeam.status).toBe(404);
      expect(await missingTeam.json()).toMatchObject({
        ok: false,
        error: { message: "Team not found" },
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({
        ok: false,
        error: { message: "Only team owner can manage members" },
      });
      expect(missingUser.status).toBe(404);
      expect(await missingUser.json()).toMatchObject({
        ok: false,
        error: { message: "User not found" },
      });
    });

    it("adds members by identifier with requested non-owner roles", async () => {
      setSession(userSession);
      const member = userRow({
        id: "member-1",
        username: "member",
        email: "member@example.test",
        name: null,
        system_role: "user",
      });
      const upsertMember = statement();
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: member }),
        statement({ first: null }),
        upsertMember,
      ]);

      const response = await dispatch(
        "/api/private/admin/members",
        env,
        jsonInit({
          teamId: "team-1",
          identifier: "Member@Example.Test",
          role: "ADMIN",
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          teamId: "team-1",
          userId: "member-1",
          role: "admin",
          siteIds: [],
          username: "member",
          email: "member@example.test",
          name: "",
        },
      });
      expect(upsertMember.bind).toHaveBeenCalledWith(
        "team-1",
        "member-1",
        "admin",
        "[]",
      );
    });

    it("upserts owner membership when adding the team owner", async () => {
      setSession(adminSession);
      const owner = userRow({
        id: "owner-1",
        username: "owner",
        email: "owner@example.test",
      });
      const upsertOwner = statement();
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: owner }),
        upsertOwner,
      ]);

      const response = await dispatch(
        "/api/private/admin/members",
        env,
        jsonInit({ teamId: "team-1", userId: "owner-1" }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          teamId: "team-1",
          userId: "owner-1",
          role: "owner",
          username: "owner",
          email: "owner@example.test",
          name: "Admin User",
        },
      });
      expect(upsertOwner.bind).toHaveBeenCalledWith("team-1", "owner-1");
    });

    it("rejects direct owner assignment and owner membership rewrites", async () => {
      setSession(adminSession);
      const ownerRoleEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: userRow({ id: "member-1" }) }),
      ]).env;
      const ownerRole = await dispatch(
        "/api/private/admin/members",
        ownerRoleEnv,
        jsonInit({ teamId: "team-1", userId: "member-1", role: "owner" }),
      );

      const existingOwnerEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: userRow({ id: "member-1" }) }),
        statement({ first: { role: "owner" } }),
      ]).env;
      const existingOwner = await dispatch(
        "/api/private/admin/members",
        existingOwnerEnv,
        jsonInit({ teamId: "team-1", userId: "member-1", role: "admin" }),
      );

      expect(ownerRole.status).toBe(400);
      expect(await ownerRole.json()).toMatchObject({
        ok: false,
        error: {
          message: "Cannot assign owner via member add; use ownership transfer",
        },
      });
      expect(existingOwner.status).toBe(403);
      expect(await existingOwner.json()).toMatchObject({
        ok: false,
        error: { message: "Cannot change team owner membership" },
      });
    });

    it("protects member role updates and removals with validation guard rails", async () => {
      setSession(adminSession);
      const missingIds = await dispatch(
        "/api/private/admin/members",
        createEnv([statement({ first: userRow() })]).env,
        jsonInit({ teamId: "team-1" }, "PATCH"),
      );

      const missingTeam = await dispatch(
        "/api/private/admin/members",
        createEnv([statement({ first: userRow() }), statement({ first: null })])
          .env,
        jsonInit({ teamId: "missing-1", userId: "member-1" }, "PATCH"),
      );

      const missingMember = await dispatch(
        "/api/private/admin/members",
        createEnv([
          statement({ first: userRow() }),
          statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
          statement({ first: null }),
        ]).env,
        jsonInit({ teamId: "team-1", userId: "missing-1" }, "PATCH"),
      );

      const ownerRoleChange = await dispatch(
        "/api/private/admin/members",
        createEnv([
          statement({ first: userRow() }),
          statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
          statement({ first: { role: "member" } }),
        ]).env,
        jsonInit(
          {
            intent: "update_role",
            teamId: "team-1",
            userId: "owner-1",
            role: "admin",
          },
          "PATCH",
        ),
      );

      const promoteToOwner = await dispatch(
        "/api/private/admin/members",
        createEnv([
          statement({ first: userRow() }),
          statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
          statement({ first: { role: "member" } }),
        ]).env,
        jsonInit(
          {
            intent: "update_role",
            teamId: "team-1",
            userId: "member-1",
            role: "owner",
          },
          "PATCH",
        ),
      );

      const removeOwner = await dispatch(
        "/api/private/admin/members",
        createEnv([
          statement({ first: userRow() }),
          statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
          statement({ first: { role: "member" } }),
        ]).env,
        jsonInit({ teamId: "team-1", userId: "owner-1" }, "PATCH"),
      );

      setSession(userSession);
      const forbidden = await dispatch(
        "/api/private/admin/members",
        createEnv([
          statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
          statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
          statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
          statement({ first: null }),
        ]).env,
        jsonInit({ teamId: "team-1", userId: "member-1" }, "PATCH"),
      );

      const unsupported = await dispatch(
        "/api/private/admin/members",
        createEnv([
          statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        ]).env,
        { method: "DELETE" },
      );

      expect(missingIds.status).toBe(400);
      expect(await missingIds.json()).toMatchObject({
        ok: false,
        error: { message: "teamId and userId are required" },
      });
      expect(missingTeam.status).toBe(404);
      expect(await missingTeam.json()).toMatchObject({
        ok: false,
        error: { message: "Team not found" },
      });
      expect(missingMember.status).toBe(404);
      expect(await missingMember.json()).toMatchObject({
        ok: false,
        error: { message: "Member not found" },
      });
      expect(ownerRoleChange.status).toBe(400);
      expect(await ownerRoleChange.json()).toMatchObject({
        ok: false,
        error: { message: "Cannot change team owner role" },
      });
      expect(promoteToOwner.status).toBe(400);
      expect(await promoteToOwner.json()).toMatchObject({
        ok: false,
        error: { message: "Cannot promote to owner; use ownership transfer" },
      });
      expect(removeOwner.status).toBe(400);
      expect(await removeOwner.json()).toMatchObject({
        ok: false,
        error: { message: "Cannot remove team owner" },
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({
        ok: false,
        error: { message: "Only team owner can manage members" },
      });
      expect(unsupported.status).toBe(405);
      expect(await unsupported.json()).toMatchObject({
        ok: false,
        error: { message: "Method Not Allowed" },
      });
    });

    it("updates member roles and returns unchanged results without writes", async () => {
      setSession(userSession);
      const update = statement();
      const updateEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: { role: "member" } }),
        update,
      ]).env;
      const updated = await dispatch(
        "/api/private/admin/members",
        updateEnv,
        jsonInit(
          {
            intent: "update_role",
            teamId: "team-1",
            userId: "member-1",
            role: "admin",
          },
          "PATCH",
        ),
      );

      const unchangedEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: { role: "admin" } }),
      ]).env;
      const unchanged = await dispatch(
        "/api/private/admin/members",
        unchangedEnv,
        jsonInit(
          {
            intent: "update_role",
            teamId: "team-1",
            userId: "member-1",
            role: "admin",
          },
          "PATCH",
        ),
      );

      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({
        ok: true,
        data: {
          teamId: "team-1",
          userId: "member-1",
          role: "admin",
          updated: true,
        },
      });
      expect(update.bind).toHaveBeenCalledWith("admin", "team-1", "member-1");
      expect(await unchanged.json()).toMatchObject({
        ok: true,
        data: {
          teamId: "team-1",
          userId: "member-1",
          role: "admin",
          unchanged: true,
        },
      });
    });

    it("prevents self-demotion by team admins and removes ordinary members", async () => {
      setSession(userSession);
      const selfDemotionEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: { role: "admin" } }),
        statement({ first: { role: "admin" } }),
      ]).env;
      const selfDemotion = await dispatch(
        "/api/private/admin/members",
        selfDemotionEnv,
        jsonInit(
          {
            intent: "update_role",
            teamId: "team-1",
            userId: "user-1",
            role: "member",
          },
          "PATCH",
        ),
      );

      const remove = statement();
      const removeEnv = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: { role: "member" } }),
        remove,
      ]).env;
      const removed = await dispatch(
        "/api/private/admin/members",
        removeEnv,
        jsonInit({ teamId: "team-1", userId: "member-1" }, "PATCH"),
      );

      expect(selfDemotion.status).toBe(400);
      expect(await selfDemotion.json()).toMatchObject({
        ok: false,
        error: {
          message: "Cannot demote yourself; ask another admin or the owner",
        },
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({
        ok: true,
        data: { teamId: "team-1", userId: "member-1", removed: true },
      });
      expect(remove.bind).toHaveBeenCalledWith("team-1", "member-1");
    });
  });

  describe("site config and script snippet routes", () => {
    it("loads default script settings for readable sites", async () => {
      setSession(userSession);
      readSiteTrackingConfigMock.mockResolvedValue(null);
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { team_id: "team-1" } }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: { role: "member" } }),
      ]);

      const response = await dispatch(
        "/api/private/admin/site-config?siteId=site-1",
        env,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: DEFAULT_SITE_SCRIPT_SETTINGS,
      });
      expect(readSiteTrackingConfigMock).toHaveBeenCalledWith(env, "site-1");
    });

    it("returns read and write site config storage errors as 500 responses", async () => {
      setSession(adminSession);
      readSiteTrackingConfigMock.mockRejectedValue(new Error("read failed"));
      const readEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: { team_id: "team-1" } }),
      ]).env;
      const readResponse = await dispatch(
        "/api/private/admin/site-config?siteId=site-1",
        readEnv,
      );

      upsertSiteTrackingConfigMock.mockRejectedValue(new Error("write failed"));
      const writeEnv = createEnv([
        statement({ first: userRow() }),
        statement({ first: { team_id: "team-1" } }),
        statement({ first: { domain: "site.example.test" } }),
      ]).env;
      const writeResponse = await dispatch(
        "/api/private/admin/site-config",
        writeEnv,
        jsonInit({ siteId: "site-1", config: { trackHash: false } }),
      );

      expect(readResponse.status).toBe(500);
      expect(await readResponse.json()).toMatchObject({
        ok: false,
        error: "read failed",
      });
      expect(writeResponse.status).toBe(500);
      expect(await writeResponse.json()).toMatchObject({
        ok: false,
        error: "write failed",
      });
    });

    it("validates site config inputs, access, and fallback storage errors", async () => {
      setSession(userSession);
      const missingRead = await dispatch(
        "/api/private/admin/site-config",
        createEnv([
          statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        ]).env,
      );

      const deniedRead = await dispatch(
        "/api/private/admin/site-config?siteId=site-1",
        createEnv([
          statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
          statement({ first: { team_id: "team-1" } }),
          statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
          statement({ first: null }),
        ]).env,
      );

      const missingWrite = await dispatch(
        "/api/private/admin/site-config",
        createEnv([
          statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        ]).env,
        jsonInit({ config: { trackHash: false } }),
      );

      setSession(adminSession);
      const missingSite = await dispatch(
        "/api/private/admin/site-config",
        createEnv([
          statement({ first: userRow() }),
          statement({ first: { team_id: "team-1" } }),
          statement({ first: null }),
        ]).env,
        jsonInit({ siteId: "missing-1" }),
      );

      upsertSiteTrackingConfigMock.mockRejectedValue("kv failed");
      const fallbackWriteError = await dispatch(
        "/api/private/admin/site-config",
        createEnv([
          statement({ first: userRow() }),
          statement({ first: { team_id: "team-1" } }),
          statement({ first: { domain: "site.example.test" } }),
        ]).env,
        jsonInit({ siteId: "site-1", config: null }),
      );

      expect(missingRead.status).toBe(400);
      expect(await missingRead.json()).toMatchObject({
        ok: false,
        error: { message: "Missing siteId" },
      });
      expect(deniedRead.status).toBe(403);
      expect(await deniedRead.json()).toMatchObject({
        ok: false,
        error: { message: "Site access denied" },
      });
      expect(missingWrite.status).toBe(400);
      expect(await missingWrite.json()).toMatchObject({
        ok: false,
        error: { message: "siteId is required" },
      });
      expect(missingSite.status).toBe(404);
      expect(await missingSite.json()).toMatchObject({
        ok: false,
        error: { message: "Site not found" },
      });
      expect(fallbackWriteError.status).toBe(500);
      expect(await fallbackWriteError.json()).toMatchObject({
        ok: false,
        error: "save_site_config_failed",
      });
      expect(upsertSiteTrackingConfigMock).toHaveBeenLastCalledWith(
        expect.anything(),
        "site-1",
        {
          siteDomain: "site.example.test",
          settings: {},
        },
      );
    });

    it("saves site config after confirming site ownership and domain", async () => {
      setSession(userSession);
      const saved = { ...DEFAULT_SITE_SCRIPT_SETTINGS, trackHash: false };
      upsertSiteTrackingConfigMock.mockResolvedValue({
        siteId: "site-1",
        siteDomain: "site.example.test",
        allowedHostnames: [],
        ...saved,
      });
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { team_id: "team-1" } }),
        statement({ first: { id: "team-1", ownerUserId: "user-1" } }),
        statement({ first: { domain: "site.example.test" } }),
      ]);

      const response = await dispatch(
        "/api/private/admin/site-config",
        env,
        jsonInit({ siteId: "site-1", config: { trackHash: false } }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, data: saved });
      expect(upsertSiteTrackingConfigMock).toHaveBeenCalledWith(env, "site-1", {
        siteDomain: "site.example.test",
        settings: { trackHash: false },
      });
    });

    it("denies site config writes when the actor cannot manage the site team", async () => {
      setSession(userSession);
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
        statement({ first: { team_id: "team-1" } }),
        statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
        statement({ first: null }),
      ]);

      const response = await dispatch(
        "/api/private/admin/site-config",
        env,
        jsonInit({ siteId: "site-1", config: { trackHash: false } }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Only team owner can update site config" },
      });
      expect(upsertSiteScriptSettingsMock).not.toHaveBeenCalled();
    });

    it("rejects unsupported site config methods after authentication", async () => {
      setSession(adminSession);
      const { env } = createEnv([statement({ first: userRow() })]);

      const response = await dispatch(
        "/api/private/admin/site-config?siteId=site-1",
        env,
        { method: "PATCH" },
      );

      expect(response.status).toBe(405);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Method Not Allowed" },
      });
    });

    it("builds script snippets from the request origin", async () => {
      setSession(adminSession);
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({ first: { team_id: "team-1" } }),
      ]);

      const response = await dispatch(
        "/api/private/admin/script-snippet?siteId=site 1",
        env,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          siteId: "site 1",
          src: "https://edge.test/script.js?siteId=site%201",
          snippet:
            '<script defer src="https://edge.test/script.js?siteId=site%201"></script>',
        },
      });
    });

    it("uses request origin for snippets and validates snippet access", async () => {
      setSession(adminSession);
      const defaultBase = await dispatch(
        "/api/private/admin/script-snippet?siteId=site-1",
        createEnv([
          statement({ first: userRow() }),
          statement({ first: { team_id: "team-1" } }),
        ]).env,
      );

      const missingSiteId = await dispatch(
        "/api/private/admin/script-snippet",
        createEnv([statement({ first: userRow() })]).env,
      );

      setSession(userSession);
      const denied = await dispatch(
        "/api/private/admin/script-snippet?siteId=site-1",
        createEnv([
          statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
          statement({ first: { team_id: "team-1" } }),
          statement({ first: { id: "team-1", ownerUserId: "owner-1" } }),
          statement({ first: null }),
        ]).env,
      );

      expect(defaultBase.status).toBe(200);
      expect(await defaultBase.json()).toMatchObject({
        ok: true,
        data: {
          siteId: "site-1",
          src: "https://edge.test/script.js?siteId=site-1",
          snippet:
            '<script defer src="https://edge.test/script.js?siteId=site-1"></script>',
        },
      });
      expect(missingSiteId.status).toBe(400);
      expect(await missingSiteId.json()).toMatchObject({
        ok: false,
        error: { message: "Missing siteId" },
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        ok: false,
        error: { message: "Site access denied" },
      });
    });

    it("rejects unsupported script snippet methods before authentication", async () => {
      const { env, prepare } = createEnv();

      const response = await dispatch(
        "/api/private/admin/script-snippet?siteId=site-1",
        env,
        { method: "POST" },
      );

      expect(response.status).toBe(405);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Method Not Allowed" },
      });
      expect(requireSessionMock).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    });
  });

  describe("system performance route", () => {
    it("requires system admin access", async () => {
      setSession(userSession);
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
      ]);

      const response = await dispatch(
        "/api/private/admin/system-performance",
        env,
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Only system admin can view system performance" },
      });
    });

    it("rejects unsupported methods after admin authorization", async () => {
      setSession(adminSession);
      const { env, prepare } = createEnv([statement({ first: userRow() })]);

      const response = await dispatch(
        "/api/private/admin/system-performance",
        env,
        { method: "POST" },
      );

      expect(response.status).toBe(405);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Method Not Allowed" },
      });
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it("aggregates system performance rows into API response data", async () => {
      setSession(adminSession);
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const trendRows = [
        {
          bucketSec: 1_799_998_200,
          visits: "2",
          customEvents: 3,
          totalEvents: 5,
          avgLatencyMs: 100.5,
          p50LatencyMs: 80,
          p75LatencyMs: 110,
          p95LatencyMs: 150,
          delayedEvents: 1,
          futureSkewedEvents: 0,
        },
      ];
      const topSiteRows = [
        {
          siteId: "site-1",
          siteName: "Site",
          siteDomain: "site.example.test",
          totalEvents: 10,
          visits: 6,
          customEvents: 4,
          avgLatencyMs: "50",
          delayedEvents: 1,
          futureSkewedEvents: 2,
        },
      ];
      const slowRows = [
        {
          kind: "custom_event",
          siteId: "site-1",
          siteName: "Site",
          siteDomain: "site.example.test",
          eventAtMs: 100,
          serverAtMs: 800,
          latencyMs: 700,
        },
        {
          kind: "other",
          siteId: "site-2",
          siteName: "Site 2",
          siteDomain: "",
          eventAtMs: 200,
          serverAtMs: 300,
          latencyMs: 100,
        },
      ];
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({
          first: {
            totalEvents: 20,
            visits: 12,
            customEvents: 8,
            activeSites: 3,
            avgLatencyMs: 75,
            trustedLatencySamples: 19,
            delayedEvents: 2,
            futureSkewedEvents: 1,
            latestCreatedAtSec: 1_799_999_990,
          },
        }),
        statement({
          first: {
            p50LatencyMs: 50,
            p75LatencyMs: 90,
            p95LatencyMs: 200,
          },
        }),
        statement({ all: trendRows }),
        statement({ all: topSiteRows }),
        statement({ all: slowRows }),
        statement({
          first: {
            total: 4,
            stale: 1,
            timedOut: 2,
            oldestStartedAt: 1_799_900_000_000,
            newestActivityAt: 1_799_999_000_000,
          },
        }),
      ]);

      const response = await dispatch(
        "/api/private/admin/system-performance?minutes=360",
        env,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        generatedAt: 1_800_000_000_000,
        window: {
          from: 1_799_978_400_000,
          to: 1_800_000_000_000,
          minutes: 360,
          bucketSizeMs: 1_800_000,
        },
        summary: {
          totalEvents: 20,
          visits: 12,
          customEvents: 8,
          activeSites: 3,
          eventsPerMinute: 20 / 360,
          latestCreatedAt: 1_799_999_990_000,
          dataFreshnessMs: 10_000,
          avgLatencyMs: 75,
          p50LatencyMs: 50,
          p75LatencyMs: 90,
          p95LatencyMs: 200,
          trustedLatencySamples: 19,
          delayedEvents: 2,
          futureSkewedEvents: 1,
          anomalyRate: 3 / 20,
        },
        openVisits: {
          total: 4,
          stale: 1,
          timedOut: 2,
          oldestStartedAt: 1_799_900_000_000,
          newestActivityAt: 1_799_999_000_000,
        },
        trend: [
          {
            bucket: 1_799_998_200,
            timestampMs: 1_799_998_200_000,
            visits: 2,
            customEvents: 3,
            totalEvents: 5,
            avgLatencyMs: 100.5,
            delayedEvents: 1,
            futureSkewedEvents: 0,
          },
        ],
        topSites: [
          {
            ...topSiteRows[0],
            avgLatencyMs: 50,
          },
        ],
        slowEvents: [
          {
            kind: "custom_event",
            siteId: "site-1",
            latencyMs: 700,
          },
          {
            kind: "visit",
            siteId: "site-2",
            latencyMs: 100,
          },
        ],
      });
    });

    it("defaults invalid windows and normalizes empty system performance rows", async () => {
      setSession(adminSession);
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({
          first: {
            totalEvents: "not-a-number",
            visits: null,
            customEvents: undefined,
            activeSites: Number.POSITIVE_INFINITY,
            avgLatencyMs: "bad",
            trustedLatencySamples: "0",
            delayedEvents: 0,
            futureSkewedEvents: 0,
            latestCreatedAtSec: "bad",
          },
        }),
        statement({ first: {} }),
        statement({ all: [] }),
        statement({ all: [] }),
        statement({ all: [] }),
        statement({ first: {} }),
      ]);

      const response = await dispatch(
        "/api/private/admin/system-performance?minutes=999",
        env,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        window: {
          from: 1_799_996_400_000,
          to: 1_800_000_000_000,
          minutes: 60,
          bucketSizeMs: 300_000,
        },
        summary: {
          totalEvents: 0,
          visits: 0,
          customEvents: 0,
          activeSites: 0,
          eventsPerMinute: 0,
          latestCreatedAt: null,
          dataFreshnessMs: null,
          avgLatencyMs: null,
          p50LatencyMs: null,
          p75LatencyMs: null,
          p95LatencyMs: null,
          trustedLatencySamples: 0,
          delayedEvents: 0,
          futureSkewedEvents: 0,
          anomalyRate: 0,
        },
        openVisits: {
          total: 0,
          stale: 0,
          timedOut: 0,
          oldestStartedAt: null,
          newestActivityAt: null,
        },
        trend: [],
        topSites: [],
        slowEvents: [],
      });
    });

    it("uses hourly buckets for the 1440 minute system performance window", async () => {
      setSession(adminSession);
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({ first: { totalEvents: 0 } }),
        statement({ first: {} }),
        statement({ all: [] }),
        statement({ all: [] }),
        statement({ all: [] }),
        statement({ first: {} }),
      ]);

      const response = await dispatch(
        "/api/private/admin/system-performance?minutes=1440",
        env,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        window: {
          from: 1_799_913_600_000,
          to: 1_800_000_000_000,
          minutes: 1440,
          bucketSizeMs: 3_600_000,
        },
      });
    });
  });

  describe("DO diagnostics route", () => {
    it("requires system admin access for DO diagnostics", async () => {
      setSession(userSession);
      const { env } = createEnv([
        statement({ first: userRow({ id: "user-1", system_role: "user" }) }),
      ]);

      const response = await dispatch("/api/private/admin/do-diagnostic", env);

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Only system admin can view DO diagnostics" },
      });
    });

    it("rejects unsupported DO diagnostic methods after admin authorization", async () => {
      setSession(adminSession);
      const { env } = createEnv([statement({ first: userRow() })]);

      const response = await dispatch("/api/private/admin/do-diagnostic", env, {
        method: "POST",
      });

      expect(response.status).toBe(405);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Method Not Allowed" },
      });
    });

    it("aggregates reachable and unreachable durable object diagnostics", async () => {
      setSession(adminSession);
      vi.spyOn(Date, "now")
        .mockReturnValueOnce(5_000)
        .mockReturnValueOnce(5_010)
        .mockReturnValueOnce(5_020)
        .mockReturnValueOnce(5_030)
        .mockReturnValueOnce(5_040)
        .mockReturnValue(5_050);
      const goodDiagnostic = diagnosticPayload();
      const secondDiagnostic = diagnosticPayload({
        visits: {
          total: 6,
          byStatus: { open: 1 },
          open: {
            total: 1,
            stale: 0,
            timedOut: 0,
            hardAged: 0,
            futureSkewed: 2,
            oldestStartedAt: 700,
            newestActivityAt: 800,
            futureMaxActivityAt: 1_500,
          },
          dirty: {
            total: 4,
            stuck: 1,
            maxFlushAttempts: 9,
          },
        },
        customEvents: {
          total: 3,
          dirty: 1,
          stuck: 4,
          maxFlushAttempts: 8,
          oldestOccurredAt: null,
        },
        alarm: {
          scheduledAt: null,
          nextDueAt: null,
          nextDueKind: null,
          nextDueEntity: null,
        },
      });
      const ingestDo = createIngestDo({
        "site-1": {
          fetch: vi.fn().mockResolvedValue(Response.json(goodDiagnostic)),
        },
        "site-2": {
          fetch: vi
            .fn()
            .mockResolvedValue(new Response("bad", { status: 503 })),
        },
        "site-3": {
          fetch: vi
            .fn()
            .mockResolvedValue(
              Response.json({ ok: false, error: "not_ready" }),
            ),
        },
        "site-4": {
          fetch: vi.fn().mockRejectedValue(new Error("network down")),
        },
        "site-5": {
          fetch: vi.fn().mockResolvedValue(Response.json(secondDiagnostic)),
        },
      });
      const { env } = createEnv(
        [
          statement({ first: userRow() }),
          statement({
            all: [
              { id: "site-1", name: "Site 1", domain: "one.example.test" },
              { id: "site-2", name: "Site 2", domain: "two.example.test" },
              { id: "site-3", name: "Site 3", domain: "three.example.test" },
              { id: "site-4", name: "", domain: "" },
              { id: "site-5", name: "Site 5", domain: "five.example.test" },
            ],
          }),
        ],
        {
          ingestDo,
        },
      );

      const response = await dispatch("/api/private/admin/do-diagnostic", env);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        generatedAt: 5_000,
        totalSites: 5,
        reachableSites: 2,
        unreachableSites: 3,
        thresholds: goodDiagnostic.thresholds,
        totals: {
          bufferedVisits: 18,
          openVisits: 5,
          openStale: 1,
          openTimedOut: 2,
          openHardAged: 3,
          openFutureSkewed: 3,
          dirtyVisits: 7,
          stuckDirtyVisits: 3,
          bufferedCustomEvents: 8,
          dirtyCustomEvents: 3,
          stuckDirtyCustomEvents: 5,
          activeAlarms: 1,
          maxVisitFlushAttempts: 9,
          maxCustomEventFlushAttempts: 8,
        },
        oldestOpenStartedAt: 700,
        futureMaxActivityAt: 1_500,
        sites: [
          {
            siteId: "site-5",
            ok: true,
            diagnostic: secondDiagnostic,
          },
          {
            siteId: "site-1",
            ok: true,
            diagnostic: goodDiagnostic,
          },
          {
            siteId: "site-2",
            ok: false,
            error: "do_status_503",
          },
          {
            siteId: "site-3",
            ok: false,
            error: "not_ready",
          },
          {
            siteId: "site-4",
            siteName: "site-4",
            siteDomain: "",
            ok: false,
            error: "network down",
          },
        ],
      });
      expect(ingestDo.idFromName).toHaveBeenCalledWith("site-1");
      expect(ingestDo.get).toHaveBeenCalledWith("stub:site-1");
    });

    it("uses default diagnostic thresholds when no sites are reachable", async () => {
      setSession(adminSession);
      vi.spyOn(Date, "now").mockReturnValue(10_000);
      const { env } = createEnv([
        statement({ first: userRow() }),
        statement({ all: [] }),
      ]);

      const response = await dispatch("/api/private/admin/do-diagnostic", env);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        generatedAt: 10_000,
        totalSites: 0,
        reachableSites: 0,
        unreachableSites: 0,
        thresholds: {
          staleMs: 30 * 60 * 1000,
          timeoutMs: 12 * 60 * 60 * 1000,
          hardAgedMs: 36 * 60 * 60 * 1000,
          stuckFlushAttempts: 5,
        },
        totals: {
          bufferedVisits: 0,
          openVisits: 0,
          openStale: 0,
          openTimedOut: 0,
          openHardAged: 0,
          openFutureSkewed: 0,
          dirtyVisits: 0,
          stuckDirtyVisits: 0,
          bufferedCustomEvents: 0,
          dirtyCustomEvents: 0,
          stuckDirtyCustomEvents: 0,
          activeAlarms: 0,
          maxVisitFlushAttempts: 0,
          maxCustomEventFlushAttempts: 0,
        },
        oldestOpenStartedAt: null,
        futureMaxActivityAt: null,
        sites: [],
      });
    });
  });
});
