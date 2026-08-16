import { parseGeoLocationValue } from "@/lib/dashboard/geo-location";

import { osVersionExpr, screenSizeExpr } from "./core-dimensions";
import {
  customEventJsonTypeCode,
  normalizeEventPayloadFilterPath,
  normalizeEventPayloadFilterValue,
} from "./core-parsers";
import {
  type DashboardFilters,
  DIRECT_REFERRER_FILTER_VALUE,
  type EventPayloadFilterValue,
  type EventRecordSortKey,
  type ListSort,
} from "./core-types";

export interface ParsedGeoFilter {
  country: string;
  regionCode?: string;
  regionName?: string;
  city?: string;
}

export function parseGeoFilterValue(
  value: string | undefined,
): ParsedGeoFilter | null {
  const parsed = parseGeoLocationValue(value);
  if (!parsed) return null;

  return {
    country: parsed.countryCode,
    ...(parsed.regionCode ? { regionCode: parsed.regionCode } : {}),
    ...(parsed.regionName ? { regionName: parsed.regionName } : {}),
    ...(parsed.level === "locality" && parsed.localityName
      ? { city: parsed.localityName }
      : {}),
  };
}

export function withoutGeoFilter(filters: DashboardFilters): DashboardFilters {
  return {
    ...filters,
    geo: undefined,
  };
}

export function buildVisitFilterSql(
  filters: DashboardFilters,
  alias = "visit_source",
): { clause: string; bindings: string[] } {
  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  const bindings: string[] = [];

  const equalsTrimmed = (column: string, value: string) => {
    clauses.push(`TRIM(COALESCE(${column}, '')) = ?`);
    bindings.push(value);
  };
  const equalsCaseInsensitive = (column: string, value: string) => {
    clauses.push(`LOWER(TRIM(COALESCE(${column}, ''))) = ?`);
    bindings.push(value.toLowerCase());
  };

  if (filters.country) {
    equalsCaseInsensitive(`${prefix}country`, filters.country);
  }
  if (filters.device) {
    equalsTrimmed(`${prefix}device_type`, filters.device);
  }
  if (filters.browser) {
    equalsTrimmed(`${prefix}browser`, filters.browser);
  }
  if (filters.path) {
    equalsTrimmed(`${prefix}pathname`, filters.path);
  }
  if (filters.query) {
    equalsTrimmed(`${prefix}query_string`, filters.query);
  }
  if (filters.title) {
    equalsTrimmed(`${prefix}title`, filters.title);
  }
  if (filters.hostname) {
    equalsCaseInsensitive(`${prefix}hostname`, filters.hostname);
  }
  if (filters.entry || filters.exit) {
    clauses.push(`TRIM(COALESCE(${prefix}session_id, '')) != ''`);
    const rankColumns = [
      ...(filters.entry
        ? [
            `ROW_NUMBER() OVER (
      PARTITION BY edge.session_id
      ORDER BY edge.started_at ASC, edge.visit_id ASC
    ) AS entry_rank`,
          ]
        : []),
      ...(filters.exit
        ? [
            `ROW_NUMBER() OVER (
      PARTITION BY edge.session_id
      ORDER BY edge.started_at DESC, edge.visit_id DESC
    ) AS exit_rank`,
          ]
        : []),
    ];
    const boundaryColumns = [
      ...(filters.entry
        ? ["MAX(CASE WHEN entry_rank = 1 THEN pathname END) AS entry_path"]
        : []),
      ...(filters.exit
        ? ["MAX(CASE WHEN exit_rank = 1 THEN pathname END) AS exit_path"]
        : []),
    ];
    const boundaryConditions = [
      ...(filters.entry ? ["COALESCE(entry_path, '') = ?"] : []),
      ...(filters.exit ? ["COALESCE(exit_path, '') = ?"] : []),
    ];
    clauses.push(`
${prefix}session_id IN (
  SELECT session_id
  FROM (
    SELECT
      session_id,
      ${boundaryColumns.join(",\n      ")}
    FROM (
      SELECT
        edge.session_id,
        edge.pathname,
        ${rankColumns.join(",\n        ")}
      FROM visit_source edge
      WHERE TRIM(COALESCE(edge.session_id, '')) != ''
    ) ranked_session_edges
    GROUP BY session_id
  ) session_boundaries
  WHERE ${boundaryConditions.join(" AND ")}
)`);
    if (filters.entry) bindings.push(filters.entry);
    if (filters.exit) bindings.push(filters.exit);
  }
  if (filters.sourceDomain) {
    if (filters.sourceDomain === DIRECT_REFERRER_FILTER_VALUE) {
      clauses.push(`TRIM(COALESCE(${prefix}referrer_host, '')) = ''`);
    } else {
      equalsCaseInsensitive(`${prefix}referrer_host`, filters.sourceDomain);
    }
  }
  if (filters.sourceLink) {
    if (filters.sourceLink === DIRECT_REFERRER_FILTER_VALUE) {
      clauses.push(`TRIM(COALESCE(${prefix}referrer_url, '')) = ''`);
    } else {
      equalsCaseInsensitive(`${prefix}referrer_url`, filters.sourceLink);
    }
  }
  if (filters.clientBrowser) {
    equalsTrimmed(`${prefix}browser`, filters.clientBrowser);
  }
  if (filters.clientOsVersion) {
    equalsTrimmed(osVersionExpr(alias), filters.clientOsVersion);
  }
  if (filters.clientDeviceType) {
    equalsTrimmed(`${prefix}device_type`, filters.clientDeviceType);
  }
  if (filters.clientLanguage) {
    equalsTrimmed(`${prefix}language`, filters.clientLanguage);
  }
  if (filters.clientScreenSize) {
    equalsTrimmed(screenSizeExpr(alias), filters.clientScreenSize);
  }
  if (filters.geoContinent) {
    equalsTrimmed(`${prefix}continent`, filters.geoContinent);
  }
  if (filters.geoTimezone) {
    equalsTrimmed(`${prefix}timezone`, filters.geoTimezone);
  }
  if (filters.geoOrganization) {
    equalsTrimmed(`${prefix}as_organization`, filters.geoOrganization);
  }

  const parsedGeo = parseGeoFilterValue(filters.geo);
  if (parsedGeo?.country) {
    equalsCaseInsensitive(`${prefix}country`, parsedGeo.country);
  }
  if (parsedGeo?.regionCode || parsedGeo?.regionName) {
    const geoRegionTokens = Array.from(
      new Set(
        [parsedGeo.regionCode, parsedGeo.regionName]
          .map((value) =>
            String(value ?? "")
              .trim()
              .toUpperCase(),
          )
          .filter((value) => value.length > 0),
      ),
    );
    if (geoRegionTokens.length > 0) {
      clauses.push(
        `UPPER(TRIM(CASE WHEN TRIM(COALESCE(${prefix}region_code, '')) != '' THEN ${prefix}region_code ELSE ${prefix}region END)) IN (${geoRegionTokens.map(() => "?").join(", ")})`,
      );
      bindings.push(...geoRegionTokens);
    }
  }
  if (parsedGeo?.city) {
    equalsCaseInsensitive(`${prefix}city`, parsedGeo.city);
  }

  return clauses.length > 0
    ? { clause: `WHERE ${clauses.join(" AND ")}`, bindings }
    : { clause: "", bindings: [] };
}

export function eventPayloadFilterValueType(
  value: EventPayloadFilterValue,
): "string" | "number" | "boolean" | "null" {
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

export function buildEventPayloadFilterSql(
  filters: DashboardFilters,
  alias = "es",
): { clauses: string[]; bindings: Array<string | number> } {
  const rules = filters.eventPayloadFilters ?? [];
  if (rules.length === 0) return { clauses: [], bindings: [] };

  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  const bindings: Array<string | number> = [];

  rules.forEach((rule, index) => {
    const path = normalizeEventPayloadFilterPath(rule.path);
    const value = normalizeEventPayloadFilterValue(rule.value);
    if (!path || value === undefined) return;

    const valueType = eventPayloadFilterValueType(value);
    const valueTypeCode = customEventJsonTypeCode(valueType);
    if (valueTypeCode === null) return;

    const valueAlias = `epv${index}`;
    const pathAlias = `epp${index}`;
    const operator = rule.operator === "ne" ? "!=" : "=";
    const baseCondition = `
      ${valueAlias}.event_pk = ${prefix}event_pk
      AND ${valueAlias}.site_id = ${prefix}site_id
      AND ${pathAlias}.path = ?`;

    if (valueType === "null") {
      clauses.push(`EXISTS (
        SELECT 1
        FROM custom_event_json_values ${valueAlias}
        INNER JOIN custom_event_json_paths ${pathAlias}
          ON ${pathAlias}.id = ${valueAlias}.path_id
        WHERE ${baseCondition}
          AND ${valueAlias}.value_type ${operator} ?
      )`);
      bindings.push(path, valueTypeCode);
      return;
    }

    let valueCondition = "";
    if (valueType === "string") {
      valueCondition = `COALESCE(${valueAlias}.string_value, '') ${operator} ?`;
      bindings.push(path, valueTypeCode, String(value));
    } else if (valueType === "number") {
      valueCondition = `${valueAlias}.number_value ${operator} ?`;
      bindings.push(path, valueTypeCode, Number(value));
    } else {
      valueCondition = `${valueAlias}.boolean_value ${operator} ?`;
      bindings.push(path, valueTypeCode, value ? 1 : 0);
    }

    clauses.push(`EXISTS (
      SELECT 1
      FROM custom_event_json_values ${valueAlias}
      INNER JOIN custom_event_json_paths ${pathAlias}
        ON ${pathAlias}.id = ${valueAlias}.path_id
      WHERE ${baseCondition}
        AND ${valueAlias}.value_type = ?
        AND ${valueCondition}
    )`);
  });

  return { clauses, bindings };
}

export function buildEventFilterSql(
  filters: DashboardFilters,
  alias = "es",
  options?: { eventName?: string; search?: string },
): { clause: string; bindings: Array<string | number> } {
  const visitFilter = buildVisitFilterSql(filters, alias);
  const clauses: string[] = visitFilter.clause
    ? [visitFilter.clause.replace(/^WHERE\s+/i, "")]
    : [];
  const bindings: Array<string | number> = [...visitFilter.bindings];
  const prefix = alias ? `${alias}.` : "";
  const payloadFilter = buildEventPayloadFilterSql(filters, alias);

  clauses.push(...payloadFilter.clauses);
  bindings.push(...payloadFilter.bindings);

  if (options?.eventName) {
    clauses.push(`TRIM(COALESCE(${prefix}event_name, '')) = ?`);
    bindings.push(options.eventName);
  }

  if (options?.search) {
    const token = `%${options.search.toLowerCase()}%`;
    clauses.push(
      `(
        LOWER(TRIM(COALESCE(${prefix}event_name, ''))) LIKE ?
        OR LOWER(TRIM(COALESCE(${prefix}event_id, ''))) LIKE ?
        OR LOWER(TRIM(COALESCE(${prefix}visit_id, ''))) LIKE ?
        OR LOWER(TRIM(COALESCE(${prefix}session_id, ''))) LIKE ?
        OR LOWER(TRIM(COALESCE(${prefix}visitor_id, ''))) LIKE ?
        OR LOWER(TRIM(COALESCE(${prefix}pathname, ''))) LIKE ?
        OR LOWER(TRIM(COALESCE(${prefix}title, ''))) LIKE ?
        OR LOWER(TRIM(COALESCE(${prefix}hostname, ''))) LIKE ?
      )`,
    );
    bindings.push(token, token, token, token, token, token, token, token);
  }

  return clauses.length > 0
    ? { clause: `WHERE ${clauses.join(" AND ")}`, bindings }
    : { clause: "", bindings };
}

export function eventRecordOrderBy(sort: ListSort<EventRecordSortKey>): string {
  const direction = sort.direction === "asc" ? "ASC" : "DESC";
  if (sort.key === "eventName") {
    return `eventName ${direction}, occurredAt DESC, eventId DESC, eventPk DESC`;
  }
  if (sort.key === "pathname") {
    return `pathname ${direction}, occurredAt DESC, eventId DESC, eventPk DESC`;
  }
  return `occurredAt ${direction}, eventId ${direction}, eventPk ${direction}`;
}
