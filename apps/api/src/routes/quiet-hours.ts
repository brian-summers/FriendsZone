import type { TimeRange, UserId } from '@friendszone/contracts';
import { overlapsQuietHours, visibleQuietHours, type ViewerContext } from '@friendszone/policy';
import { ValidationError } from '../http/errors.js';
import type { Repositories } from '../repositories/ports.js';

/**
 * Refuse a proposed time that lands in someone else's quiet hours (ADR 0030).
 *
 * The rule is "nobody may propose a plan inside my quiet hours", so it holds
 * on every route where one person puts a time in front of another: a hangout
 * proposal, a re-ask or a move, a floating booking, a handoff. It was first
 * enforced on the proposal alone, which left the same window reachable through
 * the other three. One helper means one rule.
 *
 * Only the recipients' windows are checked. Your own quiet hours are a request
 * to other people, not a restriction on you.
 *
 * Checked against the window as the proposer is *shown* it, through
 * `visibleQuietHours`. That keeps the refusal from disclosing anything: a
 * proposer who can see the shaded region learns nothing new from being told
 * the time is inside it, and one who cannot is never refused on it.
 *
 * `ValidationError` rather than a policy denial: a time inside a visible
 * window is a malformed proposal, not a permission problem.
 */
export async function refuseQuietHours(args: {
  repos: Repositories;
  viewerFor: (ownerId: UserId) => Promise<ViewerContext>;
  recipientIds: readonly UserId[];
  ranges: readonly TimeRange[];
  /** The request field to name in the validation error. */
  field: string;
}): Promise<void> {
  const { repos, viewerFor, recipientIds, ranges, field } = args;
  for (const recipientId of recipientIds) {
    const quiet = visibleQuietHours(
      await viewerFor(recipientId),
      recipientId,
      await repos.calendar.quietHours(recipientId),
    );
    if (ranges.some((range) => overlapsQuietHours(range, quiet))) {
      throw new ValidationError([field]);
    }
  }
}
