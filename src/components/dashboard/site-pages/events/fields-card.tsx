import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiArrowDownSLine,
  RiCheckLine,
  RiDatabase2Line,
  RiFileList3Line,
  RiFilter3Line,
  RiFilterOffLine,
  RiSearchLine,
  RiStackLine,
} from "@remixicon/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AnimatePresence, useReducedMotion } from "motion/react";

import { AnimatedDataTableRow } from "@/components/dashboard/common/animated-data-table-row";
import { DataTableSwitch } from "@/components/dashboard/common/data-table-switch";
import { useInfiniteTableSentinel } from "@/components/dashboard/common/use-infinite-table-sentinel";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  fetchEventTypeFields,
  fetchEventTypeFieldValues,
} from "@/lib/dashboard/client/data/index";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import { appendEventPayloadFilter } from "@/lib/dashboard/filter-state";
import { numberFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { EventField } from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

import {
  eventFieldKey,
  eventFieldValueKey,
  FIELD_TREE_CHILD_TRANSITION,
  formatFieldValueLabel,
  formatPayloadFilterRules,
  isPayloadFilterActive,
  normalizeEventFieldPath,
  parsePayloadFilterInput,
  payloadFilterValuesEqual,
  payloadFilterValueType,
} from "./event-model";
import {
  buildEventFieldTree,
  collectEventFieldTreeExpansionKeys,
  EventFieldTreeSkeleton,
  formatEventFieldKeySegment,
} from "./field-tree";
import { PayloadFilterButton } from "./payload-filters";
import {
  type EventFieldTreeNode,
  type EventPageCopy,
  type EventPayloadFilterRule,
  type EventPayloadFilterValue,
} from "./types";
export const EventFieldsCard = memo(function EventFieldsCard({
  locale,
  labels,
  siteId,
  window: timeWindow,
  filters,
  eventName,
  loading,
}: {
  locale: Locale;
  labels: EventPageCopy;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  eventName: string;
  loading: boolean;
}) {
  const fieldsSectionRef = useRef<HTMLElement | null>(null);
  const [fieldsVisible, setFieldsVisible] = useState(false);
  const reduceDataRowMotion = useReducedMotion() ?? false;
  const [payloadFilters, setPayloadFilters] = useState<
    EventPayloadFilterRule[]
  >([]);
  const [payloadFilterDialogOpen, setPayloadFilterDialogOpen] = useState(false);
  const [payloadFilterDraft, setPayloadFilterDraft] = useState("");
  const [payloadFilterError, setPayloadFilterError] = useState("");
  const payloadFiltersKey = useMemo(
    () => JSON.stringify(payloadFilters),
    [payloadFilters],
  );
  const activePayloadFilterCount = payloadFilters.length;
  const effectiveFilters = useMemo<FilterDocument>(() => {
    if (payloadFilters.length === 0) return filters;
    return payloadFilters.reduce(
      (document, rule) =>
        appendEventPayloadFilter(
          document,
          rule.path,
          rule.operator,
          rule.value,
        ),
      filters,
    );
  }, [filters, payloadFilters, payloadFiltersKey]);
  const effectiveFiltersKey = useMemo(
    () => filterQueryKey(effectiveFilters),
    [effectiveFilters],
  );
  const baseFiltersKey = useMemo(() => filterQueryKey(filters), [filters]);
  useEffect(() => {
    const section = fieldsSectionRef.current;
    if (!section) return;
    if (typeof IntersectionObserver === "undefined") {
      setFieldsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setFieldsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px", threshold: 0.01 },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  const fieldsQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "event-type-fields",
      siteId,
      eventName,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      baseFiltersKey,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      fetchEventTypeFields(siteId, timeWindow, eventName, filters, {
        limit: 100,
        cursor: pageParam,
        signal,
      }),
    enabled: typeof window !== "undefined" && fieldsVisible && !loading,
    getNextPageParam: (lastPage) =>
      lastPage.data?.pagination?.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
  });
  const filteredFieldsQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "event-filtered-fields",
      siteId,
      eventName,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      effectiveFiltersKey,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      fetchEventTypeFields(siteId, timeWindow, eventName, effectiveFilters, {
        limit: 100,
        cursor: pageParam,
        signal,
      }),
    enabled:
      typeof window !== "undefined" &&
      fieldsVisible &&
      activePayloadFilterCount > 0 &&
      !loading,
    getNextPageParam: (lastPage) =>
      lastPage.data?.pagination?.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
  });
  const baseFields =
    fieldsQuery.data?.pages.flatMap((page) => page.data.items) ?? [];
  const filteredFields =
    filteredFieldsQuery.data?.pages.flatMap((page) => page.data.items) ?? [];
  const filteredFieldsLoading = filteredFieldsQuery.isPending;
  const filteredFieldsError = filteredFieldsQuery.isError;
  const activeFields =
    activePayloadFilterCount > 0
      ? filteredFieldsLoading && filteredFields.length === 0
        ? baseFields
        : filteredFields
      : baseFields;
  const fieldListLoading =
    loading ||
    (fieldsVisible && fieldsQuery.isPending) ||
    (activePayloadFilterCount > 0 && filteredFieldsLoading);
  const fieldListError =
    fieldsQuery.isError ||
    (activePayloadFilterCount > 0 && filteredFieldsError);
  const fieldTree = useMemo(
    () => buildEventFieldTree(activeFields),
    [activeFields],
  );
  const defaultExpandedFieldKeys = useMemo(
    () => collectEventFieldTreeExpansionKeys(fieldTree),
    [fieldTree],
  );
  const preferredSelectedField = useMemo(() => {
    if (activeFields.length === 0) return null;
    return (
      activeFields.find(
        (field) =>
          field.valueType !== "object" &&
          field.valueType !== "array" &&
          normalizeEventFieldPath(field.path) !== "",
      ) ??
      activeFields.find(
        (field) => normalizeEventFieldPath(field.path) !== "",
      ) ??
      activeFields[0] ??
      null
    );
  }, [activeFields]);
  const fieldRequestKey = useMemo(
    () =>
      [
        siteId,
        eventName,
        timeWindow.from,
        timeWindow.to,
        timeWindow.interval,
        timeWindow.timeZone,
        effectiveFiltersKey,
      ].join(":"),
    [
      eventName,
      effectiveFiltersKey,
      siteId,
      timeWindow.from,
      timeWindow.interval,
      timeWindow.timeZone,
      timeWindow.to,
    ],
  );
  const [selectedFieldKey, setSelectedFieldKey] = useState("");
  const [expandedFieldKeys, setExpandedFieldKeys] = useState<Set<string>>(
    () => new Set(defaultExpandedFieldKeys),
  );

  const selectedField = useMemo(() => {
    if (activeFields.length === 0) return null;
    if (selectedFieldKey) {
      const match = activeFields.find(
        (field) => eventFieldKey(field) === selectedFieldKey,
      );
      if (match) return match;
    }
    return preferredSelectedField;
  }, [activeFields, preferredSelectedField, selectedFieldKey]);

  const selectedFieldResolvedKey = selectedField
    ? eventFieldKey(selectedField)
    : "";

  useEffect(() => {
    setExpandedFieldKeys(new Set(defaultExpandedFieldKeys));
  }, [defaultExpandedFieldKeys, fieldRequestKey]);

  const fieldValuesQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "event-field-values",
      siteId,
      eventName,
      selectedField?.path ?? "",
      selectedField?.valueType ?? "",
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      effectiveFiltersKey,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      fetchEventTypeFieldValues(
        siteId,
        timeWindow,
        eventName,
        selectedField?.path ?? "",
        selectedField?.valueType ?? "string",
        effectiveFilters,
        { limit: 25, cursor: pageParam, signal },
      ),
    enabled:
      typeof window !== "undefined" &&
      !fieldListLoading &&
      Boolean(selectedField),
    getNextPageParam: (lastPage) =>
      lastPage.data?.pagination?.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
  });
  const fieldValues =
    fieldValuesQuery.data?.pages.flatMap((page) => page.data.items) ?? [];
  const fieldValuesLoading = fieldValuesQuery.isPending;
  const fieldValuesLoadingMore = fieldValuesQuery.isFetchingNextPage;
  const fieldValuesError = fieldValuesQuery.isError;
  const fieldValuesAppendError = fieldValuesQuery.isFetchNextPageError;
  const fieldValuesHasMore = fieldValuesQuery.hasNextPage ?? false;
  const fieldValuesLoadMoreInFlightRef = useRef(false);

  useEffect(() => {
    if (!fieldValuesLoadingMore || !fieldValuesHasMore) {
      fieldValuesLoadMoreInFlightRef.current = false;
    }
  }, [fieldValuesHasMore, fieldValuesLoadingMore]);

  const loadMoreFieldValues = useCallback(() => {
    if (
      !fieldValuesHasMore ||
      fieldValuesLoadingMore ||
      fieldValuesLoadMoreInFlightRef.current
    ) {
      return;
    }
    fieldValuesLoadMoreInFlightRef.current = true;
    void fieldValuesQuery.fetchNextPage();
  }, [
    fieldValuesHasMore,
    fieldValuesLoadingMore,
    fieldValuesQuery.fetchNextPage,
  ]);

  const fieldValuesSentinelRef = useInfiniteTableSentinel({
    enabled:
      Boolean(selectedField) &&
      !fieldValuesLoading &&
      !fieldValuesLoadingMore &&
      !fieldValuesError &&
      !fieldValuesAppendError &&
      fieldValuesHasMore,
    onReachEnd: loadMoreFieldValues,
    rootMargin: "0px",
    triggerDistance: 0,
  });

  const fieldValueTotal = useMemo(
    () =>
      fieldValues.reduce(
        (sum, item) => sum + Math.max(0, Number(item.occurrences ?? 0)),
        0,
      ),
    [fieldValues],
  );

  const openPayloadFilterDialog = () => {
    setPayloadFilterDraft(formatPayloadFilterRules(payloadFilters));
    setPayloadFilterError("");
    setPayloadFilterDialogOpen(true);
  };

  const applyPayloadFilterDraft = () => {
    const parsed = parsePayloadFilterInput(payloadFilterDraft);
    if (!parsed.ok) {
      setPayloadFilterError(labels.payloadFilterInvalid);
      return;
    }
    setPayloadFilters(parsed.rules);
    setPayloadFilterError("");
    setPayloadFilterDialogOpen(false);
  };

  const clearPayloadFilters = () => {
    setPayloadFilterDraft("");
    setPayloadFilters([]);
    setPayloadFilterError("");
  };

  const applyFieldValueFilter = (
    field: EventField,
    value: EventPayloadFilterValue,
  ) => {
    const path = normalizeEventFieldPath(field.path);
    if (!path) return;
    setPayloadFilters((current) => {
      const hasSameValueFilter = current.some(
        (rule) =>
          rule.operator === "eq" &&
          normalizeEventFieldPath(rule.path) === path &&
          payloadFilterValueType(rule.value) ===
            payloadFilterValueType(value) &&
          payloadFilterValuesEqual(rule.value, value),
      );
      const withoutCurrentPath = current.filter(
        (rule) => normalizeEventFieldPath(rule.path) !== path,
      );
      if (hasSameValueFilter) return withoutCurrentPath;
      return [
        ...withoutCurrentPath,
        {
          path,
          operator: "eq",
          value,
        },
      ];
    });
  };

  const toggleFieldExpansion = (fieldKey: string) => {
    setExpandedFieldKeys((current) => {
      const next = new Set(current);
      if (next.has(fieldKey)) {
        next.delete(fieldKey);
      } else {
        next.add(fieldKey);
      }
      return next;
    });
  };

  const renderFieldTreeNode = (
    node: EventFieldTreeNode,
    depth: number,
  ): ReactNode => {
    const nodeKey = node.path || "/";
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedFieldKeys.has(nodeKey);
    const isRoot = node.path === "";
    const isArrayItem = node.segment === "*";
    const selectableField =
      node.fields.find(
        (field) =>
          eventFieldKey(field) === selectedFieldResolvedKey &&
          field.valueType !== "object" &&
          field.valueType !== "array",
      ) ??
      node.fields.find(
        (field) => field.valueType !== "object" && field.valueType !== "array",
      ) ??
      null;
    const selectableFieldKey = selectableField
      ? eventFieldKey(selectableField)
      : "";
    const isSelected =
      Boolean(selectableFieldKey) &&
      selectableFieldKey === selectedFieldResolvedKey;
    const indentStyle = { paddingLeft: `${depth * 1.25}rem` };
    const fieldLabel = isRoot
      ? labels.payload
      : isArrayItem
        ? "*"
        : formatEventFieldKeySegment(node.segment);
    const childRows = isExpanded
      ? node.children.map((child) => renderFieldTreeNode(child, depth + 1))
      : null;
    const selectField = () => {
      if (!selectableField || fieldListLoading) return;
      setSelectedFieldKey(selectableFieldKey);
    };
    const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (!selectableField || fieldListLoading) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectField();
    };

    const openLine = (
      <div
        key={`${nodeKey}:open`}
        role={selectableField ? "button" : undefined}
        tabIndex={selectableField && !fieldListLoading ? 0 : undefined}
        onClick={selectableField ? selectField : undefined}
        onKeyDown={selectableField ? handleRowKeyDown : undefined}
        className={cn(
          "group flex items-center gap-2 rounded px-1 py-1 transition-[background-color,box-shadow,filter] duration-200",
          selectableField &&
            "cursor-pointer hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
          isSelected && "bg-accent/25 ring-1 ring-border/70",
          fieldListLoading && "opacity-80",
        )}
        style={indentStyle}
      >
        {hasChildren ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 rounded-none text-primary shadow-none transition-colors hover:bg-primary/10 hover:text-primary"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleFieldExpansion(nodeKey);
                }}
                disabled={fieldListLoading}
                aria-label={
                  isExpanded ? labels.collapseField : labels.expandField
                }
              >
                <RiArrowDownSLine
                  className={cn(
                    "size-3.5 transition-transform duration-200 ease-out",
                    isExpanded ? "rotate-0" : "-rotate-90",
                  )}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isExpanded ? labels.collapseField : labels.expandField}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="size-6 shrink-0" />
        )}

        <div className="min-w-0 flex-1 truncate">
          <span
            className={cn(
              "text-foreground",
              isArrayItem && "text-muted-foreground",
            )}
          >
            {fieldLabel}
          </span>
        </div>

        {selectableField ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  selectField();
                }}
                disabled={fieldListLoading}
                aria-label={`${labels.fieldValuesTitle}: ${fieldLabel}`}
              >
                <RiSearchLine className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{labels.fieldValuesTitle}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    );

    if (!hasChildren) return openLine;

    return (
      <div key={nodeKey} className="space-y-0.5">
        {openLine}
        <AutoResizer duration={0.22} ease={[0.22, 1, 0.36, 1]}>
          <AutoTransition
            initial={false}
            duration={0.18}
            customVariants={FIELD_TREE_CHILD_TRANSITION}
            presenceMode="sync"
            transitionKey={
              isExpanded ? `${nodeKey}:expanded` : `${nodeKey}:collapsed`
            }
          >
            {childRows ? <div className="space-y-0.5">{childRows}</div> : null}
          </AutoTransition>
        </AutoResizer>
      </div>
    );
  };

  const fieldValueTableHeader = (
    <TableRow className="hover:bg-transparent">
      <TableHead className="h-8 p-0">
        <div className="px-4">{labels.values}</div>
      </TableHead>
      <TableHead className="h-8 w-24 p-0">
        <div className="px-4 text-right">{labels.occurrences}</div>
      </TableHead>
    </TableRow>
  );

  const fieldValueRows = (
    <AnimatePresence initial={false} mode="popLayout">
      {fieldValues.map((item) => {
        const count = Math.max(0, Number(item.occurrences ?? 0));
        const progressPercent =
          fieldValueTotal > 0 ? (count / fieldValueTotal) * 100 : 0;
        const valueLabel = formatFieldValueLabel(item.value);
        const activeValueFilter =
          selectedField !== null &&
          isPayloadFilterActive(payloadFilters, selectedField.path, item.value);
        const selectValueFilter = () => {
          if (!selectedField || fieldListLoading) return;
          applyFieldValueFilter(selectedField, item.value);
        };
        const handleValueRowKeyDown = (
          event: KeyboardEvent<HTMLTableRowElement>,
        ) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          selectValueFilter();
        };

        return (
          <AnimatedDataTableRow
            key={eventFieldValueKey(item.value)}
            reduceMotion={reduceDataRowMotion}
            role="button"
            tabIndex={fieldListLoading ? undefined : 0}
            data-state={activeValueFilter ? "selected" : undefined}
            onClick={selectValueFilter}
            onKeyDown={handleValueRowKeyDown}
            className={cn(
              "cursor-pointer bg-no-repeat transition-[background-size,background-color,filter] duration-300 ease-out hover:bg-muted/30 hover:brightness-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
              activeValueFilter &&
                "bg-primary/10 hover:bg-primary/15 data-[state=selected]:bg-primary/10",
            )}
            style={{
              backgroundImage:
                "linear-gradient(90deg, var(--muted) 0%, var(--muted) 100%)",
              backgroundSize: `${progressPercent.toFixed(2)}% 100%`,
              backgroundPosition: "left top",
            }}
          >
            <TableCell className="whitespace-normal p-0 align-top">
              <div className="px-4 py-2 font-mono leading-5 break-words whitespace-normal">
                {valueLabel}
              </div>
            </TableCell>
            <TableCell className="p-0">
              <div className="px-4 py-2 text-right font-mono tabular-nums">
                {numberFormat(locale, count)}
              </div>
            </TableCell>
          </AnimatedDataTableRow>
        );
      })}
    </AnimatePresence>
  );

  const fieldValueLoadMoreRows = fieldValuesAppendError ? (
    <TableRow>
      <TableCell colSpan={2} className="h-16 text-center text-muted-foreground">
        {labels.loadError}
      </TableCell>
    </TableRow>
  ) : fieldValuesHasMore ? (
    <>
      {Array.from({ length: 3 }, (_, rowIndex) => (
        <TableRow
          key={`field-values-skeleton-${rowIndex}`}
          aria-hidden="true"
          className="pointer-events-none hover:bg-transparent"
        >
          <TableCell className="whitespace-normal p-0 align-top">
            <div className="px-4 py-2">
              <Skeleton
                className={cn("h-4", rowIndex === 1 ? "w-[72%]" : "w-[58%]")}
              />
            </div>
          </TableCell>
          <TableCell className="p-0">
            <div
              ref={rowIndex === 2 ? fieldValuesSentinelRef : undefined}
              className="flex justify-end px-4 py-2"
            >
              <Skeleton className="h-4 w-14" />
            </div>
          </TableCell>
        </TableRow>
      ))}
    </>
  ) : null;

  return (
    <>
      <section ref={fieldsSectionRef} className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="inline-flex items-center gap-2 text-sm font-medium">
              <RiFileList3Line className="size-4 shrink-0" />
              {labels.fieldsTitle}
            </h2>
          </div>
          <PayloadFilterButton
            labels={labels}
            count={activePayloadFilterCount}
            onClick={openPayloadFilterDialog}
          />
        </div>

        <div className="grid items-stretch gap-6 xl:grid-cols-2">
          <Card className="h-full overflow-hidden py-0">
            <CardHeader className="space-y-2 pt-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CardTitle className="inline-flex items-center gap-2">
                    <RiDatabase2Line className="size-4" />
                    {labels.payloadFields}
                  </CardTitle>
                  {fieldListLoading ? <Spinner className="size-3.5" /> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {labels.fieldsSubtitle}
                </p>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 pb-5">
              <div className="max-h-[38rem] overflow-auto pr-1 font-mono text-[13px] leading-6">
                {fieldListLoading ? (
                  <EventFieldTreeSkeleton loadingLabel={labels.loading} />
                ) : fieldListError ? (
                  <div className="rounded-none border border-border/50 bg-muted/20 px-4 py-6 font-sans text-sm text-muted-foreground">
                    {labels.loadError}
                  </div>
                ) : activeFields.length === 0 ? (
                  <div className="rounded-none border border-border/50 bg-muted/20 px-4 py-6 font-sans text-sm text-muted-foreground">
                    {labels.emptyFields}
                  </div>
                ) : fieldTree.children.length > 0 ? (
                  <div className="min-w-max">
                    {fieldTree.children.map((child) =>
                      renderFieldTreeNode(child, 0),
                    )}
                  </div>
                ) : (
                  <div className="min-w-max">
                    {renderFieldTreeNode(fieldTree, 0)}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="h-full overflow-hidden py-0">
            <CardHeader className="space-y-2 pt-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <CardTitle className="inline-flex items-center gap-2">
                      <RiStackLine className="size-4" />
                      {labels.fieldValuesTitle}
                    </CardTitle>
                    {fieldValuesLoading ? (
                      <Spinner className="size-3.5" />
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {labels.fieldValuesSubtitle}
                  </p>
                </div>
                {selectedField ? (
                  <AutoTransition
                    initial={false}
                    transitionKey={selectedFieldResolvedKey}
                    className="min-w-0 shrink-0"
                  >
                    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 pt-1">
                      <Badge variant="ghost" className="shrink-0">
                        {selectedField.valueType}
                      </Badge>
                      <span className="max-w-[18rem] truncate font-mono text-xs text-muted-foreground">
                        {selectedField.path || "/"}
                      </span>
                    </div>
                  </AutoTransition>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <DataTableSwitch
                loading={
                  fieldListLoading ||
                  (Boolean(selectedField) && fieldValuesLoading)
                }
                hasContent={
                  Boolean(selectedField) &&
                  !fieldValuesError &&
                  (fieldValues.length > 0 || fieldValuesHasMore)
                }
                loadingLabel={labels.loading}
                emptyLabel={
                  fieldValuesError ? labels.loadError : labels.fieldValuesEmpty
                }
                colSpan={2}
                header={fieldValueTableHeader}
                rows={fieldValueRows}
                footer={fieldValueLoadMoreRows}
                contentKey={selectedFieldResolvedKey || "field-values"}
              />
            </CardContent>
          </Card>
        </div>
      </section>

      <ResponsiveDialog
        open={payloadFilterDialogOpen}
        onOpenChange={setPayloadFilterDialogOpen}
      >
        <ResponsiveDialogContent desktopClassName="max-w-xl">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle icon={RiFilter3Line}>
              {labels.payloadFilterTitle}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {labels.payloadFilterSubtitle}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-2">
            <textarea
              value={payloadFilterDraft}
              onChange={(event) => {
                setPayloadFilterDraft(event.target.value);
                if (payloadFilterError) setPayloadFilterError("");
              }}
              placeholder={labels.payloadFilterPlaceholder}
              className="min-h-32 w-full resize-y rounded-none border bg-background px-3 py-2 font-mono text-xs leading-5 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
            />
            {payloadFilterError ? (
              <p className="text-xs text-destructive">{payloadFilterError}</p>
            ) : null}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={clearPayloadFilters}
            >
              <RiFilterOffLine className="size-4" />
              <span>{labels.payloadFilterClear}</span>
            </Button>
            <Button type="button" onClick={applyPayloadFilterDraft}>
              <RiCheckLine className="size-4" />
              <span>{labels.payloadFilterApply}</span>
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
});
