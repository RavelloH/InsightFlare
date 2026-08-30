import type { ComponentType, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiArrowRightLine,
  RiBarChartBoxLine,
  RiCheckLine,
  RiCloseLine,
  RiCodeLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiGlobalLine,
  RiLinksLine,
  RiQuestionLine,
  RiRouteLine,
  RiSave3Line,
  RiSearchLine,
  RiSettings3Line,
  RiShareForwardLine,
  RiSpeedUpLine,
  RiTestTubeLine,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { BlockingRuleGeoSearchDialog } from "@/components/dashboard/blocking-rule-geo-search-dialog";
import { PageHeading } from "@/components/dashboard/page-heading";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import {
  type AdminServiceHttpMethod,
  requestAdminService,
} from "@/lib/admin-service-client";
import type { AdminServiceRoute } from "@/lib/admin-service-contract";
import {
  BLOCKING_FIELD_IDS,
  type BlockingFieldId,
  type BlockingRequestContext,
  type BlockingRuleSyntaxError,
  matchBlockingRules,
  parseBlockingRules,
  validateBlockingRules,
} from "@/lib/blocking-rules";
import type { SiteSettingsInitialData } from "@/lib/dashboard/management-data";
import type { SiteData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { navigateWithTransition } from "@/lib/page-transition";
import { useRouter } from "@/lib/router";
import {
  DEFAULT_SITE_SCRIPT_SETTINGS,
  normalizeSiteScriptSettings,
  type SiteSettingsConfig,
  type TrackingStrength,
} from "@/lib/site-settings";
import { cn } from "@/lib/utils";

interface SiteSettingsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  teamSlug: string;
  activeTeamId: string;
  siteSlug: string;
  teams: Array<{
    id: string;
    slug: string;
    name: string;
  }>;
  site: Pick<
    SiteData,
    "id" | "name" | "domain" | "publicEnabled" | "publicSlug"
  >;
  initialData?: SiteSettingsInitialData | null;
}

function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveSiteSlug(
  site: Pick<SiteData, "id" | "name" | "domain" | "publicSlug">,
): string {
  const candidate = safeSlug(String(site.domain || "").trim());
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}

function randomPublicSlug(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const values = new Uint8Array(8);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join(
    "",
  );
}

function formatSampleRateValue(value: number): string {
  const formatted = Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${formatted}%`;
}

async function postJson<T>(
  route: AdminServiceRoute,
  body: Record<string, unknown>,
  method: AdminServiceHttpMethod = "POST",
): Promise<T> {
  return requestAdminService<T>(route, { method, body });
}

type BlockingEditorValues = Record<BlockingFieldId, string>;

interface BlockingRuleFieldCopy {
  title: string;
  label: string;
  placeholder: string;
  hint: string;
  syntax: string;
  examples: readonly string[];
  exampleDescription: string;
  testLabel: string;
  testPlaceholder: string;
  testHint: string;
}

interface BlockingRuleDialogCopy {
  testButton: string;
  helpButton: string;
  searchButton: string;
  searchTitle: string;
  searchDescription: string;
  searchInputLabel: string;
  searchInputPlaceholder: string;
  searchCountryLabel: string;
  searchRegionLabel: string;
  searchBack: string;
  searchLoading: string;
  searchNoResults: string;
  searchLoadError: string;
  searchClose: string;
  helpTitle: string;
  helpDescription: string;
  syntaxTitle: string;
  examplesTitle: string;
  actionsTitle: string;
  actionsDescription: string;
  actionBlock: string;
  actionAllow: string;
  statusEmpty: string;
  statusValid: string;
  statusInvalid: string;
  errorInvalidRule: string;
  errorInvalidLines: string;
  errorInvalidLine: string;
  errorLineTooLong: string;
  errorTooManyLines: string;
  errorInvalidPattern: string;
  testTitle: string;
  testDescription: string;
  testRun: string;
  testClose: string;
  testInvalidRules: string;
  testInvalidRule: string;
  testBlocked: string;
  testAllowed: string;
  testNoMatch: string;
  testMatchedRules: string;
  testActionBlock: string;
  testActionAllow: string;
  testLine: string;
}

const BLOCKING_RULE_FIELD_DEFINITIONS: ReadonlyArray<{
  field: BlockingFieldId;
  icon: ComponentType<{ className?: string }>;
}> = [
  { field: "domains", icon: RiGlobalLine },
  { field: "paths", icon: RiRouteLine },
  { field: "queryParameters", icon: RiSettings3Line },
  { field: "referrers", icon: RiLinksLine },
  { field: "userAgents", icon: RiCodeLine },
  { field: "ips", icon: RiBarChartBoxLine },
  { field: "asns", icon: RiBarChartBoxLine },
  { field: "countries", icon: RiGlobalLine },
  { field: "regions", icon: RiGlobalLine },
];

function blockingEditorValues(input: unknown): BlockingEditorValues {
  const parsed = parseBlockingRules(input);
  return Object.fromEntries(
    BLOCKING_FIELD_IDS.map((field) => [
      field,
      parsed.fields[field].lines.join("\n"),
    ]),
  ) as BlockingEditorValues;
}

function blockingEditorLines(value: string): string[] {
  return value.length === 0 ? [] : value.split(/\r?\n/u);
}

function blockingRuleErrorMessage(
  error: BlockingRuleSyntaxError,
  copy: BlockingRuleFieldCopy,
  dialogCopy: BlockingRuleDialogCopy,
): string {
  const params = {
    field: copy.title,
    line: error.line ?? "",
  };
  switch (error.code) {
    case "invalid_lines":
      return formatI18nTemplate(dialogCopy.errorInvalidLines, params);
    case "invalid_line":
      return formatI18nTemplate(dialogCopy.errorInvalidLine, params);
    case "line_too_long":
      return formatI18nTemplate(dialogCopy.errorLineTooLong, params);
    case "too_many_lines":
      return dialogCopy.errorTooManyLines;
    case "invalid_pattern":
      return formatI18nTemplate(dialogCopy.errorInvalidPattern, params);
    default:
      return dialogCopy.errorInvalidRule;
  }
}

function blockingTestContext(
  field: BlockingFieldId,
  value: string,
): BlockingRequestContext {
  const input = value.trim();
  switch (field) {
    case "domains":
      return { hostname: input };
    case "paths":
      return { pathname: input };
    case "queryParameters":
      return { query: input };
    case "referrers":
      return { referrer: input };
    case "userAgents":
      return { userAgent: input };
    case "ips":
      return { ip: input };
    case "asns":
      return { asn: input };
    case "countries":
      return { country: input };
    case "regions":
      return { region: input };
  }
}

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

function BlockingRuleEditorCard({
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

function SettingsSection({
  id,
  title,
  description,
  children,
  danger = false,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "space-y-4",
        danger && "border border-destructive/20 bg-destructive/[0.02] p-4",
      )}
    >
      <div className="space-y-1 border-b pb-3">
        <h2
          id={id}
          className={cn(
            "text-base font-semibold",
            danger && "text-destructive",
          )}
        >
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{children}</div>
    </section>
  );
}

export function SettingsClientPage({
  locale,
  messages,
  teamSlug,
  activeTeamId,
  siteSlug,
  teams,
  site,
  initialData = null,
}: SiteSettingsClientPageProps) {
  const router = useRouter();
  const copy = messages.siteSettings;
  const initialTrackerSettings = normalizeSiteScriptSettings(
    initialData?.config,
  );
  const [name, setName] = useState(site.name);
  const [domain, setDomain] = useState(site.domain);
  const [publicEnabled, setPublicEnabled] = useState(
    Boolean(site.publicEnabled),
  );
  const [publicSlug, setPublicSlug] = useState(site.publicSlug || "");
  const [persistedName, setPersistedName] = useState(site.name);
  const [persistedDomain, setPersistedDomain] = useState(site.domain);
  const [persistedPublicEnabled, setPersistedPublicEnabled] = useState(
    Boolean(site.publicEnabled),
  );
  const [persistedPublicSlug, setPersistedPublicSlug] = useState(
    site.publicSlug || "",
  );
  const [saving, setSaving] = useState(false);
  const [savingPublicSharing, setSavingPublicSharing] = useState(false);
  const [savingTrackingStrength, setSavingTrackingStrength] = useState(false);
  const [savingQueryHash, setSavingQueryHash] = useState(false);
  const [savingPerformanceTracking, setSavingPerformanceTracking] =
    useState(false);
  const [savingBlockingField, setSavingBlockingField] =
    useState<BlockingFieldId | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [currentSiteSlug, setCurrentSiteSlug] = useState(siteSlug);
  const [transferTeamId, setTransferTeamId] = useState(activeTeamId);
  const [trackingStrength, setTrackingStrength] = useState<TrackingStrength>(
    initialTrackerSettings.trackingStrength,
  );
  const [trackQueryParams, setTrackQueryParams] = useState(
    initialTrackerSettings.trackQueryParams,
  );
  const [trackHash, setTrackHash] = useState(initialTrackerSettings.trackHash);
  const [ignoreDoNotTrack, setIgnoreDoNotTrack] = useState(
    initialTrackerSettings.ignoreDoNotTrack,
  );
  const [autoTrackOutboundLinks, setAutoTrackOutboundLinks] = useState(
    initialTrackerSettings.autoTrackOutboundLinks,
  );
  const [savingAutoTracking, setSavingAutoTracking] = useState(false);
  const [performanceSampleRate, setPerformanceSampleRate] = useState(
    initialTrackerSettings.performanceSampleRate,
  );
  const [blockingInputs, setBlockingInputs] = useState<BlockingEditorValues>(
    () => blockingEditorValues(initialData?.config),
  );
  const [persistedBlockingInputs, setPersistedBlockingInputs] =
    useState<BlockingEditorValues>(() =>
      blockingEditorValues(initialData?.config),
    );
  const [persistedSettings, setPersistedSettings] = useState(
    initialTrackerSettings,
  );
  const [origin, setOrigin] = useState(initialData?.origin ?? "");
  const appliedConfigSiteIdRef = useRef<string | null>(null);
  const appliedSnippetSiteIdRef = useRef<string | null>(null);

  const hasAutoTrackingChanges =
    autoTrackOutboundLinks !== persistedSettings.autoTrackOutboundLinks;

  const trackingSaving =
    savingTrackingStrength ||
    savingQueryHash ||
    savingPerformanceTracking ||
    savingBlockingField !== null ||
    savingAutoTracking;

  const hasSiteInfoChanges =
    name.trim() !== persistedName.trim() ||
    domain.trim() !== persistedDomain.trim();

  const hasPublicSharingChanges =
    publicEnabled !== persistedPublicEnabled ||
    publicSlug.trim() !== persistedPublicSlug.trim();

  const hasTrackingStrengthChanges =
    trackingStrength !== persistedSettings.trackingStrength;

  const hasQueryHashChanges =
    trackQueryParams !== persistedSettings.trackQueryParams ||
    trackHash !== persistedSettings.trackHash ||
    ignoreDoNotTrack !== persistedSettings.ignoreDoNotTrack;

  const normalizedPerformanceSampleRate = normalizeSiteScriptSettings({
    performanceSampleRate,
  }).performanceSampleRate;

  const hasPerformanceTrackingChanges =
    normalizedPerformanceSampleRate !== persistedSettings.performanceSampleRate;

  const blockingValidation = useMemo(
    () =>
      Object.fromEntries(
        BLOCKING_FIELD_IDS.map((field) => {
          const errors = validateBlockingRules({
            blockingRules: [
              {
                version: 2,
                data: { [field]: blockingEditorLines(blockingInputs[field]) },
              },
            ],
          }).filter((error) => error.field === field);
          return [field, errors];
        }),
      ) as unknown as Record<
        BlockingFieldId,
        readonly BlockingRuleSyntaxError[]
      >,
    [blockingInputs],
  );

  function applyTrackerSettings(raw: unknown) {
    const normalized = normalizeSiteScriptSettings(raw);
    setPersistedSettings(normalized);
    setTrackingStrength(normalized.trackingStrength);
    setTrackQueryParams(normalized.trackQueryParams);
    setTrackHash(normalized.trackHash);
    setIgnoreDoNotTrack(normalized.ignoreDoNotTrack);
    setAutoTrackOutboundLinks(normalized.autoTrackOutboundLinks);
    setPerformanceSampleRate(normalized.performanceSampleRate);
    const nextBlockingInputs = blockingEditorValues(raw);
    setBlockingInputs(nextBlockingInputs);
    setPersistedBlockingInputs(nextBlockingInputs);
  }

  const siteConfigQuery = useQuery({
    queryKey: ["dashboard", "site-config", site.id],
    queryFn: ({ signal }) =>
      requestAdminService<SiteSettingsConfig>("site-config", {
        params: { siteId: site.id },
        signal,
      }),
    initialData: initialData?.config,
    initialDataUpdatedAt: initialData?.fetchedAt,
    enabled: typeof window !== "undefined",
  });
  const scriptSnippetQuery = useQuery({
    queryKey: ["dashboard", "site-script-snippet", site.id],
    queryFn: async ({ signal }) => {
      const data = await requestAdminService<{
        siteId: string;
        src: string;
        snippet: string;
      }>("script-snippet", {
        params: { siteId: site.id },
        signal,
      });
      return data.snippet;
    },
    initialData: initialData?.scriptSnippet,
    initialDataUpdatedAt: initialData?.fetchedAt,
    enabled: typeof window !== "undefined",
  });
  const loadingSettings = siteConfigQuery.isPending;
  const loadingScript = scriptSnippetQuery.isPending;
  const scriptSnippet = scriptSnippetQuery.data ?? "";

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    if (
      siteConfigQuery.isPending ||
      appliedConfigSiteIdRef.current === site.id
    ) {
      return;
    }
    applyTrackerSettings(siteConfigQuery.data ?? DEFAULT_SITE_SCRIPT_SETTINGS);
    appliedConfigSiteIdRef.current = site.id;
    if (siteConfigQuery.isError) toast.error(copy.toasts.settingsLoadFailed);
  }, [
    copy.toasts.settingsLoadFailed,
    site.id,
    siteConfigQuery.data,
    siteConfigQuery.isError,
    siteConfigQuery.isPending,
  ]);

  useEffect(() => {
    if (
      scriptSnippetQuery.isPending ||
      appliedSnippetSiteIdRef.current === site.id
    ) {
      return;
    }
    appliedSnippetSiteIdRef.current = site.id;
    if (scriptSnippetQuery.isError) toast.error(copy.toasts.scriptLoadFailed);
  }, [
    copy.toasts.scriptLoadFailed,
    scriptSnippetQuery.isError,
    scriptSnippetQuery.isPending,
    site.id,
  ]);

  async function handleSave() {
    if (name.trim().length < 2 || domain.trim().length < 3) {
      toast.error(copy.toasts.invalidInput);
      return;
    }
    if (!hasSiteInfoChanges) {
      return;
    }

    setSaving(true);
    try {
      const updated = await postJson<SiteData>(
        "sites",
        {
          intent: "update",
          siteId: site.id,
          name: name.trim(),
          domain: domain.trim(),
        },
        "PATCH",
      );

      setName(updated.name);
      setDomain(updated.domain);
      setPersistedName(updated.name);
      setPersistedDomain(updated.domain);
      toast.success(copy.toasts.saved);

      const nextSlug = resolveSiteSlug(updated);
      if (nextSlug !== currentSiteSlug) {
        setCurrentSiteSlug(nextSlug);
        navigateWithTransition(
          router,
          `/${locale}/app/${teamSlug}/${nextSlug}/settings`,
        );
      } else {
        router.refresh();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  async function handleSavePublicSharing() {
    if (!hasPublicSharingChanges) return;

    setSavingPublicSharing(true);
    try {
      const nextPublicSlug = publicEnabled
        ? publicSlug.trim() || randomPublicSlug()
        : publicSlug.trim();
      const updated = await postJson<SiteData>(
        "sites",
        {
          intent: "update",
          siteId: site.id,
          publicEnabled,
          publicSlug: nextPublicSlug || undefined,
        },
        "PATCH",
      );

      const updatedPublicEnabled = Boolean(updated.publicEnabled);
      const updatedPublicSlug = updated.publicSlug || "";
      setPublicEnabled(updatedPublicEnabled);
      setPublicSlug(updatedPublicSlug);
      setPersistedPublicEnabled(updatedPublicEnabled);
      setPersistedPublicSlug(updatedPublicSlug);
      toast.success(copy.toasts.saved);

      const nextSlug = resolveSiteSlug(updated);
      if (nextSlug !== currentSiteSlug) {
        setCurrentSiteSlug(nextSlug);
        navigateWithTransition(
          router,
          `/${locale}/app/${teamSlug}/${nextSlug}/settings`,
        );
      } else {
        router.refresh();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingPublicSharing(false);
    }
  }

  async function persistTrackingSettings(input: Record<string, unknown>) {
    const savedSettings = await postJson<SiteSettingsConfig>("site-config", {
      siteId: site.id,
      config: input,
    });
    applyTrackerSettings(savedSettings);
    toast.success(
      `${copy.toasts.saved} ${copy.toasts.settingsPropagationHint}`,
    );
  }

  async function handleSaveTrackingStrength() {
    if (!hasTrackingStrengthChanges) return;
    setSavingTrackingStrength(true);
    try {
      await persistTrackingSettings({
        trackingStrength,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingTrackingStrength(false);
    }
  }

  async function handleSaveQueryHash() {
    if (!hasQueryHashChanges) return;
    setSavingQueryHash(true);
    try {
      await persistTrackingSettings({
        trackQueryParams,
        trackHash,
        ignoreDoNotTrack,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingQueryHash(false);
    }
  }

  async function handleSaveAutoTracking() {
    if (!hasAutoTrackingChanges) return;
    setSavingAutoTracking(true);
    try {
      await persistTrackingSettings({
        autoTrackOutboundLinks,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingAutoTracking(false);
    }
  }

  async function handleSavePerformanceTracking() {
    if (!hasPerformanceTrackingChanges) return;
    setSavingPerformanceTracking(true);
    try {
      await persistTrackingSettings({
        performanceSampleRate: normalizedPerformanceSampleRate,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingPerformanceTracking(false);
    }
  }

  async function handleSaveBlockingField(field: BlockingFieldId) {
    if (blockingInputs[field] === persistedBlockingInputs[field]) return;
    const errors = blockingValidation[field];
    if (errors.length > 0) {
      toast.error(
        blockingRuleErrorMessage(
          errors[0],
          copy.blockingRulesFields[field],
          copy.blockingRulesDialogs,
        ),
      );
      return;
    }
    setSavingBlockingField(field);
    try {
      const savedSettings = await postJson<SiteSettingsConfig>("site-config", {
        siteId: site.id,
        config: {},
        blockingPatch: {
          [field]: blockingEditorLines(blockingInputs[field]),
        },
      });
      applyTrackerSettings(savedSettings);
      toast.success(
        `${copy.toasts.saved} ${copy.toasts.settingsPropagationHint}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.saveFailed;
      toast.error(message || copy.toasts.saveFailed);
    } finally {
      setSavingBlockingField(null);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await postJson<{ siteId: string; teamId: string; removed: boolean }>(
        "sites",
        {
          intent: "remove",
          siteId: site.id,
        },
        "PATCH",
      );
      toast.success(copy.toasts.deleted);
      setDeleteDialogOpen(false);
      navigateWithTransition(router, `/${locale}/app/${teamSlug}`);
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.deleteFailed;
      toast.error(message || copy.toasts.deleteFailed);
    } finally {
      setDeleting(false);
    }
  }

  async function handleTransfer() {
    if (!transferTeamId || transferTeamId === activeTeamId) return;

    const targetTeam = teams.find((team) => team.id === transferTeamId);
    if (!targetTeam) {
      toast.error(copy.toasts.transferFailed);
      return;
    }

    setTransferring(true);
    try {
      const updated = await postJson<SiteData>(
        "sites",
        {
          intent: "update",
          siteId: site.id,
          teamId: targetTeam.id,
        },
        "PATCH",
      );
      toast.success(copy.toasts.transferred);
      const nextSlug = resolveSiteSlug(updated);
      navigateWithTransition(
        router,
        `/${locale}/app/${targetTeam.slug}/${nextSlug}`,
      );
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : copy.toasts.transferFailed;
      toast.error(message || copy.toasts.transferFailed);
    } finally {
      setTransferring(false);
    }
  }

  async function handleCopyScript() {
    if (!scriptSnippet) return;
    try {
      await navigator.clipboard.writeText(scriptSnippet);
      toast.success(copy.copiedScript);
    } catch {
      toast.error(copy.toasts.scriptLoadFailed);
    }
  }

  async function handleCopyPublicLink() {
    const link = publicLink;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success(copy.copiedLink);
    } catch {
      toast.error(copy.toasts.saveFailed);
    }
  }

  const publicLink =
    publicEnabled && publicSlug.trim() && origin
      ? `${origin}/share/${encodeURIComponent(publicSlug.trim())}`
      : "";

  return (
    <div className="space-y-6">
      <PageHeading title={copy.title} subtitle={copy.subtitle} />

      <SettingsSection
        id="site-settings-basic-info"
        title={copy.sections.basic.title}
        description={copy.sections.basic.description}
      >
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiSettings3Line className="size-4" />
              {copy.editTitle}
            </CardTitle>
            <CardDescription>{copy.editSubtitle}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col">
            <form
              className="flex h-full flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="site-settings-name">{copy.nameLabel}</Label>
                <Input
                  id="site-settings-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  minLength={2}
                  disabled={
                    saving ||
                    trackingSaving ||
                    transferring ||
                    deleting ||
                    loadingSettings
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="site-settings-domain">{copy.domainLabel}</Label>
                <Input
                  id="site-settings-domain"
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                  minLength={3}
                  disabled={
                    saving ||
                    trackingSaving ||
                    transferring ||
                    deleting ||
                    loadingSettings
                  }
                  required
                />
              </div>

              <Button
                type="submit"
                className="mt-auto self-start"
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings ||
                  !hasSiteInfoChanges
                }
              >
                <AutoTransition className="inline-flex items-center gap-2">
                  {saving ? (
                    <span
                      key="saving"
                      className="inline-flex items-center gap-2"
                    >
                      <Spinner className="size-4" />
                      {copy.saving}
                    </span>
                  ) : (
                    <span key="save" className="inline-flex items-center gap-2">
                      <RiSave3Line className="size-4" />
                      {copy.save}
                    </span>
                  )}
                </AutoTransition>
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiShareForwardLine className="size-4" />
              {copy.publicSharingTitle}
            </CardTitle>
            <CardDescription>{copy.publicSharingSubtitle}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="site-settings-public-enabled">
                {copy.publicEnabledLabel}
              </Label>
              <Select
                value={publicEnabled ? "true" : "false"}
                onValueChange={(value) => {
                  const enabled = value === "true";
                  setPublicEnabled(enabled);
                  if (enabled && !publicSlug.trim()) {
                    setPublicSlug(randomPublicSlug());
                  }
                }}
                disabled={
                  saving ||
                  savingPublicSharing ||
                  trackingSaving ||
                  transferring ||
                  deleting
                }
              >
                <SelectTrigger
                  id="site-settings-public-enabled"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{copy.booleanOn}</SelectItem>
                  <SelectItem value="false">{copy.booleanOff}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="site-settings-public-slug">
                {copy.publicSlugLabel}
              </Label>
              <Input
                id="site-settings-public-slug"
                value={publicSlug}
                placeholder={copy.publicSlugPlaceholder}
                onChange={(event) => setPublicSlug(event.target.value)}
                disabled={
                  saving ||
                  savingPublicSharing ||
                  trackingSaving ||
                  transferring ||
                  deleting
                }
              />
              <p className="text-xs text-muted-foreground">
                {copy.publicSlugHint}
              </p>
            </div>

            <AutoResizer initial duration={0.24} ease={[0.22, 1, 0.36, 1]}>
              <AutoTransition
                initial={false}
                duration={0.18}
                type="fade"
                presenceMode="wait"
                transitionKey={publicEnabled ? "enabled" : "disabled"}
              >
                <div
                  key={publicEnabled ? "enabled" : "disabled"}
                  className="space-y-2"
                >
                  <Label htmlFor="site-settings-public-link">
                    {copy.publicLinkLabel}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="site-settings-public-link"
                      value={publicLink}
                      placeholder={
                        publicEnabled
                          ? copy.publicLinkHint
                          : copy.publicDisabledHint
                      }
                      readOnly
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        void handleCopyPublicLink();
                      }}
                      disabled={!publicLink}
                    >
                      <RiFileCopyLine className="size-4" />
                      <span>
                        {messages.teamManagement.publicLinks.copyLink}
                      </span>
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {publicEnabled
                      ? copy.publicLinkHint
                      : copy.publicDisabledHint}
                  </p>
                </div>
              </AutoTransition>
            </AutoResizer>

            <Button
              type="button"
              className="mt-auto self-start"
              onClick={() => {
                void handleSavePublicSharing();
              }}
              disabled={
                saving ||
                savingPublicSharing ||
                trackingSaving ||
                transferring ||
                deleting ||
                !hasPublicSharingChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingPublicSharing ? (
                  <span
                    key="saving-public-sharing"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.saving}
                  </span>
                ) : (
                  <span
                    key="save-public-sharing"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.save}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full lg:col-span-2">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiCodeLine className="size-4" />
              {copy.scriptTitle}
            </CardTitle>
            <CardDescription>{copy.scriptSubtitle}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-3">
            <p className="text-xs text-muted-foreground">{copy.scriptHint}</p>
            <div className="border bg-muted/30 p-3">
              {loadingScript ? (
                <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-4" />
                  {copy.loadingScript}
                </div>
              ) : (
                <div className="overflow-x-auto text-xs leading-relaxed text-foreground">
                  <code className="font-mono">
                    {scriptSnippet || copy.scriptUnavailable}
                  </code>
                </div>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              className="mt-auto self-start"
              onClick={() => {
                void handleCopyScript();
              }}
              disabled={loadingScript || !scriptSnippet}
            >
              <RiFileCopyLine className="size-4" />
              <span>{copy.copyScript}</span>
            </Button>
          </CardContent>
        </Card>
      </SettingsSection>

      <SettingsSection
        id="site-settings-tracking"
        title={copy.sections.tracking.title}
        description={copy.sections.tracking.description}
      >
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiBarChartBoxLine className="size-4" />
              {copy.trackingStrengthGroupTitle}
            </CardTitle>
            <CardDescription>
              {copy.trackingStrengthDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
            {loadingSettings ? (
              <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-4" />
                {copy.loadingSettings}
              </div>
            ) : null}
            <RadioGroup
              aria-label={copy.trackingStrengthLabel}
              value={trackingStrength}
              onValueChange={(value) => {
                setTrackingStrength(value as TrackingStrength);
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings
              }
              className="gap-2"
            >
              {[
                {
                  value: "strong" as const,
                  label: copy.trackingStrengthStrong,
                  description: copy.trackingStrengthStrongDescription,
                },
                {
                  value: "smart" as const,
                  label: copy.trackingStrengthSmart,
                  description: copy.trackingStrengthSmartDescription,
                },
                {
                  value: "weak" as const,
                  label: copy.trackingStrengthWeak,
                  description: copy.trackingStrengthWeakDescription,
                },
              ].map((item) => {
                const id = `site-settings-tracking-strength-${item.value}`;
                return (
                  <FieldLabel
                    key={item.value}
                    htmlFor={id}
                    className="cursor-pointer"
                  >
                    <Field
                      orientation="horizontal"
                      className={cn(
                        trackingStrength === item.value
                          ? "border-foreground/30 bg-muted/30"
                          : "border-border hover:bg-muted/20",
                      )}
                    >
                      <FieldContent>
                        <FieldTitle>{item.label}</FieldTitle>
                        <FieldDescription>{item.description}</FieldDescription>
                      </FieldContent>
                      <RadioGroupItem
                        id={id}
                        value={item.value}
                        className="mt-0.5"
                      />
                    </Field>
                  </FieldLabel>
                );
              })}
            </RadioGroup>
            <Button
              type="button"
              className="mt-auto self-start"
              onClick={() => {
                void handleSaveTrackingStrength();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasTrackingStrengthChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingTrackingStrength ? (
                  <span
                    key="saving-strength"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span
                    key="save-strength"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.saveTracking}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiLinksLine className="size-4" />
              {copy.queryHashGroupTitle}
            </CardTitle>
            <CardDescription>{copy.queryHashGroupDescription}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="site-settings-track-query">
                {copy.trackQueryParamsLabel}
              </Label>
              <Select
                value={trackQueryParams ? "true" : "false"}
                onValueChange={(value) => {
                  setTrackQueryParams(value === "true");
                }}
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings
                }
              >
                <SelectTrigger
                  id="site-settings-track-query"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{copy.booleanOn}</SelectItem>
                  <SelectItem value="false">{copy.booleanOff}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-settings-track-hash">
                {copy.trackHashLabel}
              </Label>
              <Select
                value={trackHash ? "true" : "false"}
                onValueChange={(value) => {
                  setTrackHash(value === "true");
                }}
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings
                }
              >
                <SelectTrigger id="site-settings-track-hash" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{copy.booleanOn}</SelectItem>
                  <SelectItem value="false">{copy.booleanOff}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-settings-ignore-dnt">
                {copy.ignoreDoNotTrackLabel}
              </Label>
              <Select
                value={ignoreDoNotTrack ? "true" : "false"}
                onValueChange={(value) => {
                  setIgnoreDoNotTrack(value === "true");
                }}
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings
                }
              >
                <SelectTrigger id="site-settings-ignore-dnt" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{copy.booleanOn}</SelectItem>
                  <SelectItem value="false">{copy.booleanOff}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              className="mt-auto self-start"
              onClick={() => {
                void handleSaveQueryHash();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasQueryHashChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingQueryHash ? (
                  <span
                    key="saving-query-hash"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span
                    key="save-query-hash"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.saveTracking}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiRouteLine className="size-4" />
              {copy.autoTrackGroupTitle}
            </CardTitle>
            <CardDescription>{copy.autoTrackGroupDescription}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="site-settings-auto-track-outbound">
                {copy.autoTrackOutboundLinksLabel}
              </Label>
              <Select
                value={autoTrackOutboundLinks ? "true" : "false"}
                onValueChange={(value) => {
                  setAutoTrackOutboundLinks(value === "true");
                }}
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings
                }
              >
                <SelectTrigger
                  id="site-settings-auto-track-outbound"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{copy.booleanOn}</SelectItem>
                  <SelectItem value="false">{copy.booleanOff}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {copy.autoTrackOutboundLinksHint}
              </p>
            </div>
            <Button
              type="button"
              className="mt-auto self-start"
              onClick={() => {
                void handleSaveAutoTracking();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasAutoTrackingChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingAutoTracking ? (
                  <span
                    key="saving-auto-tracking"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span
                    key="save-auto-tracking"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.saveTracking}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiSpeedUpLine className="size-4" />
              {copy.performanceGroupTitle}
            </CardTitle>
            <CardDescription>
              {copy.performanceGroupDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="site-settings-performance-sample-rate">
                  {copy.performanceSampleRateLabel}
                </Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatSampleRateValue(normalizedPerformanceSampleRate)}
                </span>
              </div>
              <Slider
                id="site-settings-performance-sample-rate"
                min={0}
                max={100}
                step={1}
                value={[normalizedPerformanceSampleRate]}
                onValueChange={(value) => {
                  setPerformanceSampleRate(value[0] ?? 0);
                }}
                aria-label={copy.performanceSampleRateLabel}
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  loadingSettings
                }
              />
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>0%</span>
                <span>100%</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {copy.performanceSampleRateHint}
              </p>
            </div>
            <Button
              type="button"
              className="mt-auto self-start"
              onClick={() => {
                void handleSavePerformanceTracking();
              }}
              disabled={
                saving ||
                trackingSaving ||
                transferring ||
                deleting ||
                loadingSettings ||
                !hasPerformanceTrackingChanges
              }
            >
              <AutoTransition className="inline-flex items-center gap-2">
                {savingPerformanceTracking ? (
                  <span
                    key="saving-performance"
                    className="inline-flex items-center gap-2"
                  >
                    <Spinner className="size-4" />
                    {copy.savingTracking}
                  </span>
                ) : (
                  <span
                    key="save-performance"
                    className="inline-flex items-center gap-2"
                  >
                    <RiSave3Line className="size-4" />
                    {copy.saveTracking}
                  </span>
                )}
              </AutoTransition>
            </Button>
          </CardContent>
        </Card>
      </SettingsSection>

      <SettingsSection
        id="site-settings-blocking"
        title={copy.sections.blocking.title}
        description={copy.sections.blocking.description}
      >
        {BLOCKING_RULE_FIELD_DEFINITIONS.map(({ field, icon }) => (
          <BlockingRuleEditorCard
            key={field}
            field={field}
            icon={icon}
            locale={locale}
            copy={copy.blockingRulesFields[field]}
            dialogCopy={copy.blockingRulesDialogs}
            value={blockingInputs[field]}
            errors={blockingValidation[field]}
            disabled={
              saving ||
              trackingSaving ||
              transferring ||
              deleting ||
              loadingSettings
            }
            saving={savingBlockingField === field}
            changed={blockingInputs[field] !== persistedBlockingInputs[field]}
            onChange={(value) => {
              setBlockingInputs((current) => ({ ...current, [field]: value }));
            }}
            onSave={() => {
              void handleSaveBlockingField(field);
            }}
            saveLabel={copy.blockingRulesSave}
            savingLabel={copy.blockingRulesSaving}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        id="site-settings-danger"
        title={copy.sections.danger.title}
        description={copy.sections.danger.description}
        danger
      >
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiArrowRightLine className="size-4" />
              {copy.transferTitle}
            </CardTitle>
            <CardDescription>{copy.transferSubtitle}</CardDescription>
          </CardHeader>
          <CardContent className="flex h-full flex-col">
            <form
              className="flex h-full flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleTransfer();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="site-settings-transfer-team">
                  {copy.transferTeamLabel}
                </Label>
                <Select
                  value={transferTeamId}
                  onValueChange={setTransferTeamId}
                >
                  <SelectTrigger
                    id="site-settings-transfer-team"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {teams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                type="submit"
                className="mt-auto self-start"
                disabled={
                  saving ||
                  trackingSaving ||
                  transferring ||
                  deleting ||
                  transferTeamId === activeTeamId
                }
              >
                <AutoTransition className="inline-flex items-center gap-2">
                  {transferring ? (
                    <span
                      key="transferring"
                      className="inline-flex items-center gap-2"
                    >
                      <Spinner className="size-4" />
                      {copy.transferring}
                    </span>
                  ) : (
                    <span
                      key="transfer"
                      className="inline-flex items-center gap-2"
                    >
                      <RiArrowRightLine className="size-4" />
                      {copy.transfer}
                    </span>
                  )}
                </AutoTransition>
              </Button>
            </form>
          </CardContent>
        </Card>

        <AlertDialog
          open={deleteDialogOpen}
          onOpenChange={(open) => {
            if (deleting) return;
            setDeleteDialogOpen(open);
          }}
        >
          <Card className="h-full border-destructive/40">
            <CardHeader>
              <CardTitle className="inline-flex items-center gap-2">
                <RiDeleteBinLine className="size-4" />
                {copy.deleteTitle}
              </CardTitle>
              <CardDescription>{copy.deleteSubtitle}</CardDescription>
            </CardHeader>
            <CardContent className="flex h-full items-end">
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={
                    saving || trackingSaving || transferring || deleting
                  }
                >
                  <AutoTransition className="inline-flex items-center gap-2">
                    {deleting ? (
                      <span
                        key="deleting"
                        className="inline-flex items-center gap-2"
                      >
                        <Spinner className="size-4" />
                        {copy.deleting}
                      </span>
                    ) : (
                      <span
                        key="delete"
                        className="inline-flex items-center gap-2"
                      >
                        <RiDeleteBinLine className="size-4" />
                        {copy.delete}
                      </span>
                    )}
                  </AutoTransition>
                </Button>
              </AlertDialogTrigger>
            </CardContent>
          </Card>

          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle icon={RiDeleteBinLine}>
                {copy.deleteTitle}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {copy.deleteConfirm}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={trackingSaving || transferring || deleting}
              >
                <RiCloseLine className="size-4" />
                <span>{messages.teamSelect.cancel}</span>
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={trackingSaving || transferring || deleting}
                onClick={(event) => {
                  event.preventDefault();
                  void handleDelete();
                }}
              >
                <AutoTransition className="inline-flex items-center gap-2">
                  {deleting ? (
                    <span
                      key="deleting-dialog"
                      className="inline-flex items-center gap-2"
                    >
                      <Spinner className="size-4" />
                      {copy.deleting}
                    </span>
                  ) : (
                    <span
                      key="confirm-delete"
                      className="inline-flex items-center gap-2"
                    >
                      <RiDeleteBinLine className="size-4" />
                      {copy.delete}
                    </span>
                  )}
                </AutoTransition>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SettingsSection>
    </div>
  );
}
