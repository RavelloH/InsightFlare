import type { ReactNode } from "react";

interface PageHeadingProps {
  title: string;
  subtitle: string;
  actions?: ReactNode;
}

export function PageHeading({ title, subtitle, actions }: PageHeadingProps) {
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="break-words text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        <p className="max-w-prose break-words text-sm text-muted-foreground">
          {subtitle}
        </p>
      </div>
      {actions ? (
        <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-2 md:w-auto">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
