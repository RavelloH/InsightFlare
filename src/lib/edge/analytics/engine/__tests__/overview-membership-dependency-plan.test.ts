import { expect, it } from "vitest";

import { createQueryTime } from "@/lib/edge/analytics/contract";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { planOverviewMembershipDependencies } from "@/lib/edge/analytics/engine/overview-membership-dependency-plan";
import type { OverviewTrendQualificationConfiguration } from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const current = {
  ...createQueryTime(100, 200, "UTC", 1000),
  readRange: createQueryTime(50, 250, "UTC", 1000).range,
  filterRange: createQueryTime(120, 180, "UTC", 1000).range,
  paginationBinding: "reader",
};
const previous = {
  ...createQueryTime(0, 100, "Asia/Shanghai", 1000),
  paginationBinding: "previous",
};
const shapes: readonly [
  OverviewTrendQualificationConfiguration,
  readonly string[],
][] = [
  [{ kind: "aggregate" }, ["current-overview"]],
  [{ kind: "trend", interval: "day" }, ["current-trend"]],
  [
    { kind: "overview-with-detail", interval: "hour" },
    ["current-overview", "current-detail"],
  ],
  [
    { kind: "overview-with-previous", previousTime: previous },
    ["current-overview", "previous-overview"],
  ],
  [
    {
      kind: "overview-with-previous-and-detail",
      previousTime: previous,
      interval: "week",
    },
    ["current-overview", "previous-overview", "current-detail"],
  ],
];
function input(
  configuration: OverviewTrendQualificationConfiguration = shapes[4]![0],
  scope: "session" | "visitor" = "session",
) {
  const filters = parseFilterDsl(
    'count(event { event.name eq "qualifier" }) gte 1',
    analyticsFilterRegistry,
  );
  const queryTime = {
    ...createQueryTime(100, 200, "Asia/Shanghai", 1000),
    readRange: createQueryTime(0, 300, "Asia/Shanghai", 1000).range,
    filterRange: createQueryTime(110, 190, "Asia/Shanghai", 1000).range,
    filterRangeEmpty: false,
    fullHistory: false,
    paginationBinding: "original",
  };
  const execution = planAdvancedFilterExecution({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: ["site-1" as never],
    }),
    scope,
    filters,
    time: queryTime,
    reportFusionAvailable: false,
  });
  const keys = shapes.find((s) => s[0].kind === configuration.kind)![1];
  return {
    preparation: { key: "original", execution, filters, queryTime },
    readerQueryTime: structuredClone(current),
    operation:
      configuration.kind === "trend"
        ? ("trend" as const)
        : ("overview" as const),
    configuration: structuredClone(configuration),
    importedOutputs: keys.map((childKey, i) => ({
      childKey: childKey as "current-overview",
      outputId: `import-${i}`,
    })),
    consumer: { nested: { tab: "overview" } },
  };
}
function frozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(frozen);
}
it.each(["session", "visitor"] as const)(
  "preserves all five closed configurations, windows and steps for %s",
  (scope) => {
    for (const [configuration, keys] of shapes) {
      const source = input(configuration, scope),
        p = planOverviewMembershipDependencies(source)!;
      expect(p).toBeDefined();
      expect(p.preparation).toMatchObject({
        kind: "prepare-membership",
        strategy: "sql-membership",
        filters: source.preparation.filters,
        queryTime: source.preparation.queryTime,
        bounds: source.preparation.execution.decision.coreBounds,
      });
      expect(p.children.map((x) => x.key)).toEqual(keys);
      expect(p.steps.map((x) => x.kind)).toEqual([
        "prepare-membership",
        ...keys.map(() => "read-report"),
      ]);
      expect(p.children.map((x) => x.queryTime)).toEqual(
        keys.map((k) => (k === "previous-overview" ? previous : current)),
      );
      expect(
        p.children.every(
          (x) =>
            x.preparationKey === "original" &&
            x.maxPlans === 1 &&
            x.maxSources === 2,
        ),
      ).toBe(true);
      expect(p.children.map((x) => x.sourceRoles)).toEqual(
        keys.map(() => ["page", "event"]),
      );
      expect(p.children.map((x) => x.outputId)).toEqual(
        keys.map((_, i) => `import-${i}`),
      );
      expect(p.children.map((x) => x.localOutputId)).toEqual(
        keys.map((k) =>
          k.endsWith("overview") ? "overview-aggregate" : "overview-trend",
        ),
      );
      frozen(p);
      source.consumer.nested.tab = "mutated";
      source.readerQueryTime.paginationBinding = "mutated";
      expect(p.consumer.nested.tab).toBe("overview");
      expect(p.children[0]!.queryTime.paginationBinding).toBe("reader");
    }
  },
);
it.each([
  "zero",
  "extra",
  "missing",
  "reordered",
  "duplicate-key",
  "empty-output",
  "duplicate-output",
  "wrong-operation",
  "unknown-operation",
  "unknown-kind",
  "prototype-kind",
  "missing-interval",
  "unknown-interval",
  "missing-previous",
  "unsupported",
  "activity",
  "fusion",
])("rejects malformed or unlicensed %s shape", (kind) => {
  const x: any = input();
  if (kind === "zero") x.importedOutputs = [];
  if (kind === "extra")
    x.importedOutputs.push({ childKey: "current-trend", outputId: "extra" });
  if (kind === "missing") x.importedOutputs.pop();
  if (kind === "reordered") x.importedOutputs.reverse();
  if (kind === "duplicate-key")
    x.importedOutputs[1].childKey = x.importedOutputs[0].childKey;
  if (kind === "empty-output") x.importedOutputs[0].outputId = "";
  if (kind === "duplicate-output")
    x.importedOutputs[1].outputId = x.importedOutputs[0].outputId;
  if (kind === "wrong-operation") x.operation = "trend";
  if (kind === "unknown-operation") x.operation = "unknown";
  if (kind === "unknown-kind") x.configuration.kind = "unknown";
  if (kind === "prototype-kind")
    x.configuration = Object.create(x.configuration);
  if (kind === "missing-interval") delete x.configuration.interval;
  if (kind === "unknown-interval") x.configuration.interval = "unknown";
  if (kind === "missing-previous") delete x.configuration.previousTime;
  if (kind === "unsupported")
    x.preparation.execution.support.kind = "unsupported";
  if (kind === "activity")
    x.preparation.execution.decision.membership.identity.grain = "activity";
  if (kind === "fusion")
    x.preparation.execution.decision.strategy = "sql-report-fusion";
  expect(planOverviewMembershipDependencies(x)).toBeUndefined();
});
