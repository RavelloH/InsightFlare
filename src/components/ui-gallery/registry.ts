import {
  createElement,
  type ElementType,
  Fragment,
  isValidElement,
  type ReactNode,
} from "react";
import { funnelVisualizationContract } from "@insightflare/product-ui/funnel";
import { goalVisualizationContract } from "@insightflare/product-ui/goals";
import { realtimeTrafficTrendContract } from "@insightflare/product-ui/realtime";
import { shareBreakdownContract } from "@insightflare/product-ui/sharing";
import type { ComponentContract } from "@insightflare/ui/contracts";
import {
  alertDialogContract,
  animatedNumberContract,
  appOverlayContract,
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
  dialogContract,
  drawerContract,
  dropdownMenuContract,
  fieldContract,
  inputContract,
  labelContract,
  overlayScrollbarContract,
  popoverContract,
  radioGroupContract,
  responsiveDialogContract,
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
import { RiAddLine } from "@remixicon/react";
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
}

export interface UiGalleryEntry {
  readonly slug: string;
  readonly packageType: "ui" | "product-ui";
  readonly apiEntry: string;
  readonly maxValuesPerRow?: number;
  readonly previewAlignment?: "center" | "start";
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
): UiGalleryContract {
  const defaultProps = {
    ...contract.fixtures[0]?.props,
    ...defaultOverrides,
  } as Props;
  const componentType = findComponentType(contract.render(defaultProps));

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
      Object.assign(props, previewOverrides);
      if (contract.id === "sonner") {
        props.id = `ui-gallery-${cardId}-${valueId}`;
      }
      return contract.render(props as Props);
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

const galleryContracts = {
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

export const uiGalleryRegistry = [
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
    slug: "chart",
    packageType: "ui",
    apiEntry: "@insightflare/ui/chart",
    contract: galleryContracts.chart,
  },
  {
    slug: "select",
    packageType: "ui",
    apiEntry: "@insightflare/ui/select",
    contract: galleryContracts.select,
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
    slug: "card",
    packageType: "ui",
    apiEntry: "@insightflare/ui/card",
    contract: galleryContracts.card,
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
    slug: "tabbed-table",
    packageType: "ui",
    apiEntry: "@insightflare/ui/tabbed-table",
    maxValuesPerRow: 3,
    previewAlignment: "start",
    contract: galleryContracts.tabbedTable,
  },
] as const satisfies readonly UiGalleryEntry[];

export function findUiGalleryEntry(slug: string | undefined) {
  return uiGalleryRegistry.find((entry) => entry.slug === slug) ?? null;
}

export function listUiGalleryCategories(): string[] {
  return [
    ...new Set(uiGalleryRegistry.map(({ contract }) => contract.categoryId)),
  ];
}
