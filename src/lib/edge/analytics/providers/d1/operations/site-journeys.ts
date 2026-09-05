import "@tanstack/react-start/server-only";

import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
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
  queryJourneyEventsPageFromD1,
  queryJourneyTargetExistsFromD1,
  querySessionListPageFromD1,
  queryVisitorListPageFromD1,
  type SessionListCursor,
  type VisitorListCursor,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  paginationBinding,
} from "@/lib/edge/analytics/providers/d1/internal/pagination";
import type { Env } from "@/lib/edge/types";

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

type VisitorSort = {
  readonly field: "firstSeenAt" | "lastSeenAt" | "sessions" | "views";
  readonly direction: "asc" | "desc";
};

type SessionSort = {
  readonly field: "startedAt" | "durationMs" | "views";
  readonly direction: "asc" | "desc";
};

async function cursorBinding(
  input: JourneySearchInput,
  operation: "visitors" | "sessions",
  sort: unknown,
): Promise<string> {
  return paginationBinding([
    `journey-${operation}-v1`,
    input.audience ?? "private-dashboard",
    input.siteId,
    input.window.startMs,
    input.window.endExclusiveMs,
    input.window.timeZone,
    filterFingerprint(input.filters, analyticsFilterRegistry),
    effectiveScopeForPagination(input.filters),
    input.search?.trim().toLowerCase() ?? null,
    sort,
  ]);
}

function cursorObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function visitorCursor(
  value: unknown,
  sort: VisitorSort,
): VisitorListCursor | null {
  const candidate = cursorObject(value);
  const expectedKeys =
    sort.field === "lastSeenAt"
      ? ["sortValue", "visitorId"]
      : ["sortValue", "lastSeenAt", "visitorId"];
  if (
    !candidate ||
    !hasExactKeys(candidate, expectedKeys) ||
    typeof candidate.sortValue !== "number" ||
    !Number.isFinite(candidate.sortValue) ||
    (sort.field !== "lastSeenAt" &&
      (typeof candidate.lastSeenAt !== "number" ||
        !Number.isFinite(candidate.lastSeenAt))) ||
    typeof candidate.visitorId !== "string"
  )
    return null;
  return candidate as unknown as VisitorListCursor;
}

function sessionCursor(
  value: unknown,
  sort: SessionSort,
): SessionListCursor | null {
  const candidate = cursorObject(value);
  const expectedKeys =
    sort.field === "startedAt"
      ? ["sortValue", "sessionId"]
      : ["sortValue", "startedAt", "sessionId"];
  if (
    !candidate ||
    !hasExactKeys(candidate, expectedKeys) ||
    typeof candidate.sortValue !== "number" ||
    !Number.isFinite(candidate.sortValue) ||
    (sort.field !== "startedAt" &&
      (typeof candidate.startedAt !== "number" ||
        !Number.isFinite(candidate.startedAt))) ||
    typeof candidate.sessionId !== "string"
  )
    return null;
  return candidate as unknown as SessionListCursor;
}

async function decodeCursor(
  input: JourneySearchInput,
  operation: "visitors" | "sessions",
  sort: unknown,
): Promise<VisitorListCursor | SessionListCursor | null> {
  return decodePageCursor(
    input.env,
    await cursorBinding(input, operation, sort),
    input.page.cursor,
    `journey-${operation}`,
    (value) =>
      operation === "visitors"
        ? visitorCursor(value, sort as VisitorSort)
        : sessionCursor(value, sort as SessionSort),
  );
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
  const sort = {
    key: input.sort.field,
    direction: input.sort.direction,
  } as const;
  const cursor = (await decodeCursor(
    input,
    "visitors",
    input.sort,
  )) as VisitorListCursor | null;
  const page = await queryVisitorListPageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    { limit: input.page.limit, sort, search: input.search, cursor },
  );
  return {
    items: mapVisitors(page.rows),
    pagination: {
      limit: input.page.limit,
      returned: page.rows.length,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor
        ? await encodePageCursor(
            input.env,
            await cursorBinding(input, "visitors", input.sort),
            page.nextCursor,
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
  const sort = {
    key: input.sort.field,
    direction: input.sort.direction,
  } as const;
  const cursor = (await decodeCursor(
    input,
    "sessions",
    input.sort,
  )) as SessionListCursor | null;
  const page = await querySessionListPageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    { limit: input.page.limit, sort, search: input.search, cursor },
  );
  return {
    items: page.rows,
    pagination: {
      limit: input.page.limit,
      returned: page.rows.length,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor
        ? await encodePageCursor(
            input.env,
            await cursorBinding(input, "sessions", input.sort),
            page.nextCursor,
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
    effectiveScopeForPagination(input.filters),
    input.search?.trim().toLowerCase() ?? "",
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
    operation,
    (value) => {
      const candidate = cursorObject(value);
      return candidate &&
        hasExactKeys(candidate, ["occurredAt", "id"]) &&
        typeof candidate.occurredAt === "number" &&
        Number.isFinite(candidate.occurredAt) &&
        typeof candidate.id === "string"
        ? (candidate as T)
        : null;
    },
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
  const cursor = await readTrajectoryCursor<SessionListCursor>(
    input,
    "visitor-sessions",
    target.value,
  );
  const typedCursor = cursor as SessionListCursor | null;
  const page = await querySessionListPageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    { limit: input.page.limit, sort, cursor: typedCursor, target },
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
