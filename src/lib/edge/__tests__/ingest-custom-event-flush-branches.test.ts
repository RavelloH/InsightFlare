import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FLUSHED_BUFFER_RETENTION_MS } from "@/lib/edge/ingest-constants";
import { flushCustomEventRowIndividually } from "@/lib/edge/ingest-custom-event-flush";
import type { IngestFlushContext } from "@/lib/edge/ingest-flush-types";
import type { BufferedCustomEventRow } from "@/lib/edge/ingest-types";
import type { InvocationPerformanceCounter } from "@/lib/edge/observability-logger";

const NOW = Date.UTC(2026, 4, 25, 12, 0, 0);

type Binding = string | number | null;

interface D1Call {
  sql: string;
  bindings: Binding[];
}

function bufferedCustomEvent(
  overrides: Partial<BufferedCustomEventRow> = {},
): BufferedCustomEventRow {
  return {
    eventId: "event-1",
    siteId: "site-1",
    visitId: "visit-1",
    occurredAt: NOW - 1_000,
    receivedAt: NOW,
    sequence: 7,
    eventName: "Signup",
    eventDataJson: '{"plan":"pro"}',
    userId: "",
    dirty: 1,
    flushAttempts: 0,
    flushDueAt: NOW,
    nextDueAt: NOW,
    bufferRevision: 1,
    createdAt: Math.floor(NOW / 1000),
    ...overrides,
  };
}

function createFlushContext(options: {
  visitExists?: boolean;
  eventExists?: boolean;
  dictionaryIds?: Record<string, number>;
}): IngestFlushContext & {
  calls: D1Call[];
  sqlRun: ReturnType<typeof vi.fn>;
  batch: ReturnType<typeof vi.fn>;
  observability: {
    increment: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
} {
  const calls: D1Call[] = [];
  const sqlRun = vi.fn(() => 1);
  const batch = vi.fn(async () => []);
  const dictionaryIds = new Map<string, number>();
  for (const [key, value] of Object.entries(options.dictionaryIds ?? {})) {
    dictionaryIds.set(key, value);
  }

  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...bindings: Binding[]) => {
      calls.push({ sql, bindings });
      return {
        run: vi.fn(async () => ({})),
        first: vi.fn(async () => {
          if (sql.includes("FROM visits")) {
            return options.visitExists === false ? null : { ok: 1 };
          }
          if (sql.includes("FROM custom_events")) {
            return options.eventExists === false ? null : { ok: 1 };
          }
          if (sql.includes("FROM custom_event_names")) return { id: 10 };
          if (sql.includes("FROM custom_event_json_keys")) return { id: 20 };
          if (sql.includes("FROM custom_event_json_paths")) {
            const path = String(bindings[1] ?? "");
            return { id: path === "/" ? 30 : 31 };
          }
          return null;
        }),
      };
    }),
  }));

  return {
    env: {
      DB: {
        prepare,
        batch,
      } as unknown as D1Database,
    },
    dictionaryIds,
    sitePks: new Map([["site-1", 1]]),
    sqlAll: vi.fn(() => []),
    sqlOne: vi.fn(() => null),
    sqlRun,
    readPersistedVisitRow: vi.fn(async () => null),
    insertBufferedVisitRow: vi.fn(),
    hasOpenVisitsForVisitor: vi.fn(() => false),
    pushRealtimeRecord: vi.fn(async () => undefined),
    observability: {
      increment:
        vi.fn<
          (counter: InvocationPerformanceCounter, amount?: number) => void
        >(),
      info: vi.fn<(message: string) => void>(),
      warn: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string) => void>(),
    },
    calls,
    batch,
  };
}

describe("custom event individual flush branch coverage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("backs off buffered custom events while waiting for their visit", async () => {
    const context = createFlushContext({ visitExists: false });

    await expect(
      flushCustomEventRowIndividually(context, bufferedCustomEvent()),
    ).resolves.toBe(false);

    expect(context.batch).not.toHaveBeenCalled();
    expect(context.sqlRun).toHaveBeenCalledWith(
      "UPDATE buffered_custom_events SET flush_attempts = ?, last_flush_error = 'waiting_for_visit', flush_due_at = ?, next_due_at = ? WHERE event_id = ? AND buffer_revision = ? AND flush_attempts = ? AND last_flush_error IS ?",
      1,
      NOW + 60_000,
      NOW + 60_000,
      "event-1",
      1,
      0,
      null,
    );
    expect(context.observability.warn).toHaveBeenCalledWith(
      "do.flush.custom_event_waiting_for_visit",
    );
  });

  it("flushes custom events, resolves dictionaries, and deletes old flushed rows", async () => {
    const context = createFlushContext({});
    const row = bufferedCustomEvent({
      occurredAt: NOW - FLUSHED_BUFFER_RETENTION_MS - 1,
      userId: "user-1",
    });

    await expect(flushCustomEventRowIndividually(context, row)).resolves.toBe(
      true,
    );

    expect(context.batch).toHaveBeenCalledTimes(1);
    expect(context.batch.mock.calls[0]![0]).toHaveLength(4);
    expect(context.dictionaryIds).toEqual(
      new Map([
        ["name:site-1:Signup", 10],
        ["key:site-1:plan", 20],
        ["path:site-1:/", 30],
        ["path:site-1:/plan", 31],
      ]),
    );
    expect(
      context.calls.some((call) => call.sql.includes("event_name_id")),
    ).toBe(true);
    const createdAt = Math.floor(NOW / 1000);
    expect(context.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bindings: [1, "visit-1"] }),
        expect.objectContaining({
          bindings: ["site-1", 1, "Signup", createdAt, createdAt],
        }),
        expect.objectContaining({
          bindings: ["site-1", 1, "plan", createdAt, createdAt],
        }),
        expect.objectContaining({
          bindings: ["site-1", 1, "/", createdAt, createdAt],
        }),
        expect.objectContaining({ bindings: ["event-1"] }),
      ]),
    );
    expect(context.sqlRun).toHaveBeenNthCalledWith(
      1,
      "UPDATE buffered_custom_events SET dirty = 0, flush_attempts = 0, last_flush_error = NULL, flush_due_at = NULL, next_due_at = NULL WHERE (event_id = ? AND buffer_revision = ?)",
      "event-1",
      1,
    );
    expect(context.sqlRun).toHaveBeenNthCalledWith(
      2,
      "DELETE FROM buffered_custom_events WHERE (event_id = ? AND buffer_revision = ?)",
      "event-1",
      1,
    );
    const d1Statements = context.observability.increment.mock.calls
      .filter(([counter]) => counter === "d1Statements")
      .reduce((total, [, amount]) => total + (amount ?? 1), 0);
    expect(d1Statements).toBe(14);
    expect(context.observability.increment).toHaveBeenCalledWith(
      "flushedCustomEvents",
      1,
    );
  });

  it("marks rows failed when the batch does not create a persisted event", async () => {
    const context = createFlushContext({ eventExists: false });

    await expect(
      flushCustomEventRowIndividually(context, bufferedCustomEvent()),
    ).resolves.toBe(false);

    expect(context.batch).toHaveBeenCalledTimes(1);
    expect(context.sqlRun).toHaveBeenCalledWith(
      "UPDATE buffered_custom_events SET flush_attempts = ?, last_flush_error = ?, flush_due_at = ?, next_due_at = ? WHERE event_id = ? AND buffer_revision = ? AND flush_attempts = ? AND last_flush_error IS ?",
      1,
      "insert_did_not_create_event",
      NOW + 60_000,
      NOW + 60_000,
      "event-1",
      1,
      0,
      null,
    );
    expect(context.observability.warn).toHaveBeenCalledWith(
      "do.flush.custom_event_insert_not_confirmed",
    );
  });

  it("normalizes non-Error D1 failures before scheduling a retry", async () => {
    const context = createFlushContext({});
    context.batch.mockRejectedValue("string failure");

    await expect(
      flushCustomEventRowIndividually(context, bufferedCustomEvent()),
    ).resolves.toBe(false);

    expect(context.sqlRun).toHaveBeenCalledWith(
      "UPDATE buffered_custom_events SET flush_attempts = ?, last_flush_error = ?, flush_due_at = ?, next_due_at = ? WHERE event_id = ? AND buffer_revision = ? AND flush_attempts = ? AND last_flush_error IS ?",
      1,
      "string failure",
      NOW + 60_000,
      NOW + 60_000,
      "event-1",
      1,
      0,
      null,
    );
  });

  it("uses cached dictionary ids without re-querying dictionary tables", async () => {
    const context = createFlushContext({
      dictionaryIds: {
        "name:site-1:Signup": 10,
        "key:site-1:plan": 20,
        "path:site-1:/": 30,
        "path:site-1:/plan": 31,
      },
    });

    await expect(
      flushCustomEventRowIndividually(context, bufferedCustomEvent()),
    ).resolves.toBe(true);

    expect(
      context.calls.some((call) => call.sql.includes("custom_event_json_keys")),
    ).toBe(false);
    expect(context.batch).toHaveBeenCalledTimes(1);
  });

  it("uses the documented exponential retry sequence", async () => {
    const delays = [60_000, 120_000, 240_000, 480_000, 900_000, 900_000];

    for (const [previousAttempts, delay] of delays.entries()) {
      const context = createFlushContext({ visitExists: false });
      const row = bufferedCustomEvent({
        flushAttempts: previousAttempts,
        flushDueAt: NOW,
        nextDueAt: NOW,
      });

      await flushCustomEventRowIndividually(context, row);

      expect(context.sqlRun).toHaveBeenCalledWith(
        "UPDATE buffered_custom_events SET flush_attempts = ?, last_flush_error = 'waiting_for_visit', flush_due_at = ?, next_due_at = ? WHERE event_id = ? AND buffer_revision = ? AND flush_attempts = ? AND last_flush_error IS ?",
        previousAttempts + 1,
        NOW + delay,
        NOW + delay,
        "event-1",
        1,
        previousAttempts,
        null,
      );
    }
  });
});
