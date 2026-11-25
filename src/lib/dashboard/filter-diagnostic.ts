import {
  FilterDslParseError,
  FilterValidationError,
} from "@/lib/filter-contract";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";

export interface FilterDiagnosticRange {
  readonly offset: number;
  readonly length: number;
}

type DiagnosticMessages = Pick<AppMessages, "filterBuilder">;

/** UI diagnostics are translated by stable domain codes, never Error.message. */
export function describeFilterDiagnostic(
  error: unknown,
  messages: DiagnosticMessages,
) {
  const copy = messages.filterBuilder.dslDiagnostics;
  const known =
    error instanceof FilterDslParseError ||
    error instanceof FilterValidationError;
  const code = known ? error.code : undefined;
  const message =
    code && Object.prototype.hasOwnProperty.call(copy, code)
      ? (copy as Record<string, string>)[code]!
      : copy.unknown;
  if (!(error instanceof FilterDslParseError)) {
    return { message, range: null, location: null };
  }
  const source = error.source ?? "";
  const offset = Math.min(source.length, Math.max(0, error.offset));
  const prefix = source.slice(0, offset);
  const lines = prefix.split(/\r\n|\r|\n/);
  const line = lines.length;
  const column = Array.from(lines[lines.length - 1] ?? "").length + 1;
  return {
    message,
    range: {
      offset,
      length: Math.max(0, Math.min(source.length - offset, error.length)),
    },
    location: formatI18nTemplate(copy.location, { line, column }),
  };
}
