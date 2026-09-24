import {
  applyDemoFilters,
  buildDemoFactDataset,
  weightedVisitorCount,
} from "@/lib/demo/realtime/fact-builder";
import { parseDemoFilters, parseDemoNumber } from "@/lib/demo/realtime/filters";
import {
  buildDemoTimeBuckets,
  findDemoTimeBucketIndex,
  parseDemoTimeZone,
} from "@/lib/demo/realtime/shared";
type DemoRetentionGranularity = "minute" | "hour" | "day" | "week" | "month";
function parseDemoRetentionGranularity(
  value: string | number | undefined,
): DemoRetentionGranularity {
  const normalized = String(value ?? "week")
    .trim()
    .toLowerCase();
  if (
    normalized === "minute" ||
    normalized === "hour" ||
    normalized === "day" ||
    normalized === "week" ||
    normalized === "month"
  ) {
    return normalized;
  }
  return "week";
}
export function generateDemoRetention(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, Date.now() - 30 * 24 * 3600 * 1000);
  const to = parseDemoNumber(params.to, Date.now());
  const granularity = parseDemoRetentionGranularity(params.granularity);
  const timeZone = parseDemoTimeZone(params);
  const buckets = buildDemoTimeBuckets(from, to, granularity, timeZone);
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);

  const cohortByVisitor = new Map<string, number>();
  for (const visit of filtered.visits) {
    const visitorId = visit.visitorId.trim();
    if (!visitorId) continue;
    const bucket = findDemoTimeBucketIndex(buckets, visit.startedAt);
    if (bucket === null) continue;
    const current = cohortByVisitor.get(visitorId);
    if (current === undefined || bucket < current) {
      cohortByVisitor.set(visitorId, bucket);
    }
  }

  const periodsByCohort = new Map<number, Map<number, Set<string>>>();
  for (const visit of filtered.visits) {
    const visitorId = visit.visitorId.trim();
    if (!visitorId) continue;
    const cohortBucket = cohortByVisitor.get(visitorId);
    if (cohortBucket === undefined) continue;
    const visitBucket = findDemoTimeBucketIndex(buckets, visit.startedAt);
    if (visitBucket === null) continue;
    const index = Math.max(0, visitBucket - cohortBucket);
    const cohortPeriods =
      periodsByCohort.get(cohortBucket) ?? new Map<number, Set<string>>();
    const visitorSet = cohortPeriods.get(index) ?? new Set<string>();
    visitorSet.add(visitorId);
    cohortPeriods.set(index, visitorSet);
    periodsByCohort.set(cohortBucket, cohortPeriods);
  }

  const cohorts = Array.from(periodsByCohort.entries())
    .sort(([leftBucket], [rightBucket]) => leftBucket - rightBucket)
    .map(([bucket, periods]) => {
      const size = Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, periods.get(0) ?? [])),
      );
      return {
        bucket: buckets[bucket]?.timestampMs ?? 0,
        size,
        periods: Array.from(periods.entries())
          .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
          .map(([index, visitorIds]) => {
            const visitors = Math.max(
              0,
              Math.round(weightedVisitorCount(dataset, visitorIds)),
            );
            return {
              index,
              visitors,
              rate: size > 0 ? visitors / size : 0,
            };
          }),
      };
    })
    .filter((cohort) => cohort.size > 0);

  return {
    ok: true,
    granularity,
    cohorts,
  };
}
