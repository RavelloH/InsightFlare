import { z } from "zod";

export const SitePerformanceBreakdownDimensionSchema = z.enum([
  "page.path",
  "geo.country",
]);

export type SitePerformanceBreakdownDimension = z.infer<
  typeof SitePerformanceBreakdownDimensionSchema
>;
