import { realtimeStatusLabel } from "@insightflare/product-ui/realtime";

import type { AppMessages } from "@/lib/i18n/messages";
import { buildRealtimeStatusLabels } from "@/lib/product-ui-labels/realtime";
import type { RealtimeConnectionState } from "@/lib/realtime/types";

export function realtimeStatusText(
  messages: AppMessages,
  status: RealtimeConnectionState,
): string {
  return realtimeStatusLabel(buildRealtimeStatusLabels(messages), status);
}
