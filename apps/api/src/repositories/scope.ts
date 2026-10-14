import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserId } from '@friendszone/contracts';

/**
 * Who is writing, for the row-level-security backstop (ADR 0031).
 *
 * The ports deliberately take no actor - a repository method answers "store
 * this event", not "may Alice store this event", because that question belongs
 * to `packages/policy`. RLS still needs to know who is asking, and threading an
 * actor through every port signature would put an authorization input on every
 * call site. So the server opens a scope per request and the SQL client reads
 * it when it sets `app.actor_id`.
 *
 * Outside a scope there is no actor. The SQL client then sets none, and every
 * policy that checks ownership refuses the write - fail closed.
 */
export interface WriteScope {
  readonly actorId: UserId | null;
  /** A sanctioned write to another person's rows. See `asCrossOwner`. */
  readonly crossOwner: boolean;
}

const storage = new AsyncLocalStorage<WriteScope>();

export const currentScope = (): WriteScope | undefined => storage.getStore();

/** Run one request's work as `actorId`. Called by the server and nowhere else. */
export function runAsActor<T>(actorId: UserId | null, fn: () => Promise<T>): Promise<T> {
  return storage.run({ actorId, crossOwner: false }, fn);
}

/**
 * Admit writes to rows the actor does not own, for the duration of `fn`.
 *
 * The product has a small, named set of these: accepting or booking a hangout
 * writes both calendars (ADR 0010, 0013), editing a confirmed one mirrors onto
 * both copies (ADR 0012), a handoff books and clears both (ADR 0019), a
 * first-come claim and a completed handoff move the owner's listing, and a
 * moderator's takedown withdraws it (ADR 0018). Every one is wrapped in this
 * call, so `grep asCrossOwner` is the complete list - adding one is a diff a
 * reviewer sees rather than a capability every query silently carries.
 *
 * The policy kernel has already decided the action is allowed before this is
 * reached. This only stops RLS refusing what the kernel permitted.
 */
export function asCrossOwner<T>(fn: () => Promise<T>): Promise<T> {
  const scope = storage.getStore();
  // A cross-owner write is always made *by* someone. Without a scope there is
  // nobody to attribute it to, and silently opening one would be the bypass.
  if (scope === undefined || scope.actorId === null) {
    throw new Error('asCrossOwner called without an authenticated request scope');
  }
  return storage.run({ actorId: scope.actorId, crossOwner: true }, fn);
}

/**
 * The in-memory adapter's copy of the write policies in schema.sql.
 *
 * Without it the route suites, which run on the memory adapter, would pass a
 * handler that forgot `asCrossOwner`, and the first anyone heard of it would
 * be a refused write wherever the database connects as a role RLS binds.
 *
 * Outside a scope it permits everything: that is the seed and the adapter
 * conformance suite, neither of which is a request. Inside one it is stricter
 * than Postgres in one respect - a refused delete throws here, where RLS would
 * silently delete nothing - because a test that fails loudly is the point.
 */
export function assertMayWrite(ownerId: UserId, table: string): void {
  const scope = storage.getStore();
  if (scope === undefined) return;
  if (scope.crossOwner || (scope.actorId !== null && scope.actorId === ownerId)) return;
  throw new Error(`new row violates row-level security policy for table "${table}"`);
}
