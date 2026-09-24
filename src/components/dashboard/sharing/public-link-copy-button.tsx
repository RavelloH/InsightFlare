import { RiFileCopyLine } from "@remixicon/react";
import { toast } from "sonner";

import { TableActionButton } from "@/components/dashboard/common/table-action-button";

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
    <TableActionButton
      label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          toast.success(copiedLabel);
        });
      }}
    >
      <RiFileCopyLine className="size-4" />
    </TableActionButton>
  );
}
