import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/events-records", () => ({
  parseEventRecordCursor: vi.fn(),
  queryEventRecordDetailFromD1: vi.fn(),
  queryEventRecordPageFromD1: vi.fn(),
  serializeEventRecordCursor: vi.fn(),
}));

import {
  parseEventRecordCursor,
  queryEventRecordDetailFromD1,
  queryEventRecordPageFromD1,
  serializeEventRecordCursor,
} from "@/lib/edge/analytics/providers/d1/internal/events-records";
import {
  readSiteEventDetail,
  readSiteEventRecords,
} from "@/lib/edge/analytics/providers/d1/operations/site-event-records";

const base = {
  env: { MAIN_SECRET: "cursor-secret" } as never,
  siteId: "site-1",
  window: { startMs: 0, endExclusiveMs: 100, nowMs: 100, timeZone: "UTC" },
  filters: { version: 1 as const, root: null },
};

describe("site event-record runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses signed cursors and binds records to the typed query", async () => {
    vi.mocked(queryEventRecordPageFromD1).mockResolvedValue({
      rows: [],
      nextCursor: {
        sortKey: "occurredAt",
        sortDirection: "desc",
        sortValue: 1,
        occurredAt: 1,
        eventId: "evt",
        eventPk: 1,
      },
    });
    vi.mocked(serializeEventRecordCursor).mockReturnValue("inner-cursor");
    const result = await readSiteEventRecords({
      ...base,
      sort: { field: "occurredAt", direction: "desc" },
      page: { limit: 20 },
    });
    expect(result.page).toMatchObject({
      limit: 20,
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(queryEventRecordPageFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      base.window,
      base.filters,
      expect.objectContaining({ pageSize: 20, cursor: null }),
    );

    const next = result.page.nextCursor;
    vi.mocked(parseEventRecordCursor).mockReturnValue({
      sortKey: "occurredAt",
      sortDirection: "desc",
      sortValue: 1,
      occurredAt: 1,
      eventId: "evt",
      eventPk: 1,
    });
    vi.mocked(queryEventRecordPageFromD1).mockResolvedValueOnce({
      rows: [],
      nextCursor: null,
    });
    await expect(
      readSiteEventRecords({
        ...base,
        sort: { field: "occurredAt", direction: "desc" },
        page: { limit: 20, cursor: next },
      }),
    ).resolves.toMatchObject({ page: { hasMore: false, nextCursor: null } });
    expect(parseEventRecordCursor).toHaveBeenCalledWith("inner-cursor", {
      key: "occurredAt",
      direction: "desc",
    });
  });

  it("rejects malformed cursors before the provider", async () => {
    await expect(
      readSiteEventRecords({
        ...base,
        sort: { field: "occurredAt", direction: "desc" },
        page: { limit: 20, cursor: "not-a-signed-cursor" },
      }),
    ).rejects.toThrow("invalid-cursor");
    expect(queryEventRecordPageFromD1).not.toHaveBeenCalled();
    expect(parseEventRecordCursor).not.toHaveBeenCalled();
  });

  it("requires a signing root and makes detail window-scoped", async () => {
    await expect(
      readSiteEventRecords({
        ...base,
        env: {} as never,
        sort: { field: "occurredAt", direction: "desc" },
        page: { limit: 20 },
      }),
    ).rejects.toThrow("data-unavailable");
    vi.mocked(queryEventRecordDetailFromD1).mockResolvedValue(null);
    await expect(
      readSiteEventDetail({ ...base, eventId: "missing" }),
    ).rejects.toThrow("resource-not-found");
    expect(queryEventRecordDetailFromD1).toHaveBeenCalledWith(
      base.env,
      "site-1",
      "missing",
      base.window,
    );
  });

  it("accepts DAILY_SALT_SECRET as the existing deployment root", async () => {
    vi.mocked(queryEventRecordPageFromD1).mockResolvedValue({
      rows: [],
      nextCursor: null,
    });

    await expect(
      readSiteEventRecords({
        ...base,
        env: { DAILY_SALT_SECRET: "legacy-root" } as never,
        sort: { field: "occurredAt", direction: "desc" },
        page: { limit: 20 },
      }),
    ).resolves.toMatchObject({ page: { hasMore: false, nextCursor: null } });
  });

  it("returns window-scoped detail and maps provider failures", async () => {
    const detail = { event: { eventId: "evt" }, context: {}, eventData: {} };
    vi.mocked(queryEventRecordDetailFromD1).mockResolvedValueOnce(
      detail as never,
    );
    await expect(
      readSiteEventDetail({ ...base, eventId: "evt" }),
    ).resolves.toEqual(detail);

    vi.mocked(queryEventRecordPageFromD1).mockRejectedValueOnce(
      new Error("down"),
    );
    await expect(
      readSiteEventRecords({
        ...base,
        sort: { field: "occurredAt", direction: "desc" },
        page: { limit: 20 },
      }),
    ).rejects.toThrow("down");
  });
});
