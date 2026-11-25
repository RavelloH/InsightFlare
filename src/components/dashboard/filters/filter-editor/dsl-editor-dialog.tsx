import { useMemo, useRef, useState } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Button } from "@insightflare/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogTitle,
} from "@insightflare/ui/responsive-dialog";
import {
  RiAlignLeft,
  RiCheckLine,
  RiCodeSSlashLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiInformationLine,
} from "@remixicon/react";
import { toast } from "sonner";

import { FilterDslHighlight } from "@/components/dashboard/filters/filter-dsl-highlight";
import { describeFilterExpression } from "@/lib/dashboard/filter-description";
import { describeFilterDiagnostic } from "@/lib/dashboard/filter-diagnostic";
import {
  filterDocumentUsesAdvancedExpressions,
  type FilterFieldRegistry,
  formatFilterDslPretty,
  parseFilterDsl,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

import { FilterExpressionHelpDialog } from "./help-dialog";
import type { FilterPanelAudience } from "./model";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: string;
  onSourceChange: (source: string) => void;
  onConfirm: (source: string) => void;
  onRestoreFocus: () => void;
  registry: FilterFieldRegistry;
  audience: FilterPanelAudience;
  messages: AppMessages;
  observationOnly: boolean;
  expressionLabel: string;
}

export function FilterDslEditorDialog({
  open,
  onOpenChange,
  source,
  onSourceChange,
  onConfirm,
  onRestoreFocus,
  registry,
  audience,
  messages,
  observationOnly,
  expressionLabel,
}: Props) {
  const copy = messages.filterBuilder.dslEditor;
  const library = messages.filterBuilder.filterLibrary;
  const [helpOpen, setHelpOpen] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [composing, setComposing] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const validation = useMemo(() => {
    if (!open)
      return { document: null, error: null, position: null, location: null };
    try {
      const document = parseFilterDsl(source, registry, { audience });
      if (observationOnly && filterDocumentUsesAdvancedExpressions(document)) {
        return {
          document: null,
          error: copy.observationOnly,
          position: null,
          location: null,
        };
      }
      return { document, error: null, position: null, location: null };
    } catch (error) {
      const diagnostic = describeFilterDiagnostic(error, messages);
      return {
        document: null,
        error: diagnostic.message,
        position: diagnostic.range,
        location: diagnostic.location,
      };
    }
  }, [
    open,
    source,
    registry,
    audience,
    observationOnly,
    copy.observationOnly,
    messages,
  ]);
  const description = validation.document
    ? describeFilterExpression(validation.document.root, registry, messages)
    : "";
  const confirm = () => {
    if (validation.document && !composing) onConfirm(source);
  };
  const syncScroll = () => {
    if (!textarea.current) return;
    const { scrollTop, scrollLeft } = textarea.current;
    if (highlight.current) {
      highlight.current.scrollTop = scrollTop;
      highlight.current.scrollLeft = scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = scrollTop;
  };
  const replaceSelection = (
    value: string,
    start: number,
    end: number,
    caret: number,
  ) => {
    onSourceChange(source.slice(0, start) + value + source.slice(end));
    requestAnimationFrame(() =>
      textarea.current?.setSelectionRange(caret, caret),
    );
  };
  const focusError = () => {
    if (!validation.position || !textarea.current) return;
    const { offset, length } = validation.position;
    textarea.current.focus();
    textarea.current.setSelectionRange(offset, offset + length);
  };
  const textLayout =
    "m-0 border-0 p-3 font-mono text-xs leading-6 tracking-normal [tab-size:2] " +
    (wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre");
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setHelpOpen(false);
          setComposing(false);
        }
        onOpenChange(next);
      }}
    >
      <ResponsiveDialogContent
        className="gap-0 overflow-hidden p-0"
        desktopClassName="h-[min(720px,85dvh)] max-w-[920px]"
        drawerClassName="h-[94dvh] max-h-[94dvh] data-[vaul-drawer-direction=bottom]:max-h-[94dvh]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          textarea.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <div className="shrink-0 border-b border-border px-4 py-3 pr-12">
          <ResponsiveDialogTitle icon={RiCodeSSlashLine}>
            {copy.title}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {copy.description}
          </ResponsiveDialogDescription>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!validation.document || composing}
            onClick={() => {
              if (validation.document)
                onSourceChange(
                  formatFilterDslPretty(validation.document, registry),
                );
            }}
          >
            <RiAlignLeft data-icon="inline-start" />
            {library.formatted}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(source).then(
                () => toast.success(library.copied),
                () => toast.error(library.copyFailed),
              );
            }}
          >
            <RiFileCopyLine data-icon="inline-start" />
            {library.copy}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={wrap ? "secondary" : "ghost"}
            aria-pressed={wrap}
            onClick={() => {
              setWrap(!wrap);
              requestAnimationFrame(syncScroll);
            }}
          >
            {library.wrap}
          </Button>
          <div className="flex-1" />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setHelpOpen(true)}
          >
            <RiInformationLine data-icon="inline-start" />
            {copy.help}
          </Button>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
          {!wrap && (
            <div
              ref={gutter}
              aria-hidden="true"
              className="w-11 shrink-0 select-none overflow-hidden border-r border-border bg-muted/20 py-3 pr-2 text-right font-mono text-xs leading-6 text-muted-foreground"
            >
              {source.split("\n").map((_, index) => (
                <div key={index}>{index + 1}</div>
              ))}
            </div>
          )}
          <div className="relative min-h-0 min-w-0 flex-1">
            <pre
              ref={highlight}
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-0 overflow-hidden",
                textLayout,
                composing && "invisible",
              )}
            >
              <FilterDslHighlight
                source={source}
                editing
                diagnostic={validation.position}
              />
              {"\n"}
            </pre>
            <textarea
              data-vaul-no-drag
              ref={textarea}
              aria-label={expressionLabel}
              aria-invalid={Boolean(validation.error)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap={wrap ? "soft" : "off"}
              value={source}
              className={cn(
                "absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent caret-foreground outline-none selection:bg-primary/25",
                textLayout,
                !composing && "text-transparent selection:text-transparent",
              )}
              onChange={(event) => onSourceChange(event.target.value)}
              onScroll={syncScroll}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || composing) return;
                const { selectionStart: start, selectionEnd: end } =
                  event.currentTarget;
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  confirm();
                  return;
                }
                if (event.key === "Enter") {
                  const line = source.slice(
                    source.lastIndexOf("\n", start - 1) + 1,
                    start,
                  );
                  const indentation = line.match(/^\s*/)?.[0] ?? "";
                  const extra = /[({[]\s*$/.test(line) ? "  " : "";
                  const inserted = "\n" + indentation + extra;
                  event.preventDefault();
                  replaceSelection(
                    inserted,
                    start,
                    end,
                    start + inserted.length,
                  );
                } else if (
                  event.key === "Tab" &&
                  !event.shiftKey &&
                  start === end
                ) {
                  // Leave Shift+Tab available for keyboard navigation out of the editor.
                  event.preventDefault();
                  replaceSelection("  ", start, end, start + 2);
                }
              }}
            />
          </div>
        </div>
        <AutoResizer initial={false} duration={0.18}>
          <AutoTransition
            transitionKey={validation.error ? "invalid" : "valid"}
            initial={false}
            type="fade"
            duration={0.18}
          >
            <div className="max-h-32 space-y-2 overflow-y-auto border-t border-border bg-muted/20 px-4 py-3">
              {validation.error ? (
                <div
                  className="flex items-start gap-2 text-destructive"
                  role="alert"
                >
                  <RiErrorWarningLine className="mt-0.5 size-4 shrink-0" />
                  <button
                    type="button"
                    onClick={focusError}
                    disabled={!validation.position}
                    className="min-w-0 break-words text-left"
                  >
                    {validation.location ? (
                      <span className="mr-2 font-medium">
                        {validation.location}
                      </span>
                    ) : null}
                    {validation.error}
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <RiCheckLine className="size-4 text-primary" />
                    {copy.valid}
                  </div>
                  <p className="break-words text-muted-foreground">
                    {description}
                  </p>
                </>
              )}
            </div>
          </AutoTransition>
        </AutoResizer>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-3">
          <span className="font-mono text-[10px] text-muted-foreground">
            DSL v1 · {source.split("\n").length} {copy.lines}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {library.cancel}
            </Button>
            <Button
              type="button"
              disabled={!validation.document || composing}
              onClick={confirm}
            >
              {copy.confirm}
            </Button>
          </div>
        </div>
        <FilterExpressionHelpDialog
          audience={audience}
          messages={messages}
          observationOnly={observationOnly}
          open={helpOpen}
          onOpenChange={setHelpOpen}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
