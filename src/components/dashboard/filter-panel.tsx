import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiCheckLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFileCopyLine,
  RiSaveLine,
  RiUserLine,
} from "@remixicon/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
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
import { Spinner } from "@/components/ui/spinner";
import {
  createSavedFilter,
  deleteSavedFilter,
  fetchSavedFilters,
  updateSavedFilter,
} from "@/lib/dashboard/client-data";
import { resolveSuggestionScope } from "@/lib/dashboard/filter-suggestion-scope";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  SYSTEM_FILTER_PRESETS,
  type SystemFilterPreset,
  systemFilterPresetAvailableForAudience,
  systemFilterPresetFromOptionValue,
  systemFilterPresetOptionValue,
} from "@/lib/dashboard/system-filter-presets";
import {
  analyticsFilterRegistry,
  attachFilterScopePreference,
  type FilterDocument,
  filterFingerprint,
  type FilterScope,
  type FilterScopePreference,
  FilterValidationError,
  parseFilterDsl,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import type {
  SavedFilter,
  SavedFilterInput,
  SavedFilterVisibility,
} from "@/lib/saved-filters";

import type { EditorGroup, FilterPanelAudience } from "./filter-editor";
import { FilterEditor } from "./filter-editor";
import {
  allowedFields,
  conditionIdFactory,
  documentFromEditor,
  editorRootFromDocument,
  emptyEditorGroup,
  expressionTextFromEditor,
  reconcileEditorRoot,
} from "./filter-editor";

const NO_SAVED_FILTER_VALUE = "__no_saved_filter__";
const EMPTY_SAVED_FILTER_FORM = {
  name: "",
  description: "",
  visibility: "private",
  scopePreference: "auto",
} as const satisfies Omit<SavedFilterInput, "filterDsl">;
type SavedFilterForm = Omit<SavedFilterInput, "filterDsl">;
type MessageRecord = Record<string, unknown>;
type SystemPresetCopy = { readonly name: string; readonly description: string };

function readMessagePath(
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

function systemPresetItem(
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

function systemPresetCategoryLabel(
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

function systemPresetScopeLabel(
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

interface FilterPanelProps {
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

function SavedFilterFormFields({
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

function FilterPanelHeader({
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

export function FilterPanel({
  audience,
  document,
  expressionText: restoredExpressionText,
  messages,
  open,
  resolvedScope: pageResolvedScope,
  siteId,
  scopePreference,
  window,
  onApply,
  onScopeChange,
}: FilterPanelProps) {
  const nextIdRef = useRef(conditionIdFactory());
  const createId = useCallback(() => nextIdRef.current(), []);
  const queryClient = useQueryClient();
  const documentKey = JSON.stringify(document);
  const [root, setRoot] = useState<EditorGroup>(() =>
    editorRootFromDocument(document, createId),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [expressionText, setExpressionText] = useState(() =>
    expressionTextFromEditor(root),
  );
  const [expressionError, setExpressionError] = useState<string | null>(null);
  const [createSavedFilterOpen, setCreateSavedFilterOpen] = useState(false);
  const [manageSavedFilterOpen, setManageSavedFilterOpen] = useState(false);
  const [confirmSavedFilterDeleteOpen, setConfirmSavedFilterDeleteOpen] =
    useState(false);
  const [managedSavedFilterId, setManagedSavedFilterId] = useState<
    string | undefined
  >();
  const [editingSavedFilterId, setEditingSavedFilterId] = useState<
    string | undefined
  >();
  const [savedFilterForm, setSavedFilterForm] = useState<SavedFilterForm>(
    EMPTY_SAVED_FILTER_FORM,
  );
  const [savedFilterOperationError, setSavedFilterOperationError] = useState<
    string | null
  >(null);
  const expressionUpdateRef = useRef(false);
  const preservedDocumentKeyRef = useRef<string | null>(null);
  const expressionRegistry = useMemo(
    () => new Map(allowedFields(audience).map((field) => [field.id, field])),
    [audience],
  );
  const suggestionScope = resolveSuggestionScope(
    scopePreference,
    pageResolvedScope,
  );
  const savedFiltersEnabled =
    audience === "private-dashboard" && open && Boolean(siteId);
  const savedFiltersQuery = useQuery({
    queryKey: ["saved-filters", siteId],
    queryFn: ({ signal }) => fetchSavedFilters(siteId!, { signal }),
    enabled: savedFiltersEnabled,
    staleTime: 60_000,
  });
  const savedFilters = savedFiltersQuery.data?.items ?? [];
  const currentFilterFingerprint = useMemo(() => {
    try {
      return filterFingerprint(
        documentFromEditor(root),
        analyticsFilterRegistry,
      );
    } catch {
      return undefined;
    }
  }, [root]);
  const invalidateSavedFilters = useCallback(() => {
    if (!siteId) return Promise.resolve();
    return queryClient.invalidateQueries({
      queryKey: ["saved-filters", siteId],
    });
  }, [queryClient, siteId]);
  const createSavedFilterMutation = useMutation({
    mutationFn: async (form: SavedFilterForm) => {
      if (!siteId) throw new Error("missing site id");
      return createSavedFilter(siteId, { ...form, filterDsl: expressionText });
    },
    onSuccess: () => {
      setCreateSavedFilterOpen(false);
      setSavedFilterOperationError(null);
      void invalidateSavedFilters();
    },
    onError: () => {
      setSavedFilterOperationError(
        messages.filterBuilder.savedFilterOperationFailed,
      );
    },
  });
  const updateSavedFilterMutation = useMutation({
    mutationFn: async ({
      filterId,
      form,
      filterDsl,
    }: {
      filterId: string;
      form: SavedFilterForm;
      filterDsl: string;
      finishEditing?: boolean;
    }) => {
      if (!siteId) throw new Error("missing site id");
      return updateSavedFilter(siteId, filterId, { ...form, filterDsl });
    },
    onSuccess: (_result, variables) => {
      setManageSavedFilterOpen(false);
      if (variables.finishEditing) setEditingSavedFilterId(undefined);
      setSavedFilterOperationError(null);
      void invalidateSavedFilters();
    },
    onError: () => {
      setSavedFilterOperationError(
        messages.filterBuilder.savedFilterOperationFailed,
      );
    },
  });
  const deleteSavedFilterMutation = useMutation({
    mutationFn: async (filterId: string) => {
      if (!siteId) throw new Error("missing site id");
      return deleteSavedFilter(siteId, filterId);
    },
    onSuccess: () => {
      setConfirmSavedFilterDeleteOpen(false);
      setManageSavedFilterOpen(false);
      setManagedSavedFilterId(undefined);
      setEditingSavedFilterId(undefined);
      setSavedFilterOperationError(null);
      void invalidateSavedFilters();
    },
    onError: () => {
      setSavedFilterOperationError(
        messages.filterBuilder.savedFilterOperationFailed,
      );
    },
  });
  const matchedSavedFilter = useMemo(() => {
    if (expressionError || root.children.length === 0) return undefined;
    const matches = savedFilters.filter((filter) => {
      if (filter.scopePreference !== scopePreference) return false;
      if (filter.filterDsl === expressionText) return true;
      if (!currentFilterFingerprint) return false;
      try {
        return (
          filterFingerprint(
            parseFilterDsl(filter.filterDsl, analyticsFilterRegistry),
            analyticsFilterRegistry,
          ) === currentFilterFingerprint
        );
      } catch {
        return false;
      }
    });
    return matches.find((filter) => filter.isOwner) ?? matches[0];
  }, [
    currentFilterFingerprint,
    expressionError,
    expressionText,
    root.children.length,
    savedFilters,
    scopePreference,
  ]);
  const matchedSystemPreset = useMemo(() => {
    if (matchedSavedFilter || expressionError || root.children.length === 0) {
      return undefined;
    }

    return SYSTEM_FILTER_PRESETS.find((preset) => {
      if (!systemFilterPresetAvailableForAudience(preset, audience)) {
        return false;
      }
      if (!systemPresetMatchesScope(preset, scopePreference)) return false;
      if (preset.filterDsl === expressionText) return true;
      if (!currentFilterFingerprint) return false;
      try {
        return (
          filterFingerprint(
            parseFilterDsl(preset.filterDsl, analyticsFilterRegistry),
            analyticsFilterRegistry,
          ) === currentFilterFingerprint
        );
      } catch {
        return false;
      }
    });
  }, [
    currentFilterFingerprint,
    expressionError,
    expressionText,
    audience,
    matchedSavedFilter,
    root.children.length,
    scopePreference,
  ]);
  const managedSavedFilter = savedFilters.find(
    (filter) => filter.id === managedSavedFilterId && filter.isOwner,
  );
  const editingSavedFilter = savedFilters.find(
    (filter) => filter.id === editingSavedFilterId && filter.isOwner,
  );
  const hasEffectiveFilter =
    !expressionError &&
    root.children.length > 0 &&
    expressionText.trim().length > 0;
  const savedFilterPrimaryAction =
    !savedFiltersEnabled || savedFiltersQuery.isFetching || !hasEffectiveFilter
      ? undefined
      : editingSavedFilter
        ? "finish"
        : matchedSavedFilter?.isOwner
          ? "manage"
          : matchedSavedFilter
            ? "save-as"
            : "save";
  const savedFilterTriggerLabel = savedFiltersQuery.isFetching
    ? messages.filterBuilder.savedFiltersLoading
    : matchedSavedFilter
      ? matchedSavedFilter.name
      : matchedSystemPreset
        ? systemPresetItem(messages, matchedSystemPreset).name
        : messages.filterBuilder.noSavedFilter;
  const savedFilterTriggerKey = savedFiltersQuery.isFetching
    ? "loading"
    : matchedSavedFilter
      ? `saved:${matchedSavedFilter.id}`
      : matchedSystemPreset
        ? systemFilterPresetOptionValue(matchedSystemPreset.id)
        : "none";

  useEffect(() => {
    if (!open) return;
    if (preservedDocumentKeyRef.current === documentKey) {
      preservedDocumentKeyRef.current = null;
      return;
    }
    let nextRoot = editorRootFromDocument(document, createId);
    if (restoredExpressionText !== undefined) {
      try {
        nextRoot = editorRootFromDocument(
          parseFilterDsl(restoredExpressionText, expressionRegistry),
          createId,
        );
      } catch {
        // The persisted source is advisory. The URL document remains usable.
      }
    }
    expressionUpdateRef.current = true;
    setRoot(nextRoot);
    setExpressionText(
      restoredExpressionText ?? expressionTextFromEditor(nextRoot),
    );
    setExpressionError(null);
    setValidationError(null);
  }, [
    createId,
    document,
    documentKey,
    expressionRegistry,
    open,
    restoredExpressionText,
  ]);

  useEffect(() => {
    if (expressionUpdateRef.current) {
      expressionUpdateRef.current = false;
      return;
    }
    setExpressionText(expressionTextFromEditor(root));
    setExpressionError(null);
  }, [root]);

  const rootFromExpressionText = useCallback(
    (source: string): EditorGroup | null => {
      try {
        return source.trim()
          ? editorRootFromDocument(
              parseFilterDsl(source, expressionRegistry),
              createId,
            )
          : emptyEditorGroup(createId);
      } catch {
        setExpressionError(messages.filterBuilder.expressionInvalid);
        return null;
      }
    },
    [createId, expressionRegistry, messages.filterBuilder.expressionInvalid],
  );

  const setExpressionRoot = useCallback((nextRoot: EditorGroup) => {
    setRoot((current) => {
      const reconciled = reconcileEditorRoot(current, nextRoot);
      if (reconciled !== current) expressionUpdateRef.current = true;
      return reconciled;
    });
  }, []);

  const updateFromExpressionText = useCallback(
    (source: string): EditorGroup | null => {
      const nextRoot = rootFromExpressionText(source);
      if (!nextRoot) return null;
      setExpressionRoot(nextRoot);
      setExpressionError(null);
      setValidationError(null);
      return nextRoot;
    },
    [rootFromExpressionText, setExpressionRoot],
  );

  const commitExpressionText = useCallback(() => {
    const nextRoot = rootFromExpressionText(expressionText);
    if (!nextRoot) return null;
    setExpressionError(null);
    setExpressionText(expressionTextFromEditor(nextRoot));
    setExpressionRoot(nextRoot);
    return nextRoot;
  }, [expressionText, rootFromExpressionText, setExpressionRoot]);

  const apply = useCallback(() => {
    const nextRoot = commitExpressionText();
    if (!nextRoot) return;
    try {
      onApply(documentFromEditor(nextRoot), expressionText);
    } catch (error) {
      setValidationError(
        error instanceof FilterValidationError || error instanceof Error
          ? error.message === "missing_value"
            ? messages.filterBuilder.invalid
            : error.message
          : messages.filterBuilder.invalid,
      );
    }
  }, [commitExpressionText, messages.filterBuilder.invalid, onApply]);

  const applyFilterDsl = useCallback(
    (
      filterDsl: string,
      scopeOverride: FilterScopePreference = scopePreference,
    ) => {
      const nextRoot = rootFromExpressionText(filterDsl);
      if (!nextRoot) return;
      try {
        const nextDocument = attachFilterScopePreference(
          documentFromEditor(nextRoot),
          scopeOverride,
        );
        preservedDocumentKeyRef.current = JSON.stringify(nextDocument);
        setExpressionText(filterDsl);
        setExpressionRoot(nextRoot);
        setExpressionError(null);
        setValidationError(null);
        onApply(nextDocument, filterDsl, { closePanel: false });
      } catch (error) {
        setValidationError(
          error instanceof FilterValidationError || error instanceof Error
            ? error.message
            : messages.filterBuilder.invalid,
        );
      }
    },
    [
      messages.filterBuilder.invalid,
      onApply,
      rootFromExpressionText,
      scopePreference,
      setExpressionRoot,
    ],
  );
  const applySavedFilter = useCallback(
    (filter: SavedFilter) => {
      onScopeChange(filter.scopePreference);
      applyFilterDsl(filter.filterDsl, filter.scopePreference);
    },
    [applyFilterDsl, onScopeChange],
  );
  const applySystemPreset = useCallback(
    (preset: SystemFilterPreset) => {
      const nextScope = systemPresetScopeForApply(preset, scopePreference);
      if (nextScope !== scopePreference) onScopeChange(nextScope);
      applyFilterDsl(preset.filterDsl, nextScope);
    },
    [applyFilterDsl, onScopeChange, scopePreference],
  );

  const openSavedFilterCreate = useCallback(
    (source?: SavedFilter) => {
      setSavedFilterForm({
        name: source?.name ?? "",
        description: source?.description ?? "",
        visibility: "private",
        scopePreference: source?.scopePreference ?? scopePreference,
      });
      setSavedFilterOperationError(null);
      setCreateSavedFilterOpen(true);
    },
    [scopePreference],
  );

  const clearSavedFilter = useCallback(() => {
    const nextRoot = emptyEditorGroup(createId);
    const nextDocument = documentFromEditor(nextRoot);
    preservedDocumentKeyRef.current = JSON.stringify(nextDocument);
    setExpressionText("");
    setExpressionRoot(nextRoot);
    setExpressionError(null);
    setValidationError(null);
    onApply(nextDocument, "", { closePanel: false });
  }, [createId, onApply, setExpressionRoot]);

  const openSavedFilterManagement = useCallback((filter: SavedFilter) => {
    setManagedSavedFilterId(filter.id);
    setSavedFilterForm({
      name: filter.name,
      description: filter.description,
      visibility: filter.visibility,
      scopePreference: filter.scopePreference,
    });
    setSavedFilterOperationError(null);
    setManageSavedFilterOpen(true);
  }, []);

  const finishSavedFilterEditing = useCallback(() => {
    if (!editingSavedFilter) return;
    setSavedFilterOperationError(null);
    updateSavedFilterMutation.mutate({
      filterId: editingSavedFilter.id,
      form: {
        name: editingSavedFilter.name,
        description: editingSavedFilter.description,
        visibility: editingSavedFilter.visibility,
        scopePreference: savedFilterForm.scopePreference ?? "auto",
      },
      filterDsl: expressionText,
      finishEditing: true,
    });
  }, [
    editingSavedFilter,
    expressionText,
    savedFilterForm.scopePreference,
    updateSavedFilterMutation,
  ]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <FilterEditor
        audience={audience}
        initialFilterDsl={expressionText}
        messages={messages}
        siteId={siteId}
        resolvedScope={suggestionScope}
        window={window}
        controlledRoot={root}
        controlledDocument={document}
        controlledExpressionText={expressionText}
        controlledExpressionError={expressionError}
        controlledValidationError={validationError}
        onControlledRootChange={(nextRoot) => {
          const reconciledRoot = reconcileEditorRoot(root, nextRoot);
          setRoot(reconciledRoot);
          setExpressionText(expressionTextFromEditor(reconciledRoot));
          setExpressionError(null);
          setValidationError(null);
        }}
        onControlledExpressionChange={(source) => {
          setExpressionText(source);
          updateFromExpressionText(source);
        }}
        onControlledExpressionCommit={commitExpressionText}
        onControlledClear={() => {
          setRoot(emptyEditorGroup(createId));
          setExpressionText("");
          setExpressionError(null);
          setValidationError(null);
        }}
        onControlledApply={apply}
        headerContent={
          <FilterPanelHeader
            audience={audience}
            matchedSavedFilter={matchedSavedFilter}
            matchedSystemPreset={matchedSystemPreset}
            messages={messages}
            savedFilterTriggerKey={savedFilterTriggerKey}
            savedFilterTriggerLabel={savedFilterTriggerLabel}
            savedFilters={savedFilters}
            savedFiltersLoading={savedFiltersQuery.isFetching}
            scopePreference={scopePreference}
            onApplySavedFilter={applySavedFilter}
            onApplySystemPreset={applySystemPreset}
            onClearSavedFilter={clearSavedFilter}
            onScopeChange={onScopeChange}
          />
        }
        footerActions={
          <>
            {savedFilterPrimaryAction === "save" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => openSavedFilterCreate()}
              >
                <RiSaveLine />
                <span>{messages.filterBuilder.saveThisFilter}</span>
              </Button>
            ) : null}
            {savedFilterPrimaryAction === "save-as" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => openSavedFilterCreate(matchedSavedFilter)}
              >
                <RiFileCopyLine />
                <span>{messages.filterBuilder.saveAsThisFilter}</span>
              </Button>
            ) : null}
            {savedFilterPrimaryAction === "manage" && matchedSavedFilter ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => openSavedFilterManagement(matchedSavedFilter)}
              >
                <RiEditLine />
                <span>{messages.filterBuilder.manageThisFilter}</span>
              </Button>
            ) : null}
            {savedFilterPrimaryAction === "finish" ? (
              <Button
                type="button"
                variant="outline"
                disabled={updateSavedFilterMutation.isPending}
                onClick={finishSavedFilterEditing}
              >
                {updateSavedFilterMutation.isPending ? (
                  <Spinner />
                ) : (
                  <RiCheckLine />
                )}
                <span>{messages.filterBuilder.finishEditingFilter}</span>
              </Button>
            ) : null}
            <Button type="button" onClick={apply}>
              <RiCheckLine />
              <span>{messages.filterBuilder.apply}</span>
            </Button>
          </>
        }
      />

      <ResponsiveDialog
        open={createSavedFilterOpen}
        onOpenChange={(nextOpen) => {
          setCreateSavedFilterOpen(nextOpen);
          if (!nextOpen) setSavedFilterOperationError(null);
        }}
      >
        <ResponsiveDialogContent desktopClassName="max-w-md">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle icon={RiSaveLine}>
              {messages.filterBuilder.createSavedFilter}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {messages.filterBuilder.savedFilterCreateDescription}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <SavedFilterFormFields
              form={savedFilterForm}
              messages={messages}
              onChange={setSavedFilterForm}
            />
            {savedFilterOperationError ? (
              <p className="text-xs text-destructive">
                {savedFilterOperationError}
              </p>
            ) : null}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={createSavedFilterMutation.isPending}
              onClick={() => setCreateSavedFilterOpen(false)}
            >
              {messages.filterBuilder.savedFilterCancel}
            </Button>
            <Button
              type="button"
              disabled={
                createSavedFilterMutation.isPending ||
                savedFilterForm.name.trim().length === 0
              }
              onClick={() => {
                setSavedFilterOperationError(null);
                createSavedFilterMutation.mutate(savedFilterForm);
              }}
            >
              {createSavedFilterMutation.isPending ? (
                <Spinner />
              ) : (
                <RiSaveLine />
              )}
              <span>
                {createSavedFilterMutation.isPending
                  ? messages.filterBuilder.savedFilterSaving
                  : messages.filterBuilder.savedFilterSave}
              </span>
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <ResponsiveDialog
        open={manageSavedFilterOpen}
        onOpenChange={(nextOpen) => {
          setManageSavedFilterOpen(nextOpen);
          if (!nextOpen) setSavedFilterOperationError(null);
        }}
      >
        <ResponsiveDialogContent desktopClassName="max-w-md">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle icon={RiEditLine}>
              {messages.filterBuilder.manageSavedFilter}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {messages.filterBuilder.savedFilterManageDescription}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <SavedFilterFormFields
              form={savedFilterForm}
              messages={messages}
              onChange={setSavedFilterForm}
            />
            {savedFilterOperationError ? (
              <p className="text-xs text-destructive">
                {savedFilterOperationError}
              </p>
            ) : null}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="destructive"
              disabled={
                !managedSavedFilter || updateSavedFilterMutation.isPending
              }
              onClick={() => {
                setSavedFilterOperationError(null);
                setConfirmSavedFilterDeleteOpen(true);
              }}
            >
              <RiDeleteBinLine />
              <span>{messages.filterBuilder.deleteSavedFilter}</span>
            </Button>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={updateSavedFilterMutation.isPending}
                onClick={() => setManageSavedFilterOpen(false)}
              >
                {messages.filterBuilder.savedFilterCancel}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={
                  !managedSavedFilter || updateSavedFilterMutation.isPending
                }
                onClick={() => {
                  if (!managedSavedFilter) return;
                  setEditingSavedFilterId(managedSavedFilter.id);
                  setManageSavedFilterOpen(false);
                  setSavedFilterOperationError(null);
                }}
              >
                <RiEditLine />
                <span>{messages.filterBuilder.editSavedFilter}</span>
              </Button>
              <Button
                type="button"
                disabled={
                  !managedSavedFilter ||
                  updateSavedFilterMutation.isPending ||
                  savedFilterForm.name.trim().length === 0
                }
                onClick={() => {
                  if (!managedSavedFilter) return;
                  setSavedFilterOperationError(null);
                  updateSavedFilterMutation.mutate({
                    filterId: managedSavedFilter.id,
                    form: savedFilterForm,
                    filterDsl: managedSavedFilter.filterDsl,
                    finishEditing: false,
                  });
                }}
              >
                {updateSavedFilterMutation.isPending ? (
                  <Spinner />
                ) : (
                  <RiSaveLine />
                )}
                <span>
                  {updateSavedFilterMutation.isPending
                    ? messages.filterBuilder.savedFilterSaving
                    : messages.filterBuilder.savedFilterSave}
                </span>
              </Button>
            </div>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <AlertDialog
        open={confirmSavedFilterDeleteOpen}
        onOpenChange={setConfirmSavedFilterDeleteOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle
              icon={RiDeleteBinLine}
              iconClassName="text-destructive"
            >
              {messages.filterBuilder.deleteSavedFilterTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {messages.filterBuilder.deleteSavedFilterDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSavedFilterMutation.isPending}>
              {messages.filterBuilder.savedFilterCancel}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={
                !managedSavedFilter || deleteSavedFilterMutation.isPending
              }
              onClick={(event) => {
                event.preventDefault();
                if (!managedSavedFilter) return;
                setSavedFilterOperationError(null);
                deleteSavedFilterMutation.mutate(managedSavedFilter.id);
              }}
            >
              {deleteSavedFilterMutation.isPending ? (
                <Spinner />
              ) : (
                <RiDeleteBinLine />
              )}
              <span>
                {deleteSavedFilterMutation.isPending
                  ? messages.filterBuilder.savedFilterDeleting
                  : messages.filterBuilder.savedFilterDelete}
              </span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
