import {
  SearchablePopover,
  SearchablePopoverContent,
  type SearchablePopoverRootProps,
  SearchablePopoverTrigger,
} from "./searchable-popover";

export function ResponsiveSearchablePopover(props: SearchablePopoverRootProps) {
  return <SearchablePopover {...props} responsive />;
}
export {
  SearchablePopoverContent as ResponsiveSearchablePopoverContent,
  SearchablePopoverTrigger as ResponsiveSearchablePopoverTrigger,
};
