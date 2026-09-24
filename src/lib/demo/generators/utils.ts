export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function createDemoRng(siteId: string, endpoint: string): () => number {
  return mulberry32(fnv1a(`${todayKey()}:${siteId}:${endpoint}`));
}

/**
 * Stable bucket key for a time window. Rounds both endpoints to the nearest
 * minute so two calls that differ only by sub-second `Date.now()` drift land
 * in the same bucket — this keeps list and detail endpoints in sync even if
 * one of them falls back to `Date.now() - 7d ~ Date.now()`.
 *
 * Window length is preserved (the rounding is symmetric), so "today" and
 * "last 7 days" remain distinct buckets.
 */
export function windowBucket(from: number, to: number): string {
  const MIN_MS = 60_000;
  return `${Math.floor(from / MIN_MS)}:${Math.floor(to / MIN_MS)}`;
}

export function sInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function sFloat(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function sPick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function sShuffle<T>(rng: () => number, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function weightedDistribution(
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
    const views = Math.max(
      1,
      Math.round(((weights[i] ?? 0) / wSum) * total * (0.85 + rng() * 0.3)),
    );
    const sessions = Math.max(1, Math.round(views * (0.55 + rng() * 0.35)));
    return { label, views, sessions };
  });
}

export function weightedPickLabel(
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

export function weightedDistributionFromWeights(
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
    const sessions = Math.max(
      1,
      Math.min(views, Math.round(views * sessionRatio)),
    );
    return {
      label: item.label,
      views,
      sessions,
    };
  });
}

export function uniqueNonEmptyStrings(values: readonly string[]): string[] {
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

export function normalizePath(pathname: string): string {
  const normalized = String(pathname || "")
    .trim()
    .replace(/\/{2,}/g, "/");
  if (!normalized.startsWith("/")) return "";
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized || "/";
}

export function humanizeSlug(slug: string): string {
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

export function titleFromPath(pathname: string): string {
  if (pathname === "/") return "Home";
  const segments = pathname.split("/").filter(Boolean);
  const meaningful = segments[segments.length - 1] ?? segments[0] ?? "page";
  return humanizeSlug(meaningful);
}

export function expandPathLabels(
  rng: () => number,
  basePaths: readonly string[],
  desiredCount: number,
): string[] {
  const normalizedBase = uniqueNonEmptyStrings(
    basePaths
      .map((path) => normalizePath(path))
      .filter((path) => path.length > 0),
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

  const languagePrefixes = [
    "/en",
    "/de",
    "/fr",
    "/ja",
    "/zh",
    "/pt-br",
    "/es",
    "/it",
  ];
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
    if (
      stem.includes("/blog") ||
      stem.includes("/posts") ||
      stem.includes("/article")
    ) {
      candidates.push(
        `${stem}/weekly-roundup`,
        `${stem}/2026-trends`,
        `${stem}/editor-note`,
      );
    }
    if (
      stem.includes("/docs") ||
      stem.includes("/guides") ||
      stem.includes("/sdk") ||
      stem.includes("/api")
    ) {
      candidates.push(
        `${stem}/quickstart`,
        `${stem}/examples`,
        `${stem}/troubleshooting`,
      );
    }
    if (
      stem.includes("/products") ||
      stem.includes("/collections") ||
      stem.includes("/courses")
    ) {
      candidates.push(
        `${stem}/reviews`,
        `${stem}/specs`,
        `${stem}/compatibility`,
      );
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
    else if (candidateType === 1)
      candidate = `${base}/${tail}-${contentSuffix}`;
    else if (candidateType === 2) candidate = `${langPrefix}${base}`;
    else if (candidateType === 3)
      candidate = `${langPrefix}${base}/${contentSuffix}`;
    else if (candidateType === 4) candidate = `${base}-${sInt(rng, 2, 4)}`;
    else if (candidateType === 5)
      candidate = `${base}/${sInt(rng, 2024, 2026)}/${contentSuffix}`;
    else candidate = `${base}/${contentSuffix}/${sInt(rng, 1, 12)}`;
    addPath(candidate);
  }

  return output.slice(0, Math.max(1, desiredCount));
}
