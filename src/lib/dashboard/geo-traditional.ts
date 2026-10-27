import { ConverterFactory } from "opencc-js/core";
import * as Locale from "opencc-js/preset/cn2t";

// Import only the simplified-to-traditional dictionaries, not all OpenCC presets.
// This module itself is dynamically imported only when a zh-TW geo label is needed.
const converter = ConverterFactory(...Locale.from.cn, ...Locale.to.tw);

export function toTraditionalGeoName(value: string): string {
  return converter(value);
}
