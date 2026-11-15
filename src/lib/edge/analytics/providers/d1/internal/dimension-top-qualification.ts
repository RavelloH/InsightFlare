import {
  crossBreakdownPageDimensionSelection,
  type PageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import { pageVisitQualificationConsumerKey } from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
export function dimensionTopQualificationConsumerKey(
  consumer: "site-exact-dimension",
  configuration: {
    readonly limit: number;
    readonly selection: PageDimensionSelection;
    readonly excludeEmpty?: boolean;
    readonly search?: string;
    readonly sortBy: "views" | "sessions" | "visitors";
    readonly sortDirection: "asc" | "desc";
  },
) {
  return pageVisitQualificationConsumerKey(consumer, configuration);
}
export function siteExactDimensionQualificationConsumerKey(dimension: string) {
  const selection = crossBreakdownPageDimensionSelection(dimension);
  if (!selection) throw new Error("site_exact_dimension_unsupported_report");
  return dimensionTopQualificationConsumerKey("site-exact-dimension", {
    limit: 0,
    selection,
    excludeEmpty: true,
    search: undefined,
    sortBy: "views",
    sortDirection: "desc",
  });
}
