import { demoPage } from "@/lib/demo/realtime/pagination";
import { generateDemoRequestObservationData } from "@/lib/demo/realtime/request-observation";

export function demoRequestObservationResponse(
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = Number(params.from);
  const to = Number(params.to);
  const requestedMinutes =
    Number.isFinite(from) && Number.isFinite(to) && to > from
      ? Math.ceil((to - from) / 60_000)
      : 60;
  const minutes =
    requestedMinutes <= 60
      ? 60
      : requestedMinutes <= 1440
        ? 1440
        : requestedMinutes <= 10080
          ? 10080
          : 43200;
  const data = generateDemoRequestObservationData(
    minutes,
    Number.isFinite(to) && to > 0 ? to : undefined,
  );
  const serializeDetailEvent = (event: Record<string, unknown>) => {
    const { sampleWeight: _sampleWeight, ...serialized } = event;
    return serialized;
  };
  const serializeListEvent = (
    event: Record<string, unknown>,
    source: "blocked" | "included",
  ) => {
    const shared = {
      timestamp: event.timestamp,
      receivedAt: event.receivedAt,
      siteId: event.siteId,
      siteName: event.siteName,
      siteDomain: event.siteDomain,
      kind: event.kind,
      category: event.category,
      disposition: event.disposition,
      pathname: event.pathname,
      country: event.country,
      region: event.region,
      asOrganization: event.asOrganization,
      asn: event.asn,
      rayId: event.rayId,
      traceId: event.traceId,
    };
    if (source === "blocked") {
      return {
        ...shared,
        reasons: event.reasons,
        ip: event.ip,
        userAgent: event.userAgent,
        verifiedBotCategory: event.verifiedBotCategory,
        botScore: event.botScore,
      };
    }
    return {
      ...shared,
      hostname: event.hostname,
      colo: event.colo,
      requestMethod: event.requestMethod,
      edgeLatencyMs: event.edgeLatencyMs,
    };
  };
  const blockedEvents = data.blockedEvents as unknown as Array<
    Record<string, unknown>
  >;
  const includedEvents = data.includedEvents as unknown as Array<
    Record<string, unknown>
  >;

  if (params.detail === "1") {
    const traceId = String(params.traceId || "");
    const rayId = String(params.rayId || "");
    const detail = [...blockedEvents, ...includedEvents].find(
      (event) => event.traceId === traceId || event.rayId === rayId,
    );
    return {
      ok: true,
      configured: data.configured,
      generatedAt: data.generatedAt,
      sampling: data.sampling,
      detail: detail ? serializeDetailEvent(detail) : null,
    };
  }

  const rawPage = String(params.source || "");
  const source =
    rawPage === "abnormal"
      ? "blocked"
      : rawPage === "normal"
        ? "included"
        : rawPage;
  const events = source === "included" ? includedEvents : blockedEvents;
  if (source === "blocked" || source === "included") {
    const page = demoPage(
      events,
      params,
      {
        operation: "request-observation-events",
        source,
        from,
        to,
        interval: minutes,
        order: "timestamp:desc,receivedAt:desc,traceId:desc,rayId:desc",
      },
      parseRequestObservationLimit(params.limit),
      100,
    );
    return {
      ok: true,
      configured: data.configured,
      generatedAt: data.generatedAt,
      sampling: data.sampling,
      source,
      data: {
        items: page.items.map((event) => serializeListEvent(event, source)),
        pagination: page.pagination,
      },
    };
  }

  if (params.dimensionTab) {
    const group = String(params.dimensionGroup || "");
    const tab = String(params.dimensionTab);
    const rawDimensionSource = String(params.dimensionSource || "blocked");
    const dimensionSource =
      rawDimensionSource === "abnormal"
        ? "blocked"
        : rawDimensionSource === "normal"
          ? "included"
          : rawDimensionSource === "included"
            ? "included"
            : "blocked";
    const dimensionEvents =
      dimensionSource === "included" ? includedEvents : blockedEvents;
    const counts = new Map<
      string,
      DemoRequestObservationDimensionValue & {
        count: number;
        botCount: number;
      }
    >();
    for (const event of dimensionEvents) {
      for (const value of demoRequestObservationDimensionValues(
        event,
        group,
        tab,
      )) {
        const current = counts.get(value.key) ?? {
          ...value,
          count: 0,
          botCount: 0,
        };
        const sampleWeight = Math.max(1, Number(event.sampleWeight) || 1);
        current.count += sampleWeight;
        if (event.category === "bot") current.botCount += sampleWeight;
        counts.set(value.key, current);
      }
    }
    return {
      ok: true,
      sampling: data.sampling,
      dimension: {
        group,
        tab,
        source: dimensionSource,
        rows: [...counts.entries()]
          .map(([key, value]) => ({
            key,
            label: value.label,
            count: value.count,
            botCount: value.botCount,
            ...(value.iconLabel ? { iconLabel: value.iconLabel } : {}),
            ...(value.country ? { country: value.country } : {}),
            ...(value.region ? { region: value.region } : {}),
          }))
          .sort((left, right) => right.count - left.count)
          .slice(0, 30),
      },
    };
  }

  const blockedPage = demoPage(
    blockedEvents,
    params,
    {
      operation: "request-observation-events",
      source: "blocked",
      from,
      to,
      interval: minutes,
      order: "timestamp:desc,receivedAt:desc,traceId:desc,rayId:desc",
    },
    parseRequestObservationLimit(params.limit),
    100,
  );
  const includedPage = demoPage(
    includedEvents,
    params,
    {
      operation: "request-observation-events",
      source: "included",
      from,
      to,
      interval: minutes,
      order: "timestamp:desc,receivedAt:desc,traceId:desc,rayId:desc",
    },
    parseRequestObservationLimit(params.limit),
    100,
  );
  const serializedBlockedEvents = blockedPage.items.map((event) =>
    serializeListEvent(event, "blocked"),
  );
  const serializedIncludedEvents = includedPage.items.map((event) =>
    serializeListEvent(event, "included"),
  );

  return {
    ...data,
    events: serializedBlockedEvents,
    normalEvents: serializedIncludedEvents.filter(
      (event) => event.category === "normal",
    ),
    blockedEvents: serializedBlockedEvents,
    includedEvents: serializedIncludedEvents,
    blocked: {
      ...data.blocked,
      events: serializedBlockedEvents,
      pagination: blockedPage.pagination,
    },
    included: {
      ...data.included,
      events: serializedIncludedEvents,
      pagination: includedPage.pagination,
    },
  };
}

interface DemoRequestObservationDimensionValue {
  key: string;
  label: string;
  iconLabel?: string;
  country?: string;
  region?: string;
}

function demoDimensionString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function demoBotScoreBucket(value: unknown): string {
  const score = Number(value);
  if (!Number.isFinite(score) || score <= 0) return "";
  if (score < 20) return "1-19";
  if (score < 40) return "20-39";
  if (score < 60) return "40-59";
  if (score < 80) return "60-79";
  return "80-99";
}

function demoUserAgentLengthBucket(value: unknown): string {
  const length = Number(value);
  if (!Number.isFinite(length) || length <= 0) return "";
  if (length < 80) return "1-79";
  if (length < 160) return "80-159";
  if (length < 256) return "160-255";
  if (length < 512) return "256-511";
  return "512+";
}

function demoIpPrefix(value: unknown): string {
  const ip = demoDimensionString(value);
  const ipv4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.0/24`;
  if (ip.includes(":")) {
    const parts = ip.split(":").filter(Boolean);
    if (parts.length >= 4) return `${parts.slice(0, 4).join(":")}::/64`;
  }
  return ip;
}

function demoRequestObservationDimensionValue(
  value: unknown,
  options?: Pick<
    DemoRequestObservationDimensionValue,
    "iconLabel" | "country" | "region"
  >,
): DemoRequestObservationDimensionValue {
  const label = demoDimensionString(value) || "Unknown";
  return {
    key: label,
    label,
    ...options,
  };
}

function demoRequestObservationDimensionValues(
  event: Record<string, unknown>,
  group: string,
  tab: string,
): DemoRequestObservationDimensionValue[] {
  if (group === "detection") {
    if (tab === "reason") {
      const reasons = Array.isArray(event.reasons)
        ? event.reasons.map(demoDimensionString).filter(Boolean)
        : demoDimensionString(event.reasons)
            .split(",")
            .map((reason) => reason.trim())
            .filter(Boolean);
      return [demoRequestObservationDimensionValue(reasons.join(","))];
    }
    if (tab === "category") {
      const category = demoDimensionString(event.category);
      return [demoRequestObservationDimensionValue(category)];
    }
    if (tab === "kind") {
      return [demoRequestObservationDimensionValue(event.kind)];
    }
    if (tab === "botScoreBucket") {
      return [
        demoRequestObservationDimensionValue(
          demoBotScoreBucket(event.botScore),
        ),
      ];
    }
    if (tab === "verifiedBotCategory") {
      return [demoRequestObservationDimensionValue(event.verifiedBotCategory)];
    }
  }

  if (group === "target") {
    if (tab === "site") {
      const siteId = demoDimensionString(event.siteId);
      const siteName =
        demoDimensionString(event.siteName) ||
        demoDimensionString(event.siteDomain) ||
        siteId;
      return [
        demoRequestObservationDimensionValue(siteName, {
          iconLabel: demoDimensionString(event.siteDomain) || undefined,
        }),
      ].map((value) => ({ ...value, key: siteId || value.key }));
    }
    if (tab === "hostname") {
      return [demoRequestObservationDimensionValue(event.hostname)];
    }
    if (tab === "pathname") {
      return [
        demoRequestObservationDimensionValue(
          demoDimensionString(event.pathname) || "/",
        ),
      ];
    }
    if (tab === "origin") {
      return [demoRequestObservationDimensionValue(event.origin)];
    }
  }

  if (group === "network") {
    if (tab === "asOrganization") {
      return [demoRequestObservationDimensionValue(event.asOrganization)];
    }
    if (tab === "asn") {
      return [demoRequestObservationDimensionValue(event.asn)];
    }
    if (tab === "country") {
      return [demoRequestObservationDimensionValue(event.country)];
    }
    if (tab === "region") {
      return [
        demoRequestObservationDimensionValue(event.region, {
          country: demoDimensionString(event.country) || undefined,
        }),
      ];
    }
    if (tab === "city") {
      return [
        demoRequestObservationDimensionValue(event.city, {
          country: demoDimensionString(event.country) || undefined,
          region: demoDimensionString(event.region) || undefined,
        }),
      ];
    }
    if (tab === "colo") {
      return [demoRequestObservationDimensionValue(event.colo)];
    }
  }

  if (group === "client") {
    if (tab === "ip") {
      return [demoRequestObservationDimensionValue(event.ip)];
    }
    if (tab === "userAgent") {
      return [demoRequestObservationDimensionValue(event.userAgent)];
    }
    if (tab === "userAgentLengthBucket") {
      return [
        demoRequestObservationDimensionValue(
          demoUserAgentLengthBucket(event.userAgentLength),
        ),
      ];
    }
    if (tab === "ipPrefix") {
      return [demoRequestObservationDimensionValue(demoIpPrefix(event.ip))];
    }
  }

  return [demoRequestObservationDimensionValue(event[tab])];
}

const DEMO_REQUEST_OBSERVATION_DEFAULT_LIMIT = 50;

function parseRequestObservationLimit(value: unknown): number {
  const parsed = Number(value);
  return Math.max(
    1,
    Math.min(
      100,
      Number.isFinite(parsed)
        ? Math.trunc(parsed)
        : DEMO_REQUEST_OBSERVATION_DEFAULT_LIMIT,
    ),
  );
}
