import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { RiArrowDownSLine, RiSearchLine } from "@remixicon/react";
import { useInfiniteQuery } from "@tanstack/react-query";

import {
  convertCanonicalTextToDisplay,
  convertDisplayTextToCanonical,
  type FilterNumberCanonicalUnit,
  type FilterNumberDisplayUnit,
  getFilterNumberDisplayUnits,
  toDisplayNumberMetadata,
} from "@/components/dashboard/filters/filter-number-units";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OverlayScrollbar } from "@/components/ui/overlay-scrollbar";
import { Popover } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DashboardFilterOptionKey } from "@/lib/dashboard/client/data/index";
import {
  fetchEventTypeFields,
  fetchEventTypeFieldValues,
  fetchFilterValues,
} from "@/lib/dashboard/client/data/index";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { EventField } from "@/lib/dashboard-api/client/edge";
import { type RegisteredFilterField } from "@/lib/filter-contract/filter-registry";
import {
  analyticsFilterRegistry,
  type FilterDocument,
  type FilterScope,
  type FilterValue,
  type FilterValueKind,
} from "@/lib/filter-contract/index";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

import {
  isSelectablePayloadFieldType,
  payloadFieldTypeLabel,
} from "./field-catalog";
import type { EditorCondition, ValueSuggestionPage } from "./model";
import {
  filterValueKey,
  filterValueText,
  LIST_OPERATORS,
  stripSuggestionFacet,
} from "./model";
export function SearchablePayloadPathInput({
  condition,
  document,
  eventName,
  messages,
  needsValue,
  onChange,
  onSelect,
  resolvedScope,
  siteId,
  window,
}: {
  condition: EditorCondition;
  document: FilterDocument;
  eventName: string | undefined;
  messages: AppMessages;
  needsValue: boolean;
  onChange: (payloadPath: string) => void;
  onSelect: (field: EventField) => void;
  resolvedScope?: FilterScope;
  siteId: string | undefined;
  window: TimeWindow | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [searchToken, setSearchToken] = useState("");
  const deferredSearchToken = useDeferredValue(searchToken);
  const canSearch = Boolean(siteId && window && resolvedScope);
  const suggestionFilters = useMemo(
    () =>
      stripSuggestionFacet(document, condition.field, condition.payloadPath),
    [condition.field, condition.payloadPath, document],
  );
  const fieldsQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "event-field-paths",
      siteId,
      window?.from,
      window?.to,
      window?.timeZone,
      eventName,
      resolvedScope ?? "unresolved",
      suggestionFilters,
      needsValue,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      fetchEventTypeFields(siteId!, window!, eventName, suggestionFilters, {
        limit: 100,
        cursor: pageParam,
        signal,
        resolvedScope,
      }),
    enabled: open && canSearch,
    getNextPageParam: (lastPage) =>
      lastPage.data?.pagination?.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
  });
  const fields =
    fieldsQuery.data?.pages.flatMap((page) => page.data.items) ?? [];
  const suggestions = useMemo(() => {
    const search = deferredSearchToken.trim().toLocaleLowerCase();
    return fields
      .filter(
        (field) =>
          field.path &&
          (!needsValue || isSelectablePayloadFieldType(field.valueType)) &&
          (!search || field.path.toLocaleLowerCase().includes(search)),
      )
      .slice(0, 12);
  }, [deferredSearchToken, fields, needsValue]);
  const menuState = fieldsQuery.isFetching
    ? "loading"
    : suggestions.length > 0
      ? "suggestions"
      : "empty";

  useEffect(() => {
    if (open) setSearchToken("");
  }, [condition.field, condition.id, eventName, open]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-8 w-full justify-between pr-2 text-xs font-normal"
        >
          <span className="min-w-0 truncate text-left">
            {condition.payloadPath || messages.filterBuilder.valueUnset}
          </span>
          <RiArrowDownSLine className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="relative w-[var(--radix-popover-trigger-width)] origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-none border border-border bg-popover text-popover-foreground shadow-md outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <div className="relative">
            <RiSearchLine
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              className="border-0 pl-9 font-mono text-xs shadow-none focus-visible:ring-0"
              value={searchToken}
              placeholder={messages.filterBuilder.jsonPointerPlaceholder}
              onChange={(event) => {
                const next = event.target.value;
                setSearchToken(next);
                onChange(next);
              }}
            />
          </div>
          <AutoResizer initial duration={0.18}>
            <AutoTransition transitionKey={menuState} duration={0.18}>
              {fieldsQuery.isFetching ? (
                <div className="flex min-h-10 items-center justify-center border-t border-border text-muted-foreground">
                  <Spinner aria-label={messages.filterBuilder.valueLoading} />
                </div>
              ) : suggestions.length > 0 ? (
                <OverlayScrollbar
                  axis="vertical"
                  syncKey={suggestions.length}
                  className="max-h-56 border-t border-border pt-1"
                >
                  {suggestions.map((field) => (
                    <button
                      key={`${field.valueType}:${field.path}`}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                      onClick={() => {
                        onSelect(field);
                        setSearchToken("");
                        setOpen(false);
                      }}
                    >
                      <span className="min-w-0 truncate font-mono">
                        {field.path}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {payloadFieldTypeLabel(field.valueType, messages)}
                      </span>
                    </button>
                  ))}
                </OverlayScrollbar>
              ) : null}
            </AutoTransition>
          </AutoResizer>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
function filterNumberUnitLabel(
  unit: FilterNumberDisplayUnit,
  messages: AppMessages,
): string {
  switch (unit) {
    case "hours":
      return messages.filterBuilder.units.hours;
    case "minutes":
      return messages.filterBuilder.units.minutes;
    case "seconds":
      return messages.filterBuilder.units.seconds;
    case "milliseconds":
      return messages.filterBuilder.units.milliseconds;
    case "percent":
      return messages.filterBuilder.units.percent;
    case "per-mille":
      return messages.filterBuilder.units.perMille;
    case "px":
      return messages.filterBuilder.units.pixels;
  }
}
function defaultFilterNumberDisplayUnit(
  canonicalUnit: FilterNumberCanonicalUnit,
): FilterNumberDisplayUnit {
  switch (canonicalUnit) {
    case "ms":
      return "milliseconds";
    case "ratio":
      return "percent";
    case "px":
      return "px";
  }
}
function FilterNumberUnitSelect({
  canonicalUnit,
  disabled = false,
  displayUnit,
  messages,
  onChange,
}: {
  canonicalUnit: FilterNumberCanonicalUnit;
  disabled?: boolean;
  displayUnit: FilterNumberDisplayUnit;
  messages: AppMessages;
  onChange: (unit: FilterNumberDisplayUnit) => void;
}) {
  const units = getFilterNumberDisplayUnits(canonicalUnit);
  return (
    <Select
      value={displayUnit}
      disabled={disabled || units.length <= 1}
      onValueChange={(value) => {
        if (units.includes(value as FilterNumberDisplayUnit)) {
          onChange(value as FilterNumberDisplayUnit);
        }
      }}
    >
      <SelectTrigger
        aria-label={messages.filterBuilder.unitAriaLabel}
        className="w-full"
      >
        <SelectValue>
          {filterNumberUnitLabel(displayUnit, messages)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {units.map((unit) => (
          <SelectItem key={unit} value={unit}>
            {filterNumberUnitLabel(unit, messages)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function SearchableValueInput({
  condition,
  disabled = false,
  document,
  eventName,
  messages,
  onChange,
  onListChange,
  resolvedScope,
  siteId,
  valueKind,
  window,
}: {
  condition: EditorCondition;
  disabled?: boolean;
  document: FilterDocument;
  eventName: string | undefined;
  messages: AppMessages;
  onChange: (valueText: string) => void;
  onListChange: (values: readonly FilterValue[]) => void;
  resolvedScope?: FilterScope;
  siteId: string | undefined;
  valueKind: FilterValueKind;
  window: TimeWindow | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [searchToken, setSearchToken] = useState("");
  const deferredSearchToken = useDeferredValue(searchToken);
  const isPayload = condition.field === "event.payload";
  const definition = isPayload
    ? undefined
    : (analyticsFilterRegistry.get(condition.field) as
        RegisteredFilterField | undefined);
  const suggestionMode =
    definition?.suggestionMode ?? (isPayload ? "discrete" : "none");
  const suggestionFilters = useMemo(
    () =>
      stripSuggestionFacet(document, condition.field, condition.payloadPath),
    [condition.field, condition.payloadPath, document],
  );
  const isList = LIST_OPERATORS.has(condition.operator);
  const selectedValues = isList
    ? (condition.listValues ??
      (Array.isArray(condition.value) ? condition.value : []))
    : [];
  const canSearch = Boolean(
    siteId &&
    window &&
    resolvedScope &&
    (isPayload
      ? condition.payloadPath.trim()
      : condition.field !== "event.payload"),
  );
  const suggestionsQuery = useInfiniteQuery<ValueSuggestionPage>({
    queryKey: [
      "dashboard",
      isPayload ? "event-field-values" : "filter-values",
      siteId,
      window?.from,
      window?.to,
      window?.timeZone,
      ...(isPayload
        ? [eventName, condition.payloadPath, condition.scalarKind]
        : [condition.field]),
      suggestionMode,
      deferredSearchToken,
      resolvedScope ?? "unresolved",
      suggestionFilters,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => {
      if (isPayload) {
        return fetchEventTypeFieldValues(
          siteId!,
          window!,
          eventName,
          condition.payloadPath,
          condition.scalarKind,
          suggestionFilters,
          {
            limit: 12,
            cursor: pageParam as string | null,
            search: deferredSearchToken,
            signal,
            resolvedScope,
          },
        ).then((result) => ({
          items: result.data.items.map((item) => ({
            value: item.value,
            occurrences: item.occurrences,
            label: String(item.value ?? ""),
          })),
          pagination: result.data.pagination,
        }));
      }
      return fetchFilterValues(
        siteId!,
        window!,
        condition.field as DashboardFilterOptionKey,
        suggestionFilters,
        {
          limit: 12,
          cursor: pageParam as string | null,
          search: deferredSearchToken,
          signal,
          resolvedScope,
        },
      ).then((result) => ({
        items: result.items,
        pagination: result.pagination,
      }));
    },
    enabled: open && canSearch && !disabled && suggestionMode !== "none",
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.nextCursor : undefined,
  });
  const suggestions =
    suggestionsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const inputMode =
    valueKind === "number" || condition.scalarKind === "number"
      ? "decimal"
      : undefined;
  const inputType =
    valueKind === "number" || condition.scalarKind === "number"
      ? "number"
      : valueKind === "date"
        ? "date"
        : valueKind === "datetime"
          ? "datetime-local"
          : "text";
  const numberMetadata = definition?.number;
  const numberUnit = valueKind === "number" ? definition?.unit : undefined;
  const [selectedDisplayUnit, setSelectedDisplayUnit] = useState<
    FilterNumberDisplayUnit | undefined
  >(() =>
    numberUnit ? defaultFilterNumberDisplayUnit(numberUnit) : undefined,
  );
  const displayUnit = numberUnit
    ? (selectedDisplayUnit ?? defaultFilterNumberDisplayUnit(numberUnit))
    : undefined;
  const displayMetadata = toDisplayNumberMetadata(
    numberMetadata,
    numberUnit,
    displayUnit,
  );

  useEffect(() => {
    setSelectedDisplayUnit(
      numberUnit ? defaultFilterNumberDisplayUnit(numberUnit) : undefined,
    );
  }, [condition.field, condition.id, numberUnit]);

  const displayValueText = numberUnit
    ? convertCanonicalTextToDisplay(
        condition.valueText,
        numberUnit,
        displayUnit,
      )
    : condition.valueText;
  const canonicalTextFromDisplay = (valueText: string) =>
    numberUnit
      ? convertDisplayTextToCanonical(valueText, displayUnit, numberUnit)
      : valueText;

  const menuState = suggestionsQuery.isFetching
    ? "loading"
    : suggestions.length > 0
      ? "suggestions"
      : "empty";

  useEffect(() => {
    if (open) setSearchToken("");
  }, [condition.id, condition.field, condition.operator, open]);

  if (!isPayload && suggestionMode === "none" && !isList) {
    return (
      <div
        className={cn(
          "grid gap-2",
          numberUnit && "sm:grid-cols-[minmax(0,2fr)_minmax(6rem,1fr)]",
        )}
      >
        <Input
          disabled={disabled}
          type={inputType}
          value={displayValueText}
          inputMode={inputMode}
          min={displayMetadata?.min ?? numberMetadata?.min}
          max={displayMetadata?.max ?? numberMetadata?.max}
          step={displayMetadata?.step ?? numberMetadata?.step}
          onChange={(event) =>
            onChange(canonicalTextFromDisplay(event.target.value))
          }
        />
        {numberUnit && displayUnit ? (
          <FilterNumberUnitSelect
            canonicalUnit={numberUnit}
            displayUnit={displayUnit}
            messages={messages}
            onChange={setSelectedDisplayUnit}
          />
        ) : null}
      </div>
    );
  }

  const addListValue = (value: FilterValue, valueIsCanonical = false) => {
    if (typeof value === "string" && !value.trim()) return;
    const canonicalValue =
      !valueIsCanonical &&
      numberUnit &&
      displayUnit &&
      typeof value === "string"
        ? Number(convertDisplayTextToCanonical(value, displayUnit, numberUnit))
        : value;
    if (
      numberUnit &&
      typeof canonicalValue === "number" &&
      !Number.isFinite(canonicalValue)
    ) {
      return;
    }
    const nextValues = selectedValues.some(
      (selected) => filterValueKey(selected) === filterValueKey(canonicalValue),
    )
      ? selectedValues
      : [...selectedValues, canonicalValue];
    onListChange(nextValues);
    setSearchToken("");
  };

  return (
    <div
      className={cn(
        "grid gap-2",
        numberUnit && "sm:grid-cols-[minmax(0,2fr)_minmax(6rem,1fr)]",
      )}
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="h-8 w-full justify-between pr-2 text-xs font-normal"
          >
            <span className="min-w-0 truncate text-left">
              {isList
                ? selectedValues
                    .map((value) =>
                      numberUnit && displayUnit
                        ? convertCanonicalTextToDisplay(
                            filterValueText(value),
                            numberUnit,
                            displayUnit,
                          )
                        : filterValueText(value),
                    )
                    .join(", ") || messages.filterBuilder.valueUnset
                : displayValueText || messages.filterBuilder.valueUnset}
            </span>
            <RiArrowDownSLine className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={4}
            className="relative w-[var(--radix-popover-trigger-width)] origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-none border border-border bg-popover text-popover-foreground shadow-md outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {isList && selectedValues.length > 0 ? (
              <div className="flex flex-wrap gap-1 border-b border-border px-2 py-1.5">
                {selectedValues.map((value) => {
                  const displayText =
                    numberUnit && displayUnit
                      ? convertCanonicalTextToDisplay(
                          filterValueText(value),
                          numberUnit,
                          displayUnit,
                        )
                      : filterValueText(value);
                  const removeValueLabel = formatI18nTemplate(
                    messages.filterBuilder.removeValue,
                    { value: displayText },
                  );

                  return (
                    <Tooltip key={filterValueKey(value)}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="max-w-full truncate bg-muted px-1.5 py-0.5 text-xs hover:bg-accent"
                          aria-label={removeValueLabel}
                          onClick={() =>
                            onListChange(
                              selectedValues.filter(
                                (selected) =>
                                  filterValueKey(selected) !==
                                  filterValueKey(value),
                              ),
                            )
                          }
                        >
                          {displayText}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{removeValueLabel}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            ) : null}
            <div className="relative">
              <RiSearchLine
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                autoFocus
                disabled={disabled}
                className="border-0 pl-9 text-xs shadow-none focus-visible:ring-0"
                type={inputType}
                value={searchToken}
                inputMode={inputMode}
                min={displayMetadata?.min ?? numberMetadata?.min}
                max={displayMetadata?.max ?? numberMetadata?.max}
                step={displayMetadata?.step ?? numberMetadata?.step}
                placeholder={
                  isList
                    ? messages.filterBuilder.valueListPlaceholder
                    : messages.filterBuilder.valueSearchPlaceholder
                }
                onChange={(event) => {
                  const next = event.target.value;
                  setSearchToken(next);
                  if (!isList) onChange(canonicalTextFromDisplay(next));
                }}
                onKeyDown={(event) => {
                  if (isList && event.key === "Enter") {
                    event.preventDefault();
                    addListValue(searchToken);
                  }
                }}
              />
            </div>
            <AutoResizer initial duration={0.18}>
              <AutoTransition transitionKey={menuState} duration={0.18}>
                {suggestionsQuery.isFetching ? (
                  <div className="flex min-h-10 items-center justify-center border-t border-border text-muted-foreground">
                    <Spinner aria-label={messages.filterBuilder.valueLoading} />
                  </div>
                ) : suggestions.length > 0 ? (
                  <OverlayScrollbar
                    axis="vertical"
                    syncKey={suggestions.length}
                    className="max-h-56 border-t border-border pt-1"
                  >
                    {suggestions.map((item) => {
                      const value = item.value;
                      const label = "label" in item ? item.label : value;
                      return (
                        <button
                          key={`${typeof value}:${filterValueKey(value)}`}
                          type="button"
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                          onClick={() => {
                            if (isList) {
                              addListValue(value, true);
                            } else {
                              const valueText = filterValueText(value);
                              const displayText =
                                numberUnit && displayUnit
                                  ? convertCanonicalTextToDisplay(
                                      valueText,
                                      numberUnit,
                                      displayUnit,
                                    )
                                  : valueText;
                              onChange(valueText);
                              setSearchToken(displayText);
                              setOpen(false);
                            }
                          }}
                        >
                          <span className="min-w-0 truncate">
                            {label ?? filterValueText(value)}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {item.occurrences ?? 0}
                          </span>
                        </button>
                      );
                    })}
                  </OverlayScrollbar>
                ) : null}
              </AutoTransition>
            </AutoResizer>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {numberUnit && displayUnit ? (
        <FilterNumberUnitSelect
          canonicalUnit={numberUnit}
          displayUnit={displayUnit}
          messages={messages}
          onChange={setSelectedDisplayUnit}
        />
      ) : null}
    </div>
  );
}
export function RangeValueInput({
  condition,
  disabled = false,
  inputMode,
  messages,
  numberMetadata,
  numberUnit,
  onChange,
}: {
  condition: EditorCondition;
  disabled?: boolean;
  inputMode?: "decimal";
  messages: AppMessages;
  numberMetadata?: RegisteredFilterField["number"];
  numberUnit?: FilterNumberCanonicalUnit;
  onChange: (valueText: string) => void;
}) {
  const [lower = "", upper = ""] = condition.valueText.split(",", 2);
  const [selectedDisplayUnit, setSelectedDisplayUnit] = useState<
    FilterNumberDisplayUnit | undefined
  >(() =>
    numberUnit ? defaultFilterNumberDisplayUnit(numberUnit) : undefined,
  );
  const displayUnit = numberUnit
    ? (selectedDisplayUnit ?? defaultFilterNumberDisplayUnit(numberUnit))
    : undefined;
  const displayMetadata = toDisplayNumberMetadata(
    numberMetadata,
    numberUnit,
    displayUnit,
  );
  useEffect(() => {
    setSelectedDisplayUnit(
      numberUnit ? defaultFilterNumberDisplayUnit(numberUnit) : undefined,
    );
  }, [condition.field, condition.id, numberUnit]);
  const displayLower =
    numberUnit && displayUnit
      ? convertCanonicalTextToDisplay(lower, numberUnit, displayUnit)
      : lower.trim();
  const displayUpper =
    numberUnit && displayUnit
      ? convertCanonicalTextToDisplay(upper, numberUnit, displayUnit)
      : upper.trim();
  const updateEndpoint = (index: 0 | 1, value: string) => {
    const canonicalValue =
      numberUnit && displayUnit
        ? convertDisplayTextToCanonical(value, displayUnit, numberUnit)
        : value;
    onChange(
      index === 0
        ? `${canonicalValue}, ${upper.trim()}`
        : `${lower.trim()}, ${canonicalValue}`,
    );
  };
  return (
    <div
      className={cn(
        "grid gap-2",
        numberUnit ? "sm:grid-cols-3" : "sm:grid-cols-2",
      )}
    >
      <Input
        disabled={disabled}
        type={numberMetadata ? "number" : undefined}
        value={displayLower}
        inputMode={inputMode}
        min={displayMetadata?.min ?? numberMetadata?.min}
        max={displayMetadata?.max ?? numberMetadata?.max}
        step={displayMetadata?.step ?? numberMetadata?.step}
        placeholder={messages.filterBuilder.rangeStartPlaceholder}
        onChange={(event) => updateEndpoint(0, event.target.value)}
      />
      <Input
        disabled={disabled}
        type={numberMetadata ? "number" : undefined}
        value={displayUpper}
        inputMode={inputMode}
        min={displayMetadata?.min ?? numberMetadata?.min}
        max={displayMetadata?.max ?? numberMetadata?.max}
        step={displayMetadata?.step ?? numberMetadata?.step}
        placeholder={messages.filterBuilder.rangeEndPlaceholder}
        onChange={(event) => updateEndpoint(1, event.target.value)}
      />
      {numberUnit && displayUnit ? (
        <FilterNumberUnitSelect
          canonicalUnit={numberUnit}
          displayUnit={displayUnit}
          messages={messages}
          onChange={setSelectedDisplayUnit}
        />
      ) : null}
    </div>
  );
}
