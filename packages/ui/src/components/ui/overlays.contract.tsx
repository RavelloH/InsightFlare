import {
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import { Button } from "./button";
import type { DialogProps } from "./dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import type { DrawerProps } from "./drawer";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer";
import { Popover, type PopoverRootProps } from "./popover";
import type { TooltipProps } from "./tooltip";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

type DialogScenarioProps = DialogProps & {
  readonly title: string;
  readonly description: string;
};

const dialogFixtures = [
  {
    id: "dialog.scenario.confirmation",
    title: "Confirmation",
    presentation: { kind: "scenario", scenario: "confirmation" },
    props: {
      title: "Review changes",
      description: "This dialog opens from its trigger and can be dismissed.",
    },
  },
] as const satisfies readonly ComponentFixture<DialogScenarioProps>[];

export const dialogContract = defineComponentContract<DialogScenarioProps>({
  id: "dialog",
  title: "Dialog",
  category: "Overlays",
  categoryId: "overlays",
  description:
    "Modal content with an active trigger, close action, and focus management.",
  fixtures: dialogFixtures,
  render: ({ title, description, ...dialogProps }) => (
    <Dialog {...dialogProps}>
      <DialogTrigger asChild>
        <Button variant="outline">Open dialog</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  ),
});

type PopoverScenarioProps = PopoverRootProps & {
  readonly heading: string;
  readonly message: string;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
};

const popoverFixtures = [
  {
    id: "popover.scenario.preview",
    title: "Preview",
    presentation: { kind: "scenario", scenario: "interactive preview" },
    props: {
      heading: "Quick details",
      message: "Popover content is positioned relative to the trigger.",
    },
  },
] as const satisfies readonly ComponentFixture<PopoverScenarioProps>[];

export const popoverContract = defineComponentContract<PopoverScenarioProps>({
  id: "popover",
  title: "Popover",
  category: "Overlays",
  categoryId: "overlays",
  description: "A floating panel that opens from a real button trigger.",
  fixtures: popoverFixtures,
  render: ({
    heading,
    message,
    side = "bottom",
    align = "center",
    ...popoverProps
  }) => (
    <Popover.Root {...popoverProps}>
      <Popover.Trigger asChild>
        <Button variant="outline">Open details</Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          className="w-64 border bg-popover p-4 text-popover-foreground"
        >
          <h3 className="font-medium">{heading}</h3>
          <p className="mt-1 text-muted-foreground">{message}</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  ),
});

type TooltipScenarioProps = TooltipProps & {
  readonly label: string;
  readonly description: string;
  readonly delayDuration?: number;
  readonly skipDelayDuration?: number;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly sideOffset?: number;
};

const tooltipFixtures = [
  {
    id: "tooltip.scenario.help",
    title: "Help tooltip",
    presentation: { kind: "scenario", scenario: "hover or focus" },
    props: { label: "What is this?", description: "A short contextual hint." },
  },
] as const satisfies readonly ComponentFixture<TooltipScenarioProps>[];

export const tooltipContract = defineComponentContract<TooltipScenarioProps>({
  id: "tooltip",
  title: "Tooltip",
  category: "Overlays",
  categoryId: "overlays",
  description: "A contextual hint revealed by pointer hover or keyboard focus.",
  fixtures: tooltipFixtures,
  render: ({
    label,
    description,
    delayDuration,
    skipDelayDuration,
    side,
    sideOffset,
    ...tooltipProps
  }) => (
    <TooltipProvider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
    >
      <Tooltip {...tooltipProps}>
        <TooltipTrigger asChild>
          <Button variant="outline">{label}</Button>
        </TooltipTrigger>
        <TooltipContent side={side} sideOffset={sideOffset}>
          {description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
});

type DrawerScenarioProps = DrawerProps & {
  readonly title: string;
  readonly description: string;
};

const drawerFixtures = [
  {
    id: "drawer.scenario.details",
    title: "Details",
    presentation: { kind: "scenario", scenario: "interactive drawer" },
    props: {
      title: "Session details",
      description: "Use the close button or swipe down to dismiss this drawer.",
      defaultOpen: false,
    },
  },
] as const satisfies readonly ComponentFixture<DrawerScenarioProps>[];

export const drawerContract = defineComponentContract<DrawerScenarioProps>({
  id: "drawer",
  title: "Drawer",
  category: "Overlays",
  categoryId: "overlays",
  description:
    "A responsive sliding panel with the existing overlay stack behavior.",
  fixtures: drawerFixtures,
  render: ({ title, description, ...drawerProps }) => (
    <Drawer {...drawerProps}>
      <DrawerTrigger asChild>
        <Button variant="outline">Open drawer</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
          <p className="text-muted-foreground">{description}</p>
        </DrawerHeader>
        <div className="min-h-56 space-y-3 px-4 pb-6 text-sm">
          <p>Landing page viewed from a search result.</p>
          <p>Session started 4 minutes ago and includes 8 page views.</p>
          <div className="border bg-card p-3">
            <p className="font-medium">Current activity</p>
            <p className="mt-1 text-muted-foreground">Pricing → Sign up</p>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  ),
});
