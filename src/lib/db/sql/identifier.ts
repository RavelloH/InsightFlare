import { DatabaseCompilerError } from "@/lib/db/query/errors";

import { type SqlFragment, text } from "./fragment";

export function quoteIdentifier(value: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new DatabaseCompilerError(
      "invalid_identifier",
      `Invalid SQL identifier: ${JSON.stringify(value)}`,
    );
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function identifier(value: string): SqlFragment {
  return text(quoteIdentifier(value));
}
