import "@/lib/analytics/time-zone";
import "@/lib/demo/admin/durable-objects";
import "@/lib/demo/admin/system-performance";
import "@/lib/demo/admin/users";
import "@/lib/demo/analytics";
import "@/lib/demo/data/site-profiles";
import "@/lib/demo/generators/utils";
import "@/lib/demo/realtime/dimension-pickers";
import "@/lib/demo/realtime/dimension-pools";
import "@/lib/demo/realtime/path-markov";
import "@/lib/demo/realtime/shared";
import "@/lib/demo/realtime/site-curves";
import "@/lib/demo/realtime/visitor-pool";

import { classifyTrafficChannel } from "@/lib/analytics/traffic-channel-rules";
import { browserEngineLabel } from "@/lib/browser-engine";
import { dashboardFilterPresentation } from "@/lib/dashboard/filter-state";
import { demoBadRequest } from "@/lib/demo/realtime/envelope";
import { createDemoCustomEventFacts } from "@/lib/demo/realtime/events-helpers";
import {
  aggregateDimensionRowsFromVisits,
  applyDemoFilters,
  buildDemoFactDataset,
  collectClientTabs,
  collectGeoTabs,
  collectPageDataAndTabs,
  collectReferrerRows,
} from "@/lib/demo/realtime/fact-builder";
import {
  DEMO_DIRECT_REFERRER_FILTER_VALUE,
  demoValuesIncludeSearch,
  normalizeDemoFilterValue,
  normalizeDemoSearch,
  parseDemoFilters,
  parseDemoLimit,
  parseDemoNumber,
} from "@/lib/demo/realtime/filters";
import type {
  DemoQueryFilters,
  DemoVisitFact,
} from "@/lib/demo/realtime/types";
import {
  demoHashFragmentForVisit,
  demoOperatingSystemLabel,
  demoQueryStringForVisit,
} from "@/lib/demo/realtime/visit-helpers";
import {
  analyticsFilterDefinition,
  type FilterDocument,
  type FilterExpression,
} from "@/lib/filter-contract";
function dedupeDemoFilterOptions(
  options: Array<{
    value: string;
    label: string;
    group?: "country" | "region" | "city";
  }>,
): Array<{
  value: string;
  label: string;
  group?: "country" | "region" | "city";
}> {
  const seen = new Set<string>();
  const deduped: Array<{
    value: string;
    label: string;
    group?: "country" | "region" | "city";
  }> = [];

  for (const option of options) {
    const value = String(option.value ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push({
      value,
      label: String(option.label ?? value).trim() || value,
      ...(option.group ? { group: option.group } : {}),
    });
  }

  return deduped;
}
function withoutDemoFilterKey(
  filters: DemoQueryFilters,
  key: keyof DemoQueryFilters,
): DemoQueryFilters {
  const { [key]: _, ...next } = filters;
  return next;
}
interface DemoFilterValueOption {
  readonly value: string;
  readonly label: string;
  readonly occurrences: number;
}
function filterValuesFromCandidates(
  candidates: Iterable<{
    readonly value: string;
    readonly label?: string;
    readonly occurrences?: number;
  }>,
  search: string,
  limit: number,
): DemoFilterValueOption[] {
  const rows = new Map<string, DemoFilterValueOption>();
  for (const candidate of candidates) {
    const value = String(candidate.value ?? "").trim();
    if (!value) continue;
    const label = String(candidate.label ?? value).trim() || value;
    if (!demoValuesIncludeSearch(search, [value, label])) continue;
    const current = rows.get(value);
    rows.set(value, {
      value,
      label,
      occurrences:
        (current?.occurrences ?? 0) + Math.max(0, candidate.occurrences ?? 1),
    });
  }
  return [...rows.values()]
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        left.label.localeCompare(right.label),
    )
    .slice(0, limit);
}
function withoutCanonicalField(
  expression: FilterExpression | null,
  field: string,
): FilterExpression | null {
  if (!expression) return null;
  if (expression.kind === "condition") {
    return expression.target.kind === "field" &&
      expression.target.field === field
      ? null
      : expression;
  }
  if (expression.kind === "not") {
    const child = withoutCanonicalField(expression.child, field);
    return child ? { ...expression, child } : null;
  }
  const children = expression.children
    .map((child) => withoutCanonicalField(child, field))
    .filter((child): child is FilterExpression => child !== null);
  if (children.length === 0) return null;
  return children.length === 1 ? children[0]! : { ...expression, children };
}
function withoutDemoCanonicalField(
  document: FilterDocument,
  field: string,
): FilterDocument {
  return { ...document, root: withoutCanonicalField(document.root, field) };
}
function filterValueForVisit(field: string, visit: DemoVisitFact): string {
  switch (field) {
    case "page.path":
      return visit.pathname;
    case "page.title":
      return visit.title;
    case "page.hostname":
      return visit.hostname;
    case "page.query":
      return demoQueryStringForVisit(visit);
    case "page.hash":
      return demoHashFragmentForVisit(visit);
    case "referrer.domain":
      return visit.referrerHost || DEMO_DIRECT_REFERRER_FILTER_VALUE;
    case "referrer.url":
      return visit.referrerUrl || DEMO_DIRECT_REFERRER_FILTER_VALUE;
    case "traffic.channel":
      return classifyTrafficChannel({
        referrerHost: visit.referrerHost,
        utmSource: visit.utmSource,
        utmMedium: visit.utmMedium,
        utmCampaign: visit.utmCampaign,
      });
    case "client.browser":
      return visit.browser;
    case "client.browserVersion":
      return visit.browserVersion;
    case "client.browserEngine":
      return browserEngineLabel(visit.browser, visit.osVersion);
    case "client.os":
      return demoOperatingSystemLabel(visit.osVersion);
    case "client.osVersion":
      return visit.osVersion;
    case "client.deviceType":
      return visit.deviceType;
    case "client.language":
      return visit.language;
    case "client.screenSize":
      return visit.screenSize;
    case "geo.country":
      return visit.country;
    case "geo.region":
      return visit.region;
    case "geo.city":
      return visit.city;
    case "geo.continent":
      return visit.continent;
    case "geo.timeZone":
      return visit.timezone;
    case "geo.organization":
      return visit.organization;
    default:
      return "";
  }
}
const DEMO_UTM_FILTER_VALUES: Readonly<Record<string, readonly string[]>> = {
  "utm.source": ["google", "newsletter", "partner", "github"],
  "utm.medium": ["organic", "email", "referral", "social"],
  "utm.campaign": ["launch", "docs", "pricing", "retention"],
  "utm.term": ["analytics", "observability", "product-led"],
  "utm.content": ["hero", "navigation", "cta", "release-note"],
};
/** Canonical candidate-value mock used by private, public, and API v1 routes. */
export function generateDemoFilterValues(
  siteId: string,
  params: Record<string, string | number>,
  audience:
    "private-dashboard" | "public-share" | "api-v1" = "private-dashboard",
):
  | (ReturnType<typeof demoBadRequest> & { data?: unknown })
  | (Record<string, unknown> & { data?: unknown }) {
  const field = normalizeDemoFilterValue(params.filterKey);
  const definition = field ? analyticsFilterDefinition(field) : undefined;
  if (
    !field ||
    !definition ||
    definition.source === "payload" ||
    !definition.audiences.has(audience)
  ) {
    return demoBadRequest("Invalid filter field");
  }

  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const parsedFilters = parseDemoFilters(params);
  const filterDocument = parsedFilters.filterDocument
    ? withoutDemoCanonicalField(parsedFilters.filterDocument, field)
    : undefined;
  const filters = filterDocument
    ? { filterDocument, ...dashboardFilterPresentation(filterDocument) }
    : parsedFilters;
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const search = normalizeDemoSearch(params);

  if (field === "event.name") {
    return {
      ok: true,
      field,
      data: filterValuesFromCandidates(
        createDemoCustomEventFacts(filtered.visits).map((event) => ({
          value: event.eventName,
        })),
        search,
        Math.max(500, filtered.visits.length),
      ),
    };
  }
  if (field === "session.entryPath" || field === "session.exitPath") {
    const key = field === "session.entryPath" ? "entryPath" : "exitPath";
    return {
      ok: true,
      field,
      data: filterValuesFromCandidates(
        [...filtered.sessions].flatMap((sessionId) => {
          const session = dataset.sessions.get(sessionId);
          return session ? [{ value: session[key] }] : [];
        }),
        search,
        Math.max(500, filtered.sessions.size),
      ),
    };
  }
  const utmValues = DEMO_UTM_FILTER_VALUES[field];
  if (utmValues) {
    return {
      ok: true,
      field,
      data: filterValuesFromCandidates(
        utmValues.map((value) => ({ value })),
        search,
        Math.max(500, utmValues.length),
      ),
    };
  }

  return {
    ok: true,
    field,
    data: filterValuesFromCandidates(
      filtered.visits.map((visit) => {
        const value = filterValueForVisit(field, visit);
        return {
          value,
          ...(value === DEMO_DIRECT_REFERRER_FILTER_VALUE
            ? { label: "Direct" }
            : {}),
        };
      }),
      search,
      Math.max(500, filtered.visits.length),
    ),
  };
}
function parseDemoFilterKey(
  params: Record<string, string | number>,
): keyof DemoQueryFilters | null {
  const raw = normalizeDemoFilterValue(params.filterKey);
  if (!raw) return null;
  const keys: Array<keyof DemoQueryFilters> = [
    "country",
    "device",
    "browser",
    "path",
    "title",
    "hostname",
    "entry",
    "exit",
    "sourceDomain",
    "sourceLink",
    "clientBrowser",
    "clientOsVersion",
    "clientDeviceType",
    "clientLanguage",
    "clientScreenSize",
    "geo",
    "geoContinent",
    "geoTimezone",
    "geoOrganization",
  ];
  return keys.includes(raw as keyof DemoQueryFilters)
    ? (raw as keyof DemoQueryFilters)
    : null;
}
export function generateDemoFilterOptions(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const filterKey = parseDemoFilterKey(params);
  if (!filterKey) {
    return { ok: false, data: [] };
  }
  const limit = parseDemoLimit(params.limit, 200, 1, 500);
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = withoutDemoFilterKey(parseDemoFilters(params), filterKey);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);

  if (filterKey === "country") {
    const rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      limit,
      (visit) => visit.country,
    );
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        rows.map((row) => ({
          value: row.label,
          label: row.label,
        })),
      ),
    };
  }
  if (filterKey === "device") {
    const rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      limit,
      (visit) => visit.deviceType,
    );
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        rows.map((row) => ({
          value: row.label,
          label: row.label,
        })),
      ),
    };
  }
  if (filterKey === "browser") {
    const rows = aggregateDimensionRowsFromVisits(
      dataset,
      filtered.visits,
      limit,
      (visit) => visit.browser,
    );
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        rows.map((row) => ({
          value: row.label,
          label: row.label,
        })),
      ),
    };
  }
  if (
    filterKey === "path" ||
    filterKey === "title" ||
    filterKey === "hostname" ||
    filterKey === "entry" ||
    filterKey === "exit"
  ) {
    const pages = collectPageDataAndTabs(dataset, filtered, limit);
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        (pages.tabs[filterKey] ?? []).map((row) => ({
          value: String(row.label ?? "").trim(),
          label: String(row.label ?? "").trim(),
        })),
      ),
    };
  }
  if (filterKey === "sourceDomain" || filterKey === "sourceLink") {
    const rows = collectReferrerRows(dataset, filtered, limit, {
      includeFullUrl: filterKey === "sourceLink",
      directValue: "",
    });
    const hasDirectReferrer = filtered.visits.some((visit) =>
      filterKey === "sourceLink"
        ? !visit.referrerUrl.trim()
        : !visit.referrerHost.trim(),
    );
    const options =
      rows.length === 0 && hasDirectReferrer
        ? [
            {
              value: DEMO_DIRECT_REFERRER_FILTER_VALUE,
              label: "Direct",
            },
          ]
        : rows.map((row) => {
            const value = String(row.referrer ?? "").trim();
            return value
              ? { value, label: value }
              : {
                  value: DEMO_DIRECT_REFERRER_FILTER_VALUE,
                  label: "Direct",
                };
          });
    return {
      ok: true,
      data: dedupeDemoFilterOptions(options),
    };
  }

  const clientTabs = collectClientTabs(dataset, filtered, limit);
  if (
    filterKey === "clientBrowser" ||
    filterKey === "clientOsVersion" ||
    filterKey === "clientDeviceType" ||
    filterKey === "clientLanguage" ||
    filterKey === "clientScreenSize"
  ) {
    const keyMap = {
      clientBrowser: "browser",
      clientOsVersion: "osVersion",
      clientDeviceType: "deviceType",
      clientLanguage: "language",
      clientScreenSize: "screenSize",
    } as const;
    const rows = clientTabs[keyMap[filterKey]] ?? [];
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        rows.map((row) => ({
          value: String(row.label ?? "").trim(),
          label: String(row.label ?? "").trim(),
        })),
      ),
    };
  }

  const geoTabs = collectGeoTabs(dataset, filtered, limit);
  if (filterKey === "geo") {
    return {
      ok: true,
      data: dedupeDemoFilterOptions([
        ...(geoTabs.country ?? []).map((row) => ({
          value: String(row.label ?? "").trim(),
          label: String(row.label ?? "").trim(),
          group: "country" as const,
        })),
        ...(geoTabs.region ?? []).map((row) => {
          const value = String(row.label ?? "").trim();
          const segments = value.split("::").map((segment) => segment.trim());
          return {
            value,
            label: segments[2] || segments[1] || segments[0] || value,
            group: "region" as const,
          };
        }),
        ...(geoTabs.city ?? []).map((row) => {
          const value = String(row.label ?? "").trim();
          const segments = value.split("::").map((segment) => segment.trim());
          return {
            value,
            label:
              segments[3] || segments[2] || segments[1] || segments[0] || value,
            group: "city" as const,
          };
        }),
      ]),
    };
  }

  if (
    filterKey === "geoContinent" ||
    filterKey === "geoTimezone" ||
    filterKey === "geoOrganization"
  ) {
    const keyMap = {
      geoContinent: "continent",
      geoTimezone: "timezone",
      geoOrganization: "organization",
    } as const;
    const rows = geoTabs[keyMap[filterKey]] ?? [];
    return {
      ok: true,
      data: dedupeDemoFilterOptions(
        rows.map((row) => ({
          value: String(row.label ?? "").trim(),
          label: String(row.label ?? "").trim(),
        })),
      ),
    };
  }

  return { ok: true, data: [] };
}
