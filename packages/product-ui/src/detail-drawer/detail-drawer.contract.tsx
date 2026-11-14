/* eslint-disable react/no-children-prop -- keeps the element tree identical to what the gallery source view shows */
import { createElement, type ReactNode, useState } from "react";
import { Button } from "@insightflare/ui/button";
import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";
import { RiAddLine } from "@remixicon/react";

import { DetailDrawer } from "./detail-drawer";

export interface DetailDrawerContractProps {
  ariaLabel: string;
}

function DetailDrawerContractPreview({ ariaLabel }: { ariaLabel: string }) {
  const [openDepth, setOpenDepth] = useState(0);
  const [layerCount, setLayerCount] = useState(0);

  const renderLayer = (depth: number): ReactNode => {
    if (depth >= layerCount) return null;

    const layerNumber = depth + 1;
    return createElement(DetailDrawer, {
      ariaLabel: `${ariaLabel} · layer ${layerNumber}`,
      drawerKey: `ui-gallery-detail-drawer-${layerNumber}`,
      open: depth < openDepth,
      onOpenChange: (nextOpen: boolean) => {
        if (!nextOpen) {
          setOpenDepth((currentDepth) => Math.min(currentDepth, depth));
        }
      },
      children: createElement(
        "div",
        { className: "min-h-[112vh] p-6 sm:p-10" },
        createElement(
          "div",
          { className: "mx-auto max-w-3xl space-y-6" },
          createElement(
            "div",
            { className: "flex flex-wrap items-start justify-between gap-4" },
            createElement(
              "div",
              { className: "space-y-2" },
              createElement(
                "p",
                { className: "font-mono text-xs text-primary" },
                `LAYER ${layerNumber}`,
              ),
              createElement(
                "h2",
                { className: "text-xl font-semibold" },
                `${ariaLabel} · layer ${layerNumber}`,
              ),
              createElement(
                "p",
                { className: "text-sm text-muted-foreground" },
                "Open another detail drawer to continue the nested stack.",
              ),
            ),
            createElement(
              Button,
              {
                variant: "outline",
                onClick: () => setOpenDepth(depth),
              },
              "Close this layer",
            ),
          ),
          createElement(
            "div",
            { className: "border bg-card p-4 sm:p-5" },
            createElement(
              "p",
              { className: "text-xs text-muted-foreground" },
              "Current stack depth",
            ),
            createElement(
              "p",
              { className: "mt-2 font-mono text-2xl tabular-nums" },
              String(layerNumber),
            ),
          ),
          createElement(
            Button,
            {
              onClick: () => {
                const nextDepth = depth + 2;
                setLayerCount((currentCount) =>
                  Math.max(currentCount, nextDepth),
                );
                setOpenDepth(nextDepth);
              },
            },
            createElement(RiAddLine, { className: "size-4" }),
            `Open nested layer ${layerNumber + 1}`,
          ),
          renderLayer(depth + 1),
        ),
      ),
    });
  };

  return createElement(
    "div",
    { className: "grid w-full justify-items-start gap-3" },
    createElement(
      Button,
      {
        onClick: () => {
          setLayerCount((currentCount) => Math.max(currentCount, 1));
          setOpenDepth(1);
        },
      },
      "Open first detail drawer",
    ),
    createElement(
      "p",
      { className: "text-sm text-muted-foreground" },
      "Keep opening nested layers to build an unbounded stack. Close the top layer to return to the one below it.",
    ),
    renderLayer(0),
  );
}

export const detailDrawerFixtures = [
  {
    id: "detail-drawer.default",
    title: "Interactive detail drawer",
    props: { ariaLabel: "Session details" },
  },
] as const satisfies readonly ComponentFixture<DetailDrawerContractProps>[];

export const detailDrawerContract =
  defineComponentContract<DetailDrawerContractProps>({
    id: "detail-drawer",
    title: "Detail drawer",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    fixtures: detailDrawerFixtures,
    render: ({ ariaLabel }) =>
      createElement(DetailDrawerContractPreview, { ariaLabel }),
  });
