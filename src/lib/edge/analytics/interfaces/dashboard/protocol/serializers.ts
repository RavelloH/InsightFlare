interface DimensionValueRow {
  readonly value: string;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}

interface PageValueRow {
  readonly pathname: string;
  readonly query: string;
  readonly hash: string;
  readonly views: number;
  readonly sessions: number;
}

interface ReferrerValueRow {
  readonly referrer: string;
  readonly views: number;
  readonly sessions: number;
}

export function mapPages(rows: readonly PageValueRow[]) {
  return rows.map((row) => ({
    pathname: row.pathname,
    query: row.query,
    hash: row.hash,
    views: row.views,
    sessions: row.sessions,
  }));
}

export function mapTabs(rows: readonly DimensionValueRow[] | null | undefined) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    label: row.value,
    views: row.views,
    sessions: row.sessions,
    visitors: row.visitors,
  }));
}

export function mapReferrers(rows: readonly ReferrerValueRow[]) {
  return rows.map((row) => ({
    referrer: row.referrer,
    views: row.views,
    sessions: row.sessions,
  }));
}
