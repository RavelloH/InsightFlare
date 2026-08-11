import { test } from "@playwright/test";

import { createFlowContext } from "../support/flow-context";
import { registerAccountTopologyScenarios } from "./account-topology";
import { registerAnalyticsArchiveScenarios } from "./analytics-archive";
import { registerBootstrapScenarios } from "./bootstrap";
import { registerNotificationScenarios } from "./notifications";
import { registerPlatformIntegrationScenarios } from "./platform-integrations";
import { registerSystemLifecycleScenarios } from "./system-lifecycle";
import { registerTeamSiteManagementScenarios } from "./team-site-management";
import { registerTrackingRealtimeScenarios } from "./tracking-realtime";

// Playwright schedules files independently. This is intentionally the only
// registered E2E graph, so the stateful scenarios always run in this order.
const context = createFlowContext();

test.describe.serial("InsightFlare E2E", () => {
  registerBootstrapScenarios(context);
  registerAccountTopologyScenarios(context);
  registerTeamSiteManagementScenarios(context);
  registerTrackingRealtimeScenarios(context);
  registerAnalyticsArchiveScenarios(context);
  registerNotificationScenarios(context);
  registerPlatformIntegrationScenarios(context);
  registerSystemLifecycleScenarios(context);
});
