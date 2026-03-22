"use client";

import { PageHeading } from "@/components/dashboard/page-heading";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface DevicesClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

export function DevicesClientPage({ messages }: DevicesClientPageProps) {
  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.devices.title}
        subtitle={messages.devices.subtitle}
      />
    </div>
  );
}

