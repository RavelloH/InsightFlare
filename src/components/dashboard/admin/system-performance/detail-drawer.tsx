import type { ReactNode } from "react";
import { Badge } from "@insightflare/ui/badge";
import { Button } from "@insightflare/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
} from "@insightflare/ui/drawer";

import { shortDateTimeWithSeconds } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";

import {
  categoryLabel,
  COST_METRICS,
  formatCount,
  formatHotspotValue,
  formatMs,
  formatWeighted,
  type InvocationErrorAggregate,
  type InvocationHotspot,
  type InvocationRouteAggregate,
  type InvocationSample,
  type PerformanceCopy,
  sourceLabel,
  template,
  triggerLabel,
} from "./model";
import { InlineNote, ResultBadge, StatGrid } from "./parts";
import type { PerformanceKind } from "./performance-url-state";

export type DetailTarget =
  | { type: "route"; row: InvocationRouteAggregate }
  | { type: "hotspot"; row: InvocationHotspot; kind: PerformanceKind }
  | { type: "error"; row: InvocationErrorAggregate }
  | { type: "sample"; row: InvocationSample };

export interface DetailActions {
  filterRoute: (routeKey: string) => void;
  filterVersion: (version: string) => void;
  viewHotspots: (routeKey: string) => void;
  viewSamples: (target: DetailTarget) => void;
}

function DetailList({
  items,
}: {
  items: ReadonlyArray<{ label: string; value: ReactNode; mono?: boolean }>;
}) {
  return (
    <dl className="divide-y border-y text-sm">
      {items.map((item) => (
        <div
          key={item.label}
          className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-2"
        >
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd
            className={
              item.mono ? "break-all font-mono text-xs leading-5" : undefined
            }
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function coverageValue(
  value: number,
  coverage: string | undefined,
  render: (value: number) => string,
  empty: string,
) {
  if (coverage === "unavailable") return empty;
  return coverage === "partial" ? `≥ ${render(value)}` : render(value);
}

function SampleBody({
  locale,
  copy,
  row,
}: {
  locale: Locale;
  copy: PerformanceCopy;
  row: InvocationSample;
}) {
  const details = row.details;
  const phases = [...(details?.phases ?? [])].sort(
    (a, b) => b.wallMs - a.wallMs,
  );
  const maxPhase = Math.max(1, ...phases.map((phase) => phase.wallMs));
  const queries = [...(details?.queries ?? [])].sort(
    (a, b) => b.apiWallMs - a.apiWallMs,
  );
  const truncation = details?.truncation;
  const dropped = truncation
    ? truncation.queriesDropped +
      truncation.phasesDropped +
      truncation.signalsDropped
    : 0;
  return (
    <>
      <StatGrid
        className="sm:grid-cols-2"
        items={[
          {
            id: "total",
            label: copy.columns.duration,
            value: formatMs(locale, row.invocationWallMs),
          },
          {
            id: "handler",
            label: copy.columns.handler,
            value: formatMs(locale, row.handlerWallMs),
          },
          {
            id: "status",
            label: copy.detail.httpStatus,
            value: row.httpStatus ?? copy.emptyValue,
          },
          {
            id: "weight",
            label: copy.detail.sampleWeight,
            value: `×${formatCount(locale, row.sampleInterval)}`,
            note: template(copy.detail.sampleWeightValue, {
              count: formatCount(locale, row.sampleInterval),
            }),
          },
        ]}
      />
      {row.code || row.operation ? (
        <DetailList
          items={[
            ...(row.code
              ? [{ label: copy.columns.errorCode, value: row.code, mono: true }]
              : []),
            ...(row.operation
              ? [
                  {
                    label: copy.columns.operation,
                    value: row.operation,
                    mono: true,
                  },
                ]
              : []),
            ...(row.category
              ? [
                  {
                    label: copy.columns.category,
                    value: categoryLabel(copy, row.category),
                  },
                ]
              : []),
          ]}
        />
      ) : null}
      <Section title={copy.detail.phases}>
        {phases.length ? (
          <>
            <ul className="space-y-2">
              {phases.map((phase) => (
                <li key={phase.id} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="truncate font-mono">
                      {phase.id}
                      {phase.count > 1 ? (
                        <span className="ml-1.5 text-muted-foreground">
                          ×{phase.count}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatMs(locale, phase.wallMs)}
                    </span>
                  </div>
                  <div className="h-1.5 bg-muted">
                    <div
                      className="h-full bg-primary/70"
                      style={{
                        width: `${Math.max(2, (phase.wallMs / maxPhase) * 100)}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
            <InlineNote>{copy.detail.phasesHint}</InlineNote>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {copy.detail.noDetails}
          </p>
        )}
      </Section>
      {queries.length ? (
        <Section title={copy.detail.queries}>
          <ul className="divide-y border-y">
            {queries.map((query, index) => (
              <li key={`${query.id}:${index}`} className="space-y-1.5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <span className="break-all font-mono text-xs leading-5">
                    {query.id}
                  </span>
                  {query.failed ? (
                    <Badge variant="destructive" className="shrink-0">
                      {copy.detail.failed}
                    </Badge>
                  ) : null}
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  {query.variant}
                  {query.count > 1
                    ? ` · ${template(copy.detail.calls, { count: query.count })}`
                    : ""}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
                  <span>
                    <span className="text-muted-foreground">
                      {copy.detail.apiWait}{" "}
                    </span>
                    {coverageValue(
                      query.apiWallMs,
                      query.coverage.api,
                      (value) => formatMs(locale, value),
                      copy.emptyValue,
                    )}
                  </span>
                  <span>
                    <span className="text-muted-foreground">
                      {copy.detail.engine}{" "}
                    </span>
                    {coverageValue(
                      query.sqlEngineMs,
                      query.coverage.engine,
                      (value) => formatMs(locale, value),
                      copy.emptyValue,
                    )}
                  </span>
                  <span>
                    <span className="text-muted-foreground">
                      {copy.detail.rowsRead}{" "}
                    </span>
                    {coverageValue(
                      query.rowsRead,
                      query.coverage.rowsRead,
                      (value) => formatCount(locale, value),
                      copy.emptyValue,
                    )}
                  </span>
                  {query.rowsWritten > 0 ? (
                    <span>
                      <span className="text-muted-foreground">
                        {copy.detail.rowsWritten}{" "}
                      </span>
                      {coverageValue(
                        query.rowsWritten,
                        query.coverage.rowsWritten,
                        (value) => formatCount(locale, value),
                        copy.emptyValue,
                      )}
                    </span>
                  ) : null}
                  {query.attempts > 1 ? (
                    <span>
                      <span className="text-muted-foreground">
                        {copy.detail.attempts}{" "}
                      </span>
                      {query.attempts}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {dropped > 0 || row.detailsTruncated ? (
        <InlineNote>
          {template(copy.detail.truncated, { count: Math.max(dropped, 1) })}
        </InlineNote>
      ) : null}
    </>
  );
}

function RouteBody({
  locale,
  copy,
  row,
}: {
  locale: Locale;
  copy: PerformanceCopy;
  row: InvocationRouteAggregate;
}) {
  return (
    <>
      <StatGrid
        items={[
          {
            id: "invocations",
            label: copy.columns.invocations,
            value: formatCount(locale, row.estimatedInvocations),
          },
          { id: "p50", label: "P50", value: formatMs(locale, row.p50) },
          { id: "p95", label: "P95", value: formatMs(locale, row.p95) },
          { id: "p99", label: "P99", value: formatMs(locale, row.p99) },
          ...COST_METRICS.filter(
            (metric) => row.weighted[metric.key].coverage !== "unavailable",
          ).map((metric) => ({
            id: metric.key,
            label: copy.cost[metric.label],
            value: formatWeighted(
              locale,
              row.weighted[metric.key],
              metric.unit,
            ),
          })),
        ]}
      />
      {COST_METRICS.some((metric) => row.weighted[metric.key].lowerBound) ? (
        <InlineNote>{copy.detail.lowerBound}</InlineNote>
      ) : null}
    </>
  );
}

export function PerformanceDetailDrawer({
  locale,
  timeZone,
  copy,
  target,
  open,
  onOpenChange,
  actions,
}: {
  locale: Locale;
  timeZone: string;
  copy: PerformanceCopy;
  target: DetailTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: DetailActions;
}) {
  const title = !target
    ? ""
    : target.type === "route"
      ? copy.detail.routeTitle
      : target.type === "hotspot"
        ? copy.detail.hotspotTitle
        : target.type === "error"
          ? copy.detail.errorTitle
          : copy.detail.sampleTitle;
  const subtitle = !target
    ? ""
    : target.type === "hotspot"
      ? target.row.queryId
      : target.type === "error"
        ? (target.row.code ?? target.row.operation ?? copy.emptyValue)
        : target.type === "sample"
          ? shortDateTimeWithSeconds(
              locale,
              target.row.timestampSeconds * 1000,
              timeZone,
            )
          : target.row.routeKey;
  const row = target?.row;

  const context = row
    ? [
        ...(target?.type !== "route"
          ? [{ label: copy.columns.route, value: row.routeKey, mono: true }]
          : []),
        {
          label: copy.columns.source,
          value: `${sourceLabel(copy, row.source)} · ${triggerLabel(copy, row.trigger)}`,
        },
        {
          label: copy.columns.version,
          value: row.appVersion ?? copy.emptyValue,
          mono: true,
        },
      ]
    : [];

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent
        data-dashboard-floating-layer="system-performance-drawer"
        className="!w-full !max-w-none sm:!w-[min(58vw,36rem)]"
        overlayClassName="hidden"
        onFocusOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DrawerHeader className="border-b">
          <DrawerTitle>{title}</DrawerTitle>
          <DrawerDescription className="break-all font-mono text-xs">
            {subtitle}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerScrollArea contentClassName="space-y-6 p-4">
          {target ? (
            <>
              {target.type === "sample" || target.type === "error" ? (
                <div className="flex flex-wrap gap-2">
                  <ResultBadge copy={copy} result={target.row.resultClass} />
                  {target.type === "error" && target.row.category ? (
                    <Badge variant="outline">
                      {categoryLabel(copy, target.row.category)}
                    </Badge>
                  ) : null}
                </div>
              ) : null}

              {target.type === "sample" ? (
                <SampleBody locale={locale} copy={copy} row={target.row} />
              ) : target.type === "route" ? (
                <RouteBody locale={locale} copy={copy} row={target.row} />
              ) : target.type === "hotspot" ? (
                <StatGrid
                  items={[
                    {
                      id: "total",
                      label: copy.hotspots.kinds[target.kind],
                      value: formatHotspotValue(
                        locale,
                        target.kind,
                        target.row.weightedValue,
                      ),
                    },
                    {
                      id: "average",
                      label: copy.columns.average,
                      value: formatHotspotValue(
                        locale,
                        target.kind,
                        target.row.estimatedInvocations > 0
                          ? target.row.weightedValue /
                              target.row.estimatedInvocations
                          : null,
                      ),
                    },
                    {
                      id: "invocations",
                      label: copy.columns.invocations,
                      value: formatCount(
                        locale,
                        target.row.estimatedInvocations,
                      ),
                    },
                  ]}
                />
              ) : (
                <StatGrid
                  className="sm:grid-cols-2"
                  items={[
                    {
                      id: "invocations",
                      label: copy.columns.invocations,
                      value: formatCount(
                        locale,
                        target.row.estimatedInvocations,
                      ),
                    },
                    {
                      id: "operation",
                      label: copy.columns.operation,
                      value: (
                        <span className="font-mono text-sm">
                          {target.row.operation ?? copy.emptyValue}
                        </span>
                      ),
                    },
                  ]}
                />
              )}

              <Section title={copy.detail.summary}>
                <DetailList
                  items={[
                    ...context,
                    ...(target.type === "hotspot"
                      ? [
                          ...(target.row.variant
                            ? [
                                {
                                  label: copy.detail.variant,
                                  value: target.row.variant,
                                  mono: true,
                                },
                              ]
                            : []),
                          ...(target.row.filterShape
                            ? [
                                {
                                  label: copy.columns.filterShape,
                                  value: target.row.filterShape,
                                  mono: true,
                                },
                              ]
                            : []),
                          {
                            label: copy.detail.granularity,
                            value:
                              copy.detail.granularities[target.row.granularity],
                          },
                          ...(target.row.owner
                            ? [
                                {
                                  label: copy.detail.owner,
                                  value: target.row.owner,
                                  mono: true,
                                },
                              ]
                            : []),
                        ]
                      : []),
                    ...(target.type === "sample" && target.row.hotQueryId
                      ? [
                          {
                            label: copy.columns.query,
                            value: target.row.hotQueryId,
                            mono: true,
                          },
                        ]
                      : []),
                  ]}
                />
              </Section>

              <div className="flex flex-wrap gap-2 border-t pt-4">
                {target.type === "route" ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => actions.filterRoute(target.row.routeKey)}
                    >
                      {copy.actions.filterRoute}
                    </Button>
                    {target.row.source === "worker" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          actions.viewHotspots(target.row.routeKey)
                        }
                      >
                        {copy.actions.viewHotspots}
                      </Button>
                    ) : null}
                  </>
                ) : null}
                {target.type !== "sample" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => actions.viewSamples(target)}
                  >
                    {copy.actions.viewSamples}
                  </Button>
                ) : null}
                {row?.appVersion && row.appVersion !== "unknown" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => actions.filterVersion(row.appVersion ?? "")}
                  >
                    {copy.actions.filterVersion}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </DrawerScrollArea>
      </DrawerContent>
    </Drawer>
  );
}
