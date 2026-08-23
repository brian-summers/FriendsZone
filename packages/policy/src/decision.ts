/**
 * Why a request was refused.
 *
 * These are a closed set of machine-readable codes rather than sentences,
 * because denial reasons end up in audit logs and metrics. A code can be
 * counted, alerted on, and shipped to a log aggregator without smuggling a
 * username, an event title, or a location along with it.
 *
 * Critically, these codes are for *operators*. They are never returned to the
 * caller verbatim - see `docs/security/authz-model.md` on why the HTTP layer
 * collapses most of them into an indistinguishable 404.
 */
export type DenyReason =
  /** No authenticated principal, and the resource is not public. */
  | 'ANONYMOUS'
  /** A block exists in one direction or the other. Always terminal. */
  | 'BLOCKED'
  /** Requires an accepted friendship; viewer has none or only a pending one. */
  | 'NOT_FRIENDS'
  /** Action is reserved to the resource owner. */
  | 'NOT_OWNER'
  /** Action is reserved to someone named on the resource. */
  | 'NOT_PARTICIPANT'
  /** Legal action, wrong lifecycle state (e.g. responding to an expired ask). */
  | 'WRONG_STATE'
  /** No sharing rule grants this viewer access. The default outcome. */
  | 'NO_MATCHING_AUDIENCE';

export type Decision<A extends string = string> =
  | { readonly allowed: true; readonly action: A }
  | { readonly allowed: false; readonly action: A; readonly reason: DenyReason };

export const allow = <A extends string>(action: A): Decision<A> => ({ allowed: true, action });

export const deny = <A extends string>(action: A, reason: DenyReason): Decision<A> => ({
  allowed: false,
  action,
  reason,
});

export class PolicyDeniedError extends Error {
  readonly action: string;
  readonly reason: DenyReason;

  constructor(action: string, reason: DenyReason) {
    // The message is for logs only. Callers must not forward it to clients.
    super(`policy denied ${action}: ${reason}`);
    this.name = 'PolicyDeniedError';
    this.action = action;
    this.reason = reason;
  }
}

/**
 * Convert a decision into control flow. Prefer this at call sites over reading
 * `.allowed` by hand: an ignored return value is invisible in review, whereas a
 * missing `assertAllowed` shows up as an untested branch.
 */
export function assertAllowed<A extends string>(decision: Decision<A>): asserts decision is {
  allowed: true;
  action: A;
} {
  if (!decision.allowed) {
    throw new PolicyDeniedError(decision.action, decision.reason);
  }
}
