import "@tanstack/react-start/server-only";

import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  type FilterDocument,
  filterFingerprint,
  type QueryAudience,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { mapEventRecord } from "@/lib/edge/analytics/providers/d1/internal/core-mappers";
import {
  type EventRecordCursor,
  queryEventRecordDetailFromD1,
  queryEventRecordPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-records";
import type { Env } from "@/lib/edge/types";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  type PageResult,
  paginationBinding,
} from "@/lib/pagination";

export interface ReadSiteEventRecordsInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly search?: string;
  readonly eventName?: string;
  readonly sort: {
    readonly field: "occurredAt" | "eventName" | "pathname";
    readonly direction: "asc" | "desc";
  };
  readonly audience?: QueryAudience;
  readonly page: { readonly limit: number; readonly cursor?: string | null };
}

async function cursorBinding(
  input: ReadSiteEventRecordsInput,
): Promise<string> {
  return paginationBinding([
    "event-records-v1",
    input.audience ?? "private-dashboard",
    input.siteId,
    input.window.startMs,
    input.window.endExclusiveMs,
    input.window.timeZone,
    filterFingerprint(input.filters, analyticsFilterRegistry),
    effectiveScopeForPagination(input.filters),
    input.search?.trim().toLowerCase() ?? null,
    input.eventName?.trim() ?? null,
    input.sort,
  ]);
}

function decodeEventRecordCursor(
  value: unknown,
  sort: ReadSiteEventRecordsInput["sort"],
): EventRecordCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const expectedKeys =
    sort.field === "occurredAt"
      ? ["occurredAt", "eventId", "eventPk"]
      : ["sortValue", "occurredAt", "eventId", "eventPk"];
  if (
    !hasExactKeys(candidate, expectedKeys) ||
    (sort.field !== "occurredAt" &&
      typeof candidate.sortValue !== "string" &&
      typeof candidate.sortValue !== "number") ||
    typeof candidate.occurredAt !== "number" ||
    !Number.isFinite(candidate.occurredAt) ||
    typeof candidate.eventId !== "string" ||
    typeof candidate.eventPk !== "number" ||
    !Number.isSafeInteger(candidate.eventPk) ||
    candidate.eventPk < 0
  ) {
    return null;
  }
  return {
    ...(sort.field === "occurredAt"
      ? {}
      : { sortValue: candidate.sortValue as string | number }),
    occurredAt: candidate.occurredAt as number,
    eventId: candidate.eventId,
    eventPk: candidate.eventPk as number,
  };
}

async function decodeCursor(
  input: ReadSiteEventRecordsInput,
): Promise<EventRecordCursor | null> {
  return decodePageCursor(
    input.env,
    await cursorBinding(input),
    input.page.cursor,
    "event-records",
    (value) => decodeEventRecordCursor(value, input.sort),
  );
}

export async function readSiteEventRecords(input: ReadSiteEventRecordsInput) {
  const sort = {
    key: input.sort.field,
    direction: input.sort.direction,
  } as const;
  const cursor = await decodeCursor(input);
  const page = await queryEventRecordPageFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    {
      limit: input.page.limit,
      sort,
      search: input.search,
      eventName: input.eventName,
      cursor,
    },
  );
  return {
    items: page.rows.map(mapEventRecord),
    pagination: {
      limit: input.page.limit,
      hasMore: page.nextCursor !== null,
      nextCursor: page.nextCursor
        ? await encodePageCursor(
            input.env,
            await cursorBinding(input),
            page.nextCursor,
          )
        : null,
      returned: page.rows.length,
    },
  } satisfies PageResult<ReturnType<typeof mapEventRecord>>;
}

export async function readSiteEventDetail(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly eventId: string;
}) {
  const result = await queryEventRecordDetailFromD1(
    input.env,
    input.siteId,
    input.eventId,
    input.window,
  );
  if (!result) throw new Error("resource-not-found");
  return result;
}
