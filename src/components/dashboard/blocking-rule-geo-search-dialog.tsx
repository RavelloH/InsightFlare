import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { RiArrowLeftLine, RiSearchLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import {
  GeoBreadcrumbSeparator,
  GeoCountryBreadcrumbItem,
  GeoCountryFlag,
} from "@/components/dashboard/lazy-geo-location-label";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import {
  fetchGeoCountryCodes,
  fetchGeoCountryTranslationPayload,
  fetchGeoStateTranslationPayload,
  GEO_TRANSLATION_DATA_LOCALE,
  type GeoStateTranslationPayload,
  type GeoTranslationStateRecord,
  normalizeGeoTranslationLookupValue,
  pickLocaleGeoLabel,
  resolveGeoTranslationApiLocale,
} from "@/lib/dashboard/geo-translation";
import { resolveCountryLabel } from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";

export type BlockingRuleGeoSearchField = "countries" | "regions";

export interface BlockingRuleGeoSearchCopy {
  searchButton: string;
  searchTitle: string;
  searchDescription: string;
  searchInputLabel: string;
  searchInputPlaceholder: string;
  searchCountryLabel: string;
  searchRegionLabel: string;
  searchBack: string;
  searchLoading: string;
  searchNoResults: string;
  searchLoadError: string;
  searchClose: string;
}

interface CountrySearchEntry {
  code: string;
  label: string;
  searchLabels: readonly string[];
}

interface StateSearchEntry {
  countryCode: string;
  countryLabel: string;
  stateCode: string;
  label: string;
  value: string;
  searchLabels: readonly string[];
}

interface StatePayloadEntry {
  code: string;
  payload: GeoStateTranslationPayload | null;
}

const EMPTY_COUNTRY_CODES: readonly string[] = [];
const EMPTY_STATE_ENTRIES: readonly StatePayloadEntry[] = [];

function resolveGeoDataLocale(locale: Locale): string {
  return resolveGeoTranslationApiLocale(locale) ?? GEO_TRANSLATION_DATA_LOCALE;
}

function stringValues(values: readonly unknown[]): string[] {
  return values.flatMap((value) => {
    if (typeof value !== "string" && typeof value !== "number") return [];
    return [String(value)];
  });
}

function searchableValues(values: readonly unknown[]): string[] {
  return stringValues(values).flatMap((value) => {
    const normalized = normalizeGeoTranslationLookupValue(value);
    return normalized ? [normalized] : [];
  });
}

function matchesSearch(values: readonly unknown[], query: string): boolean {
  const normalizedQuery = normalizeGeoTranslationLookupValue(query);
  if (!normalizedQuery) return true;
  return searchableValues(values).some((value) =>
    value.includes(normalizedQuery),
  );
}

function stateCodeFromRecord(
  countryCode: string,
  fallbackCode: string,
  record: GeoTranslationStateRecord | undefined,
): string {
  const value = String(record?.iso3166_2 ?? "")
    .trim()
    .toUpperCase();
  return value || `${countryCode}-${fallbackCode}`;
}

function CountrySearchRow({
  entry,
  locale,
  onSelect,
}: {
  entry: CountrySearchEntry;
  locale: Locale;
  onSelect: (code: string) => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left text-xs transition-colors last:border-b-0 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      onClick={() => onSelect(entry.code)}
    >
      <GeoCountryFlag countryCode={entry.code} locale={locale} />
      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
      <code className="shrink-0 bg-muted px-1.5 py-0.5 font-mono text-[11px]">
        {entry.code}
      </code>
    </button>
  );
}

function RegionSearchRow({
  entry,
  locale,
  onSelect,
}: {
  entry: StateSearchEntry;
  locale: Locale;
  onSelect: (value: string) => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      onClick={() => onSelect(entry.value)}
    >
      <span className="min-w-0 flex-1">
        <span className="block min-w-0">
          <span className="inline-flex max-w-full items-center gap-1 text-xs">
            <GeoCountryFlag countryCode={entry.countryCode} locale={locale} />
            <span className="truncate">{entry.countryLabel}</span>
            <GeoBreadcrumbSeparator />
            <span className="truncate">{entry.label}</span>
          </span>
        </span>
      </span>
      <code className="shrink-0 bg-muted px-1.5 py-0.5 font-mono text-[11px]">
        {entry.value}
      </code>
    </button>
  );
}

export function BlockingRuleGeoSearchDialog({
  field,
  title,
  locale,
  copy,
  open,
  onOpenChange,
  onSelect,
}: {
  field: BlockingRuleGeoSearchField;
  title: string;
  locale: Locale;
  copy: BlockingRuleGeoSearchCopy;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedCountryCode, setSelectedCountryCode] = useState("");
  const deferredQuery = useDeferredValue(query);
  const apiLocale = resolveGeoDataLocale(locale);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setSelectedCountryCode("");
  }, [open]);

  const countryCodesQuery = useQuery({
    queryKey: ["blocking-rule-geo-search", "countries", apiLocale],
    queryFn: async () => {
      const countryCodes = await fetchGeoCountryCodes(apiLocale);
      if (!countryCodes) throw new Error("country codes unavailable");
      return countryCodes;
    },
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const countryCodes = countryCodesQuery.data ?? EMPTY_COUNTRY_CODES;

  const countryEntries = useMemo<CountrySearchEntry[]>(
    () =>
      countryCodes.map((code) => {
        const localizedLabel = resolveCountryLabel(code, locale, code).label;
        const englishLabel = resolveCountryLabel(code, "en", code).label;
        return {
          code,
          label: localizedLabel,
          searchLabels: [localizedLabel, englishLabel],
        };
      }),
    [countryCodes, locale],
  );
  const visibleCountryEntries = useMemo(
    () =>
      countryEntries.filter((entry) =>
        matchesSearch([entry.code, ...entry.searchLabels], deferredQuery),
      ),
    [countryEntries, deferredQuery],
  );
  const selectedCountry = countryEntries.find(
    (entry) => entry.code === selectedCountryCode,
  );

  const countryPayloadQuery = useQuery({
    queryKey: [
      "blocking-rule-geo-search",
      "country",
      apiLocale,
      selectedCountryCode,
    ],
    queryFn: async () => {
      const payload = await fetchGeoCountryTranslationPayload(
        apiLocale,
        selectedCountryCode,
      );
      if (!payload) throw new Error("country payload unavailable");
      return payload;
    },
    enabled: open && field === "regions" && Boolean(selectedCountryCode),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const stateCodes = countryPayloadQuery.data?.states ?? [];

  const statePayloadsQuery = useQuery({
    queryKey: [
      "blocking-rule-geo-search",
      "states",
      apiLocale,
      selectedCountryCode,
    ],
    queryFn: async () => {
      const payloads = await Promise.all(
        stateCodes.map(async (code) => ({
          code,
          payload: await fetchGeoStateTranslationPayload(
            apiLocale,
            selectedCountryCode,
            code,
          ),
        })),
      );
      return payloads;
    },
    enabled:
      open &&
      field === "regions" &&
      Boolean(selectedCountryCode) &&
      stateCodes.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const stateEntries = useMemo<StateSearchEntry[]>(() => {
    if (!selectedCountry) return [];
    const payloadByCode = new Map(
      (statePayloadsQuery.data ?? EMPTY_STATE_ENTRIES).map((entry) => [
        entry.code,
        entry.payload,
      ]),
    );
    return stateCodes.map((stateCode) => {
      const record = payloadByCode.get(stateCode)?.state;
      const value = stateCodeFromRecord(
        selectedCountry.code,
        stateCode,
        record,
      );
      return {
        countryCode: selectedCountry.code,
        countryLabel: selectedCountry.label,
        stateCode,
        label:
          pickLocaleGeoLabel(locale, record) ||
          String(record?.name_default ?? record?.name ?? stateCode).trim(),
        value,
        searchLabels: stringValues([
          record?.name,
          record?.name_default,
          record?.native,
          record?.code,
          record?.iso2,
          record?.iso3166_2,
          value,
          stateCode,
        ]),
      };
    });
  }, [locale, selectedCountry, stateCodes, statePayloadsQuery.data]);
  const visibleStateEntries = useMemo(
    () =>
      stateEntries.filter((entry) =>
        matchesSearch(
          [
            entry.label,
            ...entry.searchLabels,
            selectedCountry?.code,
            selectedCountry?.label,
          ],
          deferredQuery,
        ),
      ),
    [deferredQuery, selectedCountry, stateEntries],
  );

  const isRegionCountryStep = field === "regions" && !selectedCountry;
  const searchScopeLabel = isRegionCountryStep
    ? copy.searchCountryLabel
    : field === "regions"
      ? copy.searchRegionLabel
      : copy.searchCountryLabel;
  const isLoading = isRegionCountryStep
    ? countryCodesQuery.isPending
    : field === "countries"
      ? countryCodesQuery.isPending
      : countryPayloadQuery.isPending || statePayloadsQuery.isPending;
  const isError = isRegionCountryStep
    ? countryCodesQuery.isError
    : field === "countries"
      ? countryCodesQuery.isError
      : countryPayloadQuery.isError || statePayloadsQuery.isError;
  const hasResults = isRegionCountryStep
    ? visibleCountryEntries.length > 0
    : field === "countries"
      ? visibleCountryEntries.length > 0
      : visibleStateEntries.length > 0;
  const resultTransitionKey = isLoading
    ? "loading"
    : isError
      ? "error"
      : hasResults
        ? `results-${field}-${selectedCountryCode}-${deferredQuery}`
        : "empty";

  function handleSelect(value: string) {
    onSelect(value);
    onOpenChange(false);
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="max-w-xl"
        drawerClassName="overflow-hidden"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle icon={RiSearchLine}>
            {title} · {copy.searchTitle}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {copy.searchDescription}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <div className="flex flex-col gap-4">
            {field === "regions" && selectedCountry ? (
              <div className="border border-border bg-muted/20 px-3 py-2">
                <Breadcrumb className="max-w-full">
                  <BreadcrumbList className="flex-nowrap gap-1">
                    <GeoCountryBreadcrumbItem
                      countryLabel={selectedCountry.label}
                      countryCode={selectedCountry.code}
                      locale={locale}
                    />
                    <BreadcrumbItem className="min-w-0">
                      <GeoBreadcrumbSeparator />
                      <BreadcrumbPage className="block truncate leading-5">
                        {copy.searchRegionLabel}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    setSelectedCountryCode("");
                    setQuery("");
                  }}
                >
                  <RiArrowLeftLine className="size-3.5" />
                  <span>{copy.searchBack}</span>
                </Button>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor={`blocking-rule-geo-search-${field}`}>
                {copy.searchInputLabel} · {searchScopeLabel}
              </Label>
              <div className="relative">
                <RiSearchLine className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id={`blocking-rule-geo-search-${field}`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={copy.searchInputPlaceholder}
                  className="pl-8"
                  autoFocus
                />
              </div>
            </div>

            <AutoResizer>
              <AutoTransition
                className="pb-px"
                transitionKey={resultTransitionKey}
                initial={false}
                duration={0.15}
              >
                <div className="max-h-80 overflow-auto border-y border-border">
                  {isLoading ? (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                      {copy.searchLoading}
                    </p>
                  ) : isError ? (
                    <p
                      role="alert"
                      className="px-3 py-8 text-center text-xs text-destructive"
                    >
                      {copy.searchLoadError}
                    </p>
                  ) : hasResults ? (
                    isRegionCountryStep ? (
                      visibleCountryEntries.map((entry) => (
                        <CountrySearchRow
                          key={entry.code}
                          entry={entry}
                          locale={locale}
                          onSelect={(code) => {
                            setSelectedCountryCode(code);
                            setQuery("");
                          }}
                        />
                      ))
                    ) : field === "countries" ? (
                      visibleCountryEntries.map((entry) => (
                        <CountrySearchRow
                          key={entry.code}
                          entry={entry}
                          locale={locale}
                          onSelect={handleSelect}
                        />
                      ))
                    ) : (
                      visibleStateEntries.map((entry) => (
                        <RegionSearchRow
                          key={entry.value}
                          entry={entry}
                          locale={locale}
                          onSelect={handleSelect}
                        />
                      ))
                    )
                  ) : (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                      {copy.searchNoResults}
                    </p>
                  )}
                </div>
              </AutoTransition>
            </AutoResizer>
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <ResponsiveDialogClose asChild>
            <Button type="button" variant="outline">
              <span>{copy.searchClose}</span>
            </Button>
          </ResponsiveDialogClose>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
