import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DIAGNOSTIC_DAILY_LIMIT,
  type PerformanceDiagnosticInput,
  writePerformanceDiagnostic,
  writeSampledPerformanceDiagnostic,
} from "@/lib/edge/performance-diagnostics";
import type { Env } from "@/lib/edge/types";

interface AnalyticsDataPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

type AnalyticsWriter = (point: AnalyticsDataPoint) => void;

const baseInput: PerformanceDiagnosticInput = {
  route: "/api/private/v2/journeys",
  fingerprint: "sha256:abc123",
  cacheState: "miss",
  statusCode: 200,
  wallMs: 42.5,
  d1QueryCount: 3,
  d1RowsRead: 17,
  windowBucket: "30d",
  resultBucket: "small",
};

function env(writeDataPoint?: AnalyticsWriter, versionId?: string): Env {
  return {
    DB: {} as D1Database,
    INGEST_DO: {} as DurableObjectNamespace,
    QUERY_DIAGNOSTICS: writeDataPoint
      ? ({ writeDataPoint } as unknown as AnalyticsEngineDataset)
      : undefined,
    CF_VERSION_METADATA: versionId
      ? ({ id: versionId } as WorkerVersionMetadata)
      : undefined,
  } as Env;
}

describe("performance diagnostic sink", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  it("writes bounded, non-identifying request fields", () => {
    const writeDataPoint = vi.fn<AnalyticsWriter>();
    const result = writePerformanceDiagnostic(
      env(writeDataPoint, "version-42"),
      {
        ...baseInput,
        route:
          "https://edge.test/api/private/v2/journeys?siteId=secret-site#visitor-secret",
      },
    );

    expect(result).toBe(true);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint.mock.calls[0]?.[0]).toEqual({
      indexes: ["/api/private/v2/journeys", "sha256:abc123"],
      blobs: [
        "/api/private/v2/journeys",
        "sha256:abc123",
        "miss",
        "30d",
        "small",
        "version-42",
        "available",
      ],
      doubles: [1_700_000_000_000, 200, 42.5, 3, 17],
    });

    const point = JSON.stringify(writeDataPoint.mock.calls[0]?.[0]);
    expect(point).not.toContain("siteId");
    expect(point).not.toContain("secret-site");
    expect(point).not.toContain("visitor-secret");
  });

  it("replaces raw SQL and parameter text in the fingerprint with a token", () => {
    const writeDataPoint = vi.fn<AnalyticsWriter>();
    const result = writePerformanceDiagnostic(env(writeDataPoint), {
      ...baseInput,
      route: "/api/query?userId=private-user#fragment",
      fingerprint: "SELECT * FROM visits WHERE site_id = 'private-site'",
    });

    expect(result).toBe(true);
    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point?.indexes).toEqual(["/api/query", "unknown"]);
    expect(JSON.stringify(point)).not.toContain("SELECT");
    expect(JSON.stringify(point)).not.toContain("private-site");
    expect(JSON.stringify(point)).not.toContain("userId");
  });

  it("records unavailable rows and an unversioned deployment explicitly", () => {
    const writeDataPoint = vi.fn<AnalyticsWriter>();
    writePerformanceDiagnostic(env(writeDataPoint), {
      ...baseInput,
      d1RowsRead: null,
    });

    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point?.blobs).toContain("unversioned");
    expect(point?.blobs).toContain("unavailable");
    expect(point?.doubles.at(-1)).toBe(-1);
  });

  it("does not affect the request when the dataset is unbound", () => {
    expect(writePerformanceDiagnostic(env(), baseInput)).toBe(false);
  });

  it("samples before writing and fails closed when the sampler is unbound", async () => {
    const writeDataPoint = vi.fn<AnalyticsWriter>();
    const take = vi.fn().mockResolvedValue({ accepted: true });
    const getByName = vi.fn<(name: string) => { take: typeof take }>(() => ({
      take,
    }));
    const sampledEnv = {
      DIAGNOSTICS_SAMPLER: { getByName },
      QUERY_DIAGNOSTICS: { writeDataPoint },
    } as unknown as Env;

    await expect(
      writeSampledPerformanceDiagnostic(sampledEnv, {
        ...baseInput,
        route: "/api/private/v2/journeys?siteId=secret-site",
        fingerprint: "SELECT * FROM visits WHERE site_id = 'private-site'",
      }),
    ).resolves.toBe(true);
    expect(take).toHaveBeenCalledWith(DEFAULT_DIAGNOSTIC_DAILY_LIMIT);
    expect(getByName.mock.calls[0]?.[0]).not.toContain("secret-site");
    expect(getByName.mock.calls[0]?.[0]).not.toContain("SELECT");
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    await expect(
      writeSampledPerformanceDiagnostic(env(), baseInput),
    ).resolves.toBe(false);

    take.mockRejectedValueOnce(new Error("sampler unavailable"));
    await expect(
      writeSampledPerformanceDiagnostic(sampledEnv, baseInput),
    ).resolves.toBe(false);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
  });

  it("does not affect the request when writing fails and logs only a short token", () => {
    const writeDataPoint = vi.fn<AnalyticsWriter>(() => {
      throw new Error("dataset failed for /api/private?siteId=secret");
    });
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    expect(
      writePerformanceDiagnostic(env(writeDataPoint), {
        ...baseInput,
        route: "/api/private?siteId=secret",
      }),
    ).toBe(false);

    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({
        event: "performance_diagnostic_write_failed",
        fingerprint: "sha256:abc123",
      }),
    );
    const log = warning.mock.calls[0]?.[0] ?? "";
    expect(log).not.toContain("/api/private");
    expect(log).not.toContain("siteId");
    expect(log).not.toContain("dataset failed");
  });
});
