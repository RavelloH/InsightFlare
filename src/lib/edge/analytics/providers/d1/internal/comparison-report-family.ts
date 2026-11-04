import { normalizeComparisonReportFamily } from "@/lib/edge/analytics/engine/comparison-page-tabs";
import type { ComparisonReportFamily } from "@/lib/edge/analytics/engine/comparison-report-plan";

const PAGE_CURSOR_EXPRESSIONS: Readonly<Record<string, string>> = {
  "page.path": "TRIM(COALESCE(pathname, ''))",
  "page.query": "TRIM(COALESCE(query_string, ''))",
  "page.title": "TRIM(COALESCE(title, ''))",
  "page.hostname": "TRIM(COALESCE(hostname, ''))",
  "geo.timezone": "TRIM(COALESCE(timezone, ''))",
  "geo.organization": "TRIM(COALESCE(as_organization, ''))",
};

export function comparisonReportFamilyForTab(tab: string):
  | {
      readonly family: ComparisonReportFamily;
      readonly cursorExpression: string;
    }
  | undefined {
  const family = normalizeComparisonReportFamily(tab);
  if (!family) return undefined;
  if (family.kind === "session-boundary")
    return {
      family,
      cursorExpression: `session.${family.pathKind}`,
    };
  const cursorExpression = PAGE_CURSOR_EXPRESSIONS[tab];
  return cursorExpression
    ? {
        family,
        cursorExpression,
      }
    : undefined;
}

export function comparisonSessionPathCursorExpression(
  kind: "entry" | "exit",
): string {
  return `session.${kind}`;
}
