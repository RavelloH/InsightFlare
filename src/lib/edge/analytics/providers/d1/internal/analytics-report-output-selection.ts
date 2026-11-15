import type { SlotId } from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";

export interface AnalyticsReportOutputOrderKey {
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
}

export interface AnalyticsReportMultiOutputSelection {
  readonly outputIds: readonly string[];
  /** Output aliases in the requested Generic relation position order. */
  readonly fields: readonly string[];
  readonly orderBy: readonly AnalyticsReportOutputOrderKey[];
}

export interface SelectedOutputField {
  readonly name: string;
  readonly slot: SlotId;
  readonly type: LogicalValueType;
  readonly nullable: boolean;
}
