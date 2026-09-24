import { memo } from "react";
import { RiArrowLeftLine } from "@remixicon/react";

import { PageHeading } from "@/components/dashboard/common/page-heading";
import { Button } from "@/components/ui/button";
import type { AppMessages } from "@/lib/i18n/messages";
import { navigateWithTransition } from "@/lib/page-transition";
import { useRouter } from "@/lib/router";

export const EventPageHeader = memo(function EventPageHeader({
  messages,
  title,
  subtitle,
  backHref,
  backLabel,
  onBack,
}: {
  messages: AppMessages;
  title: string;
  subtitle: string;
  backHref?: string;
  backLabel?: string;
  onBack?: () => void;
}) {
  const router = useRouter();
  const handleBack = onBack
    ? onBack
    : backHref
      ? () => navigateWithTransition(router, backHref)
      : null;

  return (
    <PageHeading
      title={title}
      subtitle={subtitle}
      actions={
        handleBack ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleBack}
          >
            <RiArrowLeftLine data-icon="inline-start" />
            {backLabel || messages.common.backToTeam}
          </Button>
        ) : null
      }
    />
  );
});
