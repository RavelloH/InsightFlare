import { describe, expect, it } from "vitest";

import {
  ADVANCED_FALLBACK_LOG_MESSAGE,
  createD1ReadDiagnostics,
  recordAdvancedFallbackEntry,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";

describe("advanced filter fallback log", () => {
  it("writes one invocation log event per fallback door use and keeps the diagnostics record", () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const diagnostics = createD1ReadDiagnostics();
    runWithInvocationLogger(logger, () => {
      recordAdvancedFallbackEntry(diagnostics, {
        entry: "complete-event-qualification",
        operation: "referrers",
      });
      recordAdvancedFallbackEntry(diagnostics, {
        entry: "page-membership",
        operation: "channel-list",
      });
    });
    expect(diagnostics.advancedFallbackEntries).toEqual([
      { entry: "complete-event-qualification", operation: "referrers" },
      { entry: "page-membership", operation: "channel-list" },
    ]);
    const events = logger
      .build()
      .logs.filter((event) => event.message === ADVANCED_FALLBACK_LOG_MESSAGE);
    expect(events.map((event) => event.data)).toEqual([
      { entry: "complete-event-qualification", operation: "referrers" },
      { entry: "page-membership", operation: "channel-list" },
    ]);
    expect(events.every((event) => event.level === "info")).toBe(true);
  });

  it("is silent outside a request and without diagnostics", () => {
    expect(() =>
      recordAdvancedFallbackEntry(undefined, {
        entry: "complete-event-qualification",
        operation: "referrers",
      }),
    ).not.toThrow();
    const diagnostics = createD1ReadDiagnostics();
    recordAdvancedFallbackEntry(diagnostics, {
      entry: "page-membership",
      operation: "page-dimension",
    });
    expect(diagnostics.advancedFallbackEntries).toHaveLength(1);
  });

  it("does not write a log event for a request that never falls back", () => {
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    runWithInvocationLogger(logger, () => undefined);
    expect(
      logger
        .build()
        .logs.filter(
          (event) => event.message === ADVANCED_FALLBACK_LOG_MESSAGE,
        ),
    ).toHaveLength(0);
  });
});
