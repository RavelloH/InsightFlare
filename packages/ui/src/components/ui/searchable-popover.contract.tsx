import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import { Button } from "./button";
import type { SearchablePopoverRootProps } from "./searchable-popover";
import {
  SearchablePopover,
  SearchablePopoverContent,
  SearchablePopoverTrigger,
} from "./searchable-popover";

interface SearchablePopoverScenarioProps extends Pick<
  SearchablePopoverRootProps,
  "defaultOpen"
> {
  readonly searchPlaceholder: string;
  readonly resultsMaxHeight?: string;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
  readonly className?: string;
}

const searchablePopoverFixtures = [
  {
    id: "searchable-popover.scenario.component-picker",
    title: "Component picker",
    presentation: { kind: "scenario", scenario: "search and select" },
    props: { searchPlaceholder: "Search components" },
  },
] as const satisfies readonly ComponentFixture<SearchablePopoverScenarioProps>[];

export const searchablePopoverContract =
  defineComponentContract<SearchablePopoverScenarioProps>({
    id: "searchable-popover",
    title: "Searchable popover",
    category: "Inputs",
    categoryId: "inputs",
    description:
      "A searchable popover shell with a bounded overlay-scrollbar results area.",
    fixtures: searchablePopoverFixtures,
    render: ({
      defaultOpen,
      searchPlaceholder,
      resultsMaxHeight,
      side = "bottom",
      align = "start",
      className,
    }) => (
      <SearchablePopover defaultOpen={defaultOpen}>
        <SearchablePopoverTrigger asChild>
          <Button variant="outline">Choose component</Button>
        </SearchablePopoverTrigger>
        <SearchablePopoverContent
          align={align}
          side={side}
          defaultSearchValue=""
          searchPlaceholder={searchPlaceholder}
          resultsMaxHeight={resultsMaxHeight}
          className={className}
        >
          {[
            "Button",
            "Button group",
            "Calendar",
            "Checkbox",
            "Clickable",
            "Field",
            "Input",
            "Label",
            "Radio group",
            "Select",
            "Slider",
            "Switch",
          ].map((option) => (
            <button
              key={option}
              type="button"
              className="flex w-full items-center px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
            >
              {option}
            </button>
          ))}
        </SearchablePopoverContent>
      </SearchablePopover>
    ),
  });
