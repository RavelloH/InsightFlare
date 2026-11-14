import { memo } from "react";
import { Icon } from "@iconify/react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { Clickable } from "@insightflare/ui/clickable";
import { Spinner } from "@insightflare/ui/spinner";
import { RiGlobalLine, RiPulseLine } from "@remixicon/react";
import Avatar from "boring-avatars";
import { AnimatePresence, motion } from "motion/react";

import { resolveBrowserIconUrl, resolveOsIconUrl } from "./icon-assets";
import {
  BROWSER_APPLE_ICON_KEYS,
  DomainOrUrlIcon,
  LogoIcon,
  LogStreamScrollbar,
  MetaItem,
  OS_APPLE_ICON_KEYS,
  UNKNOWN_ICON_KEY,
  VISITOR_AVATAR_COLORS,
} from "./log-stream-primitives";
import { RealtimeRelativeTime } from "./relative-time";

export interface RealtimeLogStreamLabels {
  readonly title: string;
  readonly loading: string;
  readonly empty: string;
  readonly direct: string;
}

export interface RealtimeLogStreamViewItem {
  readonly id: string;
  readonly eventAt: number;
  readonly eventDateTime: string;
  readonly title: string;
  readonly avatarSeed: string;
  readonly browserLabel: string;
  readonly browserIconKey: string;
  readonly osLabel: string;
  readonly osIconKey: string;
  readonly countryLabel: string;
  readonly countryFlagCode: string | null;
  readonly sourceLabel: string;
}

export interface RealtimeLogStreamViewProps {
  readonly items: ReadonlyArray<RealtimeLogStreamViewItem>;
  readonly state: "loading" | "empty" | "ready";
  readonly labels: RealtimeLogStreamLabels;
  readonly locale: string;
  readonly reduceMotion: boolean;
  readonly syncKey: string;
  readonly onReachEnd: (() => void) | null;
  readonly onSelect?: (id: string) => void;
  /** "compact" renders slim single-column rows; defaults to the dashboard look. */
  readonly density?: RealtimeLogStreamDensity;
  /** Set to false to omit the visitor avatar ring. Defaults to true. */
  readonly showAvatar?: boolean;
}

export type RealtimeLogStreamDensity = "comfortable" | "compact";

const LOG_STREAM_ITEM_LAYOUT_TRANSITION = {
  layout: {
    duration: 0.34,
    ease: [0.22, 1, 0.36, 1],
  },
  opacity: {
    duration: 0.18,
    ease: [0.22, 1, 0.36, 1],
  },
} as const;

function areItemsEqual(
  previous: RealtimeLogStreamViewItem,
  next: RealtimeLogStreamViewItem,
): boolean {
  return (
    previous.id === next.id &&
    previous.eventAt === next.eventAt &&
    previous.eventDateTime === next.eventDateTime &&
    previous.title === next.title &&
    previous.avatarSeed === next.avatarSeed &&
    previous.browserLabel === next.browserLabel &&
    previous.browserIconKey === next.browserIconKey &&
    previous.osLabel === next.osLabel &&
    previous.osIconKey === next.osIconKey &&
    previous.countryLabel === next.countryLabel &&
    previous.countryFlagCode === next.countryFlagCode &&
    previous.sourceLabel === next.sourceLabel
  );
}

interface ItemCardProps {
  item: RealtimeLogStreamViewItem;
  locale: string;
  directLabel: string;
  density: RealtimeLogStreamDensity;
  showAvatar: boolean;
}

const RealtimeLogStreamItemCard = memo(
  function RealtimeLogStreamItemCard({
    item,
    locale,
    directLabel,
    density,
    showAvatar,
  }: ItemCardProps) {
    const {
      avatarSeed,
      browserLabel,
      browserIconKey,
      countryFlagCode,
      countryLabel,
      eventAt,
      eventDateTime,
      osIconKey,
      osLabel,
      sourceLabel,
      title,
    } = item;

    const metaItems = (
      <>
        <MetaItem
          icon={
            <LogoIcon
              src={resolveBrowserIconUrl(browserIconKey)}
              fallbackSrc={resolveBrowserIconUrl(UNKNOWN_ICON_KEY)}
              invertInDark={BROWSER_APPLE_ICON_KEYS.has(browserIconKey)}
            />
          }
          label={browserLabel}
          hideLabelOnMobile
        />
        <MetaItem
          icon={
            <LogoIcon
              src={resolveOsIconUrl(osIconKey)}
              fallbackSrc={resolveOsIconUrl(UNKNOWN_ICON_KEY)}
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
            <DomainOrUrlIcon label={sourceLabel} unknownLabel={directLabel} />
          }
          label={sourceLabel}
        />
      </>
    );

    if (density === "compact") {
      return (
        <Card size="sm" className="w-full gap-0 py-2">
          <CardContent className="px-3">
            <div className="flex items-center gap-3">
              {showAvatar ? (
                <div className="shrink-0">
                  <Avatar
                    size={22}
                    name={avatarSeed}
                    variant="ring"
                    colors={VISITOR_AVATAR_COLORS}
                    aria-hidden="true"
                  />
                </div>
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-medium text-foreground">
                    {title}
                  </p>
                  <p className="shrink-0 font-mono text-[11px] text-foreground">
                    <RealtimeRelativeTime locale={locale} timestamp={eventAt} />
                  </p>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {metaItems}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    return (
      <Card size="sm" className="w-full">
        <CardContent className="px-3">
          <div className="flex items-start gap-3">
            {showAvatar ? (
              <div className="shrink-0 self-center">
                <Avatar
                  size={34}
                  name={avatarSeed}
                  variant="ring"
                  colors={VISITOR_AVATAR_COLORS}
                  aria-hidden="true"
                />
              </div>
            ) : null}
            <div className="flex min-w-0 flex-1 items-stretch justify-between gap-4">
              <div className="min-w-0 space-y-2">
                <p className="min-w-0 truncate text-sm font-medium text-foreground">
                  {title}
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  {metaItems}
                </div>
              </div>
              <div className="shrink-0 self-stretch">
                <div className="flex h-full min-w-[7.5rem] flex-col items-end justify-between text-right">
                  <p className="font-mono text-[11px] text-foreground">
                    <RealtimeRelativeTime locale={locale} timestamp={eventAt} />
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
  },
  (previous, next) =>
    previous.locale === next.locale &&
    previous.directLabel === next.directLabel &&
    previous.density === next.density &&
    previous.showAvatar === next.showAvatar &&
    areItemsEqual(previous.item, next.item),
);

interface ItemProps extends ItemCardProps {
  onSelect?: (id: string) => void;
  reduceMotion: boolean;
}

const RealtimeLogStreamItemRow = memo(
  function RealtimeLogStreamItemRow({
    item,
    locale,
    directLabel,
    density,
    showAvatar,
    onSelect,
    reduceMotion,
  }: ItemProps) {
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
            onSelect?.(item.id);
          }}
          enableHoverScale={false}
          tapScale={0.985}
          duration={0.14}
          aria-label={item.title}
        >
          <RealtimeLogStreamItemCard
            item={item}
            locale={locale}
            directLabel={directLabel}
            density={density}
            showAvatar={showAvatar}
          />
        </Clickable>
      </motion.li>
    );
  },
  (previous, next) =>
    previous.locale === next.locale &&
    previous.directLabel === next.directLabel &&
    previous.density === next.density &&
    previous.showAvatar === next.showAvatar &&
    areItemsEqual(previous.item, next.item) &&
    previous.onSelect === next.onSelect &&
    previous.reduceMotion === next.reduceMotion,
);

export function RealtimeLogStreamView({
  items,
  state,
  labels,
  locale,
  reduceMotion,
  syncKey,
  onReachEnd,
  onSelect,
  density = "comfortable",
  showAvatar = true,
}: RealtimeLogStreamViewProps) {
  const logStateKey =
    state === "loading" ? "loading" : state === "empty" ? "empty" : "events";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiPulseLine className="size-4" />
          {labels.title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <AutoResizer initial duration={0.22}>
          <AutoTransition
            initial={false}
            duration={0.2}
            transitionKey={logStateKey}
          >
            {state === "loading" ? (
              <div className="flex min-h-56 items-center justify-center text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <Spinner className="size-3.5" />
                  {labels.loading}
                </span>
              </div>
            ) : state === "empty" ? (
              <div className="flex min-h-56 items-center justify-center text-muted-foreground">
                {labels.empty}
              </div>
            ) : (
              <LogStreamScrollbar
                className={
                  density === "compact" ? "max-h-[24rem]" : "max-h-[30rem]"
                }
                maskClassName="from-card via-card/80 to-transparent"
                syncKey={syncKey}
                onReachEnd={onReachEnd}
              >
                <div className="p-1">
                  <ul
                    className={
                      density === "compact"
                        ? "m-0 list-none space-y-1.5 p-0"
                        : "m-0 list-none space-y-2 p-0"
                    }
                  >
                    <AnimatePresence initial={false} mode="popLayout">
                      {items.map((item) => (
                        <RealtimeLogStreamItemRow
                          key={item.id}
                          item={item}
                          locale={locale}
                          directLabel={labels.direct}
                          density={density}
                          showAvatar={showAvatar}
                          onSelect={onSelect}
                          reduceMotion={reduceMotion}
                        />
                      ))}
                    </AnimatePresence>
                  </ul>
                </div>
              </LogStreamScrollbar>
            )}
          </AutoTransition>
        </AutoResizer>
      </CardContent>
    </Card>
  );
}
