import type { PaginatedCollection } from "./pagination";

export interface DimensionRow {
  value: string;
  label: string;
  views: number;
  sessions: number;
  visitors?: number;
}

export interface DimensionData {
  ok: boolean;
  data: PaginatedCollection<DimensionRow>;
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
