import type { CompiledQuery } from "@/lib/db";
import { createD1DatabaseClient } from "@/lib/db";
import {
  currentD1Operation,
  currentInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

import { type D1ReadDiagnostics, recordD1RowsRead } from "./diagnostics";

/** Execute a compiler-produced Analytics query through the shared D1 client. */
export async function queryD1CompiledAll<Row extends object>(
  env: Env,
  query: CompiledQuery<Row>,
  diagnostics?: D1ReadDiagnostics,
): Promise<Row[]> {
  return recordD1All(diagnostics, () =>
    createD1DatabaseClient(env.DB).all(query),
  );
}

async function recordD1All<Row extends object>(
  diagnostics: D1ReadDiagnostics | undefined,
  execute: () => Promise<D1Result<Row>>,
): Promise<Row[]> {
  const logger = currentInvocationLogger();
  const operation = currentD1Operation();
  const startedAt = globalThis.performance?.now() ?? Date.now();
  const result = await execute();
  const finishedAt = globalThis.performance?.now() ?? Date.now();
  recordD1RowsRead(diagnostics, result);
  if (logger && operation) {
    const rowsRead = result.meta?.rows_read;
    logger.recordD1Operation(operation, {
      durationMs: finishedAt - startedAt,
      ...(typeof rowsRead === "number" && Number.isFinite(rowsRead)
        ? { rowsRead: Math.max(0, Math.trunc(rowsRead)) }
        : {}),
      rowsReadAvailable:
        typeof rowsRead === "number" && Number.isFinite(rowsRead),
    });
  }
  // D1 normally always returns an array, but keep the shared source boundary
  // defensive when a test double or a transient adapter response omits results.
  // Providers should never leak an undefined collection into map/filter code.
  return Array.isArray(result.results) ? result.results : [];
}
