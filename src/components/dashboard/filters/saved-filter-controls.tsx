import { Fragment } from "react";
import { RiUserLine } from "@remixicon/react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  SYSTEM_FILTER_PRESETS,
  type SystemFilterPreset,
  systemFilterPresetAvailableForAudience,
  systemFilterPresetFromOptionValue,
  systemFilterPresetOptionValue,
} from "@/lib/dashboard/system-filter-presets";
import {
  type FilterDocument,
  type FilterScope,
  type FilterScopePreference,
} from "@/lib/filter-contract/index";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import type {
  SavedFilter,
  SavedFilterInput,
  SavedFilterVisibility,
} from "@/lib/saved-filters";

import type { FilterPanelAudience } from "./filter-editor/model";
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
  const visibleSystemPresets = SYSTEM_FILTER_PRESETS.filter((preset) =>
    systemFilterPresetAvailableForAudience(preset, audience),
  );
  const systemPresetGroups = visibleSystemPresets.reduce<
    Array<{ category: string; presets: SystemFilterPreset[] }>
  >((groups, preset) => {
    const existing = groups.find((group) => group.category === preset.category);
    if (existing) {
      existing.presets.push(preset);
    } else {
      groups.push({ category: preset.category, presets: [preset] });
    }
    return groups;
  }, []);

  return (
    <Select
      value={
        matchedSavedFilter?.id ??
        (matchedSystemPreset
          ? systemFilterPresetOptionValue(matchedSystemPreset.id)
          : NO_SAVED_FILTER_VALUE)
      }
      disabled={savedFiltersLoading}
      onValueChange={(value) => {
        if (value === NO_SAVED_FILTER_VALUE) {
          onClearSavedFilter();
          return;
        }
        const preset = systemFilterPresetFromOptionValue(value);
        if (preset) {
          onApplySystemPreset(preset);
          return;
        }
        const filter = savedFilters.find((item) => item.id === value);
        if (filter) onApplySavedFilter(filter);
      }}
    >
      <SelectTrigger className="w-full">
        <SelectValue>
          <AutoTransition
            transitionKey={savedFilterTriggerKey}
            type="fade"
            duration={0.18}
            initial={false}
          >
            <span>{savedFilterTriggerLabel}</span>
          </AutoTransition>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={NO_SAVED_FILTER_VALUE}>
            {messages.filterBuilder.noSavedFilter}
          </SelectItem>
        </SelectGroup>
        {audience === "private-dashboard" &&
        savedFilters.some((filter) => filter.isOwner) ? (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>
                {messages.filterBuilder.savedFiltersPersonal}
              </SelectLabel>
              {savedFilters
                .filter((filter) => filter.isOwner)
                .map((filter) => (
                  <SelectItem key={filter.id} value={filter.id}>
                    {filter.name}
                  </SelectItem>
                ))}
            </SelectGroup>
          </>
        ) : null}
        {audience === "private-dashboard" &&
        savedFilters.some((filter) => !filter.isOwner) ? (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>
                {messages.filterBuilder.savedFiltersTeam}
              </SelectLabel>
              {savedFilters
                .filter((filter) => !filter.isOwner)
                .map((filter) => (
                  <SelectItem key={filter.id} value={filter.id}>
                    {filter.name}
                  </SelectItem>
                ))}
            </SelectGroup>
          </>
        ) : null}
        <SelectSeparator />
        {systemPresetGroups.map((group, index) => (
          <Fragment key={group.category}>
            {index > 0 ? <SelectSeparator /> : null}
            <SelectGroup>
              <SelectLabel>
                {systemPresetGroupLabel(messages, group.category)}
              </SelectLabel>
              {group.presets.map((preset) => (
                <SelectItem
                  key={preset.id}
                  value={systemFilterPresetOptionValue(preset.id)}
                >
                  {systemPresetItem(messages, preset).name}
                </SelectItem>
              ))}
            </SelectGroup>
          </Fragment>
        ))}
      </SelectContent>
    </Select>
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
