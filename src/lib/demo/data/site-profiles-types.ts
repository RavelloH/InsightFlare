export interface DemoSiteHourProfile {
  /** UTC hour when traffic begins rising (0–23). May cause midnight wrap if riseHour + activeWidth > 24. */
  riseHour: number;
  /** Duration in hours of the active (sine) window */
  activeWidth: number;
  /** Baseline traffic level outside the active window (0–1). Higher = flatter curve. */
  baseLevel: number;
}

export interface DemoSiteProfile {
  id: string;
  teamId: string;
  name: string;
  domain: string;
  iconPath: string;
  dailyPvRange: [number, number];
  bounceRateRange: [number, number];
  avgDurationMsRange: [number, number];
  topCountries: Array<{ code: string; weight: number }>;
  topReferrers: Array<{ name: string; weight: number }>;
  paths: string[];
  titles: string[];
  deviceWeights: { Desktop: number; Mobile: number; Tablet: number };
  weekendFactor: number;
  eventNames: string[];
  hourProfile: DemoSiteHourProfile;
  /**
   * Share of a visit window's visitors drawn from the "returning" head of the
   * site's visitor universe (0–1). High = sticky audience (forum / SaaS),
   * low = drive-by traffic (marketing page / portfolio). Defaults to 0.25.
   */
  visitorReturnRate?: number;
  /**
   * Optional override for the path Markov transition graph. When omitted the
   * graph is derived from `paths` order — first path is the entry node, each
   * subsequent path carries a slightly lower forward weight.
   */
  pathFlow?: Record<string, Array<{ to: string; weight: number }>>;
}
