import { createDatabaseRuntime } from "@/lib/db/d1-runtime";
import type { CompiledMutation } from "@/lib/db/mutation/plan";
import type { DatabaseRuntime } from "@/lib/db/types";

import type { CompiledQuery } from "./compiled";

export interface DatabaseClient {
  all<Row extends object>(query: CompiledQuery<Row>): Promise<D1Result<Row>>;
  first<Row extends object>(query: CompiledQuery<Row>): Promise<Row | null>;
  run(mutation: CompiledMutation): Promise<D1Result>;
  batch(mutations: readonly CompiledMutation[]): Promise<readonly D1Result[]>;
}

export function createDatabaseClient(runtime: DatabaseRuntime): DatabaseClient {
  return {
    all<Row extends object>(query: CompiledQuery<Row>): Promise<D1Result<Row>> {
      return runtime.all<Row>(query);
    },
    first<Row extends object>(query: CompiledQuery<Row>): Promise<Row | null> {
      return runtime.first<Row>(query);
    },
    run(mutation: CompiledMutation): Promise<D1Result> {
      return runtime.run(mutation);
    },
    batch(
      mutations: readonly CompiledMutation[],
    ): Promise<readonly D1Result[]> {
      return runtime.batch(mutations);
    },
  };
}

export function createD1DatabaseClient(database: D1Database): DatabaseClient {
  return createDatabaseClient(createDatabaseRuntime(database));
}
