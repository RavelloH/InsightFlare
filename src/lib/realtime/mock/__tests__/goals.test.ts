import { describe, expect, it } from "vitest";

import type {
  GoalListData,
  GoalMutationData,
  GoalSummaryData,
  GoalTimeseriesData,
} from "@/lib/edge-client";
import { handleDemoRequest } from "@/lib/realtime/mock";
import {
  createDemoGoal,
  deleteDemoGoal,
  generateDemoGoals,
  updateDemoGoal,
} from "@/lib/realtime/mock/goals";

describe("Goal demo provider", () => {
  it("ships six goal fixtures with range-consistent bucket uniques", () => {
    const list = generateDemoGoals("demo-site-001", {}) as GoalListData;
    expect(list.data.items).toHaveLength(6);
    expect(list.data.items.map((goal) => goal.id)).toEqual(
      expect.arrayContaining([
        "demo-goal-signup",
        "demo-goal-purchase",
        "demo-goal-payload",
      ]),
    );

    const summary = generateDemoGoals("demo-site-001", {
      id: "demo-goal-purchase",
    }) as GoalSummaryData;
    const trend = generateDemoGoals("demo-site-001", {
      id: "demo-goal-purchase",
      operation: "goal-timeseries",
      from: 1_000,
      to: 7 * 86_400_000 + 1_000,
      interval: "day",
    }) as GoalTimeseriesData;
    expect(summary.data.summary.sessions).toBeDefined();
    expect(summary.data.summary.visitors).toBeDefined();
    expect(
      trend.data.timeseries.reduce(
        (total, point) => total + point.sessions.converted,
        0,
      ),
    ).toBe(summary.data.summary.sessions.converted);
    expect(
      trend.data.timeseries.reduce(
        (total, point) => total + point.visitors.converted,
        0,
      ),
    ).toBe(summary.data.summary.visitors.converted);
    expect(
      trend.data.timeseries.every(
        (point) =>
          point.sessions.converted <= point.sessions.total &&
          point.visitors.converted <= point.visitors.total,
      ),
    ).toBe(true);
  });

  it("preserves raw DSL and validates create/update/delete mutations", () => {
    const rawDsl = '  event.name eq "purchase"  ';
    const created = createDemoGoal("demo-site-001", {
      name: "Raw purchase",
      filterDsl: rawDsl,
    }) as GoalMutationData;
    expect(created.data.goal.filterDsl).toBe(rawDsl);

    const updated = updateDemoGoal(
      "demo-site-001",
      { id: created.data.goal.id },
      { filterDsl: 'event.name eq "signup_completed"' },
    ) as GoalMutationData;
    expect(updated.data.goal.filterDsl).toBe(
      'event.name eq "signup_completed"',
    );
    expect(updated.data.goal.semanticFingerprint).not.toBe(
      created.data.goal.semanticFingerprint,
    );
    expect(
      createDemoGoal("demo-site-001", {
        name: "Invalid",
        filterDsl: "not a filter",
      }),
    ).toMatchObject({ ok: false });
    expect(
      deleteDemoGoal("demo-site-001", { id: created.data.goal.id }),
    ).toEqual({
      ok: true,
    });
  });

  it("routes API v1 Goal analytics POSTs to analytics fixtures instead of CRUD", () => {
    const response = handleDemoRequest({
      path: "/api/v1/sites/demo-site-001/analytics/goals/summary",
      method: "POST",
      body: {
        filter: null,
        goalId: "demo-goal-purchase",
        scope: "auto",
        timeRange: {
          from: "2026-08-01T00:00:00.000Z",
          kind: "absolute",
          timeZone: "UTC",
          to: "2026-08-02T00:00:00.000Z",
        },
      },
    }) as GoalSummaryData & { ok: boolean };

    expect(response.ok).toBe(true);
    expect(response.data.summary.visitors).toBeDefined();
  });

  it("covers payload, default, and interval fallback fixtures", () => {
    const payloadSummary = generateDemoGoals("demo-site-001", {
      id: "demo-goal-payload",
    }) as GoalSummaryData;
    const defaultSummary = generateDemoGoals("demo-site-001", {
      id: "demo-goal-signup",
    }) as GoalSummaryData;
    expect(payloadSummary.data.summary.sessions.converted).toBe(280);
    expect(defaultSummary.data.summary.sessions.total).toBe(3_180);

    const hourly = generateDemoGoals("demo-site-001", {
      id: "demo-goal-signup",
      operation: "goal-timeseries",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-01T03:00:00.000Z",
      interval: "hour",
    }) as GoalTimeseriesData;
    expect(hourly.data.interval).toBe("hour");

    const fallbackInterval = generateDemoGoals("demo-site-001", {
      id: "demo-goal-signup",
      operation: "goal-timeseries",
      from: "not-a-date",
      to: "not-a-date",
      interval: "quarter",
    }) as GoalTimeseriesData;
    expect(fallbackInterval.data.interval).toBe("day");

    const defaultInterval = generateDemoGoals("demo-site-001", {
      id: "demo-goal-signup",
      operation: "goal-timeseries",
      from: "1000",
      to: "2000",
    }) as GoalTimeseriesData;
    expect(defaultInterval.data.interval).toBe("day");
  });

  it("returns demo errors for unknown resources and validates all mutation inputs", () => {
    expect(generateDemoGoals("other-site", {})).toMatchObject({
      ok: true,
      data: { items: expect.any(Array) },
    });
    expect(
      generateDemoGoals("demo-site-001", { id: "missing-goal" }),
    ).toMatchObject({ ok: false });

    for (const invalid of [
      null,
      {},
      { name: 42, filterDsl: 'event.name eq "purchase"' },
      { name: "Missing filter" },
    ]) {
      expect(createDemoGoal("demo-site-001", invalid)).toMatchObject({
        ok: false,
      });
    }

    const created = createDemoGoal("demo-site-001", {
      name: "Mutation target",
      filterDsl: 'event.name eq "purchase"',
    }) as GoalMutationData;
    const id = created.data.goal.id;
    expect(updateDemoGoal("demo-site-001", { id }, null)).toMatchObject({
      ok: true,
    });
    expect(
      updateDemoGoal("demo-site-001", { id }, { name: "", filterDsl: "" }),
    ).toMatchObject({ ok: false });
    expect(
      updateDemoGoal("demo-site-001", { id: "missing-goal" }, {}),
    ).toMatchObject({ ok: false });
    expect(deleteDemoGoal("other-site", { id })).toEqual({ ok: true });
    expect(deleteDemoGoal("demo-site-001", {})).toEqual({ ok: true });
    expect(deleteDemoGoal("demo-site-001", { id })).toEqual({ ok: true });
  });
});
