import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IngestDurableObject } from "@/lib/edge/ingest-do";
import type {
  Env,
  IngestEnvelopePayload,
  TrackerClientPayload,
} from "@/lib/edge/types";

const NOW = Date.UTC(2026, 4, 25, 12, 0, 0);
const VISIT_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const RECENT_EVENT_RETENTION_MS = 30 * 60 * 1000;

type SqlBinding = string | number | null;
type SqlRow = Record<string, unknown>;

const VISIT_COLUMNS = [
  "visit_id",
  "site_id",
  "visitor_id",
  "session_id",
  "status",
  "started_at",
  "last_activity_at",
  "ended_at",
  "finalized_at",
  "duration_ms",
  "duration_source",
  "exit_reason",
  "pathname",
  "query_string",
  "hash_fragment",
  "hostname",
  "title",
  "referrer_url",
  "referrer_host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "is_eu",
  "country",
  "region",
  "region_code",
  "city",
  "continent",
  "latitude",
  "longitude",
  "postal_code",
  "metro_code",
  "timezone",
  "as_organization",
  "ua_raw",
  "browser",
  "browser_version",
  "os",
  "os_version",
  "device_type",
  "screen_width",
  "screen_height",
  "language",
  "user_id",
  "user_name",
  "perf_ttfb_ms",
  "perf_fcp_ms",
  "perf_lcp_ms",
  "perf_cls",
  "perf_inp_ms",
  "ae_synced_at",
  "created_at",
  "updated_at",
] as const;

const BUFFERED_VISIT_COLUMNS = [
  ...VISIT_COLUMNS.filter((column) => column !== "ae_synced_at"),
  "hidden_at",
  "dirty",
  "flush_attempts",
  "last_flush_error",
] as const;

type VisitColumn = (typeof VISIT_COLUMNS)[number];
type BufferedVisitColumn = (typeof BUFFERED_VISIT_COLUMNS)[number];
type VisitRecord = Record<VisitColumn, SqlBinding>;
type BufferedVisitRecord = Record<BufferedVisitColumn, SqlBinding>;

class SqlResult<T extends SqlRow = SqlRow> {
  readonly rowsWritten: number;

  constructor(
    private readonly rows: T[],
    rowsWritten: number,
  ) {
    this.rowsWritten = rowsWritten;
  }

  toArray(): T[] {
    return this.rows;
  }
}

class SqliteSqlStorage {
  readonly db = new DatabaseSync(":memory:");

  exec(query: string, ...bindings: SqlBinding[]): SqlResult {
    const normalized = query.trim().toUpperCase();
    const statement = this.db.prepare(query);
    if (
      normalized.startsWith("SELECT") ||
      normalized.startsWith("PRAGMA") ||
      normalized.startsWith("WITH")
    ) {
      return new SqlResult(
        statement.all(...bindings).map((row) => ({ ...row })),
        0,
      );
    }
    const result = statement.run(...bindings);
    return new SqlResult([], Number(result.changes ?? 0));
  }

  close(): void {
    this.db.close();
  }
}

class FakeD1Statement {
  private bindings: SqlBinding[] = [];

  constructor(
    private readonly d1: FakeD1Database,
    private readonly query: string,
  ) {}

  bind(...bindings: SqlBinding[]): this {
    this.bindings = bindings;
    return this;
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    if (this.d1.failRunCalls > 0) {
      this.d1.failRunCalls -= 1;
      throw new Error("forced run failure");
    }
    const result = this.d1.db.prepare(this.query).run(...this.bindings);
    return {
      success: true,
      meta: { changes: Number(result.changes ?? 0) },
    };
  }

  async all<T extends SqlRow = SqlRow>(): Promise<{ results: T[] }> {
    return {
      results: this.d1.db
        .prepare(this.query)
        .all(...this.bindings)
        .map((row) => ({ ...row }) as T),
    };
  }

  async first<T extends SqlRow = SqlRow>(): Promise<T | null> {
    const row = this.d1.db.prepare(this.query).get(...this.bindings);
    return row ? ({ ...row } as T) : null;
  }
}

type FakeBatchHook = (statements: FakeD1Statement[]) => void | Promise<void>;

class FakeD1Database {
  readonly db = new DatabaseSync(":memory:");
  failBatchCalls = 0;
  failRunCalls = 0;
  beforeBatch: FakeBatchHook | null = null;
  readonly prepare = vi.fn((query: string) => new FakeD1Statement(this, query));
  readonly batch = vi.fn(async (statements: FakeD1Statement[]) => {
    if (this.failBatchCalls > 0) {
      this.failBatchCalls -= 1;
      throw new Error("forced batch failure");
    }
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      await hook(statements);
    }
    for (const statement of statements) {
      await statement.run();
    }
    return statements.map(() => ({ success: true }));
  });

  constructor() {
    this.db.exec(`
      CREATE TABLE visits (
        visit_id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        ended_at INTEGER,
        finalized_at INTEGER,
        duration_ms INTEGER,
        duration_source TEXT,
        exit_reason TEXT,
        pathname TEXT NOT NULL,
        query_string TEXT NOT NULL DEFAULT '',
        hash_fragment TEXT NOT NULL DEFAULT '',
        hostname TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        referrer_url TEXT NOT NULL DEFAULT '',
        referrer_host TEXT NOT NULL DEFAULT '',
        utm_source TEXT NOT NULL DEFAULT '',
        utm_medium TEXT NOT NULL DEFAULT '',
        utm_campaign TEXT NOT NULL DEFAULT '',
        utm_term TEXT NOT NULL DEFAULT '',
        utm_content TEXT NOT NULL DEFAULT '',
        is_eu INTEGER NOT NULL DEFAULT 0,
        country TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        region_code TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        continent TEXT NOT NULL DEFAULT '',
        latitude REAL,
        longitude REAL,
        postal_code TEXT NOT NULL DEFAULT '',
        metro_code TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT '',
        as_organization TEXT NOT NULL DEFAULT '',
        ua_raw TEXT NOT NULL DEFAULT '',
        browser TEXT NOT NULL DEFAULT '',
        browser_version TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '',
        os_version TEXT NOT NULL DEFAULT '',
        device_type TEXT NOT NULL DEFAULT '',
        screen_width INTEGER,
        screen_height INTEGER,
        language TEXT NOT NULL DEFAULT '',
        user_id TEXT,
        user_name TEXT,
        perf_ttfb_ms REAL,
        perf_fcp_ms REAL,
        perf_lcp_ms REAL,
        perf_cls REAL,
        perf_inp_ms REAL,
        ae_synced_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE custom_event_names (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE(site_id, name)
      );
      CREATE TABLE custom_event_json_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id TEXT NOT NULL,
        "key" TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE(site_id, "key")
      );
      CREATE TABLE custom_event_json_paths (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE(site_id, path)
      );
      CREATE TABLE custom_events (
        event_pk INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        site_id TEXT NOT NULL,
        visit_id TEXT NOT NULL,
        event_name_id INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        node_count INTEGER NOT NULL,
        value_count INTEGER NOT NULL,
        user_id TEXT,
        ae_synced_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE custom_event_json_nodes (
        event_pk INTEGER NOT NULL,
        node_id INTEGER NOT NULL,
        parent_node_id INTEGER,
        key_id INTEGER,
        path_id INTEGER NOT NULL,
        value_type INTEGER NOT NULL,
        member_order INTEGER,
        array_index INTEGER,
        depth INTEGER NOT NULL,
        UNIQUE(event_pk, node_id)
      );
      CREATE TABLE custom_event_json_values (
        event_pk INTEGER NOT NULL,
        node_id INTEGER NOT NULL,
        site_id TEXT NOT NULL,
        event_name_id INTEGER NOT NULL,
        path_id INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        scope_node_id INTEGER,
        value_type INTEGER NOT NULL,
        string_value TEXT,
        string_hash TEXT,
        number_value REAL,
        boolean_value INTEGER,
        UNIQUE(event_pk, node_id, path_id)
      );
    `);
  }

  insertVisit(overrides: Partial<VisitRecord> = {}): VisitRecord {
    const row = visitRecord(overrides);
    const placeholders = VISIT_COLUMNS.map(() => "?").join(", ");
    this.db
      .prepare(
        `INSERT INTO visits (${VISIT_COLUMNS.join(", ")}) VALUES (${placeholders})`,
      )
      .run(...VISIT_COLUMNS.map((column) => row[column]));
    return row;
  }

  all<T extends SqlRow = SqlRow>(
    query: string,
    ...bindings: SqlBinding[]
  ): T[] {
    return this.db
      .prepare(query)
      .all(...bindings)
      .map((row) => ({ ...row }) as T);
  }

  close(): void {
    this.db.close();
  }
}

type FakeWebSocketEvent = "close" | "error";
type FakeWebSocketEventPayload = { code?: number };

class FakeWebSocket {
  accepted = false;
  closed = false;
  failSend = false;
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    FakeWebSocketEvent,
    Array<(event: FakeWebSocketEventPayload) => void>
  >();

  accept(): void {
    this.accepted = true;
  }

  send(payload: string): void {
    if (this.failSend) {
      throw new Error("forced websocket send failure");
    }
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(
    event: FakeWebSocketEvent,
    listener: (event: FakeWebSocketEventPayload) => void,
  ): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(
    event: FakeWebSocketEvent,
    payload: FakeWebSocketEventPayload = {},
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

class FakeUpgradeResponse {
  readonly status: number;
  readonly webSocket: FakeWebSocket | undefined;

  constructor(
    private readonly body: BodyInit | null = null,
    init: ResponseInit & { webSocket?: FakeWebSocket } = {},
  ) {
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket;
  }

  async text(): Promise<string> {
    return typeof this.body === "string" ? this.body : "";
  }
}

function toSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function visitRecord(overrides: Partial<VisitRecord> = {}): VisitRecord {
  return {
    visit_id: "visit-1",
    site_id: "site-1",
    visitor_id: "visitor-1",
    session_id: "session-1",
    status: "open",
    started_at: NOW - 1_000,
    last_activity_at: NOW - 1_000,
    ended_at: null,
    finalized_at: null,
    duration_ms: null,
    duration_source: null,
    exit_reason: null,
    pathname: "/docs",
    query_string: "",
    hash_fragment: "",
    hostname: "example.com",
    title: "Docs",
    referrer_url: "https://ref.example/start",
    referrer_host: "ref.example",
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    utm_term: "",
    utm_content: "",
    is_eu: 0,
    country: "US",
    region: "California",
    region_code: "CA",
    city: "San Francisco",
    continent: "NA",
    latitude: 37.77,
    longitude: -122.42,
    postal_code: "94105",
    metro_code: "807",
    timezone: "America/Los_Angeles",
    as_organization: "Example ISP",
    ua_raw: "Mozilla/5.0",
    browser: "Chrome",
    browser_version: "120",
    os: "Windows",
    os_version: "11",
    device_type: "desktop",
    screen_width: 1440,
    screen_height: 900,
    language: "en-US",
    user_id: "",
    user_name: "",
    perf_ttfb_ms: null,
    perf_fcp_ms: null,
    perf_lcp_ms: null,
    perf_cls: null,
    perf_inp_ms: null,
    ae_synced_at: null,
    created_at: toSeconds(NOW),
    updated_at: toSeconds(NOW),
    ...overrides,
  };
}

function bufferedVisitRecord(
  overrides: Partial<BufferedVisitRecord> = {},
): BufferedVisitRecord {
  const base = visitRecord(overrides as Partial<VisitRecord>);
  const row = {
    ...Object.fromEntries(
      VISIT_COLUMNS.filter((column) => column !== "ae_synced_at").map(
        (column) => [column, base[column]],
      ),
    ),
    hidden_at: null,
    dirty: 1,
    flush_attempts: 0,
    last_flush_error: null,
    ...overrides,
  } as BufferedVisitRecord;
  return row;
}

function insertBufferedVisit(
  sql: SqliteSqlStorage,
  overrides: Partial<BufferedVisitRecord> = {},
): BufferedVisitRecord {
  const row = bufferedVisitRecord(overrides);
  const placeholders = BUFFERED_VISIT_COLUMNS.map(() => "?").join(", ");
  sql.exec(
    `INSERT INTO buffered_visits (${BUFFERED_VISIT_COLUMNS.join(", ")}) VALUES (${placeholders})`,
    ...BUFFERED_VISIT_COLUMNS.map((column) => row[column]),
  );
  return row;
}

function insertBufferedCustomEvent(
  sql: SqliteSqlStorage,
  overrides: Partial<Record<string, SqlBinding>> = {},
): Record<string, SqlBinding> {
  const row: Record<string, SqlBinding> = {
    event_id: "event-1",
    site_id: "site-1",
    visit_id: "visit-1",
    occurred_at: NOW - 1_000,
    received_at: NOW,
    sequence: 0,
    event_name: "Test Event",
    event_data_json: "{}",
    user_id: "",
    dirty: 1,
    flush_attempts: 0,
    last_flush_error: null,
    created_at: toSeconds(NOW),
    ...overrides,
  };
  const columns = Object.keys(row);
  sql.exec(
    `INSERT INTO buffered_custom_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ...columns.map((column) => row[column]),
  );
  return row;
}

interface TestDoContext {
  object: IngestDurableObject;
  sql: SqliteSqlStorage;
  d1: FakeD1Database;
  state: DurableObjectState;
  getAlarmAt: () => number | null;
}

function createTestDo(
  envOverrides: Partial<Env> = {},
  sql = new SqliteSqlStorage(),
): TestDoContext {
  const d1 = new FakeD1Database();
  let alarmAt: number | null = null;
  const storage = {
    sql,
    getAlarm: vi.fn(async () => alarmAt),
    setAlarm: vi.fn(async (scheduledAt: number) => {
      alarmAt = scheduledAt;
    }),
    deleteAlarm: vi.fn(async () => {
      alarmAt = null;
    }),
  };
  const state = {
    storage,
    blockConcurrencyWhile: vi.fn((callback: () => void | Promise<void>) =>
      Promise.resolve(callback()),
    ),
  } as unknown as DurableObjectState;
  const env = {
    DB: d1 as unknown as D1Database,
    INGEST_DO: {} as DurableObjectNamespace,
    DAILY_SALT_SECRET: "test-secret-with-enough-entropy",
    ...envOverrides,
  } as Env;

  return {
    object: new IngestDurableObject(state, env),
    sql,
    d1,
    state,
    getAlarmAt: () => alarmAt,
  };
}

function envelope(
  clientOverrides: Partial<TrackerClientPayload> = {},
  requestOverrides: Partial<IngestEnvelopePayload["request"]> = {},
): IngestEnvelopePayload {
  const client: TrackerClientPayload = {
    siteId: "site-1",
    kind: "pageview",
    visitId: "visit-1",
    visitorId: "visitor-1",
    timestamp: NOW - 1_000,
    startedAt: NOW - 1_000,
    pathname: "/docs",
    query: "utm_source=newsletter&utm_medium=email&utm_campaign=launch",
    hash: "#intro",
    hostname: "example.com",
    title: "Docs",
    language: "en-US",
    timezone: "America/Los_Angeles",
    screenWidth: 1440,
    screenHeight: 900,
    referrerUrl: "https://ref.example/start",
    ...clientOverrides,
  };
  return {
    request: {
      method: "POST",
      url: "https://collector.example/collect",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "cf-connecting-ip": "203.0.113.10",
      },
      cf: {
        isEUCountry: false,
        country: "US",
        region: "California",
        regionCode: "CA",
        city: "San Francisco",
        continent: "NA",
        latitude: 37.77,
        longitude: -122.42,
        postalCode: "94105",
        metroCode: "807",
        timezone: "America/Los_Angeles",
        asOrganization: "Example ISP",
      },
      body: "",
      receivedAt: NOW,
      ...requestOverrides,
    },
    client,
    trace: {
      id: "trace-1",
      source: "test",
      acceptedAt: NOW,
    },
  };
}

function ingestRequest(body: unknown): Request {
  return new Request("https://ingest.internal/ingest", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function postIngest(
  object: IngestDurableObject,
  body: unknown,
): Promise<Response> {
  return object.fetch(ingestRequest(body));
}

function localRows<T extends SqlRow = SqlRow>(
  sql: SqliteSqlStorage,
  query: string,
  ...bindings: SqlBinding[]
): T[] {
  return sql.exec(query, ...bindings).toArray() as T[];
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("IngestDurableObject", () => {
  it("exports a durable object class and rejects unknown or invalid request routes", async () => {
    const ctx = createTestDo({ ADMIN_WS_TOKEN: "secret-token" });

    expect(IngestDurableObject).toBeTypeOf("function");

    const missing = await ctx.object.fetch(
      new Request("https://ingest.internal/nope"),
    );
    expect(missing.status).toBe(404);
    await expect(missing.text()).resolves.toBe("Not Found");

    const getIngest = await ctx.object.fetch(
      new Request("https://ingest.internal/ingest"),
    );
    expect(getIngest.status).toBe(404);

    const badWsUpgrade = await ctx.object.fetch(
      new Request("https://ingest.internal/ws"),
    );
    expect(badWsUpgrade.status).toBe(426);

    // WebSocket upgrade requires WebSocketPair to be defined
    const client = new FakeWebSocket();
    const server = new FakeWebSocket();
    class TestWebSocketPair {
      constructor() {
        return [client, server];
      }
    }
    const RealResponse = globalThis.Response;
    vi.stubGlobal("WebSocketPair", TestWebSocketPair);
    vi.stubGlobal("Response", FakeUpgradeResponse);

    try {
      const wsUpgrade = await ctx.object.fetch({
        url: "https://ingest.internal/ws?token=wrong",
        method: "GET",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "upgrade" ? "websocket" : null,
        },
      } as unknown as Request);
      // Token is no longer validated, so this should succeed with 101
      expect(wsUpgrade.status).toBe(101);
    } finally {
      vi.stubGlobal("Response", RealResponse);
    }
  });

  it("uses snapshot defaults and accepts authenticated websocket upgrades", async () => {
    const ctx = createTestDo({ ADMIN_WS_TOKEN: "secret-token" });

    const snapshot = await ctx.object.fetch(
      new Request("https://ingest.internal/snapshot"),
    );
    expect(snapshot.status).toBe(200);
    await expect(snapshot.json()).resolves.toMatchObject({
      ok: true,
      buffered: 0,
      data: [],
    });

    const client = new FakeWebSocket();
    const server = new FakeWebSocket();
    class AuthenticatedWebSocketPair {
      constructor() {
        return [client, server];
      }
    }
    const RealResponse = globalThis.Response;
    vi.stubGlobal("WebSocketPair", AuthenticatedWebSocketPair);
    vi.stubGlobal("Response", FakeUpgradeResponse);

    try {
      const upgrade = await ctx.object.fetch({
        url: "https://ingest.internal/ws?token=secret-token",
        method: "GET",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "upgrade" ? "websocket" : null,
        },
      } as unknown as Request);

      expect(upgrade.status).toBe(101);
      expect(server.accepted).toBe(true);
      expect(upgrade.webSocket).toBe(client);
    } finally {
      vi.stubGlobal("Response", RealResponse);
    }
  });

  it("records direct Durable Object SQL calls in the request invocation", async () => {
    const ctx = createTestDo();

    const response = await ctx.object.fetch(
      new Request("https://ingest.internal/snapshot"),
    );

    expect(response.status).toBe(200);
    expect(console.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: "do",
        request: expect.objectContaining({ route: "/snapshot", status: 200 }),
        performance: expect.objectContaining({
          doSqlStatements: expect.any(Number),
        }),
        logs: expect.arrayContaining([
          expect.objectContaining({ message: "do_sql.all.started" }),
          expect.objectContaining({ message: "do_sql.all.completed" }),
        ]),
      }),
    );
  });

  it("emits a separate websocket lifecycle record after the upgrade response", async () => {
    const ctx = createTestDo();
    const client = new FakeWebSocket();
    const server = new FakeWebSocket();
    class LifecycleWebSocketPair {
      constructor() {
        return [client, server];
      }
    }
    const RealResponse = globalThis.Response;
    vi.stubGlobal("WebSocketPair", LifecycleWebSocketPair);
    vi.stubGlobal("Response", FakeUpgradeResponse);

    try {
      const response = await ctx.object.fetch({
        url: "https://ingest.internal/ws",
        method: "GET",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "upgrade" ? "websocket" : null,
        },
      } as unknown as Request);
      expect(response.status).toBe(101);

      server.emit("close", { code: 1000 });

      expect(console.log).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: "do",
          request: {
            route: "/ws",
            method: "WEBSOCKET",
            status: 101,
            outcome: "ok",
          },
          performance: expect.objectContaining({
            webSocketDurationMs: expect.any(Number),
          }),
          logs: [
            expect.objectContaining({
              message: "do.websocket.closed",
              data: { code: 1000 },
            }),
          ],
        }),
      );
    } finally {
      vi.stubGlobal("Response", RealResponse);
    }
  });

  it("returns bad request for malformed JSON and ignores invalid normalized payloads", async () => {
    const ctx = createTestDo();

    const badJson = await postIngest(ctx.object, "{not-json");
    expect(badJson.status).toBe(400);
    await expect(badJson.text()).resolves.toBe("Bad Request");

    const missingSite = await postIngest(ctx.object, envelope({ siteId: "" }));
    expect(missingSite.status).toBe(202);
    await expect(missingSite.text()).resolves.toBe("ignored:missing_site_id");

    const missingHostname = await postIngest(
      ctx.object,
      envelope({ hostname: "" }),
    );
    expect(missingHostname.status).toBe(202);
    await expect(missingHostname.text()).resolves.toBe(
      "ignored:missing_hostname",
    );

    const unsupportedKind = await postIngest(
      ctx.object,
      envelope({ kind: "not_supported" as TrackerClientPayload["kind"] }),
    );
    expect(unsupportedKind.status).toBe(202);
    await expect(unsupportedKind.text()).resolves.toBe(
      "ignored:unsupported_kind",
    );

    expect(
      localRows<{ count: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS count FROM buffered_visits",
      )[0]?.count,
    ).toBe(0);
  });

  it("buffers pageviews, normalizes context, exposes snapshots, and reports diagnostics", async () => {
    const ctx = createTestDo();

    const response = await postIngest(ctx.object, envelope());

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("ok");
    expect(ctx.getAlarmAt()).toBe(NOW + 60_000);

    const [visit] = localRows<{
      visit_id: string;
      session_id: string;
      status: string;
      pathname: string;
      query_string: string;
      hash_fragment: string;
      utm_source: string;
      utm_medium: string;
      utm_campaign: string;
      referrer_host: string;
      screen_width: number;
      screen_height: number;
      dirty: number;
    }>(
      ctx.sql,
      `
        SELECT visit_id, status, pathname, query_string, hash_fragment,
               session_id, utm_source, utm_medium, utm_campaign, referrer_host,
               screen_width, screen_height, dirty
        FROM buffered_visits
      `,
    );
    expect(visit).toMatchObject({
      visit_id: "visit-1",
      status: "open",
      pathname: "/docs",
      query_string:
        "utm_source=newsletter&utm_medium=email&utm_campaign=launch",
      hash_fragment: "#intro",
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "launch",
      referrer_host: "ref.example",
      screen_width: 1440,
      screen_height: 900,
      dirty: 1,
    });

    const snapshot = await ctx.object.fetch(
      new Request(
        `https://ingest.internal/snapshot?from=0&to=${NOW}&limit=25.9`,
      ),
    );
    expect(snapshot.status).toBe(200);
    await expect(snapshot.json()).resolves.toMatchObject({
      ok: true,
      buffered: 0,
      data: [
        {
          id: "visit-1",
          eventType: "visit",
          visitId: "visit-1",
          sessionId: visit.session_id,
          pathname: "/docs",
          hostname: "example.com",
          visitorId: "visitor-1",
          screenWidth: 1440,
          screenHeight: 900,
        },
      ],
    });

    const diagnostic = await ctx.object.fetch(
      new Request("https://ingest.internal/diagnostic"),
    );
    expect(diagnostic.status).toBe(200);
    await expect(diagnostic.json()).resolves.toMatchObject({
      ok: true,
      snapshotAt: NOW,
      visits: {
        total: 1,
        byStatus: { open: 1 },
        open: { total: 1, stale: 0, timedOut: 0, hardAged: 0 },
        dirty: { total: 1, stuck: 0, maxFlushAttempts: 0 },
      },
      customEvents: {
        total: 0,
        dirty: 0,
      },
      alarm: {
        scheduledAt: NOW + 60_000,
      },
    });
  });

  it("derives privacy-preserving visitor IDs for EU or missing visitor payloads", async () => {
    const ctx = createTestDo();

    const response = await postIngest(
      ctx.object,
      envelope(
        { visitorId: "" },
        {
          cf: {
            isEUCountry: true,
            country: "DE",
          },
        },
      ),
    );

    expect(response.status).toBe(202);
    const [visit] = localRows<{ visitor_id: string; is_eu: number }>(
      ctx.sql,
      "SELECT visitor_id, is_eu FROM buffered_visits WHERE visit_id = ?",
      "visit-1",
    );
    expect(visit?.is_eu).toBe(1);
    expect(visit?.visitor_id).toMatch(/^[0-9a-f]{64}$/);
    expect(visit?.visitor_id).not.toBe("visitor-1");
  });

  it("closes previous pageviews, handles leave events, and attaches performance metrics", async () => {
    const ctx = createTestDo();

    await postIngest(
      ctx.object,
      envelope({
        visitId: "visit-1",
        startedAt: NOW - 20_000,
        timestamp: NOW - 20_000,
        pathname: "/first",
      }),
    );
    await postIngest(
      ctx.object,
      envelope({
        visitId: "visit-2",
        navigation: "route",
        startedAt: NOW - 10_000,
        timestamp: NOW - 10_000,
        pathname: "/second",
        referrerUrl: "https://example.com/first",
      }),
    );
    await postIngest(
      ctx.object,
      envelope({
        kind: "leave",
        visitId: "visit-2",
        performanceVisitId: "visit-2",
        timestamp: NOW - 5_000,
        durationMs: 4_567.8,
        performance: {
          ttfb: 1.23456,
          fcp: -1,
          lcp: 2500,
          cls: 0.12345,
          inp: 99.9999,
        },
      }),
    );

    const rows = localRows<{
      visit_id: string;
      status: string;
      ended_at: number | null;
      duration_ms: number | null;
      duration_source: string | null;
      perf_ttfb_ms: number | null;
      perf_fcp_ms: number | null;
      perf_lcp_ms: number | null;
      perf_cls: number | null;
      perf_inp_ms: number | null;
    }>(
      ctx.sql,
      `
        SELECT visit_id, status, ended_at, duration_ms, duration_source,
               perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms
        FROM buffered_visits
        ORDER BY visit_id
      `,
    );

    expect(rows).toMatchObject([
      {
        visit_id: "visit-1",
        status: "complete",
        ended_at: NOW - 10_000,
        duration_ms: 10_000,
        duration_source: "server",
      },
      {
        visit_id: "visit-2",
        status: "complete",
        ended_at: NOW - 5_000,
        duration_ms: 5000,
        duration_source: "server",
        perf_ttfb_ms: 1.235,
        perf_fcp_ms: null,
        perf_lcp_ms: 2500,
        perf_cls: 0.123,
        perf_inp_ms: 100,
      },
    ]);
  });

  it("reuses server sessions across browser contexts without closing other tabs", async () => {
    const ctx = createTestDo();

    await postIngest(
      ctx.object,
      envelope({
        visitId: "tab-a-visit",
        startedAt: NOW - 20_000,
        timestamp: NOW - 20_000,
        pathname: "/tab-a",
      }),
    );
    await postIngest(
      ctx.object,
      envelope({
        visitId: "tab-b-visit",
        startedAt: NOW - 10_000,
        timestamp: NOW - 10_000,
        pathname: "/tab-b",
      }),
    );

    const rows = localRows<{
      visit_id: string;
      session_id: string;
      status: string;
    }>(
      ctx.sql,
      `
        SELECT visit_id, session_id, status
        FROM buffered_visits
        ORDER BY visit_id
      `,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.session_id).toBe(rows[1]?.session_id);
    expect(rows).toMatchObject([
      {
        visit_id: "tab-a-visit",
        status: "open",
      },
      {
        visit_id: "tab-b-visit",
        status: "open",
      },
    ]);
  });

  it("closes the matching route referrer instead of another active tab", async () => {
    const ctx = createTestDo();

    await postIngest(
      ctx.object,
      envelope({
        visitId: "tab-a-visit",
        startedAt: NOW - 30_000,
        timestamp: NOW - 30_000,
        pathname: "/tab-a",
      }),
    );
    await postIngest(
      ctx.object,
      envelope({
        visitId: "tab-b-visit",
        startedAt: NOW - 10_000,
        timestamp: NOW - 10_000,
        pathname: "/tab-b",
      }),
    );
    await postIngest(
      ctx.object,
      envelope({
        visitId: "tab-a-next",
        navigation: "route",
        startedAt: NOW - 5_000,
        timestamp: NOW - 5_000,
        pathname: "/tab-a/next",
        referrerUrl: "https://example.com/tab-a",
      }),
    );

    const rows = localRows<{
      visit_id: string;
      status: string;
      ended_at: number | null;
      duration_ms: number | null;
    }>(
      ctx.sql,
      `
        SELECT visit_id, status, ended_at, duration_ms
        FROM buffered_visits
        ORDER BY visit_id
      `,
    );

    expect(rows).toMatchObject([
      {
        visit_id: "tab-a-next",
        status: "open",
      },
      {
        visit_id: "tab-a-visit",
        status: "complete",
        ended_at: NOW - 5_000,
        duration_ms: 25_000,
      },
      {
        visit_id: "tab-b-visit",
        status: "open",
      },
    ]);
  });

  it("starts a new server session after the configured inactivity window", async () => {
    const ctx = createTestDo({ SESSION_WINDOW_MINUTES: "1" });

    await postIngest(
      ctx.object,
      envelope(
        {
          visitId: "old-visit",
          startedAt: NOW - 120_000,
          timestamp: NOW - 120_000,
          pathname: "/old",
        },
        { receivedAt: NOW - 120_000 },
      ),
    );
    await postIngest(
      ctx.object,
      envelope({
        visitId: "new-visit",
        startedAt: NOW,
        timestamp: NOW,
        pathname: "/new",
      }),
    );

    const rows = localRows<{ session_id: string }>(
      ctx.sql,
      `
        SELECT session_id
        FROM buffered_visits
        ORDER BY visit_id
      `,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.session_id).not.toBe(rows[1]?.session_id);
  });

  it("keeps hidden visits pending and lets pagehide override within the grace window", async () => {
    const ctx = createTestDo();

    await postIngest(
      ctx.object,
      envelope({
        visitId: "hidden-visit",
        startedAt: NOW - 20_000,
        timestamp: NOW - 20_000,
      }),
    );
    await postIngest(
      ctx.object,
      envelope({
        kind: "visibility",
        visitId: "hidden-visit",
        visibilityState: "hidden",
        timestamp: NOW - 10_000,
      }),
    );

    expect(
      localRows<{ status: string; hidden_at: number | null }>(
        ctx.sql,
        "SELECT status, hidden_at FROM buffered_visits WHERE visit_id = ?",
        "hidden-visit",
      )[0],
    ).toEqual({ status: "hidden_pending", hidden_at: NOW - 10_000 });

    await postIngest(
      ctx.object,
      envelope({
        kind: "leave",
        visitId: "hidden-visit",
        timestamp: NOW,
        durationMs: 20_000,
      }),
    );

    expect(
      localRows<{
        status: string;
        hidden_at: number | null;
        ended_at: number | null;
        duration_ms: number | null;
        duration_source: string | null;
        exit_reason: string | null;
      }>(
        ctx.sql,
        `SELECT status, hidden_at, ended_at, duration_ms, duration_source, exit_reason
         FROM buffered_visits
         WHERE visit_id = ?`,
        "hidden-visit",
      )[0],
    ).toEqual({
      status: "complete",
      hidden_at: null,
      ended_at: NOW,
      duration_ms: 20_000,
      duration_source: "server",
      exit_reason: "pagehide",
    });
  });

  it("finalizes stale hidden visits at hidden_at during flush", async () => {
    const ctx = createTestDo();
    const startedAt = NOW - 40 * 60 * 1000;
    const hiddenAt = NOW - RECENT_EVENT_RETENTION_MS - 60_000;

    await postIngest(
      ctx.object,
      envelope(
        {
          visitId: "hidden-timeout-visit",
          startedAt,
          timestamp: startedAt,
        },
        { receivedAt: startedAt },
      ),
    );
    await postIngest(
      ctx.object,
      envelope(
        {
          kind: "visibility",
          visitId: "hidden-timeout-visit",
          visibilityState: "hidden",
          timestamp: hiddenAt,
        },
        { receivedAt: hiddenAt },
      ),
    );

    const flush = await ctx.object.fetch(
      new Request("https://ingest.internal/flush", { method: "POST" }),
    );

    expect(flush.status).toBe(200);
    expect(
      ctx.d1.all<{
        status: string;
        ended_at: number | null;
        duration_ms: number | null;
        duration_source: string | null;
        exit_reason: string | null;
      }>(
        `SELECT status, ended_at, duration_ms, duration_source, exit_reason
         FROM visits
         WHERE visit_id = ?`,
        "hidden-timeout-visit",
      )[0],
    ).toEqual({
      status: "complete",
      ended_at: hiddenAt,
      duration_ms: hiddenAt - startedAt,
      duration_source: "hidden",
      exit_reason: "hidden_timeout",
    });
    expect(
      localRows<{ status: string; dirty: number }>(
        ctx.sql,
        "SELECT status, dirty FROM buffered_visits WHERE visit_id = ?",
        "hidden-timeout-visit",
      )[0],
    ).toEqual({ status: "complete", dirty: 0 });
  });

  it("applies identify updates to buffered visits, buffered events, and persisted D1 visits", async () => {
    const ctx = createTestDo();

    await postIngest(ctx.object, envelope());
    await postIngest(
      ctx.object,
      envelope({
        kind: "custom_event",
        eventId: "event-1",
        eventName: "Signup Clicked",
        eventData: { plan: "pro" },
        sequence: 1,
      }),
    );
    await postIngest(
      ctx.object,
      envelope({
        kind: "identify",
        userId: "user-1",
        userName: "Ada",
      }),
    );

    const [bufferedVisit] = localRows<{ user_id: string; user_name: string }>(
      ctx.sql,
      "SELECT user_id, user_name FROM buffered_visits WHERE visit_id = ?",
      "visit-1",
    );
    const [bufferedEvent] = localRows<{ user_id: string }>(
      ctx.sql,
      "SELECT user_id FROM buffered_custom_events WHERE event_id = ?",
      "event-1",
    );
    expect(bufferedVisit).toEqual({ user_id: "user-1", user_name: "Ada" });
    expect(bufferedEvent).toEqual({ user_id: "user-1" });

    ctx.d1.insertVisit({ visit_id: "persisted-visit", user_id: "" });
    const persistedIdentify = await postIngest(
      ctx.object,
      envelope({
        kind: "identify",
        visitId: "persisted-visit",
        userId: "persisted-user",
        userName: "Grace",
      }),
    );
    expect(persistedIdentify.status).toBe(202);

    expect(
      ctx.d1.all<{ user_id: string; user_name: string }>(
        "SELECT user_id, user_name FROM visits WHERE visit_id = ?",
        "persisted-visit",
      )[0],
    ).toEqual({ user_id: "persisted-user", user_name: "Grace" });
  });

  it("buffers custom events waiting for a visit, rejects invalid data, and flushes event JSON paths", async () => {
    const ctx = createTestDo();

    const waiting = await postIngest(
      ctx.object,
      envelope({
        kind: "custom_event",
        visitId: "visit-1",
        eventId: "event-waiting",
        eventName: "Checkout Started",
        eventData: { cart: { total: 42, currency: "USD" } },
        sequence: 1,
      }),
    );
    expect(waiting.status).toBe(202);
    await expect(waiting.text()).resolves.toBe("ignored:waiting_for_visit");

    const invalid = await postIngest(
      ctx.object,
      envelope({
        kind: "custom_event",
        visitId: "visit-1",
        eventId: "event-invalid",
        eventName: "Bad Data",
        eventData: null,
      }),
    );
    expect(invalid.status).toBe(202);
    await expect(invalid.text()).resolves.toBe(
      "ignored:invalid_custom_event_data",
    );

    await postIngest(ctx.object, envelope());
    await postIngest(
      ctx.object,
      envelope({
        kind: "custom_event",
        visitId: "visit-1",
        eventId: "event-live",
        eventName: "Checkout Finished",
        eventData: {
          revenue: 42,
          coupon: "SAVE",
          nested: { valid: true },
        },
        sequence: 2,
      }),
    );

    expect(
      localRows<{ count: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS count FROM buffered_custom_events",
      )[0]?.count,
    ).toBe(2);

    const flush = await ctx.object.fetch(
      new Request("https://ingest.internal/flush", { method: "POST" }),
    );
    expect(flush.status).toBe(200);
    await expect(flush.json()).resolves.toEqual({ ok: true });

    expect(ctx.d1.batch).toHaveBeenCalled();
    expect(
      ctx.d1.all<{ event_id: string }>(
        "SELECT event_id FROM custom_events ORDER BY event_id",
      ),
    ).toEqual([{ event_id: "event-live" }, { event_id: "event-waiting" }]);
    expect(
      ctx.d1.all<{ name: string }>(
        "SELECT name FROM custom_event_names ORDER BY name",
      ),
    ).toEqual([{ name: "Checkout Finished" }, { name: "Checkout Started" }]);
    expect(
      ctx.d1
        .all<{
          path: string;
        }>("SELECT path FROM custom_event_json_paths ORDER BY path")
        .map((row) => row.path),
    ).toEqual(expect.arrayContaining(["/", "/cart/total", "/nested/valid"]));
    expect(
      localRows<{ dirty: number }>(
        ctx.sql,
        "SELECT dirty FROM buffered_custom_events WHERE event_id = ?",
        "event-live",
      )[0]?.dirty,
    ).toBe(0);
  });

  it("hydrates persisted visits when custom events arrive after the buffered row is gone", async () => {
    const ctx = createTestDo();
    ctx.d1.insertVisit({
      visit_id: "persisted-visit",
      status: "complete",
      ended_at: NOW - 500,
      finalized_at: NOW - 500,
    });

    const response = await postIngest(
      ctx.object,
      envelope({
        kind: "custom_event",
        visitId: "persisted-visit",
        eventId: "event-persisted",
        eventName: "Download",
        eventData: { file: "report.pdf" },
      }),
    );

    expect(response.status).toBe(202);
    expect(
      localRows<{ dirty: number; status: string }>(
        ctx.sql,
        "SELECT dirty, status FROM buffered_visits WHERE visit_id = ?",
        "persisted-visit",
      )[0],
    ).toEqual({ dirty: 0, status: "complete" });
    expect(
      localRows<{ event_name: string }>(
        ctx.sql,
        "SELECT event_name FROM buffered_custom_events WHERE event_id = ?",
        "event-persisted",
      )[0],
    ).toEqual({ event_name: "Download" });
  });

  it("falls back to individual D1 visit flushes when a batch fails", async () => {
    const ctx = createTestDo();
    ctx.d1.failBatchCalls = 1;
    await postIngest(ctx.object, envelope());

    const flush = await ctx.object.fetch(
      new Request("https://ingest.internal/flush", { method: "POST" }),
    );

    expect(flush.status).toBe(200);
    expect(ctx.d1.batch).toHaveBeenCalledTimes(2);
    expect(
      ctx.d1.all<{ visit_id: string }>(
        "SELECT visit_id FROM visits WHERE visit_id = ?",
        "visit-1",
      ),
    ).toEqual([{ visit_id: "visit-1" }]);
    expect(
      localRows<{ dirty: number }>(
        ctx.sql,
        "SELECT dirty FROM buffered_visits WHERE visit_id = ?",
        "visit-1",
      )[0]?.dirty,
    ).toBe(0);
  });

  it("deletes rows that cannot be flushed after batch and individual failures", async () => {
    const ctx = createTestDo();
    ctx.d1.failBatchCalls = 2;
    await postIngest(ctx.object, envelope());

    const flush = await ctx.object.fetch(
      new Request("https://ingest.internal/flush", { method: "POST" }),
    );

    expect(flush.status).toBe(200);
    expect(ctx.d1.batch).toHaveBeenCalledTimes(2);
    expect(
      localRows<{ count: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS count FROM buffered_visits",
      )[0]?.count,
    ).toBe(0);
  });

  it("deletes custom events that still have no persisted visit during flush", async () => {
    const ctx = createTestDo();
    await postIngest(
      ctx.object,
      envelope({
        kind: "custom_event",
        eventId: "event-orphan",
        eventName: "Orphan",
        eventData: { ok: true },
      }),
    );

    const flush = await ctx.object.fetch(
      new Request("https://ingest.internal/flush", { method: "POST" }),
    );

    expect(flush.status).toBe(200);
    expect(
      localRows<{ count: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS count FROM buffered_custom_events",
      )[0]?.count,
    ).toBe(0);
    expect(
      ctx.d1.all<{ count: number }>(
        "SELECT COUNT(*) AS count FROM custom_events",
      )[0]?.count,
    ).toBe(0);
  });

  it("cleans old flushed rows during manual flush", async () => {
    const ctx = createTestDo();
    insertBufferedVisit(ctx.sql, {
      visit_id: "old-complete",
      status: "complete",
      ended_at: NOW - RECENT_EVENT_RETENTION_MS - 1,
      finalized_at: NOW - RECENT_EVENT_RETENTION_MS - 1,
      dirty: 0,
    });
    ctx.sql.exec(
      `
        INSERT INTO buffered_custom_events (
          event_id, site_id, visit_id, occurred_at, received_at, sequence,
          event_name, event_data_json, user_id, dirty, flush_attempts,
          last_flush_error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      "old-event",
      "site-1",
      "old-complete",
      NOW - RECENT_EVENT_RETENTION_MS - 1,
      NOW - RECENT_EVENT_RETENTION_MS - 1,
      0,
      "Old Event",
      "{}",
      "",
      0,
      0,
      null,
      toSeconds(NOW),
    );

    const flush = await ctx.object.fetch(
      new Request("https://ingest.internal/flush", { method: "POST" }),
    );

    expect(flush.status).toBe(200);
    expect(
      localRows<{ visits: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS visits FROM buffered_visits",
      )[0]?.visits,
    ).toBe(0);
    expect(
      localRows<{ events: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS events FROM buffered_custom_events",
      )[0]?.events,
    ).toBe(0);
  });

  it("finalizes timed-out visits during alarms and clears alarms when no work remains", async () => {
    const ctx = createTestDo();
    insertBufferedVisit(ctx.sql, {
      visit_id: "stale-visit",
      started_at: NOW - VISIT_TIMEOUT_MS - 60_000,
      last_activity_at: NOW - VISIT_TIMEOUT_MS - 1,
      dirty: 0,
    });

    await ctx.object.alarm();

    expect(
      ctx.d1.all<{ visit_id: string; status: string }>(
        "SELECT visit_id, status FROM visits WHERE visit_id = ?",
        "stale-visit",
      )[0],
    ).toEqual({ visit_id: "stale-visit", status: "timeout" });
    expect(
      localRows<{ count: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS count FROM buffered_visits WHERE visit_id = ?",
        "stale-visit",
      )[0]?.count,
    ).toBe(0);
    expect(ctx.getAlarmAt()).toBeNull();
    expect(ctx.state.storage.deleteAlarm).toHaveBeenCalled();
  });

  it("reschedules alarms while open visits remain buffered", async () => {
    const ctx = createTestDo();
    insertBufferedVisit(ctx.sql, {
      visit_id: "active-visit",
      last_activity_at: NOW,
      dirty: 0,
    });

    await ctx.object.alarm();

    expect(ctx.getAlarmAt()).toBe(NOW + 60_000);
    expect(ctx.state.storage.setAlarm).toHaveBeenCalledWith(NOW + 60_000);
  });

  it("ignores additional invalid validation shapes without buffering rows", async () => {
    const ctx = createTestDo();

    const missingClient = await postIngest(ctx.object, {
      ...envelope(),
      client: undefined,
    });
    expect(missingClient.status).toBe(202);
    await expect(missingClient.text()).resolves.toBe("ignored:missing_site_id");

    const cases: Array<{
      name: string;
      client: Partial<TrackerClientPayload>;
      reason: string;
    }> = [
      {
        name: "pageview visit",
        client: { kind: "pageview", visitId: "" },
        reason: "missing_visit_id",
      },
      {
        name: "leave visit",
        client: { kind: "leave", visitId: "" },
        reason: "missing_visit_id",
      },
      {
        name: "identify visit",
        client: { kind: "identify", visitId: "", userId: "user-1" },
        reason: "missing_visit_id",
      },
      {
        name: "identify user",
        client: { kind: "identify", userId: "" },
        reason: "missing_user_id",
      },
      {
        name: "custom event visit",
        client: {
          kind: "custom_event",
          visitId: "",
          eventName: "Clicked",
          eventData: {},
        },
        reason: "missing_visit_id",
      },
      {
        name: "custom event name",
        client: {
          kind: "custom_event",
          eventName: "",
          eventData: {},
        },
        reason: "missing_event_name",
      },
    ];

    for (const testCase of cases) {
      const response = await postIngest(ctx.object, envelope(testCase.client));
      expect(response.status, testCase.name).toBe(202);
      await expect(response.text(), testCase.name).resolves.toBe(
        `ignored:${testCase.reason}`,
      );
    }

    expect(
      localRows<{ visits: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS visits FROM buffered_visits",
      )[0]?.visits,
    ).toBe(0);
    expect(
      localRows<{ events: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS events FROM buffered_custom_events",
      )[0]?.events,
    ).toBe(0);
  });

  it("normalizes timestamp, session, referrer, and empty UTM fallbacks", async () => {
    const ctx = createTestDo();

    const response = await postIngest(
      ctx.object,
      envelope({
        timestamp: NOW + 10_000,
        startedAt: NOW - 60_000,
        query: "",
        referrerUrl: "https://EXAMPLE.com/other",
      }),
    );

    expect(response.status).toBe(202);
    const [visit] = localRows<{
      session_id: string;
      started_at: number;
      last_activity_at: number;
      referrer_url: string;
      referrer_host: string;
      utm_source: string;
    }>(
      ctx.sql,
      `SELECT session_id, started_at, last_activity_at, referrer_url,
              referrer_host, utm_source
       FROM buffered_visits
       WHERE visit_id = ?`,
      "visit-1",
    );
    expect(visit?.session_id).not.toBe("");
    expect(visit).toMatchObject({
      started_at: NOW,
      last_activity_at: NOW,
      referrer_url: "",
      referrer_host: "",
      utm_source: "",
    });
  });

  it("keeps duplicate pageviews and custom events idempotent", async () => {
    const ctx = createTestDo();

    await postIngest(ctx.object, envelope());
    const duplicatePageview = await postIngest(ctx.object, envelope());
    expect(duplicatePageview.status).toBe(202);
    await expect(duplicatePageview.text()).resolves.toBe("ok");

    await postIngest(
      ctx.object,
      envelope({
        kind: "custom_event",
        eventId: "event-duplicate",
        eventName: "Duplicate",
        eventData: { ok: true },
      }),
    );
    const duplicateEvent = await postIngest(
      ctx.object,
      envelope({
        kind: "custom_event",
        eventId: "event-duplicate",
        eventName: "Duplicate",
        eventData: { ok: true },
      }),
    );

    expect(duplicateEvent.status).toBe(202);
    expect(
      localRows<{ visits: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS visits FROM buffered_visits",
      )[0]?.visits,
    ).toBe(1);
    expect(
      localRows<{ events: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS events FROM buffered_custom_events",
      )[0]?.events,
    ).toBe(1);
  });

  it("hydrates persisted visits when leave performance arrives without a buffered visit", async () => {
    const ctx = createTestDo();
    ctx.d1.insertVisit({
      visit_id: "persisted-perf",
      status: "complete",
      ended_at: NOW - 1_000,
      finalized_at: NOW - 1_000,
    });

    const response = await postIngest(
      ctx.object,
      envelope({
        kind: "leave",
        visitId: "missing-open-visit",
        performanceVisitId: "persisted-perf",
        performance: {
          ttfb: 12.3456,
          lcp: 999.4,
        },
      }),
    );

    expect(response.status).toBe(202);
    const [visit] = localRows<{
      visit_id: string;
      status: string;
      dirty: number;
      perf_ttfb_ms: number;
      perf_lcp_ms: number;
    }>(
      ctx.sql,
      `SELECT visit_id, status, dirty, perf_ttfb_ms, perf_lcp_ms
       FROM buffered_visits
       WHERE visit_id = ?`,
      "persisted-perf",
    );
    expect(visit).toEqual({
      visit_id: "persisted-perf",
      status: "complete",
      dirty: 1,
      perf_ttfb_ms: 12.346,
      perf_lcp_ms: 999.4,
    });
  });

  it("pushes snapshots and realtime events to websocket clients and prunes stale sockets", async () => {
    const ctx = createTestDo();
    insertBufferedVisit(ctx.sql, {
      visit_id: "socket-active",
      last_activity_at: NOW - 1_000,
      dirty: 0,
      screen_width: null,
      screen_height: null,
      os: "",
      os_version: "13",
    });

    const pairs: Array<[FakeWebSocket, FakeWebSocket]> = [
      [new FakeWebSocket(), new FakeWebSocket()],
      [new FakeWebSocket(), new FakeWebSocket()],
      [new FakeWebSocket(), new FakeWebSocket()],
    ];
    const issuedPairs: Array<readonly [FakeWebSocket, FakeWebSocket]> = [];
    class TestWebSocketPair {
      constructor() {
        const pair = pairs.shift();
        if (!pair) throw new Error("unexpected websocket pair");
        issuedPairs.push(pair);
        return pair;
      }
    }
    const wsRequest = (url: string) =>
      ({
        url,
        method: "GET",
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "upgrade" ? "websocket" : null,
        },
      }) as unknown as Request;
    const RealResponse = globalThis.Response;
    vi.stubGlobal("WebSocketPair", TestWebSocketPair);
    vi.stubGlobal("Response", FakeUpgradeResponse);

    const firstUpgrade = await ctx.object.fetch(
      wsRequest("https://ingest.internal/ws?siteId=site-1"),
    );
    const secondUpgrade = await ctx.object.fetch(
      wsRequest("https://ingest.internal/ws?siteId=site-1"),
    );
    const thirdUpgrade = await ctx.object.fetch(
      wsRequest("https://ingest.internal/ws?siteId=site-1"),
    );
    vi.stubGlobal("Response", RealResponse);

    expect(firstUpgrade.status).toBe(101);
    expect(secondUpgrade.status).toBe(101);
    expect(thirdUpgrade.status).toBe(101);

    const [, healthyServer] = issuedPairs[0]!;
    const [, staleServer] = issuedPairs[1]!;
    const [, errorServer] = issuedPairs[2]!;

    expect(healthyServer.accepted).toBe(true);
    const initialSnapshot = JSON.parse(healthyServer.sent[0] ?? "{}");
    expect(initialSnapshot).toMatchObject({
      type: "snapshot",
      data: {
        activeNow: 1,
        visits: [
          {
            visitId: "socket-active",
            screenWidth: null,
            screenHeight: null,
            osVersion: "13",
          },
        ],
      },
    });

    staleServer.failSend = true;
    errorServer.emit("error");
    expect(errorServer.closed).toBe(true);

    await postIngest(
      ctx.object,
      envelope({
        visitId: "socket-visit",
        visitorId: "socket-visitor",
        pathname: "/socket",
        timestamp: NOW - 2_000,
        startedAt: NOW - 2_000,
      }),
    );
    await postIngest(
      ctx.object,
      envelope({
        kind: "custom_event",
        visitId: "socket-visit",
        eventId: "socket-event",
        eventName: "Socket Event",
        eventData: { ok: true },
        timestamp: NOW - 1_000,
      }),
    );
    await postIngest(
      ctx.object,
      envelope({
        kind: "leave",
        visitId: "socket-visit",
        timestamp: NOW,
      }),
    );

    const eventMessages = healthyServer.sent
      .slice(1)
      .map((payload) => JSON.parse(payload));
    expect(eventMessages.map((message) => message.data.eventType)).toEqual([
      "visit",
      "Socket Event",
      "__presence_leave",
    ]);
    expect(staleServer.closed).toBe(true);

    healthyServer.emit("close");
    await postIngest(
      ctx.object,
      envelope({
        visitId: "after-close",
      }),
    );
    expect(healthyServer.sent).toHaveLength(4);

    const snapshot = await ctx.object.fetch(
      new Request("https://ingest.internal/snapshot?from=NaN&to=NaN&limit=NaN"),
    );
    await expect(snapshot.json()).resolves.toMatchObject({
      ok: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "leave:socket-visit",
          eventType: "__presence_leave",
        }),
      ]),
    });
  });

  it("deletes custom events when D1 custom event flush expansion or insert verification fails", async () => {
    const invalidJsonCtx = createTestDo();
    invalidJsonCtx.d1.insertVisit({ visit_id: "visit-invalid-json" });
    insertBufferedCustomEvent(invalidJsonCtx.sql, {
      event_id: "event-invalid-json",
      visit_id: "visit-invalid-json",
      event_data_json: "{not-json",
    });

    const invalidJsonFlush = await invalidJsonCtx.object.fetch(
      new Request("https://ingest.internal/flush", { method: "POST" }),
    );

    expect(invalidJsonFlush.status).toBe(200);
    expect(
      localRows<{ events: number }>(
        invalidJsonCtx.sql,
        "SELECT COUNT(*) AS events FROM buffered_custom_events",
      )[0]?.events,
    ).toBe(0);

    const missingInsertCtx = createTestDo();
    missingInsertCtx.d1.insertVisit({ visit_id: "visit-removed-before-batch" });
    insertBufferedCustomEvent(missingInsertCtx.sql, {
      event_id: "event-missing-insert",
      visit_id: "visit-removed-before-batch",
      event_name: "Missing Insert",
      event_data_json: '{"ok":true}',
    });
    missingInsertCtx.d1.beforeBatch = () => {
      missingInsertCtx.d1.db
        .prepare("DELETE FROM visits WHERE visit_id = ?")
        .run("visit-removed-before-batch");
    };

    const missingInsertFlush = await missingInsertCtx.object.fetch(
      new Request("https://ingest.internal/flush", { method: "POST" }),
    );

    expect(missingInsertFlush.status).toBe(200);
    expect(
      localRows<{ events: number }>(
        missingInsertCtx.sql,
        "SELECT COUNT(*) AS events FROM buffered_custom_events",
      )[0]?.events,
    ).toBe(0);
    expect(
      missingInsertCtx.d1.all<{ events: number }>(
        "SELECT COUNT(*) AS events FROM custom_events",
      )[0]?.events,
    ).toBe(0);
  });

  it("hydrates persisted orphan custom event visits and deletes old unresolved orphans during cleanup", async () => {
    const ctx = createTestDo();
    ctx.d1.insertVisit({
      visit_id: "late-persisted",
      status: "complete",
      ended_at: NOW - VISIT_TIMEOUT_MS - 5_000,
      finalized_at: NOW - VISIT_TIMEOUT_MS - 5_000,
    });

    for (let index = 0; index < 10; index += 1) {
      insertBufferedCustomEvent(ctx.sql, {
        event_id: `event-old-${index}`,
        visit_id: `missing-${index}`,
        occurred_at: NOW - VISIT_TIMEOUT_MS - 10_000 + index,
        received_at: NOW - VISIT_TIMEOUT_MS - 10_000 + index,
        created_at: toSeconds(NOW - VISIT_TIMEOUT_MS - 10_000 + index),
      });
    }
    insertBufferedCustomEvent(ctx.sql, {
      event_id: "event-hydrate",
      visit_id: "late-persisted",
      occurred_at: NOW - VISIT_TIMEOUT_MS - 1_000,
      received_at: NOW - VISIT_TIMEOUT_MS - 1_000,
      created_at: toSeconds(NOW - VISIT_TIMEOUT_MS - 1_000),
    });
    insertBufferedCustomEvent(ctx.sql, {
      event_id: "event-delete",
      visit_id: "still-missing",
      occurred_at: NOW - VISIT_TIMEOUT_MS - 500,
      received_at: NOW - VISIT_TIMEOUT_MS - 500,
      created_at: toSeconds(NOW - VISIT_TIMEOUT_MS - 500),
    });

    const flush = await ctx.object.fetch(
      new Request("https://ingest.internal/flush", { method: "POST" }),
    );

    expect(flush.status).toBe(200);
    expect(
      localRows<{ dirty: number; status: string }>(
        ctx.sql,
        "SELECT dirty, status FROM buffered_visits WHERE visit_id = ?",
        "late-persisted",
      )[0],
    ).toEqual({ dirty: 0, status: "complete" });
    expect(
      localRows<{ events: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS events FROM buffered_custom_events WHERE event_id = ?",
        "event-hydrate",
      )[0]?.events,
    ).toBe(1);
    expect(
      localRows<{ events: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS events FROM buffered_custom_events WHERE event_id = ?",
        "event-delete",
      )[0]?.events,
    ).toBe(0);
  });

  it("reports diagnostics when alarm lookup fails", async () => {
    const ctx = createTestDo();
    vi.mocked(ctx.state.storage.getAlarm).mockRejectedValueOnce(
      new Error("alarm unavailable"),
    );

    const diagnostic = await ctx.object.fetch(
      new Request("https://ingest.internal/diagnostic"),
    );

    expect(diagnostic.status).toBe(200);
    await expect(diagnostic.json()).resolves.toMatchObject({
      ok: true,
      alarm: {
        scheduledAt: null,
      },
    });
  });

  it("normalizes diagnostics when storage aggregates are missing or nonnumeric", async () => {
    const ctx = createTestDo();
    const originalExec = ctx.sql.exec.bind(ctx.sql);
    vi.spyOn(ctx.sql, "exec").mockImplementation(
      (query: string, ...bindings: SqlBinding[]) => {
        const normalized = query.replace(/\s+/g, " ");
        if (normalized.includes("SELECT COUNT(*) AS c FROM buffered_visits")) {
          return new SqlResult([], 0);
        }
        if (
          normalized.includes(
            "SELECT status, COUNT(*) AS c FROM buffered_visits GROUP BY status",
          )
        ) {
          return new SqlResult([{ status: "open", c: null }], 0);
        }
        if (normalized.includes("oldestStartedAt")) {
          return new SqlResult(
            [
              {
                total: "NaN",
                stale: "Infinity",
                timedOut: "nope",
                hardAged: null,
                futureSkewed: "1",
                oldestStartedAt: "not-a-timestamp",
                newestActivityAt: "123",
                futureMaxActivityAt: undefined,
              } as SqlRow,
            ],
            0,
          );
        }
        if (
          normalized.includes("FROM buffered_visits") &&
          normalized.includes("MAX(flush_attempts) AS maxAttempts")
        ) {
          return new SqlResult(
            [{ total: "NaN", stuck: "Infinity", maxAttempts: "5" }],
            0,
          );
        }
        if (normalized.includes("FROM buffered_custom_events")) {
          return new SqlResult(
            [
              {
                total: "NaN",
                dirty: "bad",
                stuck: "Infinity",
                maxAttempts: "nope",
                oldestOccurredAt: "bad",
              },
            ],
            0,
          );
        }
        return originalExec(query, ...bindings);
      },
    );
    vi.mocked(ctx.state.storage.getAlarm).mockResolvedValueOnce(
      "not-a-number" as never,
    );

    const diagnostic = await ctx.object.fetch(
      new Request("https://ingest.internal/diagnostic"),
    );

    expect(diagnostic.status).toBe(200);
    await expect(diagnostic.json()).resolves.toMatchObject({
      ok: true,
      visits: {
        total: 0,
        byStatus: { open: 0 },
        open: {
          total: 0,
          stale: 0,
          timedOut: 0,
          hardAged: 0,
          futureSkewed: 1,
          oldestStartedAt: null,
          newestActivityAt: 123,
          futureMaxActivityAt: null,
        },
        dirty: {
          total: 0,
          stuck: 0,
          maxFlushAttempts: 5,
        },
      },
      customEvents: {
        total: 0,
        dirty: 0,
        stuck: 0,
        maxFlushAttempts: 0,
        oldestOccurredAt: null,
      },
      alarm: {
        scheduledAt: null,
      },
    });
  });

  it("repairs legacy buffered custom event schemas during initialization", () => {
    const legacySql = new SqliteSqlStorage();
    legacySql.exec(`
      CREATE TABLE buffered_custom_events (
        event_id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        visit_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        pathname TEXT NOT NULL,
        hostname TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        event_name TEXT NOT NULL,
        event_data_json TEXT NOT NULL DEFAULT '{}',
        dirty INTEGER NOT NULL DEFAULT 1,
        flush_attempts INTEGER NOT NULL DEFAULT 0,
        last_flush_error TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    createTestDo({}, legacySql);

    expect(
      localRows<{ name: string }>(
        legacySql,
        "PRAGMA table_info(buffered_custom_events)",
      ).map((column) => column.name),
    ).toEqual(expect.arrayContaining(["received_at", "sequence", "user_id"]));

    const missingUserSql = new SqliteSqlStorage();
    missingUserSql.exec(`
      CREATE TABLE buffered_custom_events (
        event_id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        visit_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0,
        event_name TEXT NOT NULL,
        event_data_json TEXT NOT NULL DEFAULT '{}',
        dirty INTEGER NOT NULL DEFAULT 1,
        flush_attempts INTEGER NOT NULL DEFAULT 0,
        last_flush_error TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    createTestDo({}, missingUserSql);

    expect(
      localRows<{ name: string }>(
        missingUserSql,
        "PRAGMA table_info(buffered_custom_events)",
      ).map((column) => column.name),
    ).toContain("user_id");
  });

  it("reschedules alarms when dirty custom events remain after the alarm flush budget", async () => {
    const ctx = createTestDo();
    ctx.d1.insertVisit({
      visit_id: "event-budget-visit",
      status: "complete",
      ended_at: NOW - 1_000,
      finalized_at: NOW - 1_000,
    });

    for (let index = 0; index < 21; index += 1) {
      insertBufferedCustomEvent(ctx.sql, {
        event_id: `event-budget-${index}`,
        visit_id: "event-budget-visit",
        event_name: "Budget Event",
        event_data_json: '{"ok":true}',
      });
    }

    await ctx.object.alarm();

    expect(ctx.getAlarmAt()).toBe(NOW + 60_000);
    expect(
      localRows<{ dirty: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS dirty FROM buffered_custom_events WHERE dirty = 1",
      )[0]?.dirty,
    ).toBe(1);
  });

  it("reschedules alarms when dirty visits remain after the alarm flush budget", async () => {
    const ctx = createTestDo();
    for (let index = 0; index < 201; index += 1) {
      insertBufferedVisit(ctx.sql, {
        visit_id: `visit-budget-${index}`,
        session_id: `session-budget-${index}`,
        status: "complete",
        ended_at: NOW - 1_000,
        finalized_at: NOW - 1_000,
        dirty: 1,
      });
    }

    await ctx.object.alarm();

    expect(ctx.getAlarmAt()).toBe(NOW + 60_000);
    expect(
      localRows<{ dirty: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS dirty FROM buffered_visits WHERE dirty = 1",
      )[0]?.dirty,
    ).toBe(1);
    expect(ctx.state.storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it("deletes old flushed custom event rows immediately after successful D1 flush", async () => {
    const ctx = createTestDo();
    ctx.d1.insertVisit({
      visit_id: "old-event-visit",
      status: "complete",
      ended_at: NOW - RECENT_EVENT_RETENTION_MS - 1,
      finalized_at: NOW - RECENT_EVENT_RETENTION_MS - 1,
    });
    insertBufferedCustomEvent(ctx.sql, {
      event_id: "old-flushed-event",
      visit_id: "old-event-visit",
      event_name: "Old Flushed",
      event_data_json: '{"ok":true}',
      occurred_at: NOW - RECENT_EVENT_RETENTION_MS - 1,
      received_at: NOW - RECENT_EVENT_RETENTION_MS - 1,
      created_at: toSeconds(NOW - RECENT_EVENT_RETENTION_MS - 1),
    });

    const flush = await ctx.object.fetch(
      new Request("https://ingest.internal/flush", { method: "POST" }),
    );

    expect(flush.status).toBe(200);
    expect(
      ctx.d1.all<{ event_id: string }>(
        "SELECT event_id FROM custom_events WHERE event_id = ?",
        "old-flushed-event",
      ),
    ).toEqual([{ event_id: "old-flushed-event" }]);
    expect(
      localRows<{ events: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS events FROM buffered_custom_events WHERE event_id = ?",
        "old-flushed-event",
      )[0]?.events,
    ).toBe(0);
  });

  it("keeps old orphan events when cleanup hydrates every missing visit from D1", async () => {
    const ctx = createTestDo();
    ctx.d1.insertVisit({
      visit_id: "only-persisted-orphan",
      status: "complete",
      ended_at: NOW - VISIT_TIMEOUT_MS - 1_000,
      finalized_at: NOW - VISIT_TIMEOUT_MS - 1_000,
    });
    for (let index = 0; index < 21; index += 1) {
      insertBufferedCustomEvent(ctx.sql, {
        event_id: `only-hydrated-event-${index}`,
        visit_id: "only-persisted-orphan",
        event_name: "Hydrated Orphan",
        event_data_json: '{"ok":true}',
        occurred_at: NOW - VISIT_TIMEOUT_MS - 1_000 + index,
        received_at: NOW - VISIT_TIMEOUT_MS - 1_000 + index,
        created_at: toSeconds(NOW - VISIT_TIMEOUT_MS - 1_000 + index),
      });
    }

    const flush = await ctx.object.fetch(
      new Request("https://ingest.internal/flush", { method: "POST" }),
    );

    expect(flush.status).toBe(200);
    expect(
      localRows<{ dirty: number }>(
        ctx.sql,
        "SELECT dirty FROM buffered_visits WHERE visit_id = ?",
        "only-persisted-orphan",
      )[0],
    ).toEqual({ dirty: 0 });
    expect(
      localRows<{ events: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS events FROM buffered_custom_events WHERE event_id = ?",
        "only-hydrated-event-20",
      )[0]?.events,
    ).toBe(1);
  });

  it("records websocket initial snapshot send failures in the invocation log", async () => {
    const ctx = createTestDo();
    const client = new FakeWebSocket();
    const server = new FakeWebSocket();
    server.failSend = true;
    class FailingSnapshotWebSocketPair {
      constructor() {
        return [client, server];
      }
    }
    const RealResponse = globalThis.Response;
    vi.stubGlobal("WebSocketPair", FailingSnapshotWebSocketPair);
    vi.stubGlobal("Response", FakeUpgradeResponse);

    const response = await ctx.object.fetch({
      url: "https://ingest.internal/ws",
      method: "GET",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "upgrade" ? "websocket" : null,
      },
    } as unknown as Request);
    vi.stubGlobal("Response", RealResponse);

    expect(response.status).toBe(101);
    expect(server.accepted).toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "do",
        trigger: "request",
        request: expect.objectContaining({ route: "/ws", status: 101 }),
        logs: expect.arrayContaining([
          expect.objectContaining({ message: "do.websocket.snapshot_failed" }),
        ]),
      }),
    );
  });

  it("ignores leave updates that lose the open-visit race", async () => {
    const ctx = createTestDo();
    await postIngest(
      ctx.object,
      envelope({
        visitId: "race-visit",
        startedAt: NOW - 10_000,
        timestamp: NOW - 10_000,
      }),
    );

    const originalExec = ctx.sql.exec.bind(ctx.sql);
    vi.spyOn(ctx.sql, "exec").mockImplementation(
      (query: string, ...bindings: SqlBinding[]) => {
        const normalized = query.replace(/\s+/g, " ");
        if (
          normalized.includes("UPDATE buffered_visits") &&
          normalized.includes("duration_source = ?") &&
          normalized.includes("exit_reason = ?") &&
          normalized.includes(
            "WHERE visit_id = ? AND status IN ('open', 'hidden_pending')",
          )
        ) {
          originalExec(
            "UPDATE buffered_visits SET status = 'complete' WHERE visit_id = ?",
            "race-visit",
          );
        }
        return originalExec(query, ...bindings);
      },
    );

    const response = await postIngest(
      ctx.object,
      envelope({
        kind: "leave",
        visitId: "race-visit",
        timestamp: NOW,
      }),
    );

    expect(response.status).toBe(202);
    expect(console.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: "do",
        traceId: "trace-1",
        logs: expect.arrayContaining([
          expect.objectContaining({ message: "do.ingest.leave_race_lost" }),
          expect.objectContaining({ message: "do.ingest.leave_ignored" }),
        ]),
      }),
    );
    await expect(
      (
        await ctx.object.fetch(
          new Request(
            "https://ingest.internal/snapshot?from=0&to=9999999999999&limit=10",
          ),
        )
      ).json(),
    ).resolves.toMatchObject({
      data: expect.not.arrayContaining([
        expect.objectContaining({ eventType: "__presence_leave" }),
      ]),
    });
  });

  it("does not hydrate performance rows when neither buffered nor persisted visit exists", async () => {
    const ctx = createTestDo();

    const response = await postIngest(
      ctx.object,
      envelope({
        kind: "leave",
        visitId: "missing-leave",
        performanceVisitId: "missing-performance",
        performance: {
          ttfb: 10,
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(
      localRows<{ visits: number }>(
        ctx.sql,
        "SELECT COUNT(*) AS visits FROM buffered_visits",
      )[0]?.visits,
    ).toBe(0);
  });

  it("identifies persisted visits without user names or session ids and swallows D1 write failures", async () => {
    const persistedCtx = createTestDo();
    persistedCtx.d1.insertVisit({
      visit_id: "persisted-no-name",
      user_id: "",
      user_name: "",
    });

    const persistedIdentify = await postIngest(
      persistedCtx.object,
      envelope({
        kind: "identify",
        visitId: "persisted-no-name",
        userId: "user-without-name",
        userName: "",
      }),
    );

    expect(persistedIdentify.status).toBe(202);
    expect(
      persistedCtx.d1.all<{ user_id: string; user_name: string | null }>(
        "SELECT user_id, user_name FROM visits WHERE visit_id = ?",
        "persisted-no-name",
      )[0],
    ).toEqual({ user_id: "user-without-name", user_name: null });

    const failingCtx = createTestDo();
    failingCtx.d1.insertVisit({
      visit_id: "persisted-failing-identify",
      user_id: "",
      user_name: "",
    });
    failingCtx.d1.failRunCalls = 1;

    const failingIdentify = await postIngest(
      failingCtx.object,
      envelope({
        kind: "identify",
        visitId: "persisted-failing-identify",
        userId: "lost-user",
        userName: "",
      }),
    );

    expect(failingIdentify.status).toBe(202);
    expect(
      failingCtx.d1.all<{ user_id: string; user_name: string | null }>(
        "SELECT user_id, user_name FROM visits WHERE visit_id = ?",
        "persisted-failing-identify",
      )[0],
    ).toEqual({ user_id: "", user_name: "" });
  });
});
