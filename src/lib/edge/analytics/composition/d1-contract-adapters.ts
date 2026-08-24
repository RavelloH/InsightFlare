/**
 * HTTP/SSR contract bridge for the concrete D1 composition.
 *
 * This file is intentionally the only composition entry point for the old
 * URL contract handlers. It lets protocol adapters remain provider-agnostic
 * while the handlers are migrated to canonical operation inputs.
 */
export * from "@/lib/edge/analytics/composition/legacy/analysis-contract-adapter";
export type { SimpleDimensionKey } from "@/lib/edge/analytics/composition/legacy/dimensions-contract-adapter";
export * from "@/lib/edge/analytics/composition/legacy/dimensions-contract-adapter";
export * from "@/lib/edge/analytics/composition/legacy/events-contract-adapter";
export * from "@/lib/edge/analytics/composition/legacy/filter-values-contract-adapter";
export * from "@/lib/edge/analytics/composition/legacy/funnels-contract-adapter";
export * from "@/lib/edge/analytics/composition/legacy/journeys-contract-adapter";
export * from "@/lib/edge/analytics/composition/legacy/overview-contract-adapter";
export * from "@/lib/edge/analytics/composition/legacy/overview-extras-contract-adapter";
export type { OverviewTab } from "@/lib/edge/analytics/composition/legacy/overview-tabs-contract-adapter";
export * from "@/lib/edge/analytics/composition/legacy/overview-tabs-contract-adapter";
export * from "@/lib/edge/analytics/composition/legacy/pages-contract-adapter";
export * from "@/lib/edge/analytics/composition/legacy/technology-contract-adapter";
export * from "@/lib/edge/analytics/providers/d1/internal/core";
export * from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
export { handleFunnel } from "@/lib/edge/analytics/providers/d1/internal/funnels";
export * from "@/lib/edge/analytics/providers/d1/internal/router";
export type { TeamDashboardQueryResult } from "@/lib/edge/analytics/providers/d1/internal/team";
