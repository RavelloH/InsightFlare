import type { QueryTime } from "@/lib/edge/analytics/contract";
import {
  freezeMembershipRecipeValue,
  type MembershipPreparationInput,
  normalizeMembershipPreparations,
  validMembershipChildReferences,
} from "@/lib/edge/analytics/engine/membership-dependency-plan";

import { pageMembershipDimensionContract } from "./page-channel-membership-reader-contract";

export type PageChannelMembershipReader =
  | {
      readonly kind: "dimension-page";
      readonly dimension: string;
      readonly limit: number;
      readonly cursorText: string | null;
      readonly search?: string;
      readonly sortBy: "views" | "sessions" | "visitors";
      readonly sortDirection: "asc" | "desc";
      readonly excludeEmpty: false;
      readonly audience: "private-dashboard";
    }
  | {
      readonly kind: "channels-list";
      readonly mode: "list";
      readonly limit: number;
      readonly sourceLimit: number | undefined;
      readonly audience: "private-dashboard";
      readonly hasComparison: false;
      readonly hasCurrent: false;
      readonly hasReference: false;
    };

/** Pure declaration, never a request capability or permission to bypass admission.
 * The provider must retain qualified execution first and freshly bind the exact
 * request-owned preparation after whole-original-filter admission, before cursor.
 */
export function planPageChannelMembershipDependencies(input: {
  readonly preparation: MembershipPreparationInput;
  readonly readerQueryTime: QueryTime;
  readonly reader: PageChannelMembershipReader;
}) {
  const reader = input.reader;
  if (
    reader.audience !== "private-dashboard" ||
    !Number.isSafeInteger(reader.limit) ||
    reader.limit < 0
  )
    return undefined;
  const preparations = normalizeMembershipPreparations([input.preparation]);
  if (!preparations || preparations.length !== 1) return undefined;
  let contract;
  if (reader.kind === "dimension-page") {
    contract = pageMembershipDimensionContract(reader.dimension);
    if (
      !contract ||
      reader.excludeEmpty !== false ||
      (reader.cursorText !== null && typeof reader.cursorText !== "string") ||
      (reader.search !== undefined && typeof reader.search !== "string") ||
      (reader.sortBy !== "views" &&
        reader.sortBy !== "sessions" &&
        reader.sortBy !== "visitors") ||
      (reader.sortDirection !== "asc" && reader.sortDirection !== "desc")
    )
      return undefined;
  } else if (reader.kind === "channels-list") {
    if (
      reader.mode !== "list" ||
      reader.limit < 1 ||
      reader.hasComparison !== false ||
      reader.hasCurrent !== false ||
      reader.hasReference !== false ||
      (reader.sourceLimit === undefined
        ? reader.limit !== 100
        : reader.sourceLimit !== reader.limit)
    )
      return undefined;
    contract = {
      readerProfile: "channels-list-v1" as const,
      outputId: "overview-channels" as const,
      sourceRole: "page" as const,
      maxPlans: 1 as const,
      maxSources: 1 as const,
    };
  } else return undefined;
  const child = {
    kind: "read-report" as const,
    strategy: "consume-dependency" as const,
    key: "report",
    preparationKey: preparations[0]!.key,
    ...contract,
    queryTime: input.readerQueryTime,
  };
  if (!validMembershipChildReferences(preparations, [child])) return undefined;
  const value = {
    kind: "page-channel-membership-dependencies" as const,
    preparations,
    steps: [
      preparations[0]!,
      ...(reader.kind === "dimension-page"
        ? [
            {
              kind: "decode-page-cursor" as const,
              operation: "dimension" as const,
              cursorText: reader.cursorText,
              queryTime: input.readerQueryTime,
            },
          ]
        : []),
      child,
    ],
    children: [child],
    consumer: reader,
  };
  return freezeMembershipRecipeValue(
    JSON.parse(JSON.stringify(value)) as typeof value,
  );
}
