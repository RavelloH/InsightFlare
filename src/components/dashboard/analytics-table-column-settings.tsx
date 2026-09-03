import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiDraggable,
  RiLayoutColumnLine,
  RiRefreshLine,
} from "@remixicon/react";
import { Reorder, useDragControls } from "motion/react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import {
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/ui/responsive-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const STORAGE_VERSION = 1;

export interface AnalyticsTableColumnDefinition<TId extends string = string> {
  id: TId;
  label: string;
  required?: boolean;
}

export interface AnalyticsTableColumnSettingsLabels {
  action: string;
  title: string;
  description: string;
  visible: string;
  required: string;
  reset: string;
  dragHint: string;
  close: string;
}

interface StoredColumnState {
  version: number;
  order: string[];
  visible: string[];
}

interface ColumnState {
  order: string[];
  visible: string[];
}

function readStoredColumnState(storageKey: string): StoredColumnState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredColumnState>;
    if (
      parsed.version !== STORAGE_VERSION ||
      !Array.isArray(parsed.order) ||
      !Array.isArray(parsed.visible)
    ) {
      return null;
    }

    return {
      version: STORAGE_VERSION,
      order: parsed.order.filter(
        (value): value is string => typeof value === "string",
      ),
      visible: parsed.visible.filter(
        (value): value is string => typeof value === "string",
      ),
    };
  } catch {
    return null;
  }
}

function normalizeColumnState(
  columns: readonly AnalyticsTableColumnDefinition[],
  stored: StoredColumnState | null,
): ColumnState {
  const defaultOrder = columns.map((column) => column.id);
  const availableIds = new Set(defaultOrder);
  const requiredIds = columns
    .filter((column) => column.required)
    .map((column) => column.id);
  if (!stored) {
    return {
      order: defaultOrder,
      visible: defaultOrder,
    };
  }

  const order = [...(stored?.order ?? []), ...defaultOrder].filter(
    (id, index, values) => {
      return availableIds.has(id) && values.indexOf(id) === index;
    },
  );
  const storedIds = new Set([
    ...(stored?.order ?? []),
    ...(stored?.visible ?? []),
  ]);
  const newColumnIds = defaultOrder.filter((id) => !storedIds.has(id));
  const visible = [
    ...(stored?.visible ?? []),
    ...requiredIds,
    ...newColumnIds,
  ].filter((id, index, values) => {
    return availableIds.has(id) && values.indexOf(id) === index;
  });

  return {
    order,
    visible: visible.length > 0 ? visible : defaultOrder,
  };
}

export function useAnalyticsTableColumns<TId extends string = string>({
  storageKey,
  columns,
}: {
  storageKey: string;
  columns: readonly AnalyticsTableColumnDefinition<TId>[];
}) {
  const schemaKey = useMemo(
    () =>
      columns
        .map((column) => `${column.id}:${column.required ? "required" : ""}`)
        .join("|"),
    [columns],
  );
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const [state, setState] = useState<ColumnState>(() =>
    normalizeColumnState(columns, null),
  );
  const [storageHydrated, setStorageHydrated] = useState(false);

  useEffect(() => {
    setState(
      normalizeColumnState(
        columnsRef.current,
        readStoredColumnState(storageKey),
      ),
    );
    setStorageHydrated(true);
  }, [schemaKey, storageKey]);

  useEffect(() => {
    if (!storageHydrated || typeof window === "undefined") return;

    const stored: StoredColumnState = {
      version: STORAGE_VERSION,
      order: state.order,
      visible: state.visible,
    };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(stored));
    } catch {
      // Storage can be unavailable in private browsing or restricted contexts.
    }
  }, [state, storageHydrated, storageKey]);

  const setOrder = useCallback((nextOrder: readonly TId[]) => {
    setState((current) => ({ ...current, order: [...nextOrder] }));
  }, []);
  const setVisible = useCallback((nextVisible: readonly TId[]) => {
    setState((current) => ({ ...current, visible: [...nextVisible] }));
  }, []);
  const reset = useCallback(() => {
    setState(normalizeColumnState(columns, null));
  }, [columns]);

  const visibleIds = useMemo(() => {
    const visible = new Set(state.visible);
    return state.order.filter((id) => visible.has(id)) as TId[];
  }, [state]);

  return {
    orderedIds: state.order as TId[],
    visibleIds,
    setOrder,
    setVisible,
    reset,
  };
}

function ColumnSettingsRow({
  column,
  checked,
  onCheckedChange,
  onDragEnd,
  dragHint,
  requiredLabel,
}: {
  column: AnalyticsTableColumnDefinition;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onDragEnd: () => void;
  dragHint: string;
  requiredLabel: string;
}) {
  const dragControls = useDragControls();

  return (
    <Reorder.Item
      value={column.id}
      dragListener={false}
      dragControls={dragControls}
      onDragEnd={onDragEnd}
      className="flex items-center gap-2 border border-border/60 bg-muted/10 px-2 py-2"
    >
      <button
        type="button"
        className="touch-none cursor-grab rounded-none p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
        onPointerDown={(event) => dragControls.start(event)}
        aria-label={dragHint}
      >
        <RiDraggable className="size-4" />
      </button>
      <Checkbox
        id={`analytics-table-column-${column.id}`}
        checked={checked}
        disabled={column.required}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <label
        htmlFor={`analytics-table-column-${column.id}`}
        className={cn(
          "min-w-0 flex-1 cursor-pointer truncate text-sm",
          column.required && "cursor-default",
        )}
      >
        {column.label}
      </label>
      {column.required ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {requiredLabel}
        </span>
      ) : null}
    </Reorder.Item>
  );
}

export function AnalyticsTableColumnSettings<TId extends string = string>({
  columns,
  orderedIds,
  visibleIds,
  onOrderChange,
  onVisibilityChange,
  onReset,
  labels,
}: {
  columns: readonly AnalyticsTableColumnDefinition<TId>[];
  orderedIds: readonly TId[];
  visibleIds: readonly TId[];
  onOrderChange: (nextOrder: readonly TId[]) => void;
  onVisibilityChange: (nextVisible: readonly TId[]) => void;
  onReset: () => void;
  labels: AnalyticsTableColumnSettingsLabels;
}) {
  const [open, setOpen] = useState(false);
  const [draftOrderedIds, setDraftOrderedIds] = useState(() => [...orderedIds]);
  const draftOrderRef = useRef<TId[]>([...orderedIds]);
  const columnsById = useMemo(
    () => new Map(columns.map((column) => [column.id, column])),
    [columns],
  );
  const visibleSet = useMemo(() => new Set(visibleIds), [visibleIds]);

  useEffect(() => {
    const nextOrder = [...orderedIds];
    const currentOrder = draftOrderRef.current;
    const orderChanged =
      currentOrder.length !== nextOrder.length ||
      currentOrder.some((id, index) => id !== nextOrder[index]);

    if (!orderChanged) return;
    draftOrderRef.current = nextOrder;
    setDraftOrderedIds(nextOrder);
  }, [orderedIds]);

  const toggleVisibility = (id: TId, checked: boolean) => {
    const column = columnsById.get(id);
    if (!column || column.required) return;

    const nextVisible = new Set(visibleIds);
    if (checked) nextVisible.add(id);
    else nextVisible.delete(id);
    onVisibilityChange(
      draftOrderedIds.filter((columnId) => nextVisible.has(columnId)),
    );
  };

  const handleReorder = (nextOrder: TId[]) => {
    draftOrderRef.current = nextOrder;
    setDraftOrderedIds(nextOrder);
  };

  const handleDragEnd = () => {
    const nextOrder = draftOrderRef.current;
    const orderChanged =
      orderedIds.length !== nextOrder.length ||
      orderedIds.some((id, index) => id !== nextOrder[index]);

    if (orderChanged) onOrderChange(nextOrder);
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <ResponsiveDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={labels.action}
              >
                <RiLayoutColumnLine />
              </Button>
            </ResponsiveDialogTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{labels.action}</TooltipContent>
      </Tooltip>
      <ResponsiveDialogContent
        desktopClassName="max-w-md"
        drawerClassName="max-h-[85dvh]"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle icon={RiLayoutColumnLine}>
            {labels.title}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {labels.description}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">
            {labels.visible}
          </p>
          <Reorder.Group
            axis="y"
            values={draftOrderedIds}
            onReorder={(nextOrder) => handleReorder(nextOrder as TId[])}
            className="space-y-1.5"
          >
            {draftOrderedIds.map((id) => {
              const column = columnsById.get(id);
              if (!column) return null;
              return (
                <ColumnSettingsRow
                  key={column.id}
                  column={column}
                  checked={visibleSet.has(id)}
                  onCheckedChange={(checked) => toggleVisibility(id, checked)}
                  onDragEnd={handleDragEnd}
                  dragHint={labels.dragHint}
                  requiredLabel={labels.required}
                />
              );
            })}
          </Reorder.Group>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter className="flex-row justify-between">
          <Button type="button" variant="ghost" onClick={onReset}>
            <RiRefreshLine data-icon="inline-start" />
            {labels.reset}
          </Button>
          <ResponsiveDialogClose asChild>
            <Button type="button" variant="outline">
              {labels.close}
            </Button>
          </ResponsiveDialogClose>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
