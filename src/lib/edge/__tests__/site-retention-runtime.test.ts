import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/journey-retention", () => ({
  parseRetentionGranularity: (value: string | null) => value ?? "week",
  queryRetentionFromD1: vi.fn(),
}));

import type { FilterFieldId } from "@/lib/edge/analytics/contract";
import { queryRetentionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import {
  readSiteRetention,
  type ReadSiteRetentionInput,
} from "@/lib/edge/analytics/providers/d1/operations/site-retention";

const input = {
  env: {} as never,
  siteId: "site-1",
  window: { startMs: 0, endExclusiveMs: 86_400_000, nowMs: 1, timeZone: "UTC" },
  filters: {
    version: 1 as const,
    root: {
      kind: "condition" as const,
      target: { kind: "field" as const, field: "page.path" as FilterFieldId },
      operator: "eq" as const,
      value: "/pricing",
    },
  },
  granularity: "week",
} satisfies ReadSiteRetentionInput;

describe("site retention runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates the typed cohort query and normalizes cohort starts", async () => {
    vi.mocked(queryRetentionFromD1).mockResolvedValue({
      granularity: "week",
      cohorts: [
        {
          bucket: 0,
          size: 10,
          periods: [{ index: 0, visitors: 10, rate: 1 }],
        },
      ],
    });
    await expect(readSiteRetention(input)).resolves.toEqual({
      granularity: "week",
      cohorts: [
        {
          start: "1970-01-01T00:00:00.000Z",
          size: 10,
          periods: [{ index: 0, visitors: 10, rate: 1 }],
        },
      ],
    });
    expect(queryRetentionFromD1).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      "week",
    );
  });

  it("rejects unauthorized filters and provider failures", async () => {
    await expect(
      readSiteRetention({
        ...input,
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "unknown.field" as FilterFieldId },
            operator: "eq",
            value: "x",
          },
        },
      }),
    ).rejects.toThrow("invalid-input");
    vi.mocked(queryRetentionFromD1).mockRejectedValueOnce(new Error("down"));
    await expect(readSiteRetention(input)).rejects.toThrow("internal");
  });
});
