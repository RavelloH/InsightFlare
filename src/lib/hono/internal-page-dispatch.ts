/**
 * A page middleware Hono dispatch is already owned by the outer Worker
 * invocation. HTTP headers are not proof of that ownership: clients can forge
 * them. Only this module's in-memory Request identity is trusted.
 */
const internalPageRequests = new WeakSet<Request>();

export async function dispatchInternalPageRequest<T>(
  request: Request,
  dispatch: (internalRequest: Request) => T | Promise<T>,
): Promise<T> {
  // Use a fresh identity even if a page middleware supplies the original
  // external Request; never mark the external request as internal.
  const internalRequest = new Request(request);
  internalPageRequests.add(internalRequest);
  try {
    return await dispatch(internalRequest);
  } finally {
    internalPageRequests.delete(internalRequest);
  }
}

/** Only a currently active, code-owned internal dispatch may skip Hono logging. */
export function isInternalPageRequest(request: Request): boolean {
  return internalPageRequests.has(request);
}
