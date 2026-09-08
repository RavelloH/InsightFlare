import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  editorInput: {
    name: "Renamed goal",
    filterDsl: 'event.name eq "purchase"',
  },
}));

vi.mock("@/lib/dashboard/client-data", () => ({
  createGoal: vi.fn(),
  deleteGoal: vi.fn(),
  fetchGoalDefinition: vi.fn(),
  fetchGoalSummary: vi.fn(),
  fetchGoalTimeseries: vi.fn(),
  fetchGoals: vi.fn(),
  updateGoal: vi.fn(),
}));

vi.mock("@/components/dashboard/site-pages/detail-query-modal", () => ({
  DETAIL_QUERY_PARAM: "detail",
  DetailDrawer: (props: { children: ReactNode }) =>
    createElement("div", { "data-detail-drawer": true }, props.children),
}));

vi.mock("@/components/dashboard/site-pages/goal-card", () => ({
  GoalCard: (props: { goal: GoalDefinition; onEdit: () => void }) =>
    createElement(
      "button",
      {
        type: "button",
        "data-goal-edit": props.goal.id,
        onClick: props.onEdit,
      },
      `Edit ${props.goal.name}`,
    ),
  GoalCardSkeleton: () => createElement("div"),
}));

vi.mock("@/components/dashboard/site-pages/goal-detail", () => ({
  GoalDetail: () => createElement("div", { "data-goal-detail": true }),
}));

vi.mock("@/components/ui/auto-transition", () => ({
  AutoTransition: (props: { children: ReactNode }) =>
    createElement("div", null, props.children),
}));

vi.mock("@/components/dashboard/site-pages/goal-editor", () => ({
  GoalEditor: (props: {
    open: boolean;
    onSubmit: (input: { name: string; filterDsl: string }) => Promise<void>;
  }) =>
    props.open
      ? createElement(
          "button",
          {
            type: "button",
            "data-goal-save": true,
            onClick: () => void props.onSubmit(testState.editorInput),
          },
          "Save goal",
        )
      : null,
}));

import {
  goalDefinitionQueryKey,
  GoalsClientPage,
} from "@/components/dashboard/site-pages/goals-client-page";
import { fetchGoals, updateGoal } from "@/lib/dashboard/client-data";
import type {
  GoalDefinition,
  GoalListData,
  GoalMutationData,
} from "@/lib/edge-client";
import { getMessages } from "@/lib/i18n/messages";

const messages = getMessages("en");
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

function listData(item: GoalDefinition = goal): GoalListData {
  return {
    ok: true,
    data: {
      items: [item],
      pagination: {
        limit: 50,
        returned: 1,
        hasMore: false,
        nextCursor: null,
      },
    },
  };
}

function mutationData(item: GoalDefinition): GoalMutationData {
  return { ok: true, data: { goal: item } };
}

function renderPage(client: QueryClient): {
  readonly container: HTMLDivElement;
  readonly root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(GoalsClientPage, {
          locale: "en",
          messages,
          siteId: "site-1",
          pathname: "/sites/site-1/goals",
          canManage: true,
        }),
      ),
    );
  });
  return { container, root };
}

describe("GoalsClientPage mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.editorInput = {
      name: "Renamed goal",
      filterDsl: 'event.name eq "purchase"',
    };
    vi.mocked(fetchGoals).mockResolvedValue(listData());
    window.history.replaceState({}, "", "/sites/site-1/goals");
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps analysis caches valid when an edit only renames a goal", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const definitionKey = goalDefinitionQueryKey("site-1", goal.id);
    const summaryKey = [
      "dashboard",
      "goal-summary",
      "site-1",
      goal.id,
      "existing-analysis",
    ] as const;
    const timeseriesKey = [
      "dashboard",
      "goal-timeseries",
      "site-1",
      goal.id,
      "existing-analysis",
    ] as const;
    client.setQueryData(definitionKey, { ok: true, data: { goal } });
    client.setQueryData(summaryKey, { cached: true });
    client.setQueryData(timeseriesKey, { cached: true });
    const renamedGoal = { ...goal, name: "Renamed goal", updatedAt: 3 };
    vi.mocked(updateGoal).mockResolvedValue(mutationData(renamedGoal));
    const { container, root } = renderPage(client);

    await vi.waitFor(() =>
      expect(container.querySelector("[data-goal-edit]")).not.toBeNull(),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>("[data-goal-edit]")?.click(),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>("[data-goal-save]")?.click(),
    );

    await vi.waitFor(() => expect(updateGoal).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(fetchGoals).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(container.querySelector("[data-goal-save]")).toBeNull(),
    );
    expect(client.getQueryState(definitionKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(summaryKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(timeseriesKey)?.isInvalidated).toBe(false);

    act(() => root.unmount());
    container.remove();
  });

  it("invalidates analysis caches when an edit changes the semantic fingerprint", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const definitionKey = goalDefinitionQueryKey("site-1", goal.id);
    const summaryKey = [
      "dashboard",
      "goal-summary",
      "site-1",
      goal.id,
      "existing-analysis",
    ] as const;
    const timeseriesKey = [
      "dashboard",
      "goal-timeseries",
      "site-1",
      goal.id,
      "existing-analysis",
    ] as const;
    client.setQueryData(definitionKey, { ok: true, data: { goal } });
    client.setQueryData(summaryKey, { cached: true });
    client.setQueryData(timeseriesKey, { cached: true });
    const semanticGoal = {
      ...goal,
      filterDsl: 'event.name eq "signup"',
      semanticFingerprint: "goal-v1-signup",
      updatedAt: 3,
    };
    testState.editorInput = {
      name: goal.name,
      filterDsl: semanticGoal.filterDsl,
    };
    vi.mocked(updateGoal).mockResolvedValue(mutationData(semanticGoal));
    const { container, root } = renderPage(client);

    await vi.waitFor(() =>
      expect(container.querySelector("[data-goal-edit]")).not.toBeNull(),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>("[data-goal-edit]")?.click(),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>("[data-goal-save]")?.click(),
    );

    await vi.waitFor(() => expect(updateGoal).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(fetchGoals).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(container.querySelector("[data-goal-save]")).toBeNull(),
    );
    expect(client.getQueryState(definitionKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(summaryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(timeseriesKey)?.isInvalidated).toBe(true);

    act(() => root.unmount());
    container.remove();
  });
});
