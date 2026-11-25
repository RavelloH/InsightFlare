import { type ReactNode } from "react";
import { Field, FieldLabel } from "@insightflare/ui/field";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";

import type { WidgetConfig } from "@/lib/widgets/contract";

import type { widgetLabels } from "./labels";
import { displayType, metricLabel } from "./widget-manager-model";

export function FormSelect({
  id,
  label,
  value,
  onChange,
  disabled,
  className,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Field className={`min-w-0 ${className ?? ""}`}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-72">{children}</SelectContent>
      </Select>
    </Field>
  );
}

export function PublicationSummary({
  heading,
  config,
  siteName,
  copy,
}: {
  heading: string;
  config: WidgetConfig;
  siteName: string;
  copy: ReturnType<typeof widgetLabels>;
}) {
  const title = config.title || displayType(config.type, copy);
  const period = config.range === "7d" ? copy.sevenDays : copy.thirtyDays;
  const origins =
    config.embedMode === "any" ? copy.any : config.allowedOrigins.join(", ");
  return (
    <section className="space-y-1.5" aria-label={heading}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      <p className="font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">
        {siteName} · {displayType(config.type, copy)} ·{" "}
        {metricLabel(config.metric, copy)}
      </p>
      <p className="text-xs text-muted-foreground">
        {period} · {config.timeZone}
      </p>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p>{copy.accessOrigins}</p>
        <p className="break-all">{origins}</p>
      </div>
    </section>
  );
}
