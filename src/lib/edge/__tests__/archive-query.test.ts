import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { handlePrivateArchive } from "@/lib/edge/admin/archive-query";
import {
  type EdgeSessionClaims,
  requireSession,
} from "@/lib/edge/auth/session-auth";
import type { Env } from "@/lib/edge/types";
import { ONE_HOUR_MS } from "@/lib/edge/utils";
vi.mock("@/lib/edge/auth/session-auth", () => ({
  requireSession: vi.fn(),
}));
const requireSessionMock = vi.mocked(requireSession);
interface MockStatement {
  bind: ReturnType<typeof vi.fn>;
  all?: ReturnType<typeof vi.fn>;
  first?: ReturnType<typeof vi.fn>;
}
interface MockBucket {
  get: ReturnType<typeof vi.fn>;
}
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
function statement(input: {
  all?: Record<string, unknown>[];
  first?: Record<string, unknown> | null;
}): MockStatement {
  const stmt: MockStatement = {
    bind: vi.fn(function (this: MockStatement) {
      return this;
    }),
  };
  if ("all" in input) {
    stmt.all = vi.fn().mockResolvedValue({ results: input.all });
  }
  if ("first" in input) {
    stmt.first = vi.fn().mockResolvedValue(input.first);
  }
  return stmt;
}
function createEnv(
  statements: MockStatement[] = [],
  bucket?: MockBucket,
): {
  env: Env;
  prepare: ReturnType<typeof vi.fn>;
  bucket?: MockBucket;
} {
  let index = 0;
  const prepare = vi.fn((sql: string) => {
    const stmt = statements[index++];
    if (!stmt) {
      throw new Error(`Unexpected SQL: ${sql}`);
    }
    return stmt;
  });
  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      ARCHIVE_BUCKET: bucket as unknown as R2Bucket,
    } as Env,
    prepare,
    bucket,
  };
}
function createBucket(object: unknown): MockBucket {
  return {
    get: vi.fn().mockResolvedValue(object),
  };
}
function r2Object(
  input: {
    body?: BodyInit;
    contentType?: string;
    etag?: string;
    range?: R2Range;
    size?: number;
  } = {},
): R2ObjectBody {
  const body = input.body ?? "parquet-bytes";
  return {
    body,
    size: input.size ?? 13,
    httpEtag: input.etag ?? '"archive-etag"',
    httpMetadata: input.contentType
      ? { contentType: input.contentType }
      : undefined,
    range: input.range,
  } as unknown as R2ObjectBody;
}
function edgeRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://edge.test${path}`, init);
}
async function dispatch(path: string, env: Env, init?: RequestInit) {
  const request = edgeRequest(path, init);
  return handlePrivateArchive(request, env, new URL(request.url));
}
describe("private archive edge query handler", () => {
  beforeEach(() => {
    requireSessionMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches legacy manifest and archive-key SQL against migrated D1 queries", async () => {
    const database = createMigratedDatabase();
    try {
      database
        .prepare(
          "INSERT INTO users (id,email,name,username) VALUES ('owner-1','owner@example.test','Owner','owner')",
        )
        .run();
      database
        .prepare(
          "INSERT INTO teams (id,name,slug,owner_user_id) VALUES ('team-1','Team','team','owner-1')",
        )
        .run();
      const insertSite = database.prepare(
        "INSERT INTO sites (id,team_id,name,domain) VALUES (?,?,?,?)",
      );
      insertSite.run("site-1", "team-1", "Site One", "one.test");
      insertSite.run("site-2", "team-1", "Site Two", "two.test");
      const insertIdentity = database.prepare(
        "INSERT OR IGNORE INTO site_identities (site_id) VALUES (?)",
      );
      insertIdentity.run("site-1");
      insertIdentity.run("site-2");
      const sitePk = (siteId: string) =>
        (
          database
            .prepare(
              "SELECT site_pk AS sitePk FROM site_identities WHERE site_id=?",
            )
            .get(siteId) as { sitePk: number }
        ).sitePk;
      const insertArchive = database.prepare(
        `INSERT INTO archive_objects (
          archive_key,site_id,start_hour,end_hour,granularity,format,site_pk
        ) VALUES (?,?,?,?,?,?,?)`,
      );
      insertArchive.run(
        "site-1/later.parquet",
        "site-1",
        3,
        4,
        "hour",
        "parquet",
        sitePk("site-1"),
      );
      insertArchive.run(
        "site-1/earlier.parquet",
        "site-1",
        2,
        3,
        "hour",
        "parquet",
        sitePk("site-1"),
      );
      insertArchive.run(
        "site-1/outside.parquet",
        "site-1",
        0,
        1,
        "hour",
        "parquet",
        sitePk("site-1"),
      );
      insertArchive.run(
        "site-2/other.parquet",
        "site-2",
        2,
        3,
        "hour",
        "parquet",
        sitePk("site-2"),
      );

      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const bucket = createBucket(r2Object({ body: "parquet-content" }));
      const env = {
        DB: createSqliteD1Database(database, trace),
        ARCHIVE_BUCKET: bucket as unknown as R2Bucket,
      } as Env;
      requireSessionMock.mockResolvedValue(adminSession);

      const legacyManifestQuery = {
        sql: `SELECT archive_key AS archiveKey, site_id AS siteId,
                     start_hour AS startHour, end_hour AS endHour,
                     granularity, format, row_count AS rowCount,
                     size_bytes AS sizeBytes, created_at AS createdAt
              FROM archive_objects
              WHERE site_pk=(SELECT site_pk FROM site_identities WHERE site_id=?)
                AND end_hour>=? AND start_hour<=?
              ORDER BY start_hour ASC`,
        bindings: ["site-1", 2, 4],
      };
      const legacyRows = database
        .prepare(legacyManifestQuery.sql)
        .all(...legacyManifestQuery.bindings);

      const manifest = await dispatch(
        "/api/private/archive/manifest?siteId=site-1&from=7200000&to=14400000",
        env,
      );
      const payload = (await manifest.json()) as {
        files: Array<Record<string, unknown>>;
      };

      expect(manifest.status).toBe(200);
      expect(
        payload.files.map(({ archiveKey, startHour, endHour }) => ({
          archiveKey,
          startHour,
          endHour,
        })),
      ).toEqual(
        (legacyRows as Array<Record<string, unknown>>).map(
          ({ archiveKey, startHour, endHour }) => ({
            archiveKey,
            startHour,
            endHour,
          }),
        ),
      );
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.preparedSql[0]).toContain('"site_identities"');
      expect(trace.bindings[0]).toEqual(["site-1", 2, 4]);
      const legacyManifestPlan = explainQueryPlan(
        database,
        legacyManifestQuery,
      );
      const typedManifestPlan = explainQueryPlan(database, {
        sql: trace.preparedSql[0],
        bindings: trace.bindings[0],
      });
      expect(legacyManifestPlan.join("\n")).toContain(
        "idx_archive_objects_site_pk_hour",
      );
      expect(typedManifestPlan.join("\n")).toContain(
        "idx_archive_objects_site_pk_hour",
      );
      expect(legacyManifestPlan.join("\n")).toContain(
        "sqlite_autoindex_site_identities_1",
      );
      expect(typedManifestPlan.join("\n")).toContain(
        "sqlite_autoindex_site_identities_1",
      );

      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const legacyFileQuery = {
        sql: "SELECT archive_key AS archiveKey,format,site_id AS siteId FROM archive_objects WHERE archive_key=? LIMIT 1",
        bindings: ["site-1/earlier.parquet"],
      };
      const legacyFile = database
        .prepare(legacyFileQuery.sql)
        .get(...legacyFileQuery.bindings);
      const file = await dispatch(
        "/api/private/archive/file?key=site-1%2Fearlier.parquet",
        env,
      );

      expect(file.status).toBe(200);
      expect(legacyFile).toEqual({
        archiveKey: "site-1/earlier.parquet",
        format: "parquet",
        siteId: "site-1",
      });
      expect(await file.text()).toBe("parquet-content");
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.bindings[0]).toEqual(["site-1/earlier.parquet", 1]);
      expect(explainQueryPlan(database, legacyFileQuery).join("\n")).toContain(
        "sqlite_autoindex_archive_objects_1",
      );
      expect(
        explainQueryPlan(database, {
          sql: trace.preparedSql[0],
          bindings: trace.bindings[0],
        }).join("\n"),
      ).toContain("sqlite_autoindex_archive_objects_1");
    } finally {
      database.close();
    }
  });

  it("returns not found for unknown private archive paths", async () => {
    const { env } = createEnv();

    const response = await dispatch("/api/private/archive/unknown", env);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { message: "Not Found" },
    });
    expect(requireSessionMock).not.toHaveBeenCalled();
  });

  describe("manifest requests", () => {
    it("rejects unsupported methods and missing site ids before authentication", async () => {
      const { env } = createEnv();

      const post = await dispatch("/api/private/archive/manifest", env, {
        method: "POST",
      });
      const missingSite = await dispatch("/api/private/archive/manifest", env);

      expect(post.status).toBe(405);
      expect(await post.json()).toMatchObject({
        ok: false,
        error: { message: "Method Not Allowed" },
      });
      expect(missingSite.status).toBe(400);
      expect(await missingSite.json()).toMatchObject({
        ok: false,
        error: { message: "Missing siteId" },
      });
      expect(requireSessionMock).not.toHaveBeenCalled();
    });

    it("returns unauthorized when the session is absent", async () => {
      requireSessionMock.mockResolvedValue(null);
      const { env } = createEnv();

      const response = await dispatch(
        "/api/private/archive/manifest?siteId=site-1",
        env,
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Unauthorized" },
      });
    });

    it("denies manifest access when a non-admin user is not a site member", async () => {
      requireSessionMock.mockResolvedValue(userSession);
      const membership = statement({ first: null });
      const { env } = createEnv([membership]);

      const response = await dispatch(
        "/api/private/archive/manifest?siteId=site-1",
        env,
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Site access denied for current user" },
      });
      expect(membership.bind).toHaveBeenCalledWith("user-1", "site-1", 1);
    });

    it("rejects invalid manifest time windows after authorization", async () => {
      requireSessionMock.mockResolvedValue(adminSession);
      const { env, prepare } = createEnv();

      const response = await dispatch(
        "/api/private/archive/manifest?siteId=site-1&from=7200000&to=3600000",
        env,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Invalid time window" },
      });
      expect(prepare).not.toHaveBeenCalled();
    });

    it("rejects non-numeric manifest time windows instead of using defaults", async () => {
      requireSessionMock.mockResolvedValue(adminSession);
      const { env, prepare } = createEnv();

      const response = await dispatch(
        "/api/private/archive/manifest?siteId=site-1&from=nope&to=wat",
        env,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Invalid time window" },
      });
      expect(prepare).not.toHaveBeenCalled();
    });

    it("uses the default one-year time window when from and to are omitted", async () => {
      requireSessionMock.mockResolvedValue(adminSession);
      const nowMs = Date.UTC(2026, 4, 25, 12, 30);
      vi.spyOn(Date, "now").mockReturnValue(nowMs);
      const list = statement({ all: [] });
      const { env } = createEnv([list]);

      const response = await dispatch(
        "/api/private/archive/manifest?siteId=site-1",
        env,
      );

      const payload = await response.json();
      const expectedFromHour = Math.floor(
        (nowMs - 365 * 24 * ONE_HOUR_MS) / ONE_HOUR_MS,
      );
      const expectedToHour = Math.floor(nowMs / ONE_HOUR_MS);
      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        ok: true,
        siteId: "site-1",
        fromHour: expectedFromHour,
        toHour: expectedToHour,
        files: [],
      });
      expect(list.bind).toHaveBeenCalledWith(
        "site-1",
        expectedFromHour,
        expectedToHour,
      );
    });

    it("lists authorized manifest files with encoded private fetch URLs", async () => {
      requireSessionMock.mockResolvedValue(userSession);
      const membership = statement({
        first: {
          id: "site-1",
          ownerUserId: "owner-1",
          role: "member",
          siteIdsJson: '["site-1"]',
        },
      });
      const list = statement({
        all: [
          {
            archiveKey: "site 1/2026-05-25.parquet",
            siteId: "site-1",
            startHour: 494_100,
            endHour: 494_123,
            granularity: "hour",
            format: "parquet",
            rowCount: 42,
            sizeBytes: 1024,
            createdAt: 1_779_708_000_000,
          },
        ],
      });
      const { env, prepare } = createEnv([membership, list]);

      const response = await dispatch(
        "/api/private/archive/manifest?siteId=%20site-1%20&from=7200000.9&to=14400000.1",
        env,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        siteId: "site-1",
        fromHour: 2,
        toHour: 4,
        files: [
          {
            archiveKey: "site 1/2026-05-25.parquet",
            siteId: "site-1",
            startHour: 494_100,
            endHour: 494_123,
            granularity: "hour",
            format: "parquet",
            rowCount: 42,
            sizeBytes: 1024,
            createdAt: 1_779_708_000_000,
            fetchUrl:
              "/api/private/archive/file?key=site%201%2F2026-05-25.parquet",
          },
        ],
      });
      expect(membership.bind).toHaveBeenCalledWith("user-1", "site-1", 1);
      expect(list.bind).toHaveBeenCalledWith("site-1", 2, 4);
      expect(prepare).toHaveBeenCalledTimes(2);
    });
  });

  describe("file requests", () => {
    it("rejects unsupported methods and missing archive bucket bindings", async () => {
      const { env } = createEnv();

      const post = await dispatch("/api/private/archive/file", env, {
        method: "POST",
      });
      const missingBucket = await dispatch(
        "/api/private/archive/file?key=archive.parquet",
        env,
      );

      expect(post.status).toBe(405);
      expect(await post.json()).toMatchObject({
        ok: false,
        error: { message: "Method Not Allowed" },
      });
      expect(missingBucket.status).toBe(404);
      expect(await missingBucket.json()).toMatchObject({
        ok: false,
        error: { message: "Archive bucket is not configured" },
      });
      expect(requireSessionMock).not.toHaveBeenCalled();
    });

    it("returns unauthorized before parsing file keys", async () => {
      requireSessionMock.mockResolvedValue(null);
      const { env } = createEnv([], createBucket(null));

      const response = await dispatch(
        "/api/private/archive/file?key=archive.parquet",
        env,
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Unauthorized" },
      });
    });

    it("rejects empty file keys after trimming query parameters", async () => {
      requireSessionMock.mockResolvedValue(adminSession);
      const { env, prepare } = createEnv([], createBucket(null));

      const missing = await dispatch("/api/private/archive/file", env);
      const blank = await dispatch("/api/private/archive/file?key=%20", env);

      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({
        ok: false,
        error: { message: "Missing key" },
      });
      expect(blank.status).toBe(400);
      expect(await blank.json()).toMatchObject({
        ok: false,
        error: { message: "Missing key" },
      });
      expect(prepare).not.toHaveBeenCalled();
    });

    it("returns not found for missing or non-queryable archive rows", async () => {
      requireSessionMock.mockResolvedValue(adminSession);
      const missingRow = statement({ first: null });
      const csvRow = statement({
        first: {
          archiveKey: "site/export.csv",
          format: "csv",
          siteId: "site-1",
        },
      });
      const { env } = createEnv([missingRow, csvRow], createBucket(null));

      const missing = await dispatch(
        "/api/private/archive/file?key=missing.parquet",
        env,
      );
      const csv = await dispatch(
        "/api/private/archive/file?key=site%2Fexport.csv",
        env,
      );

      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({
        ok: false,
        error: { message: "Archive object not found" },
      });
      expect(csv.status).toBe(404);
      expect(await csv.json()).toMatchObject({
        ok: false,
        error: { message: "Archive object is not queryable in precise mode" },
      });
      expect(missingRow.bind).toHaveBeenCalledWith("missing.parquet", 1);
      expect(csvRow.bind).toHaveBeenCalledWith("site/export.csv", 1);
    });

    it("denies file access when a non-admin member lacks site access", async () => {
      requireSessionMock.mockResolvedValue(userSession);
      const archiveRow = statement({
        first: {
          archiveKey: "site/day.parquet",
          format: "parquet",
          siteId: "site-1",
        },
      });
      const membership = statement({
        first: {
          id: "site-1",
          ownerUserId: "owner-1",
          role: "member",
          siteIdsJson: '["site-2"]',
        },
      });
      const bucket = createBucket(r2Object());
      const { env } = createEnv([archiveRow, membership], bucket);

      const response = await dispatch(
        "/api/private/archive/file?key=site%2Fday.parquet",
        env,
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Site access denied for current user" },
      });
      expect(membership.bind).toHaveBeenCalledWith("user-1", "site-1", 1);
      expect(bucket.get).not.toHaveBeenCalled();
    });

    it("returns not found when archive metadata exists but R2 content is missing", async () => {
      requireSessionMock.mockResolvedValue(adminSession);
      const archiveRow = statement({
        first: {
          archiveKey: "site/day.parquet",
          format: "parquet",
          siteId: "site-1",
        },
      });
      const bucket = createBucket(null);
      const { env } = createEnv([archiveRow], bucket);

      const response = await dispatch(
        "/api/private/archive/file?key=%20site%2Fday.parquet%20",
        env,
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Archive object content is missing" },
      });
      expect(archiveRow.bind).toHaveBeenCalledWith("site/day.parquet", 1);
      expect(bucket.get).toHaveBeenCalledWith("site/day.parquet", undefined);
    });

    it("streams archive files with fallback parquet metadata", async () => {
      requireSessionMock.mockResolvedValue(userSession);
      const archiveRow = statement({
        first: {
          archiveKey: "site/day.parquet",
          format: "parquet",
          siteId: "site-1",
        },
      });
      const membership = statement({
        first: {
          id: "site-1",
          ownerUserId: "owner-1",
          role: "member",
          siteIdsJson: "[]",
        },
      });
      const bucket = createBucket(r2Object({ body: "full-parquet", size: 12 }));
      const { env } = createEnv([archiveRow, membership], bucket);

      const response = await dispatch(
        "/api/private/archive/file?key=site%2Fday.parquet",
        env,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/vnd.apache.parquet",
      );
      expect(response.headers.get("cache-control")).toBe(
        "private, max-age=120",
      );
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("etag")).toBe('"archive-etag"');
      expect(response.headers.get("content-length")).toBe("12");
      expect(await response.text()).toBe("full-parquet");
      expect(membership.bind).toHaveBeenCalledWith("user-1", "site-1", 1);
      expect(bucket.get).toHaveBeenCalledWith("site/day.parquet", undefined);
    });

    it("streams ranged GET responses and forwards the request range headers to R2", async () => {
      requireSessionMock.mockResolvedValue(adminSession);
      const archiveRow = statement({
        first: {
          archiveKey: "site/day.parquet",
          format: "parquet",
          siteId: "site-1",
        },
      });
      const bucket = createBucket(
        r2Object({
          body: "range-bytes",
          contentType: "application/octet-stream",
          range: { offset: 2, length: 4 },
          size: 10,
        }),
      );
      const { env } = createEnv([archiveRow], bucket);

      const response = await dispatch(
        "/api/private/archive/file?key=site%2Fday.parquet",
        env,
        { headers: { range: "bytes=2-5" } },
      );

      expect(response.status).toBe(206);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
      expect(response.headers.get("content-length")).toBe("4");
      expect(await response.text()).toBe("range-bytes");
      expect(bucket.get).toHaveBeenCalledWith("site/day.parquet", {
        range: expect.any(Headers),
      });
    });

    it("normalizes suffix ranges for HEAD responses without returning a body", async () => {
      requireSessionMock.mockResolvedValue(adminSession);
      const archiveRow = statement({
        first: {
          archiveKey: "site/day.parquet",
          format: "parquet",
          siteId: "site-1",
        },
      });
      const bucket = createBucket(
        r2Object({
          contentType: "application/x-parquet",
          range: { suffix: 5 },
          size: 20,
        }),
      );
      const { env } = createEnv([archiveRow], bucket);

      const response = await dispatch(
        "/api/private/archive/file?key=site%2Fday.parquet",
        env,
        {
          method: "HEAD",
          headers: { range: "bytes=-5" },
        },
      );

      expect(response.status).toBe(206);
      expect(response.headers.get("content-type")).toBe(
        "application/x-parquet",
      );
      expect(response.headers.get("content-range")).toBe("bytes 15-19/20");
      expect(response.headers.get("content-length")).toBe("5");
      expect(await response.text()).toBe("");
    });

    it("falls back to full-object responses for invalid normalized ranges", async () => {
      requireSessionMock.mockResolvedValue(adminSession);
      const suffixZero = statement({
        first: {
          archiveKey: "site/suffix.parquet",
          format: "parquet",
          siteId: "site-1",
        },
      });
      const zeroSize = statement({
        first: {
          archiveKey: "site/empty.parquet",
          format: "parquet",
          siteId: "site-1",
        },
      });
      const bucket = createBucket(r2Object({ range: { suffix: 0 }, size: 10 }));
      bucket.get
        .mockResolvedValueOnce(r2Object({ range: { suffix: 0 }, size: 10 }))
        .mockResolvedValueOnce(r2Object({ range: { offset: 0 }, size: 0 }));
      const { env } = createEnv([suffixZero, zeroSize], bucket);

      const suffixResponse = await dispatch(
        "/api/private/archive/file?key=site%2Fsuffix.parquet",
        env,
        { headers: { range: "bytes=-0" } },
      );
      const zeroSizeResponse = await dispatch(
        "/api/private/archive/file?key=site%2Fempty.parquet",
        env,
        { headers: { range: "bytes=0-" } },
      );

      expect(suffixResponse.status).toBe(200);
      expect(suffixResponse.headers.get("content-range")).toBeNull();
      expect(suffixResponse.headers.get("content-length")).toBe("10");
      expect(zeroSizeResponse.status).toBe(200);
      expect(zeroSizeResponse.headers.get("content-range")).toBeNull();
      expect(zeroSizeResponse.headers.get("content-length")).toBe("0");
    });

    it("normalizes offset ranges when R2 omits offset or length", async () => {
      requireSessionMock.mockResolvedValue(adminSession);
      const missingOffset = statement({
        first: {
          archiveKey: "site/missing-offset.parquet",
          format: "parquet",
          siteId: "site-1",
        },
      });
      const missingLength = statement({
        first: {
          archiveKey: "site/missing-length.parquet",
          format: "parquet",
          siteId: "site-1",
        },
      });
      const emptyLength = statement({
        first: {
          archiveKey: "site/empty-length.parquet",
          format: "parquet",
          siteId: "site-1",
        },
      });
      const bucket = createBucket(null);
      bucket.get
        .mockResolvedValueOnce(
          r2Object({
            range: { length: 3, suffix: undefined } as R2Range,
            size: 10,
          }),
        )
        .mockResolvedValueOnce(
          r2Object({ range: { offset: 7 } as R2Range, size: 10 }),
        )
        .mockResolvedValueOnce(
          r2Object({ range: { offset: 9, length: 0 }, size: 10 }),
        );
      const { env } = createEnv(
        [missingOffset, missingLength, emptyLength],
        bucket,
      );

      const offsetResponse = await dispatch(
        "/api/private/archive/file?key=site%2Fmissing-offset.parquet",
        env,
        { headers: { range: "bytes=0-2" } },
      );
      const lengthResponse = await dispatch(
        "/api/private/archive/file?key=site%2Fmissing-length.parquet",
        env,
        { headers: { range: "bytes=7-" } },
      );
      const emptyResponse = await dispatch(
        "/api/private/archive/file?key=site%2Fempty-length.parquet",
        env,
        { headers: { range: "bytes=9-8" } },
      );

      expect(offsetResponse.status).toBe(206);
      expect(offsetResponse.headers.get("content-range")).toBe("bytes 0-2/10");
      expect(offsetResponse.headers.get("content-length")).toBe("3");
      expect(lengthResponse.status).toBe(206);
      expect(lengthResponse.headers.get("content-range")).toBe("bytes 7-9/10");
      expect(lengthResponse.headers.get("content-length")).toBe("3");
      expect(emptyResponse.status).toBe(200);
      expect(emptyResponse.headers.get("content-range")).toBeNull();
      expect(emptyResponse.headers.get("content-length")).toBe("10");
    });
  });
});
