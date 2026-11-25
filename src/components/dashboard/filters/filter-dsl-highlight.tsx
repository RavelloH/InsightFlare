import { useMemo, useState } from "react";
import { Input, type InputProps } from "@insightflare/ui/input";

import type { FilterDiagnosticRange } from "@/lib/dashboard/filter-diagnostic";
import { filterDslDisplayTokens } from "@/lib/filter-contract";
import { cn } from "@/lib/utils";

// Website's signal (green) and flare (amber) semantic palette.
// Foreground and neutrals follow the application theme.
export const filterDslTokenColors = {
  plain: "text-foreground",
  keyword: "text-[#057a55] dark:text-[#3ee8a4]",
  operator: "text-[#057a55] dark:text-[#3ee8a4]",
  function: "text-[#057a55] dark:text-[#3ee8a4] font-semibold",
  field: "text-foreground",
  entity: "text-foreground font-semibold",
  context: "text-muted-foreground italic",
  punctuation: "text-muted-foreground",
  string: "text-[#9a5200] dark:text-[#ffb547]",
  literal: "text-[#9a5200] dark:text-[#ffb547]",
} as const;

export function FilterDslHighlight({
  source,
  editing = false,
  diagnostic,
}: {
  source: string;
  editing?: boolean;
  diagnostic?: FilterDiagnosticRange | null;
}) {
  const tokens = useMemo(() => filterDslDisplayTokens(source), [source]);
  // Split lexical spans at diagnostic boundaries; never replace characters
  // or change their width, even when the range crosses token boundaries.
  const offset = diagnostic
    ? Math.max(0, Math.min(source.length, diagnostic.offset))
    : -1;
  const end = diagnostic
    ? Math.min(source.length, offset + Math.max(1, diagnostic.length))
    : -1;
  const underline =
    "underline decoration-wavy decoration-destructive decoration-[1.5px] underline-offset-[3px]";
  let cursor = 0;
  return (
    <>
      {tokens.map((token, index) => {
        const start = cursor;
        const stop = (cursor += token.text.length);
        const color = cn(
          filterDslTokenColors[token.kind],
          editing && "font-normal not-italic",
        );
        if (!diagnostic || start >= end || stop <= offset)
          return (
            <span key={index} className={color}>
              {token.text}
            </span>
          );
        const a = Math.max(start, offset) - start;
        const b = Math.min(stop, end) - start;
        return (
          <span key={index} className={color}>
            {token.text.slice(0, a)}
            <span data-dsl-diagnostic="range" className={underline}>
              {token.text.slice(a, b)}
            </span>
            {token.text.slice(b)}
          </span>
        );
      })}
      {diagnostic && offset === source.length ? (
        // End-of-input diagnostics need a visible marker without altering
        // the textarea value or pushing the final token onto another line.
        <span
          data-dsl-diagnostic="eof"
          className={cn("relative inline-block h-0 w-0 align-baseline")}
        >
          <span className={cn("absolute top-[-1em] left-0", underline)}>
            {"\u00a0"}
          </span>
        </span>
      ) : null}
    </>
  );
}

/** Native input over a purely visual highlight layer; no custom text editing. */
export function FilterDslInput({
  value,
  className,
  style,
  onCompositionStart,
  onCompositionEnd,
  onScroll,
  ...props
}: InputProps) {
  const source = typeof value === "string" ? value : "";
  const [composing, setComposing] = useState(false);
  const [scrollLeft, setScrollLeft] = useState(0);
  return (
    <div className="relative w-max min-w-full font-mono text-xs" style={style}>
      {/* Intrinsic content width tracks Unicode glyphs, not UTF-16 length. */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none flex h-8 min-w-[32ch] items-center overflow-hidden px-4 pr-6 whitespace-pre",
          composing && "invisible",
        )}
      >
        <span
          style={{
            transform: scrollLeft ? `translateX(-${scrollLeft}px)` : undefined,
          }}
        >
          <FilterDslHighlight source={source} editing />
        </span>
      </div>
      <Input
        {...props}
        value={value}
        onCompositionStart={(event) => {
          setComposing(true);
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          setComposing(false);
          onCompositionEnd?.(event);
        }}
        onScroll={(event) => {
          setScrollLeft(event.currentTarget.scrollLeft);
          onScroll?.(event);
        }}
        className={cn(
          "absolute inset-0 h-full w-full font-mono text-xs caret-foreground selection:bg-primary/25 placeholder:text-muted-foreground",
          !composing && "text-transparent selection:text-transparent",
          className,
        )}
      />
    </div>
  );
}
