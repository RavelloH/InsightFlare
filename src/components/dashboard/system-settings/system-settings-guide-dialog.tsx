import { RiBookOpenLine } from "@remixicon/react";

import { Button } from "@/components/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/ui/responsive-dialog";

interface SystemSettingsGuideDialogProps {
  triggerLabel: string;
  title: string;
  description: string;
  steps: string[];
}

export function SystemSettingsGuideDialog({
  triggerLabel,
  title,
  description,
  steps,
}: SystemSettingsGuideDialogProps) {
  return (
    <ResponsiveDialog>
      <ResponsiveDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="ml-auto">
          <RiBookOpenLine className="size-4" />
          {triggerLabel}
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent desktopClassName="max-w-lg">
        <ResponsiveDialogHeader className="pr-8">
          <ResponsiveDialogTitle icon={RiBookOpenLine}>
            {title}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {description}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <ol className="grid list-decimal gap-2 pl-4 text-xs/relaxed text-muted-foreground">
            {steps.map((step) => (
              <li key={step} className="pl-1">
                {step}
              </li>
            ))}
          </ol>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
