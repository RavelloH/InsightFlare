import type { UtmDimensionTab } from "@/lib/dashboard/client-data";
import type { DimensionRow } from "@/lib/edge-client";

export type CampaignTab = UtmDimensionTab;

export interface CampaignBreakdownRow {
  key: string;
  value: string;
  label: string;
  views: number;
  sessions: number;
  mono?: boolean;
}

export type CampaignRawRowsByTab = Record<CampaignTab, DimensionRow[]>;
export type CampaignRowsByTab = Record<CampaignTab, CampaignBreakdownRow[]>;

export const CAMPAIGN_TABS = [
  "source",
  "medium",
  "campaign",
  "term",
  "content",
] as const satisfies CampaignTab[];

export function buildCampaignRows(
  rows: CampaignRawRowsByTab[CampaignTab],
  tab: CampaignTab,
  notSetLabel: string,
): CampaignBreakdownRow[] {
  const safeRows = Array.isArray(rows) ? rows : [];

  return safeRows.map((row, index) => {
    const value = normalizeDimensionValue(row.value ?? row.label);
    return {
      key: value || createEmptyKey(tab, index),
      value,
      label: value || notSetLabel,
      views: Math.max(0, Number(row.views ?? 0)),
      sessions: Math.max(0, Number(row.sessions ?? 0)),
      mono: tab === "term" || tab === "content",
    };
  });
}

function normalizeDimensionValue(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function createEmptyKey(tab: CampaignTab, index: number): string {
  return `__empty__:${tab}:${index}`;
}

export function buildCampaignRowsByTab(
  rowsByTab: CampaignRawRowsByTab,
  notSetLabel: string,
): CampaignRowsByTab {
  const next = {} as CampaignRowsByTab;

  for (const tab of CAMPAIGN_TABS) {
    next[tab] = buildCampaignRows(rowsByTab[tab], tab, notSetLabel);
  }

  return next;
}
