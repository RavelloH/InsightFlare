import type { RealtimeEvent } from "@/lib/realtime/types";

// ---------------------------------------------------------------------------
//  Realtime mock socket (existing)
// ---------------------------------------------------------------------------

type RealtimeSocketMessage =
  | {
      type: "snapshot";
      data: {
        activeNow: number;
        events: RealtimeEvent[];
      };
    }
  | {
      type: "event";
      data: RealtimeEvent;
    };

export type RealtimeSocketLike = Pick<
  WebSocket,
  "readyState" | "onopen" | "onmessage" | "onerror" | "onclose" | "close"
>;

interface MockRealtimeSocketOptions {
  siteId: string;
  activeWindowMs?: number;
}

const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class MockRealtimeSocket implements RealtimeSocketLike {
  readyState: WebSocket["readyState"] = READY_STATE.CONNECTING;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;

  private readonly activeWindowMs: number;
  private readonly siteId: string;
  private readonly visitors = new Map<string, number>();
  private recentEvents: RealtimeEvent[] = [];
  private sequence = 0;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;

  constructor({ siteId, activeWindowMs = 5 * 60 * 1000 }: MockRealtimeSocketOptions) {
    this.siteId = siteId;
    this.activeWindowMs = activeWindowMs;
    this.seedSnapshot();
    this.beginHandshake();
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === READY_STATE.CLOSED) return;
    this.readyState = READY_STATE.CLOSING;
    this.clearTimers();
    this.readyState = READY_STATE.CLOSED;
    this.emitClose(code ?? 1000, reason ?? "mock closed", (code ?? 1000) === 1000);
  }

  private beginHandshake(): void {
    const handshakeDelayMs = randomInt(120, 780);
    const shouldFailHandshake = Math.random() < 0.2;
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.readyState !== READY_STATE.CONNECTING) return;
      if (shouldFailHandshake) {
        this.emitError();
        return;
      }

      this.readyState = READY_STATE.OPEN;
      this.emitOpen();
      this.emitSnapshot();
      this.startEventStream();
      this.scheduleDisconnect();
    }, handshakeDelayMs);
  }

  private startEventStream(): void {
    this.eventTimer = setInterval(() => {
      if (this.readyState !== READY_STATE.OPEN) return;
      const burst = randomInt(1, 3);
      const now = Date.now();
      for (let i = 0; i < burst; i += 1) {
        const event = this.generateEvent(now);
        this.emitMessage({
          type: "event",
          data: event,
        });
      }

      if (Math.random() < 0.08) {
        this.emitSnapshot();
      }
    }, 850);
  }

  private scheduleDisconnect(): void {
    const disconnectAfterMs = randomInt(18_000, 32_000);
    this.dropTimer = setTimeout(() => {
      this.dropTimer = null;
      if (this.readyState !== READY_STATE.OPEN) return;
      this.emitError();
    }, disconnectAfterMs);
  }

  private emitOpen(): void {
    this.onopen?.call(
      this as unknown as WebSocket,
      new Event("open"),
    );
  }

  private emitMessage(payload: RealtimeSocketMessage): void {
    this.onmessage?.call(
      this as unknown as WebSocket,
      new MessageEvent("message", {
        data: JSON.stringify(payload),
      }),
    );
  }

  private emitError(): void {
    this.onerror?.call(
      this as unknown as WebSocket,
      new Event("error"),
    );
  }

  private emitClose(code: number, reason: string, wasClean: boolean): void {
    this.onclose?.call(
      this as unknown as WebSocket,
      new CloseEvent("close", {
        code,
        reason,
        wasClean,
      }),
    );
  }

  private emitSnapshot(): void {
    if (this.readyState !== READY_STATE.OPEN) return;
    const now = Date.now();
    this.prune(now);
    // Derive activeNow from the integration-based traffic rate
    const windowViews = integrateViews(this.siteId, now - this.activeWindowMs, now);
    const r = siteRatios(this.siteId);
    const baseActive = Math.round(windowViews * r.sessionsPerView * r.visitorsPerSession);
    const activeNow = Math.max(0, baseActive + randomInt(-2, 3));
    const events = this.recentEvents.slice(-160);
    this.emitMessage({
      type: "snapshot",
      data: { activeNow, events },
    });
  }

  private seedSnapshot(): void {
    const now = Date.now();
    const windowViews = integrateViews(this.siteId, now - this.activeWindowMs, now);
    const r = siteRatios(this.siteId);
    const expectedVisitors = Math.max(5, Math.round(windowViews * r.sessionsPerView * r.visitorsPerSession));
    const initialCount = Math.min(160, Math.max(10, expectedVisitors + randomInt(-3, 5)));
    for (let i = 0; i < initialCount; i += 1) {
      const event = this.buildEvent({
        visitorId: this.nextVisitorId(),
        eventAt: now - randomInt(0, Math.max(1, this.activeWindowMs - 1000)),
      });
      this.trackEvent(event);
    }
    this.prune(now);
  }

  private generateEvent(now: number): RealtimeEvent {
    const useExisting = this.visitors.size > 0 && Math.random() < 0.72;
    let visitorId = this.nextVisitorId();
    if (useExisting) {
      const ids = Array.from(this.visitors.keys());
      visitorId = ids[randomInt(0, ids.length - 1)];
    }

    const event = this.buildEvent({
      visitorId,
      eventAt: now,
    });
    this.trackEvent(event);
    this.prune(now);
    return event;
  }

  private trackEvent(event: RealtimeEvent): void {
    this.visitors.set(event.visitorId, event.eventAt);
    this.recentEvents.push(event);
  }

  private prune(now: number): void {
    const cutoff = now - this.activeWindowMs;

    this.recentEvents = this.recentEvents.filter((item) => item.eventAt >= cutoff);
    for (const [visitorId, eventAt] of this.visitors.entries()) {
      if (eventAt < cutoff) {
        this.visitors.delete(visitorId);
      }
    }
  }

  private nextVisitorId(): string {
    const suffix = this.sequence.toString(36);
    this.sequence += 1;
    return `${this.siteId}-visitor-${suffix}`;
  }

  private nextEventId(): string {
    const suffix = this.sequence.toString(36);
    this.sequence += 1;
    return `${this.siteId}-event-${suffix}`;
  }

  private buildEvent(input: {
    visitorId: string;
    eventAt: number;
  }): RealtimeEvent {
    const profile = findSiteProfile(this.siteId);
    const eventTypes = ["pageview", ...profile.eventNames.slice(0, 4)];
    const paths = profile.paths;

    return {
      id: this.nextEventId(),
      eventType: eventTypes[randomInt(0, eventTypes.length - 1)],
      eventAt: input.eventAt,
      pathname: paths[randomInt(0, paths.length - 1)],
      visitorId: input.visitorId,
      country: weightedPickCountry(Math.random, profile.topCountries),
      browser: weightedPickLabel(Math.random, BROWSER_MARKET_WEIGHTS, "Chrome"),
    };
  }

  private clearTimers(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.eventTimer) {
      clearInterval(this.eventTimer);
      this.eventTimer = null;
    }
    if (this.dropTimer) {
      clearTimeout(this.dropTimer);
      this.dropTimer = null;
    }
  }
}

export function createMockRealtimeSocket(
  options: MockRealtimeSocketOptions,
): RealtimeSocketLike {
  return new MockRealtimeSocket(options);
}

// ---------------------------------------------------------------------------
//  Demo mode — seeded PRNG & data generators
// ---------------------------------------------------------------------------

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function createDemoRng(siteId: string, endpoint: string): () => number {
  return mulberry32(fnv1a(`${todayKey()}:${siteId}:${endpoint}`));
}

// Seeded helpers that use a provided rng
function sInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function sFloat(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function sPick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function sShuffle<T>(rng: () => number, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Generate weighted distribution values (Zipf-like), returns array summing to ~total
function weightedDistribution(
  rng: () => number,
  labels: readonly string[],
  total: number,
  count: number,
): Array<{ label: string; views: number; sessions: number }> {
  const n = Math.min(count, labels.length);
  const picked = sShuffle(rng, [...labels]).slice(0, n);
  const weights: number[] = [];
  let wSum = 0;
  for (let i = 0; i < n; i++) {
    const w = 1 / (i + 1 + rng() * 0.5);
    weights.push(w);
    wSum += w;
  }
  return picked.map((label, i) => {
    const views = Math.max(1, Math.round((weights[i] / wSum) * total * (0.85 + rng() * 0.3)));
    const sessions = Math.max(1, Math.round(views * (0.55 + rng() * 0.35)));
    return { label, views, sessions };
  });
}

function weightedPickLabel(
  rng: () => number,
  entries: Array<{ label: string; weight: number }>,
  fallback: string,
): string {
  const normalized = entries
    .map((item) => ({
      label: String(item.label || "").trim(),
      weight: Math.max(0, Number(item.weight) || 0),
    }))
    .filter((item) => item.label.length > 0 && item.weight > 0);
  if (normalized.length === 0) return fallback;
  const totalWeight = normalized.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return fallback;
  let hit = rng() * totalWeight;
  for (const item of normalized) {
    hit -= item.weight;
    if (hit <= 0) return item.label;
  }
  return normalized[normalized.length - 1]?.label || fallback;
}

function weightedDistributionFromWeights(
  rng: () => number,
  entries: Array<{ label: string; weight: number }>,
  total: number,
  count: number,
  sessionRatioRange: [number, number] = [0.52, 0.86],
): Array<{ label: string; views: number; sessions: number }> {
  const merged = new Map<string, number>();
  for (const entry of entries) {
    const label = String(entry.label || "").trim();
    const weight = Math.max(0, Number(entry.weight) || 0);
    if (!label || weight <= 0) continue;
    merged.set(label, (merged.get(label) ?? 0) + weight);
  }
  const normalized = Array.from(merged.entries())
    .map(([label, weight]) => ({ label, weight }))
    .sort((left, right) => right.weight - left.weight);
  const n = Math.min(count, normalized.length);
  if (n <= 0) return [];
  const picked = normalized.slice(0, n);
  const weightSum = picked.reduce((sum, item) => sum + item.weight, 0);
  const sessionMin = Math.min(sessionRatioRange[0], sessionRatioRange[1]);
  const sessionMax = Math.max(sessionRatioRange[0], sessionRatioRange[1]);
  return picked.map((item) => {
    const ratio = item.weight / Math.max(weightSum, Number.EPSILON);
    const variance = 0.92 + rng() * 0.16;
    const views = Math.max(1, Math.round(total * ratio * variance));
    const sessionRatio = sessionMin + rng() * (sessionMax - sessionMin);
    const sessions = Math.max(1, Math.min(views, Math.round(views * sessionRatio)));
    return {
      label: item.label,
      views,
      sessions,
    };
  });
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizePath(pathname: string): string {
  const normalized = String(pathname || "")
    .trim()
    .replace(/\/{2,}/g, "/");
  if (!normalized.startsWith("/")) return "";
  if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
  return normalized || "/";
}

function humanizeSlug(slug: string): string {
  const cleaned = slug
    .replace(/[_-]+/g, " ")
    .replace(/\b(v\d+)\b/gi, "")
    .trim();
  if (!cleaned) return "Page";
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function titleFromPath(pathname: string): string {
  if (pathname === "/") return "Home";
  const segments = pathname.split("/").filter(Boolean);
  const meaningful = segments[segments.length - 1] ?? segments[0] ?? "page";
  return humanizeSlug(meaningful);
}

function expandPathLabels(
  rng: () => number,
  basePaths: readonly string[],
  desiredCount: number,
): string[] {
  const normalizedBase = uniqueNonEmptyStrings(
    basePaths.map((path) => normalizePath(path)).filter((path) => path.length > 0),
  );
  const nonRootBase = normalizedBase.filter((path) => path !== "/");
  const sourcePaths = nonRootBase.length > 0 ? nonRootBase : ["/home"];

  const seen = new Set<string>();
  const output: string[] = [];
  const addPath = (candidate: string) => {
    const normalized = normalizePath(candidate);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    output.push(normalized);
  };

  for (const path of normalizedBase) addPath(path);

  const genericPool = [
    "/pricing/enterprise",
    "/pricing/startup",
    "/integrations",
    "/docs",
    "/docs/getting-started",
    "/docs/api",
    "/docs/changelog",
    "/blog",
    "/blog/2026-product-roadmap",
    "/blog/customer-story",
    "/resources",
    "/resources/templates",
    "/support",
    "/support/contact",
    "/status",
    "/security",
    "/about/company",
    "/careers/open-roles",
  ];

  const languagePrefixes = ["/en", "/de", "/fr", "/ja", "/zh", "/pt-br", "/es", "/it"];
  const contentSuffixes = [
    "overview",
    "pricing",
    "faq",
    "compare",
    "case-study",
    "guide",
    "integration",
    "checklist",
    "playbook",
    "release-notes",
    "benchmarks",
    "examples",
  ];

  for (const base of sourcePaths) {
    if (output.length >= desiredCount) break;
    const stem = base.replace(/\/+$/, "");
    const candidates = [
      `${stem}/overview`,
      `${stem}/faq`,
      `${stem}/pricing`,
      `${stem}/compare`,
      `${stem}/case-study`,
      `${stem}/guide`,
    ];
    if (stem.includes("/blog") || stem.includes("/posts") || stem.includes("/article")) {
      candidates.push(`${stem}/weekly-roundup`, `${stem}/2026-trends`, `${stem}/editor-note`);
    }
    if (stem.includes("/docs") || stem.includes("/guides") || stem.includes("/sdk") || stem.includes("/api")) {
      candidates.push(`${stem}/quickstart`, `${stem}/examples`, `${stem}/troubleshooting`);
    }
    if (stem.includes("/products") || stem.includes("/collections") || stem.includes("/courses")) {
      candidates.push(`${stem}/reviews`, `${stem}/specs`, `${stem}/compatibility`);
    }
    for (const variant of sShuffle(rng, candidates)) {
      addPath(variant);
      if (output.length >= desiredCount) break;
    }
  }

  for (const path of sShuffle(rng, genericPool)) {
    addPath(path);
    if (output.length >= desiredCount) break;
  }

  let attempts = 0;
  while (output.length < desiredCount && attempts < desiredCount * 20) {
    attempts += 1;
    const base = sPick(rng, sourcePaths).replace(/\/+$/, "");
    const langPrefix = sPick(rng, languagePrefixes);
    const contentSuffix = sPick(rng, contentSuffixes);
    const tail = base.split("/").filter(Boolean).pop() ?? "page";
    const candidateType = sInt(rng, 0, 6);
    let candidate = base;
    if (candidateType === 0) candidate = `${base}/${contentSuffix}`;
    else if (candidateType === 1) candidate = `${base}/${tail}-${contentSuffix}`;
    else if (candidateType === 2) candidate = `${langPrefix}${base}`;
    else if (candidateType === 3) candidate = `${langPrefix}${base}/${contentSuffix}`;
    else if (candidateType === 4) candidate = `${base}-${sInt(rng, 2, 4)}`;
    else if (candidateType === 5) candidate = `${base}/${sInt(rng, 2024, 2026)}/${contentSuffix}`;
    else candidate = `${base}/${contentSuffix}/${sInt(rng, 1, 12)}`;
    addPath(candidate);
  }

  return output.slice(0, Math.max(1, desiredCount));
}

// ---------------------------------------------------------------------------
//  Demo site profiles
// ---------------------------------------------------------------------------

interface DemoSiteHourProfile {
  /** UTC hour when traffic begins rising (0–23). May cause midnight wrap if riseHour + activeWidth > 24. */
  riseHour: number;
  /** Duration in hours of the active (sine) window */
  activeWidth: number;
  /** Baseline traffic level outside the active window (0–1). Higher = flatter curve. */
  baseLevel: number;
}

interface DemoSiteProfile {
  id: string;
  teamId: string;
  name: string;
  domain: string;
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
}

const DEMO_TEAMS = [
  { id: "demo-team-001", name: "XEOOS Team", slug: "xeoos-team", ownerUserId: "demo-user-001" },
] as const;

const DEMO_SITE_PROFILES: DemoSiteProfile[] = [
  {
    id: "demo-site-001", teamId: "demo-team-001",
    name: "Corporate Website", domain: "acme-corp.com",
    dailyPvRange: [8200, 14500], bounceRateRange: [0.38, 0.52], avgDurationMsRange: [45000, 95000],
    topCountries: [
      { code: "US", weight: 0.35 }, { code: "GB", weight: 0.15 }, { code: "DE", weight: 0.12 },
      { code: "CA", weight: 0.10 }, { code: "AU", weight: 0.08 }, { code: "FR", weight: 0.06 },
      { code: "JP", weight: 0.04 }, { code: "IN", weight: 0.03 }, { code: "BR", weight: 0.03 },
      { code: "NL", weight: 0.02 }, { code: "SG", weight: 0.02 },
    ],
    topReferrers: [
      { name: "google.com", weight: 0.40 }, { name: "(direct)", weight: 0.25 },
      { name: "linkedin.com", weight: 0.12 }, { name: "twitter.com", weight: 0.08 },
      { name: "bing.com", weight: 0.05 }, { name: "facebook.com", weight: 0.04 },
      { name: "baidu.com", weight: 0.03 }, { name: "reddit.com", weight: 0.03 },
    ],
    paths: ["/", "/about", "/products", "/pricing", "/careers", "/contact", "/blog", "/blog/company-update", "/solutions", "/partners"],
    titles: ["Home", "About Us", "Products", "Pricing", "Careers", "Contact", "Blog", "Company Update", "Solutions", "Partners"],
    deviceWeights: { Desktop: 0.68, Mobile: 0.27, Tablet: 0.05 },
    weekendFactor: 0.35,
    eventNames: ["cta_click", "demo_request", "newsletter_signup", "pdf_download", "contact_form"],
    hourProfile: { riseHour: 10, activeWidth: 12, baseLevel: 0.12 },
  },
  {
    id: "demo-site-002", teamId: "demo-team-001",
    name: "E-Commerce Store", domain: "shopwave.store",
    dailyPvRange: [12000, 22000], bounceRateRange: [0.28, 0.42], avgDurationMsRange: [120000, 240000],
    topCountries: [
      { code: "US", weight: 0.30 }, { code: "CN", weight: 0.15 }, { code: "DE", weight: 0.10 },
      { code: "GB", weight: 0.10 }, { code: "JP", weight: 0.08 }, { code: "FR", weight: 0.06 },
      { code: "KR", weight: 0.05 }, { code: "AU", weight: 0.04 }, { code: "CA", weight: 0.04 },
      { code: "BR", weight: 0.04 }, { code: "IN", weight: 0.03 }, { code: "IT", weight: 0.01 },
    ],
    topReferrers: [
      { name: "google.com", weight: 0.35 }, { name: "(direct)", weight: 0.20 },
      { name: "instagram.com", weight: 0.12 }, { name: "facebook.com", weight: 0.10 },
      { name: "pinterest.com", weight: 0.07 }, { name: "twitter.com", weight: 0.05 },
      { name: "youtube.com", weight: 0.04 }, { name: "tiktok.com", weight: 0.04 },
      { name: "bing.com", weight: 0.03 },
    ],
    paths: ["/", "/collections", "/collections/new-arrivals", "/products/wireless-headphones", "/products/smart-watch", "/cart", "/checkout", "/account", "/sale", "/products/laptop-stand", "/wishlist", "/returns"],
    titles: ["Shop Home", "Collections", "New Arrivals", "Wireless Headphones", "Smart Watch", "Cart", "Checkout", "My Account", "Sale", "Laptop Stand", "Wishlist", "Returns"],
    deviceWeights: { Desktop: 0.42, Mobile: 0.52, Tablet: 0.06 },
    weekendFactor: 1.25,
    eventNames: ["add_to_cart", "purchase", "wishlist_add", "product_view", "checkout_start", "coupon_apply", "review_submit"],
    hourProfile: { riseHour: 5, activeWidth: 17, baseLevel: 0.22 },
  },
  {
    id: "demo-site-003", teamId: "demo-team-001",
    name: "News Portal", domain: "dailypulse.news",
    dailyPvRange: [18000, 35000], bounceRateRange: [0.55, 0.72], avgDurationMsRange: [30000, 70000],
    topCountries: [
      { code: "US", weight: 0.40 }, { code: "GB", weight: 0.18 }, { code: "CA", weight: 0.10 },
      { code: "AU", weight: 0.08 }, { code: "IN", weight: 0.06 }, { code: "DE", weight: 0.04 },
      { code: "IE", weight: 0.03 }, { code: "NZ", weight: 0.03 }, { code: "SG", weight: 0.02 },
      { code: "ZA", weight: 0.02 }, { code: "PH", weight: 0.02 }, { code: "NG", weight: 0.02 },
    ],
    topReferrers: [
      { name: "google.com", weight: 0.30 }, { name: "(direct)", weight: 0.15 },
      { name: "news.google.com", weight: 0.15 }, { name: "twitter.com", weight: 0.12 },
      { name: "facebook.com", weight: 0.10 }, { name: "reddit.com", weight: 0.06 },
      { name: "apple.news", weight: 0.05 }, { name: "flipboard.com", weight: 0.04 },
      { name: "bing.com", weight: 0.03 },
    ],
    paths: ["/", "/politics", "/tech", "/world", "/business", "/sports", "/culture", "/opinion", "/science", "/health"],
    titles: ["Breaking News", "Politics", "Tech", "World", "Business", "Sports", "Culture", "Opinion", "Science", "Health"],
    deviceWeights: { Desktop: 0.35, Mobile: 0.60, Tablet: 0.05 },
    weekendFactor: 0.90,
    eventNames: ["article_read", "share_click", "newsletter_subscribe", "comment_post", "bookmark"],
    hourProfile: { riseHour: 6, activeWidth: 17, baseLevel: 0.25 },
  },
  {
    id: "demo-site-004", teamId: "demo-team-001",
    name: "Marketing Landing", domain: "launch.brightpath.co",
    dailyPvRange: [3500, 7200], bounceRateRange: [0.62, 0.78], avgDurationMsRange: [15000, 40000],
    topCountries: [
      { code: "US", weight: 0.50 }, { code: "CA", weight: 0.12 }, { code: "GB", weight: 0.10 },
      { code: "AU", weight: 0.08 }, { code: "DE", weight: 0.05 }, { code: "FR", weight: 0.04 },
      { code: "NL", weight: 0.03 }, { code: "IN", weight: 0.03 }, { code: "BR", weight: 0.03 },
      { code: "SG", weight: 0.02 },
    ],
    topReferrers: [
      { name: "google.com", weight: 0.25 }, { name: "facebook.com", weight: 0.20 },
      { name: "instagram.com", weight: 0.15 }, { name: "(direct)", weight: 0.12 },
      { name: "twitter.com", weight: 0.10 }, { name: "linkedin.com", weight: 0.08 },
      { name: "producthunt.com", weight: 0.05 }, { name: "tiktok.com", weight: 0.05 },
    ],
    paths: ["/", "/features", "/pricing", "/testimonials", "/faq", "/get-started"],
    titles: ["BrightPath — Launch Faster", "Features", "Pricing", "Testimonials", "FAQ", "Get Started"],
    deviceWeights: { Desktop: 0.48, Mobile: 0.47, Tablet: 0.05 },
    weekendFactor: 0.55,
    eventNames: ["signup_click", "video_play", "pricing_view", "testimonial_scroll", "cta_click"],
    hourProfile: { riseHour: 12, activeWidth: 9, baseLevel: 0.06 },
  },

  {
    id: "demo-site-005", teamId: "demo-team-001",
    name: "Developer Docs", domain: "docs.devstack.io",
    dailyPvRange: [6500, 12000], bounceRateRange: [0.22, 0.35], avgDurationMsRange: [180000, 420000],
    topCountries: [
      { code: "US", weight: 0.25 }, { code: "CN", weight: 0.15 }, { code: "IN", weight: 0.12 },
      { code: "DE", weight: 0.10 }, { code: "GB", weight: 0.08 }, { code: "JP", weight: 0.06 },
      { code: "BR", weight: 0.05 }, { code: "FR", weight: 0.04 }, { code: "KR", weight: 0.04 },
      { code: "RU", weight: 0.03 }, { code: "CA", weight: 0.03 }, { code: "PL", weight: 0.02 },
      { code: "NL", weight: 0.02 }, { code: "SE", weight: 0.01 },
    ],
    topReferrers: [
      { name: "google.com", weight: 0.35 }, { name: "(direct)", weight: 0.20 },
      { name: "github.com", weight: 0.15 }, { name: "stackoverflow.com", weight: 0.10 },
      { name: "dev.to", weight: 0.05 }, { name: "twitter.com", weight: 0.04 },
      { name: "reddit.com", weight: 0.04 }, { name: "hackernews.com", weight: 0.04 },
      { name: "bing.com", weight: 0.03 },
    ],
    paths: ["/", "/getting-started", "/api-reference", "/guides/authentication", "/guides/webhooks", "/sdk/javascript", "/sdk/python", "/sdk/go", "/changelog", "/examples", "/migration-guide", "/troubleshooting"],
    titles: ["Documentation", "Getting Started", "API Reference", "Authentication Guide", "Webhooks Guide", "JavaScript SDK", "Python SDK", "Go SDK", "Changelog", "Examples", "Migration Guide", "Troubleshooting"],
    deviceWeights: { Desktop: 0.85, Mobile: 0.12, Tablet: 0.03 },
    weekendFactor: 0.45,
    eventNames: ["code_copy", "api_key_generate", "search", "feedback_submit", "example_run"],
    hourProfile: { riseHour: 3, activeWidth: 18, baseLevel: 0.20 },
  },
  {
    id: "demo-site-006", teamId: "demo-team-001",
    name: "SaaS Dashboard", domain: "app.cloudmetrics.io",
    dailyPvRange: [4200, 8500], bounceRateRange: [0.12, 0.22], avgDurationMsRange: [240000, 600000],
    topCountries: [
      { code: "US", weight: 0.30 }, { code: "DE", weight: 0.12 }, { code: "GB", weight: 0.10 },
      { code: "CA", weight: 0.08 }, { code: "FR", weight: 0.07 }, { code: "AU", weight: 0.06 },
      { code: "JP", weight: 0.05 }, { code: "NL", weight: 0.05 }, { code: "SG", weight: 0.04 },
      { code: "SE", weight: 0.04 }, { code: "BR", weight: 0.03 }, { code: "IN", weight: 0.03 },
      { code: "KR", weight: 0.03 },
    ],
    topReferrers: [
      { name: "(direct)", weight: 0.55 }, { name: "google.com", weight: 0.20 },
      { name: "github.com", weight: 0.08 }, { name: "twitter.com", weight: 0.05 },
      { name: "linkedin.com", weight: 0.05 }, { name: "producthunt.com", weight: 0.04 },
      { name: "bing.com", weight: 0.03 },
    ],
    paths: ["/", "/dashboard", "/analytics", "/settings", "/integrations", "/billing", "/team", "/alerts", "/reports", "/api-keys"],
    titles: ["CloudMetrics", "Dashboard", "Analytics", "Settings", "Integrations", "Billing", "Team", "Alerts", "Reports", "API Keys"],
    deviceWeights: { Desktop: 0.82, Mobile: 0.15, Tablet: 0.03 },
    weekendFactor: 0.30,
    eventNames: ["dashboard_view", "report_export", "alert_create", "integration_connect", "plan_upgrade"],
    hourProfile: { riseHour: 8, activeWidth: 11, baseLevel: 0.08 },
  },
  {
    id: "demo-site-007", teamId: "demo-team-001",
    name: "Open Source Project", domain: "oss-toolkit.dev",
    dailyPvRange: [2800, 5500], bounceRateRange: [0.32, 0.48], avgDurationMsRange: [90000, 200000],
    topCountries: [
      { code: "US", weight: 0.22 }, { code: "CN", weight: 0.18 }, { code: "IN", weight: 0.12 },
      { code: "DE", weight: 0.08 }, { code: "BR", weight: 0.07 }, { code: "JP", weight: 0.06 },
      { code: "GB", weight: 0.05 }, { code: "RU", weight: 0.05 }, { code: "FR", weight: 0.04 },
      { code: "KR", weight: 0.04 }, { code: "CA", weight: 0.03 }, { code: "PL", weight: 0.03 },
      { code: "ID", weight: 0.02 }, { code: "TR", weight: 0.01 },
    ],
    topReferrers: [
      { name: "github.com", weight: 0.35 }, { name: "google.com", weight: 0.25 },
      { name: "(direct)", weight: 0.12 }, { name: "stackoverflow.com", weight: 0.08 },
      { name: "reddit.com", weight: 0.06 }, { name: "hackernews.com", weight: 0.05 },
      { name: "dev.to", weight: 0.04 }, { name: "twitter.com", weight: 0.03 },
      { name: "npmjs.com", weight: 0.02 },
    ],
    paths: ["/", "/docs", "/docs/installation", "/docs/configuration", "/docs/plugins", "/examples", "/playground", "/blog", "/sponsors", "/community"],
    titles: ["OSS Toolkit", "Documentation", "Installation", "Configuration", "Plugins", "Examples", "Playground", "Blog", "Sponsors", "Community"],
    deviceWeights: { Desktop: 0.80, Mobile: 0.16, Tablet: 0.04 },
    weekendFactor: 0.65,
    eventNames: ["star_click", "install_copy", "playground_run", "docs_search", "issue_create"],
    hourProfile: { riseHour: 20, activeWidth: 16, baseLevel: 0.18 },
  },
  {
    id: "demo-site-008", teamId: "demo-team-001",
    name: "API Documentation", domain: "api.swiftlink.dev",
    dailyPvRange: [2200, 4800], bounceRateRange: [0.18, 0.30], avgDurationMsRange: [200000, 480000],
    topCountries: [
      { code: "US", weight: 0.28 }, { code: "IN", weight: 0.15 }, { code: "DE", weight: 0.10 },
      { code: "CN", weight: 0.09 }, { code: "GB", weight: 0.08 }, { code: "JP", weight: 0.06 },
      { code: "BR", weight: 0.05 }, { code: "FR", weight: 0.04 }, { code: "CA", weight: 0.04 },
      { code: "KR", weight: 0.04 }, { code: "NL", weight: 0.03 }, { code: "AU", weight: 0.02 },
      { code: "PL", weight: 0.02 },
    ],
    topReferrers: [
      { name: "(direct)", weight: 0.30 }, { name: "google.com", weight: 0.28 },
      { name: "github.com", weight: 0.15 }, { name: "stackoverflow.com", weight: 0.10 },
      { name: "dev.to", weight: 0.05 }, { name: "twitter.com", weight: 0.04 },
      { name: "reddit.com", weight: 0.04 }, { name: "bing.com", weight: 0.04 },
    ],
    paths: ["/", "/v2/endpoints", "/v2/authentication", "/v2/rate-limits", "/v2/errors", "/v2/webhooks", "/sdks", "/sdks/node", "/sdks/python", "/changelog", "/status"],
    titles: ["SwiftLink API", "Endpoints", "Authentication", "Rate Limits", "Errors", "Webhooks", "SDKs", "Node SDK", "Python SDK", "Changelog", "Status"],
    deviceWeights: { Desktop: 0.88, Mobile: 0.10, Tablet: 0.02 },
    weekendFactor: 0.38,
    eventNames: ["api_test", "code_copy", "sdk_download", "search_query", "feedback"],
    hourProfile: { riseHour: 4, activeWidth: 15, baseLevel: 0.15 },
  },

  {
    id: "demo-site-009", teamId: "demo-team-001",
    name: "Personal Blog", domain: "thoughts.jchen.me",
    dailyPvRange: [800, 2200], bounceRateRange: [0.45, 0.62], avgDurationMsRange: [60000, 150000],
    topCountries: [
      { code: "CN", weight: 0.35 }, { code: "US", weight: 0.20 }, { code: "JP", weight: 0.08 },
      { code: "SG", weight: 0.08 }, { code: "TW", weight: 0.06 }, { code: "HK", weight: 0.05 },
      { code: "DE", weight: 0.04 }, { code: "GB", weight: 0.04 }, { code: "CA", weight: 0.03 },
      { code: "AU", weight: 0.03 }, { code: "KR", weight: 0.02 }, { code: "MY", weight: 0.02 },
    ],
    topReferrers: [
      { name: "google.com", weight: 0.30 }, { name: "(direct)", weight: 0.22 },
      { name: "twitter.com", weight: 0.15 }, { name: "baidu.com", weight: 0.10 },
      { name: "weibo.com", weight: 0.06 }, { name: "github.com", weight: 0.05 },
      { name: "zhihu.com", weight: 0.05 }, { name: "bing.com", weight: 0.04 },
      { name: "reddit.com", weight: 0.03 },
    ],
    paths: ["/", "/posts", "/posts/building-in-public", "/posts/rust-vs-go", "/posts/side-project-lessons", "/posts/design-systems", "/about", "/projects", "/newsletter", "/archive"],
    titles: ["J.Chen's Blog", "Posts", "Building in Public", "Rust vs Go", "Side Project Lessons", "Design Systems", "About", "Projects", "Newsletter", "Archive"],
    deviceWeights: { Desktop: 0.62, Mobile: 0.33, Tablet: 0.05 },
    weekendFactor: 1.15,
    eventNames: ["article_read_complete", "newsletter_subscribe", "share_click", "comment"],
    hourProfile: { riseHour: 21, activeWidth: 13, baseLevel: 0.10 },
  },
  {
    id: "demo-site-010", teamId: "demo-team-001",
    name: "Community Forum", domain: "community.pixelforge.io",
    dailyPvRange: [5500, 10000], bounceRateRange: [0.18, 0.28], avgDurationMsRange: [300000, 720000],
    topCountries: [
      { code: "US", weight: 0.28 }, { code: "DE", weight: 0.12 }, { code: "GB", weight: 0.10 },
      { code: "FR", weight: 0.08 }, { code: "CA", weight: 0.06 }, { code: "JP", weight: 0.06 },
      { code: "AU", weight: 0.05 }, { code: "BR", weight: 0.05 }, { code: "IN", weight: 0.05 },
      { code: "NL", weight: 0.04 }, { code: "KR", weight: 0.04 }, { code: "SE", weight: 0.03 },
      { code: "PL", weight: 0.02 }, { code: "ES", weight: 0.02 },
    ],
    topReferrers: [
      { name: "(direct)", weight: 0.35 }, { name: "google.com", weight: 0.28 },
      { name: "github.com", weight: 0.10 }, { name: "twitter.com", weight: 0.08 },
      { name: "reddit.com", weight: 0.06 }, { name: "discord.com", weight: 0.05 },
      { name: "youtube.com", weight: 0.04 }, { name: "dev.to", weight: 0.04 },
    ],
    paths: ["/", "/latest", "/categories/general", "/categories/showcase", "/categories/help", "/categories/feedback", "/t/getting-started-guide", "/t/monthly-challenge", "/u/profile", "/search"],
    titles: ["PixelForge Community", "Latest", "General", "Showcase", "Help", "Feedback", "Getting Started", "Monthly Challenge", "Profile", "Search"],
    deviceWeights: { Desktop: 0.72, Mobile: 0.24, Tablet: 0.04 },
    weekendFactor: 1.20,
    eventNames: ["post_create", "reply_submit", "like_click", "bookmark", "mention", "upload"],
    hourProfile: { riseHour: 7, activeWidth: 18, baseLevel: 0.28 },
  },
  {
    id: "demo-site-011", teamId: "demo-team-001",
    name: "Portfolio Site", domain: "studio.mikalee.design",
    dailyPvRange: [600, 1800], bounceRateRange: [0.50, 0.68], avgDurationMsRange: [40000, 100000],
    topCountries: [
      { code: "US", weight: 0.32 }, { code: "GB", weight: 0.12 }, { code: "DE", weight: 0.08 },
      { code: "FR", weight: 0.08 }, { code: "CA", weight: 0.07 }, { code: "JP", weight: 0.06 },
      { code: "AU", weight: 0.05 }, { code: "NL", weight: 0.05 }, { code: "SE", weight: 0.04 },
      { code: "IT", weight: 0.04 }, { code: "BR", weight: 0.03 }, { code: "KR", weight: 0.03 },
      { code: "SG", weight: 0.03 },
    ],
    topReferrers: [
      { name: "dribbble.com", weight: 0.22 }, { name: "google.com", weight: 0.20 },
      { name: "(direct)", weight: 0.18 }, { name: "behance.net", weight: 0.12 },
      { name: "linkedin.com", weight: 0.10 }, { name: "twitter.com", weight: 0.08 },
      { name: "instagram.com", weight: 0.06 }, { name: "pinterest.com", weight: 0.04 },
    ],
    paths: ["/", "/work", "/work/brand-identity", "/work/web-design", "/work/mobile-app", "/about", "/contact", "/blog", "/services"],
    titles: ["Mika Lee Design", "Work", "Brand Identity", "Web Design", "Mobile App", "About", "Contact", "Blog", "Services"],
    deviceWeights: { Desktop: 0.58, Mobile: 0.35, Tablet: 0.07 },
    weekendFactor: 0.70,
    eventNames: ["project_view", "contact_form", "resume_download", "social_click"],
    hourProfile: { riseHour: 10, activeWidth: 11, baseLevel: 0.08 },
  },
  {
    id: "demo-site-012", teamId: "demo-team-001",
    name: "Education Platform", domain: "learn.codeacademy.org",
    dailyPvRange: [7000, 13000], bounceRateRange: [0.15, 0.25], avgDurationMsRange: [480000, 1200000],
    topCountries: [
      { code: "US", weight: 0.22 }, { code: "IN", weight: 0.18 }, { code: "BR", weight: 0.10 },
      { code: "NG", weight: 0.06 }, { code: "GB", weight: 0.06 }, { code: "DE", weight: 0.05 },
      { code: "ID", weight: 0.05 }, { code: "PH", weight: 0.04 }, { code: "PK", weight: 0.04 },
      { code: "CA", weight: 0.04 }, { code: "MX", weight: 0.03 }, { code: "KE", weight: 0.03 },
      { code: "EG", weight: 0.03 }, { code: "VN", weight: 0.03 }, { code: "TR", weight: 0.02 },
      { code: "CO", weight: 0.02 },
    ],
    topReferrers: [
      { name: "google.com", weight: 0.35 }, { name: "(direct)", weight: 0.25 },
      { name: "youtube.com", weight: 0.10 }, { name: "reddit.com", weight: 0.06 },
      { name: "twitter.com", weight: 0.05 }, { name: "facebook.com", weight: 0.05 },
      { name: "linkedin.com", weight: 0.04 }, { name: "dev.to", weight: 0.04 },
      { name: "quora.com", weight: 0.03 }, { name: "stackoverflow.com", weight: 0.03 },
    ],
    paths: ["/", "/courses", "/courses/javascript-fundamentals", "/courses/python-data-science", "/courses/react-masterclass", "/courses/sql-basics", "/dashboard", "/certificates", "/community", "/pricing", "/blog", "/paths/fullstack"],
    titles: ["CodeAcademy", "Courses", "JavaScript Fundamentals", "Python Data Science", "React Masterclass", "SQL Basics", "Dashboard", "Certificates", "Community", "Pricing", "Blog", "Full-Stack Path"],
    deviceWeights: { Desktop: 0.65, Mobile: 0.30, Tablet: 0.05 },
    weekendFactor: 1.10,
    eventNames: ["lesson_complete", "quiz_submit", "certificate_earn", "course_enroll", "exercise_run", "hint_request"],
    hourProfile: { riseHour: 0, activeWidth: 20, baseLevel: 0.22 },
  },
];

function findSiteProfile(siteId: string): DemoSiteProfile {
  return DEMO_SITE_PROFILES.find((s) => s.id === siteId) ?? DEMO_SITE_PROFILES[0];
}

// ---------------------------------------------------------------------------
//  Shared data constants
// ---------------------------------------------------------------------------

const ALL_BROWSERS = [
  "Chrome",
  "Safari",
  "Edge",
  "Firefox",
  "Samsung Internet",
  "Opera",
  "Brave",
  "Arc",
  "Mobile Safari",
  "Chrome Mobile",
  "Firefox Mobile",
  "Opera Mobile",
  "Yandex Browser",
  "UC Browser",
  "QQ Browser",
  "Vivaldi",
  "DuckDuckGo Browser",
  "Whale",
  "Huawei Browser",
  "Mi Browser",
] as const;
const ALL_OS = [
  "Windows 11",
  "Windows 10",
  "macOS 15",
  "macOS 14",
  "Ubuntu 24.04",
  "Ubuntu 22.04",
  "Fedora 40",
  "Debian 12",
  "iOS 18",
  "iOS 17",
  "Android 15",
  "Android 14",
  "Chrome OS",
  "HarmonyOS 5",
] as const;
const ALL_LANGUAGES = [
  "en-US",
  "en-GB",
  "zh-CN",
  "zh-TW",
  "de-DE",
  "ja-JP",
  "fr-FR",
  "es-ES",
  "es-419",
  "pt-BR",
  "ko-KR",
  "ru-RU",
  "nl-NL",
  "it-IT",
  "pl-PL",
  "tr-TR",
  "id-ID",
  "vi-VN",
  "th-TH",
  "ar-SA",
] as const;
const ALL_SCREEN_SIZES = [
  "1920x1080",
  "2560x1440",
  "1440x900",
  "1366x768",
  "1536x864",
  "1600x900",
  "3840x2160",
  "390x844",
  "393x852",
  "412x915",
  "430x932",
  "360x780",
  "360x800",
  "768x1024",
  "834x1194",
  "1024x1366",
] as const;
const ALL_CONTINENTS = ["North America", "Europe", "Asia", "South America", "Oceania", "Africa"] as const;
const ALL_TIMEZONES = [
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "America/Denver",
  "America/Toronto",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "America/Bogota",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Amsterdam",
  "Europe/Madrid",
  "Europe/Warsaw",
  "Europe/Istanbul",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Asia/Seoul",
  "Asia/Jakarta",
  "Asia/Manila",
  "Asia/Bangkok",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Africa/Nairobi",
] as const;
const ALL_ORGS = [
  "Cloudflare Inc.",
  "Google LLC",
  "Amazon.com Inc.",
  "Microsoft Corp.",
  "Comcast Cable",
  "AT&T Services",
  "Deutsche Telekom",
  "Telefonica",
  "China Telecom",
  "China Unicom",
  "China Mobile",
  "NTT Communications",
  "Vodafone Group",
  "British Telecom",
  "Orange S.A.",
  "SK Broadband",
  "Reliance Jio",
  "Airtel Broadband",
  "Telstra",
  "Rogers Communications",
  "Bell Canada",
  "Singtel",
  "KPN",
  "TIM Brasil",
  "Claro",
] as const;
const BROWSER_MARKET_WEIGHTS: Array<{ label: string; weight: number }> = [
  { label: "Chrome", weight: 0.49 },
  { label: "Safari", weight: 0.22 },
  { label: "Edge", weight: 0.09 },
  { label: "Firefox", weight: 0.06 },
  { label: "Samsung Internet", weight: 0.04 },
  { label: "Chrome Mobile", weight: 0.03 },
  { label: "Mobile Safari", weight: 0.025 },
  { label: "Opera", weight: 0.02 },
  { label: "Brave", weight: 0.012 },
  { label: "Arc", weight: 0.01 },
  { label: "Firefox Mobile", weight: 0.008 },
  { label: "Opera Mobile", weight: 0.006 },
  { label: "Yandex Browser", weight: 0.005 },
  { label: "UC Browser", weight: 0.004 },
  { label: "QQ Browser", weight: 0.004 },
  { label: "Vivaldi", weight: 0.003 },
  { label: "DuckDuckGo Browser", weight: 0.003 },
  { label: "Whale", weight: 0.0025 },
  { label: "Huawei Browser", weight: 0.0025 },
  { label: "Mi Browser", weight: 0.002 },
];
const GLOBAL_REFERRER_LONG_TAIL: Array<{ name: string; weight: number }> = [
  { name: "duckduckgo.com", weight: 0.06 },
  { name: "search.yahoo.com", weight: 0.055 },
  { name: "yandex.com", weight: 0.04 },
  { name: "ecosia.org", weight: 0.035 },
  { name: "news.ycombinator.com", weight: 0.03 },
  { name: "medium.com", weight: 0.03 },
  { name: "substack.com", weight: 0.025 },
  { name: "discord.com", weight: 0.024 },
  { name: "slack.com", weight: 0.02 },
  { name: "notion.so", weight: 0.018 },
  { name: "youtube.com", weight: 0.016 },
  { name: "wechat.com", weight: 0.014 },
  { name: "x.com", weight: 0.014 },
  { name: "threads.net", weight: 0.012 },
  { name: "quora.com", weight: 0.012 },
  { name: "npmjs.com", weight: 0.011 },
  { name: "producthunt.com", weight: 0.011 },
  { name: "baidu.com", weight: 0.01 },
  { name: "zhihu.com", weight: 0.01 },
  { name: "weibo.com", weight: 0.009 },
  { name: "line.me", weight: 0.008 },
  { name: "kakao.com", weight: 0.008 },
  { name: "dev.to", weight: 0.008 },
  { name: "stackoverflow.com", weight: 0.008 },
  { name: "l.facebook.com", weight: 0.007 },
  { name: "m.facebook.com", weight: 0.007 },
];
const GLOBAL_COUNTRY_LONG_TAIL: Array<{ code: string; weight: number }> = [
  { code: "US", weight: 0.18 },
  { code: "IN", weight: 0.11 },
  { code: "BR", weight: 0.08 },
  { code: "DE", weight: 0.06 },
  { code: "GB", weight: 0.055 },
  { code: "CA", weight: 0.05 },
  { code: "FR", weight: 0.045 },
  { code: "JP", weight: 0.04 },
  { code: "AU", weight: 0.035 },
  { code: "ES", weight: 0.03 },
  { code: "IT", weight: 0.03 },
  { code: "NL", weight: 0.025 },
  { code: "SE", weight: 0.02 },
  { code: "PL", weight: 0.02 },
  { code: "MX", weight: 0.02 },
  { code: "TR", weight: 0.02 },
  { code: "ID", weight: 0.02 },
  { code: "PH", weight: 0.018 },
  { code: "VN", weight: 0.018 },
  { code: "KR", weight: 0.018 },
  { code: "SG", weight: 0.016 },
  { code: "MY", weight: 0.015 },
  { code: "TH", weight: 0.015 },
  { code: "NG", weight: 0.015 },
  { code: "ZA", weight: 0.014 },
  { code: "KE", weight: 0.014 },
  { code: "EG", weight: 0.014 },
  { code: "CO", weight: 0.014 },
  { code: "AR", weight: 0.013 },
  { code: "CL", weight: 0.012 },
  { code: "AE", weight: 0.012 },
  { code: "PK", weight: 0.012 },
  { code: "HK", weight: 0.01 },
  { code: "TW", weight: 0.01 },
  { code: "IE", weight: 0.01 },
  { code: "NZ", weight: 0.01 },
  { code: "PT", weight: 0.01 },
];
// Region format matches real backend: "country::stateCode::stateName"
const ALL_REGIONS = [
  "US::CA::California",
  "US::TX::Texas",
  "US::NY::New York",
  "US::FL::Florida",
  "US::WA::Washington",
  "CA::ON::Ontario",
  "CA::BC::British Columbia",
  "CA::QC::Quebec",
  "GB::ENG::England",
  "DE::BE::Berlin",
  "DE::BY::Bavaria",
  "DE::NW::North Rhine-Westphalia",
  "FR::IDF::Ile-de-France",
  "FR::ARA::Auvergne-Rhone-Alpes",
  "NL::NH::North Holland",
  "ES::MD::Madrid",
  "IT::62::Lazio",
  "PL::14::Mazowieckie",
  "SE::AB::Stockholm County",
  "JP::13::Tokyo",
  "JP::27::Osaka",
  "CN::BJ::Beijing",
  "CN::SH::Shanghai",
  "CN::GD::Guangdong",
  "IN::MH::Maharashtra",
  "IN::KA::Karnataka",
  "IN::DL::Delhi",
  "KR::11::Seoul",
  "SG::01::Singapore",
  "AU::NSW::New South Wales",
  "AU::VIC::Victoria",
  "NZ::AUK::Auckland",
  "BR::SP::Sao Paulo",
  "BR::RJ::Rio de Janeiro",
  "MX::CMX::Ciudad de Mexico",
  "AR::B::Buenos Aires",
  "CO::DC::Bogota",
  "ZA::GT::Gauteng",
  "NG::LA::Lagos",
  "KE::110::Nairobi",
  "EG::C::Cairo",
  "TR::34::Istanbul",
  "ID::JK::Jakarta",
  "PH::00::Metro Manila",
  "VN::HN::Hanoi",
] as const;
// City format matches real backend: "country::stateCode::stateName::cityName"
const ALL_CITIES = [
  "US::CA::California::San Francisco",
  "US::NY::New York::New York",
  "US::CA::California::Los Angeles",
  "US::TX::Texas::Austin",
  "US::IL::Illinois::Chicago",
  "US::WA::Washington::Seattle",
  "US::MA::Massachusetts::Boston",
  "CA::ON::Ontario::Toronto",
  "CA::BC::British Columbia::Vancouver",
  "CA::QC::Quebec::Montreal",
  "GB::ENG::England::London",
  "GB::ENG::England::Manchester",
  "DE::BE::Berlin::Berlin",
  "DE::BY::Bavaria::Munich",
  "DE::HH::Hamburg::Hamburg",
  "FR::IDF::Ile-de-France::Paris",
  "FR::ARA::Auvergne-Rhone-Alpes::Lyon",
  "NL::NH::North Holland::Amsterdam",
  "ES::MD::Madrid::Madrid",
  "IT::62::Lazio::Rome",
  "SE::AB::Stockholm County::Stockholm",
  "PL::14::Mazowieckie::Warsaw",
  "JP::13::Tokyo::Tokyo",
  "JP::27::Osaka::Osaka",
  "CN::BJ::Beijing::Beijing",
  "CN::SH::Shanghai::Shanghai",
  "CN::GD::Guangdong::Shenzhen",
  "CN::GD::Guangdong::Guangzhou",
  "IN::MH::Maharashtra::Mumbai",
  "IN::DL::Delhi::New Delhi",
  "IN::KA::Karnataka::Bengaluru",
  "IN::TG::Telangana::Hyderabad",
  "KR::11::Seoul::Seoul",
  "SG::01::Singapore::Singapore",
  "AU::NSW::New South Wales::Sydney",
  "AU::VIC::Victoria::Melbourne",
  "NZ::AUK::Auckland::Auckland",
  "BR::SP::Sao Paulo::Sao Paulo",
  "BR::RJ::Rio de Janeiro::Rio de Janeiro",
  "MX::CMX::Ciudad de Mexico::Mexico City",
  "AR::B::Buenos Aires::Buenos Aires",
  "CO::DC::Bogota::Bogota",
  "ZA::GT::Gauteng::Johannesburg",
  "NG::LA::Lagos::Lagos",
  "KE::110::Nairobi::Nairobi",
  "EG::C::Cairo::Cairo",
  "TR::34::Istanbul::Istanbul",
  "ID::JK::Jakarta::Jakarta",
  "PH::00::Metro Manila::Manila",
  "VN::HN::Hanoi::Hanoi",
  "TW::TPE::Taipei::Taipei",
  "HK::HK::Hong Kong::Hong Kong",
  "MY::14::Kuala Lumpur::Kuala Lumpur",
] as const;

const COUNTRY_COORDINATE_ANCHORS: Record<string, { latitude: number; longitude: number }> = {
  US: { latitude: 39.5, longitude: -98.35 },
  CA: { latitude: 56.13, longitude: -106.35 },
  GB: { latitude: 54.8, longitude: -2.3 },
  DE: { latitude: 51.16, longitude: 10.45 },
  FR: { latitude: 46.23, longitude: 2.21 },
  JP: { latitude: 36.2, longitude: 138.25 },
  CN: { latitude: 35.86, longitude: 104.2 },
  IN: { latitude: 20.59, longitude: 78.96 },
  BR: { latitude: -14.24, longitude: -51.93 },
  AU: { latitude: -25.27, longitude: 133.77 },
  NL: { latitude: 52.13, longitude: 5.29 },
  KR: { latitude: 35.91, longitude: 127.77 },
  SG: { latitude: 1.35, longitude: 103.82 },
  SE: { latitude: 60.13, longitude: 18.64 },
  IT: { latitude: 41.87, longitude: 12.57 },
  RU: { latitude: 61.52, longitude: 105.32 },
  IE: { latitude: 53.14, longitude: -7.69 },
  NZ: { latitude: -40.9, longitude: 174.89 },
  ZA: { latitude: -30.56, longitude: 22.94 },
  PH: { latitude: 12.88, longitude: 121.77 },
  NG: { latitude: 9.08, longitude: 8.68 },
  PL: { latitude: 51.92, longitude: 19.15 },
  ES: { latitude: 40.46, longitude: -3.75 },
  PT: { latitude: 39.4, longitude: -8.22 },
  ID: { latitude: -0.79, longitude: 113.92 },
  MX: { latitude: 23.63, longitude: -102.55 },
  TR: { latitude: 38.96, longitude: 35.24 },
  TW: { latitude: 23.7, longitude: 121.0 },
  HK: { latitude: 22.32, longitude: 114.17 },
  MY: { latitude: 4.21, longitude: 101.98 },
  PK: { latitude: 30.38, longitude: 69.35 },
  KE: { latitude: -0.02, longitude: 37.91 },
  EG: { latitude: 26.82, longitude: 30.8 },
  VN: { latitude: 14.06, longitude: 108.28 },
  CO: { latitude: 4.57, longitude: -74.3 },
  AR: { latitude: -38.42, longitude: -63.62 },
  CL: { latitude: -35.68, longitude: -71.54 },
  AE: { latitude: 23.42, longitude: 53.85 },
  TH: { latitude: 15.87, longitude: 100.99 },
};

interface GeoCluster {
  latitude: number;
  longitude: number;
  weight: number;
  spreadKm: number;
}

const COUNTRY_GEO_CLUSTERS: Record<string, GeoCluster[]> = {
  US: [
    { latitude: 40.7128, longitude: -74.006, weight: 0.24, spreadKm: 38 },
    { latitude: 34.0522, longitude: -118.2437, weight: 0.21, spreadKm: 42 },
    { latitude: 41.8781, longitude: -87.6298, weight: 0.15, spreadKm: 36 },
    { latitude: 32.7767, longitude: -96.797, weight: 0.13, spreadKm: 34 },
    { latitude: 33.749, longitude: -84.388, weight: 0.12, spreadKm: 33 },
    { latitude: 47.6062, longitude: -122.3321, weight: 0.1, spreadKm: 31 },
    { latitude: 42.3601, longitude: -71.0589, weight: 0.05, spreadKm: 30 },
  ],
  CA: [
    { latitude: 43.6532, longitude: -79.3832, weight: 0.46, spreadKm: 28 },
    { latitude: 49.2827, longitude: -123.1207, weight: 0.29, spreadKm: 26 },
    { latitude: 45.5017, longitude: -73.5673, weight: 0.25, spreadKm: 24 },
  ],
  GB: [
    { latitude: 51.5074, longitude: -0.1278, weight: 0.58, spreadKm: 24 },
    { latitude: 53.4808, longitude: -2.2426, weight: 0.24, spreadKm: 20 },
    { latitude: 52.4862, longitude: -1.8904, weight: 0.18, spreadKm: 20 },
  ],
  DE: [
    { latitude: 52.52, longitude: 13.405, weight: 0.34, spreadKm: 22 },
    { latitude: 48.1351, longitude: 11.582, weight: 0.26, spreadKm: 20 },
    { latitude: 50.1109, longitude: 8.6821, weight: 0.24, spreadKm: 18 },
    { latitude: 53.5511, longitude: 9.9937, weight: 0.16, spreadKm: 18 },
  ],
  FR: [
    { latitude: 48.8566, longitude: 2.3522, weight: 0.62, spreadKm: 21 },
    { latitude: 45.764, longitude: 4.8357, weight: 0.2, spreadKm: 19 },
    { latitude: 43.2965, longitude: 5.3698, weight: 0.18, spreadKm: 20 },
  ],
  JP: [
    { latitude: 35.6762, longitude: 139.6503, weight: 0.58, spreadKm: 20 },
    { latitude: 34.6937, longitude: 135.5023, weight: 0.25, spreadKm: 19 },
    { latitude: 35.1815, longitude: 136.9066, weight: 0.17, spreadKm: 18 },
  ],
  CN: [
    { latitude: 39.9042, longitude: 116.4074, weight: 0.27, spreadKm: 32 },
    { latitude: 31.2304, longitude: 121.4737, weight: 0.29, spreadKm: 30 },
    { latitude: 22.5431, longitude: 114.0579, weight: 0.2, spreadKm: 27 },
    { latitude: 23.1291, longitude: 113.2644, weight: 0.14, spreadKm: 25 },
    { latitude: 30.5728, longitude: 104.0668, weight: 0.1, spreadKm: 24 },
  ],
  IN: [
    { latitude: 19.076, longitude: 72.8777, weight: 0.28, spreadKm: 29 },
    { latitude: 28.6139, longitude: 77.209, weight: 0.25, spreadKm: 30 },
    { latitude: 12.9716, longitude: 77.5946, weight: 0.2, spreadKm: 26 },
    { latitude: 17.385, longitude: 78.4867, weight: 0.15, spreadKm: 24 },
    { latitude: 13.0827, longitude: 80.2707, weight: 0.12, spreadKm: 23 },
  ],
  BR: [
    { latitude: -23.5505, longitude: -46.6333, weight: 0.52, spreadKm: 33 },
    { latitude: -22.9068, longitude: -43.1729, weight: 0.28, spreadKm: 30 },
    { latitude: -15.7939, longitude: -47.8828, weight: 0.2, spreadKm: 28 },
  ],
  AU: [
    { latitude: -33.8688, longitude: 151.2093, weight: 0.45, spreadKm: 26 },
    { latitude: -37.8136, longitude: 144.9631, weight: 0.32, spreadKm: 25 },
    { latitude: -27.4698, longitude: 153.0251, weight: 0.15, spreadKm: 23 },
    { latitude: -31.9523, longitude: 115.8613, weight: 0.08, spreadKm: 22 },
  ],
  NL: [
    { latitude: 52.3676, longitude: 4.9041, weight: 0.69, spreadKm: 17 },
    { latitude: 51.9244, longitude: 4.4777, weight: 0.31, spreadKm: 16 },
  ],
  KR: [
    { latitude: 37.5665, longitude: 126.978, weight: 0.72, spreadKm: 17 },
    { latitude: 35.1796, longitude: 129.0756, weight: 0.28, spreadKm: 16 },
  ],
  SG: [{ latitude: 1.3521, longitude: 103.8198, weight: 1, spreadKm: 11 }],
  SE: [
    { latitude: 59.3293, longitude: 18.0686, weight: 0.74, spreadKm: 16 },
    { latitude: 57.7089, longitude: 11.9746, weight: 0.26, spreadKm: 15 },
  ],
  IT: [
    { latitude: 41.9028, longitude: 12.4964, weight: 0.58, spreadKm: 18 },
    { latitude: 45.4642, longitude: 9.19, weight: 0.42, spreadKm: 18 },
  ],
  RU: [
    { latitude: 55.7558, longitude: 37.6173, weight: 0.7, spreadKm: 24 },
    { latitude: 59.9311, longitude: 30.3609, weight: 0.3, spreadKm: 22 },
  ],
  IE: [{ latitude: 53.3498, longitude: -6.2603, weight: 1, spreadKm: 16 }],
  NZ: [
    { latitude: -36.8485, longitude: 174.7633, weight: 0.7, spreadKm: 16 },
    { latitude: -41.2865, longitude: 174.7762, weight: 0.3, spreadKm: 15 },
  ],
  ZA: [
    { latitude: -26.2041, longitude: 28.0473, weight: 0.65, spreadKm: 20 },
    { latitude: -33.9249, longitude: 18.4241, weight: 0.35, spreadKm: 20 },
  ],
  PH: [
    { latitude: 14.5995, longitude: 120.9842, weight: 0.78, spreadKm: 22 },
    { latitude: 10.3157, longitude: 123.8854, weight: 0.22, spreadKm: 20 },
  ],
  NG: [
    { latitude: 6.5244, longitude: 3.3792, weight: 0.72, spreadKm: 24 },
    { latitude: 9.0765, longitude: 7.3986, weight: 0.28, spreadKm: 22 },
  ],
  PL: [
    { latitude: 52.2297, longitude: 21.0122, weight: 0.64, spreadKm: 17 },
    { latitude: 50.0647, longitude: 19.945, weight: 0.36, spreadKm: 16 },
  ],
  ES: [
    { latitude: 40.4168, longitude: -3.7038, weight: 0.56, spreadKm: 19 },
    { latitude: 41.3874, longitude: 2.1686, weight: 0.44, spreadKm: 19 },
  ],
  PT: [
    { latitude: 38.7223, longitude: -9.1393, weight: 0.68, spreadKm: 16 },
    { latitude: 41.1579, longitude: -8.6291, weight: 0.32, spreadKm: 15 },
  ],
  ID: [
    { latitude: -6.2088, longitude: 106.8456, weight: 0.57, spreadKm: 28 },
    { latitude: -7.2575, longitude: 112.7521, weight: 0.23, spreadKm: 24 },
    { latitude: -6.9175, longitude: 107.6191, weight: 0.2, spreadKm: 22 },
  ],
  MX: [
    { latitude: 19.4326, longitude: -99.1332, weight: 0.55, spreadKm: 24 },
    { latitude: 20.6597, longitude: -103.3496, weight: 0.25, spreadKm: 22 },
    { latitude: 25.6866, longitude: -100.3161, weight: 0.2, spreadKm: 21 },
  ],
  TR: [
    { latitude: 41.0082, longitude: 28.9784, weight: 0.64, spreadKm: 21 },
    { latitude: 39.9334, longitude: 32.8597, weight: 0.22, spreadKm: 20 },
    { latitude: 38.4237, longitude: 27.1428, weight: 0.14, spreadKm: 19 },
  ],
  TW: [
    { latitude: 25.033, longitude: 121.5654, weight: 0.73, spreadKm: 14 },
    { latitude: 24.1477, longitude: 120.6736, weight: 0.27, spreadKm: 13 },
  ],
  HK: [{ latitude: 22.3193, longitude: 114.1694, weight: 1, spreadKm: 9 }],
  MY: [
    { latitude: 3.139, longitude: 101.6869, weight: 0.72, spreadKm: 16 },
    { latitude: 5.4141, longitude: 100.3288, weight: 0.16, spreadKm: 14 },
    { latitude: 1.4927, longitude: 103.7414, weight: 0.12, spreadKm: 14 },
  ],
  PK: [
    { latitude: 24.8607, longitude: 67.0011, weight: 0.48, spreadKm: 22 },
    { latitude: 31.5497, longitude: 74.3436, weight: 0.34, spreadKm: 21 },
    { latitude: 33.6844, longitude: 73.0479, weight: 0.18, spreadKm: 20 },
  ],
  KE: [
    { latitude: -1.2921, longitude: 36.8219, weight: 0.78, spreadKm: 18 },
    { latitude: -4.0435, longitude: 39.6682, weight: 0.22, spreadKm: 17 },
  ],
  EG: [
    { latitude: 30.0444, longitude: 31.2357, weight: 0.74, spreadKm: 20 },
    { latitude: 31.2001, longitude: 29.9187, weight: 0.26, spreadKm: 18 },
  ],
  VN: [
    { latitude: 10.8231, longitude: 106.6297, weight: 0.47, spreadKm: 21 },
    { latitude: 21.0278, longitude: 105.8342, weight: 0.43, spreadKm: 21 },
    { latitude: 16.0544, longitude: 108.2022, weight: 0.1, spreadKm: 18 },
  ],
  CO: [
    { latitude: 4.711, longitude: -74.0721, weight: 0.62, spreadKm: 19 },
    { latitude: 6.2442, longitude: -75.5812, weight: 0.38, spreadKm: 18 },
  ],
  AR: [
    { latitude: -34.6037, longitude: -58.3816, weight: 0.7, spreadKm: 21 },
    { latitude: -31.4201, longitude: -64.1888, weight: 0.3, spreadKm: 19 },
  ],
  CL: [{ latitude: -33.4489, longitude: -70.6693, weight: 1, spreadKm: 18 }],
  AE: [
    { latitude: 25.2048, longitude: 55.2708, weight: 0.62, spreadKm: 14 },
    { latitude: 24.4539, longitude: 54.3773, weight: 0.38, spreadKm: 13 },
  ],
  TH: [
    { latitude: 13.7563, longitude: 100.5018, weight: 0.76, spreadKm: 19 },
    { latitude: 18.7883, longitude: 98.9853, weight: 0.24, spreadKm: 16 },
  ],
};

function normalizeLongitude(longitude: number): number {
  if (!Number.isFinite(longitude)) return 0;
  let value = longitude;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

function weightedPickIndex(rng: () => number, weights: number[]): number {
  if (weights.length === 0) return 0;
  const safeWeights = weights.map((weight) => Math.max(0, Number(weight) || 0));
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) return 0;
  let hit = rng() * totalWeight;
  for (let index = 0; index < safeWeights.length; index += 1) {
    hit -= safeWeights[index] ?? 0;
    if (hit <= 0) return index;
  }
  return safeWeights.length - 1;
}

function randomGaussian(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = Math.max(rng(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pickCountryGeoCluster(rng: () => number, countryCode: string): GeoCluster {
  const clusters = COUNTRY_GEO_CLUSTERS[countryCode];
  if (!clusters || clusters.length === 0) {
    const anchor = COUNTRY_COORDINATE_ANCHORS[countryCode] ?? { latitude: 20, longitude: 0 };
    return {
      latitude: anchor.latitude,
      longitude: anchor.longitude,
      weight: 1,
      spreadKm: 170,
    };
  }
  const index = weightedPickIndex(rng, clusters.map((cluster) => cluster.weight));
  return clusters[index] ?? clusters[0];
}

function sampleGeoPointByCountry(
  rng: () => number,
  countryCode: string,
): { latitude: number; longitude: number } {
  const cluster = pickCountryGeoCluster(rng, countryCode);
  const outskirtsBoost = rng() < 0.08 ? 1.8 + rng() * 1.8 : 1;
  const spreadKm = cluster.spreadKm * outskirtsBoost;
  const latSigma = spreadKm / 111;
  const cosLat = Math.max(0.22, Math.cos((cluster.latitude * Math.PI) / 180));
  const lonSigma = spreadKm / (111 * cosLat);
  const latitude = Math.max(
    -85,
    Math.min(85, cluster.latitude + randomGaussian(rng) * latSigma),
  );
  const longitude = normalizeLongitude(cluster.longitude + randomGaussian(rng) * lonSigma);
  return {
    latitude: Number(latitude.toFixed(5)),
    longitude: Number(longitude.toFixed(5)),
  };
}

function weightedPickCountry(
  rng: () => number,
  countries: Array<{ code: string; weight: number }>,
): string {
  const totalWeight = countries.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (totalWeight <= 0 || countries.length === 0) return "US";
  let hit = rng() * totalWeight;
  for (const item of countries) {
    const weight = Math.max(0, item.weight);
    hit -= weight;
    if (hit <= 0) return item.code;
  }
  return countries[countries.length - 1]?.code || "US";
}

function buildCountryPool(
  rng: () => number,
  baseCountries: Array<{ code: string; weight: number }>,
  targetCount: number,
): Array<{ code: string; weight: number }> {
  const normalizedTarget = Math.max(4, targetCount);
  const pool = new Map<string, number>();
  for (const country of baseCountries) {
    const code = String(country.code || "").trim().toUpperCase();
    const weight = Math.max(0, Number(country.weight) || 0);
    if (!code || weight <= 0) continue;
    pool.set(code, (pool.get(code) ?? 0) + weight);
  }
  if (pool.size === 0) pool.set("US", 1);

  const baseWeightSum = Array.from(pool.values()).reduce((sum, value) => sum + value, 0);
  const longTailScale = Math.max(0.08, baseWeightSum * 0.22);

  for (const candidate of sShuffle(rng, [...GLOBAL_COUNTRY_LONG_TAIL])) {
    if (pool.size >= normalizedTarget) break;
    if (pool.has(candidate.code)) continue;
    const weight = candidate.weight * longTailScale * (0.7 + rng() * 0.7);
    pool.set(candidate.code, weight);
  }

  return Array.from(pool.entries())
    .map(([code, weight]) => ({ code, weight }))
    .sort((left, right) => right.weight - left.weight);
}

function buildReferrerPool(
  rng: () => number,
  baseReferrers: Array<{ name: string; weight: number }>,
  targetCount: number,
): Array<{ label: string; weight: number }> {
  const normalizedTarget = Math.max(6, targetCount);
  const pool = new Map<string, number>();
  for (const referrer of baseReferrers) {
    const label = String(referrer.name || "").trim();
    const weight = Math.max(0, Number(referrer.weight) || 0);
    if (!label || weight <= 0) continue;
    pool.set(label, (pool.get(label) ?? 0) + weight);
  }
  if (!pool.has("(direct)")) pool.set("(direct)", 0.2);

  const baseWeightSum = Array.from(pool.values()).reduce((sum, value) => sum + value, 0);
  const longTailScale = Math.max(0.04, baseWeightSum * 0.16);

  for (const candidate of sShuffle(rng, [...GLOBAL_REFERRER_LONG_TAIL])) {
    if (pool.size >= normalizedTarget) break;
    if (pool.has(candidate.name)) continue;
    const weight = candidate.weight * longTailScale * (0.65 + rng() * 0.9);
    pool.set(candidate.name, weight);
  }

  return Array.from(pool.entries())
    .map(([label, weight]) => ({ label, weight }))
    .sort((left, right) => right.weight - left.weight);
}

function filterGeoLabelsByCountries(
  labels: readonly string[],
  countries: string[],
): string[] {
  const allowed = new Set(countries.map((country) => country.trim().toUpperCase()).filter(Boolean));
  const filtered = labels.filter((label) => allowed.has(String(label).split("::")[0] || ""));
  if (filtered.length >= 6) return filtered;
  return [...labels];
}

// ---------------------------------------------------------------------------
//  Core integration: per-site deterministic traffic rate function
//
//  Each site has an hourProfile { riseHour, activeWidth, baseLevel } that
//  defines a unique 24h traffic shape:
//    - Active zone [riseHour, riseHour + activeWidth]: sine peak
//    - Outside: flat at baseLevel
//    - Supports midnight wrapping (riseHour + activeWidth > 24)
//
//  r(t) = dailyViewCount(day) × siteHourShape(hourOfDay) / siteDayIntegral
//
//  Views for any [from, to] = Σ over each overlapping day d:
//    dailyViewCount(siteId, d) × siteHourShapeIntegral(h1, h2, ...) / siteDayIntegral(siteId)
//
//  Guarantees:
//    1. Same window → same result (deterministic)
//    2. Sub-windows sum to parent window (additive)
//    3. Data changes with time window (integration-dependent)
//    4. Each site has a distinct 24h curve shape
// ---------------------------------------------------------------------------

/**
 * Closed-form integral of a per-site hour shape over [h1, h2] (hour-of-day, 0–24).
 *
 * Shape: baseLevel outside active zone; baseLevel + (1-baseLevel)·sin(phase·π/activeWidth) inside.
 * Active zone wraps around midnight when riseHour + activeWidth > 24.
 */
function siteHourShapeIntegral(
  h1: number, h2: number,
  riseHour: number, activeWidth: number, baseLevel: number,
): number {
  if (h1 >= h2) return 0;
  const constPart = baseLevel * (h2 - h1);
  const endHour = riseHour + activeWidth;

  // Define active segments in [0, 24] space, each with a phase offset.
  // Segment format: [segStart, segEnd, offset]
  //   phase(h) = h - riseHour + offset
  const segments: Array<[number, number, number]> = [];
  if (endHour <= 24) {
    segments.push([riseHour, endHour, 0]);
  } else {
    // Wraps midnight: [riseHour..24] continues as [0..endHour-24]
    segments.push([riseHour, 24, 0]);
    segments.push([0, endHour - 24, 24]);
  }

  let sinPart = 0;
  const k = Math.PI / activeWidth;
  for (const [segStart, segEnd, offset] of segments) {
    const oStart = Math.max(h1, segStart);
    const oEnd = Math.min(h2, segEnd);
    if (oStart >= oEnd) continue;
    // ∫ sin((h - riseHour + offset) · k) dh = (1/k)(cos(start) - cos(end))
    sinPart += (1 / k) * (
      Math.cos((oStart - riseHour + offset) * k) -
      Math.cos((oEnd - riseHour + offset) * k)
    );
  }

  return constPart + (1 - baseLevel) * sinPart;
}

const _siteDayIntegralCache = new Map<string, number>();

/** Cached full-day integral for a site's hour shape */
function siteDayIntegral(siteId: string): number {
  const cached = _siteDayIntegralCache.get(siteId);
  if (cached !== undefined) return cached;
  const hp = findSiteProfile(siteId).hourProfile;
  const val = siteHourShapeIntegral(0, 24, hp.riseHour, hp.activeWidth, hp.baseLevel);
  _siteDayIntegralCache.set(siteId, val);
  return val;
}

/** Deterministic daily view count for a site on a given day number (since epoch) */
function dailyViewCount(siteId: string, dayNum: number): number {
  const profile = findSiteProfile(siteId);
  const rng = mulberry32(fnv1a(`${siteId}:day:${dayNum}`));
  let pv = sInt(rng, profile.dailyPvRange[0], profile.dailyPvRange[1]);
  // 1970-01-01 (dayNum 0) = Thursday (dow 4). 0=Sun…6=Sat
  const dow = (4 + ((dayNum % 7) + 7) % 7) % 7;
  if (dow === 0 || dow === 6) pv = Math.round(pv * profile.weekendFactor);
  return pv;
}

/** Integrate views for a site over [fromMs, toMs) using per-site hour shape */
function integrateViews(siteId: string, fromMs: number, toMs: number): number {
  if (fromMs >= toMs) return 0;
  const HOUR_MS = 3600000;
  const DAY_H = 24;
  const fromH = fromMs / HOUR_MS;
  const toH = toMs / HOUR_MS;
  const fromDay = Math.floor(fromH / DAY_H);
  const toDay = Math.floor((toH - 1e-9) / DAY_H);
  const hp = findSiteProfile(siteId).hourProfile;
  const dayInt = siteDayIntegral(siteId);
  let total = 0;
  for (let d = fromDay; d <= toDay; d++) {
    const dayStartH = d * DAY_H;
    const h1 = Math.max(fromH - dayStartH, 0);
    const h2 = Math.min(toH - dayStartH, DAY_H);
    if (h1 >= h2) continue;
    total += dailyViewCount(siteId, d) * siteHourShapeIntegral(h1, h2, hp.riseHour, hp.activeWidth, hp.baseLevel) / dayInt;
  }
  return Math.round(total);
}

interface SiteMetricRatios {
  sessionsPerView: number;
  visitorsPerSession: number;
  bounceRate: number;
  avgDurationMs: number;
}

const _siteRatiosCache = new Map<string, SiteMetricRatios>();

/** Per-site metric ratios — deterministic, fixed for each site */
function siteRatios(siteId: string): SiteMetricRatios {
  const cached = _siteRatiosCache.get(siteId);
  if (cached) return cached;
  const profile = findSiteProfile(siteId);
  const rng = mulberry32(fnv1a(`${siteId}:ratios`));
  const ratios: SiteMetricRatios = {
    sessionsPerView: 0.4 + rng() * 0.25,
    visitorsPerSession: 0.65 + rng() * 0.25,
    bounceRate: sFloat(rng, profile.bounceRateRange[0], profile.bounceRateRange[1]),
    avgDurationMs: sInt(rng, profile.avgDurationMsRange[0], profile.avgDurationMsRange[1]),
  };
  _siteRatiosCache.set(siteId, ratios);
  return ratios;
}

/**
 * Daily variation factor for a given metric.
 * Returns a deterministic multiplier around 1.0 that varies per day,
 * making bounce rate, avg duration, etc. change across time windows.
 */
function dailyMetricFactor(siteId: string, dayNum: number, metric: string): number {
  const rng = mulberry32(fnv1a(`${siteId}:dfactor:${metric}:${dayNum}`));
  switch (metric) {
    case "sessions": return 0.88 + rng() * 0.24;   // 0.88–1.12
    case "visitors": return 0.90 + rng() * 0.20;   // 0.90–1.10
    case "bounce":   return 0.78 + rng() * 0.44;   // 0.78–1.22
    case "duration": return 0.65 + rng() * 0.70;   // 0.65–1.35
    default: return 1.0;
  }
}

/** Compute all six overview metrics via day-by-day integration with daily factors */
function computeMetrics(siteId: string, fromMs: number, toMs: number) {
  if (fromMs >= toMs) {
    return {
      views: 0, sessions: 0, visitors: 0, bounces: 0,
      totalDurationMs: 0, avgDurationMs: 0, bounceRate: 0,
      approximateVisitors: false,
    };
  }
  const HOUR_MS = 3600000;
  const DAY_H = 24;
  const hp = findSiteProfile(siteId).hourProfile;
  const dayInt = siteDayIntegral(siteId);
  const base = siteRatios(siteId);

  const fromH = fromMs / HOUR_MS;
  const toH = toMs / HOUR_MS;
  const fromDay = Math.floor(fromH / DAY_H);
  const toDay = Math.floor((toH - 1e-9) / DAY_H);

  let sumViews = 0;
  let sumSessions = 0;
  let sumVisitors = 0;
  let sumBounces = 0;
  let sumDurationMs = 0;

  for (let d = fromDay; d <= toDay; d++) {
    const dayStartH = d * DAY_H;
    const h1 = Math.max(fromH - dayStartH, 0);
    const h2 = Math.min(toH - dayStartH, DAY_H);
    if (h1 >= h2) continue;

    const viewsFrac = dailyViewCount(siteId, d)
      * siteHourShapeIntegral(h1, h2, hp.riseHour, hp.activeWidth, hp.baseLevel) / dayInt;

    const sf = dailyMetricFactor(siteId, d, "sessions");
    const vf = dailyMetricFactor(siteId, d, "visitors");
    const bf = dailyMetricFactor(siteId, d, "bounce");
    const df = dailyMetricFactor(siteId, d, "duration");

    const sessionsFrac = viewsFrac * base.sessionsPerView * sf;
    const visitorsFrac = sessionsFrac * base.visitorsPerSession * vf;
    // Bounce rate is defined as bounces / sessions.
    // Cap daily bounce rate at 100% so bounces never exceed sessions.
    const bouncesFrac = sessionsFrac * Math.min(1, base.bounceRate * bf);
    const durationFrac = sessionsFrac * base.avgDurationMs * df;

    sumViews += viewsFrac;
    sumSessions += sessionsFrac;
    sumVisitors += visitorsFrac;
    sumBounces += bouncesFrac;
    sumDurationMs += durationFrac;
  }

  const views = Math.round(sumViews);
  const sessions = Math.max(views > 0 ? 1 : 0, Math.round(sumSessions));
  const visitors = Math.max(sessions > 0 ? 1 : 0, Math.round(sumVisitors));
  const bounces = Math.min(sessions, Math.round(sumBounces));
  const totalDurationMs = Math.round(sumDurationMs);
  const bounceRate = sessions > 0 ? Math.round((bounces / sessions) * 10000) / 10000 : 0;
  const avgDurationMs = sessions > 0 ? Math.round(totalDurationMs / sessions) : 0;

  return {
    views, sessions, visitors, bounces,
    totalDurationMs, avgDurationMs, bounceRate,
    approximateVisitors: false,
  };
}

function demoIntervalStepMs(interval: string): number {
  switch (interval) {
    case "minute": return 60_000;
    case "hour": return 3_600_000;
    case "week": return 7 * 86_400_000;
    case "month": return 30 * 86_400_000;
    default: return 86_400_000;
  }
}

// ---------------------------------------------------------------------------
//  Data generators (integration-based)
// ---------------------------------------------------------------------------

function generateDemoOverview(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = Number(params.from || 0);
  const to = Number(params.to || Date.now());
  const data = computeMetrics(siteId, from, to);
  const result: Record<string, unknown> = { ok: true, data };

  if (params.includeChange) {
    const span = to - from;
    const previousData = computeMetrics(siteId, Math.max(0, from - span), from);
    result.previousData = previousData;
    const cr = (cur: number, prev: number) =>
      prev === 0 ? null : Math.round(((cur - prev) / prev) * 10000) / 10000;
    result.changeRates = {
      views: cr(data.views, previousData.views),
      sessions: cr(data.sessions, previousData.sessions),
      visitors: cr(data.visitors, previousData.visitors),
      bounces: cr(data.bounces, previousData.bounces),
      bounceRate: cr(data.bounceRate, previousData.bounceRate),
      avgDurationMs: cr(data.avgDurationMs, previousData.avgDurationMs),
    };
  }

  if (params.includeDetail) {
    const interval = String(params.interval || "day");
    result.detail = {
      interval,
      data: generateTrendBuckets(siteId, from, to, interval),
    };
  }

  return result;
}

function generateTrendBuckets(siteId: string, from: number, to: number, interval: string) {
  const stepMs = demoIntervalStepMs(interval);
  const buckets: Array<{
    bucket: number; timestampMs: number;
    views: number; visitors: number; sessions: number;
    bounces: number; totalDurationMs: number; avgDurationMs: number;
    source: string;
  }> = [];

  for (let ts = from; ts < to; ts += stepMs) {
    const end = Math.min(ts + stepMs, to);
    const m = computeMetrics(siteId, ts, end);
    buckets.push({
      bucket: Math.floor(ts / stepMs),
      timestampMs: ts,
      views: m.views,
      visitors: m.visitors,
      sessions: m.sessions,
      bounces: m.bounces,
      totalDurationMs: m.totalDurationMs,
      avgDurationMs: m.avgDurationMs,
      source: "detail",
    });
  }

  return buckets;
}

function generateDemoTrend(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = Number(params.from || 0);
  const to = Number(params.to || Date.now());
  const interval = String(params.interval || "day");
  return { ok: true, interval, data: generateTrendBuckets(siteId, from, to, interval) };
}

function generateDemoPages(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const profile = findSiteProfile(siteId);
  const rng = createDemoRng(siteId, "pages");
  const limit = Number(params.limit || 100);
  const from = Number(params.from || 0);
  const to = Number(params.to || Date.now());
  const totalViews = integrateViews(siteId, from, to);
  const r = siteRatios(siteId);

  const expandedPaths = expandPathLabels(
    rng,
    profile.paths,
    Math.min(
      Math.max(18, profile.paths.length * 3),
      Math.max(limit, 18),
    ),
  );
  const count = Math.min(limit, expandedPaths.length);
  const dist = weightedDistribution(rng, expandedPaths, totalViews, count);

  const data = dist.map((d) => ({
    pathname: d.label,
    views: d.views,
    sessions: d.sessions,
  })).sort((a, b) => b.views - a.views);

  const pathTitleMap = new Map<string, string>();
  for (let index = 0; index < profile.paths.length; index += 1) {
    const path = normalizePath(profile.paths[index] || "");
    const title = String(profile.titles[index] || "").trim();
    if (!path) continue;
    pathTitleMap.set(path, title || titleFromPath(path));
  }

  // Generate tabs
  const pathTab = data.map((d) => ({ label: d.pathname, views: d.views, sessions: d.sessions }));
  const titleTab = data
    .slice(0, Math.min(limit, 28))
    .map((item) => ({
      label: pathTitleMap.get(item.pathname) ?? titleFromPath(item.pathname),
      views: item.views,
      sessions: item.sessions,
    }))
    .sort((left, right) => right.views - left.views);
  const hostTab = [{ label: profile.domain, views: totalViews, sessions: Math.round(totalViews * r.sessionsPerView) }];
  const topSlice = Math.max(5, Math.min(12, Math.round(data.length * 0.36)));
  const entryTab = data.slice(0, topSlice).map((d) => ({
    label: d.pathname,
    views: Math.round(d.views * (0.6 + rng() * 0.3)),
    sessions: Math.round(d.sessions * (0.6 + rng() * 0.3)),
  }));
  const exitTab = sShuffle(rng, [...data]).slice(0, topSlice).map((d) => ({
    label: d.pathname,
    views: Math.round(d.views * (0.3 + rng() * 0.4)),
    sessions: Math.round(d.sessions * (0.3 + rng() * 0.4)),
  }));

  return {
    ok: true,
    data,
    tabs: { path: pathTab, title: titleTab, hostname: hostTab, entry: entryTab, exit: exitTab },
  };
}

function generateDemoReferrers(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const profile = findSiteProfile(siteId);
  const rng = createDemoRng(siteId, "referrers");
  const limit = Number(params.limit || 100);
  const from = Number(params.from || 0);
  const to = Number(params.to || Date.now());
  const totalViews = integrateViews(siteId, from, to);

  const referrerPool = buildReferrerPool(
    rng,
    profile.topReferrers,
    Math.min(Math.max(14, profile.topReferrers.length + 12), Math.max(limit, 14)),
  );
  const dist = weightedDistributionFromWeights(
    rng,
    referrerPool,
    totalViews,
    Math.min(limit, referrerPool.length),
    [0.5, 0.86],
  );

  return {
    ok: true,
    data: dist.map((d) => ({
      referrer: d.label,
      views: d.views,
      sessions: d.sessions,
    })).sort((a, b) => b.views - a.views),
  };
}

function generateDemoVisitors(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const rng = createDemoRng(siteId, "visitors");
  const limit = Number(params.limit || 100);
  const from = Number(params.from || Date.now() - 7 * 24 * 3600 * 1000);
  const to = Number(params.to || Date.now());
  const span = to - from;

  const visitors: Array<{
    visitorId: string;
    firstSeenAt: number;
    lastSeenAt: number;
    views: number;
    sessions: number;
  }> = [];

  for (let i = 0; i < limit; i++) {
    const firstSeen = from + Math.round(rng() * span * 0.8);
    const lastSeen = firstSeen + Math.round(rng() * (to - firstSeen));
    const views = sInt(rng, 1, 25);
    const sessions = Math.max(1, Math.min(views, sInt(rng, 1, 8)));
    visitors.push({
      visitorId: `v-${siteId.slice(-3)}-${i.toString(36).padStart(3, "0")}`,
      firstSeenAt: firstSeen,
      lastSeenAt: lastSeen,
      views,
      sessions,
    });
  }

  return {
    ok: true,
    data: visitors.sort((a, b) => b.lastSeenAt - a.lastSeenAt),
  };
}

function generateDemoDimension(
  siteId: string,
  dimensionType: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const profile = findSiteProfile(siteId);
  const rng = createDemoRng(siteId, `dim-${dimensionType}`);
  const limit = Number(params.limit || 20);
  const from = Number(params.from || 0);
  const to = Number(params.to || Date.now());
  const totalViews = integrateViews(siteId, from, to);

  let dist: Array<{ label: string; views: number; sessions: number }>;
  if (dimensionType === "countries") {
    const countryPool = buildCountryPool(
      rng,
      profile.topCountries,
      Math.min(Math.max(14, profile.topCountries.length + 10), Math.max(limit, 14)),
    );
    dist = weightedDistributionFromWeights(
      rng,
      countryPool.map((item) => ({ label: item.code, weight: item.weight })),
      totalViews,
      Math.min(limit, countryPool.length),
      [0.48, 0.8],
    );
  } else if (dimensionType === "browsers") {
    dist = weightedDistributionFromWeights(
      rng,
      BROWSER_MARKET_WEIGHTS,
      totalViews,
      Math.min(limit, BROWSER_MARKET_WEIGHTS.length),
      [0.54, 0.88],
    );
  } else {
    let labels: string[];
    switch (dimensionType) {
      case "devices":
        labels = Object.keys(profile.deviceWeights);
        break;
      case "event-types":
        labels = profile.eventNames;
        break;
      default:
        labels = profile.topCountries.map((c) => c.code);
    }
    dist = weightedDistribution(rng, labels, totalViews, Math.min(limit, labels.length));
  }

  return {
    ok: true,
    data: dist.map((d) => ({
      value: d.label,
      views: d.views,
      sessions: d.sessions,
    })).sort((a, b) => b.views - a.views),
  };
}

function generateDemoClientDimensionTabs(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const profile = findSiteProfile(siteId);
  const rng = createDemoRng(siteId, "client-dims");
  const limit = Number(params.limit || 100);
  const from = Number(params.from || 0);
  const to = Number(params.to || Date.now());
  const totalViews = integrateViews(siteId, from, to);

  const mkTab = (labels: readonly string[], n: number) =>
    weightedDistribution(rng, labels, totalViews, Math.min(n, limit))
      .sort((a, b) => b.views - a.views);

  const mobileLikeShare = Math.max(
    0,
    Math.min(1, profile.deviceWeights.Mobile + profile.deviceWeights.Tablet * 0.45),
  );
  const browserPool = BROWSER_MARKET_WEIGHTS.map((item) => {
    let weight = item.weight;
    if (
      item.label.includes("Mobile")
      || item.label.includes("Samsung")
      || item.label.includes("UC")
      || item.label.includes("QQ")
      || item.label.includes("Huawei")
      || item.label.includes("Mi")
    ) {
      weight *= 0.7 + mobileLikeShare * 1.45;
    } else {
      weight *= 0.9 + (1 - mobileLikeShare) * 0.28;
    }
    return { label: item.label, weight };
  });
  const browserTab = weightedDistributionFromWeights(
    rng,
    browserPool,
    totalViews,
    Math.min(limit, Math.max(10, Math.min(18, browserPool.length))),
    [0.52, 0.88],
  ).sort((left, right) => right.views - left.views);

  const deviceLabels = Object.entries(profile.deviceWeights)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  const deviceTab = mkTab(deviceLabels, 3);

  return {
    ok: true,
    tabs: {
      browser: browserTab,
      osVersion: mkTab(ALL_OS, 12),
      deviceType: deviceTab,
      language: mkTab(ALL_LANGUAGES, 16),
      screenSize: mkTab(ALL_SCREEN_SIZES, 12),
    },
  };
}

function generateDemoGeoDimensionTabs(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const profile = findSiteProfile(siteId);
  const rng = createDemoRng(siteId, "geo-dims");
  const limit = Number(params.limit || 100);
  const from = Number(params.from || 0);
  const to = Number(params.to || Date.now());
  const totalViews = integrateViews(siteId, from, to);

  const mkTab = (labels: readonly string[], n: number) =>
    weightedDistribution(rng, labels, totalViews, Math.min(n, limit))
      .sort((a, b) => b.views - a.views);

  const countryPool = buildCountryPool(
    rng,
    profile.topCountries,
    Math.min(Math.max(16, profile.topCountries.length + 12), Math.max(limit, 16)),
  );
  const countryLabels = countryPool.map((item) => item.code);
  const regionLabels = filterGeoLabelsByCountries(ALL_REGIONS, countryLabels);
  const cityLabels = filterGeoLabelsByCountries(ALL_CITIES, countryLabels);
  const countryTab = weightedDistributionFromWeights(
    rng,
    countryPool.map((item) => ({ label: item.code, weight: item.weight })),
    totalViews,
    Math.min(limit, countryPool.length),
    [0.48, 0.8],
  ).sort((left, right) => right.views - left.views);

  return {
    ok: true,
    tabs: {
      country: countryTab,
      region: mkTab(regionLabels, Math.min(24, regionLabels.length)),
      city: mkTab(cityLabels, Math.min(32, cityLabels.length)),
      continent: mkTab(ALL_CONTINENTS, 6),
      timezone: mkTab(ALL_TIMEZONES, 18),
      organization: mkTab(ALL_ORGS, 18),
    },
  };
}

function generateDemoGeoPoints(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const profile = findSiteProfile(siteId);
  const rng = createDemoRng(siteId, "geo-points");
  const limit = Math.max(50, Math.min(20000, Number(params.limit || 5000)));
  const from = Number(params.from || Math.max(0, Date.now() - 24 * 3600 * 1000));
  const to = Number(params.to || Date.now());
  const span = Math.max(1, to - from);
  const totalViews = Math.max(0, integrateViews(siteId, from, to));
  const desired = Math.max(120, Math.round(Math.sqrt(totalViews + 1) * 28));
  const count = Math.min(limit, desired);
  const countryPool = buildCountryPool(
    rng,
    profile.topCountries,
    Math.min(34, Math.max(18, profile.topCountries.length + 14)),
  );
  const sessionSpace = Math.max(8, Math.round(count * 0.58));
  const visitorSpace = Math.max(6, Math.round(count * 0.43));

  const points: Array<{
    latitude: number;
    longitude: number;
    timestampMs: number;
    country: string;
  }> = [];
  const countryBuckets = new Map<
    string,
    { views: number; sessions: Set<string>; visitors: Set<string> }
  >();

  for (let index = 0; index < count; index += 1) {
    const countryCode = weightedPickCountry(rng, countryPool);
    const point = sampleGeoPointByCountry(rng, countryCode);
    const timestampMs = to - Math.round(rng() * span);
    points.push({
      latitude: point.latitude,
      longitude: point.longitude,
      timestampMs,
      country: countryCode,
    });

    const bucket = countryBuckets.get(countryCode) ?? {
      views: 0,
      sessions: new Set<string>(),
      visitors: new Set<string>(),
    };
    bucket.views += 1;
    const sessionId = `${countryCode}-s-${sInt(rng, 1, sessionSpace)}`;
    const visitorId = `${countryCode}-v-${sInt(rng, 1, visitorSpace)}`;
    bucket.sessions.add(sessionId);
    bucket.visitors.add(visitorId);
    countryBuckets.set(countryCode, bucket);
  }

  const countryCounts = Array.from(countryBuckets.entries())
    .map(([country, bucket]) => ({
      country,
      views: bucket.views,
      sessions: bucket.sessions.size,
      visitors: bucket.visitors.size,
    }))
    .sort((left, right) => right.views - left.views || left.country.localeCompare(right.country));

  return {
    ok: true,
    data: points.sort((left, right) => right.timestampMs - left.timestampMs),
    countryCounts,
  };
}

function generateDemoOverviewPanels(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const pages = generateDemoPages(siteId, { ...params, limit: 12 }) as {
    tabs: Record<string, unknown>;
  };
  const referrers = generateDemoReferrers(siteId, { ...params, limit: 12 }) as {
    data: unknown[];
  };
  const clientTabs = generateDemoClientDimensionTabs(siteId, params) as {
    tabs: Record<string, unknown>;
  };
  const geoTabs = generateDemoGeoDimensionTabs(siteId, params) as {
    tabs: Record<string, unknown>;
  };

  return {
    ok: true,
    pageTabs: pages.tabs,
    referrers: referrers.data,
    clientTabs: clientTabs.tabs,
    geoTabs: geoTabs.tabs,
  };
}

function generateDemoTeamDashboard(
  teamId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const teamSites = DEMO_SITE_PROFILES.filter((s) => s.teamId === teamId);
  const from = Number(params.from || 0);
  const to = Number(params.to || Date.now());
  const interval = String(params.interval || "day");
  const now = Date.now();
  const span = to - from;

  const sites = teamSites.map((site) => {
    const metrics = computeMetrics(site.id, from, to);
    const prevMetrics = computeMetrics(site.id, Math.max(0, from - span), from);
    const cr = (cur: number, prev: number) =>
      prev === 0 ? null : Math.round(((cur - prev) / prev) * 10000) / 10000;
    return {
      id: site.id,
      teamId: site.teamId,
      name: site.name,
      domain: site.domain,
      publicEnabled: 0,
      publicSlug: null,
      createdAt: now - 180 * 24 * 3600 * 1000,
      updatedAt: now - sInt(mulberry32(fnv1a(site.id)), 1, 14) * 24 * 3600 * 1000,
      overview: metrics,
      changeRates: {
        views: cr(metrics.views, prevMetrics.views),
        sessions: cr(metrics.sessions, prevMetrics.sessions),
        visitors: cr(metrics.visitors, prevMetrics.visitors),
        bounceRate: cr(metrics.bounceRate, prevMetrics.bounceRate),
        avgDurationMs: cr(metrics.avgDurationMs, prevMetrics.avgDurationMs),
        pagesPerSession: null,
      },
    };
  });

  const stepMs = demoIntervalStepMs(interval);
  const trend: Array<{ bucket: number; timestampMs: number; sites: Array<{ siteId: string; views: number; visitors: number }> }> = [];
  for (let ts = from; ts < to; ts += stepMs) {
    const end = Math.min(ts + stepMs, to);
    const sitesForBucket = teamSites.map((site) => {
      const views = integrateViews(site.id, ts, end);
      const r = siteRatios(site.id);
      const visitors = Math.max(views > 0 ? 1 : 0, Math.round(views * r.sessionsPerView * r.visitorsPerSession));
      return { siteId: site.id, views, visitors };
    });
    trend.push({ bucket: Math.floor(ts / stepMs), timestampMs: ts, sites: sitesForBucket });
  }

  return { ok: true, data: { sites, trend } };
}

// ---------------------------------------------------------------------------
//  Admin data generators (fixed structure)
// ---------------------------------------------------------------------------

function getDemoUser() {
  return {
    id: "demo-user-001",
    username: "demo",
    email: "demo@insightflare.app",
    name: "Demo User",
    systemRole: "admin" as const,
    createdAt: Date.now() - 180 * 24 * 3600 * 1000,
    updatedAt: Date.now() - 2 * 24 * 3600 * 1000,
    teamCount: 1,
    ownedTeamCount: 1,
  };
}

function getDemoTeams() {
  const now = Date.now();
  return DEMO_TEAMS.map((t) => {
    const teamSites = DEMO_SITE_PROFILES.filter((s) => s.teamId === t.id);
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      ownerUserId: t.ownerUserId,
      createdAt: now - 180 * 24 * 3600 * 1000,
      updatedAt: now - sInt(mulberry32(fnv1a(t.id)), 1, 30) * 24 * 3600 * 1000,
      siteCount: teamSites.length,
      memberCount: 1,
      membershipRole: "owner",
    };
  });
}

function getDemoSites(teamId: string) {
  const now = Date.now();
  return DEMO_SITE_PROFILES
    .filter((s) => s.teamId === teamId)
    .map((s) => ({
      id: s.id,
      teamId: s.teamId,
      name: s.name,
      domain: s.domain,
      publicEnabled: 0,
      publicSlug: null,
      createdAt: now - 180 * 24 * 3600 * 1000,
      updatedAt: now - sInt(mulberry32(fnv1a(s.id)), 1, 14) * 24 * 3600 * 1000,
    }));
}

function getDemoMembers(teamId: string) {
  const user = getDemoUser();
  return [
    {
      teamId,
      userId: user.id,
      role: "owner",
      joinedAt: user.createdAt,
      username: user.username,
      email: user.email,
      name: user.name,
    },
  ];
}

function getDemoSiteConfig() {
  return {
    trackingStrength: "smart" as const,
    trackQueryParams: true,
    trackHash: true,
    domainWhitelist: [] as string[],
    pathBlacklist: [] as string[],
    ignoreDoNotTrack: true,
  };
}

function getDemoScriptSnippet(siteId: string) {
  const edgeBase = process.env.NEXT_PUBLIC_INSIGHTFLARE_EDGE_URL
    || (typeof window !== "undefined" ? window.location.origin : "https://localhost:3000");
  const src = `${edgeBase.replace(/\/$/, "")}/script.js?siteId=${encodeURIComponent(siteId)}`;
  return {
    siteId,
    src,
    snippet: `<script defer src="${src}"></script>`,
  };
}

// ---------------------------------------------------------------------------
//  Route dispatcher — the single entry point for demo mode
// ---------------------------------------------------------------------------

export function handleDemoRequest(options: {
  path: string;
  method?: string;
  params?: Record<string, string | number>;
  body?: unknown;
}): unknown {
  const { path, method = "GET", params = {} } = options;
  const siteId = String(params.siteId || "demo-site-001");
  const teamId = String(params.teamId || "");

  // Write operations → read-only stub
  if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
    // Special cases that need real-looking responses
    if (path.includes("/auth/login")) {
      const user = getDemoUser();
      return { ok: true, data: { user, teams: getDemoTeams() } };
    }
    if (path.includes("/auth/me")) {
      const user = getDemoUser();
      return { ok: true, data: { user, teams: getDemoTeams() } };
    }
    if (path.includes("/profile")) {
      return { ok: true, data: getDemoUser() };
    }
    if (path.includes("/site-config")) {
      return { ok: true, data: getDemoSiteConfig() };
    }
    // Generic write → return empty success
    return { ok: true, data: {} };
  }

  // GET routes
  if (path.includes("/admin/auth/me")) {
    return { ok: true, data: { user: getDemoUser(), teams: getDemoTeams() } };
  }
  if (path.includes("/admin/users")) {
    return { ok: true, data: [getDemoUser()] };
  }
  if (path.includes("/admin/teams")) {
    return { ok: true, data: getDemoTeams() };
  }
  if (path.includes("/admin/sites")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: getDemoSites(tid) };
  }
  if (path.includes("/admin/members")) {
    const tid = teamId || getDemoTeams()[0].id;
    return { ok: true, data: getDemoMembers(tid) };
  }
  if (path.includes("/admin/site-config")) {
    return { ok: true, data: getDemoSiteConfig() };
  }
  if (path.includes("/admin/script-snippet")) {
    return { ok: true, data: getDemoScriptSnippet(siteId) };
  }

  // Analytics query routes
  if (path.includes("/overview-panels")) {
    return generateDemoOverviewPanels(siteId, params);
  }
  if (path.includes("/overview-client-dimensions")) {
    return generateDemoClientDimensionTabs(siteId, params);
  }
  if (path.includes("/overview-geo-dimensions")) {
    return generateDemoGeoDimensionTabs(siteId, params);
  }
  if (path.includes("/overview-geo-points")) {
    return generateDemoGeoPoints(siteId, params);
  }
  if (path.includes("/team-dashboard")) {
    const tid = teamId || getDemoTeams()[0].id;
    return generateDemoTeamDashboard(tid, params);
  }
  if (path.includes("/overview")) {
    return generateDemoOverview(siteId, params);
  }
  if (path.includes("/trend")) {
    return generateDemoTrend(siteId, params);
  }
  if (path.includes("/pages")) {
    return generateDemoPages(siteId, params);
  }
  if (path.includes("/referrers")) {
    return generateDemoReferrers(siteId, params);
  }
  if (path.includes("/visitors")) {
    return generateDemoVisitors(siteId, params);
  }
  if (path.includes("/countries")) {
    return generateDemoDimension(siteId, "countries", params);
  }
  if (path.includes("/devices")) {
    return generateDemoDimension(siteId, "devices", params);
  }
  if (path.includes("/browsers")) {
    return generateDemoDimension(siteId, "browsers", params);
  }
  if (path.includes("/event-types")) {
    return generateDemoDimension(siteId, "event-types", params);
  }

  // Public routes — delegate to same generators
  const publicMatch = path.match(/\/api\/public\/[^/]+\/(.*)/);
  if (publicMatch) {
    const subPath = publicMatch[1];
    if (subPath === "overview") return generateDemoOverview(siteId, params);
    if (subPath === "trend") return generateDemoTrend(siteId, params);
    if (subPath === "pages") return generateDemoPages(siteId, params);
    if (subPath === "referrers") return generateDemoReferrers(siteId, params);
  }

  // Fallback
  return { ok: true, data: {} };
}
