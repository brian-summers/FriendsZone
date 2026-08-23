import { describe, expect, it } from 'vitest';
import { areClaimsClosed, drawWinner } from './marketplace.js';
import { projectListing } from './projection.js';
import {
  asAnonymous,
  asBlocked,
  asFriend,
  asOwner,
  asStranger,
  BOB,
  CAROL,
  claim,
  CLIMBING_CREW,
  listing,
} from './testing.js';

const NOW = '2026-03-05T12:00:00.000Z';

describe('areClaimsClosed', () => {
  it('leaves a listing with no deadline open forever', () => {
    expect(areClaimsClosed(listing(), NOW)).toBe(false);
  });

  it('is closed once the deadline has passed', () => {
    expect(areClaimsClosed({ claimsCloseAt: '2026-03-04T00:00:00.000Z' }, NOW)).toBe(true);
  });

  it('is open while the deadline is ahead', () => {
    expect(areClaimsClosed({ claimsCloseAt: '2026-03-06T00:00:00.000Z' }, NOW)).toBe(false);
  });

  it('treats the deadline instant itself as closed', () => {
    expect(areClaimsClosed({ claimsCloseAt: NOW }, NOW)).toBe(true);
  });
});

describe('drawWinner', () => {
  const entries = ['a', 'b', 'c', 'd'] as const;

  it('returns null for an empty field', () => {
    expect(drawWinner([], 0.5)).toBeNull();
  });

  it('selects deterministically from the supplied number', () => {
    // The whole point of injecting the number: the same draw is reproducible,
    // so a test can assert the outcome rather than that "something" was picked.
    expect(drawWinner(entries, 0)).toBe('a');
    expect(drawWinner(entries, 0.25)).toBe('b');
    expect(drawWinner(entries, 0.5)).toBe('c');
    expect(drawWinner(entries, 0.99)).toBe('d');
  });

  it('stays in range for a value just under one', () => {
    // Floating-point multiplication can round up to `length`, which would index
    // off the end and return undefined.
    expect(drawWinner(entries, 0.9999999999999999)).toBe('d');
  });

  it('covers every entry across the interval, and only real entries', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const winner = drawWinner(entries, i / 1000);
      expect(entries).toContain(winner);
      if (winner !== null) seen.add(winner);
    }
    expect(seen.size).toBe(entries.length);
  });

  it('refuses a number outside [0, 1)', () => {
    expect(() => drawWinner(entries, 1)).toThrow(RangeError);
    expect(() => drawWinner(entries, -0.1)).toThrow(RangeError);
    expect(() => drawWinner(entries, Number.NaN)).toThrow(RangeError);
  });
});

describe('projectListing', () => {
  it('gives a viewer outside the audience nothing at all', () => {
    // `null`, not a redacted stub: a listing you are not in the audience for
    // must be indistinguishable from one that does not exist.
    expect(
      projectListing({ listing: listing(), viewer: asStranger(), claims: [] }),
    ).toBeNull();
  });

  it('gives a blocked viewer the same nothing as a stranger', () => {
    const l = listing({ audience: { kind: 'PUBLIC' } });
    expect(projectListing({ listing: l, viewer: asBlocked(), claims: [] })).toBeNull();
    // …even though the very same listing is visible to an ordinary stranger.
    expect(projectListing({ listing: l, viewer: asStranger(), claims: [] })).not.toBeNull();
  });

  it('never returns the owner’s audience configuration', () => {
    // The bug this guards: a spread would ship `audience`, letting a viewer
    // read the shape of the owner's circles.
    const view = projectListing({
      listing: listing({ audience: { kind: 'CIRCLE', circleId: CLIMBING_CREW } }),
      viewer: asFriend([CLIMBING_CREW]),
      claims: [],
    });
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty('audience');
    expect(JSON.stringify(view)).not.toContain(CLIMBING_CREW);
  });

  it('never returns the stored updatedAt or raw claim rows to a non-owner', () => {
    const view = projectListing({
      listing: listing(),
      viewer: asFriend(),
      claims: [claim({ claimantId: CAROL })],
    });
    expect(view).not.toHaveProperty('updatedAt');
    expect(view).not.toHaveProperty('claims');
  });

  it('hides other people’s claims from a claimant, including that they exist', () => {
    const view = projectListing({
      listing: listing(),
      viewer: asFriend(), // BOB
      claims: [claim({ claimantId: BOB }), claim({ claimantId: CAROL, message: 'me please' })],
    });

    expect(view?.yourClaim?.status).toBe('PENDING');
    // Absent, not empty: an empty array is a count, and zero is a number.
    expect(view).not.toHaveProperty('claims');
    // Nothing about Carol survives serialisation - not her id, not her message.
    expect(JSON.stringify(view)).not.toContain(CAROL);
    expect(JSON.stringify(view)).not.toContain('me please');
  });

  it('omits yourClaim entirely for a viewer who has not claimed', () => {
    const view = projectListing({
      listing: listing(),
      viewer: asFriend(),
      claims: [claim({ claimantId: CAROL })],
    });
    expect(view).not.toHaveProperty('yourClaim');
  });

  it('gives the owner every claim, because they have to pick', () => {
    const view = projectListing({
      listing: listing(),
      viewer: asOwner(),
      claims: [claim({ claimantId: BOB }), claim({ claimantId: CAROL })],
    });

    expect(view?.isOwner).toBe(true);
    expect(view?.claims).toHaveLength(2);
    expect(view?.claims?.map((c) => c.claimantId)).toEqual([BOB, CAROL]);
    // The owner cannot claim their own listing, so this stays absent for them.
    expect(view).not.toHaveProperty('yourClaim');
  });

  it('shows the owner their own listing whatever the audience', () => {
    const view = projectListing({
      listing: listing({ audience: { kind: 'SELF' } }),
      viewer: asOwner(),
      claims: [],
    });
    expect(view?.isOwner).toBe(true);
  });

  it('marks a non-owner as such', () => {
    const view = projectListing({ listing: listing(), viewer: asFriend(), claims: [] });
    expect(view?.isOwner).toBe(false);
  });

  it('carries the mode and deadline so the client can render the terms', () => {
    const view = projectListing({
      listing: listing({ claimMode: 'LOTTERY', claimsCloseAt: '2026-03-09T00:00:00.000Z' }),
      viewer: asFriend(),
      claims: [],
    });
    expect(view?.claimMode).toBe('LOTTERY');
    expect(view?.claimsCloseAt).toBe('2026-03-09T00:00:00.000Z');
  });

  it('omits an absent deadline rather than sending null', () => {
    const view = projectListing({ listing: listing(), viewer: asFriend(), claims: [] });
    expect(view).not.toHaveProperty('claimsCloseAt');
  });

  it('gives an anonymous caller a public listing without a claim', () => {
    const view = projectListing({
      listing: listing({ audience: { kind: 'PUBLIC' } }),
      viewer: asAnonymous(),
      claims: [claim({ claimantId: BOB })],
    });
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty('yourClaim');
    expect(view).not.toHaveProperty('claims');
  });
});
