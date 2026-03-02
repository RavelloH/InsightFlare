import * as React from "react";
import { cn } from "@/lib/utils";

function Widget({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-md border bg-card overflow-hidden", className)}
      {...props}
    />
  );
}

function WidgetHead({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-b px-4 py-3 text-sm font-medium",
        className
      )}
      {...props}
    />
  );
}

function WidgetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(className)} {...props} />;
}

function WidgetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "border-t bg-def-100 px-4 py-2 text-sm text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export { Widget, WidgetHead, WidgetBody, WidgetFooter };
