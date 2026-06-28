import { errorResponse } from "@/lib/response";

export function internalServerError(
  request: Request,
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : String(error);
  return errorResponse(
    request,
    500,
    "internal_server_error",
    message || "Internal Server Error",
  );
}
