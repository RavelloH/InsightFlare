import type { PaginatedCollection } from "./pagination";

export interface DimensionData {
  ok: boolean;
  data: Array<{
    value: string;
    label: string;
    views: number;
    sessions: number;
    visitors?: number;
  }>;
}

export interface DashboardFilterOption {
  value: string;
  label: string;
  occurrences?: number;
  group?: "country" | "region" | "city";
}

export interface DashboardFilterOptionsData {
  ok: boolean;
  data: PaginatedCollection<DashboardFilterOption>;
}
