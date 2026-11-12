import "@tanstack/react-start/server-only";

import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  type FilterDocument,
  filterFingerprint,
  type QueryAudience,
} from "@/lib/edge/analytics/contract";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import { scopedFilterMetadata } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import {
  type DeferredEventRecordsQualification,
  isDeferredEventQualification,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { mapEventRecord } from "@/lib/edge/analytics/providers/d1/internal/core-mappers";
import type { D1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  type EventRecordCursor,
  queryEventRecordDetailFromD1,
  queryEventRecordPageFromD1,
  queryEventRecordPageWithMembershipFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-records";
import { queryQualifiedEventRecordPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-records";
import type { Env } from "@/lib/edge/types";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  InvalidCursorError,
  type PageResult,
  paginationBindingForWindow,
} from "@/lib/pagination";

export interface ReadSiteEventRecordsInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly queryTime?: QueryTime;
  readonly search?: string;
  readonly eventName?: string;
  readonly sort: {
    readonly field: "occurredAt" | "eventName" | "pathname";
    readonly direction: "asc" | "desc";
  };
  readonly audience?: QueryAudience;
  readonly deferredQualification?: DeferredEventRecordsQualification;
  readonly diagnostics?: D1ReadDiagnostics;
  readonly page: { readonly limit: number; readonly cursor?: string | null };
}

async function cursorBinding(
  input: ReadSiteEventRecordsInput,
): Promise<string> {
  const eventName = input.eventName?.trim() || null;
  return paginationBindingForWindow(input.window, [
    "event-records-v1",
    input.audience ?? "private-dashboard",
    input.siteId,
    input.window.startMs,
    input.window.endExclusiveMs,
    input.window.timeZone,
    filterFingerprint(input.filters, analyticsFilterRegistry),
    effectiveScopeForPagination(input.filters),
    input.search?.trim().toLowerCase() ?? null,
    eventName,
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
  const search = input.search?.trim() || undefined;
  const eventName = input.eventName?.trim() || undefined;
  const normalizedInput = { ...input, search, eventName };
  const sort = {
    key: input.sort.field,
    direction: input.sort.direction,
  } as const;
  const deferred = input.deferredQualification;
  if (deferred) {
    const prepared = deferred.eventRecordsRequest;
    if (
      !isDeferredEventQualification(deferred) ||
      deferred.operation !== "event-records" ||
      !prepared ||
      deferred.env !== input.env ||
      deferred.siteId !== input.siteId ||
      deferred.filters !== input.filters ||
      deferred.requestTime !== input.queryTime ||
      deferred.requestScopePlan !== input.scopePlan ||
      deferred.time.range.startMs !== input.window.startMs ||
      deferred.time.range.endExclusiveMs !== input.window.endExclusiveMs ||
      deferred.time.reportingTimeZone !== input.window.timeZone ||
      prepared.search !== search ||
      prepared.eventName !== eventName ||
      prepared.sort.field !== input.sort.field ||
      prepared.sort.direction !== input.sort.direction ||
      prepared.page.limit !== input.page.limit ||
      prepared.page.cursor !== (input.page.cursor ?? null) ||
      prepared.audience !== (input.audience ?? "private-dashboard")
    )
      throw new Error("event_records_deferred_request_binding_mismatch");
  }
  let cursor: EventRecordCursor | null;
  try {
    cursor = await decodeCursor(normalizedInput);
  } catch (error) {
    if (deferred && error instanceof InvalidCursorError) {
      // Keep legacy cap-before-cursor precedence for malformed or stale cursors.
      // SEM088 remains open for this invalid-cursor-only preparation bridge.
      await prepareDeferredEventQualificationFallback(deferred);
    }
    throw error;
  }

  let page;
  if (deferred) {
    const execution = await queryQualifiedEventRecordPageFromD1({
      env: input.env,
      deferred,
      options: {
        limit: input.page.limit,
        sort,
        search,
        eventName,
        cursor,
      },
      cursorToken: input.page.cursor ?? null,
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    });
    if (execution.kind === "executed") {
      page = execution.page;
    } else {
      if (input.diagnostics)
        input.diagnostics.advancedCountSqlFallbackReason =
          execution.fallbackReason;
      page = await queryEventRecordPageWithMembershipFromD1({
        env: input.env,
        siteId: input.siteId,
        deferred,
        options: { limit: input.page.limit, sort, search, eventName, cursor },
        cursorToken: input.page.cursor ?? null,
        audience: input.audience ?? "private-dashboard",
      });
      if (!page) {
        const fallbackFilters =
          await prepareDeferredEventQualificationFallback(deferred);
        page = await queryEventRecordPageFromD1(
          input.env,
          input.siteId,
          input.window,
          fallbackFilters,
          {
            limit: input.page.limit,
            sort,
            search,
            eventName,
            cursor,
            scopePlan: scopedFilterMetadata(fallbackFilters)?.plan,
            queryTime: input.queryTime ?? deferred.time,
          },
        );
      }
    }
  } else {
    page = await queryEventRecordPageFromD1(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      {
        limit: input.page.limit,
        sort,
        search,
        eventName,
        cursor,
        scopePlan: input.scopePlan,
        queryTime: input.queryTime,
      },
    );
  }
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
