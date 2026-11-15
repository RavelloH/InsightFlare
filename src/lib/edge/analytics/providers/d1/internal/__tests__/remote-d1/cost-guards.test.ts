// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";

import { observeStatementAttempts } from "./cost-guards";
import {
  createRemoteD1Database,
  type RemoteStatementMeta,
} from "./remote-d1-database";

describe("cost failure evidence", () => {
  it("retains the completed D1 metadata and failed bound SQL while rethrowing timeout", async () => {
    // Every request is intercepted; this test neither loads credentials nor
    // contacts Cloudflare. The adapter still validates the returned metadata.
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                success: true,
                results: [{ value: 1 }],
                meta: {
                  rows_read: 3,
                  rows_written: 0,
                  timings: { sql_duration_ms: 2.5 },
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1031, message: "Query timed out" }],
          }),
        ),
      );
    const completed: RemoteStatementMeta[] = [];
    try {
      const observed = observeStatementAttempts(
        createRemoteD1Database({
          accountId: "mock-account",
          databaseId: "mock-database",
          token: "mock-token",
          onStatement: (meta) => completed.push(meta),
        }),
      );
      await observed.database.prepare("SELECT ? AS value").bind(1).all();
      await expect(
        observed.database.prepare("SELECT ? AS slow").bind("bound-value").all(),
      ).rejects.toThrow("Query timed out");
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        rowsRead: 3,
        rowsWritten: 0,
        sqlDurationMs: 2.5,
      });
      expect(observed.attempts).toMatchObject([
        { sql: "SELECT ? AS value", params: [1], status: "completed" },
        {
          sql: "SELECT ? AS slow",
          params: ["bound-value"],
          status: "failed",
          error: { message: expect.stringContaining("Query timed out") },
        },
      ]);
      expect(observed.attempts[1]).not.toHaveProperty("rowsRead");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      request.mockRestore();
    }
  });

  it("captures every bound statement in a real-engine batch and retains a failed batch", async () => {
    const local = createMigratedDatabase();
    try {
      const observed = observeStatementAttempts(createSqliteD1Database(local));
      expect(
        await observed.database.batch([
          observed.database.prepare("SELECT ? AS value").bind(2),
          observed.database.prepare("SELECT ? AS value").bind(3),
        ]),
      ).toHaveLength(2);
      await expect(
        observed.database.batch([
          observed.database.prepare("SELECT ? AS value").bind(4),
          observed.database
            .prepare("SELECT json_extract(?, '$') AS value")
            .bind("invalid-json"),
        ]),
      ).rejects.toThrow("malformed JSON");
      expect(
        observed.attempts.map(({ params, status }) => ({ params, status })),
      ).toEqual([
        { params: [2], status: "completed" },
        { params: [3], status: "completed" },
        { params: [4], status: "failed" },
        { params: ["invalid-json"], status: "failed" },
      ]);
    } finally {
      local.close();
    }
  });
});
