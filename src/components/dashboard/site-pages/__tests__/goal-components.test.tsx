import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dashboard/client-data", () => ({
  fetchGoalDefinition: vi.fn(),
  fetchGoalSummary: vi.fn(),
  fetchGoalTimeseries: vi.fn(),
}));

vi.mock("@/components/dashboard/filter-editor", () => ({
  FilterEditor: (props: {
    audience: string;
    initialFilterDsl: string;
    onApply?: (filterDsl: string, conditionCount: number) => void;
    resolvedScope?: string;
  }) =>
    createElement(
      "div",
      {
        "data-audience": props.audience,
        "data-initial-filter-dsl": props.initialFilterDsl,
        "data-resolved-scope": props.resolvedScope,
      },
      createElement(
        "button",
        {
          type: "button",
          onClick: () => props.onApply?.(props.initialFilterDsl, 1),
        },
        "Apply mocked filter",
      ),
    ),
}));

import {
  GoalCard,
  goalSummaryQueryKey,
} from "@/components/dashboard/site-pages/goal-card";
import {
  GoalDetail,
  goalTimeseriesQueryKey,
} from "@/components/dashboard/site-pages/goal-detail";
import { GoalEditor } from "@/components/dashboard/site-pages/goal-editor";
import {
  fetchGoalSummary,
  fetchGoalTimeseries,
} from "@/lib/dashboard/client-data";
import type {
  GoalDefinition,
  GoalSummaryData,
  GoalTimeseriesData,
} from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import { getMessages } from "@/lib/i18n/messages";

const messages = getMessages("en");
const labels = messages.goals;
const filters: FilterDocument = { version: 1, root: null };
const window = {
  preset: "7d" as const,
  from: 1_000,
  to: 10_000,
  interval: "day" as const,
  timeZone: "UTC",
};
const goal: GoalDefinition = {
  id: "goal-1",
  siteId: "site-1",
  name: "Purchase completed",
  filterDslVersion: 1,
  filterDsl: 'event.name eq "purchase"',
  semanticFingerprint: "goal-v1-purchase",
  createdAt: 1,
  updatedAt: 2,
};
const summary: GoalSummaryData = {
  ok: true,
  data: {
    goal,
    summary: {
      sessions: { total: 10, converted: 2, conversionRate: 0.2 },
      visitors: { total: 8, converted: 1, conversionRate: 0.125 },
    },
  },
};
const timeseries: GoalTimeseriesData = {
  ok: true,
  data: {
    goal,
    interval: "day",
    timeseries: [
      {
        timestampMs: 1_000,
        sessions: { total: 5, converted: 1, conversionRate: 0.2 },
        visitors: { total: 4, converted: 1, conversionRate: 0.25 },
      },
    ],
  },
};

function renderWithQueryClient(
  element: ReactNode,
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 15_000 },
    },
  }),
): {
  readonly client: QueryClient;
  readonly container: HTMLDivElement;
  readonly root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  return { client, container, root };
}

describe("Goal dashboard components", () => {
  let intersectionCallback:
    ((entries: IntersectionObserverEntry[]) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchGoalSummary).mockResolvedValue(summary);
    vi.mocked(fetchGoalTimeseries).mockResolvedValue(timeseries);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = (entries) => callback(entries, this as never);
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads card summary near the viewport and never loads timeseries from a card", async () => {
    const { container, root } = renderWithQueryClient(
      createElement(GoalCard, {
        goal,
        siteId: "site-1",
        locale: "en",
        labels,
        messages,
        window,
        filters,
        filterKey: "empty",
        canManage: false,
        onOpen: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
      }),
    );

    expect(fetchGoalSummary).not.toHaveBeenCalled();
    expect(fetchGoalTimeseries).not.toHaveBeenCalled();
    await act(async () => {
      intersectionCallback?.([
        { isIntersecting: true } as IntersectionObserverEntry,
      ]);
      await Promise.resolve();
    });
    expect(fetchGoalSummary).toHaveBeenCalledWith(
      "site-1",
      "goal-1",
      window,
      filters,
      expect.objectContaining({
        goalSemanticFingerprint: goal.semanticFingerprint,
      }),
    );
    expect(container.querySelector(`[aria-label="${labels.edit}"]`)).toBeNull();
    expect(
      container.querySelector(`[aria-label="${labels.delete}"]`),
    ).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it("uses the same summary key in the detail view and only adds the timeseries query there", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: 15_000 },
      },
    });
    client.setQueryData(
      goalSummaryQueryKey("site-1", goal, window, "empty", "auto"),
      summary,
    );
    const { container, root } = renderWithQueryClient(
      createElement(GoalDetail, {
        goal,
        siteId: "site-1",
        locale: "en",
        labels,
        window,
        filters,
        filterKey: "empty",
        canManage: true,
        onEdit: vi.fn(),
        onDelete: vi.fn(),
      }),
      client,
    );
    const cardKey = goalSummaryQueryKey(
      "site-1",
      goal,
      window,
      "empty",
      "auto",
    );
    const detailKey = goalSummaryQueryKey(
      "site-1",
      goal,
      window,
      "empty",
      "auto",
    );
    expect(detailKey).toEqual(cardKey);
    expect(
      goalTimeseriesQueryKey("site-1", goal, window, "empty", "auto"),
    ).toContain(window.interval);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchGoalSummary).not.toHaveBeenCalled();
    expect(fetchGoalTimeseries).toHaveBeenCalledTimes(1);
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes(labels.edit),
      ),
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes(labels.delete),
      ),
    ).toBe(true);
    expect(container.textContent).toContain('Event name equals "purchase"');
    expect(container.textContent).not.toContain(goal.filterDsl);
    act(() => root.unmount());
    container.remove();
  });

  it("separates analysis cache keys by range, filter, scope, semantic identity, and interval", () => {
    const changedWindow = { ...window, to: window.to + 1_000 };
    const changedGoal = {
      ...goal,
      semanticFingerprint: `${goal.semanticFingerprint}-changed`,
    };
    const summaryKey = goalSummaryQueryKey(
      "site-1",
      goal,
      window,
      "empty",
      "auto",
    );

    expect(
      goalSummaryQueryKey("site-1", goal, changedWindow, "empty", "auto"),
    ).not.toEqual(summaryKey);
    expect(
      goalSummaryQueryKey("site-1", goal, window, "changed", "auto"),
    ).not.toEqual(summaryKey);
    expect(
      goalSummaryQueryKey("site-1", goal, window, "empty", "event"),
    ).not.toEqual(summaryKey);
    expect(
      goalSummaryQueryKey("site-1", changedGoal, window, "empty", "auto"),
    ).not.toEqual(summaryKey);

    const timeseriesKey = goalTimeseriesQueryKey(
      "site-1",
      goal,
      window,
      "empty",
      "auto",
    );
    expect(
      goalTimeseriesQueryKey(
        "site-1",
        goal,
        { ...window, interval: "hour" },
        "empty",
        "auto",
      ),
    ).not.toEqual(timeseriesKey);
  });

  it("renders both visitor and session series without audience tabs", async () => {
    const { container, root } = renderWithQueryClient(
      createElement(GoalDetail, {
        goal,
        siteId: "site-1",
        locale: "en",
        labels,
        window,
        filters,
        filterKey: "empty",
        canManage: false,
        onEdit: vi.fn(),
        onDelete: vi.fn(),
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(fetchGoalTimeseries).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[data-slot="chart"]')).not.toBeNull(),
    );
    expect(
      container.querySelector('[data-goal-series="visitors,sessions"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the editor compact, uses event scope, counts conditions, and preserves raw DSL", async () => {
    const rawDsl = '  event.name eq "purchase"  ';
    const submit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    const { container, root } = renderWithQueryClient(
      createElement(GoalEditor, {
        open: true,
        goal: { ...goal, name: "Original goal", filterDsl: rawDsl },
        labels,
        messages,
        siteId: "site-1",
        window,
        submitting: false,
        onOpenChange,
        onSubmit: submit,
      }),
    );

    const filterButton = Array.from(
      document.body.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes(`${labels.filter} (1)`));
    expect(filterButton).toBeDefined();
    expect(filterButton?.className).toContain("w-full");
    act(() => filterButton?.click());
    const filterEditor = document.body.querySelector(
      '[data-audience="private-dashboard"]',
    );
    expect(filterEditor).not.toBeNull();
    expect(filterEditor?.getAttribute("data-resolved-scope")).toBe("event");
    expect(filterEditor?.getAttribute("data-initial-filter-dsl")).toBe(rawDsl);

    const apply = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Apply mocked filter",
    );
    act(() => apply?.click());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    const save = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes(labels.saveEdit),
    );
    act(() => save?.click());
    await vi.waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        name: "Original goal",
        filterDsl: rawDsl,
      }),
    );
    act(() => root.unmount());
    container.remove();
  });
});
