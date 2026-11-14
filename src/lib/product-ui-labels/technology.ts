import type {
  BrowserRadarLabels,
  BrowserVersionBreakdownLabels,
  TechnologyShareOverviewLabels,
} from "@insightflare/product-ui/technology";

import type { AppMessages } from "@/lib/i18n/messages";

export function buildBrowserShareOverviewLabels(
  messages: AppMessages,
): TechnologyShareOverviewLabels {
  return {
    primaryTitle: messages.browsers.browserShareTitle,
    secondaryTitle: messages.browsers.engineShareTitle,
    valueLabel: messages.common.visitors,
    emptyLabel: messages.common.noData,
    loadingLabel: messages.common.loading,
  };
}

export function buildDeviceShareOverviewLabels(
  messages: AppMessages,
): TechnologyShareOverviewLabels {
  return {
    primaryTitle: messages.devices.deviceShareTitle,
    secondaryTitle: messages.devices.osShareTitle,
    valueLabel: messages.common.visitors,
    emptyLabel: messages.common.noData,
    loadingLabel: messages.common.loading,
  };
}

export function buildBrowserRadarLabels(
  messages: AppMessages,
): BrowserRadarLabels {
  return {
    title: messages.browsers.radarTitle,
    subtitle: messages.browsers.radarSubtitle,
    loadingLabel: messages.common.loading,
    emptyLabel: messages.common.noData,
    metrics: {
      duration: messages.browsers.radarDuration,
      engagement: messages.browsers.radarEngagement,
      depth: messages.browsers.radarDepth,
      loyalty: messages.browsers.radarLoyalty,
      frequency: messages.browsers.radarFrequency,
      traffic: messages.browsers.radarTraffic,
    },
  };
}

export interface CrossBreakdownLabels {
  readonly firstTitle: string;
  readonly secondTitle: string;
  readonly loadingLabel: string;
  readonly emptyLabel: string;
}

export function buildBrowserCrossBreakdownLabels(
  messages: AppMessages,
): CrossBreakdownLabels {
  return {
    firstTitle: messages.browsers.osBreakdownTitle,
    secondTitle: messages.browsers.deviceTypeBreakdownTitle,
    loadingLabel: messages.common.loading,
    emptyLabel: messages.common.noData,
  };
}

export function buildDeviceCrossBreakdownLabels(
  messages: AppMessages,
): CrossBreakdownLabels {
  return {
    firstTitle: messages.devices.browserByDeviceTitle,
    secondTitle: messages.devices.osByDeviceTitle,
    loadingLabel: messages.common.loading,
    emptyLabel: messages.common.noData,
  };
}

export function buildBrowserVersionBreakdownLabels(
  messages: AppMessages,
): BrowserVersionBreakdownLabels {
  return {
    title: messages.browsers.versionBreakdownTitle,
    loadingLabel: messages.common.loading,
    emptyLabel: messages.common.noData,
    visitorsLabel: messages.common.visitors,
    currentPeriodLabel: messages.dashboardHeader.compareCurrentPeriod,
  };
}
