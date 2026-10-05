import {
  createHighlighter,
  type HighlightTokenClass,
} from "@tanstack/highlight/core";
import { jsx } from "@tanstack/highlight/languages/jsx";

const highlighter = createHighlighter({ languages: [jsx] });

const TOKEN_CLASSES: Partial<Record<HighlightTokenClass, string>> = {
  attr: "text-chart-2",
  comment: "text-muted-foreground/70",
  deleted: "text-destructive",
  function: "text-chart-3",
  inserted: "text-chart-1",
  keyword: "text-primary",
  literal: "text-chart-secondary",
  meta: "text-muted-foreground",
  number: "text-chart-secondary",
  operator: "text-muted-foreground",
  property: "text-chart-2",
  selector: "text-chart-2",
  string: "text-emerald-800 dark:text-chart-1",
  tag: "text-primary",
  type: "text-chart-2",
  variable: "text-chart-secondary",
};

export function HighlightedCode({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const tokens = highlighter.highlight(source, { lang: "jsx" }).tokens;

  return (
    <code className={className}>
      {tokens.map((token, index) => {
        const tokenClass = token.className
          ? TOKEN_CLASSES[token.className]
          : undefined;
        return tokenClass ? (
          <span key={index} className={tokenClass}>
            {token.value}
          </span>
        ) : (
          token.value
        );
      })}
    </code>
  );
}
