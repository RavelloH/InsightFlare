import {
  assertWholeFilterCountDocument,
  type QualifiedSourceFilterMode,
  type QualifiedSourceFilterResolution,
  resolveQualifiedSourceFilters,
} from "./qualified-page-source";

export type JourneyListQualificationFilterResolution =
  QualifiedSourceFilterResolution;

export type JourneyListQualificationFilterMode = QualifiedSourceFilterMode;

/** Journey-list compatibility adapter over the shared source resolver. */
export function resolveJourneyListQualificationFilters(
  filters: Parameters<typeof resolveQualifiedSourceFilters>[0],
  mode: JourneyListQualificationFilterMode = "split-only",
): JourneyListQualificationFilterResolution {
  return resolveQualifiedSourceFilters(filters, mode);
}

/** Preserve the established Journey error code while sharing canonical proof. */
export function assertJourneyListWholeFilterCountDocument(
  filters: Parameters<typeof assertWholeFilterCountDocument>[0],
  countDocument: Parameters<typeof assertWholeFilterCountDocument>[1],
  entity: "visitor" | "session",
): void {
  assertWholeFilterCountDocument(
    filters,
    countDocument,
    `journey_${entity}_list_whole_filter_count_document_mismatch`,
  );
}
