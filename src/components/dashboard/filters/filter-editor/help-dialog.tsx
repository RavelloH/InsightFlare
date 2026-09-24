import { useMemo } from "react";
import { RiInformationLine } from "@remixicon/react";

import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import {
  type FilterOperator,
  type FilterValueKind,
} from "@/lib/filter-contract/index";
import type { AppMessages } from "@/lib/i18n/messages";

import {
  allowedFields,
  fieldLabel,
  registryFieldGroups,
} from "./field-catalog";
import type { FilterPanelAudience } from "./model";
import { VALUELESS_OPERATORS } from "./model";
export function FilterExpressionHelpDialog({
  audience,
  messages,
  observationOnly = false,
  open,
  onOpenChange,
}: {
  audience: FilterPanelAudience;
  messages: AppMessages;
  observationOnly?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fields = useMemo(
    () => allowedFields(audience, observationOnly),
    [audience, observationOnly],
  );
  const fieldGroups = useMemo(() => {
    return registryFieldGroups(fields, messages);
  }, [fields, messages]);
  const operators = useMemo(() => {
    const available = new Set<FilterOperator>();
    fields.forEach((field) =>
      field.operators.forEach((operator) => available.add(operator)),
    );
    return [...available];
  }, [fields]);
  const unaryOperators = operators.filter((operator) =>
    VALUELESS_OPERATORS.has(operator),
  );
  const valueKindLabel = (valueKind: FilterValueKind) =>
    messages.filterBuilder.valueKinds[valueKind];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        className="gap-0 p-0"
        desktopClassName="max-w-4xl"
        drawerClassName="overflow-hidden"
      >
        <ResponsiveDialogHeader className="border-b px-4 py-4 sm:px-5">
          <ResponsiveDialogTitle icon={RiInformationLine}>
            {messages.filterBuilder.expressionHelpTitle}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {messages.filterBuilder.expressionHelpDescription}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="flex flex-col overflow-hidden p-0">
          <VerticalScrollMask
            syncKey={`${audience}:${observationOnly}:${fields.length}:${operators.length}`}
            className="min-h-0 flex-1 max-h-[min(calc(80dvh-5rem),46rem)]"
          >
            <div className="space-y-6 p-4 sm:p-5">
              <section className="space-y-3">
                <h3 className="text-sm font-medium">
                  {messages.filterBuilder.expressionHelpSyntax}
                </h3>
                <div className="space-y-2 border-y border-border py-3 font-mono text-xs">
                  <p>&lt;field&gt; &lt;operator&gt; &lt;value&gt;</p>
                  <p>&lt;expression&gt; AND | OR &lt;expression&gt;</p>
                  <p>NOT &lt;expression&gt; · (&lt;expression&gt;)</p>
                  <p>AND(&lt;expression&gt;) · OR(&lt;expression&gt;)</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {messages.filterBuilder.expressionHelpLogicDescription}
                </p>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium">
                  {messages.filterBuilder.expressionHelpValues}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {messages.filterBuilder.expressionHelpValuesDescription}
                </p>
                <div className="flex flex-wrap gap-2 font-mono text-xs">
                  {[
                    '"text"',
                    "42",
                    "true",
                    '["a", "b"]',
                    "between [10, 20]",
                  ].map((example) => (
                    <code key={example} className="bg-muted px-2 py-1">
                      {example}
                    </code>
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium">
                  {messages.filterBuilder.expressionHelpOperators}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {operators.map((operator) => (
                    <span
                      key={operator}
                      className="inline-flex items-center gap-1 bg-muted px-2 py-1 text-xs"
                    >
                      <code className="font-mono">{operator}</code>
                      <span className="text-muted-foreground">
                        {messages.filterBuilder.operatorLabels[operator] ??
                          operator}
                      </span>
                    </span>
                  ))}
                </div>
                {unaryOperators.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {messages.filterBuilder.expressionHelpUnaryOperators}:{" "}
                    <span className="font-mono">
                      {unaryOperators.join(", ")}
                    </span>
                  </p>
                ) : null}
              </section>

              <section className="space-y-3">
                <h3 className="text-sm font-medium">
                  {messages.filterBuilder.expressionHelpFields}
                </h3>
                <div className="divide-y divide-border border-y border-border">
                  {fieldGroups.map((group) => (
                    <div key={group.key}>
                      <h4 className="bg-muted px-3 py-2 text-xs font-medium">
                        {group.label}
                      </h4>
                      {group.fields.map((field) => (
                        <div
                          key={field.id}
                          className="grid gap-2 px-3 py-2 sm:grid-cols-[minmax(13rem,0.75fr)_minmax(0,1fr)]"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium">
                              {fieldLabel(field, messages)}
                            </div>
                            <code className="block truncate font-mono text-xs text-muted-foreground">
                              {field.id}
                            </code>
                          </div>
                          <div className="min-w-0 space-y-1">
                            <div className="text-xs text-muted-foreground">
                              {messages.filterBuilder.expressionHelpFieldType}:{" "}
                              {valueKindLabel(field.valueKind)}
                            </div>
                            <div className="break-words text-xs text-muted-foreground">
                              {
                                messages.filterBuilder
                                  .expressionHelpFieldOperators
                              }
                              :{" "}
                              <span className="font-mono">
                                {[...field.operators].join(", ")}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </VerticalScrollMask>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
