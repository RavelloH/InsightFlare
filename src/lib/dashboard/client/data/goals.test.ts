import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPrivateJson: vi.fn(),
  fetchPrivateJsonMutate: vi.fn(),
}));

vi.mock("@/lib/dashboard/client/request", () => ({
  fetchPrivateJson: mocks.fetchPrivateJson,
  fetchPrivateJsonMutate: mocks.fetchPrivateJsonMutate,
}));

import { EMPTY_DASHBOARD_FILTER_DOCUMENT } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";

import {
  createGoal,
  deleteGoal,
  fetchGoalDefinition,
  fetchGoals,
  fetchGoalSummary,
  fetchGoalTimeseries,
  updateGoal,
} from "./goals";

const window: TimeWindow = {
  preset: "custom",
  from: 1_000,
  to: 2_000,
  interval: "hour",
  timeZone: "UTC",
};

beforeEach(() => {
  mocks.fetchPrivateJson.mockReset().mockResolvedValue({ ok: true });
  mocks.fetchPrivateJsonMutate.mockReset().mockResolvedValue({ ok: true });
});

describe("goal data client helpers", () => {
  it("fetches goal lists and individual definitions with optional paging", async () => {
    const controller = new AbortController();
    await fetchGoals("site-1");
    expect(mocks.fetchPrivateJson).toHaveBeenNthCalledWith(
      1,
      "/api/private/goals",
      expect.objectContaining({ siteId: "site-1", limit: 100 }),
      { signal: undefined },
    );
    await fetchGoals("site-2", {
      limit: 25,
      cursor: "next",
      signal: controller.signal,
    });
    expect(mocks.fetchPrivateJson).toHaveBeenNthCalledWith(
      2,
      "/api/private/goals",
      expect.objectContaining({ siteId: "site-2", limit: 25, cursor: "next" }),
      { signal: controller.signal },
    );
    await fetchGoalDefinition("site-1", "  goal-1  ", {
      signal: controller.signal,
    });
    expect(mocks.fetchPrivateJson).toHaveBeenLastCalledWith(
      "/api/private/goals",
      { siteId: "site-1", id: "goal-1" },
      { signal: controller.signal, dedupe: false },
    );
  });

  it("includes optional filters and semantic fingerprints in analytics requests", async () => {
    await fetchGoalSummary("site-1", " goal-1 ", window);
    expect(mocks.fetchPrivateJson).toHaveBeenLastCalledWith(
      "/api/private/goal-summary",
      expect.objectContaining({
        siteId: "site-1",
        id: "goal-1",
        from: 1_000,
        to: 2_000,
        timeZone: "UTC",
      }),
      { dedupe: false, signal: undefined },
    );
    await fetchGoalSummary(
      "site-1",
      "goal-2",
      window,
      EMPTY_DASHBOARD_FILTER_DOCUMENT,
      {
        signal: new AbortController().signal,
        goalSemanticFingerprint: "fingerprint",
      },
    );
    expect(mocks.fetchPrivateJson).toHaveBeenLastCalledWith(
      "/api/private/goal-summary",
      expect.objectContaining({ goalFingerprint: "fingerprint" }),
      expect.objectContaining({
        dedupe: false,
        signal: expect.any(AbortSignal),
      }),
    );

    await fetchGoalTimeseries("site-1", "goal-3", window);
    expect(mocks.fetchPrivateJson).toHaveBeenLastCalledWith(
      "/api/private/goal-timeseries",
      expect.objectContaining({ interval: "hour", id: "goal-3" }),
      { dedupe: false, signal: undefined },
    );
    await fetchGoalTimeseries("site-1", "goal-4", window, undefined, {
      goalSemanticFingerprint: "series-fingerprint",
    });
    expect(mocks.fetchPrivateJson).toHaveBeenLastCalledWith(
      "/api/private/goal-timeseries",
      expect.objectContaining({ goalFingerprint: "series-fingerprint" }),
      { dedupe: false, signal: undefined },
    );
  });

  it("sends create, update, and delete mutations with the correct method payloads", async () => {
    await createGoal("site-1", {
      name: "Purchase",
      filterDsl: "event.name eq Purchase",
    });
    expect(mocks.fetchPrivateJsonMutate).toHaveBeenLastCalledWith(
      "/api/private/goals",
      "POST",
      { siteId: "site-1" },
      {
        name: "Purchase",
        filterDslVersion: 1,
        filterDsl: "event.name eq Purchase",
      },
    );
    await updateGoal("site-1", "goal-1", { name: "Renamed" });
    expect(mocks.fetchPrivateJsonMutate).toHaveBeenLastCalledWith(
      "/api/private/goals",
      "PATCH",
      { siteId: "site-1", id: "goal-1" },
      { name: "Renamed" },
    );
    await updateGoal("site-1", "goal-1", { filterDsl: "page.path eq /" });
    expect(mocks.fetchPrivateJsonMutate).toHaveBeenLastCalledWith(
      "/api/private/goals",
      "PATCH",
      { siteId: "site-1", id: "goal-1" },
      { filterDsl: "page.path eq /", filterDslVersion: 1 },
    );
    await deleteGoal("site-1", "goal-1");
    expect(mocks.fetchPrivateJsonMutate).toHaveBeenLastCalledWith(
      "/api/private/goals",
      "DELETE",
      { siteId: "site-1", id: "goal-1" },
    );
  });
});
