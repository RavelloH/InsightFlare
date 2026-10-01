import { createDatabaseRuntime } from "./d1-runtime";

/** Run the single supported D1 query-planner maintenance operation. */
export function optimizeD1Database(database: D1Database): Promise<D1Result> {
  return createDatabaseRuntime(database).run({
    sql: "PRAGMA optimize",
    tag: "scheduled_tasks.maintenance.optimize",
  });
}
