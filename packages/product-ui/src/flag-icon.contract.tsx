import { createElement } from "react";
import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { FlagIcon, type FlagIconProps } from "./flag-icon";

export const flagIconFixtures = [
  {
    id: "flag-icon.default",
    title: "United States",
    props: { icon: "flagpack:us", className: "h-3 w-4" },
  },
  {
    id: "flag-icon.japan",
    title: "Japan",
    props: { icon: "flagpack:jp", className: "h-3 w-4" },
  },
  {
    id: "flag-icon.china",
    title: "China",
    props: { icon: "flagpack:cn", className: "h-3 w-4" },
  },
] as const satisfies readonly ComponentFixture<FlagIconProps>[];

export const flagIconContract = defineComponentContract<FlagIconProps>({
  id: "flag-icon",
  title: "Flag icon",
  category: "Product UI / Management",
  categoryId: "product-management",
  fixtures: flagIconFixtures,
  render: (props) => createElement(FlagIcon, props),
});
