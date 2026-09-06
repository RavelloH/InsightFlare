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

export function FunnelStepFilterDialog({
  open,
  filterDsl,
  onOpenChange,
  onApply,
  labels,
  messages,
  siteId,
  window: timeWindow,
}: {
  readonly open: boolean;
  readonly filterDsl: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onApply: (filterDsl: string) => void;
  readonly labels: AppMessages["funnels"];
  readonly messages: AppMessages;
  readonly siteId?: string;
  readonly window?: TimeWindow;
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="max-w-xl"
        onPointerDownCapture={(event) => event.stopPropagation()}
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle icon={RiFilter2Line}>
            {labels.stepFilter}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <FilterEditor
            audience="private-dashboard"
            initialFilterDsl={filterDsl}
            messages={messages}
            siteId={siteId}
            window={timeWindow}
            onApply={(next) => {
              onApply(next);
            }}
            onCancel={() => onOpenChange(false)}
            applyLabel={labels.apply}
            cancelLabel={labels.cancel}
          />
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
