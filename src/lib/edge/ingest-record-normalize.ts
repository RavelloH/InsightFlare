import { UAParser } from "ua-parser-js";

import { visitorDailySaltSecret } from "@/lib/secrets";

import { mergeUaClientHintsIntoHeaders } from "./client-hints";
import { expandCustomEventData } from "./custom-event-json";
import {
  clampTimestamp,
  normalizePerformancePayload,
  resolveTrustedClientTimestamp,
} from "./ingest-normalize";
import type {
  BufferedCustomEventInput,
  NormalizeResult,
  RecentVisitorSession,
  StoredOpenVisit,
} from "./ingest-types";
import type {
  Env,
  IngestEnvelopePayload,
  NormalizedCustomEvent,
  NormalizedIdentify,
  NormalizedLeave,
  NormalizedPageview,
  NormalizedVisibility,
  TrackerClientPayload,
  TrackerPayloadKind,
} from "./types";
import {
  clampString,
  coerceNumber,
  coerceString,
  deriveEuVisitorId,
  deriveServerSessionId,
  isSameHostname,
  resolveSessionWindowMinutes,
  safeHostname,
} from "./utils";

interface NormalizeRecordContext {
  env: Pick<
    Env,
    "MAIN_SECRET" | "DAILY_SALT_SECRET" | "SESSION_WINDOW_MINUTES"
  >;
  getVisitContext(
    siteId: string,
    visitId: string,
  ): Promise<StoredOpenVisit | null>;
  findRecentVisitorSession(input: {
    siteId: string;
    visitorId: string;
    visitId: string;
    startedAt: number;
    sessionWindowMs: number;
    routePreviousHostname?: string;
    routePreviousPathname?: string;
    routePreviousQueryString?: string;
    routePreviousHashFragment?: string;
  }): Promise<RecentVisitorSession | null>;
  insertBufferedCustomEvent(record: BufferedCustomEventInput): boolean;
  ensureAlarm(): Promise<void>;
}

function parseUtmFromQuery(queryString: string): {
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
} {
  if (!queryString) {
    return {
      utmSource: "",
      utmMedium: "",
      utmCampaign: "",
      utmTerm: "",
      utmContent: "",
    };
  }
  const params = new URLSearchParams(queryString);
  return {
    utmSource: clampString(params.get("utm_source") || "", 255),
    utmMedium: clampString(params.get("utm_medium") || "", 255),
    utmCampaign: clampString(params.get("utm_campaign") || "", 255),
    utmTerm: clampString(params.get("utm_term") || "", 255),
    utmContent: clampString(params.get("utm_content") || "", 255),
  };
}

export async function normalizeIngestRecord(
  envelope: IngestEnvelopePayload,
  context: NormalizeRecordContext,
): Promise<NormalizeResult> {
  const client = envelope.client ?? ({} as TrackerClientPayload);
  const traceId = envelope.trace?.id || "";
  const siteId = clampString(coerceString(client.siteId), 120);
  if (!siteId) return { record: null, reason: "missing_site_id" };

  const requestHeaders = envelope.request.headers ?? {};
  const nowMs = Date.now();
  const receivedAt = clampTimestamp(envelope.request.receivedAt, nowMs);
  const eventAt = resolveTrustedClientTimestamp(client.timestamp, receivedAt);
  const visitorSecret = await visitorDailySaltSecret(context.env);
  if (!visitorSecret) {
    throw new Error(
      "MAIN_SECRET or DAILY_SALT_SECRET is required for visitor identity",
    );
  }
  const startedAt = Math.min(
    resolveTrustedClientTimestamp(client.startedAt, receivedAt, eventAt),
    eventAt,
  );
  const kind = clampString(coerceString(client.kind), 40) as TrackerPayloadKind;
  const visitId = clampString(coerceString(client.visitId), 128);

  const cf = envelope.request.cf ?? {};
  const uaRaw = clampString(
    coerceString(requestHeaders["user-agent"] ?? ""),
    1024,
  );
  const uaHeaders = mergeUaClientHintsIntoHeaders(
    requestHeaders,
    client.uaClientHints,
  );
  const ua = await new UAParser(uaHeaders).getResult().withClientHints();
  const isEU = Boolean(cf.isEUCountry);

  let visitorId = clampString(coerceString(client.visitorId), 128);
  if (isEU || !visitorId) {
    const ip = clampString(
      coerceString(
        requestHeaders["cf-connecting-ip"] ??
          requestHeaders["x-forwarded-for"] ??
          "",
      ),
      80,
    );
    visitorId = await deriveEuVisitorId({
      ip,
      ua: uaRaw,
      eventAtMs: eventAt,
      secret: visitorSecret,
    });
  }

  const contextGeoBase = {
    isEU,
    country: clampString(coerceString(cf.country ?? ""), 10),
    region: clampString(coerceString(cf.region ?? ""), 128),
    regionCode: clampString(coerceString(cf.regionCode ?? ""), 32),
    city: clampString(coerceString(cf.city ?? ""), 128),
    continent: clampString(coerceString(cf.continent ?? ""), 32),
    latitude: coerceNumber(cf.latitude, null),
    longitude: coerceNumber(cf.longitude, null),
    postalCode: clampString(coerceString(cf.postalCode ?? ""), 32),
    metroCode: clampString(coerceString(cf.metroCode ?? ""), 32),
    timezone: clampString(
      coerceString(client.timezone || cf.timezone || ""),
      120,
    ),
    asOrganization: clampString(coerceString(cf.asOrganization ?? ""), 255),
    uaRaw,
    browser: clampString(coerceString(ua.browser.name ?? ""), 80),
    browserVersion: clampString(coerceString(ua.browser.version ?? ""), 80),
    os: clampString(coerceString(ua.os.name ?? ""), 80),
    osVersion: clampString(coerceString(ua.os.version ?? ""), 80),
    deviceType: clampString(coerceString(ua.device.type ?? "desktop"), 40),
  };

  if (kind === "pageview") {
    if (!visitId) return { record: null, reason: "missing_visit_id" };
    const pathname = clampString(coerceString(client.pathname || "/"), 2048);
    const hostname = clampString(
      coerceString(client.hostname || ""),
      255,
    ).toLowerCase();
    if (!hostname) {
      return { record: null, reason: "missing_hostname" };
    }
    const rawReferrerUrl = clampString(coerceString(client.referrerUrl), 2000);
    const rawReferrerHost = clampString(
      safeHostname(rawReferrerUrl),
      255,
    ).toLowerCase();
    const referrerIsSameHostname = isSameHostname(rawReferrerHost, hostname);
    const referrerUrl = referrerIsSameHostname ? "" : rawReferrerUrl;
    const referrerHost = referrerIsSameHostname ? "" : rawReferrerHost;
    const navigationKind = clampString(coerceString(client.navigation), 40);
    let routePreviousHostname = "";
    let routePreviousPathname = "";
    let routePreviousQueryString = "";
    let routePreviousHashFragment = "";
    if (navigationKind === "route" && referrerIsSameHostname) {
      try {
        const routePreviousUrl = new URL(rawReferrerUrl);
        routePreviousHostname = clampString(routePreviousUrl.hostname, 255)
          .toLowerCase()
          .replace(/\.+$/, "");
        routePreviousPathname = clampString(
          routePreviousUrl.pathname || "/",
          2048,
        );
        routePreviousQueryString = clampString(
          routePreviousUrl.search || "",
          2048,
        );
        routePreviousHashFragment = clampString(
          routePreviousUrl.hash || "",
          1024,
        );
      } catch {
        routePreviousHostname = "";
        routePreviousPathname = "";
        routePreviousQueryString = "";
        routePreviousHashFragment = "";
      }
    }
    const sessionWindowMinutes = resolveSessionWindowMinutes(context.env);
    const recentSession = await context.findRecentVisitorSession({
      siteId,
      visitorId,
      visitId,
      startedAt,
      sessionWindowMs: sessionWindowMinutes * 60 * 1000,
      routePreviousHostname,
      routePreviousPathname,
      routePreviousQueryString,
      routePreviousHashFragment,
    });
    const sessionId =
      recentSession?.sessionId ||
      (await deriveServerSessionId({
        siteId,
        visitorId,
        visitId,
        startedAt,
        secret: visitorSecret,
      }));
    const recentStatus = recentSession?.status || "";
    const recentOpenVisit =
      recentSession?.visitId &&
      navigationKind === "route" &&
      Number(recentSession.routeMatch ?? 0) > 0 &&
      (recentStatus === "open" || recentStatus === "hidden_pending")
        ? recentSession
        : null;
    const queryString = clampString(coerceString(client.query || ""), 2048);
    return {
      record: {
        kind: "pageview",
        traceId,
        receivedAt,
        siteId,
        visitId,
        visitorId,
        sessionId,
        previousVisitId: recentOpenVisit?.visitId || "",
        previousVisitStartedAt: recentOpenVisit?.startedAt ?? null,
        startedAt,
        pathname,
        queryString,
        hashFragment: clampString(coerceString(client.hash || ""), 1024),
        hostname,
        title: clampString(coerceString(client.title || ""), 1024),
        referrerUrl,
        referrerHost,
        ...parseUtmFromQuery(queryString),
        userId:
          clampString(coerceString(client.userId || ""), 255) || undefined,
        userName:
          clampString(coerceString(client.userName || ""), 255) || undefined,
        screenWidth: coerceNumber(client.screenWidth, null),
        screenHeight: coerceNumber(client.screenHeight, null),
        language: clampString(coerceString(client.language || ""), 120),
        ...contextGeoBase,
      } satisfies NormalizedPageview,
    };
  }

  if (kind === "leave") {
    if (!visitId) return { record: null, reason: "missing_visit_id" };
    const performanceVisitId =
      clampString(coerceString(client.performanceVisitId), 128) || visitId;
    return {
      record: {
        kind: "leave",
        traceId,
        siteId,
        visitId,
        performanceVisitId,
        receivedAt,
        leaveAt: eventAt,
        durationMs: coerceNumber(client.durationMs, null),
        exitReason:
          clampString(coerceString(client.exitReason || ""), 40) || "pagehide",
        performance: normalizePerformancePayload(client.performance),
      } satisfies NormalizedLeave,
    };
  }

  if (kind === "visibility") {
    if (!visitId) return { record: null, reason: "missing_visit_id" };
    const visibilityState = clampString(
      coerceString(client.visibilityState || ""),
      20,
    );
    if (visibilityState !== "hidden" && visibilityState !== "visible") {
      return {
        record: null,
        reason: "invalid_visibility_state",
        detail: { visibilityState },
      };
    }
    return {
      record: {
        kind: "visibility",
        traceId,
        siteId,
        visitId,
        visibilityState,
        receivedAt,
        eventAt,
      } satisfies NormalizedVisibility,
    };
  }

  if (kind === "identify") {
    if (!visitId) return { record: null, reason: "missing_visit_id" };
    const identifyUserId = clampString(coerceString(client.userId || ""), 255);
    if (!identifyUserId) return { record: null, reason: "missing_user_id" };
    const identifyUserName = clampString(
      coerceString(client.userName || ""),
      255,
    );
    return {
      record: {
        kind: "identify",
        traceId,
        siteId,
        visitId,
        userId: identifyUserId,
        userName: identifyUserName,
        receivedAt,
      } satisfies NormalizedIdentify,
    };
  }

  if (kind === "custom_event") {
    if (!visitId) return { record: null, reason: "missing_visit_id" };
    const eventName = clampString(coerceString(client.eventName), 120);
    if (!eventName) return { record: null, reason: "missing_event_name" };
    const eventDataResult = expandCustomEventData(client.eventData);
    if (!eventDataResult.ok) {
      return {
        record: null,
        reason: "invalid_custom_event_data",
        detail: { error: eventDataResult.error },
      };
    }
    const visit = await context.getVisitContext(siteId, visitId);
    const sequence = 0;
    const eventId = clampString(
      coerceString(client.eventId || crypto.randomUUID()),
      128,
    );
    if (!visit) {
      const inserted = context.insertBufferedCustomEvent({
        eventId,
        siteId,
        visitId,
        occurredAt: eventAt,
        receivedAt,
        sequence,
        eventName,
        eventDataJson: eventDataResult.data.json,
        userId: clampString(coerceString(client.userId || ""), 255),
      });
      if (inserted) {
        await context.ensureAlarm();
      }
      return {
        record: null,
        reason: "waiting_for_visit",
        detail: { eventId, eventName, buffered: inserted },
      };
    }
    return {
      record: {
        kind: "custom_event",
        traceId,
        eventId,
        sequence,
        receivedAt,
        eventAt,
        eventName,
        eventDataJson: eventDataResult.data.json,
        siteId: visit.siteId,
        visitId: visit.visitId,
        visitorId: visit.visitorId,
        sessionId: visit.sessionId,
        startedAt: visit.startedAt,
        pathname: visit.pathname,
        queryString: visit.queryString,
        hashFragment: visit.hashFragment,
        hostname: visit.hostname,
        title: visit.title,
        referrerUrl: visit.referrerUrl,
        referrerHost: visit.referrerHost,
        utmSource: visit.utmSource,
        utmMedium: visit.utmMedium,
        utmCampaign: visit.utmCampaign,
        utmTerm: visit.utmTerm,
        utmContent: visit.utmContent,
        isEU: visit.isEU,
        country: visit.country,
        region: visit.region,
        regionCode: visit.regionCode,
        city: visit.city,
        continent: visit.continent,
        latitude: visit.latitude,
        longitude: visit.longitude,
        postalCode: visit.postalCode,
        metroCode: visit.metroCode,
        timezone: visit.timezone,
        asOrganization: visit.asOrganization,
        uaRaw: visit.uaRaw,
        browser: visit.browser,
        browserVersion: visit.browserVersion,
        os: visit.os,
        osVersion: visit.osVersion,
        deviceType: visit.deviceType,
        screenWidth: visit.screenWidth,
        screenHeight: visit.screenHeight,
        language: visit.language,
        userId:
          clampString(coerceString(client.userId || ""), 255) ||
          visit.userId ||
          undefined,
        userName:
          clampString(coerceString(client.userName || ""), 255) ||
          visit.userName ||
          undefined,
      } satisfies NormalizedCustomEvent,
    };
  }

  return { record: null, reason: "unsupported_kind", detail: { kind } };
}
