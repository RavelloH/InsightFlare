import { toast } from "sonner";

import {
  type ComponentContract,
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import { AnimatedNumber, type AnimatedNumberProps } from "./animated-number";
import { AppOverlay, type AppOverlayProps } from "./app-overlay";
import { AutoResizer, type AutoResizerProps } from "./auto-resizer";
import { AutoTransition, type AutoTransitionProps } from "./auto-transition";
import { Badge, type BadgeProps } from "./badge";
import { Button } from "./button";
import { ButtonGroup, type ButtonGroupProps } from "./button-group";
import { Calendar, type CalendarProps } from "./calendar";
import { Checkbox, type CheckboxProps } from "./checkbox";
import { Clickable, type ClickableProps } from "./clickable";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  type FieldProps,
} from "./field";
import { Label, type LabelProps } from "./label";
import {
  OverlayScrollbar,
  type OverlayScrollbarProps,
} from "./overlay-scrollbar";
import {
  RadioGroup,
  RadioGroupItem,
  type RadioGroupProps,
} from "./radio-group";
import { Separator, type SeparatorProps } from "./separator";
import { Skeleton, type SkeletonProps } from "./skeleton";
import { Slider, type SliderProps } from "./slider";
import { Toaster, type ToasterProps } from "./sonner";
import { Spinner, type SpinnerProps } from "./spinner";
import { Switch, type SwitchProps } from "./switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  type TabsProps,
  TabsTrigger,
} from "./tabs";
import {
  VerticalScrollMask,
  type VerticalScrollMaskProps,
} from "./vertical-scroll-mask";

export const badgeFixtures = [
  {
    id: "badge.variant.default",
    title: "Default",
    presentation: { kind: "axis", axis: "variant", value: "default" },
    props: { children: "Active" } satisfies BadgeProps,
  },
  {
    id: "badge.variant.outline",
    title: "Outline",
    presentation: { kind: "axis", axis: "variant", value: "outline" },
    props: { variant: "outline", children: "Pending" } satisfies BadgeProps,
  },
  {
    id: "badge.variant.destructive",
    title: "Destructive",
    presentation: { kind: "axis", axis: "variant", value: "destructive" },
    props: { variant: "destructive", children: "Failed" } satisfies BadgeProps,
  },
] as const satisfies readonly ComponentFixture<BadgeProps>[];

export const badgeContract = defineComponentContract<BadgeProps>({
  id: "badge",
  title: "Badge",
  category: "Feedback",
  categoryId: "feedback",
  description: "Compact labels for status and classification.",
  fixtures: badgeFixtures,
  render: (props) => <Badge {...props} />,
});

export const buttonGroupFixtures = [
  {
    id: "button-group.orientation.horizontal",
    title: "Horizontal actions",
    presentation: { kind: "axis", axis: "orientation", value: "horizontal" },
    props: {
      orientation: "horizontal",
      children: (
        <>
          <Button variant="outline">Previous</Button>
          <Button>Continue</Button>
        </>
      ),
    } satisfies ButtonGroupProps,
  },
  {
    id: "button-group.orientation.vertical",
    title: "Vertical actions",
    presentation: { kind: "axis", axis: "orientation", value: "vertical" },
    props: {
      orientation: "vertical",
      children: (
        <>
          <Button variant="outline">Month</Button>
          <Button variant="outline">Quarter</Button>
          <Button>Year</Button>
        </>
      ),
    } satisfies ButtonGroupProps,
  },
] as const satisfies readonly ComponentFixture<ButtonGroupProps>[];

export const buttonGroupContract = defineComponentContract<ButtonGroupProps>({
  id: "button-group",
  title: "Button group",
  category: "Inputs",
  categoryId: "inputs",
  description: "Related actions grouped with shared edges and focus order.",
  fixtures: buttonGroupFixtures,
  render: (props) => <ButtonGroup {...props} />,
});

export const calendarFixtures = [
  {
    id: "calendar.state.month",
    title: "Month selection",
    presentation: { kind: "scenario", scenario: "month-navigation" },
    props: {
      mode: "single",
      defaultMonth: new Date(2025, 8, 1),
      selected: new Date(2025, 8, 12),
    } satisfies CalendarProps,
  },
] as const satisfies readonly ComponentFixture<CalendarProps>[];

export const calendarContract = defineComponentContract<CalendarProps>({
  id: "calendar",
  title: "Calendar",
  category: "Inputs",
  categoryId: "inputs",
  description: "Date selection with a navigable month view.",
  fixtures: calendarFixtures,
  render: (props) => <Calendar {...props} />,
});

export const checkboxFixtures = [
  {
    id: "checkbox.state.checked",
    title: "Checked",
    presentation: { kind: "scenario", scenario: "checked" },
    props: {
      defaultChecked: true,
      "aria-label": "Include returning visitors",
    } satisfies CheckboxProps,
  },
  {
    id: "checkbox.state.disabled",
    title: "Disabled",
    presentation: { kind: "scenario", scenario: "disabled" },
    props: {
      disabled: true,
      "aria-label": "Unavailable option",
    } satisfies CheckboxProps,
  },
] as const satisfies readonly ComponentFixture<CheckboxProps>[];

export const checkboxContract: ComponentContract<CheckboxProps> =
  defineComponentContract<CheckboxProps>({
    id: "checkbox",
    title: "Checkbox",
    category: "Inputs",
    categoryId: "inputs",
    description: "A labeled binary choice with native keyboard support.",
    fixtures: checkboxFixtures,
    render: (props) => <Checkbox {...props} />,
  });

export const clickableFixtures = [
  {
    id: "clickable.state.interactive",
    title: "Interactive card action",
    presentation: { kind: "scenario", scenario: "keyboard-and-pointer" },
    props: {
      children: "Open report",
      "aria-label": "Open report",
    } satisfies ClickableProps,
  },
  {
    id: "clickable.state.disabled",
    title: "Disabled action",
    presentation: { kind: "scenario", scenario: "disabled" },
    props: {
      children: "Not available",
      disabled: true,
    } satisfies ClickableProps,
  },
] as const satisfies readonly ComponentFixture<ClickableProps>[];

export const clickableContract = defineComponentContract<ClickableProps>({
  id: "clickable",
  title: "Clickable",
  category: "Inputs",
  categoryId: "inputs",
  description: "A motion-enabled action surface with button keyboard behavior.",
  fixtures: clickableFixtures,
  render: (props) => <Clickable {...props} />,
});

export const fieldFixtures = [
  {
    id: "field.orientation.vertical",
    title: "Vertical field",
    presentation: { kind: "axis", axis: "orientation", value: "vertical" },
    props: {
      orientation: "vertical",
      children: (
        <FieldContent>
          <FieldLabel htmlFor="gallery-email">Work email</FieldLabel>
          <input
            id="gallery-email"
            className="h-9 border border-input bg-background px-3 text-sm"
            defaultValue="team@example.com"
          />
          <FieldDescription>
            We’ll send one concise product update each week.
          </FieldDescription>
        </FieldContent>
      ),
    } satisfies FieldProps,
  },
  {
    id: "field.orientation.horizontal",
    title: "Horizontal field",
    presentation: { kind: "axis", axis: "orientation", value: "horizontal" },
    props: {
      orientation: "horizontal",
      children: (
        <>
          <FieldContent>
            <FieldLabel htmlFor="gallery-weekly-digest">
              Weekly digest
            </FieldLabel>
            <FieldDescription>
              A short summary of your team’s activity.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="gallery-weekly-digest"
            defaultChecked
            aria-label="Weekly digest"
          />
        </>
      ),
      className: "items-center gap-4 bg-muted/20 p-4",
    } satisfies FieldProps,
  },
] as const satisfies readonly ComponentFixture<FieldProps>[];

export const fieldContract = defineComponentContract<FieldProps>({
  id: "field",
  title: "Field",
  category: "Inputs",
  categoryId: "inputs",
  description: "A composable layout for labels, controls, and helper copy.",
  fixtures: fieldFixtures,
  render: (props) => <Field {...props} />,
});

export const labelFixtures = [
  {
    id: "label.state.default",
    title: "Default",
    presentation: { kind: "scenario", scenario: "default" },
    props: { children: "Workspace name" } satisfies LabelProps,
  },
] as const satisfies readonly ComponentFixture<LabelProps>[];

export const labelContract: ComponentContract<LabelProps> =
  defineComponentContract<LabelProps>({
    id: "label",
    title: "Label",
    category: "Inputs",
    categoryId: "inputs",
    fixtures: labelFixtures,
    render: (props) => (
      <div className="flex w-full justify-center">
        <Label {...props} />
      </div>
    ),
  });

export const radioGroupFixtures = [
  {
    id: "radio-group.state.selection",
    title: "Reporting interval",
    presentation: { kind: "scenario", scenario: "selection" },
    props: {
      defaultValue: "weekly",
      "aria-label": "Reporting interval",
    } satisfies RadioGroupProps,
  },
] as const satisfies readonly ComponentFixture<RadioGroupProps>[];

export const radioGroupContract: ComponentContract<RadioGroupProps> =
  defineComponentContract<RadioGroupProps>({
    id: "radio-group",
    title: "Radio group",
    category: "Inputs",
    categoryId: "inputs",
    fixtures: radioGroupFixtures,
    render: (props) => (
      <div className="flex w-full justify-center">
        <div className="w-fit">
          <RadioGroup {...props}>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="daily" /> Daily
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="weekly" /> Weekly
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="monthly" /> Monthly
            </label>
          </RadioGroup>
        </div>
      </div>
    ),
  });

export const separatorFixtures = [
  {
    id: "separator.orientation.horizontal",
    title: "Horizontal",
    presentation: { kind: "axis", axis: "orientation", value: "horizontal" },
    props: { orientation: "horizontal" } satisfies SeparatorProps,
  },
  {
    id: "separator.orientation.vertical",
    title: "Vertical",
    presentation: { kind: "axis", axis: "orientation", value: "vertical" },
    props: { orientation: "vertical" } satisfies SeparatorProps,
  },
] as const satisfies readonly ComponentFixture<SeparatorProps>[];

export const separatorContract: ComponentContract<SeparatorProps> =
  defineComponentContract<SeparatorProps>({
    id: "separator",
    title: "Separator",
    category: "Foundations",
    categoryId: "foundations",
    fixtures: separatorFixtures,
    render: (props) =>
      props.orientation === "vertical" ? (
        <div className="mx-auto flex h-12 w-max items-center justify-center gap-3 whitespace-nowrap">
          <span className="text-xs text-muted-foreground">Traffic</span>
          <Separator {...props} className="!h-8 !w-px !self-center" />
          <span className="text-xs text-muted-foreground">Conversions</span>
        </div>
      ) : (
        <div className="flex w-56 flex-col items-center gap-2">
          <span className="text-xs text-muted-foreground">Traffic</span>
          <Separator {...props} />
          <span className="text-xs text-muted-foreground">Conversions</span>
        </div>
      ),
  });

export const skeletonFixtures = [
  {
    id: "skeleton.state.loading",
    title: "Loading placeholder",
    presentation: { kind: "scenario", scenario: "loading" },
    props: { className: "h-5 w-40" } satisfies SkeletonProps,
  },
] as const satisfies readonly ComponentFixture<SkeletonProps>[];

export const skeletonContract = defineComponentContract<SkeletonProps>({
  id: "skeleton",
  title: "Skeleton",
  category: "Feedback",
  categoryId: "feedback",
  fixtures: skeletonFixtures,
  render: (props) => (
    <div className="w-64 space-y-3">
      <Skeleton {...props} />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  ),
});

export const sliderFixtures = [
  {
    id: "slider.state.range",
    title: "Visitor threshold",
    presentation: { kind: "scenario", scenario: "range" },
    props: {
      defaultValue: [68],
      max: 100,
      step: 1,
      "aria-label": "Visitor threshold",
    } satisfies SliderProps,
  },
] as const satisfies readonly ComponentFixture<SliderProps>[];

export const sliderContract: ComponentContract<SliderProps> =
  defineComponentContract<SliderProps>({
    id: "slider",
    title: "Slider",
    category: "Inputs",
    categoryId: "inputs",
    fixtures: sliderFixtures,
    render: (props) => (
      <div
        className={
          props.orientation === "vertical"
            ? "mx-auto flex h-48 w-20 items-center justify-center"
            : "mx-auto flex w-72 justify-center"
        }
      >
        <Slider
          {...props}
          className={`${props.orientation === "vertical" ? "h-full w-8" : "w-full"} ${props.className ?? ""}`}
        />
      </div>
    ),
  });

export const spinnerFixtures = [
  {
    id: "spinner.state.loading",
    title: "Loading",
    presentation: { kind: "scenario", scenario: "loading" },
    props: { "aria-label": "Loading dashboard data" } satisfies SpinnerProps,
  },
] as const satisfies readonly ComponentFixture<SpinnerProps>[];

export const spinnerContract = defineComponentContract<SpinnerProps>({
  id: "spinner",
  title: "Spinner",
  category: "Feedback",
  categoryId: "feedback",
  fixtures: spinnerFixtures,
  render: (props) => <Spinner {...props} />,
});

export const switchFixtures = [
  {
    id: "switch.state.on",
    title: "On",
    presentation: { kind: "scenario", scenario: "on" },
    props: {
      defaultChecked: true,
      "aria-label": "Enable notifications",
    } satisfies SwitchProps,
  },
  {
    id: "switch.state.disabled",
    title: "Disabled",
    presentation: { kind: "scenario", scenario: "disabled" },
    props: {
      disabled: true,
      "aria-label": "Unavailable setting",
    } satisfies SwitchProps,
  },
] as const satisfies readonly ComponentFixture<SwitchProps>[];

export const switchContract: ComponentContract<SwitchProps> =
  defineComponentContract<SwitchProps>({
    id: "switch",
    title: "Switch",
    category: "Inputs",
    categoryId: "inputs",
    fixtures: switchFixtures,
    render: (props) => <Switch {...props} />,
  });

export const tabsFixtures = [
  {
    id: "tabs.scenario.analytics",
    title: "Analytics sections",
    presentation: { kind: "scenario", scenario: "tab-switching" },
    props: {
      defaultValue: "overview",
      "aria-label": "Analytics sections",
    } satisfies TabsProps,
  },
] as const satisfies readonly ComponentFixture<TabsProps>[];

type TabsScenarioProps = TabsProps & { variant?: "default" | "line" };

export const tabsContract: ComponentContract<TabsScenarioProps> =
  defineComponentContract<TabsScenarioProps>({
    id: "tabs",
    title: "Tabs",
    category: "Navigation",
    categoryId: "navigation",
    fixtures: tabsFixtures,
    render: ({ variant = "default", ...props }) => (
      <div className="flex w-full justify-center">
        <Tabs {...props} className="w-fit items-center">
          <TabsList variant={variant}>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="sources">Sources</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="p-3 text-center">
            Overview metrics
          </TabsContent>
          <TabsContent value="sources" className="p-3 text-center">
            Top acquisition sources
          </TabsContent>
        </Tabs>
      </div>
    ),
  });

export const animatedNumberFixtures = [
  {
    id: "animated-number.value.integer",
    title: "Integer",
    presentation: { kind: "scenario", scenario: "integer" },
    props: {
      value: 1284,
      className: "font-mono text-2xl tabular-nums",
    } satisfies AnimatedNumberProps,
  },
  {
    id: "animated-number.value.decimal",
    title: "Decimal",
    presentation: { kind: "scenario", scenario: "decimal" },
    props: {
      value: 12.5,
      className: "font-mono text-2xl tabular-nums",
    } satisfies AnimatedNumberProps,
  },
] as const satisfies readonly ComponentFixture<AnimatedNumberProps>[];

export const animatedNumberContract =
  defineComponentContract<AnimatedNumberProps>({
    id: "animated-number",
    title: "Animated number",
    category: "Data display",
    categoryId: "data-display",
    fixtures: animatedNumberFixtures,
    render: (props) => <AnimatedNumber {...props} />,
  });

export const autoResizerFixtures = [
  {
    id: "auto-resizer.scenario.height",
    title: "Content height",
    presentation: { kind: "scenario", scenario: "height" },
    props: {
      children: (
        <p className="max-w-xs text-sm">
          This content stays measured as its layout changes.
        </p>
      ),
      duration: 0.4,
      animateHeight: true,
      initial: true,
    } satisfies AutoResizerProps,
  },
] as const satisfies readonly ComponentFixture<AutoResizerProps>[];

export const autoResizerContract = defineComponentContract<AutoResizerProps>({
  id: "auto-resizer",
  title: "Auto resizer",
  category: "Foundations",
  categoryId: "foundations",
  fixtures: autoResizerFixtures,
  render: (props) => (
    <div className="flex w-full justify-center">
      <AutoResizer {...props} />
    </div>
  ),
});

export const autoTransitionFixtures = [
  {
    id: "auto-transition.type.fade",
    title: "Fade",
    presentation: { kind: "axis", axis: "type", value: "fade" },
    props: {
      children: "Updated content",
      className:
        "inline-flex min-h-12 min-w-48 items-center justify-center border bg-card px-6 font-mono text-sm",
      type: "fade",
      initial: true,
      duration: 0.45,
      transitionKey: "fade",
    } satisfies AutoTransitionProps,
  },
  {
    id: "auto-transition.type.slide",
    title: "Slide",
    presentation: { kind: "axis", axis: "type", value: "slide" },
    props: {
      children: "Updated content",
      className:
        "inline-flex min-h-12 min-w-48 items-center justify-center border bg-card px-6 font-mono text-sm",
      type: "slide",
      initial: true,
      duration: 0.45,
      transitionKey: "slide",
    } satisfies AutoTransitionProps,
  },
] as const satisfies readonly ComponentFixture<AutoTransitionProps>[];

export const autoTransitionContract =
  defineComponentContract<AutoTransitionProps>({
    id: "auto-transition",
    title: "Auto transition",
    category: "Foundations",
    categoryId: "foundations",
    fixtures: autoTransitionFixtures,
    render: (props) => <AutoTransition {...props} />,
  });

export const appOverlayFixtures = [
  {
    id: "app-overlay.state.open",
    title: "Open backdrop",
    presentation: { kind: "scenario", scenario: "open" },
    props: {
      open: true,
      layerId: "gallery-preview",
      className: "z-10 bg-black/50 backdrop-blur-sm pointer-events-none",
    } satisfies AppOverlayProps,
  },
] as const satisfies readonly ComponentFixture<AppOverlayProps>[];

export const appOverlayContract = defineComponentContract<AppOverlayProps>({
  id: "app-overlay",
  title: "App overlay",
  category: "Overlays",
  categoryId: "overlays",
  fixtures: appOverlayFixtures,
  render: (props) => (
    <div className="relative h-40 w-full max-w-lg transform-gpu overflow-hidden border bg-background p-4">
      <div className="relative z-0 grid h-full content-center gap-3">
        <div className="flex items-center justify-between border-b pb-2">
          <span className="font-medium">Analytics dashboard</span>
          <span className="text-xs text-muted-foreground">Live</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            ["Visitors", "1,284", "w-4/5"],
            ["Conversions", "186", "w-3/5"],
            ["Revenue", "$8.4k", "w-2/3"],
          ].map(([label, value, width]) => (
            <div key={label} className="border bg-card p-2">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1 font-mono font-semibold">{value}</p>
              <div className="mt-2 h-1 bg-muted">
                <div className={`h-full ${width} bg-primary`} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <AppOverlay {...props} />
    </div>
  ),
});

export const overlayScrollbarFixtures = [
  {
    id: "overlay-scrollbar.axis.horizontal",
    title: "Horizontal overflow",
    presentation: { kind: "axis", axis: "axis", value: "horizontal" },
    props: {
      axis: "horizontal",
      showEdgeMasks: true,
      className: "w-80",
      maskClassName: "from-card via-card/80 to-transparent",
      children: (
        <div className="flex w-[36rem] gap-2 py-3">
          {["Direct", "Search", "Social", "Email", "Referral"].map((label) => (
            <span key={label} className="border bg-card px-4 py-2 text-sm">
              {label}
            </span>
          ))}
        </div>
      ),
    } satisfies OverlayScrollbarProps,
  },
] as const satisfies readonly ComponentFixture<OverlayScrollbarProps>[];

export const overlayScrollbarContract =
  defineComponentContract<OverlayScrollbarProps>({
    id: "overlay-scrollbar",
    title: "Overlay scrollbar",
    category: "Foundations",
    categoryId: "foundations",
    fixtures: overlayScrollbarFixtures,
    render: (props) => (
      <OverlayScrollbar
        {...props}
        className={`mx-auto w-80 ${props.axis === "horizontal" ? "" : "h-40"} ${props.className ?? ""}`}
        maskClassName={
          props.maskClassName ?? "from-card via-card/80 to-transparent"
        }
      />
    ),
  });

export const verticalScrollMaskFixtures = [
  {
    id: "vertical-scroll-mask.scenario.long-content",
    title: "Long content",
    presentation: { kind: "scenario", scenario: "long-content" },
    props: {
      className: "h-44 w-72 border",
      maskClassName: "from-card via-card/80 to-transparent",
      children: (
        <div className="space-y-3 p-4">
          {Array.from({ length: 8 }, (_, index) => (
            <p key={index} className="border-b pb-2 text-sm">
              Acquisition report section {index + 1}
            </p>
          ))}
        </div>
      ),
    } satisfies VerticalScrollMaskProps,
  },
] as const satisfies readonly ComponentFixture<VerticalScrollMaskProps>[];

export const verticalScrollMaskContract =
  defineComponentContract<VerticalScrollMaskProps>({
    id: "vertical-scroll-mask",
    title: "Vertical scroll mask",
    category: "Foundations",
    categoryId: "foundations",
    fixtures: verticalScrollMaskFixtures,
    render: (props) => (
      <VerticalScrollMask
        {...props}
        maskClassName={
          props.maskClassName ?? "from-card via-card/80 to-transparent"
        }
      />
    ),
  });

export const toasterFixtures = [
  {
    id: "toaster.theme.light",
    title: "Light theme host",
    presentation: { kind: "axis", axis: "theme", value: "light" },
    props: {
      theme: "light",
      id: "gallery-light",
      position: "bottom-right",
      visibleToasts: 1,
    } satisfies ToasterProps,
  },
  {
    id: "toaster.theme.dark",
    title: "Dark theme host",
    presentation: { kind: "axis", axis: "theme", value: "dark" },
    props: {
      theme: "dark",
      id: "gallery-dark",
      position: "bottom-right",
      visibleToasts: 1,
    } satisfies ToasterProps,
  },
] as const satisfies readonly ComponentFixture<ToasterProps>[];

export const toasterContract = defineComponentContract<ToasterProps>({
  id: "sonner",
  title: "Toaster",
  category: "Feedback",
  categoryId: "feedback",
  description:
    "A theme-controlled toast host that leaves theme choice to its consumer.",
  fixtures: toasterFixtures,
  render: (props) => {
    const toasterId = props.id ?? "gallery-toaster";

    return (
      <div className="relative mx-auto flex h-72 w-full max-w-sm transform-gpu flex-col items-center justify-center gap-4 overflow-hidden border bg-background">
        <Toaster {...props} id={toasterId} />
        <Button
          variant="outline"
          data-toast-target={toasterId}
          onClick={(event) => {
            const target = event.currentTarget.dataset.toastTarget;
            if (target) {
              toast.success("Settings saved", { toasterId: target });
            }
          }}
        >
          Show toast
        </Button>
      </div>
    );
  },
});
