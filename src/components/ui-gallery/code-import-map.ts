import type { ElementType } from "react";
import * as productAnalyticsTooltip from "@insightflare/product-ui/analytics-tooltip";
import * as productCharts from "@insightflare/product-ui/charts";
import * as productDetailDrawer from "@insightflare/product-ui/detail-drawer";
import * as productFunnel from "@insightflare/product-ui/funnel";
import * as productGoals from "@insightflare/product-ui/goals";
import * as productRealtime from "@insightflare/product-ui/realtime";
import * as productSharing from "@insightflare/product-ui/sharing";
import * as productSiteScopeSelector from "@insightflare/product-ui/site-scope-selector";
import * as productTables from "@insightflare/product-ui/tables";
import * as uiAlertDialog from "@insightflare/ui/alert-dialog";
import * as uiAnimatedNumber from "@insightflare/ui/animated-number";
import * as uiAppOverlay from "@insightflare/ui/app-overlay";
import * as uiAsyncContent from "@insightflare/ui/async-content";
import * as uiAutoResizer from "@insightflare/ui/auto-resizer";
import * as uiAutoTransition from "@insightflare/ui/auto-transition";
import * as uiBadge from "@insightflare/ui/badge";
import * as uiBreadcrumb from "@insightflare/ui/breadcrumb";
import * as uiButton from "@insightflare/ui/button";
import * as uiButtonGroup from "@insightflare/ui/button-group";
import * as uiCalendar from "@insightflare/ui/calendar";
import * as uiCard from "@insightflare/ui/card";
import * as uiChart from "@insightflare/ui/chart";
import * as uiCheckbox from "@insightflare/ui/checkbox";
import * as uiClickable from "@insightflare/ui/clickable";
import * as uiClickableTableCell from "@insightflare/ui/clickable-table-cell";
import * as uiDataTableSwitch from "@insightflare/ui/data-table-switch";
import * as uiDialog from "@insightflare/ui/dialog";
import * as uiDrawer from "@insightflare/ui/drawer";
import * as uiDropdownMenu from "@insightflare/ui/dropdown-menu";
import * as uiField from "@insightflare/ui/field";
import * as uiInput from "@insightflare/ui/input";
import * as uiJsonTree from "@insightflare/ui/json-tree";
import * as uiLabel from "@insightflare/ui/label";
import * as uiMetricSummaryGrid from "@insightflare/ui/metric-summary-grid";
import * as uiOverlayScrollbar from "@insightflare/ui/overlay-scrollbar";
import * as uiPageHeading from "@insightflare/ui/page-heading";
import * as uiPopover from "@insightflare/ui/popover";
import * as uiRadioGroup from "@insightflare/ui/radio-group";
import * as uiResponsiveDialog from "@insightflare/ui/responsive-dialog";
import * as uiSearchablePopover from "@insightflare/ui/searchable-popover";
import * as uiSelect from "@insightflare/ui/select";
import * as uiSeparator from "@insightflare/ui/separator";
import * as uiSheet from "@insightflare/ui/sheet";
import * as uiSidebar from "@insightflare/ui/sidebar";
import * as uiSkeleton from "@insightflare/ui/skeleton";
import * as uiSlider from "@insightflare/ui/slider";
import * as uiSonner from "@insightflare/ui/sonner";
import * as uiSpinner from "@insightflare/ui/spinner";
import * as uiSwitch from "@insightflare/ui/switch";
import * as uiTabbedTable from "@insightflare/ui/tabbed-table";
import * as uiTable from "@insightflare/ui/table";
import * as uiTableActionButton from "@insightflare/ui/table-action-button";
import * as uiTabs from "@insightflare/ui/tabs";
import * as uiTooltip from "@insightflare/ui/tooltip";
import * as uiVerticalScrollMask from "@insightflare/ui/vertical-scroll-mask";
import { RiAddLine, RiMore2Line } from "@remixicon/react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

export interface ComponentSourceImport {
  readonly name: string;
  readonly source: string;
}

const sourceModules: readonly {
  readonly source: string;
  readonly exports: object;
}[] = [
  { source: "@insightflare/ui/button", exports: uiButton },
  { source: "@insightflare/ui/button-group", exports: uiButtonGroup },
  { source: "@insightflare/ui/badge", exports: uiBadge },
  { source: "@insightflare/ui/async-content", exports: uiAsyncContent },
  { source: "@insightflare/ui/calendar", exports: uiCalendar },
  { source: "@insightflare/ui/checkbox", exports: uiCheckbox },
  { source: "@insightflare/ui/clickable", exports: uiClickable },
  { source: "@insightflare/ui/field", exports: uiField },
  { source: "@insightflare/ui/input", exports: uiInput },
  { source: "@insightflare/ui/label", exports: uiLabel },
  { source: "@insightflare/ui/radio-group", exports: uiRadioGroup },
  { source: "@insightflare/ui/separator", exports: uiSeparator },
  { source: "@insightflare/ui/skeleton", exports: uiSkeleton },
  { source: "@insightflare/ui/slider", exports: uiSlider },
  { source: "@insightflare/ui/spinner", exports: uiSpinner },
  { source: "@insightflare/ui/switch", exports: uiSwitch },
  { source: "@insightflare/ui/tabs", exports: uiTabs },
  { source: "@insightflare/ui/breadcrumb", exports: uiBreadcrumb },
  { source: "@insightflare/ui/page-heading", exports: uiPageHeading },
  { source: "@insightflare/ui/chart", exports: uiChart },
  { source: "@insightflare/ui/json-tree", exports: uiJsonTree },
  { source: "@insightflare/ui/select", exports: uiSelect },
  {
    source: "@insightflare/ui/searchable-popover",
    exports: uiSearchablePopover,
  },
  { source: "@insightflare/ui/dialog", exports: uiDialog },
  { source: "@insightflare/ui/popover", exports: uiPopover },
  { source: "@insightflare/ui/tooltip", exports: uiTooltip },
  { source: "@insightflare/ui/drawer", exports: uiDrawer },
  { source: "@insightflare/ui/alert-dialog", exports: uiAlertDialog },
  { source: "@insightflare/ui/dropdown-menu", exports: uiDropdownMenu },
  { source: "@insightflare/ui/responsive-dialog", exports: uiResponsiveDialog },
  { source: "@insightflare/ui/sheet", exports: uiSheet },
  { source: "@insightflare/ui/table", exports: uiTable },
  {
    source: "@insightflare/ui/clickable-table-cell",
    exports: uiClickableTableCell,
  },
  { source: "@insightflare/ui/data-table-switch", exports: uiDataTableSwitch },
  {
    source: "@insightflare/ui/table-action-button",
    exports: uiTableActionButton,
  },
  { source: "@insightflare/ui/card", exports: uiCard },
  {
    source: "@insightflare/ui/metric-summary-grid",
    exports: uiMetricSummaryGrid,
  },
  { source: "@insightflare/ui/sidebar", exports: uiSidebar },
  { source: "@insightflare/ui/animated-number", exports: uiAnimatedNumber },
  { source: "@insightflare/ui/app-overlay", exports: uiAppOverlay },
  { source: "@insightflare/ui/auto-resizer", exports: uiAutoResizer },
  { source: "@insightflare/ui/auto-transition", exports: uiAutoTransition },
  { source: "@insightflare/ui/overlay-scrollbar", exports: uiOverlayScrollbar },
  { source: "@insightflare/ui/sonner", exports: uiSonner },
  {
    source: "@insightflare/ui/vertical-scroll-mask",
    exports: uiVerticalScrollMask,
  },
  { source: "@insightflare/ui/tabbed-table", exports: uiTabbedTable },
  { source: "@insightflare/product-ui/goals", exports: productGoals },
  { source: "@insightflare/product-ui/funnel", exports: productFunnel },
  { source: "@insightflare/product-ui/realtime", exports: productRealtime },
  { source: "@insightflare/product-ui/sharing", exports: productSharing },
  { source: "@insightflare/product-ui/charts", exports: productCharts },
  { source: "@insightflare/product-ui/tables", exports: productTables },
  {
    source: "@insightflare/product-ui/detail-drawer",
    exports: productDetailDrawer,
  },
  {
    source: "@insightflare/product-ui/site-scope-selector",
    exports: productSiteScopeSelector,
  },
  {
    source: "@insightflare/product-ui/analytics-tooltip",
    exports: productAnalyticsTooltip,
  },
  {
    source: "recharts",
    exports: { CartesianGrid, Line, LineChart, XAxis, YAxis },
  },
  {
    source: "@remixicon/react",
    exports: { RiAddLine, RiMore2Line },
  },
];

const importsByType = new Map<ElementType, ComponentSourceImport>();

// Match exports by identity so production minification cannot corrupt JSX names.
for (const { source, exports } of sourceModules) {
  for (const [name, value] of Object.entries(exports)) {
    if (
      (typeof value !== "function" &&
        (typeof value !== "object" || value === null)) ||
      importsByType.has(value as ElementType)
    ) {
      continue;
    }

    importsByType.set(value as ElementType, { name, source });
  }
}

export function resolveComponentSourceImport(
  type: ElementType,
): ComponentSourceImport | null {
  return importsByType.get(type) ?? null;
}
