import type { ComponentType } from "react";
import {
  RiBarChartBoxLine,
  RiCodeLine,
  RiGlobalLine,
  RiLinksLine,
  RiRouteLine,
  RiSettings3Line,
} from "@remixicon/react";

import {
  BLOCKING_FIELD_IDS,
  type BlockingFieldId,
  type BlockingRequestContext,
  type BlockingRuleSyntaxError,
  parseBlockingRules,
} from "@/lib/blocking";
import type { SiteSettingsInitialData } from "@/lib/dashboard/management-data";
import {
  type AdminServiceHttpMethod,
  requestAdminService,
} from "@/lib/dashboard-api/client/admin-service";
import type { SiteData } from "@/lib/dashboard-api/client/edge";
import type { AdminServiceRoute } from "@/lib/dashboard-api/contract/admin-service";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
export interface SiteSettingsClientPageProps {
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
export function resolveSiteSlug(
  site: Pick<SiteData, "id" | "name" | "domain" | "publicSlug">,
): string {
  const candidate = safeSlug(String(site.domain || "").trim());
  if (candidate.length > 0) return candidate;
  return site.id.slice(0, 8);
}
export function randomPublicSlug(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const values = new Uint8Array(8);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join(
    "",
  );
}
export function formatSampleRateValue(value: number): string {
  const formatted = Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${formatted}%`;
}
export async function postJson<T>(
  route: AdminServiceRoute,
  body: Record<string, unknown>,
  method: AdminServiceHttpMethod = "POST",
): Promise<T> {
  return requestAdminService<T>(route, { method, body });
}
export type BlockingEditorValues = Record<BlockingFieldId, string>;
export interface BlockingRuleFieldCopy {
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
export interface BlockingRuleDialogCopy {
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
export const BLOCKING_RULE_FIELD_DEFINITIONS: ReadonlyArray<{
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
export function blockingEditorValues(input: unknown): BlockingEditorValues {
  const parsed = parseBlockingRules(input);
  return Object.fromEntries(
    BLOCKING_FIELD_IDS.map((field) => [
      field,
      parsed.fields[field].lines.join("\n"),
    ]),
  ) as BlockingEditorValues;
}
export function blockingEditorLines(value: string): string[] {
  return value.length === 0 ? [] : value.split(/\r?\n/u);
}
export function blockingRuleErrorMessage(
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
export function blockingTestContext(
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
