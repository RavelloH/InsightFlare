import type { ComponentType } from "react";
import { useEffect, useRef, useState } from "react";
import {
  RiCheckLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiQuestionLine,
  RiSave3Line,
  RiSearchLine,
  RiTestTubeLine,
} from "@remixicon/react";

import { BlockingRuleGeoSearchDialog } from "@/components/dashboard/admin/blocking-rule-geo-search-dialog";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  type BlockingFieldId,
  type BlockingRuleSyntaxError,
  matchBlockingRules,
  parseBlockingRules,
} from "@/lib/blocking";
import type { Locale } from "@/lib/i18n/config";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

import {
  blockingEditorLines,
  type BlockingRuleDialogCopy,
  blockingRuleErrorMessage,
  type BlockingRuleFieldCopy,
  blockingTestContext,
} from "./settings-model";
function BlockingRuleHelpDialog({
  copy,
  dialogCopy,
  open,
  onOpenChange,
}: {
  copy: BlockingRuleFieldCopy;
  dialogCopy: BlockingRuleDialogCopy;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const exampleConfig = copy.examples.join("\n");
  const blockExample =
    copy.examples.find((example) => !example.startsWith("-")) ??
    copy.examples[0] ??
    "";
  const allowExample =
    copy.examples.find((example) => example.startsWith("-")) ?? "";
  const allowExamplePattern = allowExample.replace(/^-/, "");

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="max-w-2xl"
        drawerClassName="overflow-hidden"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle icon={RiQuestionLine}>
            {copy.title} · {dialogCopy.helpTitle}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {dialogCopy.helpDescription}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <div className="flex flex-col gap-6">
            <section className="space-y-3">
              <h3 className="text-sm font-medium">{dialogCopy.syntaxTitle}</h3>
              <div className="space-y-2 border-y border-border py-3 text-xs">
                {copy.syntax
                  .split(/\r?\n/u)
                  .filter((line) => line.length > 0)
                  .map((line, index) => (
                    <p key={`${line}-${index}`}>{line}</p>
                  ))}
              </div>
              <p className="text-xs text-muted-foreground">{copy.hint}</p>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {dialogCopy.examplesTitle}
              </h3>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
                {exampleConfig}
              </pre>
              <p className="text-xs text-muted-foreground">
                {copy.exampleDescription}
              </p>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">{dialogCopy.actionsTitle}</h3>
              <p className="text-xs text-muted-foreground">
                {dialogCopy.actionsDescription}
              </p>
              <table className="w-full border-y border-border text-xs">
                <colgroup>
                  <col className="w-1/2" />
                  <col className="w-1/2" />
                </colgroup>
                <tbody className="divide-y divide-border">
                  {blockExample ? (
                    <tr>
                      <td className="w-1/2 px-3 py-3 align-top">
                        <code className="inline-block max-w-full break-all bg-muted px-2 py-1 font-mono">
                          {blockExample}
                        </code>
                      </td>
                      <td className="w-1/2 px-3 py-3 align-top">
                        {formatI18nTemplate(dialogCopy.actionBlock, {
                          example: blockExample,
                        })}
                      </td>
                    </tr>
                  ) : null}
                  {allowExample ? (
                    <tr>
                      <td className="w-1/2 px-3 py-3 align-top">
                        <code className="inline-block max-w-full break-all bg-muted px-2 py-1 font-mono">
                          {allowExample}
                        </code>
                      </td>
                      <td className="w-1/2 px-3 py-3 align-top">
                        {formatI18nTemplate(dialogCopy.actionAllow, {
                          example: allowExamplePattern,
                        })}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </section>
          </div>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
function BlockingRuleTestDialog({
  field,
  copy,
  dialogCopy,
  value,
  errors,
  open,
  onOpenChange,
}: {
  field: BlockingFieldId;
  copy: BlockingRuleFieldCopy;
  dialogCopy: BlockingRuleDialogCopy;
  value: string;
  errors: readonly BlockingRuleSyntaxError[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [testValue, setTestValue] = useState("");
  const [result, setResult] = useState<ReturnType<
    typeof matchBlockingRules
  > | null>(null);
  const fieldResult = result?.fields[field];

  useEffect(() => {
    if (!open) {
      setTestValue("");
      setResult(null);
    }
  }, [open]);

  function handleTest() {
    if (errors.length > 0) {
      setResult(null);
      return;
    }
    const parsed = parseBlockingRules({
      blockingRules: [
        {
          version: 2,
          data: { [field]: blockingEditorLines(value) },
        },
      ],
    });
    if (!parsed.ok) {
      setResult(null);
      return;
    }
    setResult(
      matchBlockingRules(parsed, blockingTestContext(field, testValue)),
    );
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="max-w-xl"
        drawerClassName="overflow-hidden"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle icon={RiTestTubeLine}>
            {copy.title} · {dialogCopy.testTitle}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {dialogCopy.testDescription}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <div className="flex flex-col gap-5">
            <div className="space-y-2">
              <Label htmlFor={`site-settings-blocking-test-${field}`}>
                {copy.testLabel}
              </Label>
              <Input
                id={`site-settings-blocking-test-${field}`}
                value={testValue}
                onChange={(event) => {
                  setTestValue(event.target.value);
                  setResult(null);
                }}
                placeholder={copy.testPlaceholder}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleTest();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">{copy.testHint}</p>
            </div>

            {errors.length > 0 ? (
              <div
                role="alert"
                className="space-y-2 border border-destructive/30 bg-destructive/[0.04] p-3 text-xs text-destructive"
              >
                <p className="font-medium">{dialogCopy.testInvalidRules}</p>
                <ul className="space-y-1">
                  {errors.map((error, index) => (
                    <li key={`${error.code}-${error.line ?? "x"}-${index}`}>
                      {error.line
                        ? `${dialogCopy.testLine} ${error.line}`
                        : dialogCopy.testInvalidRule}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <AutoResizer>
              <AutoTransition
                className="pb-px"
                transitionKey={
                  fieldResult
                    ? `${fieldResult.decision}-${fieldResult.matched.length > 0 ? "matched" : "no-match"}`
                    : "empty"
                }
                initial={false}
                duration={0.15}
              >
                {fieldResult ? (
                  <div
                    aria-live="polite"
                    className={cn(
                      "space-y-3 border p-3",
                      fieldResult.decision === "block"
                        ? "border-destructive/30 bg-destructive/[0.04]"
                        : "border-emerald-500/30 bg-emerald-500/[0.04]",
                    )}
                  >
                    <div
                      className={cn(
                        "inline-flex items-center gap-2 text-sm font-medium",
                        fieldResult.decision === "block"
                          ? "text-destructive"
                          : "text-emerald-700 dark:text-emerald-400",
                      )}
                    >
                      {fieldResult.decision === "block" ? (
                        <RiErrorWarningLine className="size-4" />
                      ) : (
                        <RiCheckLine className="size-4" />
                      )}
                      {fieldResult.decision === "block"
                        ? dialogCopy.testBlocked
                        : dialogCopy.testAllowed}
                    </div>

                    {fieldResult.matched.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-xs font-medium">
                          {dialogCopy.testMatchedRules}
                        </p>
                        <ul className="space-y-1.5 text-xs">
                          {fieldResult.matched.map((reason, index) => (
                            <li
                              key={`${reason.line ?? "x"}-${reason.pattern}-${index}`}
                              className="flex flex-wrap items-center gap-x-2 gap-y-1"
                            >
                              <code className="bg-muted px-1.5 py-0.5 font-mono">
                                {reason.pattern}
                              </code>
                              <span className="text-muted-foreground">
                                {reason.action === "block"
                                  ? dialogCopy.testActionBlock
                                  : dialogCopy.testActionAllow}
                              </span>
                              {reason.line ? (
                                <span className="text-muted-foreground">
                                  ({dialogCopy.testLine} {reason.line})
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {dialogCopy.testNoMatch}
                      </p>
                    )}
                  </div>
                ) : null}
              </AutoTransition>
            </AutoResizer>
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <ResponsiveDialogClose asChild>
            <Button type="button" variant="outline">
              <RiCloseLine className="size-4" />
              <span>{dialogCopy.testClose}</span>
            </Button>
          </ResponsiveDialogClose>
          <Button
            type="button"
            onClick={handleTest}
            disabled={errors.length > 0}
          >
            <RiTestTubeLine className="size-4" />
            <span>{dialogCopy.testRun}</span>
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
export function BlockingRuleEditorCard({
  copy,
  dialogCopy,
  value,
  errors,
  disabled,
  saving,
  changed,
  onChange,
  onSave,
  icon: Icon,
  field,
  locale,
  saveLabel,
  savingLabel,
}: {
  copy: BlockingRuleFieldCopy;
  dialogCopy: BlockingRuleDialogCopy;
  value: string;
  errors: readonly BlockingRuleSyntaxError[];
  disabled: boolean;
  saving: boolean;
  changed: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  icon: ComponentType<{ className?: string }>;
  field: BlockingFieldId;
  locale: Locale;
  saveLabel: string;
  savingLabel: string;
}) {
  const inputId = `site-settings-blocking-${field}`;
  const statusId = `${inputId}-status`;
  const errorId = `${inputId}-errors`;
  const [testOpen, setTestOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastEmittedValueRef = useRef(value);

  useEffect(() => {
    if (value === lastEmittedValueRef.current) return;
    lastEmittedValueRef.current = value;
    if (textareaRef.current && textareaRef.current.value !== value) {
      textareaRef.current.value = value;
    }
  }, [value]);

  const hasRules = blockingEditorLines(value).some(
    (line) => line.trim().length > 0,
  );
  const statusMessage =
    errors.length > 0
      ? dialogCopy.statusInvalid
      : hasRules
        ? dialogCopy.statusValid
        : formatI18nTemplate(dialogCopy.statusEmpty, {
            field: copy.title,
          });
  const statusTransitionKey =
    errors.length > 0 ? "invalid" : hasRules ? "valid" : "empty";
  const statusClassName =
    errors.length > 0
      ? "text-destructive"
      : hasRules
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-muted-foreground";
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <Icon className="size-4" />
          {copy.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex h-full flex-col gap-4">
        <div className="space-y-2">
          <Label htmlFor={inputId}>{copy.label}</Label>
          <textarea
            id={inputId}
            ref={textareaRef}
            defaultValue={value}
            onInput={(event) => {
              const nextValue = event.currentTarget.value;
              lastEmittedValueRef.current = nextValue;
              onChange(nextValue);
            }}
            placeholder={copy.placeholder}
            rows={4}
            aria-invalid={errors.length > 0}
            aria-describedby={[statusId, errors.length > 0 ? errorId : null]
              .filter((id): id is string => id !== null)
              .join(" ")}
            disabled={disabled}
            className="min-h-24 w-full rounded-none border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 dark:bg-input/30 dark:disabled:bg-input/80"
          />
          <AutoResizer>
            <AutoTransition
              transitionKey={statusTransitionKey}
              initial={false}
              duration={0.15}
            >
              <div className="space-y-2">
                <p
                  id={statusId}
                  role="status"
                  className={cn("text-xs", statusClassName)}
                >
                  {statusMessage}
                </p>
                {errors.length > 0 ? (
                  <ul
                    id={errorId}
                    className="space-y-1 text-xs text-destructive"
                  >
                    {errors.map((error, index) => (
                      <li key={`${error.code}-${error.line ?? "x"}-${index}`}>
                        {blockingRuleErrorMessage(error, copy, dialogCopy)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </AutoTransition>
          </AutoResizer>
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            onClick={onSave}
            disabled={disabled || !changed || errors.length > 0}
          >
            <AutoTransition className="inline-flex items-center gap-2">
              {saving ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner className="size-4" />
                  {savingLabel}
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <RiSave3Line className="size-4" />
                  {saveLabel}
                </span>
              )}
            </AutoTransition>
          </Button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {field === "countries" || field === "regions" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setSearchOpen(true)}
              >
                <RiSearchLine className="size-4" />
                <span>{dialogCopy.searchButton}</span>
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => setTestOpen(true)}
            >
              <RiTestTubeLine className="size-4" />
              <span>{dialogCopy.testButton}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setHelpOpen(true)}
            >
              <RiQuestionLine className="size-4" />
              <span>{dialogCopy.helpButton}</span>
            </Button>
          </div>
        </div>
        <BlockingRuleTestDialog
          field={field}
          copy={copy}
          dialogCopy={dialogCopy}
          value={value}
          errors={errors}
          open={testOpen}
          onOpenChange={setTestOpen}
        />
        <BlockingRuleHelpDialog
          copy={copy}
          dialogCopy={dialogCopy}
          open={helpOpen}
          onOpenChange={setHelpOpen}
        />
        {field === "countries" || field === "regions" ? (
          <BlockingRuleGeoSearchDialog
            field={field}
            title={copy.title}
            locale={locale}
            copy={dialogCopy}
            open={searchOpen}
            onOpenChange={setSearchOpen}
            onSelect={(selectedValue) => {
              const lines = blockingEditorLines(value);
              const nextLines = lines.includes(selectedValue)
                ? lines
                : [...lines, selectedValue];
              onChange(nextLines.join("\n"));
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
