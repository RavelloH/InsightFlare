import { memo, useMemo } from "react";
import { Icon } from "@iconify/react";
import { RiGlobalLine } from "@remixicon/react";
import Avatar from "boring-avatars";
import { motion } from "motion/react";

import { Card, CardContent } from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import { shortDateTime } from "@/lib/dashboard/format";

import {
  areRealtimeLogStreamItemPropsEqual,
  BROWSER_APPLE_ICON_KEYS,
  BROWSER_ICON_DIR,
  classifyRealtimeLogEvent,
  DomainOrUrlIcon,
  formatLogTitle,
  LOG_STREAM_ITEM_LAYOUT_TRANSITION,
  LogoIcon,
  MetaItem,
  OS_APPLE_ICON_KEYS,
  OS_ICON_DIR,
  type RealtimeLogStreamItemMotionProps,
  type RealtimeLogStreamItemProps,
  RealtimeRelativeTime,
  resolveRealtimeEventDisplayData,
  UNKNOWN_ICON_KEY,
  VISITOR_AVATAR_COLORS,
} from "./model";
const RealtimeLogStreamItemCard = memo(function RealtimeLogStreamItemCard({
  event,
  locale,
  messages,
  timeZone,
}: RealtimeLogStreamItemProps) {
  const displayData = useMemo(
    () => resolveRealtimeEventDisplayData(locale, messages, event),
    [event, locale, messages],
  );
  const {
    avatarSeed,
    browserLabel,
    browserIconKey,
    countryFlagCode,
    countryLabel,
    osIconKey,
    osLabel,
    sourceLabel,
    title,
  } = displayData;
  const eventDateTime = useMemo(
    () => shortDateTime(locale, event.eventAt, timeZone),
    [event.eventAt, locale, timeZone],
  );

  return (
    <Card size="sm" className="w-full">
      <CardContent className="px-3">
        <div className="flex items-start gap-3">
          <div className="shrink-0 self-center">
            <Avatar
              size={34}
              name={avatarSeed}
              variant="ring"
              colors={VISITOR_AVATAR_COLORS}
              aria-hidden="true"
            />
          </div>
          <div className="flex min-w-0 flex-1 items-stretch justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <p className="min-w-0 truncate text-sm font-medium text-foreground">
                {title}
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <MetaItem
                  icon={
                    <LogoIcon
                      src={`${BROWSER_ICON_DIR}/${browserIconKey}.svg`}
                      fallbackSrc={`${BROWSER_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
                      invertInDark={BROWSER_APPLE_ICON_KEYS.has(browserIconKey)}
                    />
                  }
                  label={browserLabel}
                  hideLabelOnMobile
                />
                <MetaItem
                  icon={
                    <LogoIcon
                      src={`${OS_ICON_DIR}/${osIconKey}.svg`}
                      fallbackSrc={`${OS_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
                      invertInDark={OS_APPLE_ICON_KEYS.has(osIconKey)}
                    />
                  }
                  label={osLabel}
                  hideLabelOnMobile
                />
                <MetaItem
                  icon={
                    countryFlagCode ? (
                      <Icon
                        icon={`flagpack:${countryFlagCode.toLowerCase()}`}
                        style={{ width: 16, height: 12 }}
                        className="block shrink-0"
                      />
                    ) : (
                      <RiGlobalLine className="size-3.5 text-muted-foreground" />
                    )
                  }
                  label={countryLabel}
                  hideLabelOnMobile
                />
                <MetaItem
                  icon={
                    <DomainOrUrlIcon
                      label={sourceLabel}
                      unknownLabel={messages.overview.direct}
                    />
                  }
                  label={sourceLabel}
                />
              </div>
            </div>
            <div className="shrink-0 self-stretch">
              <div className="flex h-full min-w-[7.5rem] flex-col items-end justify-between text-right">
                <p className="font-mono text-[11px] text-foreground">
                  <RealtimeRelativeTime
                    locale={locale}
                    timestamp={event.eventAt}
                  />
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {eventDateTime}
                </p>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}, areRealtimeLogStreamItemPropsEqual);
function areRealtimeLogStreamItemMotionPropsEqual(
  previousProps: RealtimeLogStreamItemMotionProps,
  nextProps: RealtimeLogStreamItemMotionProps,
): boolean {
  return (
    areRealtimeLogStreamItemPropsEqual(previousProps, nextProps) &&
    previousProps.onSelect === nextProps.onSelect &&
    previousProps.reduceMotion === nextProps.reduceMotion
  );
}
export const RealtimeLogStreamItem = memo(function RealtimeLogStreamItem({
  event,
  locale,
  messages,
  timeZone,
  onSelect,
  reduceMotion,
}: RealtimeLogStreamItemMotionProps) {
  const title = formatLogTitle(
    messages,
    event,
    classifyRealtimeLogEvent(event),
  );

  return (
    <motion.li
      layout={reduceMotion ? false : "position"}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
      transition={LOG_STREAM_ITEM_LAYOUT_TRANSITION}
      className="list-none"
    >
      <Clickable
        className="block w-full rounded-none text-left focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          onSelect(event);
        }}
        enableHoverScale={false}
        tapScale={0.985}
        duration={0.14}
        aria-label={title}
      >
        <RealtimeLogStreamItemCard
          event={event}
          locale={locale}
          messages={messages}
          timeZone={timeZone}
        />
      </Clickable>
    </motion.li>
  );
}, areRealtimeLogStreamItemMotionPropsEqual);
export { RealtimeLogEventDetailsDrawer } from "./log-stream-event-details";
