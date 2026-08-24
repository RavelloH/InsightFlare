import "@tanstack/react-start/server-only";

import type { QueryWindow } from "@/lib/edge/query/core";
import { mapVisitors } from "@/lib/edge/query/core-mappers";
import {
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
} from "@/lib/edge/query/journey-detail-queries";
import {
  parseSessionListCursor,
  parseVisitorListCursor,
  queryJourneyEventsFromD1,
  queryJourneyTargetExistsFromD1,
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  serializeSessionListCursor,
  serializeVisitorListCursor,
} from "@/lib/edge/query/journey-list-queries";
import {
  analyticsFilterRegistry,
  assertFilterAudience,
  executeTypedApplicationOperation,
  type FilterDocument,
  filterFingerprint,
  siteQueryContext,
  validateTypedQueryFilters,
} from "@/lib/edge/query-contract";
import { createQueryTime } from "@/lib/edge/query-contract/helpers";
import type { Env } from "@/lib/edge/types";
import { sha256Hex } from "@/lib/edge/utils";
import { rootSecret } from "@/lib/secrets";

interface JourneyDetailInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
}

function base(input: JourneyDetailInput) {
  return {
    context: siteQueryContext(input.siteId, "api-v1"),
    time: createQueryTime(
      input.window.startMs,
      input.window.endExclusiveMs,
      input.window.timeZone,
      input.window.nowMs,
    ),
    filters: { version: 1 as const, root: null },
  };
}

interface JourneySearchInput extends JourneyDetailInput {
  readonly filters: FilterDocument;
  readonly search?: string;
  readonly page: { readonly limit: number; readonly cursor?: string | null };
}

function searchBase(input: JourneySearchInput) {
  const context = siteQueryContext(input.siteId, "api-v1");
  const filterError = validateTypedQueryFilters(context, input.filters);
  if (filterError) throw new Error(filterError.kind);
  try {
    assertFilterAudience(
      input.filters,
      analyticsFilterRegistry,
      context.policy.audience,
    );
  } catch {
    throw new Error("invalid-input");
  }
  return {
    context,
    time: createQueryTime(
      input.window.startMs,
      input.window.endExclusiveMs,
      input.window.timeZone,
      input.window.nowMs,
    ),
    filters: input.filters,
  };
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
  const result = await executeTypedApplicationOperation(
    "visitor-detail",
    base(input),
    async () => ({
      value: await queryVisitorDetailFromD1(
        input.env,
        input.siteId,
        input.visitorId,
        input.window.timeZone,
        input.window,
      ),
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  if (!result.data) throw new Error("resource-not-found");
  return result.data;
}

export async function readSiteSessionDetail(
  input: JourneyDetailInput & { readonly sessionId: string },
) {
  const result = await executeTypedApplicationOperation(
    "session-detail",
    base(input),
    async () => ({
      value: await querySessionDetailFromD1(
        input.env,
        input.siteId,
        input.sessionId,
        input.window,
      ),
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  if (!result.data) throw new Error("resource-not-found");
  return result.data;
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
  const result = await executeTypedApplicationOperation(
    "visitors",
    searchBase(input),
    async () => {
      const page = await queryVisitorListPageFromD1(
        input.env,
        input.siteId,
        input.window,
        input.filters,
        { pageSize: input.page.limit, sort, search: input.search, cursor },
      );
      return {
        value: {
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
        },
      };
    },
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
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
  const result = await executeTypedApplicationOperation(
    "sessions",
    searchBase(input),
    async () => {
      const page = await querySessionListPageFromD1(
        input.env,
        input.siteId,
        input.window,
        input.filters,
        { pageSize: input.page.limit, sort, search: input.search, cursor },
      );
      return {
        value: {
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
        },
      };
    },
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}

interface JourneyTrajectoryInput extends JourneySearchInput {
  readonly limit: number;
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
  const query = searchBase(input);
  await assertJourneyTargetInWindow(input, target);
  const result = await executeTypedApplicationOperation(
    "event-records",
    query,
    async () => ({
      value: {
        items: await queryJourneyEventsFromD1(
          input.env,
          input.siteId,
          input.window,
          input.filters,
          target,
          input.limit,
        ),
      },
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
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
  const query = searchBase(input);
  await assertJourneyTargetInWindow(input, target);
  const result = await executeTypedApplicationOperation(
    "sessions",
    query,
    async () => ({
      value: {
        items: await querySessionsFromD1(
          input.env,
          input.siteId,
          input.window,
          input.filters,
          input.limit,
          target,
        ),
      },
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}
