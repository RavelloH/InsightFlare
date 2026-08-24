import "@tanstack/react-start/server-only";

import {
  type ChannelsResult,
  type FilterDocument,
} from "@/lib/edge/analytics/contract";
import { queryChannelsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/channels";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";

export interface ReadSiteChannelsInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
}

export async function readSiteChannels(
  input: ReadSiteChannelsInput,
): Promise<ChannelsResult> {
  return {
    items: await queryChannelsFromD1(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.limit,
    ),
  };
}
