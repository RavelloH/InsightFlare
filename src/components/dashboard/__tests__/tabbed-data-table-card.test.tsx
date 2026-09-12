import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as Motion from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TabbedDataTableLoader,
  TabbedDataTableLoaderOptions,
  TabbedDataTablePage,
  TabbedDataTableRowBase,
} from "@/components/dashboard/tabbed-data-table-card";

const sentinelState = vi.hoisted(() => ({
  onReachEnd: undefined as (() => void) | undefined,
}));

vi.mock("@/components/dashboard/use-infinite-table-sentinel", () => ({
  useInfiniteTableSentinel: ({ onReachEnd }: { onReachEnd: () => void }) => {
    sentinelState.onReachEnd = onReachEnd;
    return () => undefined;
  },
}));

vi.mock("@/components/dashboard/animated-data-table-row", () => ({
  AnimatedDataTableRow: ({
    children,
    reduceMotion: _reduceMotion,
    ...props
  }: {
    children: ReactNode;
    reduceMotion?: boolean;
  } & Record<string, unknown>) => <tr {...props}>{children}</tr>,
}));

vi.mock("@/components/dashboard/tabbed-scroll-mask-card", () => ({
  TabbedScrollMaskCard: ({
    children,
    headerRight,
  }: {
    children: ReactNode;
    headerRight?: ReactNode;
  }) => (
    <div>
      {headerRight}
      {children}
    </div>
  ),
}));

vi.mock("@/components/dashboard/data-table-switch", () => ({
  DataTableSwitch: ({
    loading,
    hasContent,
    header,
    rows,
    footer,
  }: {
    loading: boolean;
    hasContent: boolean;
    header: ReactNode;
    rows: ReactNode;
    footer?: ReactNode;
  }) =>
    loading ? (
      <div data-testid="loading">Loading</div>
    ) : hasContent ? (
      <table>
        <thead>{header}</thead>
        <tbody>
          {rows}
          {footer}
        </tbody>
      </table>
    ) : (
      <div data-testid="empty">Empty</div>
    ),
}));

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof Motion>()),
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  useReducedMotion: () => true,
}));

import {
  TabbedDataTableCard,
  type TabbedDataTableColumn,
} from "@/components/dashboard/tabbed-data-table-card";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface TestRow extends TabbedDataTableRowBase {
  value: number;
}

type TestSortKey = "value";
type TestTab = "all";

const tabs = [{ value: "all", label: "All" }] as const;
const columns: readonly TabbedDataTableColumn<TestRow, TestSortKey, TestTab>[] =
  [
    {
      key: "value",
      label: "Value",
      getValue: (row) => row.value,
    },
  ];

function page(
  items: readonly TestRow[],
  nextCursor: string | null = null,
): TabbedDataTablePage<TestRow> {
  return {
    items,
    pagination: {
      limit: 2,
      returned: items.length,
      hasMore: nextCursor !== null,
      nextCursor,
    },
  };
}

function renderTable(
  loader: TabbedDataTableLoader<TestTab, TestRow, TestSortKey>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <TabbedDataTableCard<TestTab, TestRow, TestSortKey>
          tabs={tabs}
          columns={columns}
          loader={loader}
          limit={2}
          sortActionLabel={(label) => `Sort by ${label}`}
          loadingLabel="Loading"
          emptyLabel="Empty"
          search={false}
          export={false}
        />
      </QueryClientProvider>,
    );
  });
  return { client, container, root };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function renderedLabels(container: HTMLDivElement) {
  return Array.from(container.querySelectorAll("tbody tr"), (row) =>
    row.querySelector("td")?.textContent?.trim(),
  ).filter((label): label is string => Boolean(label));
}

describe("TabbedDataTableCard loader contract", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let client: QueryClient | undefined;

  beforeEach(() => {
    sentinelState.onReachEnd = undefined;
  });

  afterEach(() => {
    act(() => root?.unmount());
    client?.clear();
    container?.remove();
    root = undefined;
    client = undefined;
    container = undefined;
  });

  it("renders rows in the order returned by the loader", async () => {
    const loader = vi.fn(
      async (_options: TabbedDataTableLoaderOptions<TestTab, TestSortKey>) =>
        page([
          { key: "low", value: 1 },
          { key: "high", value: 10 },
        ]),
    );
    ({ client, container, root } = renderTable(loader));

    await settle();

    expect(renderedLabels(container!)).toEqual(["low", "high"]);
  });

  it("starts a new sort request from the first cursor", async () => {
    const loader = vi.fn(
      async (_options: TabbedDataTableLoaderOptions<TestTab, TestSortKey>) =>
        page([
          { key: "first", value: 1 },
          { key: "second", value: 2 },
        ]),
    );
    ({ client, container, root } = renderTable(loader));
    await settle();

    act(() => {
      container!
        .querySelector<HTMLButtonElement>('button[aria-label="Sort by Value"]')
        ?.click();
    });
    await settle();

    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls[1]?.[0]).toMatchObject({
      cursor: null,
      sort: { key: "value", direction: "asc" },
    });
  });

  it("appends pages without changing their loader order", async () => {
    const loader = vi.fn(
      async ({ cursor }: TabbedDataTableLoaderOptions<TestTab, TestSortKey>) =>
        cursor === null
          ? page(
              [
                { key: "page-one-a", value: 1 },
                { key: "page-one-b", value: 2 },
              ],
              "next",
            )
          : page([
              { key: "page-two-a", value: 3 },
              { key: "page-two-b", value: 4 },
            ]),
    );
    ({ client, container, root } = renderTable(loader));
    await settle();

    act(() => sentinelState.onReachEnd?.());
    await settle();

    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls[1]?.[0]).toMatchObject({ cursor: "next" });
    expect(renderedLabels(container!)).toEqual([
      "page-one-a",
      "page-one-b",
      "page-two-a",
      "page-two-b",
    ]);
  });
});
