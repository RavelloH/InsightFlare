import {
  createElement,
  type ElementType,
  Fragment,
  isValidElement,
  type ReactNode,
  useState,
} from "react";
import {
  AnalyticsTooltipProvider,
  AnalyticsTooltipTarget,
} from "@insightflare/product-ui/analytics-tooltip";
import {
  DonutChart,
  TrafficPairBarChart,
} from "@insightflare/product-ui/charts";
import { DetailDrawer } from "@insightflare/product-ui/detail-drawer";
import { funnelVisualizationContract } from "@insightflare/product-ui/funnel";
import { goalVisualizationContract } from "@insightflare/product-ui/goals";
import { realtimeTrafficTrendContract } from "@insightflare/product-ui/realtime";
import { shareBreakdownContract } from "@insightflare/product-ui/sharing";
import type { SiteScopeSelectorProps } from "@insightflare/product-ui/site-scope-selector";
import { SiteScopeSelector } from "@insightflare/product-ui/site-scope-selector";
import {
  AnalyticsDataTable,
  type AnalyticsTableColumnDefinition,
  AnalyticsTableColumnSettings,
} from "@insightflare/product-ui/tables";
import { Button } from "@insightflare/ui/button";
import { ClickableTableCell } from "@insightflare/ui/clickable-table-cell";
import type { ComponentContract } from "@insightflare/ui/contracts";
import {
  alertDialogContract,
  animatedNumberContract,
  appOverlayContract,
  asyncContentContract,
  autoResizerContract,
  autoTransitionContract,
  badgeContract,
  breadcrumbContract,
  buttonContract,
  buttonGroupContract,
  calendarContract,
  cardContract,
  chartContract,
  checkboxContract,
  clickableContract,
  type ComponentCategoryId,
  defineComponentContract,
  dialogContract,
  drawerContract,
  dropdownMenuContract,
  fieldContract,
  inputContract,
  jsonTreeContract,
  labelContract,
  metricSummaryGridContract,
  overlayScrollbarContract,
  pageHeadingContract,
  popoverContract,
  radioGroupContract,
  responsiveDialogContract,
  searchablePopoverContract,
  selectContract,
  separatorContract,
  sheetContract,
  sidebarContract,
  skeletonContract,
  sliderContract,
  spinnerContract,
  switchContract,
  tabbedTableContract,
  tableContract,
  tabsContract,
  toasterContract,
  tooltipContract,
  verticalScrollMaskContract,
} from "@insightflare/ui/contracts";
import { DataTableSwitch } from "@insightflare/ui/data-table-switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@insightflare/ui/table";
import { TableActionButton } from "@insightflare/ui/table-action-button";
import { RiAddLine, RiMore2Line } from "@remixicon/react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

export interface UiGalleryContract {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly categoryId: ComponentCategoryId;
  readonly componentType: ElementType | null;
  readonly propCards: readonly {
    readonly id: string;
    readonly prop: string;
    readonly values: readonly {
      readonly id: string;
      readonly label: string;
      readonly value: string | number | boolean;
      readonly preview?: "on-demand";
    }[];
  }[];
  renderPropValue(
    cardId: string,
    valueId: string,
    showDeferredPreview?: boolean,
    previewOverrides?: Record<string, unknown>,
  ): ReactNode | null;
  renderSourceValue(
    cardId: string,
    valueId: string,
    showDeferredPreview?: boolean,
    sourceOverrides?: Record<string, unknown>,
  ): ReactNode | null;
}

export interface UiGalleryEntry {
  readonly slug: string;
  readonly packageType: "ui" | "product-ui";
  readonly apiEntry: string;
  readonly maxValuesPerRow?: number;
  readonly previewAlignment?: "center" | "start" | "centered-left";
  readonly contract: UiGalleryContract;
}

interface GalleryPropValue {
  readonly id: string;
  readonly label: string;
  readonly value: string | number | boolean;
  readonly overrides?: Record<string, unknown>;
  readonly applyValue?: boolean;
  readonly preview?: "on-demand";
}

interface GalleryPropCard {
  readonly id: string;
  readonly prop: string;
  readonly values: readonly GalleryPropValue[];
}

function setGalleryPropValue(
  props: Record<string, unknown>,
  prop: string,
  value: unknown,
) {
  const segments = prop.split(".");
  let target = props;
  for (const segment of segments.slice(0, -1)) {
    const nested = target[segment];
    target[segment] =
      typeof nested === "object" && nested !== null
        ? { ...(nested as Record<string, unknown>) }
        : {};
    target = target[segment] as Record<string, unknown>;
  }
  target[segments.at(-1)!] = value;
}

function findComponentType(node: ReactNode): ElementType | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const componentType = findComponentType(child);
      if (componentType) return componentType;
    }
    return null;
  }

  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  if (node.type === Fragment) return findComponentType(node.props.children);
  if (typeof node.type !== "string") return node.type;
  return findComponentType(node.props.children);
}

function registerPropCards<Props>(
  contract: ComponentContract<Props>,
  propCards: readonly GalleryPropCard[],
  defaultOverrides: Partial<Props> = {},
  sourceRender?: (props: Props) => ReactNode,
): UiGalleryContract {
  const defaultProps = {
    ...contract.fixtures[0]?.props,
    ...defaultOverrides,
  } as Props;
  const componentType = findComponentType(contract.render(defaultProps));
  const resolveProps = (
    cardId: string,
    valueId: string,
    showDeferredPreview = false,
    overrides?: Record<string, unknown>,
  ) => {
    const card = propCards.find((candidate) => candidate.id === cardId);
    const value = card?.values.find((candidate) => candidate.id === valueId);
    if (!card || !value) return null;

    const props = { ...defaultProps } as Record<string, unknown>;
    if (value.applyValue !== false) {
      const resolvedValue =
        value.preview === "on-demand" && !showDeferredPreview
          ? false
          : value.value;
      setGalleryPropValue(props, card.prop, resolvedValue);
    }
    Object.assign(props, value.overrides);
    Object.assign(props, overrides);
    if (contract.id === "sonner") {
      props.id = `ui-gallery-${cardId}-${valueId}`;
    }
    return props as Props;
  };

  return {
    ...contract,
    propCards,
    componentType,
    renderPropValue(
      cardId,
      valueId,
      showDeferredPreview = false,
      previewOverrides,
    ) {
      const props = resolveProps(
        cardId,
        valueId,
        showDeferredPreview,
        previewOverrides,
      );
      return props ? contract.render(props) : null;
    },
    renderSourceValue(
      cardId,
      valueId,
      showDeferredPreview = false,
      sourceOverrides,
    ) {
      const props = resolveProps(
        cardId,
        valueId,
        showDeferredPreview,
        sourceOverrides,
      );
      if (!props) return null;
      return sourceRender ? sourceRender(props) : contract.render(props);
    },
  };
}

function propCard(
  prop: string,
  values: readonly GalleryPropValue[],
): GalleryPropCard {
  return { id: prop, prop, values };
}

function propValue(
  value: string | number | boolean,
  label = String(value),
  overrides?: Record<string, unknown>,
  applyValue = true,
  preview?: "on-demand",
): GalleryPropValue {
  return {
    id: String(value),
    label,
    value,
    overrides,
    applyValue,
    preview,
  };
}

function SiteScopeSelectorGalleryPreview({
  selectedSiteIds: initialSelectedSiteIds,
  ...props
}: Omit<SiteScopeSelectorProps, "onChange">) {
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>(() => [
    ...initialSelectedSiteIds,
  ]);

  return createElement(SiteScopeSelector, {
    ...props,
    selectedSiteIds,
    onChange: setSelectedSiteIds,
  });
}

function DetailDrawerGalleryPreview({ ariaLabel }: { ariaLabel: string }) {
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

function scrollbarItems(labels: readonly string[], className: string) {
  return createElement(
    "div",
    { className },
    ...labels.map((label, index) =>
      createElement(
        "span",
        {
          key: `${label}-${index}`,
          className: className.includes("grid")
            ? "flex min-h-12 items-center border bg-card px-4 py-2 text-sm"
            : "border bg-card px-4 py-2 text-sm",
        },
        label,
      ),
    ),
  );
}

const ClickableTableCellGalleryPreview = Object.assign(
  function ClickableTableCellGalleryPreview({
    focusable,
    ariaLabel,
    onClick,
    children,
  }: {
    focusable: boolean;
    ariaLabel: string;
    onClick: () => void;
    children: ReactNode;
  }) {
    const [selectedPage, setSelectedPage] = useState("/pricing");
    const handleClick = () => {
      onClick();
      setSelectedPage((page) =>
        page === "/pricing" ? "/docs/getting-started" : "/pricing",
      );
    };

    return createElement(ClickableTableCell, {
      focusable,
      ariaLabel:
        selectedPage === "/pricing" ? ariaLabel : `Open ${selectedPage}`,
      onClick: handleClick,
      children: selectedPage === "/pricing" ? children : selectedPage,
    });
  },
  { displayName: "ClickableTableCell" },
);

const COLUMN_SETTINGS_BASE_COLUMNS: readonly AnalyticsTableColumnDefinition[] =
  [
    { id: "page", label: "Page", required: true },
    { id: "views", label: "Views" },
    { id: "visitors", label: "Visitors" },
    { id: "conversions", label: "Conversions", defaultVisible: false },
  ] as const satisfies readonly AnalyticsTableColumnDefinition[];

const COLUMN_SETTINGS_LABELS = {
  action: "Configure columns",
  title: "Table columns",
  description: "Choose which columns to show and drag to change their order.",
  visible: "Visible columns",
  required: "Required",
  reset: "Reset",
  dragHint: "Drag to reorder",
  close: "Done",
};

const AnalyticsTableColumnSettingsGalleryPreview = Object.assign(
  function AnalyticsTableColumnSettingsGalleryPreview({
    columns,
    orderedIds: initialOrderedIds,
    visibleIds: initialVisibleIds,
    onOrderChange,
    onVisibilityChange,
    onReset,
    labels,
  }: {
    columns: readonly AnalyticsTableColumnDefinition[];
    orderedIds: readonly string[];
    visibleIds: readonly string[];
    onOrderChange: (nextOrder: readonly string[]) => void;
    onVisibilityChange: (nextVisible: readonly string[]) => void;
    onReset: () => void;
    labels: typeof COLUMN_SETTINGS_LABELS;
  }) {
    const [orderedIds, setOrderedIds] = useState([...initialOrderedIds]);
    const [visibleIds, setVisibleIds] = useState([...initialVisibleIds]);
    const visibleColumnIds = orderedIds.filter((id) => visibleIds.includes(id));
    const columnsById = new Map(
      columns.map((column) => [column.id, column] as const),
    );
    const handleOrderChange = (nextOrder: readonly string[]) => {
      setOrderedIds([...nextOrder]);
      onOrderChange(nextOrder);
    };
    const handleVisibilityChange = (nextVisible: readonly string[]) => {
      setVisibleIds([...nextVisible]);
      onVisibilityChange(nextVisible);
    };
    const handleReset = () => {
      setOrderedIds(columns.map((column) => column.id));
      setVisibleIds(
        columns
          .filter(
            (column) => column.required || column.defaultVisible !== false,
          )
          .map((column) => column.id),
      );
      onReset();
    };

    return createElement(
      "div",
      { className: "grid w-full gap-3" },
      createElement(
        "div",
        { className: "flex items-center justify-between gap-3" },
        createElement("p", { className: "text-sm font-medium" }, "Page report"),
        createElement(AnalyticsTableColumnSettings, {
          columns,
          orderedIds,
          visibleIds,
          onOrderChange: handleOrderChange,
          onVisibilityChange: handleVisibilityChange,
          onReset: handleReset,
          labels,
        }),
      ),
      createElement(
        Table,
        null,
        createElement(
          "thead",
          null,
          createElement(
            TableRow,
            null,
            ...visibleColumnIds.map((id) =>
              createElement(
                TableHead,
                { key: id },
                columnsById.get(id)?.label ?? id,
              ),
            ),
          ),
        ),
        createElement(
          TableBody,
          null,
          ...[
            ["/pricing", "1,284", "842", "126"],
            ["/docs/getting-started", "946", "731", "84"],
          ].map((row) =>
            createElement(
              TableRow,
              { key: row[0]! },
              ...visibleColumnIds.map((id) => {
                const index = columns.findIndex((column) => column.id === id);
                return createElement(TableCell, { key: id }, row[index] ?? "—");
              }),
            ),
          ),
        ),
      ),
    );
  },
  { displayName: "AnalyticsTableColumnSettings" },
);

const galleryContracts = {
  asyncContent: registerPropCards(asyncContentContract, [
    propCard("loading", [propValue(false), propValue(true)]),
    propCard("hasContent", [propValue(true), propValue(false)]),
    propCard("loadingLabel", [
      propValue("Loading report…"),
      propValue("Loading analytics…"),
    ]),
    propCard("loadingContent", [
      propValue(
        "default",
        "Spinner and label",
        { loadingContent: undefined },
        false,
      ),
      propValue(
        "custom",
        "Custom placeholder",
        {
          loading: true,
          loadingContent: createElement(
            "div",
            {
              className:
                "flex min-h-20 items-center justify-center border bg-card p-4",
            },
            "Loading summary…",
          ),
        },
        false,
      ),
    ]),
    propCard("emptyContent", [
      propValue("No report data available."),
      propValue("No results found."),
    ]),
    propCard("children", [
      propValue(
        "Report content",
        "Report content",
        {
          children: createElement(
            "div",
            { className: "border bg-card p-4" },
            "Report content",
          ),
        },
        false,
      ),
      propValue(
        "Analytics content",
        "Analytics content",
        {
          children: createElement(
            "div",
            { className: "border bg-card p-4" },
            "Analytics summary",
          ),
        },
        false,
      ),
    ]),
    propCard("className", [propValue("w-full"), propValue("max-w-2xl")]),
    propCard("minHeightClassName", [
      propValue("min-h-[120px]"),
      propValue("min-h-64"),
    ]),
    propCard("initial", [propValue(true), propValue(false)]),
  ]),
  button: registerPropCards(
    buttonContract,
    [
      propCard("variant", [
        ...[
          "default",
          "secondary",
          "outline",
          "ghost",
          "destructive",
          "link",
        ].map((value) => propValue(value)),
      ]),
      propCard("size", [
        ...[
          "default",
          "xs",
          "sm",
          "lg",
          "icon",
          "icon-xs",
          "icon-sm",
          "icon-lg",
        ].map((value) =>
          propValue(
            value,
            value,
            ["icon", "icon-xs", "icon-sm", "icon-lg"].includes(value)
              ? { children: createElement(RiAddLine, { "aria-hidden": true }) }
              : undefined,
          ),
        ),
      ]),
      propCard("disabled", [propValue(false), propValue(true)]),
      propCard("type", [propValue("button"), propValue("submit")]),
      propCard("asChild", [
        propValue(false, "false"),
        propValue(true, "true", {
          children: createElement("a", { href: "#button-preview" }, "Save"),
        }),
      ]),
      propCard("children", [
        propValue("Text", "Text", { children: "Save" }, false),
        propValue(
          "Icon",
          "Leading icon",
          {
            children: createElement(
              "span",
              { className: "inline-flex items-center gap-1.5" },
              createElement(RiAddLine, { className: "size-4" }),
              "Create",
            ),
          },
          false,
        ),
      ]),
    ],
    { children: "Save", variant: "default", size: "default", disabled: false },
  ),
  buttonGroup: registerPropCards(buttonGroupContract, [
    propCard("orientation", [propValue("horizontal"), propValue("vertical")]),
    propCard("children", [
      propValue(
        "Previous and Continue",
        "Previous and Continue",
        { children: buttonGroupContract.fixtures[0].props.children },
        false,
      ),
      propValue(
        "Month, Quarter, Year",
        "Month, Quarter, Year",
        { children: buttonGroupContract.fixtures[1].props.children },
        false,
      ),
    ]),
  ]),
  badge: registerPropCards(
    badgeContract,
    [
      propCard("variant", [
        ...[
          "default",
          "secondary",
          "destructive",
          "outline",
          "ghost",
          "link",
        ].map((value) => propValue(value)),
      ]),
      propCard("asChild", [
        propValue(false, "false"),
        propValue(true, "true", {
          children: createElement("a", { href: "#badge-preview" }, "Active"),
        }),
      ]),
      propCard("children", [
        propValue("Active", "Active", { children: "Active" }, false),
        propValue("New", "New", { children: "New" }, false),
      ]),
    ],
    { children: "Active" },
  ),
  calendar: registerPropCards(calendarContract, [
    propCard("mode", [
      propValue("single"),
      propValue("multiple", "multiple", {
        selected: [new Date(2025, 8, 12), new Date(2025, 8, 15)],
      }),
      propValue("range", "range", {
        selected: {
          from: new Date(2025, 8, 12),
          to: new Date(2025, 8, 16),
        },
      }),
    ]),
    propCard("captionLayout", [
      ...["label", "dropdown", "dropdown-months", "dropdown-years"].map(
        (value) => propValue(value),
      ),
    ]),
    propCard("selected", [
      propValue(
        "2025-09-12",
        "September 12",
        { selected: new Date(2025, 8, 12) },
        false,
      ),
      propValue(
        "2025-09-18",
        "September 18",
        { selected: new Date(2025, 8, 18) },
        false,
      ),
    ]),
    propCard("defaultMonth", [
      propValue(
        "september-2025",
        "September 2025",
        { defaultMonth: new Date(2025, 8, 1) },
        false,
      ),
      propValue(
        "october-2025",
        "October 2025",
        { defaultMonth: new Date(2025, 9, 1) },
        false,
      ),
    ]),
    propCard("month", [
      propValue(
        "september-2025",
        "September 2025",
        { month: new Date(2025, 8, 1) },
        false,
      ),
      propValue(
        "october-2025",
        "October 2025",
        { month: new Date(2025, 9, 1) },
        false,
      ),
    ]),
    propCard("showOutsideDays", [propValue(true), propValue(false)]),
    propCard("numberOfMonths", [propValue(1), propValue(2)]),
    propCard("weekStartsOn", [propValue(0), propValue(1), propValue(6)]),
    propCard("required", [propValue(false), propValue(true)]),
    propCard("disabled", [
      propValue("none", "No disabled dates", { disabled: undefined }, false),
      propValue(
        "before-today",
        "Dates before today",
        { disabled: { before: new Date(2025, 8, 12) } },
        false,
      ),
    ]),
    propCard("buttonVariant", [
      ...[
        "default",
        "secondary",
        "outline",
        "ghost",
        "destructive",
        "link",
      ].map((value) => propValue(value)),
    ]),
  ]),
  checkbox: registerPropCards(checkboxContract, [
    propCard("checked", [
      propValue(true),
      propValue(false),
      propValue("indeterminate"),
    ]),
    propCard("defaultChecked", [propValue(false), propValue(true)]),
    propCard("disabled", [propValue(false), propValue(true)]),
    propCard("required", [propValue(false), propValue(true)]),
    propCard("name", [propValue("includeReturningVisitors")]),
    propCard("value", [
      propValue("returning-visitors"),
      propValue("new-visitors"),
    ]),
  ]),
  clickable: registerPropCards(clickableContract, [
    propCard("children", [
      propValue(
        "Open report",
        "Open report",
        { children: "Open report" },
        false,
      ),
      propValue(
        "View details",
        "View details",
        { children: "View details" },
        false,
      ),
    ]),
    propCard("disabled", [propValue(false), propValue(true)]),
    propCard("enableHoverScale", [propValue(true), propValue(false)]),
    propCard("hoverScale", [propValue(1), propValue(1.16), propValue(1.3)]),
    propCard("tapScale", [propValue(0.9), propValue(0.94), propValue(1)]),
    propCard("duration", [propValue(0.1), propValue(0.16), propValue(0.3)]),
    propCard("aria-label", [
      propValue("Open report"),
      propValue("View details"),
    ]),
  ]),
  field: registerPropCards(fieldContract, [
    propCard("orientation", [
      propValue("vertical"),
      propValue("horizontal", "horizontal", {
        children: fieldContract.fixtures[1].props.children,
        className: "items-center gap-4 bg-muted/20 p-4",
      }),
    ]),
    propCard("children", [
      propValue(
        "email-field",
        "Email field",
        { children: fieldContract.fixtures[0].props.children },
        false,
      ),
      propValue(
        "preference-field",
        "Preference field",
        {
          children: fieldContract.fixtures[1].props.children,
          orientation: "horizontal",
          className: "items-center gap-4 bg-muted/20 p-4",
        },
        false,
      ),
    ]),
  ]),
  input: registerPropCards(inputContract, [
    propCard("type", [
      ...["text", "email", "search", "number", "password"].map((value) =>
        propValue(value),
      ),
    ]),
    propCard("disabled", [propValue(false), propValue(true)]),
    propCard("readOnly", [propValue(false), propValue(true)]),
    propCard("placeholder", [
      propValue("Enter a value"),
      propValue("name@example.com"),
    ]),
    propCard("defaultValue", [
      propValue("team@example.com"),
      propValue("analytics@example.com"),
    ]),
    propCard("value", [
      propValue("analytics@example.com", "analytics@example.com", {
        readOnly: true,
      }),
      propValue("team@example.com", "team@example.com", {
        readOnly: true,
      }),
    ]),
    propCard("name", [propValue("email"), propValue("workspaceName")]),
    propCard("autoComplete", [propValue("email"), propValue("name")]),
    propCard("aria-invalid", [propValue(false), propValue(true)]),
    propCard("required", [propValue(false), propValue(true)]),
  ]),
  label: registerPropCards(labelContract, [
    propCard("htmlFor", [propValue("workspace-name"), propValue("team-name")]),
    propCard("children", [
      propValue(
        "Workspace name",
        "Workspace name",
        { children: "Workspace name" },
        false,
      ),
      propValue("Team name", "Team name", { children: "Team name" }, false),
    ]),
  ]),
  radioGroup: registerPropCards(radioGroupContract, [
    propCard("defaultValue", [
      propValue("daily"),
      propValue("weekly"),
      propValue("monthly"),
    ]),
    propCard("value", [
      propValue("daily"),
      propValue("weekly"),
      propValue("monthly"),
    ]),
    propCard("orientation", [
      propValue("vertical", "vertical", { className: "grid gap-3" }),
      propValue("horizontal", "horizontal", {
        className: "flex flex-wrap gap-3",
      }),
    ]),
    propCard("disabled", [propValue(false), propValue(true)]),
    propCard("required", [propValue(false), propValue(true)]),
    propCard("name", [propValue("reporting-period"), propValue("interval")]),
  ]),
  separator: registerPropCards(separatorContract, [
    propCard("orientation", [propValue("horizontal"), propValue("vertical")]),
    propCard("decorative", [propValue(true), propValue(false)]),
  ]),
  skeleton: registerPropCards(skeletonContract, [
    propCard("className", [
      propValue("h-3 w-28"),
      propValue("h-5 w-40"),
      propValue("h-8 w-56"),
    ]),
  ]),
  slider: registerPropCards(sliderContract, [
    propCard("disabled", [propValue(false), propValue(true)]),
    propCard("orientation", [propValue("horizontal"), propValue("vertical")]),
    propCard("min", [propValue(0), propValue(10), propValue(25)]),
    propCard("max", [propValue(50), propValue(100), propValue(200)]),
    propCard("step", [propValue(1), propValue(5), propValue(10)]),
    propCard("defaultValue", [
      propValue("single-value", "Single value", { defaultValue: [35] }, false),
      propValue("range", "Range", { defaultValue: [25, 75] }, false),
    ]),
    propCard("value", [
      propValue("controlled-single", "Single value", { value: [68] }, false),
      propValue("controlled-range", "Range", { value: [25, 75] }, false),
    ]),
  ]),
  spinner: registerPropCards(spinnerContract, [
    propCard("className", [
      propValue("size-3"),
      propValue("size-4"),
      propValue("size-6"),
    ]),
  ]),
  switch: registerPropCards(switchContract, [
    propCard("defaultChecked", [propValue(false), propValue(true)]),
    propCard("checked", [propValue(false), propValue(true)]),
    propCard("disabled", [propValue(false), propValue(true)]),
    propCard("size", [propValue("default"), propValue("sm")]),
    propCard("required", [propValue(false), propValue(true)]),
    propCard("name", [propValue("notifications"), propValue("weeklyDigest")]),
    propCard("value", [propValue("enabled"), propValue("subscribed")]),
  ]),
  tabs: registerPropCards(tabsContract, [
    propCard("variant", [propValue("default"), propValue("line")]),
    propCard("orientation", [propValue("horizontal"), propValue("vertical")]),
    propCard("defaultValue", [propValue("overview"), propValue("sources")]),
    propCard("value", [propValue("overview"), propValue("sources")]),
    propCard("activationMode", [propValue("automatic"), propValue("manual")]),
  ]),
  breadcrumb: registerPropCards(breadcrumbContract, [
    propCard("children", [
      propValue(
        "overview-to-traffic",
        "Overview → Reports → Traffic",
        { children: breadcrumbContract.fixtures[0].props.children },
        false,
      ),
    ]),
    propCard("aria-label", [
      propValue("breadcrumb"),
      propValue("Primary navigation"),
    ]),
  ]),
  chart: registerPropCards(chartContract, [
    propCard("id", [propValue("traffic-chart"), propValue("sessions-chart")]),
    propCard("className", [propValue("h-48 w-full"), propValue("h-64 w-full")]),
    propCard("config", [
      propValue(
        "Views and visitors",
        "Views and visitors",
        {
          config: {
            visitors: { label: "Visitors", color: "var(--chart-1)" },
            sessions: { label: "Sessions", color: "var(--chart-2)" },
          },
        },
        false,
      ),
      propValue(
        "Visits and page views",
        "Visits and page views",
        {
          config: {
            visitors: { label: "Visits", color: "var(--chart-3)" },
            sessions: { label: "Page views", color: "var(--chart-4)" },
          },
        },
        false,
      ),
    ]),
    propCard("children", [
      propValue(
        "visitors-and-sessions",
        "Two line series",
        { children: chartContract.fixtures[0].props.children },
        false,
      ),
      propValue(
        "visitors-only",
        "Single line series",
        {
          children: createElement(
            LineChart,
            {
              data: [
                { day: "Mon", visitors: 410 },
                { day: "Tue", visitors: 520 },
                { day: "Wed", visitors: 470 },
                { day: "Thu", visitors: 620 },
                { day: "Fri", visitors: 590 },
              ],
              margin: { left: 8, right: 8, top: 12 },
            },
            createElement(CartesianGrid, {
              vertical: false,
              strokeDasharray: "3 3",
            }),
            createElement(XAxis as ElementType, {
              dataKey: "day",
              tickLine: false,
              axisLine: false,
            }),
            createElement(YAxis as ElementType, {
              width: 36,
              tickLine: false,
              axisLine: false,
            }),
            createElement(Line as ElementType, {
              dataKey: "visitors",
              type: "monotone",
              stroke: "var(--color-visitors)",
              strokeWidth: 2,
              dot: false,
            }),
          ),
          config: {
            visitors: { label: "Visitors", color: "var(--chart-1)" },
          },
        },
        false,
      ),
    ]),
  ]),
  jsonTree: registerPropCards(jsonTreeContract, [
    propCard("value", [
      propValue(
        "event-payload",
        "Event payload",
        {
          value: {
            event: "checkout.completed",
            visitor: { id: "visitor_1284", returning: true },
            properties: { currency: "USD", total: 84.5 },
          },
        },
        false,
      ),
      propValue(
        "source-array",
        "Source array",
        { value: ["direct", "search", "social"] },
        false,
      ),
      propValue("scalar", "Scalar", { value: "checkout.completed" }, false),
    ]),
    propCard("className", [
      propValue("default", "Default", { className: undefined }, false),
      propValue("max-w-2xl", "Constrained width", { className: "max-w-2xl" }),
    ]),
  ]),
  select: registerPropCards(selectContract, [
    propCard("defaultValue", [propValue("daily"), propValue("weekly")]),
    propCard("value", [propValue("daily"), propValue("weekly")]),
    propCard("children", [
      propValue(
        "daily-weekly-options",
        "Daily and weekly options",
        { children: selectContract.fixtures[0].props.children },
        false,
      ),
      propValue(
        "daily-monthly-options",
        "Daily and monthly options",
        { children: selectContract.fixtures[1].props.children },
        false,
      ),
    ]),
    propCard("disabled", [propValue(false), propValue(true)]),
    propCard("defaultOpen", [
      propValue(false),
      propValue(true, "true", undefined, true, "on-demand"),
    ]),
    propCard("open", [
      propValue(false),
      propValue(true, "true", undefined, true, "on-demand"),
    ]),
    propCard("required", [propValue(false), propValue(true)]),
    propCard("name", [propValue("reporting-period"), propValue("interval")]),
  ]),
  searchablePopover: registerPropCards(
    searchablePopoverContract,
    [
      propCard("searchPlaceholder", [
        propValue("Search components"),
        propValue("Find a component"),
      ]),
      propCard("resultsMaxHeight", [propValue("18rem"), propValue("14rem")]),
      propCard("side", [
        propValue("bottom"),
        propValue("top"),
        propValue("right"),
        propValue("left"),
      ]),
      propCard("align", [
        propValue("start"),
        propValue("center"),
        propValue("end"),
      ]),
      propCard("defaultOpen", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
      propCard("className", [
        propValue("default", "Default", { className: undefined }, false),
        propValue("min-w-64", "Wider menu", { className: "min-w-64" }),
      ]),
    ],
    { defaultOpen: false },
  ),
  dialog: registerPropCards(
    dialogContract,
    [
      propCard("defaultOpen", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
      propCard("open", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
    ],
    { defaultOpen: false },
  ),
  popover: registerPropCards(popoverContract, [
    propCard("defaultOpen", [
      propValue(false),
      propValue(true, "true", undefined, true, "on-demand"),
    ]),
    propCard("open", [
      propValue(false),
      propValue(true, "true", undefined, true, "on-demand"),
    ]),
    propCard("modal", [propValue(false), propValue(true)]),
    propCard("side", [
      propValue("top"),
      propValue("right"),
      propValue("bottom"),
      propValue("left"),
    ]),
    propCard("align", [
      propValue("start"),
      propValue("center"),
      propValue("end"),
    ]),
  ]),
  tooltip: registerPropCards(tooltipContract, [
    propCard("defaultOpen", [
      propValue(false),
      propValue(true, "true", undefined, true, "on-demand"),
    ]),
    propCard("open", [
      propValue(false),
      propValue(true, "true", undefined, true, "on-demand"),
    ]),
    propCard("delayDuration", [propValue(0), propValue(300), propValue(700)]),
    propCard("skipDelayDuration", [propValue(0), propValue(300)]),
    propCard("disableHoverableContent", [propValue(false), propValue(true)]),
    propCard("side", [
      propValue("top"),
      propValue("right"),
      propValue("bottom"),
      propValue("left"),
    ]),
    propCard("sideOffset", [propValue(0), propValue(8), propValue(16)]),
  ]),
  drawer: registerPropCards(
    drawerContract,
    [
      propCard("defaultOpen", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
      propCard("open", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
      propCard("modal", [propValue(true), propValue(false)]),
      propCard("direction", [
        propValue("bottom"),
        propValue("top"),
        propValue("left"),
        propValue("right"),
      ]),
    ],
    { defaultOpen: false },
  ),
  alertDialog: registerPropCards(
    alertDialogContract,
    [
      propCard("defaultOpen", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
      propCard("open", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
    ],
    { defaultOpen: false },
  ),
  dropdownMenu: registerPropCards(
    dropdownMenuContract,
    [
      propCard("defaultOpen", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
      propCard("open", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
      propCard("modal", [propValue(true), propValue(false)]),
    ],
    { defaultOpen: false },
  ),
  responsiveDialog: registerPropCards(
    responsiveDialogContract,
    [
      propCard("defaultOpen", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
      propCard("open", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
    ],
    { defaultOpen: false },
  ),
  sheet: registerPropCards(
    sheetContract,
    [
      propCard("side", [
        propValue("top"),
        propValue("right"),
        propValue("bottom"),
        propValue("left"),
      ]),
      propCard("defaultOpen", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
      propCard("open", [
        propValue(false),
        propValue(true, "true", undefined, true, "on-demand"),
      ]),
    ],
    { defaultOpen: false },
  ),
  table: registerPropCards(tableContract, [
    propCard("className", [propValue("w-full"), propValue("min-w-[36rem]")]),
    propCard("children", [
      propValue(
        "three-rows",
        "Three rows",
        { children: tableContract.fixtures[0].props.children },
        false,
      ),
      propValue(
        "one-row",
        "One row",
        { children: tableContract.fixtures[1].props.children },
        false,
      ),
    ]),
  ]),
  card: registerPropCards(cardContract, [
    propCard("size", [propValue("default"), propValue("sm")]),
    propCard("className", [
      propValue("max-w-xs", "Compact", { className: "max-w-xs" }),
      propValue("max-w-md", "Wide", { className: "max-w-md" }),
    ]),
    propCard("children", [
      propValue(
        "metric-card",
        "Metric card",
        { children: cardContract.fixtures[0].props.children },
        false,
      ),
      propValue(
        "summary-card",
        "Summary card",
        { children: cardContract.fixtures[1].props.children },
        false,
      ),
    ]),
  ]),
  metricSummaryGrid: registerPropCards(metricSummaryGridContract, [
    propCard("columns", [propValue(2), propValue(3), propValue(4)]),
    propCard("loading", [propValue(false), propValue(true)]),
  ]),
  sidebar: registerPropCards(sidebarContract, [
    propCard("side", [propValue("left"), propValue("right")]),
    propCard("variant", [
      propValue("sidebar"),
      propValue("floating"),
      propValue("inset"),
    ]),
    propCard("collapsible", [
      propValue("none"),
      propValue("icon"),
      propValue("offcanvas"),
    ]),
    propCard("defaultOpen", [propValue(true), propValue(false)]),
    propCard("open", [propValue(true), propValue(false)]),
  ]),
  animatedNumber: registerPropCards(animatedNumberContract, [
    propCard("value", [propValue(0), propValue(1284), propValue(12500.75)]),
    propCard("continuous", [propValue(false), propValue(true)]),
    propCard("className", [
      propValue("text-xl", "Small", { className: "font-mono text-xl" }),
      propValue("text-3xl", "Large", { className: "font-mono text-3xl" }),
    ]),
    propCard("style", [
      propValue("default-style", "Default color", { style: undefined }, false),
      propValue(
        "accent-style",
        "Accent color",
        { style: { color: "var(--primary)", fontWeight: 700 } },
        false,
      ),
    ]),
  ]),
  appOverlay: registerPropCards(appOverlayContract, [
    propCard("open", [
      propValue(false),
      propValue(true, "true", undefined, true, "on-demand"),
    ]),
  ]),
  autoResizer: registerPropCards(autoResizerContract, [
    propCard("animateHeight", [propValue(true), propValue(false)]),
    propCard("animateWidth", [propValue(false), propValue(true)]),
    propCard("duration", [propValue(0), propValue(0.3), propValue(0.6)]),
    propCard("ease", [
      propValue("easeInOut"),
      propValue("easeOut"),
      propValue("linear"),
    ]),
    propCard("initial", [propValue(false), propValue(true)]),
    propCard("className", [propValue("w-48"), propValue("w-72")]),
    propCard("children", [
      propValue(
        "short-content",
        "Short content",
        {
          children: createElement(
            "p",
            { className: "max-w-xs text-sm" },
            "A short measured block.",
          ),
        },
        false,
      ),
      propValue(
        "long-content",
        "Long content",
        {
          children: createElement(
            "p",
            { className: "max-w-xs text-sm" },
            "A longer content block that wraps across multiple lines.",
          ),
        },
        false,
      ),
    ]),
  ]),
  autoTransition: registerPropCards(autoTransitionContract, [
    propCard("type", [
      ...["fade", "slide", "scale", "slideUp", "slideDown", "crossFade"].map(
        (value) => propValue(value),
      ),
    ]),
    propCard("presenceMode", [
      propValue("sync"),
      propValue("wait"),
      propValue("popLayout"),
    ]),
    propCard("duration", [propValue(0.1), propValue(0.3), propValue(0.6)]),
    propCard("initial", [propValue(false), propValue(true)]),
    propCard("as", [propValue("div"), propValue("span"), propValue("li")]),
    propCard("transitionKey", [
      propValue("updated", "Updated", { children: "Updated content" }),
      propValue("loading", "Loading", { children: "Loading report…" }),
    ]),
    propCard("className", [propValue("text-sm"), propValue("text-base")]),
  ]),
  overlayScrollbar: registerPropCards(overlayScrollbarContract, [
    propCard("axis", [
      propValue("horizontal"),
      propValue("vertical", "vertical", {
        children: scrollbarItems(
          ["Direct", "Search", "Social", "Email", "Referral"],
          "flex flex-col gap-2 py-3",
        ),
        className: "h-40 w-80",
      }),
      propValue("both", "both", {
        children: scrollbarItems(
          [
            "Direct",
            "Search",
            "Social",
            "Email",
            "Referral",
            "Partner",
            "Campaign",
            "Other",
          ],
          "grid w-[36rem] grid-cols-2 gap-2 p-2",
        ),
        className: "h-40 w-80",
      }),
    ]),
    propCard("showEdgeMasks", [propValue(false), propValue(true)]),
    propCard("className", [
      propValue("w-64", "Narrow", { className: "w-64" }),
      propValue("w-96", "Wide", { className: "w-96" }),
    ]),
    propCard("maskClassName", [
      propValue(
        "default-mask",
        "Default mask",
        { maskClassName: undefined },
        false,
      ),
      propValue(
        "subtle-mask",
        "Subtle mask",
        {
          maskClassName: "from-card/40 via-card/20 to-transparent",
        },
        false,
      ),
    ]),
    propCard("options", [
      propValue(
        "move-to-show",
        "Show while moving",
        {
          options: {
            overflow: { x: "scroll", y: "hidden" },
            scrollbars: {
              theme: "os-theme-insightflare",
              autoHide: "move",
              autoHideDelay: 420,
              autoHideSuspend: false,
            },
          },
        },
        false,
      ),
      propValue(
        "always-visible",
        "Always visible",
        {
          options: {
            overflow: { x: "scroll", y: "hidden" },
            scrollbars: {
              theme: "os-theme-insightflare",
              autoHide: "never",
              autoHideDelay: 420,
              autoHideSuspend: false,
            },
          },
        },
        false,
      ),
    ]),
    propCard("contentClassName", [
      propValue("p-2", "Compact content", { contentClassName: "p-2" }),
      propValue("p-4", "Spacious content", { contentClassName: "p-4" }),
    ]),
    propCard("viewportClassName", [
      propValue("h-12", "Short viewport", { viewportClassName: "h-12" }),
      propValue("h-20", "Tall viewport", { viewportClassName: "h-20" }),
    ]),
    propCard("syncKey", [propValue("sources-a"), propValue("sources-b")]),
    propCard("children", [
      propValue(
        "five-sources",
        "Five sources",
        { children: overlayScrollbarContract.fixtures[0].props.children },
        false,
      ),
      propValue(
        "two-sources",
        "Two sources",
        {
          children: createElement(
            "div",
            { className: "flex w-[36rem] gap-2 py-3" },
            createElement(
              "span",
              { className: "border bg-card px-4 py-2 text-sm" },
              "Direct",
            ),
            createElement(
              "span",
              { className: "border bg-card px-4 py-2 text-sm" },
              "Search",
            ),
          ),
        },
        false,
      ),
    ]),
  ]),
  pageHeading: registerPropCards(pageHeadingContract, [
    propCard("title", [propValue("Goals"), propValue("Funnels")]),
    propCard("subtitle", [
      propValue(
        "Measure conversion from a single reusable event or page condition.",
      ),
      propValue("Measure conversion through multi-step user journeys."),
    ]),
    propCard("actions", [
      propValue("none", "No actions", { actions: undefined }, false),
      propValue(
        "new-goal",
        "New goal button",
        {
          actions: createElement(
            "button",
            {
              className: "border bg-primary px-3 py-2 text-primary-foreground",
            },
            "New goal",
          ),
        },
        false,
      ),
    ]),
  ]),
  toaster: registerPropCards(toasterContract, [
    propCard("theme", [
      propValue("light"),
      propValue("dark"),
      propValue("system"),
    ]),
    propCard("position", [
      ...[
        "bottom-right",
        "top-left",
        "top-center",
        "top-right",
        "bottom-left",
        "bottom-center",
      ].map((value) => propValue(value)),
    ]),
    propCard("richColors", [propValue(false), propValue(true)]),
    propCard("closeButton", [propValue(false), propValue(true)]),
    propCard("expand", [propValue(false), propValue(true)]),
    propCard("visibleToasts", [propValue(3), propValue(5)]),
    propCard("duration", [propValue(3000), propValue(5000), propValue(8000)]),
  ]),
  verticalScrollMask: registerPropCards(verticalScrollMaskContract, [
    propCard("className", [
      propValue("h-32 w-64"),
      propValue("h-44 w-72"),
      propValue("h-56 w-80"),
    ]),
    propCard("enabled", [propValue(true), propValue(false)]),
    propCard("maskClassName", [
      propValue(
        "default-mask",
        "Default mask",
        { maskClassName: undefined },
        false,
      ),
      propValue(
        "subtle-mask",
        "Subtle mask",
        {
          maskClassName: "from-card/40 via-card/20 to-transparent",
        },
        false,
      ),
    ]),
    propCard("scrollbarOptions", [
      propValue(
        "move-to-show",
        "Show while moving",
        {
          scrollbarOptions: {
            overflow: { x: "hidden", y: "scroll" },
            scrollbars: {
              theme: "os-theme-insightflare",
              autoHide: "move",
              autoHideDelay: 420,
              autoHideSuspend: false,
            },
          },
        },
        false,
      ),
      propValue(
        "always-visible",
        "Always visible",
        {
          scrollbarOptions: {
            overflow: { x: "hidden", y: "scroll" },
            scrollbars: {
              theme: "os-theme-insightflare",
              autoHide: "never",
              autoHideDelay: 420,
              autoHideSuspend: false,
            },
          },
        },
        false,
      ),
    ]),
    propCard("contentClassName", [
      propValue("p-2", "Compact content", { contentClassName: "p-2" }),
      propValue("p-4", "Spacious content", { contentClassName: "p-4" }),
    ]),
    propCard("syncKey", [propValue("content-a"), propValue("content-b")]),
    propCard("children", [
      propValue(
        "long-content",
        "Long content",
        { children: verticalScrollMaskContract.fixtures[0].props.children },
        false,
      ),
      propValue(
        "short-content",
        "Short content",
        {
          children: createElement(
            "div",
            { className: "space-y-3 p-4" },
            createElement(
              "p",
              { className: "border-b pb-2 text-sm" },
              "Acquisition summary",
            ),
            createElement(
              "p",
              { className: "border-b pb-2 text-sm" },
              "Top sources",
            ),
          ),
        },
        false,
      ),
    ]),
  ]),
  goalVisualization: registerPropCards(goalVisualizationContract, [
    propCard("visitors", [
      propValue(
        "current-period",
        "Current period",
        { visitors: goalVisualizationContract.fixtures[0].props.visitors },
        false,
      ),
      propValue(
        "with-comparison",
        "With comparison",
        { visitors: goalVisualizationContract.fixtures[2].props.visitors },
        false,
      ),
      propValue(
        "loading",
        "Loading",
        { visitors: goalVisualizationContract.fixtures[1].props.visitors },
        false,
      ),
    ]),
    propCard("sessions", [
      propValue(
        "current-period",
        "Current period",
        { sessions: goalVisualizationContract.fixtures[0].props.sessions },
        false,
      ),
      propValue(
        "with-comparison",
        "With comparison",
        { sessions: goalVisualizationContract.fixtures[2].props.sessions },
        false,
      ),
      propValue(
        "loading",
        "Loading",
        { sessions: goalVisualizationContract.fixtures[1].props.sessions },
        false,
      ),
    ]),
    propCard("visitorConversion", [
      propValue(
        "current-period",
        "Current period",
        {
          visitorConversion:
            goalVisualizationContract.fixtures[0].props.visitorConversion,
        },
        false,
      ),
      propValue(
        "with-comparison",
        "With comparison",
        {
          visitorConversion:
            goalVisualizationContract.fixtures[2].props.visitorConversion,
        },
        false,
      ),
      propValue(
        "loading",
        "Loading",
        {
          visitorConversion:
            goalVisualizationContract.fixtures[1].props.visitorConversion,
        },
        false,
      ),
    ]),
  ]),
  funnel: registerPropCards(
    funnelVisualizationContract,
    [
      propCard("state", [
        propValue("ready"),
        propValue("loading", "loading", {
          steps: funnelVisualizationContract.fixtures[2].props.steps,
          comparison: { state: "loading" },
        }),
      ]),
      propCard("locale", [propValue("en-US"), propValue("de-DE")]),
      propCard("labels", [
        propValue(
          "sessions-and-visitors",
          "Sessions and visitors",
          { labels: funnelVisualizationContract.fixtures[0].props.labels },
          false,
        ),
        propValue(
          "visits-and-signups",
          "Visits and sign-ups",
          {
            labels: {
              overallConversion: "Overall completion",
              converted: "completed visits",
            },
          },
          false,
        ),
      ]),
      propCard("steps", [
        propValue(
          "three-steps",
          "Three steps",
          { steps: funnelVisualizationContract.fixtures[0].props.steps },
          false,
        ),
        propValue(
          "two-steps",
          "Two steps",
          {
            steps: funnelVisualizationContract.fixtures[0].props.steps.slice(
              0,
              2,
            ),
          },
          false,
        ),
      ]),
      propCard("summary", [
        propValue(
          "summary-2400",
          "2,400 total",
          {
            summary: {
              overallConversionRate: 0.14,
              convertedProgressions: 336,
              totalProgressions: 2400,
            },
          },
          false,
        ),
        propValue(
          "summary-1200",
          "1,200 total",
          {
            summary: {
              overallConversionRate: 0.2,
              convertedProgressions: 240,
              totalProgressions: 1200,
            },
          },
          false,
        ),
      ]),
      propCard("comparison", [
        propValue("none", "No comparison", { comparison: undefined }, false),
        propValue(
          "ready",
          "Previous period",
          {
            comparison:
              funnelVisualizationContract.fixtures[0].props.comparison,
          },
          false,
        ),
      ]),
    ],
    { comparison: undefined },
  ),
  realtimeTrafficTrend: registerPropCards(realtimeTrafficTrendContract, [
    propCard("state", [propValue("ready"), propValue("loading")]),
    propCard("title", [
      propValue("Realtime traffic"),
      propValue("Live visitors"),
    ]),
    propCard("data", [
      propValue(
        "four-points",
        "Four points",
        { data: realtimeTrafficTrendContract.fixtures[0].props.data },
        false,
      ),
      propValue(
        "two-points",
        "Two points",
        {
          data: realtimeTrafficTrendContract.fixtures[0].props.data.slice(0, 2),
        },
        false,
      ),
    ]),
    propCard("locale", [propValue("en-US"), propValue("de-DE")]),
    propCard("viewsLabel", [propValue("Views"), propValue("Page views")]),
    propCard("visitorsLabel", [
      propValue("Visitors"),
      propValue("Unique visitors"),
    ]),
  ]),
  sharing: registerPropCards(
    shareBreakdownContract,
    [
      propCard("title", [
        propValue("Traffic sources"),
        propValue("Top channels"),
      ]),
      propCard("items", [
        propValue(
          "three-sources",
          "Three sources",
          { items: shareBreakdownContract.fixtures[0].props.items },
          false,
        ),
        propValue(
          "two-sources",
          "Two sources",
          { items: shareBreakdownContract.fixtures[0].props.items.slice(0, 2) },
          false,
        ),
      ]),
      propCard("loading", [propValue(false), propValue(true)]),
      propCard("comparisonItems", [
        propValue(
          "none",
          "No comparison",
          { comparisonItems: undefined },
          false,
        ),
        propValue(
          "previous period",
          "Previous period",
          {
            comparisonItems:
              shareBreakdownContract.fixtures[0].props.comparisonItems,
          },
          false,
        ),
      ]),
      propCard("maxItems", [propValue(2), propValue(4), propValue(6)]),
      propCard("comparisonLabel", [
        propValue("Previous period"),
        propValue("Last month"),
      ]),
      propCard("locale", [propValue("en-US"), propValue("de-DE")]),
      propCard("valueLabel", [propValue("visitors"), propValue("sessions")]),
      propCard("emptyLabel", [
        propValue("No traffic sources", "No traffic sources", {
          items: [],
          comparisonItems: undefined,
          loading: false,
        }),
        propValue("No channels available", "No channels available", {
          items: [],
          comparisonItems: undefined,
          loading: false,
        }),
      ]),
      propCard("className", [
        propValue("w-full", "Full width", { className: "w-full" }),
        propValue("max-w-xl", "Narrow", { className: "max-w-xl" }),
      ]),
    ],
    { comparisonItems: undefined },
  ),
  trafficPairBarChart: registerPropCards(
    defineComponentContract<{
      locale: string;
      comparison: boolean;
    }>({
      id: "traffic-pair-bar-chart",
      title: "Traffic pair bar chart",
      category: "Product UI / Analytics",
      categoryId: "product-analytics",
      fixtures: [
        {
          id: "default",
          title: "Traffic pair bar chart",
          props: { locale: "en-US", comparison: false },
        },
      ],
      render: ({ locale, comparison }) => {
        const traffic = [
          { timestampMs: 1_728_000_000_000, views: 128, visitors: 84 },
          { timestampMs: 1_728_086_400_000, views: 176, visitors: 112 },
          { timestampMs: 1_728_172_800_000, views: 142, visitors: 96 },
          { timestampMs: 1_728_259_200_000, views: 214, visitors: 151 },
          { timestampMs: 1_728_345_600_000, views: 189, visitors: 130 },
        ];

        return createElement(
          "div",
          { className: "w-full" },
          createElement(TrafficPairBarChart, {
            data: traffic,
            ...(comparison
              ? {
                  comparisonData: traffic.map((point) => ({
                    ...point,
                    views: point.views * 0.8,
                    visitors: point.visitors * 0.85,
                  })),
                }
              : {}),
            locale,
            timeZone: "UTC",
            interval: "day",
            viewsLabel: "Views",
            visitorsLabel: "Visitors",
            dataIsComplete: true,
            range: {
              from: traffic[0]!.timestampMs,
              to: traffic.at(-1)!.timestampMs,
            },
          }),
        );
      },
    }),
    [
      propCard("locale", [propValue("en-US"), propValue("zh-CN")]),
      propCard("comparison", [propValue(false), propValue(true)]),
    ],
  ),
  donutChart: registerPropCards(
    defineComponentContract<{
      locale: string;
      comparison: boolean;
    }>({
      id: "donut-chart",
      title: "Donut chart",
      category: "Product UI / Analytics",
      categoryId: "product-analytics",
      fixtures: [
        {
          id: "default",
          title: "Donut chart",
          props: { locale: "en-US", comparison: false },
        },
      ],
      render: ({ locale, comparison }) => {
        const sources = [
          {
            key: "search",
            label: "Search",
            value: 420,
            share: 42,
            color: "var(--color-chart-1)",
          },
          {
            key: "direct",
            label: "Direct",
            value: 310,
            share: 31,
            color: "var(--color-chart-2)",
          },
          {
            key: "social",
            label: "Social",
            value: 270,
            share: 27,
            color: "var(--color-chart-3)",
          },
        ];
        const comparisonColors = [
          "var(--color-chart-secondary-1)",
          "var(--color-chart-secondary-2)",
          "var(--color-chart-secondary-3)",
        ];

        return createElement(
          "div",
          { className: "mx-auto w-full max-w-sm" },
          createElement(DonutChart, {
            data: sources,
            ...(comparison
              ? {
                  comparisonData: sources.map((point, index) => ({
                    ...point,
                    value: Math.round(point.value * 0.82),
                    color: comparisonColors[index % comparisonColors.length]!,
                  })),
                }
              : {}),
            locale,
            valueLabel: "visitors",
          }),
        );
      },
    }),
    [
      propCard("locale", [propValue("en-US"), propValue("zh-CN")]),
      propCard("comparison", [propValue(false), propValue(true)]),
    ],
  ),
  tableActionButton: registerPropCards(
    defineComponentContract<{
      tone: "default" | "destructive";
      disabled: boolean;
    }>({
      id: "table-action-button",
      title: "Table action button",
      category: "Data display",
      categoryId: "data-display",
      fixtures: [
        {
          id: "default",
          title: "Table action button",
          props: { tone: "default", disabled: false },
        },
      ],
      render: ({ tone, disabled }) =>
        createElement(
          "div",
          { className: "flex w-full items-center gap-3" },
          createElement(TableActionButton, {
            label: tone === "destructive" ? "Delete row" : "More row actions",
            tone,
            disabled,
            children: createElement(RiMore2Line, { "aria-hidden": true }),
          }),
          createElement(
            "span",
            { className: "text-sm text-muted-foreground" },
            "Example table row",
          ),
        ),
    }),
    [
      propCard("tone", [propValue("default"), propValue("destructive")]),
      propCard("disabled", [propValue(false), propValue(true)]),
    ],
  ),
  clickableTableCell: registerPropCards(
    defineComponentContract<{ focusable: boolean }>({
      id: "clickable-table-cell",
      title: "Clickable table cell",
      category: "Data display",
      categoryId: "data-display",
      fixtures: [
        {
          id: "default",
          title: "Clickable table cell",
          props: { focusable: false },
        },
      ],
      render: ({ focusable }) =>
        createElement(
          "div",
          { className: "grid w-full gap-3" },
          createElement(
            Table,
            null,
            createElement(
              TableBody,
              null,
              createElement(
                TableRow,
                null,
                createElement(ClickableTableCellGalleryPreview, {
                  focusable,
                  ariaLabel: "Open /pricing",
                  onClick: () => {},
                  children: "/pricing",
                }),
                createElement(TableCell, { className: "text-right" }, "1,284"),
              ),
            ),
          ),
          createElement(
            "p",
            { className: "text-xs text-muted-foreground" },
            "Click the page cell to switch the selected row.",
          ),
        ),
    }),
    [propCard("focusable", [propValue(false), propValue(true)])],
  ),
  dataTableSwitch: registerPropCards(
    defineComponentContract<{
      state: "ready" | "loading" | "empty";
    }>({
      id: "data-table-switch",
      title: "Data table switch",
      category: "Data display",
      categoryId: "data-display",
      fixtures: [
        {
          id: "default",
          title: "Ready table",
          props: { state: "ready" },
        },
      ],
      render: ({ state }) =>
        createElement(
          "div",
          { className: "w-full border bg-card" },
          createElement(DataTableSwitch, {
            loading: state === "loading",
            hasContent: state === "ready",
            loadingLabel: "Loading pages…",
            emptyLabel: "No pages found.",
            colSpan: 2,
            loadingRowCount: 3,
            header: createElement(
              TableRow,
              null,
              createElement(TableHead, null, "Page"),
              createElement(TableHead, { className: "text-right" }, "Views"),
            ),
            rows:
              state === "ready"
                ? createElement(
                    Fragment,
                    null,
                    createElement(
                      TableRow,
                      null,
                      createElement(TableCell, null, "/pricing"),
                      createElement(
                        TableCell,
                        { className: "text-right tabular-nums" },
                        "1,284",
                      ),
                    ),
                    createElement(
                      TableRow,
                      null,
                      createElement(TableCell, null, "/docs/getting-started"),
                      createElement(
                        TableCell,
                        { className: "text-right tabular-nums" },
                        "946",
                      ),
                    ),
                  )
                : null,
            contentKey: state,
          }),
        ),
    }),
    [
      propCard("state", [
        propValue("ready"),
        propValue("loading"),
        propValue("empty"),
      ]),
    ],
  ),
  analyticsTableColumnSettings: registerPropCards(
    defineComponentContract<{ preset: "default" | "all-columns" }>({
      id: "analytics-table-column-settings",
      title: "Analytics table column settings",
      category: "Product UI / Analytics",
      categoryId: "product-analytics",
      fixtures: [
        {
          id: "default",
          title: "Analytics table column settings",
          props: { preset: "default" },
        },
      ],
      render: ({ preset }) => {
        const columns = COLUMN_SETTINGS_BASE_COLUMNS.map((column) => ({
          ...column,
          defaultVisible:
            preset === "all-columns" || column.defaultVisible !== false,
        }));
        const orderedIds = columns.map((column) => column.id);
        const visibleIds = columns
          .filter(
            (column) => column.required || column.defaultVisible !== false,
          )
          .map((column) => column.id);

        return createElement(AnalyticsTableColumnSettingsGalleryPreview, {
          key: preset,
          columns,
          orderedIds,
          visibleIds,
          onOrderChange: () => {},
          onVisibilityChange: () => {},
          onReset: () => {},
          labels: COLUMN_SETTINGS_LABELS,
        });
      },
    }),
    [
      propCard("preset", [
        propValue("default"),
        propValue("all-columns", "All columns visible"),
      ]),
    ],
  ),
  analyticsDataTable: registerPropCards(
    defineComponentContract<{
      loading: boolean;
      rows: readonly { id: string; page: string; views: string }[];
    }>({
      id: "analytics-data-table",
      title: "Analytics data table",
      category: "Product UI / Analytics",
      categoryId: "product-analytics",
      fixtures: [
        {
          id: "default",
          title: "Analytics table",
          props: {
            loading: false,
            rows: [
              { id: "pricing", page: "/pricing", views: "1,284" },
              { id: "docs", page: "/docs/getting-started", views: "946" },
              { id: "blog", page: "/blog/launch", views: "721" },
            ],
          },
        },
      ],
      render: ({ loading, rows }) =>
        createElement(
          AnalyticsDataTable<{ id: string; page: string; views: string }>,
          {
            loading,
            rows,
            header: createElement(
              "tr",
              null,
              createElement("th", { className: "px-4 py-3 text-left" }, "Page"),
              createElement(
                "th",
                { className: "px-4 py-3 text-right" },
                "Views",
              ),
            ),
            columnCount: 2,
            skeletonRows: 3,
            getRowKey: (row) => row.id,
            renderRow: (row) => ({
              children: createElement(
                Fragment,
                null,
                createElement("td", { className: "px-4 py-3" }, row.page),
                createElement(
                  "td",
                  { className: "px-4 py-3 text-right tabular-nums" },
                  row.views,
                ),
              ),
            }),
            renderSkeletonRow: () =>
              createElement(
                Fragment,
                null,
                createElement(
                  "td",
                  { className: "px-4 py-3" },
                  createElement("div", {
                    className: "h-4 w-40 animate-pulse bg-muted",
                  }),
                ),
                createElement(
                  "td",
                  { className: "px-4 py-3" },
                  createElement("div", {
                    className: "ml-auto h-4 w-16 animate-pulse bg-muted",
                  }),
                ),
              ),
            errorContent: "Unable to load pages.",
            emptyContent: "No pages found.",
            minTableWidth: "32rem",
          },
        ),
    }),
    [propCard("loading", [propValue(false), propValue(true)])],
  ),
  detailDrawer: registerPropCards(
    defineComponentContract<{ ariaLabel: string }>({
      id: "detail-drawer",
      title: "Detail drawer",
      category: "Product UI / Analytics",
      categoryId: "product-analytics",
      fixtures: [
        {
          id: "default",
          title: "Interactive detail drawer",
          props: { ariaLabel: "Session details" },
        },
      ],
      render: ({ ariaLabel }) =>
        createElement(DetailDrawerGalleryPreview, { ariaLabel }),
    }),
    [
      propCard("ariaLabel", [
        propValue("Session details"),
        propValue("Visitor details"),
      ]),
    ],
    {},
    ({ ariaLabel }) =>
      createElement(DetailDrawer, {
        ariaLabel,
        drawerKey: "ui-gallery-detail-drawer-example",
        open: true,
        onOpenChange: () => {},
        children: createElement(
          "div",
          { className: "space-y-2 p-6" },
          createElement(
            "h2",
            { className: "text-lg font-semibold" },
            ariaLabel,
          ),
          createElement(
            "p",
            { className: "text-sm text-muted-foreground" },
            `Details for ${ariaLabel.toLowerCase()}.`,
          ),
        ),
      }),
  ),
  siteScopeSelector: registerPropCards(
    defineComponentContract<Omit<SiteScopeSelectorProps, "onChange">>({
      id: "site-scope-selector",
      title: "Site scope selector",
      category: "Product UI / Management",
      categoryId: "product-management",
      fixtures: [
        {
          id: "default",
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
      ],
      render: (props) =>
        createElement(SiteScopeSelectorGalleryPreview, {
          ...props,
          key: props.selectedSiteIds.join(",") || "all-sites",
        }),
    }),
    [
      propCard("selectedSiteIds", [
        propValue("all", "All sites", { selectedSiteIds: [] }, false),
        propValue("one", "One site", { selectedSiteIds: ["site-news"] }, false),
        propValue(
          "multiple",
          "Multiple sites",
          { selectedSiteIds: ["site-news", "site-docs"] },
          false,
        ),
      ]),
    ],
    {},
    (props) =>
      createElement(SiteScopeSelector, {
        ...props,
        onChange: () => {},
      }),
  ),
  analyticsTooltip: registerPropCards(
    defineComponentContract<{
      retentionMode: "table-column" | "target";
    }>({
      id: "analytics-tooltip",
      title: "Analytics tooltip",
      category: "Product UI / Analytics",
      categoryId: "product-analytics",
      fixtures: [
        {
          id: "default",
          title: "Single moving tooltip",
          props: { retentionMode: "target" },
        },
      ],
      render: ({ retentionMode }) => {
        const examples = [
          { key: "timestamp", target: "14:32:08.221", title: "Timestamp" },
          { key: "request", target: "GET /pricing", title: "Request" },
          { key: "visitor", target: "visitor-1042", title: "Visitor" },
          { key: "duration", target: "184 ms", title: "Duration" },
        ];

        return createElement(AnalyticsTooltipProvider, {
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
              ...examples.map(({ key, target, title }) =>
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
        });
      },
    }),
    [
      propCard("retentionMode", [
        propValue("target"),
        propValue("table-column"),
      ]),
    ],
  ),
  tabbedTable: registerPropCards(tabbedTableContract, [
    propCard("state", [
      propValue("ready"),
      propValue("loading"),
      propValue("loading-more"),
      propValue("empty", "Empty", {
        rows: [],
        rowsByTab: { pages: [], sources: [] },
      }),
      propValue("error"),
    ]),
    propCard("defaultValue", [propValue("pages"), propValue("sources")]),
    propCard("headerHidden", [propValue(false), propValue(true)]),
  ]),
} as const;

export const uiGalleryRegistry: readonly UiGalleryEntry[] = [
  {
    slug: "button",
    packageType: "ui",
    apiEntry: "@insightflare/ui/button",
    contract: galleryContracts.button,
  },
  {
    slug: "button-group",
    packageType: "ui",
    apiEntry: "@insightflare/ui/button-group",
    contract: galleryContracts.buttonGroup,
  },
  {
    slug: "badge",
    packageType: "ui",
    apiEntry: "@insightflare/ui/badge",
    contract: galleryContracts.badge,
  },
  {
    slug: "async-content",
    packageType: "ui",
    apiEntry: "@insightflare/ui/async-content",
    contract: galleryContracts.asyncContent,
  },
  {
    slug: "calendar",
    packageType: "ui",
    apiEntry: "@insightflare/ui/calendar",
    contract: galleryContracts.calendar,
  },
  {
    slug: "checkbox",
    packageType: "ui",
    apiEntry: "@insightflare/ui/checkbox",
    contract: galleryContracts.checkbox,
  },
  {
    slug: "clickable",
    packageType: "ui",
    apiEntry: "@insightflare/ui/clickable",
    contract: galleryContracts.clickable,
  },
  {
    slug: "field",
    packageType: "ui",
    apiEntry: "@insightflare/ui/field",
    contract: galleryContracts.field,
  },
  {
    slug: "input",
    packageType: "ui",
    apiEntry: "@insightflare/ui/input",
    contract: galleryContracts.input,
  },
  {
    slug: "label",
    packageType: "ui",
    apiEntry: "@insightflare/ui/label",
    contract: galleryContracts.label,
  },
  {
    slug: "radio-group",
    packageType: "ui",
    apiEntry: "@insightflare/ui/radio-group",
    contract: galleryContracts.radioGroup,
  },
  {
    slug: "separator",
    packageType: "ui",
    apiEntry: "@insightflare/ui/separator",
    contract: galleryContracts.separator,
  },
  {
    slug: "skeleton",
    packageType: "ui",
    apiEntry: "@insightflare/ui/skeleton",
    contract: galleryContracts.skeleton,
  },
  {
    slug: "slider",
    packageType: "ui",
    apiEntry: "@insightflare/ui/slider",
    contract: galleryContracts.slider,
  },
  {
    slug: "spinner",
    packageType: "ui",
    apiEntry: "@insightflare/ui/spinner",
    contract: galleryContracts.spinner,
  },
  {
    slug: "switch",
    packageType: "ui",
    apiEntry: "@insightflare/ui/switch",
    contract: galleryContracts.switch,
  },
  {
    slug: "tabs",
    packageType: "ui",
    apiEntry: "@insightflare/ui/tabs",
    contract: galleryContracts.tabs,
  },
  {
    slug: "breadcrumb",
    packageType: "ui",
    apiEntry: "@insightflare/ui/breadcrumb",
    contract: galleryContracts.breadcrumb,
  },
  {
    slug: "page-heading",
    packageType: "ui",
    apiEntry: "@insightflare/ui/page-heading",
    previewAlignment: "centered-left",
    contract: galleryContracts.pageHeading,
  },
  {
    slug: "chart",
    packageType: "ui",
    apiEntry: "@insightflare/ui/chart",
    contract: galleryContracts.chart,
  },
  {
    slug: "json-tree",
    packageType: "ui",
    apiEntry: "@insightflare/ui/json-tree",
    contract: galleryContracts.jsonTree,
  },
  {
    slug: "select",
    packageType: "ui",
    apiEntry: "@insightflare/ui/select",
    contract: galleryContracts.select,
  },
  {
    slug: "searchable-popover",
    packageType: "ui",
    apiEntry: "@insightflare/ui/searchable-popover",
    contract: galleryContracts.searchablePopover,
  },
  {
    slug: "dialog",
    packageType: "ui",
    apiEntry: "@insightflare/ui/dialog",
    contract: galleryContracts.dialog,
  },
  {
    slug: "popover",
    packageType: "ui",
    apiEntry: "@insightflare/ui/popover",
    contract: galleryContracts.popover,
  },
  {
    slug: "tooltip",
    packageType: "ui",
    apiEntry: "@insightflare/ui/tooltip",
    contract: galleryContracts.tooltip,
  },
  {
    slug: "drawer",
    packageType: "ui",
    apiEntry: "@insightflare/ui/drawer",
    contract: galleryContracts.drawer,
  },
  {
    slug: "alert-dialog",
    packageType: "ui",
    apiEntry: "@insightflare/ui/alert-dialog",
    contract: galleryContracts.alertDialog,
  },
  {
    slug: "dropdown-menu",
    packageType: "ui",
    apiEntry: "@insightflare/ui/dropdown-menu",
    contract: galleryContracts.dropdownMenu,
  },
  {
    slug: "responsive-dialog",
    packageType: "ui",
    apiEntry: "@insightflare/ui/responsive-dialog",
    contract: galleryContracts.responsiveDialog,
  },
  {
    slug: "sheet",
    packageType: "ui",
    apiEntry: "@insightflare/ui/sheet",
    contract: galleryContracts.sheet,
  },
  {
    slug: "table",
    packageType: "ui",
    apiEntry: "@insightflare/ui/table",
    contract: galleryContracts.table,
  },
  {
    slug: "clickable-table-cell",
    packageType: "ui",
    apiEntry: "@insightflare/ui/clickable-table-cell",
    maxValuesPerRow: 2,
    previewAlignment: "start",
    contract: galleryContracts.clickableTableCell,
  },
  {
    slug: "data-table-switch",
    packageType: "ui",
    apiEntry: "@insightflare/ui/data-table-switch",
    maxValuesPerRow: 3,
    previewAlignment: "start",
    contract: galleryContracts.dataTableSwitch,
  },
  {
    slug: "table-action-button",
    packageType: "ui",
    apiEntry: "@insightflare/ui/table-action-button",
    maxValuesPerRow: 2,
    previewAlignment: "start",
    contract: galleryContracts.tableActionButton,
  },
  {
    slug: "card",
    packageType: "ui",
    apiEntry: "@insightflare/ui/card",
    contract: galleryContracts.card,
  },
  {
    slug: "metric-summary-grid",
    packageType: "ui",
    apiEntry: "@insightflare/ui/metric-summary-grid",
    maxValuesPerRow: 1,
    contract: galleryContracts.metricSummaryGrid,
  },
  {
    slug: "sidebar",
    packageType: "ui",
    apiEntry: "@insightflare/ui/sidebar",
    contract: galleryContracts.sidebar,
  },
  {
    slug: "animated-number",
    packageType: "ui",
    apiEntry: "@insightflare/ui/animated-number",
    contract: galleryContracts.animatedNumber,
  },
  {
    slug: "app-overlay",
    packageType: "ui",
    apiEntry: "@insightflare/ui/app-overlay",
    contract: galleryContracts.appOverlay,
  },
  {
    slug: "auto-resizer",
    packageType: "ui",
    apiEntry: "@insightflare/ui/auto-resizer",
    contract: galleryContracts.autoResizer,
  },
  {
    slug: "auto-transition",
    packageType: "ui",
    apiEntry: "@insightflare/ui/auto-transition",
    contract: galleryContracts.autoTransition,
  },
  {
    slug: "overlay-scrollbar",
    packageType: "ui",
    apiEntry: "@insightflare/ui/overlay-scrollbar",
    contract: galleryContracts.overlayScrollbar,
  },
  {
    slug: "sonner",
    packageType: "ui",
    apiEntry: "@insightflare/ui/sonner",
    contract: galleryContracts.toaster,
  },
  {
    slug: "vertical-scroll-mask",
    packageType: "ui",
    apiEntry: "@insightflare/ui/vertical-scroll-mask",
    contract: galleryContracts.verticalScrollMask,
  },
  {
    slug: "goal-visualization",
    packageType: "product-ui",
    apiEntry: "@insightflare/product-ui/goals",
    previewAlignment: "start",
    contract: galleryContracts.goalVisualization,
  },
  {
    slug: "funnel",
    packageType: "product-ui",
    apiEntry: "@insightflare/product-ui/funnel",
    previewAlignment: "start",
    contract: galleryContracts.funnel,
  },
  {
    slug: "realtime-traffic-trend",
    packageType: "product-ui",
    apiEntry: "@insightflare/product-ui/realtime",
    contract: galleryContracts.realtimeTrafficTrend,
  },
  {
    slug: "sharing",
    packageType: "product-ui",
    apiEntry: "@insightflare/product-ui/sharing",
    contract: galleryContracts.sharing,
  },
  {
    slug: "traffic-pair-bar-chart",
    packageType: "product-ui",
    apiEntry: "@insightflare/product-ui/charts",
    maxValuesPerRow: 2,
    previewAlignment: "start",
    contract: galleryContracts.trafficPairBarChart,
  },
  {
    slug: "donut-chart",
    packageType: "product-ui",
    apiEntry: "@insightflare/product-ui/charts",
    maxValuesPerRow: 2,
    contract: galleryContracts.donutChart,
  },
  {
    slug: "analytics-data-table",
    packageType: "product-ui",
    apiEntry: "@insightflare/product-ui/tables",
    maxValuesPerRow: 2,
    previewAlignment: "start",
    contract: galleryContracts.analyticsDataTable,
  },
  {
    slug: "analytics-table-column-settings",
    packageType: "product-ui",
    apiEntry: "@insightflare/product-ui/tables",
    maxValuesPerRow: 2,
    previewAlignment: "start",
    contract: galleryContracts.analyticsTableColumnSettings,
  },
  {
    slug: "detail-drawer",
    packageType: "product-ui",
    apiEntry: "@insightflare/product-ui/detail-drawer",
    maxValuesPerRow: 2,
    previewAlignment: "start",
    contract: galleryContracts.detailDrawer,
  },
  {
    slug: "site-scope-selector",
    packageType: "product-ui",
    apiEntry: "@insightflare/product-ui/site-scope-selector",
    previewAlignment: "start",
    contract: galleryContracts.siteScopeSelector,
  },
  {
    slug: "analytics-tooltip",
    packageType: "product-ui",
    apiEntry: "@insightflare/product-ui/analytics-tooltip",
    maxValuesPerRow: 3,
    contract: galleryContracts.analyticsTooltip,
  },
  {
    slug: "tabbed-table",
    packageType: "ui",
    apiEntry: "@insightflare/ui/tabbed-table",
    maxValuesPerRow: 3,
    previewAlignment: "start",
    contract: galleryContracts.tabbedTable,
  },
];

export function findUiGalleryEntry(slug: string | undefined) {
  return uiGalleryRegistry.find((entry) => entry.slug === slug) ?? null;
}

export function listUiGalleryCategories(): string[] {
  return [
    ...new Set(uiGalleryRegistry.map(({ contract }) => contract.categoryId)),
  ];
}
