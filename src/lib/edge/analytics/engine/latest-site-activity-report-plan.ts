import {
  type QueryTime,
  scopedFilterMetadata,
  type SiteId,
} from "@/lib/edge/analytics/contract";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export function buildLatestSiteActivityPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
}): ValidatedLogicalPlan {
  const metadata = scopedFilterMetadata(input.filters);
  const sourceSelection =
    !metadata && input.filters.root !== null
      ? createSemanticScopedSourceSelection({
          profile: "direct-page-session-compat-v1",
          filters: input.filters,
          subject: createSemanticSubjectDomain({
            origin: "site",
            siteIds: [input.siteId as SiteId],
          }),
          time: semanticTemporalDomainsFromQueryTime(input.queryTime),
        })
      : undefined;
  const { builder, pages } = createPageReportSource({
    ...input,
    ...(metadata
      ? {
          scopePlan: metadata.plan,
          preparedTimePolicy: "reader-window-v1" as const,
        }
      : {}),
    ...(sourceSelection ? { sourceSelection } : {}),
    attributes: ["page.report.lastActivityAt"],
  });
  const latest = builder.aggregate(pages, {}, [
    {
      name: "lastActivityAt",
      kind: "max",
      expression: builder.slot(pages, "attribute:page.report.lastActivityAt"),
    },
  ]);
  builder.output("overview-latest-site-activity", latest, [
    { name: "lastActivityAt", slot: "lastActivityAt" },
  ]);
  return builder.finish();
}
