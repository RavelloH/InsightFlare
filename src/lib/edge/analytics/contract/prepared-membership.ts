/**
 * Request-private result of evaluating an advanced filter once.
 *
 * The scoped plan carries only this opaque handle. The evaluated identities
 * never appear in plan data, selections, cache keys or serialized requests;
 * the D1 provider registers a physical relation for them and the lowerer
 * resolves the handle when it builds the SQL. A plain object that merely looks
 * like a handle is rejected because the state lives in a module-private
 * WeakMap keyed by the exact frozen object this module created.
 */
declare const preparedMembershipBrand: unique symbol;

export interface PreparedMembership {
  readonly [preparedMembershipBrand]: true;
  /** Process-unique label that keeps distinct memberships distinct in keys. */
  readonly id: string;
}

interface PreparedMembershipState {
  /** Sites whose identities the evaluation produced. */
  readonly siteIds: readonly string[];
  /** Provider-defined physical relations; opaque to every other layer. */
  readonly payload: unknown;
}

const states = new WeakMap<object, PreparedMembershipState>();
let nextId = 0;

/** Register a freshly evaluated membership and return its opaque handle. */
export function createPreparedMembership(input: {
  readonly siteIds: readonly string[];
  readonly payload: unknown;
}): PreparedMembership {
  if (
    !Array.isArray(input.siteIds) ||
    input.siteIds.some((siteId) => typeof siteId !== "string" || !siteId)
  )
    throw new Error("prepared_membership_sites_invalid");
  nextId += 1;
  const handle = Object.freeze({
    id: `prepared-membership-${nextId}`,
  }) as PreparedMembership;
  states.set(handle as object, {
    siteIds: Object.freeze([...new Set(input.siteIds)].sort()),
    payload: input.payload,
  });
  return handle;
}

export function isPreparedMembership(
  value: unknown,
): value is PreparedMembership {
  return (
    typeof value === "object" && value !== null && states.has(value as object)
  );
}

/** Sites the membership was evaluated for, or undefined for a foreign value. */
export function preparedMembershipSiteIds(
  value: unknown,
): readonly string[] | undefined {
  return isPreparedMembership(value) ? states.get(value)!.siteIds : undefined;
}

/** The provider payload registered with the handle, or undefined if foreign. */
export function preparedMembershipPayload(value: unknown): unknown {
  return isPreparedMembership(value) ? states.get(value)!.payload : undefined;
}
