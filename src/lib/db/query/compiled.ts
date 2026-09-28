import type { DatabaseStatement } from "@/lib/db/types";

export interface CompiledQuery<
  Row extends object = Record<string, unknown>,
> extends DatabaseStatement {
  readonly kind: "query";
  readonly __rowType?: Row;
}
