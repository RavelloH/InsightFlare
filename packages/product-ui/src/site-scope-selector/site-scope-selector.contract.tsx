import { createElement, useState } from "react";
import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  SiteScopeSelector,
  type SiteScopeSelectorProps,
} from "./site-scope-selector";

export type SiteScopeSelectorContractProps = Omit<
  SiteScopeSelectorProps,
  "onChange"
>;

function SiteScopeSelectorContractPreview({
  selectedSiteIds: initialSelectedSiteIds,
  ...props
}: SiteScopeSelectorContractProps) {
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>(() => [
    ...initialSelectedSiteIds,
  ]);

  return createElement(SiteScopeSelector, {
    ...props,
    selectedSiteIds,
    onChange: setSelectedSiteIds,
  });
}

export const siteScopeSelectorFixtures = [
  {
    id: "site-scope-selector.default",
    title: "All sites selected",
    props: {
      ariaLabel: "Site scope",
      allSitesLabel: "All sites",
      selectedSiteIds: [],
      sites: [
        {
          id: "site-news",
          name: "News Portal",
          domain: "news.example.com",
        },
        {
          id: "site-store",
          name: "E-Commerce Store",
          domain: "store.example.com",
        },
        {
          id: "site-docs",
          name: "Developer Docs",
          domain: "docs.example.com",
        },
      ],
      emptySitesLabel: "No sites available.",
    },
  },
] as const satisfies readonly ComponentFixture<SiteScopeSelectorContractProps>[];

export const siteScopeSelectorContract =
  defineComponentContract<SiteScopeSelectorContractProps>({
    id: "site-scope-selector",
    title: "Site scope selector",
    category: "Product UI / Management",
    categoryId: "product-management",
    fixtures: siteScopeSelectorFixtures,
    render: (props) =>
      createElement(SiteScopeSelectorContractPreview, {
        ...props,
        key: props.selectedSiteIds.join(",") || "all-sites",
      }),
  });
