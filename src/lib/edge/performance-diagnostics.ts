import { diagnosticsSamplerName } from "./diagnostics-sampler";
import type { Env } from "./types";

export type PerformanceCacheState = "hit" | "miss" | "bypass";

export interface PerformanceDiagnosticInput {
  route: string;
  fingerprint: string;
  cacheState: PerformanceCacheState;
  statusCode: number;
  wallMs: number;
  d1QueryCount: number;
  d1RowsRead: number | null;
  windowBucket: string;
  resultBucket: string;
}

function bounded(value: string, max: number): string {
  return value.trim().slice(0, max);
}

const INVALID_FINGERPRINT = "unknown";
export const DEFAULT_DIAGNOSTIC_DAILY_LIMIT = 10_000;

/**
 * Keep the route dimension low-cardinality and independent from caller input.
 * Routes may be supplied as a path or as a server-generated token; absolute
 * URLs are reduced to their pathname and query/hash components are discarded.
 */
function routeToken(value: string): string {
  const raw = value.trim();
  if (!raw) return "unknown";

  // A route token is already safe to retain as-is. This also avoids turning
  // names such as "journey-v2" into a path accidentally.
  const token = raw.split(/[?#]/, 1)[0] ?? "";
  if (
    !token.includes("/") &&
    !token.includes("\\") &&
    /^[A-Za-z0-9._:-]+$/.test(token)
  ) {
    return bounded(token, 96) || "unknown";
  }

  try {
    const pathname = new URL(raw, "https://diagnostic.invalid").pathname;
    return bounded(pathname, 96) || "/";
  } catch {
    // URL parsing can fail for malformed input. Strip query/hash and any
    // authority prefix rather than allowing the original value through.
    const withoutQuery = token;
    const authorityEnd = withoutQuery.indexOf("//");
    if (authorityEnd >= 0) {
      const pathStart = withoutQuery.indexOf("/", authorityEnd + 2);
      return bounded(pathStart >= 0 ? withoutQuery.slice(pathStart) : "/", 96);
    }
    return bounded(withoutQuery, 96) || "unknown";
  }
}

/**
 * Fingerprints are server-generated opaque tokens. Reject SQL, parameters,
 * whitespace, and punctuation that could carry a raw query before writing.
 */
function fingerprintToken(value: string): string {
  const fingerprint = value.trim();
  if (!fingerprint) return INVALID_FINGERPRINT;
  if (!/^[A-Za-z0-9._:-]+$/.test(fingerprint)) return INVALID_FINGERPRINT;
  if (
    /^(?:select|insert|update|delete|replace|with|pragma|explain)(?:$|[._:-])/i.test(
      fingerprint,
    )
  ) {
    return INVALID_FINGERPRINT;
  }
  return bounded(fingerprint, 96) || INVALID_FINGERPRINT;
}

function versionToken(env: Env): string {
  const version = bounded(env.CF_VERSION_METADATA?.id ?? "", 96);
  return version || "unversioned";
}

/**
 * Emits one request-level, non-identifying performance observation. This is
 * deliberately best-effort: application responses must never depend on the
 * observability dataset being available.
 */
export function writePerformanceDiagnostic(
  env: Env,
  input: PerformanceDiagnosticInput,
): boolean {
  const dataset = env.QUERY_DIAGNOSTICS;
  if (!dataset) return false;
  const route = routeToken(input.route);
  const fingerprint = fingerprintToken(input.fingerprint);
  try {
    dataset.writeDataPoint({
      indexes: [route, fingerprint],
      blobs: [
        route,
        fingerprint,
        input.cacheState,
        bounded(input.windowBucket, 32),
        bounded(input.resultBucket, 32),
        versionToken(env),
        input.d1RowsRead === null ? "unavailable" : "available",
      ],
      doubles: [
        Date.now(),
        Math.max(0, Math.trunc(input.statusCode)),
        Math.max(0, input.wallMs),
        Math.max(0, Math.trunc(input.d1QueryCount)),
        input.d1RowsRead === null ? -1 : Math.max(0, input.d1RowsRead),
      ],
    });
    return true;
  } catch {
    console.warn(
      JSON.stringify({
        event: "performance_diagnostic_write_failed",
        fingerprint: fingerprint.slice(0, 24),
      }),
    );
    return false;
  }
}

/**
 * Applies the sharded, global daily quota before emitting the single request
 * event. Sampler errors fail closed so observation cannot become unbounded.
 */
export async function writeSampledPerformanceDiagnostic(
  env: Env,
  input: PerformanceDiagnosticInput,
  dailyLimit = DEFAULT_DIAGNOSTIC_DAILY_LIMIT,
): Promise<boolean> {
  const sampler = env.DIAGNOSTICS_SAMPLER;
  if (!sampler) return false;
  const route = routeToken(input.route);
  const fingerprint = fingerprintToken(input.fingerprint);
  try {
    const decision = await sampler
      .getByName(diagnosticsSamplerName(route, fingerprint))
      .take(dailyLimit);
    if (!decision.accepted) return false;
  } catch {
    console.warn(
      JSON.stringify({ event: "performance_diagnostic_sampler_failed" }),
    );
    return false;
  }
  return writePerformanceDiagnostic(env, input);
}
