import { RiFilter2Line } from "@remixicon/react";

import { FilterEditor } from "@/components/dashboard/filter-editor";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { AppMessages } from "@/lib/i18n/messages";

export function GoalFilterDialog({
  open,
  filterDsl,
  labels,
  messages,
  siteId,
  window,
  onOpenChange,
  onApply,
}: {
  readonly open: boolean;
  readonly filterDsl: string;
  readonly labels: AppMessages["goals"];
  readonly messages: AppMessages;
  readonly siteId: string;
  readonly window: TimeWindow;
  readonly onOpenChange: (open: boolean) => void;
  readonly onApply: (filterDsl: string) => void;
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="max-w-xl"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle icon={RiFilter2Line}>
            {labels.filter}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody
          scrollable={false}
          className="px-4 pb-2 md:px-0 md:pb-0"
        >
          <FilterEditor
            className="min-h-0 flex-1"
            audience="private-dashboard"
            initialFilterDsl={filterDsl}
            messages={messages}
            observationOnly
            siteId={siteId}
            window={window}
            resolvedScope="event"
            applyLabel={labels.apply}
            cancelLabel={labels.cancel}
            onApply={onApply}
            onCancel={() => onOpenChange(false)}
          />
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
