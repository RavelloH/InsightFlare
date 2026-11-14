import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { analyticsTooltipContract } from "@insightflare/product-ui/analytics-tooltip";
import {
  donutChartContract,
  eventTrendBarChartContract,
  latencyPercentileChartContract,
  metricAreaChartContract,
  performanceRadarChartContract,
  performanceTrendChartContract,
  shareTrendAreaChartContract,
  siteTrafficStackChartContract,
  stackedBreakdownBarChartContract,
  trafficPairBarChartContract,
} from "@insightflare/product-ui/charts";
import { detailDrawerContract } from "@insightflare/product-ui/detail-drawer";
import { siteScopeSelectorContract } from "@insightflare/product-ui/site-scope-selector";
import {
  analyticsDataTableContract,
  analyticsTableColumnSettingsContract,
} from "@insightflare/product-ui/tables";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { TooltipProvider } from "@insightflare/ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom cannot cancel native animations; motion falls back to JS animations without WAAPI.
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const contracts = [
  analyticsDataTableContract,
  analyticsTableColumnSettingsContract,
  analyticsTooltipContract,
  detailDrawerContract,
  donutChartContract,
  eventTrendBarChartContract,
  latencyPercentileChartContract,
  metricAreaChartContract,
  performanceRadarChartContract,
  performanceTrendChartContract,
  shareTrendAreaChartContract,
  siteScopeSelectorContract,
  siteTrafficStackChartContract,
  stackedBreakdownBarChartContract,
  trafficPairBarChartContract,
];

let container: HTMLDivElement;
let root: Root;

describe("product-ui chart and utility contracts", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("uses unique contract and fixture ids", () => {
    const contractIds = contracts.map((contract) => contract.id);
    expect(new Set(contractIds).size).toBe(contractIds.length);
    const fixtureIds = contracts.flatMap((contract) =>
      contract.fixtures.map((fixture) => fixture.id),
    );
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
  });

  for (const contract of contracts) {
    it(`renders every fixture of ${contract.id}`, async () => {
      expect(contract.fixtures.length).toBeGreaterThan(0);
      for (const fixture of contract.fixtures) {
        const node = contract.renderFixture(fixture.id);
        expect(node, fixture.id).not.toBeNull();
        await act(async () => {
          root.render(
            <LayerManagerProvider>
              <TooltipProvider>{node}</TooltipProvider>
            </LayerManagerProvider>,
          );
          await Promise.resolve();
        });
        expect(container.childElementCount, fixture.id).toBeGreaterThan(0);
      }
    });
  }

  it("keeps a realistic showcase fixture for every chart contract", () => {
    for (const contract of [
      donutChartContract,
      eventTrendBarChartContract,
      latencyPercentileChartContract,
      metricAreaChartContract,
      performanceRadarChartContract,
      performanceTrendChartContract,
      shareTrendAreaChartContract,
      siteTrafficStackChartContract,
      stackedBreakdownBarChartContract,
      trafficPairBarChartContract,
    ]) {
      expect(
        contract.fixtures.some((fixture) =>
          fixture.id.endsWith(`${contract.id}.showcase`),
        ),
        contract.id,
      ).toBe(true);
    }
  });
});
