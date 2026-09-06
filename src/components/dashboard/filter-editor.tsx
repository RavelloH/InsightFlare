import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiChatQuoteLine,
  RiCheckLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiFilterOffLine,
} from "@remixicon/react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Clickable } from "@/components/ui/clickable";
import { Input } from "@/components/ui/input";
import { OverlayScrollbar } from "@/components/ui/overlay-scrollbar";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import { describeFilterExpression } from "@/lib/dashboard/filter-description";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import {
  filterConditionCount,
  type FilterDocument,
  FilterValidationError,
  parseFilterDsl,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

export type {
  EditorGroup,
  EditorNode,
  FilterPanelAudience,
} from "./filter-editor-internals";
export {
  allowedFields,
  conditionIdFactory,
  documentFromEditor,
  editorRootFromDocument,
  emptyEditorGroup,
  expressionTextFromEditor,
  reconcileEditorRoot,
} from "./filter-editor-internals";

import type {
  EditorGroup,
  EditorNode,
  FilterPanelAudience,
} from "./filter-editor-internals";
import {
  allowedFields,
  appendEditorNode,
  conditionIdFactory,
  defaultCondition,
  defaultGroup,
  directEventName,
  displayRootExpression,
  documentFromEditor,
  editorRootFromDocument,
  emptyEditorGroup,
  expressionTextFromEditor,
  FilterExpressionHelpDialog,
  GroupEditor,
  removeEditorNode,
  updateEditorNode,
} from "./filter-editor-internals";

export interface FilterEditorProps {
  readonly audience: FilterPanelAudience;
  readonly initialFilterDsl: string;
  readonly id?: string;
  readonly className?: string;
  readonly messages: AppMessages;
  readonly onApply?: (filterDsl: string, conditionCount: number) => void;
  readonly onDraftChange?: (filterDsl: string) => void;
  readonly onCancel?: () => void;
  readonly applyLabel?: string;
  readonly cancelLabel?: string;
  readonly expressionLabel?: string;
  readonly invalidFilterLabel?: string;
  readonly placeholder?: string;
  readonly siteId?: string;
  readonly resolvedScope?: "event" | "session" | "visitor";
  readonly window?: TimeWindow;
  readonly controlledRoot?: EditorGroup;
  readonly controlledDocument?: FilterDocument;
  readonly controlledExpressionText?: string;
  readonly controlledExpressionError?: string | null;
  readonly controlledValidationError?: string | null;
  readonly onControlledRootChange?: (root: EditorGroup) => void;
  readonly onControlledExpressionChange?: (source: string) => void;
  readonly onControlledExpressionCommit?: () => void;
  readonly onControlledClear?: () => void;
  readonly onControlledApply?: () => void;
  readonly headerContent?: ReactNode;
  readonly footerActions?: ReactNode;
}

/**
 * Shared visual filter editor. The global filter panel and funnel step
 * dialogs use the same match/group/condition editor and expression footer.
 */
export function FilterEditor({
  audience,
  initialFilterDsl,
  id = "filter-editor-expression",
  className,
  messages,
  onApply,
  onDraftChange,
  onCancel,
  applyLabel = "Apply",
  cancelLabel = "Cancel",
  expressionLabel = messages.filterBuilder.expression,
  invalidFilterLabel = messages.filterBuilder.expressionInvalid,
  placeholder = messages.filterBuilder.expressionPlaceholder,
  siteId,
  resolvedScope,
  window,
  controlledRoot,
  controlledDocument,
  controlledExpressionText,
  controlledExpressionError,
  controlledValidationError,
  onControlledRootChange,
  onControlledExpressionChange,
  onControlledExpressionCommit,
  onControlledClear,
  onControlledApply,
  headerContent,
  footerActions,
}: FilterEditorProps) {
  const isControlled = controlledRoot !== undefined;
  const nextIdRef = useRef(conditionIdFactory());
  const createId = useCallback(() => nextIdRef.current(), []);
  const expressionRegistry = useMemo(
    () => new Map(allowedFields(audience).map((field) => [field.id, field])),
    [audience],
  );
  const [root, setRoot] = useState<EditorGroup>(() => {
    try {
      return editorRootFromDocument(
        parseFilterDsl(initialFilterDsl, expressionRegistry),
        createId,
      );
    } catch {
      return emptyEditorGroup(createId);
    }
  });
  const [expressionText, setExpressionText] = useState(initialFilterDsl);
  const [expressionError, setExpressionError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [expressionHelpOpen, setExpressionHelpOpen] = useState(false);
  const expressionUpdateRef = useRef(false);

  useEffect(() => {
    if (isControlled) return;
    let nextRoot: EditorGroup;
    try {
      nextRoot = editorRootFromDocument(
        parseFilterDsl(initialFilterDsl, expressionRegistry),
        createId,
      );
    } catch {
      nextRoot = emptyEditorGroup(createId);
    }
    expressionUpdateRef.current = true;
    setRoot(nextRoot);
    setExpressionText(initialFilterDsl);
    setExpressionError(null);
    setValidationError(null);
  }, [createId, expressionRegistry, initialFilterDsl, isControlled]);

  useEffect(() => {
    if (isControlled) return;
    if (expressionUpdateRef.current) {
      expressionUpdateRef.current = false;
      return;
    }
    setExpressionText(expressionTextFromEditor(root));
  }, [isControlled, root]);

  const renderedRoot = controlledRoot ?? root;
  const renderedExpressionText = controlledExpressionText ?? expressionText;
  const renderedExpressionError = isControlled
    ? (controlledExpressionError ?? null)
    : expressionError;
  const renderedValidationError = isControlled
    ? (controlledValidationError ?? null)
    : validationError;

  const naturalLanguageDescription = useMemo(
    () =>
      describeFilterExpression(
        displayRootExpression(renderedRoot),
        expressionRegistry,
        messages,
      ),
    [expressionRegistry, messages, renderedRoot],
  );
  const editorDocument = useMemo(() => {
    try {
      return controlledDocument ?? documentFromEditor(renderedRoot);
    } catch {
      return { version: 1 as const, root: null };
    }
  }, [controlledDocument, renderedRoot]);
  const eventName = directEventName(renderedRoot);

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
        setExpressionError(invalidFilterLabel);
        return null;
      }
    },
    [createId, expressionRegistry, invalidFilterLabel],
  );

  const updateFromExpressionText = useCallback(
    (source: string) => {
      const nextRoot = rootFromExpressionText(source);
      if (!nextRoot) return;
      expressionUpdateRef.current = true;
      setRoot(nextRoot);
      setExpressionError(null);
      setValidationError(null);
    },
    [rootFromExpressionText],
  );

  const updateNode = useCallback(
    (nodeId: string, update: (node: EditorNode) => EditorNode) => {
      const nextRoot = updateEditorNode(
        renderedRoot,
        nodeId,
        update,
      ) as EditorGroup;
      if (isControlled) onControlledRootChange?.(nextRoot);
      else setRoot(nextRoot);
      setExpressionError(null);
      setValidationError(null);
    },
    [isControlled, onControlledRootChange, renderedRoot],
  );

  const addCondition = useCallback(
    (parentId: string) => {
      const nextRoot = appendEditorNode(
        renderedRoot,
        parentId,
        defaultCondition(createId),
      ) as EditorGroup;
      if (isControlled) onControlledRootChange?.(nextRoot);
      else setRoot(nextRoot);
      setExpressionError(null);
      setValidationError(null);
    },
    [createId, isControlled, onControlledRootChange, renderedRoot],
  );

  const addGroup = useCallback(
    (parentId: string) => {
      const nextRoot = appendEditorNode(
        renderedRoot,
        parentId,
        defaultGroup(createId),
      ) as EditorGroup;
      if (isControlled) onControlledRootChange?.(nextRoot);
      else setRoot(nextRoot);
      setExpressionError(null);
      setValidationError(null);
    },
    [createId, isControlled, onControlledRootChange, renderedRoot],
  );

  const removeNode = useCallback(
    (nodeId: string) => {
      const nextRoot =
        (removeEditorNode(renderedRoot, nodeId) as EditorGroup | null) ??
        emptyEditorGroup(createId);
      if (isControlled) onControlledRootChange?.(nextRoot);
      else setRoot(nextRoot);
      setExpressionError(null);
      setValidationError(null);
    },
    [createId, isControlled, onControlledRootChange, renderedRoot],
  );

  const commitExpressionText = useCallback(() => {
    if (isControlled) {
      onControlledExpressionCommit?.();
      return renderedRoot;
    }
    const nextRoot = rootFromExpressionText(expressionText);
    if (!nextRoot) return null;
    const formatted = expressionTextFromEditor(nextRoot);
    setRoot(nextRoot);
    setExpressionText(formatted);
    setExpressionError(null);
    return nextRoot;
  }, [
    expressionText,
    isControlled,
    onControlledExpressionCommit,
    renderedRoot,
    rootFromExpressionText,
  ]);

  const clear = useCallback(() => {
    if (isControlled) {
      onControlledClear?.();
      return;
    }
    setRoot(emptyEditorGroup(createId));
    setExpressionText("");
    setExpressionError(null);
    setValidationError(null);
    onDraftChange?.("");
  }, [createId, isControlled, onControlledClear, onDraftChange]);

  const apply = useCallback(() => {
    if (isControlled) {
      onControlledApply?.();
      return;
    }
    const nextRoot = commitExpressionText();
    if (!nextRoot) return;
    try {
      const document: FilterDocument = documentFromEditor(nextRoot);
      onApply?.(
        expressionTextFromEditor(nextRoot),
        filterConditionCount(document),
      );
    } catch (error) {
      setValidationError(
        error instanceof FilterValidationError || error instanceof Error
          ? error.message === "missing_value"
            ? messages.filterBuilder.invalid
            : error.message
          : invalidFilterLabel,
      );
    }
  }, [
    commitExpressionText,
    isControlled,
    invalidFilterLabel,
    messages.filterBuilder.invalid,
    onApply,
    onControlledApply,
  ]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <VerticalScrollMask
        className="min-h-0 flex-1"
        contentClassName="min-h-0 pb-4"
      >
        {headerContent}
        <GroupEditor
          audience={audience}
          document={editorDocument}
          eventName={eventName}
          group={renderedRoot}
          isRoot
          messages={messages}
          path={[]}
          resolvedScope={resolvedScope}
          onAddCondition={addCondition}
          onAddGroup={addGroup}
          onChange={updateNode}
          onRemove={removeNode}
          siteId={siteId}
          window={window}
        />
        {renderedValidationError ? (
          <p className="mt-4 border-l-2 border-destructive px-2 text-xs text-destructive">
            {renderedValidationError}
          </p>
        ) : null}
      </VerticalScrollMask>

      <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background">
        <div className="border-b border-border bg-muted/20">
          <AutoResizer initial={false} duration={0.18}>
            <AutoTransition
              transitionKey={naturalLanguageDescription}
              type="fade"
              duration={0.18}
              initial={false}
            >
              <VerticalScrollMask
                syncKey={naturalLanguageDescription}
                className="max-h-28"
                contentClassName="max-h-28"
                maskClassName="from-muted/20 via-muted/10 to-transparent"
              >
                <div
                  aria-label={messages.filterBuilder.naturalLanguageDescription}
                  className="min-h-8 px-4 py-2 text-xs leading-4 text-muted-foreground"
                >
                  <RiChatQuoteLine
                    className="mr-2 inline-block size-4 align-text-bottom"
                    aria-hidden
                  />
                  <span className="break-words">
                    {naturalLanguageDescription}
                  </span>
                </div>
              </VerticalScrollMask>
            </AutoTransition>
          </AutoResizer>
        </div>
        <div className="border-b border-border">
          <OverlayScrollbar
            axis="horizontal"
            syncKey={renderedExpressionText}
            className="w-full"
          >
            <Input
              id={id}
              aria-label={expressionLabel}
              aria-invalid={renderedExpressionError ? true : undefined}
              className="h-8 min-w-full border-0 bg-transparent px-4 font-mono text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
              placeholder={placeholder}
              style={{
                width: `${Math.max(32, renderedExpressionText.length + 3)}ch`,
              }}
              value={renderedExpressionText}
              onChange={(event) => {
                const source = event.target.value;
                if (isControlled) {
                  onControlledExpressionChange?.(source);
                } else {
                  setExpressionText(source);
                  updateFromExpressionText(source);
                  onDraftChange?.(source);
                }
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (isControlled) onControlledExpressionCommit?.();
                else commitExpressionText();
              }}
            />
          </OverlayScrollbar>
        </div>
        <AutoResizer initial={false} duration={0.18}>
          <AutoTransition
            transitionKey={renderedExpressionError ? "invalid" : "valid"}
            type="slideDown"
            duration={0.18}
            initial={false}
          >
            {renderedExpressionError ? (
              <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-destructive">
                <RiErrorWarningLine className="size-4 shrink-0" aria-hidden />
                <Clickable
                  className="justify-start text-left text-destructive"
                  hoverScale={1.05}
                  onClick={() => setExpressionHelpOpen(true)}
                >
                  {renderedExpressionError}
                </Clickable>
              </div>
            ) : null}
          </AutoTransition>
        </AutoResizer>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Button type="button" variant="ghost" onClick={clear}>
            <RiFilterOffLine />
            {messages.filters.clear}
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {footerActions ??
              (onCancel ? (
                <Button type="button" variant="outline" onClick={onCancel}>
                  <RiCloseLine />
                  {cancelLabel}
                </Button>
              ) : null)}
            {!footerActions ? (
              <Button type="button" onClick={apply}>
                <RiCheckLine />
                {applyLabel}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <FilterExpressionHelpDialog
        audience={audience}
        messages={messages}
        open={expressionHelpOpen}
        onOpenChange={setExpressionHelpOpen}
      />
    </div>
  );
}
