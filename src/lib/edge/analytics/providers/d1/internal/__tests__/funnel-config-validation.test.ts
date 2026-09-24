import { describe, expect, it } from "vitest";

import type { FunnelConfigV2 } from "@/lib/edge/analytics/contract/funnel-config";
import {
  estimateFunnelSqlBindingCount,
  validateD1FunnelConfigForWrite,
} from "@/lib/edge/analytics/providers/d1/internal/funnel-config-validation";

function highBindingConfig(): FunnelConfigV2 {
  const filterDsl = Array.from(
    { length: 10 },
    (_, index) => `page.path eq "/candidate-${index}"`,
  ).join(" AND ");
  return {
    filterDslVersion: 1,
    progressionScope: "session",
    conversionWindowMs: null,
    steps: Array.from({ length: 10 }, (_, index) => ({
      id: `step-${index}`,
      filterDsl,
    })),
  };
}

describe("D1 funnel configuration validation", () => {
  it("enforces the provider binding budget without putting SQL in the contract", () => {
    const config = highBindingConfig();

    expect(estimateFunnelSqlBindingCount(config)).toBeGreaterThan(100 - 6);
    expect(() => validateD1FunnelConfigForWrite(config)).toThrow(
      "funnel_sql_binding_limit_exceeded",
    );
  });
});
