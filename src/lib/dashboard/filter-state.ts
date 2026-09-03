import {
  analyticsFilterRegistry,
  attachFilterScopePreference,
  type CanonicalJsonPath,
  FILTER_DOCUMENT_VERSION,
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterFieldId,
  filterFingerprint,
  filterScopePreferenceFromDocument,
  type FilterValue,
  normalizeFilterDocument,
  serializeFilterParams,
} from "@/lib/filter-contract";

import {
  buildRegionLocationValue,
  parseGeoLocationValue,
} from "./geo-location";

export const DASHBOARD_FILTER_CONTROL_KEYS = [
  "country",
  "device",
  "browser",
  "path",
  "query",
  "title",
  "hostname",
  "entry",
  "exit",
  "sourceDomain",
  "sourceLink",
  "channel",
  "clientBrowser",
  "clientOsVersion",
  "clientDeviceType",
  "clientLanguage",
  "clientScreenSize",
  "geo",
  "geoContinent",
  "geoTimezone",
  "geoOrganization",
] as const;

export type DashboardFilterControlKey =
  (typeof DASHBOARD_FILTER_CONTROL_KEYS)[number];

export type DashboardFilterPresentation = Partial<
  Record<DashboardFilterControlKey, string>
>;

const FIELD_BY_CONTROL_KEY: Readonly<
  Record<Exclude<DashboardFilterControlKey, "geo">, FilterFieldId>
> = {
  country: "geo.country" as FilterFieldId,
  device: "client.deviceType" as FilterFieldId,
  browser: "client.browser" as FilterFieldId,
  query: "page.query" as FilterFieldId,
  path: "page.path" as FilterFieldId,
  title: "page.title" as FilterFieldId,
  hostname: "page.hostname" as FilterFieldId,
  entry: "session.entryPath" as FilterFieldId,
  exit: "session.exitPath" as FilterFieldId,
  sourceDomain: "referrer.domain" as FilterFieldId,
  sourceLink: "referrer.url" as FilterFieldId,
  channel: "traffic.channel" as FilterFieldId,
  clientBrowser: "client.browser" as FilterFieldId,
  clientOsVersion: "client.osVersion" as FilterFieldId,
  clientDeviceType: "client.deviceType" as FilterFieldId,
  clientLanguage: "client.language" as FilterFieldId,
  clientScreenSize: "client.screenSize" as FilterFieldId,
  geoContinent: "geo.continent" as FilterFieldId,
  geoTimezone: "geo.timeZone" as FilterFieldId,
  geoOrganization: "geo.organization" as FilterFieldId,
};

export const EMPTY_DASHBOARD_FILTER_DOCUMENT: FilterDocument = Object.freeze({
  version: FILTER_DOCUMENT_VERSION,
  root: null,
});

function visitExpression(
  expression: FilterExpression | null,
  visit: (condition: FilterCondition) => void,
): void {
  if (!expression) return;
  if (expression.kind === "condition") {
    visit(expression);
    return;
  }
  if (expression.kind === "not") {
    // A negated condition is a query constraint, not a single selected value
    // that can be represented by a dashboard card's row highlight/filter.
    return;
  }
  expression.children.forEach((child) => visitExpression(child, visit));
}

function conditionValueForField(
  document: FilterDocument,
  field: FilterFieldId,
): string | undefined {
  let value: string | undefined;
  visitExpression(document.root, (condition) => {
    if (
      value !== undefined ||
      condition.target.kind !== "field" ||
      condition.target.field !== field ||
      condition.operator !== "eq" ||
      typeof condition.value !== "string"
    ) {
      return;
    }
    value = condition.value;
  });
  return value;
}

function withoutFields(
  expression: FilterExpression | null,
  fields: ReadonlySet<string>,
): FilterExpression | null {
  if (!expression) return null;
  if (expression.kind === "condition") {
    return expression.target.kind === "field" &&
      fields.has(expression.target.field)
      ? null
      : expression;
  }
  if (expression.kind === "not") {
    const child = withoutFields(expression.child, fields);
    return child ? { kind: "not", child } : null;
  }
  const children = expression.children
    .map((child) => withoutFields(child, fields))
    .filter((child): child is FilterExpression => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { kind: expression.kind, children };
}

function normalizedDocument(
  root: FilterExpression | null,
  source?: FilterDocument,
): FilterDocument {
  const normalized = normalizeFilterDocument(
    { version: FILTER_DOCUMENT_VERSION, root },
    analyticsFilterRegistry,
  );
  const preference = filterScopePreferenceFromDocument(source);
  return preference
    ? attachFilterScopePreference(normalized, preference)
    : normalized;
}

function geoConditions(value: string): FilterExpression | null {
  const parsed = parseGeoLocationValue(value);
  if (!parsed) return null;
  const conditions: FilterCondition[] = [
    {
      kind: "condition",
      target: { kind: "field", field: "geo.country" as FilterFieldId },
      operator: "eq",
      value: parsed.countryCode,
    },
  ];
  if (parsed.level !== "country") {
    conditions.push({
      kind: "condition",
      target: { kind: "field", field: "geo.region" as FilterFieldId },
      operator: "eq",
      value:
        parsed.regionName ||
        parsed.regionCode ||
        buildRegionLocationValue(
          parsed.countryCode,
          parsed.regionCode || parsed.regionName || "",
          parsed.regionName || parsed.regionCode || "",
        ),
    });
  }
  if (parsed.level === "locality" && parsed.localityName) {
    conditions.push({
      kind: "condition",
      target: { kind: "field", field: "geo.city" as FilterFieldId },
      operator: "eq",
      value: parsed.localityName,
    });
  }
  return conditions.length === 1
    ? conditions[0]!
    : { kind: "and", children: conditions };
}

function fieldsForControlKey(
  key: DashboardFilterControlKey,
): ReadonlySet<string> {
  if (key === "geo") {
    return new Set(["geo.country", "geo.region", "geo.city"]);
  }
  return new Set([FIELD_BY_CONTROL_KEY[key].toString()]);
}

export function dashboardFilterFieldId(
  key: Exclude<DashboardFilterControlKey, "geo">,
): FilterFieldId {
  return FIELD_BY_CONTROL_KEY[key];
}

export function dashboardFilterValue(
  document: FilterDocument,
  key: DashboardFilterControlKey,
): string | undefined {
  if (key !== "geo")
    return conditionValueForField(document, FIELD_BY_CONTROL_KEY[key]);
  const country = conditionValueForField(
    document,
    "geo.country" as FilterFieldId,
  );
  if (!country) return undefined;
  const region = conditionValueForField(
    document,
    "geo.region" as FilterFieldId,
  );
  const city = conditionValueForField(document, "geo.city" as FilterFieldId);
  if (!region) return country;
  if (!city) return `${country}::${region}`;
  return `${country}::${region}::${city}`;
}

export function dashboardFilterPresentation(
  document: FilterDocument,
): DashboardFilterPresentation {
  const result: DashboardFilterPresentation = {};
  for (const key of DASHBOARD_FILTER_CONTROL_KEYS) {
    const value = dashboardFilterValue(document, key);
    if (value) result[key] = value;
  }
  return result;
}

export function dashboardFilterDocumentFromPresentation(
  presentation: DashboardFilterPresentation,
): FilterDocument {
  let document = EMPTY_DASHBOARD_FILTER_DOCUMENT;
  for (const key of DASHBOARD_FILTER_CONTROL_KEYS) {
    const value = presentation[key];
    if (value) document = setDashboardFilterValue(document, key, value);
  }
  return document;
}

export function withoutDashboardFilter(
  document: FilterDocument,
  key: DashboardFilterControlKey,
): FilterDocument {
  return normalizedDocument(
    withoutFields(document.root, fieldsForControlKey(key)),
    document,
  );
}

export function setDashboardFilterValue(
  document: FilterDocument,
  key: DashboardFilterControlKey,
  rawValue: string | null | undefined,
): FilterDocument {
  const value = String(rawValue ?? "")
    .trim()
    .slice(0, 240);
  const base = withoutDashboardFilter(document, key);
  if (!value) return base;
  const expression =
    key === "geo"
      ? geoConditions(value)
      : {
          kind: "condition" as const,
          target: { kind: "field" as const, field: FIELD_BY_CONTROL_KEY[key] },
          operator: "eq" as const,
          value: value as FilterValue,
        };
  return expression
    ? normalizedDocument(
        base.root
          ? { kind: "and", children: [base.root, expression] }
          : expression,
        document,
      )
    : base;
}

export function dashboardFilterFingerprint(document: FilterDocument): string {
  return filterFingerprint(document, analyticsFilterRegistry);
}

/** Replaces only typed filter parameters and preserves unrelated URL state. */
export function withDashboardFilterSearchParams(
  searchParams: URLSearchParams,
  document: FilterDocument,
): URLSearchParams {
  const next = new URLSearchParams(searchParams.toString());
  for (const key of [...next.keys()]) {
    if (
      key.startsWith("filter[") ||
      DASHBOARD_FILTER_CONTROL_KEYS.includes(
        key as DashboardFilterControlKey,
      ) ||
      key === "geoCountry" ||
      key === "geoRegion" ||
      key === "geoCity"
    ) {
      next.delete(key);
    }
  }
  // A scope preference only has meaning together with an active filter. Keep
  // stale scope-only URLs from surviving when the last filter is removed.
  if (!document.root) next.delete("scope");
  for (const [key, value] of serializeFilterParams(
    document,
    analyticsFilterRegistry,
  )) {
    next.append(key, value);
  }
  return next;
}

/** Formats dashboard navigation query strings without escaping filter syntax. */
export function serializeDashboardSearchParams(
  searchParams: URLSearchParams,
): string {
  return [...searchParams]
    .map(([key, value]) => {
      const readableKey = encodeURIComponent(key)
        .replaceAll("%5B", "[")
        .replaceAll("%5D", "]")
        .replaceAll("%2F", "/")
        .replaceAll("%3A", ":");
      // Keep a terminal slash encoded. TanStack Router normalizes a raw
      // trailing slash in a query value (for example `filter[page.path]=/`)
      // to an empty value during client navigation. Interior slashes remain
      // readable, so ordinary paths such as `/politics` keep their existing
      // URL shape.
      const hasTerminalSlash = value.endsWith("/");
      const readableValue = encodeURIComponent(
        hasTerminalSlash ? value.slice(0, -1) : value,
      )
        .replaceAll("%3A", ":")
        .replaceAll("%2F", "/")
        .concat(hasTerminalSlash ? "%2F" : "");
      return `${readableKey}=${readableValue}`;
    })
    .join("&");
}

export function appendEventPayloadFilter(
  document: FilterDocument,
  path: string,
  operator: "eq" | "neq",
  value: FilterValue,
): FilterDocument {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const condition: FilterCondition = {
    kind: "condition",
    target: {
      kind: "event-payload",
      path: normalizedPath as CanonicalJsonPath,
    },
    operator,
    value,
  };
  return normalizedDocument(
    document.root
      ? { kind: "and", children: [document.root, condition] }
      : condition,
    document,
  );
}

export function dashboardFilterFieldsForControl(
  key: DashboardFilterControlKey,
): readonly string[] {
  return [...fieldsForControlKey(key)];
}
