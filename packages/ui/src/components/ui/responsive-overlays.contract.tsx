import { useState } from "react";

import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import { Button } from "./button";
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuSeparator,
  ResponsiveDropdownMenuTrigger,
} from "./responsive-dropdown-menu";
import {
  ResponsiveSearchablePopover,
  ResponsiveSearchablePopoverContent,
  ResponsiveSearchablePopoverTrigger,
} from "./responsive-searchable-popover";

interface ResponsiveOverlayFixtureProps {
  defaultOpen?: boolean;
}

function MenuFixture({ defaultOpen }: ResponsiveOverlayFixtureProps) {
  const [theme, setTheme] = useState("system");
  return (
    <ResponsiveDropdownMenu defaultOpen={defaultOpen}>
      <ResponsiveDropdownMenuTrigger asChild>
        <Button variant="outline">Appearance</Button>
      </ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent title="Appearance">
        <ResponsiveDropdownMenuRadioGroup
          value={theme}
          onValueChange={setTheme}
        >
          <ResponsiveDropdownMenuRadioItem value="light">
            Light
          </ResponsiveDropdownMenuRadioItem>
          <ResponsiveDropdownMenuRadioItem value="dark">
            Dark
          </ResponsiveDropdownMenuRadioItem>
          <ResponsiveDropdownMenuRadioItem value="system">
            System
          </ResponsiveDropdownMenuRadioItem>
        </ResponsiveDropdownMenuRadioGroup>
        <ResponsiveDropdownMenuSeparator />
        <ResponsiveDropdownMenuItem variant="destructive">
          Reset preferences
        </ResponsiveDropdownMenuItem>
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}

function SearchFixture({ defaultOpen }: ResponsiveOverlayFixtureProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("Choose component");
  return (
    <ResponsiveSearchablePopover open={open} onOpenChange={setOpen}>
      <ResponsiveSearchablePopoverTrigger asChild>
        <Button variant="outline">{selected}</Button>
      </ResponsiveSearchablePopoverTrigger>
      <ResponsiveSearchablePopoverContent
        drawerTitle="Choose component"
        searchPlaceholder="Search components"
        searchValue={query}
        onSearchValueChange={setQuery}
      >
        {[
          "Button",
          "Calendar",
          "Checkbox",
          "Input",
          "Select",
          "Slider",
          "Switch",
        ]
          .filter((item) => item.toLowerCase().includes(query.toLowerCase()))
          .map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={selected === item}
              className="flex w-full items-center px-3 py-2 text-left text-xs hover:bg-accent"
              onClick={() => {
                setSelected(item);
                setOpen(false);
                setQuery("");
              }}
            >
              {item}
            </button>
          ))}
      </ResponsiveSearchablePopoverContent>
    </ResponsiveSearchablePopover>
  );
}

const responsiveDropdownMenuFixtures = [
  {
    id: "responsive-dropdown-menu.scenario.appearance",
    title: "Appearance menu",
    props: { defaultOpen: false },
  },
] as const satisfies readonly ComponentFixture<ResponsiveOverlayFixtureProps>[];

const responsiveSearchablePopoverFixtures = [
  {
    id: "responsive-searchable-popover.scenario.picker",
    title: "Component picker",
    props: { defaultOpen: false },
  },
] as const satisfies readonly ComponentFixture<ResponsiveOverlayFixtureProps>[];

export const responsiveDropdownMenuContract =
  defineComponentContract<ResponsiveOverlayFixtureProps>({
    id: "responsive-dropdown-menu",
    title: "Responsive dropdown menu",
    category: "Overlays",
    categoryId: "overlays",
    description:
      "An anchored menu on desktop and a bottom drawer on narrow screens.",
    fixtures: responsiveDropdownMenuFixtures,
    render: (props) => <MenuFixture {...props} />,
  });

export const responsiveSearchablePopoverContract =
  defineComponentContract<ResponsiveOverlayFixtureProps>({
    id: "responsive-searchable-popover",
    title: "Responsive searchable popover",
    category: "Inputs",
    categoryId: "inputs",
    description:
      "A searchable popover on desktop and a scrollable bottom drawer on narrow screens.",
    fixtures: responsiveSearchablePopoverFixtures,
    render: (props) => <SearchFixture {...props} />,
  });
