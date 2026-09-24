import { RiSettings3Line } from "@remixicon/react";

import { TableActionButton } from "@/components/dashboard/common/table-action-button";
import { navigateWithTransition } from "@/lib/page-transition";
import { useRouter } from "@/lib/router";

interface PublicLinkSettingsButtonProps {
  href: string;
  label: string;
}

export function PublicLinkSettingsButton({
  href,
  label,
}: PublicLinkSettingsButtonProps) {
  const router = useRouter();

  return (
    <TableActionButton
      label={label}
      onClick={() => navigateWithTransition(router, href)}
    >
      <RiSettings3Line className="size-4" />
    </TableActionButton>
  );
}
