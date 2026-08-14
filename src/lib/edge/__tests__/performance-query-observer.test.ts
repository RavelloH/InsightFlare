import { describe, expect, it, vi } from "vitest";

import {
  completePerformanceQueryObservation,
  createPerformanceQueryObserver,
  recordD1All,
  recordD1Batch,
  recordD1FirstOrRun,
} from "@/lib/edge/performance-query-observer";

const writeDataPoint = vi.fn();
const env = {
  QUERY_DIAGNOSTICS: { writeDataPoint },
} as never;

describe("PerformanceQueryObserver", () => {
  it("accumulates observable D1 rows", () => {
    const observer = createPerformanceQueryObserver("journey-v2", "detail");

    recordD1All(observer, { meta: { rows_read: 12.9 } });
    recordD1All(observer, { meta: { rows_read: 3 } });

    expect(observer).toMatchObject({
      d1QueryCount: 2,
      d1RowsRead: 15,
      rowsReadAvailable: true,
    });
  });

  it("fails the whole request closed when an all result lacks metadata", () => {
    const observer = createPerformanceQueryObserver("task-v2", "group-list");

    recordD1All(observer, { meta: { rows_read: 25 } });
    recordD1All(observer, { meta: {} });

    expect(observer).toMatchObject({
      d1QueryCount: 2,
      d1RowsRead: 25,
      rowsReadAvailable: false,
    });
  });

  it("fails the whole request closed for first, run, and batch calls", () => {
    const observer = createPerformanceQueryObserver("task-v2", "group-list");

    recordD1All(observer, { meta: { rows_read: 25 } });
    recordD1FirstOrRun(observer);
    recordD1FirstOrRun(observer);
    recordD1Batch(observer, 3);

    expect(observer).toMatchObject({
      d1QueryCount: 6,
      d1RowsRead: 25,
      rowsReadAvailable: false,
    });
  });

  it("writes exactly one request-level observation", () => {
    const observer = createPerformanceQueryObserver(
      "/api/task-v2?account=secret",
      "SELECT * FROM sessions",
    );
    recordD1All(observer, { meta: { rows_read: 42 } });

    const emitted = completePerformanceQueryObservation(env, observer, {
      resultBucket: "1-25",
      statusCode: 200,
      windowBucket: "30d",
    });

    expect(emitted).toBe(true);
    expect(
      completePerformanceQueryObservation(env, observer, {
        resultBucket: "1-25",
        statusCode: 200,
        windowBucket: "30d",
      }),
    ).toBe(false);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint.mock.calls[0]?.[0].indexes).toEqual([
      "/api/task-v2",
      "unknown",
    ]);
    expect(writeDataPoint.mock.calls[0]?.[0].doubles.slice(1)).toEqual([
      200, 0, 1, 42,
    ]);
  });
});
