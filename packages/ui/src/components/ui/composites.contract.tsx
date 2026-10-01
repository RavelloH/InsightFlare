import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import {
  type ComponentContract,
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  type AlertDialogProps,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  type BreadcrumbProps,
  BreadcrumbSeparator,
} from "./breadcrumb";
import { Button } from "./button";
import {
  type ChartConfig,
  ChartContainer,
  type ChartContainerProps,
} from "./chart";
import { Checkbox } from "./checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  type DropdownMenuProps,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  type ResponsiveDialogProps,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "./responsive-dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  type SheetProps,
  SheetTitle,
  SheetTrigger,
} from "./sheet";

const trafficChartConfig = {
  visitors: { label: "Visitors", color: "var(--chart-1)" },
  sessions: { label: "Sessions", color: "var(--chart-2)" },
} satisfies ChartConfig;

const trafficSeries = [
  { day: "Mon", visitors: 410, sessions: 320 },
  { day: "Tue", visitors: 520, sessions: 380 },
  { day: "Wed", visitors: 470, sessions: 355 },
  { day: "Thu", visitors: 620, sessions: 440 },
  { day: "Fri", visitors: 590, sessions: 425 },
  { day: "Sat", visitors: 710, sessions: 510 },
  { day: "Sun", visitors: 680, sessions: 495 },
];

export const breadcrumbFixtures = [
  {
    id: "breadcrumb.scenario.current-page",
    title: "Current page",
    presentation: { kind: "scenario", scenario: "current-page" },
    props: {
      children: (
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="#overview">Overview</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="#reports">Reports</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Traffic</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      ),
    } satisfies BreadcrumbProps,
  },
] as const satisfies readonly ComponentFixture<BreadcrumbProps>[];

export const breadcrumbContract = defineComponentContract<BreadcrumbProps>({
  id: "breadcrumb",
  title: "Breadcrumb",
  category: "Navigation",
  categoryId: "navigation",
  fixtures: breadcrumbFixtures,
  render: (props) => (
    <div className="flex w-full justify-center">
      <Breadcrumb {...props} />
    </div>
  ),
});

export const chartFixtures = [
  {
    id: "chart.scenario.traffic-trend",
    title: "Traffic trend",
    presentation: { kind: "scenario", scenario: "line-series" },
    props: {
      id: "gallery-traffic-trend",
      className: "h-64 w-full",
      config: trafficChartConfig,
      children: (
        <LineChart data={trafficSeries} margin={{ left: 8, right: 8, top: 12 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} />
          <YAxis width={36} tickLine={false} axisLine={false} />
          <Line
            dataKey="visitors"
            type="monotone"
            stroke="var(--color-visitors)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            dataKey="sessions"
            type="monotone"
            stroke="var(--color-sessions)"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      ),
    } satisfies ChartContainerProps,
  },
] as const satisfies readonly ComponentFixture<ChartContainerProps>[];

export const chartContract = defineComponentContract<ChartContainerProps>({
  id: "chart",
  title: "Chart primitives",
  category: "Data display",
  categoryId: "data-display",
  description:
    "Theme-aware chart surfaces and configuration for Recharts compositions.",
  fixtures: chartFixtures,
  render: (props) => <ChartContainer {...props} />,
});

export const dropdownMenuFixtures = [
  {
    id: "dropdown-menu.scenario.actions",
    title: "Actions menu",
    presentation: { kind: "scenario", scenario: "actions" },
    props: { defaultOpen: true } satisfies DropdownMenuProps,
  },
] as const satisfies readonly ComponentFixture<DropdownMenuProps>[];

export const dropdownMenuContract: ComponentContract<DropdownMenuProps> =
  defineComponentContract<DropdownMenuProps>({
    id: "dropdown-menu",
    title: "Dropdown menu",
    category: "Overlays",
    categoryId: "overlays",
    fixtures: dropdownMenuFixtures,
    render: (props) => (
      <DropdownMenu {...props}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Report actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Traffic report</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem>Export CSV</DropdownMenuItem>
          <DropdownMenuItem>Copy report link</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  });

export const alertDialogFixtures = [
  {
    id: "alert-dialog.scenario.confirmation",
    title: "Confirmation",
    presentation: { kind: "scenario", scenario: "confirmation" },
    props: { defaultOpen: true } satisfies AlertDialogProps,
  },
] as const satisfies readonly ComponentFixture<AlertDialogProps>[];

export const alertDialogContract: ComponentContract<AlertDialogProps> =
  defineComponentContract<AlertDialogProps>({
    id: "alert-dialog",
    title: "Alert dialog",
    category: "Overlays",
    categoryId: "overlays",
    fixtures: alertDialogFixtures,
    render: (props) => (
      <AlertDialog {...props}>
        <AlertDialogTrigger asChild>
          <Button variant="outline">Remove report</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove saved report?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  });

export const responsiveDialogFixtures = [
  {
    id: "responsive-dialog.scenario.details",
    title: "Responsive details",
    presentation: { kind: "scenario", scenario: "responsive-surface" },
    props: { defaultOpen: false } satisfies ResponsiveDialogProps,
  },
] as const satisfies readonly ComponentFixture<ResponsiveDialogProps>[];

export const responsiveDialogContract: ComponentContract<ResponsiveDialogProps> =
  defineComponentContract<ResponsiveDialogProps>({
    id: "responsive-dialog",
    title: "Responsive dialog",
    category: "Overlays",
    categoryId: "overlays",
    description:
      "Uses the dialog on wide screens and a drawer on small screens.",
    fixtures: responsiveDialogFixtures,
    render: (props) => (
      <ResponsiveDialog {...props}>
        <ResponsiveDialogTrigger asChild>
          <Button variant="outline">Open details</Button>
        </ResponsiveDialogTrigger>
        <ResponsiveDialogContent desktopClassName="w-full max-w-md">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Report details</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              A responsive overlay surface.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <p className="text-sm">
              The content remains scrollable across viewport sizes.
            </p>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button>Done</Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    ),
  });

type SheetScenarioProps = SheetProps & {
  readonly side?: "top" | "right" | "bottom" | "left";
};

export const sheetFixtures = [
  {
    id: "sheet.scenario.settings",
    title: "Settings panel",
    presentation: { kind: "scenario", scenario: "settings-panel" },
    props: { defaultOpen: false, side: "right" } satisfies SheetScenarioProps,
  },
] as const satisfies readonly ComponentFixture<SheetScenarioProps>[];

export const sheetContract: ComponentContract<SheetScenarioProps> =
  defineComponentContract<SheetScenarioProps>({
    id: "sheet",
    title: "Sheet",
    category: "Overlays",
    categoryId: "overlays",
    fixtures: sheetFixtures,
    render: ({ side = "right", ...sheetProps }) => (
      <Sheet {...sheetProps}>
        <SheetTrigger asChild>
          <Button variant="outline">Open settings</Button>
        </SheetTrigger>
        <SheetContent side={side}>
          <SheetHeader>
            <SheetTitle>Display settings</SheetTitle>
            <SheetDescription>
              Choose how this report is displayed.
            </SheetDescription>
          </SheetHeader>
          <div className="flex items-center gap-2 px-4 py-3 text-sm">
            <Checkbox defaultChecked aria-label="Compact rows" />
            <span>Compact rows</span>
          </div>
          <SheetFooter>
            <Button>Save settings</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    ),
  });
