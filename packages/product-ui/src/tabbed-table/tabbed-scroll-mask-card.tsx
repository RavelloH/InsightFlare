import { type ReactNode } from "react";
import { Card } from "@insightflare/ui/card";
import { OverlayScrollbar } from "@insightflare/ui/overlay-scrollbar";
import { Tabs, TabsList, TabsTrigger } from "@insightflare/ui/tabs";
import { VerticalScrollMask } from "@insightflare/ui/vertical-scroll-mask";

import { cn } from "../utils/cn";
export interface TabbedScrollMaskCardTab<T extends string = string> {
  value: T;
  label: string;
}
interface TabbedScrollMaskCardProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  tabs: readonly TabbedScrollMaskCardTab<T>[];
  children: ReactNode;
  headerRight?: ReactNode;
  headerHidden?: boolean;
  syncKey?: string | number | boolean | null;
  className?: string;
  tabsListClassName?: string;
  tabTriggerClassName?: string;
  viewportClassName?: string;
}
export function TabbedScrollMaskCard<T extends string = string>({
  value,
  onValueChange,
  tabs,
  children,
  headerRight,
  headerHidden = false,
  syncKey,
  className,
  tabsListClassName,
  tabTriggerClassName,
  viewportClassName,
}: TabbedScrollMaskCardProps<T>) {
  return (
    <Card className={cn("gap-0 py-0 overflow-hidden", className)}>
      {headerHidden ? null : (
        <div className="border-b">
          <Tabs
            value={value}
            onValueChange={(next) => onValueChange(next as T)}
            className="gap-0"
          >
            <div className="flex items-center gap-1 px-2 py-1">
              <OverlayScrollbar
                axis="horizontal"
                className="min-w-0 flex-1"
                contentClassName="w-max min-w-full"
                syncKey={value}
              >
                <TabsList
                  variant="line"
                  className={cn(
                    "h-10 w-max min-w-max justify-start gap-1 border-0 px-0",
                    tabsListClassName,
                  )}
                >
                  {tabs.map((tab) => (
                    <TabsTrigger
                      key={tab.value}
                      value={tab.value}
                      className={cn(
                        "h-8 flex-none px-3 text-xs",
                        tabTriggerClassName,
                      )}
                    >
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </OverlayScrollbar>
              {headerRight ? (
                <div className="shrink-0">{headerRight}</div>
              ) : null}
            </div>
          </Tabs>
        </div>
      )}

      <VerticalScrollMask
        className={cn("max-h-[60vh]", viewportClassName)}
        contentClassName="pt-1.5"
        syncKey={syncKey}
        maskClassName="from-card via-card/80 to-transparent"
      >
        {children}
      </VerticalScrollMask>
    </Card>
  );
}
