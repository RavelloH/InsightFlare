"use client";

import { RiFileCopyLine } from "@remixicon/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

interface PublicLinkCopyButtonProps {
  value: string;
  label: string;
  copiedLabel: string;
}

export function PublicLinkCopyButton({
  value,
  label,
  copiedLabel,
}: PublicLinkCopyButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          toast.success(copiedLabel);
        });
      }}
    >
      <RiFileCopyLine />
    </Button>
  );
}
