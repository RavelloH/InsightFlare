import { DEFAULT_SITE_ID } from "./constants";

export interface DashboardRangeParams {
  siteId: string;
  from: number;
  to: number;
}

export function parseDashboardRange(searchParams: Record<string, string | string[] | undefined>): DashboardRangeParams {
  const now = Date.now();
  const defaultFrom = now - 7 * 24 * 60 * 60 * 1000;

  const siteIdInput = searchParams.siteId;
  const fromInput = searchParams.from;
  const toInput = searchParams.to;

  const siteId =
    typeof siteIdInput === "string" && siteIdInput.trim().length > 0
      ? siteIdInput.trim()
      : process.env.INSIGHTFLARE_DEFAULT_SITE_ID || DEFAULT_SITE_ID;

  const from =
    typeof fromInput === "string" && Number.isFinite(Number(fromInput))
      ? Math.floor(Number(fromInput))
      : defaultFrom;
  const to =
    typeof toInput === "string" && Number.isFinite(Number(toInput))
      ? Math.floor(Number(toInput))
      : now;

  return {
    siteId,
    from: Math.min(from, to),
    to: Math.max(from, to),
  };
}

