import { isAnalyticsEngineDisabled } from "@/lib/edge/analytics-engine";
import type { InvocationLogger } from "@/lib/edge/observability-logger";
import type { Env, TrackerClientPayload } from "@/lib/edge/types";

import {
  REQUEST_ANALYTICS_SCHEMA_VERSION,
  REQUEST_FLAG_BOT_SCORE_PRESENT,
  REQUEST_FLAG_COORDINATE_PRESENT,
  REQUEST_FLAG_EDGE_LATENCY_PRESENT,
  REQUEST_FLAG_EVENT_AT_PRESENT,
  REQUEST_FLAG_QUIC_RTT_PRESENT,
  REQUEST_FLAG_TCP_RTT_PRESENT,
  REQUEST_FLAG_TLS_CLIENT_HELLO_LENGTH_PRESENT,
  type RequestAnalyticsInput,
  setRequestFlag,
} from "./request-schema";
import {
  cfAsn,
  cfBotScore,
  cfCoordinates,
  cfString,
  clampString,
  finiteNumber,
  nonNegativeNumber,
  payloadHostname,
  payloadPathname,
  requestCf,
  requestHeader,
  requestIp,
  requestMetadata,
  requestOrigin,
  resolveEdgeLatency,
  resolveEventAt,
  safeStringify,
  stringValue,
} from "./writer-utils";

export type { RequestAnalyticsInput } from "./request-schema";

export type RequestAnalyticsEnvironment = Env & {
  REQUEST_ANALYTICS?: AnalyticsEngineDataset;
};

export type RequestAnalyticsLogger = Pick<InvocationLogger, "warn" | "error"> &
  Partial<Pick<InvocationLogger, "info">>;

function requestCategory(input: RequestAnalyticsInput): string {
  return stringValue(input.category, 40);
}

function requestReasons(input: RequestAnalyticsInput): string {
  return clampString(
    input.reasons
      .map((reason) => stringValue(reason, 160))
      .filter(Boolean)
      .join(","),
    2_048,
  );
}

/**
 * Write the single request-level projection for a /collect request.
 *
 * The writer is intentionally synchronous: Analytics Engine writes are
 * best-effort and the collector must not wait for or depend on them.
 */
export function writeRequestAnalyticsPoint(
  env: RequestAnalyticsEnvironment,
  input: RequestAnalyticsInput,
  logger?: RequestAnalyticsLogger,
): void {
  if (isAnalyticsEngineDisabled(env)) return;

  const dataset = env.REQUEST_ANALYTICS;
  if (!dataset) {
    logger?.warn("collect.request_analytics_missing_binding");
    return;
  }

  try {
    const request = input.request;
    const payload: TrackerClientPayload = input.payload;
    const cf = requestCf(request);
    const userAgent = requestHeader(request, "user-agent", 1_024);
    const asn = cfAsn(cf);
    const coordinates = cfCoordinates(cf);
    const botScore = cfBotScore(cf);
    const tcpRtt = nonNegativeNumber(cf.clientTcpRtt);
    const quicRtt = nonNegativeNumber(cf.clientQuicRtt);
    const tlsClientHelloLength = nonNegativeNumber(cf.tlsClientHelloLength);
    const receivedAt = finiteNumber(input.receivedAt) ?? 0;
    const eventAt = resolveEventAt(payload, receivedAt);
    const edgeLatency = resolveEdgeLatency(input.receivedAt);
    const ip = input.category === "normal" ? "" : requestIp(request);

    let flags = 0;
    flags = setRequestFlag(
      flags,
      REQUEST_FLAG_EVENT_AT_PRESENT,
      eventAt.present,
    );
    flags = setRequestFlag(
      flags,
      REQUEST_FLAG_EDGE_LATENCY_PRESENT,
      edgeLatency.present,
    );
    flags = setRequestFlag(
      flags,
      REQUEST_FLAG_COORDINATE_PRESENT,
      coordinates !== null,
    );
    flags = setRequestFlag(
      flags,
      REQUEST_FLAG_BOT_SCORE_PRESENT,
      botScore !== null,
    );
    flags = setRequestFlag(
      flags,
      REQUEST_FLAG_TCP_RTT_PRESENT,
      tcpRtt !== null,
    );
    flags = setRequestFlag(
      flags,
      REQUEST_FLAG_QUIC_RTT_PRESENT,
      quicRtt !== null,
    );
    flags = setRequestFlag(
      flags,
      REQUEST_FLAG_TLS_CLIENT_HELLO_LENGTH_PRESENT,
      tlsClientHelloLength !== null,
    );

    const point = {
      // siteId is intentionally only index1; it is not a blob slot.
      indexes: [clampString(stringValue(input.siteId, 255) || "unknown", 255)],
      blobs: [
        stringValue(payload.kind, 40),
        requestCategory(input),
        requestReasons(input),
        ip,
        userAgent,
        requestOrigin(input.origin),
        payloadHostname(payload),
        payloadPathname(payload),
        cfString(cf, "country", 10),
        cfString(cf, "region", 128),
        cfString(cf, "city", 128),
        cfString(cf, "continent", 32),
        cfString(cf, "colo", 16),
        cfString(cf, "asOrganization", 255),
        cfString(cf, "verifiedBotCategory", 80),
        requestHeader(request, "cf-ray", 120),
        stringValue(input.traceId, 128),
        clampString(request.method, 16),
        cfString(cf, "httpProtocol", 40),
        safeStringify(requestMetadata(request, payload, cf)),
      ],
      doubles: [
        receivedAt,
        eventAt.value,
        edgeLatency.value,
        asn,
        coordinates?.latitude ?? 0,
        coordinates?.longitude ?? 0,
        botScore ?? 0,
        userAgent.length,
        tcpRtt ?? 0,
        quicRtt ?? 0,
        tlsClientHelloLength ?? 0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        flags,
        REQUEST_ANALYTICS_SCHEMA_VERSION,
      ],
    };

    dataset.writeDataPoint(point);
    logger?.info?.("collect.request_analytics_written");
  } catch (error) {
    void error;
    logger?.error("collect.request_analytics_write_failed");
  }
}
