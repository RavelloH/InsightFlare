import { RiDeleteBinLine, RiDraggable, RiFilter2Line } from "@remixicon/react";
import { Reorder, useDragControls } from "motion/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FunnelStep } from "@/lib/edge-client";
import {
  analyticsFilterRegistry,
  filterConditionCount,
  parseFilterDsl,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";

function conditionCount(filterDsl: string): number {
  try {
    return filterConditionCount(
      parseFilterDsl(filterDsl, analyticsFilterRegistry),
    );
  } catch {
    return 0;
  }
}

export function FunnelStepRow({
  step,
  index,
  total,
  onChange,
  onDelete,
  onFilter,
  labels,
}: {
  readonly step: FunnelStep;
  readonly index: number;
  readonly total: number;
  readonly onChange: (patch: Partial<FunnelStep>) => void;
  readonly onDelete: () => void;
  readonly onFilter: () => void;
  readonly labels: AppMessages["funnels"];
}) {
  const controls = useDragControls();
  const count = conditionCount(step.filterDsl);

  return (
    <Reorder.Item
      value={step}
      id={step.id}
      dragListener={false}
      dragControls={controls}
      className="flex min-w-0 items-center gap-2 border bg-muted/20 p-2"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`${labels.dragStep} ${index + 1}`}
        onPointerDown={(event) => controls.start(event)}
        className="cursor-grab touch-none active:cursor-grabbing"
      >
        <RiDraggable />
      </Button>
      <span className="sr-only">
        {labels.step} {index + 1}
      </span>
      <Input
        value={step.name ?? ""}
        onChange={(event) =>
          onChange({ name: event.target.value || undefined })
        }
        placeholder={labels.unnamed}
        aria-label={`${labels.step} ${index + 1} ${labels.nameLabel}`}
        className="min-w-0 flex-1"
      />
      <Button
        type="button"
        variant="outline"
        onClick={onFilter}
        className="w-28 shrink-0 justify-center"
      >
        <RiFilter2Line />
        <span>
          {labels.filter}
          {count > 0 ? ` (${count})` : ""}
        </span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`${labels.removeStep} ${index + 1}`}
        disabled={total <= 2}
        onClick={onDelete}
      >
        <RiDeleteBinLine />
      </Button>
    </Reorder.Item>
  );
}
