import "@tanstack/react-start/server-only";

import {
  analyticsFilterRegistry,
  type FilterDocument,
  filterFingerprint,
  type QueryAudience,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { mapVisitors } from "@/lib/edge/analytics/providers/d1/internal/core-mappers";
import {
  queryJourneyEventDetailFromD1,
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
  stripSessionDetailCollections,
  stripVisitorDetailCollections,
} from "@/lib/edge/analytics/providers/d1/internal/journey-detail-queries";
import {
  parseSessionListCursor,
  parseVisitorListCursor,
  queryJourneyEventsPageFromD1,
  queryJourneyTargetExistsFromD1,
  querySessionListPageFromD1,
  queryVisitorListPageFromD1,
  serializeSessionListCursor,
  serializeVisitorListCursor,
  type SessionListCursor,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  decodePageCursor,
  encodePageCursor,
  paginationBinding,
} from "@/lib/edge/analytics/providers/d1/internal/pagination";
import type { Env } from "@/lib/edge/types";
import { sha256Hex } from "@/lib/edge/utils";
import { rootSecret } from "@/lib/secrets";

interface JourneyDetailInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
}

interface JourneySearchInput extends JourneyDetailInput {
  readonly filters: FilterDocument;
  readonly search?: string;
  readonly page: { readonly limit: number; readonly cursor?: string | null };
  readonly audience?: QueryAudience;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    ),
  );
}

async function cursorBinding(
  input: JourneySearchInput,
  operation: "visitors" | "sessions",
  sort: unknown,
): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      `journey-${operation}-v1`,
      input.audience ?? "private-dashboard",
      input.siteId,
      input.window.startMs,
      input.window.endExclusiveMs,
      input.window.timeZone,
      filterFingerprint(input.filters, analyticsFilterRegistry),
      input.search ?? null,
      sort,
    ]),
  );
}

async function decodeCursor(
  input: JourneySearchInput,
  operation: "visitors" | "sessions",
  sort: unknown,
): Promise<string | null> {
  if (!input.page.cursor) return null;
  const secret = rootSecret(input.env);
  if (!secret) return null;
  const [payload, signature, extra] = input.page.cursor.split(".");
  if (
    !payload ||
    !signature ||
    extra ||
    (await sign(secret, payload)) !== signature
  )
    return null;
  try {
    const raw = atob(
      payload.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - (payload.length % 4)) % 4),
    );
    const value = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(raw, (character) => character.charCodeAt(0)),
      ),
    ) as { binding?: string; cursor?: string };
    return value.binding === (await cursorBinding(input, operation, sort)) &&
      typeof value.cursor === "string"
      ? value.cursor
      : null;
  } catch {
    return null;
  }
}

async function encodeCursor(
  input: JourneySearchInput,
  operation: "visitors" | "sessions",
  sort: unknown,
  cursor: string,
): Promise<string> {
  const secret = rootSecret(input.env);
  if (!secret) throw new Error("data-unavailable");
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        binding: await cursorBinding(input, operation, sort),
        cursor,
      }),
    ),
  );
  return `${payload}.${await sign(secret, payload)}`;
}

export async function readSiteVisitorDetail(
  input: JourneyDetailInput & { readonly visitorId: string },
) {
  const result = await queryVisitorDetailFromD1(
    input.env,
    input.siteId,
    input.visitorId,
    input.window.timeZone,
    input.window,
  );
  if (!result) throw new Error("resource-not-found");
  return stripVisitorDetailCollections(result);
}

export async function readSiteSessionDetail(
  input: JourneyDetailInput & { readonly sessionId: string },
) {
  const result = await querySessionDetailFromD1(
    input.env,
    input.siteId,
    input.sessionId,
    input.window,
  );
  if (!result) throw new Error("resource-not-found");
  return stripSessionDetailCollections(result);
}

export async function readSiteJourneyEventDetail(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly eventId: string;
  readonly eventKind?: "pageview" | "session_start" | "leave";
}) {
  const result = await queryJourneyEventDetailFromD1(
    input.env,
    input.siteId,
    input.eventId,
    input.window,
    input.eventKind,
  );
  if (!result) throw new Error("resource-not-found");
  return result;
}

export async function readSiteVisitors(
  input: JourneySearchInput & {
    readonly sort: {
      readonly field: "firstSeenAt" | "lastSeenAt" | "sessions" | "views";
      readonly direction: "asc" | "desc";
    };
  },
) {
  if (!rootSecret(input.env)) throw new Error("data-unavailable");
  const sort = {
    key: input.sort.field,
    direction: input.sort.direction,
  } as const;
  const rawCursor = await decodeCursor(input, "visitors", input.sort);
  const cursor = rawCursor ? parseVisitorListCursor(rawCursor, sort) : null;
  if (input.page.cursor && !cursor) throw new Error("invalid-cursor");
  const page = await queryVisitorListPageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    { pageSize: input.page.limit, sort, search: input.search, cursor },
  );
  return {
    items: mapVisitors(page.rows),
    page: {
      limit: input.page.limit,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor
        ? await encodeCursor(
            input,
            "visitors",
            input.sort,
            serializeVisitorListCursor(page.nextCursor),
          )
        : null,
    },
  };
}

export async function readSiteSessions(
  input: JourneySearchInput & {
    readonly sort: {
      readonly field: "startedAt" | "durationMs" | "views";
      readonly direction: "asc" | "desc";
    };
  },
) {
  if (!rootSecret(input.env)) throw new Error("data-unavailable");
  const sort = {
    key: input.sort.field,
    direction: input.sort.direction,
  } as const;
  const rawCursor = await decodeCursor(input, "sessions", input.sort);
  const cursor = rawCursor ? parseSessionListCursor(rawCursor, sort) : null;
  if (input.page.cursor && !cursor) throw new Error("invalid-cursor");
  const page = await querySessionListPageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    { pageSize: input.page.limit, sort, search: input.search, cursor },
  );
  return {
    items: page.rows,
    page: {
      limit: input.page.limit,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor
        ? await encodeCursor(
            input,
            "sessions",
            input.sort,
            serializeSessionListCursor(page.nextCursor),
          )
        : null,
    },
  };
}

interface JourneyTrajectoryInput extends JourneySearchInput {
  readonly limit?: number;
}

function trajectoryBinding(
  input: JourneyTrajectoryInput,
  operation: "visitor-events" | "visitor-sessions" | "session-events",
  target: string,
): Promise<string> {
  return paginationBinding([
    `analytics-${operation}-v1`,
    input.audience ?? "private-dashboard",
    input.siteId,
    target,
    input.window.startMs,
    input.window.endExclusiveMs,
    input.window.timeZone,
    filterFingerprint(input.filters, analyticsFilterRegistry),
    input.search ?? "",
  ]);
}

interface TrajectoryCursor {
  readonly occurredAt: number;
  readonly id: string;
}

async function readTrajectoryCursor<T>(
  input: JourneyTrajectoryInput,
  operation: "visitor-events" | "visitor-sessions" | "session-events",
  target: string,
): Promise<T | null> {
  return decodePageCursor<T>(
    input.env,
    await trajectoryBinding(input, operation, target),
    input.page.cursor,
  );
}

async function writeTrajectoryCursor(
  input: JourneyTrajectoryInput,
  operation: "visitor-events" | "visitor-sessions" | "session-events",
  target: string,
  cursor: unknown,
): Promise<string | null> {
  return cursor
    ? encodePageCursor(
        input.env,
        await trajectoryBinding(input, operation, target),
        cursor,
      )
    : null;
}

async function assertJourneyTargetInWindow(
  input: JourneyTrajectoryInput,
  target: { readonly type: "visitor" | "session"; readonly value: string },
) {
  if (
    !(await queryJourneyTargetExistsFromD1(
      input.env,
      input.siteId,
      target,
      input.window,
    ))
  ) {
    throw new Error("resource-not-found");
  }
}

async function readJourneyEvents(
  input: JourneyTrajectoryInput,
  target: { readonly type: "visitor" | "session"; readonly value: string },
) {
  await assertJourneyTargetInWindow(input, target);
  const operation =
    target.type === "visitor" ? "visitor-events" : "session-events";
  const cursor = await readTrajectoryCursor<TrajectoryCursor>(
    input,
    operation,
    target.value,
  );
  if (input.page.cursor && !cursor) throw new Error("invalid-cursor");
  const page = await queryJourneyEventsPageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    target,
    input.page.limit,
    cursor,
  );
  return {
    items: page.items,
    pagination: {
      ...page.pagination,
      nextCursor: await writeTrajectoryCursor(
        input,
        operation,
        target.value,
        page.pagination.nextCursor,
      ),
    },
  };
}

export function readSiteVisitorEvents(
  input: JourneyTrajectoryInput & { readonly visitorId: string },
) {
  return readJourneyEvents(input, { type: "visitor", value: input.visitorId });
}

export function readSiteSessionEvents(
  input: JourneyTrajectoryInput & { readonly sessionId: string },
) {
  return readJourneyEvents(input, { type: "session", value: input.sessionId });
}

export async function readSiteVisitorSessions(
  input: JourneyTrajectoryInput & { readonly visitorId: string },
) {
  const target = { type: "visitor" as const, value: input.visitorId };
  await assertJourneyTargetInWindow(input, target);
  const sort = { key: "startedAt", direction: "desc" } as const;
  const rawCursor = await readTrajectoryCursor<SessionListCursor>(
    input,
    "visitor-sessions",
    target.value,
  );
  const cursor = rawCursor
    ? parseSessionListCursor(serializeSessionListCursor(rawCursor), sort)
    : null;
  if (input.page.cursor && !cursor) throw new Error("invalid-cursor");
  const page = await querySessionListPageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    { pageSize: input.page.limit, sort, cursor, target },
  );
  return {
    items: page.rows,
    pagination: {
      limit: input.page.limit,
      returned: page.rows.length,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor
        ? await writeTrajectoryCursor(
            input,
            "visitor-sessions",
            target.value,
            page.nextCursor,
          )
        : null,
    },
  };
}
