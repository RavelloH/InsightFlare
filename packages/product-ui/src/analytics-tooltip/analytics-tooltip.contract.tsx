/* eslint-disable react/no-children-prop -- keeps the element tree identical to what the gallery source view shows */
import { createElement } from "react";
import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  AnalyticsTooltipProvider,
  AnalyticsTooltipTarget,
} from "./analytics-tooltip";

export interface AnalyticsTooltipContractProps {
  retentionMode: "table-column" | "target";
}

const EXAMPLES = [
  { key: "timestamp", target: "14:32:08.221", title: "Timestamp" },
  { key: "request", target: "GET /pricing", title: "Request" },
  { key: "visitor", target: "visitor-1042", title: "Visitor" },
  { key: "duration", target: "184 ms", title: "Duration" },
];

export const analyticsTooltipFixtures = [
  {
    id: "analytics-tooltip.default",
    title: "Single moving tooltip",
    props: { retentionMode: "target" },
  },
] as const satisfies readonly ComponentFixture<AnalyticsTooltipContractProps>[];

export const analyticsTooltipContract =
  defineComponentContract<AnalyticsTooltipContractProps>({
    id: "analytics-tooltip",
    title: "Analytics tooltip",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    fixtures: analyticsTooltipFixtures,
    render: ({ retentionMode }) =>
      createElement(AnalyticsTooltipProvider, {
        retentionMode,
        children: createElement(
          "div",
          { className: "grid w-full max-w-sm gap-4" },
          createElement(
            "p",
            { className: "text-sm text-muted-foreground" },
            "Move down the vertical trigger stack. One tooltip follows each row and updates with its content.",
          ),
          createElement(
            "div",
            { className: "grid gap-2" },
            ...EXAMPLES.map(({ key, target, title }) =>
              createElement(
                "div",
                {
                  key,
                  className:
                    "flex items-center justify-between gap-4 border bg-card px-4 py-3",
                },
                createElement(
                  "span",
                  { className: "text-xs text-muted-foreground" },
                  title,
                ),
                createElement(AnalyticsTooltipTarget, {
                  contentKey: key,
                  className:
                    "shrink-0 cursor-help border-b border-dashed border-muted-foreground/60 py-1 font-mono text-sm",
                  content: createElement(
                    "div",
                    { className: "grid gap-1 whitespace-nowrap" },
                    createElement(
                      "span",
                      {
                        className:
                          "text-[10px] uppercase tracking-wide text-background/60",
                      },
                      title,
                    ),
                    createElement(
                      "span",
                      { className: "text-xs" },
                      `${target} · sample analytics detail`,
                    ),
                  ),
                  children: target,
                }),
              ),
            ),
          ),
        ),
      }),
  });
