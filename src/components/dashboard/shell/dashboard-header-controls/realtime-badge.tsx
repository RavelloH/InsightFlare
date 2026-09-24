import {
  RealtimeStatusDot,
  realtimeStatusText,
} from "@/components/dashboard/realtime/realtime-status-indicator";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { AutoTransition } from "@/components/ui/auto-transition";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AppMessages } from "@/lib/i18n/messages";
import type {
  RealtimeChannelState,
  RealtimeConnectionState,
} from "@/lib/realtime/types";
export const selectRealtimeHeaderState = (state: RealtimeChannelState) => ({
  activeNow: state.activeNow,
  status: state.status,
  hasConnected: state.hasConnected,
});
export type RealtimeHeaderState = ReturnType<typeof selectRealtimeHeaderState>;
export const areRealtimeHeaderStatesEqual = (
  left: RealtimeHeaderState,
  right: RealtimeHeaderState,
) =>
  left.activeNow === right.activeNow &&
  left.status === right.status &&
  left.hasConnected === right.hasConnected;
export function RealtimeActiveBadge({
  activeNow,
  status,
  showValue,
  label,
  messages,
}: {
  activeNow: number;
  status: RealtimeConnectionState;
  showValue: boolean;
  label: string;
  messages: AppMessages;
}) {
  const statusText = realtimeStatusText(messages, status);
  const valueText = showValue ? String(activeNow) : "--";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="inline-flex h-9 items-center px-1 text-xs font-medium text-foreground/90">
          <AutoTransition
            type="fade"
            duration={0.16}
            initial={false}
            presenceMode="wait"
            className="inline-flex items-center"
          >
            {showValue ? (
              <span key="active-now-value" className="inline-flex items-center">
                <AnimatedNumber
                  value={activeNow}
                  continuous
                  className="font-mono tabular-nums"
                />
              </span>
            ) : (
              <span
                key="active-now-empty"
                className="inline-flex w-0 overflow-hidden"
                aria-hidden
              />
            )}
          </AutoTransition>
          <span className={showValue ? "ml-2" : ""}>
            <RealtimeStatusDot status={status} />
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">{`${label}: ${valueText} · ${statusText}`}</TooltipContent>
    </Tooltip>
  );
}
