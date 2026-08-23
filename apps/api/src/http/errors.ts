import { PolicyDeniedError, type DenyReason } from '@friendszone/policy';

export interface HttpErrorResponse {
  readonly status: number;
  readonly body: { readonly error: string };
  /** Extra response headers. Only `Retry-After` uses this today. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Too many requests.
 *
 * `retryAfterSeconds` is echoed to the caller because it says only how long
 * *they* must wait - a fact about themselves, disclosing nothing about anyone
 * else or about whether any resource exists.
 */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super('rate limited');
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Map an internal denial reason to a response.
 *
 * The important choice here is that most denials become **404, not 403**.
 *
 * A 403 is an admission. "You may not see Alice's calendar" confirms that
 * Alice exists, that this id is hers, and - if the response varies by reason -
 * whether you are blocked or merely not a friend. Chained across a handle list,
 * that turns the API into a social graph oracle. Returning the same 404 for
 * "no such thing" and "not yours" costs a little debuggability and removes the
 * oracle entirely.
 *
 * Two deliberate exceptions:
 *
 *  - `ANONYMOUS` → 401, because telling an unauthenticated caller to log in
 *    reveals nothing they could not learn by logging in.
 *  - `WRONG_STATE` → 409, which is only ever reached after an identity check
 *    has already passed, so the caller demonstrably knows the resource exists.
 */
export function denialToResponse(reason: DenyReason): HttpErrorResponse {
  switch (reason) {
    case 'ANONYMOUS':
      return { status: 401, body: { error: 'authentication_required' } };

    case 'WRONG_STATE':
      return { status: 409, body: { error: 'conflict' } };

    case 'BLOCKED':
    case 'NOT_FRIENDS':
    case 'NOT_OWNER':
    case 'NOT_PARTICIPANT':
    case 'NO_MATCHING_AUDIENCE':
      return { status: 404, body: { error: 'not_found' } };

    default: {
      // Unreachable while `DenyReason` is exhaustively handled; if someone adds
      // a reason and misses this switch, fail closed rather than fall through.
      const _exhaustive: never = reason;
      void _exhaustive;
      return { status: 404, body: { error: 'not_found' } };
    }
  }
}

export class ValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super('request validation failed');
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * Final translation from thrown error to wire response.
 *
 * Anything unrecognised becomes a bare 500. Stack traces, driver messages, and
 * ORM errors stay in the log where they belong; echoing them is how internal
 * paths, table names, and library versions end up in a bug bounty report.
 */
export function errorToResponse(error: unknown): HttpErrorResponse {
  if (error instanceof PolicyDeniedError) {
    return denialToResponse(error.reason);
  }
  if (error instanceof ValidationError) {
    return { status: 400, body: { error: 'invalid_request' } };
  }
  if (error instanceof RateLimitedError) {
    return {
      status: 429,
      body: { error: 'rate_limited' },
      headers: { 'retry-after': String(error.retryAfterSeconds) },
    };
  }
  return { status: 500, body: { error: 'internal_error' } };
}
