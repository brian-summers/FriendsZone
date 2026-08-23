import type { CircleId, RelationshipKind, UserId } from '@friendszone/contracts';

/**
 * Everything the policy engine is allowed to know about who is asking.
 *
 * This type is the engine's entire input surface, and keeping it this small is
 * the point. The engine performs no I/O: it cannot look up a friendship, cannot
 * query the database, cannot be tricked by a stale cache it fetched itself. The
 * caller assembles this context from trusted sources and passes it in, which
 * makes every decision a pure function of explicit inputs and therefore
 * exhaustively testable.
 */
export interface ViewerContext {
  /** `null` for unauthenticated callers. Never a placeholder or sentinel id. */
  readonly viewerId: UserId | null;

  /**
   * The viewer's relationship *to the owner of the resource being accessed*.
   * Callers must recompute this per owner. Reusing a context across owners is
   * the most likely way to introduce a privilege-escalation bug here.
   */
  readonly relationship: RelationshipKind;

  /**
   * Circles belonging to the resource owner that the viewer is a member of.
   * Empty for non-friends. The viewer never learns these ids exist; they are an
   * input to the decision, not part of any response.
   */
  readonly sharedCircleIds: readonly CircleId[];

  /**
   * Whether this caller is on the deployment's moderator allowlist.
   *
   * Sourced from `MODERATOR_IDS` in config, never from the database and never
   * from anything a user can write - a role that can be escalated to through
   * the API is a role that will be
   * (docs/adr/0018-reporting-and-moderation.md).
   *
   * Required rather than optional on purpose. An omitted boolean would default
   * to `false`, which is fail-closed and would be *fine*; it would also be
   * invisible in review. Making every construction site name it means the
   * compiler asks the question.
   *
   * This grants **no exemption from the visibility model**. There is no branch
   * anywhere in `visibility.ts` or `projection.ts` that consults it. It unlocks
   * the moderation queue and the evidence snapshots attached to reports -
   * nothing else, and specifically not anyone's calendar.
   */
  readonly isModerator: boolean;
}

/** The context for a caller we know nothing about. Maximum restriction. */
export const ANONYMOUS_VIEWER: ViewerContext = Object.freeze({
  viewerId: null,
  relationship: 'NONE',
  sharedCircleIds: Object.freeze([]),
  isModerator: false,
});

export const isSelf = (viewer: ViewerContext, ownerId: UserId): boolean =>
  viewer.viewerId !== null && viewer.viewerId === ownerId;

/**
 * Compile-time exhaustiveness guard. Every `switch` over a union in this
 * package ends with a call to this in the default branch, so adding a new
 * relationship kind, audience, or action breaks the build rather than silently
 * falling through to whatever the last branch happened to be.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled variant in ${context}: ${JSON.stringify(value)}`);
}
