import type { AppMessages } from "@/lib/i18n/messages";
import type { DashboardFilters, RangePreset } from "@/lib/dashboard/query-state";

interface RangeLinksProps {
  pathname: string;
  activeRange: RangePreset;
  messages: AppMessages;
  filters?: DashboardFilters;
}

export function RangeLinks({ pathname, activeRange, messages, filters }: RangeLinksProps) {
  void pathname;
  void activeRange;
  void messages;
  void filters;
  return null;
}
