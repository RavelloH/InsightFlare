"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { useLocation } from "@tanstack/react-router";

import { DetailDrawer } from "@/components/dashboard/site-pages/detail-drawer";
import { EventDetailDrawer } from "@/components/dashboard/site-pages/event-detail-drawer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OverlayFrame } from "@/components/ui/layer/layer-manager";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getMessages } from "@/lib/i18n/messages";

const FIXTURE_QUERY = "__layerFixture";
const DETAIL_COUNT = 5;
const SYNTHETIC_COUNT = 20;
const STRESS_MESSAGES = getMessages("zh");

type FixtureMode = "stress" | "synthetic" | null;

function fixtureMode(search: string): FixtureMode {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(search).get(FIXTURE_QUERY);
  return value === "stress" || value === "synthetic" ? value : null;
}

function SyntheticFrames() {
  return (
    <>
      {Array.from({ length: SYNTHETIC_COUNT }, (_, index) => (
        <OverlayFrame
          key={index}
          id={`e2e-synthetic-layer-${index}`}
          kind="command"
          open
        >
          <div data-layer-synthetic-index={index} />
        </OverlayFrame>
      ))}
    </>
  );
}

function StressControls({
  dialogOpen,
  eventDrawerOpen,
  filterOpen,
  onDialogOpenChange,
  onEventDrawerOpenChange,
  onFilterOpenChange,
}: {
  readonly dialogOpen: boolean;
  readonly eventDrawerOpen: boolean;
  readonly filterOpen: boolean;
  readonly onDialogOpenChange: (open: boolean) => void;
  readonly onEventDrawerOpenChange: (open: boolean) => void;
  readonly onFilterOpenChange: (open: boolean) => void;
}) {
  return (
    <div
      data-layer-fixture-stress=""
      className="pointer-events-auto flex flex-col gap-3 p-6"
    >
      <p className="text-sm font-medium">Layer system stress fixture</p>
      <Button
        type="button"
        onClick={() => onDialogOpenChange(true)}
        aria-label="Open stress dialog"
      >
        Open stress dialog
      </Button>
      <Button
        type="button"
        onClick={() => onEventDrawerOpenChange(true)}
        aria-label="Open stress event drawer"
      >
        Open stress event drawer
      </Button>
      <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stress dialog</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The filter dialog is a child frame of this dialog.
          </p>
          <Button
            type="button"
            onClick={() => onFilterOpenChange(true)}
            aria-label="Open stress filter dialog"
          >
            Open stress filter dialog
          </Button>
          <Dialog open={filterOpen} onOpenChange={onFilterOpenChange}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Stress filter dialog</DialogTitle>
              </DialogHeader>
              <Select defaultValue="first">
                <SelectTrigger aria-label="Stress filter select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="first">First filter value</SelectItem>
                  <SelectItem value="second">Second filter value</SelectItem>
                </SelectContent>
              </Select>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>
      <EventDetailDrawer
        locale="zh"
        messages={STRESS_MESSAGES}
        labels={STRESS_MESSAGES.events}
        siteId="e2e-layer-fixture"
        pathname="/zh/app/e2e-layer-fixture/goals"
        open={eventDrawerOpen}
        onOpenChange={onEventDrawerOpenChange}
        detail={null}
        loading
        error={false}
        eventKind="pageview"
      />
    </div>
  );
}

function StressFrames() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [eventDrawerOpen, setEventDrawerOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [openFrames, setOpenFrames] = useState(() =>
    Array.from({ length: DETAIL_COUNT }, () => true),
  );

  const closeFrame = (index: number, open: boolean) => {
    setOpenFrames((current) => {
      if (current[index] === open) return current;
      const next = [...current];
      next[index] = open;
      return next;
    });
  };

  const renderFrame = (index: number): ReactNode => {
    const isLeaf = index === DETAIL_COUNT - 1;
    return (
      <DetailDrawer
        ariaLabel={`Layer fixture detail ${index + 1}`}
        drawerKey={`e2e-layer-detail-${index}`}
        open={openFrames[index] ?? false}
        onOpenChange={(open) => closeFrame(index, open)}
      >
        <div
          data-layer-fixture-detail-index={index}
          className="pointer-events-none min-h-[132vh]"
        >
          {isLeaf ? (
            <StressControls
              dialogOpen={dialogOpen}
              eventDrawerOpen={eventDrawerOpen}
              filterOpen={filterOpen}
              onDialogOpenChange={setDialogOpen}
              onEventDrawerOpenChange={setEventDrawerOpen}
              onFilterOpenChange={setFilterOpen}
            />
          ) : null}
          {!isLeaf ? renderFrame(index + 1) : null}
        </div>
      </DetailDrawer>
    );
  };

  return renderFrame(0);
}

export function LayerSystemFixture() {
  const search = useLocation({ select: (location) => location.searchStr });
  const mode = fixtureMode(search);

  if (mode === "synthetic") return <SyntheticFrames />;
  if (mode === "stress") return <StressFrames />;
  return null;
}
