import { type FilterDocument } from "./filters";
import { EMPTY_FILTER_DOCUMENT } from "./helpers";
import { assertOperationAllowed } from "./policy";
import type {
  AnalyticsResult,
  ChannelItem,
  ChannelsQuery,
  ChannelsResult,
  QuerySource,
  QueryTime,
} from "./types";

export interface ChannelsReaderInput {
  readonly context: ChannelsQuery["context"];
  readonly time: QueryTime;
  readonly filters: FilterDocument;
  readonly limit: number;
}

export interface ChannelsReader {
  readChannels(input: ChannelsReaderInput): Promise<{
    readonly value: readonly ChannelItem[];
    readonly source: QuerySource;
  }>;
}

export async function executeChannels(
  reader: ChannelsReader,
  input: ChannelsQuery,
): Promise<AnalyticsResult<ChannelsResult>> {
  const error = assertOperationAllowed(input.context, "channels");
  if (error) return { ok: false, error };
  const result = await reader.readChannels({
    context: input.context,
    time: input.time,
    filters: input.filters ?? EMPTY_FILTER_DOCUMENT,
    limit: input.limit,
  });
  return {
    ok: true,
    data: { items: result.value },
    meta: {
      time: input.time,
      source: result.source,
      approximateVisitors: false,
    },
  };
}
