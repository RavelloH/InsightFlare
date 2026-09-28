export type DatabaseCompilerErrorCode =
  | "invalid_plan"
  | "unsupported_expression"
  | "unsupported_mutation"
  | "invalid_identifier";

export class DatabaseCompilerError extends Error {
  constructor(
    readonly code: DatabaseCompilerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DatabaseCompilerError";
  }
}
