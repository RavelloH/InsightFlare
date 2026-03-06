"use client";

import { PageHeading } from "@/components/dashboard/page-heading";
import type { AppMessages } from "@/lib/i18n/messages";

interface RealtimeClientPageProps {
  messages: AppMessages;
}

export function RealtimeClientPage({ messages }: RealtimeClientPageProps) {
  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.realtime.title}
        subtitle={messages.realtime.subtitle}
      />
    </div>
  );
}
