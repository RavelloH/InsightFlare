import { useMemo, useState } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Button } from "@insightflare/ui/button";
import { Input } from "@insightflare/ui/input";
import { Label } from "@insightflare/ui/label";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@insightflare/ui/responsive-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";
import {
  RiApps2Line,
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiBookOpenLine,
  RiCheckLine,
  RiCodeSSlashLine,
  RiFileCopyLine,
  RiGroupLine,
  RiUserLine,
} from "@remixicon/react";
import { toast } from "sonner";

import { describeFilterExpression } from "@/lib/dashboard/filter-description";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  SYSTEM_FILTER_PRESETS,
  type SystemFilterPreset,
  systemFilterPresetAvailableForAudience,
  systemFilterPresetOptionValue,
} from "@/lib/dashboard/system-filter-presets";
import {
  analyticsFilterRegistry,
  assertFilterAudience,
  type FilterDocument,
  filterDocumentUsesAdvancedExpressions,
  filterDslDisplayTokens,
  filterDslFeatures,
  type FilterScope,
  type FilterScopePreference,
  formatFilterDslPretty,
  parseFilterDsl,
} from "@/lib/filter-contract/index";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import type {
  SavedFilter,
  SavedFilterInput,
  SavedFilterVisibility,
} from "@/lib/saved-filters";

import type { FilterPanelAudience } from "./filter-editor/model";
import { filterDslTokenColors } from "./filter-dsl-highlight";
export const NO_SAVED_FILTER_VALUE = "__no_saved_filter__";
export const EMPTY_SAVED_FILTER_FORM = {
  name: "",
  description: "",
  visibility: "private",
  scopePreference: "auto",
} as const satisfies Omit<SavedFilterInput, "filterDsl">;
export type SavedFilterForm = Omit<SavedFilterInput, "filterDsl">;
export type MessageRecord = Record<string, unknown>;
export type SystemPresetCopy = {
  readonly name: string;
  readonly description: string;
};
export function readMessagePath(
  messages: AppMessages,
  path: string,
): string | undefined {
  let value: unknown = messages;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as MessageRecord)[segment];
  }
  return typeof value === "string" ? value : undefined;
}
export function systemPresetItem(
  messages: AppMessages,
  preset: SystemFilterPreset,
): SystemPresetCopy {
  const item = (
    messages.filterBuilder.systemPresetItems as unknown as MessageRecord
  )[preset.id];
  const legacyItem =
    item && typeof item === "object" ? (item as MessageRecord) : undefined;
  return {
    name:
      readMessagePath(messages, preset.labelKey) ??
      (typeof legacyItem?.name === "string" ? legacyItem.name : preset.id),
    description:
      readMessagePath(messages, preset.descriptionKey) ??
      (typeof legacyItem?.description === "string"
        ? legacyItem.description
        : ""),
  };
}
export function systemPresetCategoryLabel(
  messages: AppMessages,
  category: string,
): string {
  const categories = (messages.filterBuilder as unknown as MessageRecord)
    .systemPresetCategories;
  return categories && typeof categories === "object"
    ? (((categories as MessageRecord)[category] as string | undefined) ??
        category)
    : category;
}
export function systemPresetGroupLabel(
  messages: AppMessages,
  category: string,
): string {
  return `${messages.filterBuilder.systemPresets} · ${systemPresetCategoryLabel(messages, category)}`;
}
export function systemPresetScopeLabel(
  messages: AppMessages,
  scope: SystemFilterPreset["scope"],
): string {
  const scopes = (messages.filterBuilder as unknown as MessageRecord)
    .systemPresetScopes;
  return scopes && typeof scopes === "object"
    ? (((scopes as MessageRecord)[scope] as string | undefined) ?? scope)
    : scope;
}
export function systemPresetScopeForApply(
  preset: SystemFilterPreset,
  currentScope: FilterScopePreference,
): FilterScopePreference {
  return preset.scope === "preserve" ? currentScope : preset.scope;
}
export function systemPresetMatchesScope(
  preset: SystemFilterPreset,
  currentScope: FilterScopePreference,
): boolean {
  return preset.scope === "preserve" || preset.scope === currentScope;
}
export function SavedFilterSelect({
  audience,
  matchedSavedFilter,
  matchedSystemPreset,
  messages,
  savedFilterTriggerKey,
  savedFilterTriggerLabel,
  savedFilters,
  savedFiltersLoading,
  onApplySavedFilter,
  onApplySystemPreset,
  onClearSavedFilter,
}: {
  readonly audience: FilterPanelAudience;
  readonly matchedSavedFilter?: SavedFilter;
  readonly matchedSystemPreset?: SystemFilterPreset;
  readonly messages: AppMessages;
  readonly savedFilterTriggerKey: string;
  readonly savedFilterTriggerLabel: string;
  readonly savedFilters: readonly SavedFilter[];
  readonly savedFiltersLoading: boolean;
  readonly onApplySavedFilter: (filter: SavedFilter) => void;
  readonly onApplySystemPreset: (preset: SystemFilterPreset) => void;
  readonly onClearSavedFilter: () => void;
}) {
  const copy = messages.filterBuilder.filterLibrary;
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<
    "all" | "personal" | "team" | "system"
  >("all");
  const [search, setSearch] = useState("");
  const [topic, setTopic] = useState("all");
  const [kind, setKind] = useState("all");
  const [scope, setScope] = useState("all");
  const [selected, setSelected] = useState("");
  const [mobileDetail, setMobileDetail] = useState(false);
  const [formatted, setFormatted] = useState(true);
  const [wrap, setWrap] = useState(false);
  const activeKey =
    matchedSavedFilter?.id ??
    (matchedSystemPreset
      ? systemFilterPresetOptionValue(matchedSystemPreset.id)
      : "");
  const entries = useMemo(() => {
    if (!open) return [];
    const personal =
      audience === "private-dashboard"
        ? savedFilters.map((filter) => ({
            key: filter.id,
            name: filter.name,
            description: filter.description,
            source: filter.isOwner ? ("personal" as const) : ("team" as const),
            dsl: filter.filterDsl,
            scope: filter.scopePreference,
            filter,
            preset: undefined,
          }))
        : [];
    const system = SYSTEM_FILTER_PRESETS.filter((preset) =>
      systemFilterPresetAvailableForAudience(preset, audience),
    ).map((preset) => ({
      key: systemFilterPresetOptionValue(preset.id),
      ...systemPresetItem(messages, preset),
      source: "system" as const,
      dsl: preset.filterDsl,
      scope: preset.scope,
      filter: undefined,
      preset,
    }));
    return [
      ...personal.filter((item) => item.source === "personal"),
      ...personal.filter((item) => item.source === "team"),
      ...system,
    ].map((item) => {
      try {
        if (item.filter && item.filter.filterDslVersion !== 1)
          throw new Error("Unsupported DSL version");
        const document = parseFilterDsl(item.dsl, analyticsFilterRegistry);
        assertFilterAudience(document, analyticsFilterRegistry, audience);
        return {
          ...item,
          document,
          advanced: filterDocumentUsesAdvancedExpressions(document),
        };
      } catch {
        return { ...item, document: undefined, advanced: false };
      }
    });
  }, [audience, messages, savedFilters, open]);
  const topics = Array.from(
    new Set(
      entries.flatMap((item) => (item.preset ? [item.preset.category] : [])),
    ),
  );
  const categories = [
    { id: "all" as const, label: copy.all, icon: RiApps2Line },
    { id: "personal" as const, label: copy.personal, icon: RiUserLine },
    { id: "team" as const, label: copy.team, icon: RiGroupLine },
    {
      id: "system" as const,
      label: messages.filterBuilder.systemPresets,
      icon: RiBookOpenLine,
    },
  ].filter(
    (item) =>
      audience === "private-dashboard" ||
      item.id === "all" ||
      item.id === "system",
  );
  const scopeLabel = (value: string) =>
    value === "auto"
      ? copy.auto
      : systemPresetScopeLabel(messages, value as SystemFilterPreset["scope"]);
  const sourceLabel = (value: string) =>
    categories.find((item) => item.id === value)?.label ?? value;
  const needle = search.trim().toLocaleLowerCase();
  const visible = entries.filter(
    (item) =>
      (category === "all" || item.source === category) &&
      (category !== "system" ||
        ((topic === "all" || item.preset?.category === topic) &&
          (kind === "all" || item.advanced === (kind === "advanced")) &&
          (scope === "all" || item.scope === scope))) &&
      (!needle ||
        [
          item.name,
          item.description,
          item.dsl,
          item.filter?.authorName ?? "",
          item.preset
            ? systemPresetCategoryLabel(messages, item.preset.category)
            : "",
        ].some((value) => value.toLocaleLowerCase().includes(needle))),
  );
  const groups = new Map<string, typeof visible>();
  for (const item of visible) {
    const group = item.preset
      ? systemPresetGroupLabel(messages, item.preset.category)
      : sourceLabel(item.source);
    const values = groups.get(group) ?? [];
    values.push(item);
    groups.set(group, values);
  }
  const current = visible.find((item) => item.key === selected) ?? visible[0];
  const source = current
    ? formatted && current.document
      ? formatFilterDslPretty(current.document, analyticsFilterRegistry)
      : current.dsl
    : "";
  const tokens = useMemo(() => filterDslDisplayTokens(source), [source]);
  const features = current?.document ? filterDslFeatures(current.document) : [];
  const tokenColors = filterDslTokenColors;
  // Keep physical line numbers independent of soft wrapping.
  const lines: Array<Array<{ text: string; kind: keyof typeof tokenColors }>> =
    [[]];
  for (const token of tokens) {
    token.text.split("\n").forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ text: part, kind: token.kind });
    });
  }
  const changeCategory = (value: typeof category) => {
    setCategory(value);
    setTopic("all");
    setKind("all");
    setScope("all");
    setSelected("");
    setMobileDetail(false);
  };
  const changeOpen = (value: boolean) => {
    if (value) {
      changeCategory("all");
      setSearch("");
      setSelected(activeKey);
    }
    setOpen(value);
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={changeOpen}>
      <ResponsiveDialogTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between gap-2 font-normal"
          disabled={savedFiltersLoading}
        >
          <span className="min-w-0 truncate">
            <AutoTransition
              transitionKey={savedFilterTriggerKey}
              type="fade"
              duration={0.18}
              initial={false}
            >
              <span>
                {activeKey || savedFiltersLoading
                  ? savedFilterTriggerLabel
                  : copy.choose}
              </span>
            </AutoTransition>
          </span>
          <RiArrowDownSLine
            className="size-4 shrink-0 opacity-60"
            aria-hidden
          />
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent
        className="gap-0 overflow-hidden p-0"
        desktopClassName="h-[min(760px,85dvh)] max-w-[1160px]"
        drawerClassName="h-[94dvh] max-h-[94dvh] data-[vaul-drawer-direction=bottom]:max-h-[94dvh]"
      >
        <div className="shrink-0 border-b border-border px-4 py-3 pr-12">
          <ResponsiveDialogTitle icon={RiBookOpenLine}>
            {copy.title}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {copy.description}
          </ResponsiveDialogDescription>
        </div>
        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <nav
            aria-label={copy.categories}
            className="flex w-20 shrink-0 flex-col gap-1 border-r border-border bg-muted/20 p-2 max-md:w-full max-md:flex-row max-md:border-r-0 max-md:border-b"
          >
            {categories.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                aria-pressed={category === id}
                onClick={() => changeCategory(id)}
                className={
                  "flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 py-3 text-center transition-colors md:flex-none " +
                  (category === id
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50")
                }
              >
                <Icon className="size-5" aria-hidden />
                <span className="text-[11px] leading-tight">{label}</span>
              </button>
            ))}
          </nav>
          <div
            className={
              "flex min-h-0 min-w-0 flex-1 flex-col border-r border-border md:w-[310px] md:flex-none " +
              (mobileDetail ? "max-md:hidden" : "")
            }
          >
            <div className="shrink-0 space-y-2 border-b border-border p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{sourceLabel(category)}</span>
                <span className="text-muted-foreground tabular-nums">
                  {visible.length}
                </span>
              </div>
              <Input
                aria-label={copy.search}
                placeholder={copy.search}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setMobileDetail(false);
                }}
              />
              {category === "system" && (
                <div className="grid grid-cols-2 gap-2">
                  <Select value={topic} onValueChange={setTopic}>
                    <SelectTrigger
                      aria-label={copy.topic}
                      className="col-span-2 w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{copy.allTopics}</SelectItem>
                      {topics.map((value) => (
                        <SelectItem key={value} value={value}>
                          {systemPresetCategoryLabel(messages, value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={kind} onValueChange={setKind}>
                    <SelectTrigger aria-label={copy.type} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{copy.allTypes}</SelectItem>
                      <SelectItem value="standard">{copy.standard}</SelectItem>
                      <SelectItem value="advanced">{copy.advanced}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={scope} onValueChange={setScope}>
                    <SelectTrigger aria-label={copy.scope} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{copy.allScopes}</SelectItem>
                      {["preserve", "event", "session", "visitor"].map(
                        (value) => (
                          <SelectItem key={value} value={value}>
                            {scopeLabel(value)}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <AutoTransition
                transitionKey={
                  category + ":" + topic + ":" + kind + ":" + scope
                }
                type="fade"
                duration={0.16}
                initial={false}
              >
                {[...groups.entries()].map(([group, items], groupIndex) => (
                  <section key={group} className="mb-2">
                    {groupIndex > 0 && (
                      <hr className="mx-2 mb-2 border-border" />
                    )}
                    <h4 className="px-2 py-2 text-[10px] font-medium text-muted-foreground">
                      {group}
                    </h4>
                    {items.map((item) => (
                      <button
                        type="button"
                        key={item.key}
                        aria-pressed={current?.key === item.key}
                        onClick={() => {
                          setSelected(item.key);
                          setMobileDetail(true);
                        }}
                        className={
                          "block w-full space-y-1.5 border-l-2 border-transparent px-3 py-2.5 text-left transition-colors " +
                          (current?.key === item.key
                            ? "border-primary bg-accent text-accent-foreground"
                            : "hover:bg-muted/50")
                        }
                      >
                        <span className="flex items-center justify-between gap-2 font-medium">
                          <span className="truncate">{item.name}</span>
                          {activeKey === item.key && (
                            <RiCheckLine
                              className="size-4 shrink-0 text-primary"
                              aria-label={copy.currentMatch}
                            />
                          )}
                        </span>
                        {item.description && (
                          <span className="line-clamp-2 text-muted-foreground">
                            {item.description}
                          </span>
                        )}
                        <span className="flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                          <span>{sourceLabel(item.source)}</span>
                          <span>{scopeLabel(item.scope)}</span>
                          {item.preset && (
                            <span>
                              {systemPresetCategoryLabel(
                                messages,
                                item.preset.category,
                              )}
                            </span>
                          )}
                          {item.advanced && (
                            <span className="font-medium text-primary">
                              {copy.advanced}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </section>
                ))}
              </AutoTransition>
              {!visible.length && (
                <p className="p-4 text-center text-muted-foreground">
                  {copy.empty}
                </p>
              )}
            </div>
          </div>
          <div
            className={
              "flex min-h-0 min-w-0 flex-1 flex-col " +
              (!mobileDetail ? "max-md:hidden" : "")
            }
          >
            <div className="border-b border-border p-2 md:hidden">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setMobileDetail(false)}
              >
                <RiArrowLeftLine />
                {copy.back}
              </Button>
            </div>
            {current ? (
              <>
                <div className="max-h-[42%] shrink-0 overflow-y-auto border-b border-border">
                  <AutoResizer initial={false} duration={0.18}>
                    <AutoTransition
                      transitionKey={current.key}
                      initial={false}
                      type="fade"
                      duration={0.18}
                      className="space-y-3 p-4"
                    >
                      <h3 className="break-words text-base font-semibold">
                        {current.name}
                      </h3>
                      {current.description && (
                        <p className="whitespace-pre-wrap break-words text-muted-foreground">
                          {current.description}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                        <span>{sourceLabel(current.source)}</span>
                        <span>{scopeLabel(current.scope)}</span>
                        {current.preset && (
                          <span>
                            {systemPresetCategoryLabel(
                              messages,
                              current.preset.category,
                            )}
                          </span>
                        )}
                        {current.advanced && <span>{copy.advanced}</span>}
                        {current.filter && (
                          <>
                            <span>
                              {formatI18nTemplate(
                                messages.filterBuilder.savedFiltersAuthor,
                                { name: current.filter.authorName },
                              )}
                            </span>
                            <span>
                              {current.filter.visibility === "team"
                                ? messages.filterBuilder.savedFiltersTeamShared
                                : messages.filterBuilder.savedFiltersPrivate}
                            </span>
                            <span title={copy.updated}>
                              {new Date(
                                current.filter.updatedAt * 1000,
                              ).toLocaleString()}
                            </span>
                          </>
                        )}
                      </div>
                      {features.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="mr-1 text-muted-foreground">
                            {copy.features}
                          </span>
                          {features.map((feature) => (
                            <code
                              key={feature}
                              className="border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[11px]"
                            >
                              {feature}
                            </code>
                          ))}
                        </div>
                      )}
                      {current.document ? (
                        <p className="break-words text-muted-foreground">
                          {describeFilterExpression(
                            current.document.root,
                            analyticsFilterRegistry,
                            messages,
                          )}
                        </p>
                      ) : (
                        <p className="text-destructive">
                          {messages.filterBuilder.expressionInvalid}
                        </p>
                      )}
                    </AutoTransition>
                  </AutoResizer>
                </div>
                <div className="flex min-h-0 flex-1 flex-col bg-muted/20">
                  <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                    <span className="flex items-center gap-2 font-medium">
                      <RiCodeSSlashLine className="size-4" />
                      Filter DSL{" "}
                      <span className="text-muted-foreground">
                        v{current.filter?.filterDslVersion ?? 1}
                      </span>
                    </span>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        size="sm"
                        variant={formatted ? "secondary" : "ghost"}
                        onClick={() => setFormatted(true)}
                      >
                        {copy.formatted}
                      </Button>
                      <Button
                        size="sm"
                        variant={!formatted ? "secondary" : "ghost"}
                        onClick={() => setFormatted(false)}
                      >
                        {copy.original}
                      </Button>
                      <Button
                        size="sm"
                        variant={wrap ? "secondary" : "ghost"}
                        aria-pressed={wrap}
                        onClick={() => setWrap(!wrap)}
                      >
                        {copy.wrap}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title={copy.copy}
                        onClick={() => {
                          void navigator.clipboard.writeText(source).then(
                            () => toast.success(copy.copied),
                            () => toast.error(copy.copyFailed),
                          );
                        }}
                      >
                        <RiFileCopyLine />
                        {copy.copy}
                      </Button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto bg-background p-3 font-mono text-xs leading-6">
                    <AutoTransition
                      transitionKey={current.key + ":" + formatted}
                      type="fade"
                      initial={false}
                      duration={0.16}
                      className={wrap ? "min-w-0" : "min-w-max"}
                    >
                      {lines.map((line, index) => (
                        <div key={index} className="flex min-h-6 items-start">
                          <span
                            aria-hidden
                            className="mr-3 w-7 shrink-0 select-none text-right text-muted-foreground/60"
                          >
                            {index + 1}
                          </span>
                          <code
                            className={
                              wrap
                                ? "min-w-0 whitespace-pre-wrap break-all"
                                : "whitespace-pre"
                            }
                          >
                            {line.map((token, tokenIndex) => (
                              <span
                                key={tokenIndex}
                                className={tokenColors[token.kind]}
                              >
                                {token.text}
                              </span>
                            ))}
                          </code>
                        </div>
                      ))}
                    </AutoTransition>
                  </div>
                </div>
              </>
            ) : (
              <div className="grid flex-1 place-items-center p-4 text-muted-foreground">
                {copy.empty}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border p-3">
          <Button
            variant="ghost"
            onClick={() => {
              onClearSavedFilter();
              setOpen(false);
            }}
          >
            {messages.filterBuilder.noSavedFilter}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {copy.cancel}
            </Button>
            <Button
              className={mobileDetail ? undefined : "max-md:hidden"}
              disabled={!current?.document?.root}
              onClick={() => {
                if (!current?.document?.root) return;
                if (current.filter) onApplySavedFilter(current.filter);
                else if (current.preset) onApplySystemPreset(current.preset);
                setOpen(false);
              }}
            >
              {messages.filterBuilder.apply}
            </Button>
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

export interface FilterPanelProps {
  readonly audience: FilterPanelAudience;
  readonly document: FilterDocument;
  /** Raw DSL associated with the active query document, when available. */
  readonly expressionText?: string;
  readonly messages: AppMessages;
  readonly open: boolean;
  readonly siteId?: string;
  /** Concrete scope resolved by the parent page for the active operation. */
  readonly resolvedScope?: FilterScope;
  readonly scopePreference: FilterScopePreference;
  readonly window?: TimeWindow;
  readonly onApply: (
    document: FilterDocument,
    rawDsl?: string,
    options?: { readonly closePanel?: boolean },
  ) => void;
  readonly onScopeChange: (preference: FilterScopePreference) => void;
}
export function SavedFilterFormFields({
  form,
  messages,
  onChange,
}: {
  form: SavedFilterForm;
  messages: AppMessages;
  onChange: (next: SavedFilterForm) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="saved-filter-name">
          {messages.filterBuilder.savedFilterName}
        </Label>
        <Input
          id="saved-filter-name"
          maxLength={120}
          value={form.name}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="saved-filter-description">
          {messages.filterBuilder.savedFilterDescription}
        </Label>
        <textarea
          id="saved-filter-description"
          className="flex min-h-20 w-full resize-y border border-input bg-transparent px-2 py-1.5 text-xs shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          maxLength={2_000}
          value={form.description}
          onChange={(event) =>
            onChange({ ...form, description: event.target.value })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label>{messages.filterBuilder.scopeLabel}</Label>
        <Select
          value={form.scopePreference ?? "auto"}
          onValueChange={(scopePreference) =>
            onChange({
              ...form,
              scopePreference: scopePreference as FilterScopePreference,
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">
              {messages.filterBuilder.scopeAuto}
            </SelectItem>
            <SelectItem value="event">
              {messages.filterBuilder.scopeEvent}
            </SelectItem>
            <SelectItem value="session">
              {messages.filterBuilder.scopeSession}
            </SelectItem>
            <SelectItem value="visitor">
              {messages.filterBuilder.scopeVisitor}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>{messages.filterBuilder.savedFilterVisibility}</Label>
        <Select
          value={form.visibility}
          onValueChange={(visibility) =>
            onChange({
              ...form,
              visibility: visibility as SavedFilterVisibility,
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="private">
              {messages.filterBuilder.savedFilterVisibilityPrivate}
            </SelectItem>
            <SelectItem value="team">
              {messages.filterBuilder.savedFilterVisibilityTeam}
            </SelectItem>
          </SelectContent>
        </Select>
        <AutoResizer initial={false} duration={0.18}>
          <AutoTransition
            transitionKey={form.visibility}
            type="fade"
            duration={0.18}
            initial={false}
          >
            {form.visibility === "team" ? (
              <p className="text-xs text-muted-foreground">
                {messages.filterBuilder.savedFilterVisibilityTeamHint}
              </p>
            ) : null}
          </AutoTransition>
        </AutoResizer>
      </div>
    </div>
  );
}
export function FilterPanelHeader({
  audience,
  matchedSavedFilter,
  matchedSystemPreset,
  messages,
  savedFilterTriggerKey,
  savedFilterTriggerLabel,
  savedFilters,
  savedFiltersLoading,
  scopePreference,
  onApplySavedFilter,
  onApplySystemPreset,
  onClearSavedFilter,
  onScopeChange,
}: {
  audience: FilterPanelAudience;
  matchedSavedFilter?: SavedFilter;
  matchedSystemPreset?: SystemFilterPreset;
  messages: AppMessages;
  savedFilterTriggerKey: string;
  savedFilterTriggerLabel: string;
  savedFilters: readonly SavedFilter[];
  savedFiltersLoading: boolean;
  scopePreference: FilterScopePreference;
  onApplySavedFilter: (filter: SavedFilter) => void;
  onApplySystemPreset: (preset: SystemFilterPreset) => void;
  onClearSavedFilter: () => void;
  onScopeChange: (preference: FilterScopePreference) => void;
}) {
  return (
    <>
      <div className="mb-4 border-b border-border pb-4">
        <SavedFilterSelect
          audience={audience}
          matchedSavedFilter={matchedSavedFilter}
          matchedSystemPreset={matchedSystemPreset}
          messages={messages}
          savedFilterTriggerKey={savedFilterTriggerKey}
          savedFilterTriggerLabel={savedFilterTriggerLabel}
          savedFilters={savedFilters}
          savedFiltersLoading={savedFiltersLoading}
          onApplySavedFilter={onApplySavedFilter}
          onApplySystemPreset={onApplySystemPreset}
          onClearSavedFilter={onClearSavedFilter}
        />

        <AutoResizer initial={false} duration={0.18}>
          <AutoTransition
            transitionKey={
              matchedSavedFilter?.id ??
              (matchedSystemPreset
                ? systemFilterPresetOptionValue(matchedSystemPreset.id)
                : "none")
            }
            type="fade"
            duration={0.18}
            initial={false}
          >
            {matchedSavedFilter ? (
              <div className="space-y-1.5 pt-3 text-xs text-muted-foreground">
                {matchedSavedFilter.description ? (
                  <p className="break-words">
                    {matchedSavedFilter.description}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1">
                    <RiUserLine className="size-3.5" aria-hidden />
                    {formatI18nTemplate(
                      messages.filterBuilder.savedFiltersAuthor,
                      { name: matchedSavedFilter.authorName },
                    )}
                  </span>
                  <span>
                    {matchedSavedFilter.visibility === "team"
                      ? messages.filterBuilder.savedFiltersTeamShared
                      : messages.filterBuilder.savedFiltersPrivate}
                  </span>
                </div>
              </div>
            ) : matchedSystemPreset ? (
              <div className="space-y-1.5 pt-3 text-xs text-muted-foreground">
                <p>
                  {systemPresetItem(messages, matchedSystemPreset).description}
                </p>
                <p className="flex flex-wrap gap-x-3 gap-y-1">
                  <span>
                    {systemPresetCategoryLabel(
                      messages,
                      matchedSystemPreset.category,
                    )}
                  </span>
                  <span>
                    {systemPresetScopeLabel(
                      messages,
                      matchedSystemPreset.scope,
                    )}
                  </span>
                </p>
              </div>
            ) : null}
          </AutoTransition>
        </AutoResizer>
      </div>

      <div className="mb-4 border-b border-border pb-4">
        <div className="space-y-1.5">
          <Label htmlFor="filter-panel-scope">
            {messages.filterBuilder.scopeLabel}
          </Label>
          <Select
            value={scopePreference}
            onValueChange={(value) =>
              onScopeChange(value as FilterScopePreference)
            }
          >
            <SelectTrigger id="filter-panel-scope" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                {messages.filterBuilder.scopeAuto}
              </SelectItem>
              <SelectItem value="event">
                {messages.filterBuilder.scopeEvent}
              </SelectItem>
              <SelectItem value="session">
                {messages.filterBuilder.scopeSession}
              </SelectItem>
              <SelectItem value="visitor">
                {messages.filterBuilder.scopeVisitor}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </>
  );
}
