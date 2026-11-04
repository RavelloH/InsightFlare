import { createDatabaseRuntime } from "@/lib/db";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

/** Test-only raw SQL executor for frozen pre-compiler query oracles. */
export async function queryLegacyD1All<Row extends object>(
  env: Env,
  sql: string,
  bindings: Array<string | number | null>,
): Promise<Row[]> {
  const result = await createDatabaseRuntime(env.DB).all<Row>({
    sql,
    bindings,
    tag: currentD1Operation() ?? "test.legacy-oracle.all",
  });
  return result.results;
}
