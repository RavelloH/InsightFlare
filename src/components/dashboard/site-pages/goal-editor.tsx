import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { RiCloseLine, RiFilter2Line, RiSave3Line } from "@remixicon/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { Spinner } from "@/components/ui/spinner";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { GoalDefinition } from "@/lib/edge-client";
import {
  analyticsFilterRegistry,
  filterConditionCount,
  parseFilterDsl,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";

import { GoalFilterDialog } from "./goal-filter-dialog";

export function GoalEditor({
  open,
  goal,
  labels,
  messages,
  siteId,
  window,
  submitting,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly goal?: GoalDefinition | null;
  readonly labels: AppMessages["goals"];
  readonly messages: AppMessages;
  readonly siteId: string;
  readonly window: TimeWindow;
  readonly submitting: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: {
    name: string;
    filterDsl: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [filterDsl, setFilterDsl] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterOpenRef = useRef(false);
  const setFilterDialogOpen = (nextOpen: boolean) => {
    filterOpenRef.current = nextOpen;
    setFilterOpen(nextOpen);
  };
  const handleEditorOpenChange = (nextOpen: boolean) => {
    // The filter editor is rendered in a separate portal. Because the shared
    // dialog is non-modal, the parent can receive an outside-interaction close
    // event while the child dialog is being opened or dismissed. Ignore that
    // event and keep the editor form mounted.
    if (!nextOpen && (filterOpen || filterOpenRef.current)) {
      return;
    }
    onOpenChange(nextOpen);
  };
  useEffect(() => {
    if (!open) return;
    setName(goal?.name ?? "");
    setFilterDsl(goal?.filterDsl ?? "");
    setFilterDialogOpen(false);
  }, [goal, open]);
  const valid = name.trim().length > 0 && filterDsl.trim().length > 0;
  let filterCount = 0;
  try {
    filterCount = filterConditionCount(
      parseFilterDsl(filterDsl, analyticsFilterRegistry),
    );
  } catch {
    // The shared editor owns detailed validation; the compact trigger only
    // needs a stable count and must not rewrite the user's raw DSL.
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || submitting) return;
    void onSubmit({
      name: name.trim(),
      filterDsl,
    });
  };

  return (
    <>
      <ResponsiveDialog open={open} onOpenChange={handleEditorOpenChange}>
        <ResponsiveDialogContent desktopClassName="max-w-xl">
          <form
            onSubmit={submit}
            className="flex min-h-0 flex-1 flex-col gap-4"
          >
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle icon={RiSave3Line}>
                {goal ? labels.editTitle : labels.createTitle}
              </ResponsiveDialogTitle>
            </ResponsiveDialogHeader>
            <ResponsiveDialogBody>
              <div className="min-h-max min-w-0 space-y-3">
                <div className="space-y-1.5">
                  <label htmlFor="goal-name" className="text-sm font-medium">
                    {labels.nameLabel}
                  </label>
                  <Input
                    id="goal-name"
                    value={name}
                    placeholder={labels.namePlaceholder}
                    onChange={(event) => setName(event.target.value)}
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{labels.filter}</label>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full min-w-32 justify-start truncate text-left text-xs"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => setFilterDialogOpen(true)}
                  >
                    <RiFilter2Line /> {labels.filter} ({filterCount})
                  </Button>
                  {!valid && (name.length > 0 || filterDsl.length > 0) ? (
                    <p className="text-xs text-destructive">
                      {labels.invalidGoal}
                    </p>
                  ) : null}
                </div>
              </div>
            </ResponsiveDialogBody>
            <ResponsiveDialogFooter>
              <ResponsiveDialogClose asChild>
                <Button type="button" variant="outline" disabled={submitting}>
                  <RiCloseLine /> {labels.cancel}
                </Button>
              </ResponsiveDialogClose>
              <Button type="submit" disabled={!valid || submitting}>
                {submitting ? <Spinner /> : <RiSave3Line />}
                {submitting
                  ? labels.creating
                  : goal
                    ? labels.saveEdit
                    : labels.save}
              </Button>
            </ResponsiveDialogFooter>
          </form>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <GoalFilterDialog
        open={filterOpen}
        filterDsl={filterDsl}
        labels={labels}
        messages={messages}
        siteId={siteId}
        window={window}
        onOpenChange={setFilterDialogOpen}
        onApply={(next) => {
          setFilterDsl(next);
          setFilterDialogOpen(false);
        }}
      />
    </>
  );
}
