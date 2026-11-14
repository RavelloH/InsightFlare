// Deterministic sample data shared by every showcase fixture. One fictional
// developer-tools site (docs + blog) so totals agree across views: the same
// daily series feeds the overview metrics, the traffic chart, and the events.
// No clocks and no Math.random: every value is derived from fixed seeds.

export const SHOWCASE_START_MS = Date.UTC(2026, 6, 1);
export const SHOWCASE_DAY_MS = 24 * 60 * 60 * 1000;
export const SHOWCASE_DAYS = 30;
/** Day index (Mon, Jul 13) of the simulated launch that spikes traffic. */
export const SHOWCASE_LAUNCH_DAY = 12;

export function createShowcaseRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function poisson(rng: () => number, lambda: number): number {
  if (lambda > 30) {
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian(rng)));
  }
  const limit = Math.exp(-lambda);
  let count = 0;
  let product = 1;
  do {
    count += 1;
    product *= rng();
  } while (product > limit);
  return count - 1;
}

function dayOfWeek(timestampMs: number): number {
  // 1970-01-01 was a Thursday; 0 = Sunday.
  return (Math.floor(timestampMs / SHOWCASE_DAY_MS) + 4) % 7;
}

const WEEKDAY_FACTOR = [0.56, 1, 1.06, 1.08, 1.03, 0.9, 0.5] as const;
const LAUNCH_CURVE = [2.3, 1.65, 1.35, 1.18, 1.08, 1.03] as const;

export interface ShowcaseDay {
  readonly timestampMs: number;
  readonly visitors: number;
  readonly sessions: number;
  readonly views: number;
  readonly bounceRate: number;
  readonly avgDurationMs: number;
  /** 1 on ordinary days; above 1 during the launch spike. */
  readonly boost: number;
}

function generateDays(options: {
  seed: number;
  startMs: number;
  baseVisitors: number;
  growth: number;
  launch: boolean;
  weekendStrength?: number;
}): ShowcaseDay[] {
  const rng = createShowcaseRng(options.seed);
  const weekendStrength = options.weekendStrength ?? 1;
  return Array.from({ length: SHOWCASE_DAYS }, (_, index) => {
    const timestampMs = options.startMs + index * SHOWCASE_DAY_MS;
    const dow = dayOfWeek(timestampMs);
    const weekend = dow === 0 || dow === 6;
    const weekday = WEEKDAY_FACTOR[dow] ?? 1;
    const boost = options.launch
      ? (LAUNCH_CURVE[index - SHOWCASE_LAUNCH_DAY] ?? 1)
      : 1;
    const calm = weekend ? 1 - (1 - weekday) * weekendStrength : weekday;
    const level =
      options.baseVisitors * calm * (1 + options.growth * index) * boost;
    const visitors = Math.round(level * Math.exp(gaussian(rng) * 0.07));
    const sessions = Math.round(visitors * (1.22 + rng() * 0.07));
    const pagesPerSession =
      (weekend ? 2.05 : 2.35) + (boost > 1.3 ? 0.25 : 0) + (rng() - 0.5) * 0.22;
    const views = Math.round(sessions * pagesPerSession);
    const bounceRate =
      0.47 +
      (weekend ? 0.03 : 0) +
      (boost > 1.3 ? 0.05 : 0) +
      (rng() - 0.5) * 0.03;
    const avgDurationMs = Math.round(
      124_000 +
        (weekend ? 14_000 : 0) -
        (boost > 1.3 ? 11_000 : 0) +
        (rng() - 0.5) * 16_000,
    );
    return {
      timestampMs,
      visitors,
      sessions,
      views,
      bounceRate,
      avgDurationMs,
      boost,
    };
  });
}

/** Thirty days ending Jul 30, including the launch spike on Jul 13. */
export const currentDays = generateDays({
  seed: 20260701,
  startMs: SHOWCASE_START_MS,
  baseVisitors: 1480,
  growth: 0.0045,
  launch: true,
});

/** The thirty days before, used for period comparison. */
export const previousDays = generateDays({
  seed: 20260601,
  startMs: SHOWCASE_START_MS - SHOWCASE_DAYS * SHOWCASE_DAY_MS,
  baseVisitors: 1480 * 0.97,
  growth: 0.003,
  launch: false,
});

export interface ShowcaseTotals {
  readonly views: number;
  readonly sessions: number;
  /** Unique visitors in the window; below the sum of daily visitors. */
  readonly visitors: number;
  readonly bounceRate: number;
  readonly avgDurationMs: number;
  readonly pagesPerSession: number;
}

export function summarizeDays(days: readonly ShowcaseDay[]): ShowcaseTotals {
  const sum = (pick: (day: ShowcaseDay) => number) =>
    days.reduce((total, day) => total + pick(day), 0);
  const sessions = sum((day) => day.sessions);
  const views = sum((day) => day.views);
  return {
    views,
    sessions,
    visitors: Math.round(sum((day) => day.visitors) * 0.7),
    bounceRate: sum((day) => day.bounceRate * day.sessions) / sessions,
    avgDurationMs: sum((day) => day.avgDurationMs * day.sessions) / sessions,
    pagesPerSession: views / sessions,
  };
}

export const currentTotals = summarizeDays(currentDays);
export const previousTotals = summarizeDays(previousDays);

/** Percentage change, or null when the base is empty. */
export function percentChange(
  current: number,
  previous: number,
): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Splits `total` into integer parts proportional to `weights` (sums exactly). */
export function splitTotal(
  total: number,
  weights: readonly number[],
): number[] {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const raw = weights.map((weight) => (total * weight) / weightSum);
  const floors = raw.map((value) => Math.floor(value));
  let remainder = total - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction);
  for (const { index } of order) {
    if (remainder <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}

export const SHOWCASE_TEAM_SITES = [
  { id: "site-docs", name: "Docs" },
  { id: "site-blog", name: "Blog" },
  { id: "site-app", name: "App" },
  { id: "site-status", name: "Status" },
] as const;

const teamSiteDays = [
  currentDays,
  generateDays({
    seed: 4417,
    startMs: SHOWCASE_START_MS,
    baseVisitors: 640,
    growth: 0.006,
    launch: true,
  }),
  generateDays({
    seed: 9021,
    startMs: SHOWCASE_START_MS,
    baseVisitors: 390,
    growth: 0.004,
    launch: false,
    weekendStrength: 1.5,
  }),
  generateDays({
    seed: 6188,
    startMs: SHOWCASE_START_MS,
    baseVisitors: 120,
    growth: 0.001,
    launch: false,
  }),
] as const;

/** Per-day traffic for every site in the team, ready for the stack chart. */
export const teamTraffic = Array.from(
  { length: SHOWCASE_DAYS },
  (_, index) => ({
    timestampMs: SHOWCASE_START_MS + index * SHOWCASE_DAY_MS,
    sites: SHOWCASE_TEAM_SITES.map((site, siteIndex) => {
      const day = teamSiteDays[siteIndex]?.[index];
      return {
        siteId: site.id,
        visitors: day?.visitors ?? 0,
        views: day?.views ?? 0,
      };
    }),
  }),
);

export interface ShowcaseEventType {
  readonly key: string;
  readonly label: string;
  /** Share of daily visitors that trigger the event, on an ordinary day. */
  readonly rate: number;
  /** How strongly the launch spike lifts it (1 = same as traffic). */
  readonly launchLift: number;
  readonly sessionRatio: number;
  readonly visitorRatio: number;
}

export const SHOWCASE_EVENT_TYPES: readonly ShowcaseEventType[] = [
  {
    key: "search",
    label: "search",
    rate: 0.23,
    launchLift: 1,
    sessionRatio: 0.71,
    visitorRatio: 0.58,
  },
  {
    key: "copy_cmd",
    label: "copy_cmd",
    rate: 0.092,
    launchLift: 1.15,
    sessionRatio: 0.82,
    visitorRatio: 0.74,
  },
  {
    key: "deploy",
    label: "deploy",
    rate: 0.034,
    launchLift: 1.45,
    sessionRatio: 0.91,
    visitorRatio: 0.83,
  },
  {
    key: "signup",
    label: "signup",
    rate: 0.019,
    launchLift: 1.3,
    sessionRatio: 0.93,
    visitorRatio: 0.88,
  },
];

/** Events per day split by type, plus an "other" remainder. */
export function eventDays(days: readonly ShowcaseDay[], seed: number) {
  const rng = createShowcaseRng(seed);
  return days.map((day) => {
    const eventsBySeries: Record<string, number> = {};
    let total = 0;
    for (const type of SHOWCASE_EVENT_TYPES) {
      const lift = day.boost > 1 ? day.boost ** (type.launchLift - 1) : 1;
      const value = Math.max(
        0,
        Math.round(
          day.visitors * type.rate * lift * Math.exp(gaussian(rng) * 0.09),
        ),
      );
      eventsBySeries[type.key] = value;
      total += value;
    }
    const other = Math.round(
      day.visitors * 0.047 * Math.exp(gaussian(rng) * 0.1),
    );
    eventsBySeries.__other = other;
    total += other;
    return {
      timestampMs: day.timestampMs,
      totalEvents: total,
      eventsBySeries,
    };
  });
}

export const SHOWCASE_COUNTRIES = [
  { code: "US", label: "United States", weight: 27 },
  { code: "DE", label: "Germany", weight: 9 },
  { code: "GB", label: "United Kingdom", weight: 8 },
  { code: "IN", label: "India", weight: 8 },
  { code: "JP", label: "Japan", weight: 6.5 },
  { code: "FR", label: "France", weight: 5 },
  { code: "CA", label: "Canada", weight: 4.5 },
  { code: "BR", label: "Brazil", weight: 4 },
  { code: "NL", label: "Netherlands", weight: 3.2 },
  { code: "CN", label: "China", weight: 3 },
  { code: "AU", label: "Australia", weight: 2.6 },
  { code: "SE", label: "Sweden", weight: 2 },
] as const;

export const SHOWCASE_SOURCES = [
  { key: "search", label: "Search", weight: 41 },
  { key: "direct", label: "Direct", weight: 23.5 },
  { key: "github", label: "github.com", weight: 12 },
  { key: "hackernews", label: "news.ycombinator.com", weight: 6.5 },
  { key: "reddit", label: "reddit.com", weight: 4.2 },
  { key: "x", label: "x.com", weight: 3.4 },
  { key: "newsletter", label: "Newsletter", weight: 2.6 },
  { key: "other", label: "Other", weight: 6.8 },
] as const;

/** The fictional site every showcase view, demo, and agent answer belongs to. */
export const SHOWCASE_SITE = { id: "site_8f3a", name: "edgekit.dev" } as const;

// Share of unique visitors per class, current and previous window.
export const SHOWCASE_BROWSER_WEIGHTS = {
  chrome: 63.8,
  safari: 19.1,
  edge: 7.2,
  firefox: 4.6,
  samsung: 2.3,
  other: 3,
};
export const SHOWCASE_BROWSER_WEIGHTS_PREVIOUS = {
  chrome: 62.1,
  safari: 19.8,
  edge: 6.4,
  firefox: 5.4,
  samsung: 2.1,
  other: 4.2,
};
export const SHOWCASE_ENGINE_WEIGHTS = {
  blink: 73.3,
  webkit: 19.1,
  gecko: 4.6,
  other: 3,
};
export const SHOWCASE_ENGINE_WEIGHTS_PREVIOUS = {
  blink: 70.6,
  webkit: 19.8,
  gecko: 5.4,
  other: 4.2,
};
export const SHOWCASE_DEVICE_WEIGHTS = {
  desktop: 57.8,
  mobile: 39,
  tablet: 3.2,
};
export const SHOWCASE_DEVICE_WEIGHTS_PREVIOUS = {
  desktop: 59.6,
  mobile: 37.4,
  tablet: 3,
};
export const SHOWCASE_OS_WEIGHTS = {
  windows: 36.5,
  ios: 22.4,
  android: 17.3,
  macos: 14.2,
  linux: 7.1,
  other: 2.5,
};
export const SHOWCASE_OS_WEIGHTS_PREVIOUS = {
  windows: 37.8,
  ios: 21.1,
  android: 16.4,
  macos: 14.5,
  linux: 7.7,
  other: 2.5,
};
