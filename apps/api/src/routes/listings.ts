import {
  ClaimDecisionInput,
  ClaimId,
  ClaimListingInput,
  CreateListingInput,
  ListingId,
  MAX_CLAIMS_PER_LISTING,
  UpdateListingInput,
  UploadPhotoInput,
  type Claim,
  type ExchangeView,
  type Listing,
  type UserId,
  type ListingView,
  type UploadedPhoto,
} from '@friendszone/contracts';
import {
  assertAllowed,
  can,
  drawWinner,
  PolicyDeniedError,
  projectExchange,
  projectListing,
} from '@friendszone/policy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decodePhoto, MAX_PHOTO_BYTES, sniffImageType } from '../http/images.js';
import { defineRoute, rawResponse, type RawResponse } from '../http/route.js';
import { ValidationError } from '../http/errors.js';
import type { Repositories } from '../repositories/ports.js';

/**
 * Things - the secondhand exchange.
 *
 * Offering an item to an audience, and claiming one by whichever of the three
 * modes the owner chose (docs/adr/0017-claim-modes-and-deadlines.md).
 *
 * The **handoff** that follows an accepted claim lives in `exchanges.ts`. It
 * was gated on reporting and moderation, which shipped in
 * docs/adr/0018-reporting-and-moderation.md; the handoff itself is
 * docs/adr/0019-the-handoff.md. Claim views carry the live handoff so the two
 * read as one flow to a client, but only ever the one that viewer is party to.
 */

/** A browse page is bounded, like every other list in this API. */
const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;

/**
 * Photo upload gets its own body cap, well above the server-wide 256 KiB.
 *
 * Base64 inflates by a third, and there is envelope overhead on top, so the
 * limit is the byte cap plus headroom rather than the byte cap itself.
 */
const PHOTO_BODY_LIMIT = Math.ceil(MAX_PHOTO_BYTES * (4 / 3)) + 8192;

const requireActor = (actorId: UserId | null, action: string): UserId => {
  if (actorId === null) throw new PolicyDeniedError(action, 'ANONYMOUS');
  return actorId;
};

export function buildListingRoutes(repos: Repositories) {
  /**
   * Live handoffs for a listing's claims, as this viewer may see them.
   *
   * `projectExchange` refuses anyone who is not a party, so a non-party simply
   * gets an empty map - the filtering is the kernel's, not this loop's.
   */
  const exchangesFor = async (
    listing: Listing,
    claims: readonly Claim[],
    viewer: Parameters<typeof can>[0],
  ): Promise<Map<string, ExchangeView>> => {
    const map = new Map<string, ExchangeView>();
    for (const claim of claims) {
      const exchange = await repos.exchanges.forClaim(claim.id);
      if (exchange === null) continue;
      const view = projectExchange({ exchange, viewer, listing, claim });
      if (view !== null) map.set(claim.id, view);
    }
    return map;
  };

  /**
   * Load a listing and project it for one viewer, or throw the same 404 a
   * nonexistent id would produce.
   *
   * Unknown-to-you and does-not-exist have to be one outcome, so they are one
   * code path - the only way to keep them identical as the file grows.
   */
  const loadVisible = async (
    listingId: ListingId,
    viewerFor: (ownerId: UserId) => Promise<Parameters<typeof can>[0]>,
  ): Promise<{ listing: Listing; claims: Claim[]; view: ListingView }> => {
    const listing = await repos.listings.byId(listingId);
    if (listing === null) throw new PolicyDeniedError('listing:view', 'NO_MATCHING_AUDIENCE');

    const viewer = await viewerFor(listing.ownerId);
    const claims = await repos.listings.claimsFor(listing.id);
    const view = projectListing({
      listing,
      viewer,
      claims,
      exchanges: await exchangesFor(listing, claims, viewer),
    });
    if (view === null) throw new PolicyDeniedError('listing:view', 'NO_MATCHING_AUDIENCE');

    return { listing, claims, view };
  };

  return [
    /**
     * Browse. Every listing the viewer is entitled to, newest first.
     *
     * The port returns raw rows and `projectListing` decides, per listing, what
     * survives - including whether it appears at all. The coarse `listing:view`
     * gate on this route is not the filter; dropping the per-record projection
     * would expose every listing in the system.
     */
    defineRoute({
      method: 'GET',
      rateLimit: 'READ',
      url: '/v1/listings',
      authz: { kind: 'POLICY', action: 'listing:view' },
      params: z.object({}),
      query: z.object({
        limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
      }),
      handler: async (ctx): Promise<{ listings: ListingView[] }> => {
        // Over-read before filtering: the cap is on what we *return*, and a
        // viewer entitled to few of many would otherwise see an empty page.
        const candidates = await repos.listings.recent(MAX_PAGE * 4);

        const views: ListingView[] = [];
        for (const listing of candidates) {
          if (views.length >= ctx.query.limit) break;
          // Per owner, inside the loop. A context hoisted out of this loop and
          // reused across owners is the exact bug `viewerFor` exists to prevent.
          const viewer = await ctx.viewerFor(listing.ownerId);
          const claims = await repos.listings.claimsFor(listing.id);
          const view = projectListing({
            listing,
            viewer,
            claims,
            exchanges: await exchangesFor(listing, claims, viewer),
          });
          if (view !== null) views.push(view);
        }

        return { listings: views };
      },
    }),

    defineRoute({
      method: 'GET',
      rateLimit: 'READ',
      url: '/v1/listings/:id',
      authz: { kind: 'POLICY', action: 'listing:view' },
      params: z.object({ id: ListingId }),
      query: z.object({}),
      handler: async (ctx): Promise<ListingView> => {
        const { view } = await loadVisible(ctx.params.id, ctx.viewerFor);
        return view;
      },
    }),

    /** Offer something. The owner is the session, never the body. */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/listings',
      authz: { kind: 'POLICY', action: 'listing:create' },
      params: z.object({}),
      query: z.object({}),
      body: CreateListingInput,
      handler: async (ctx): Promise<ListingView> => {
        const actorId = requireActor(ctx.actorId, 'listing:create');
        const viewer = await ctx.viewerFor(actorId);
        assertAllowed(can(viewer, { action: 'listing:create', ownerId: actorId }));

        /**
         * A lottery with no deadline can never be drawn - `listing:draw`
         * refuses one - so creating that combination would produce an item
         * permanently stuck accepting entries. Refused at the edge, where the
         * caller can still fix it, rather than left as a dead end.
         */
        if (ctx.body.claimMode === 'LOTTERY' && ctx.body.claimsCloseAt === undefined) {
          throw new ValidationError(['claimsCloseAt']);
        }
        if (
          ctx.body.claimsCloseAt !== undefined &&
          Date.parse(ctx.body.claimsCloseAt) <= Date.now()
        ) {
          throw new ValidationError(['claimsCloseAt']);
        }

        const now = new Date().toISOString();
        const listing: Listing = {
          id: randomUUID() as ListingId,
          ownerId: actorId, // ← from the session, never the body
          title: ctx.body.title,
          condition: ctx.body.condition,
          currency: ctx.body.currency,
          photoKeys: ctx.body.photoKeys,
          audience: ctx.body.audience,
          status: 'AVAILABLE',
          claimMode: ctx.body.claimMode,
          createdAt: now,
          updatedAt: now,
          ...(ctx.body.description === undefined ? {} : { description: ctx.body.description }),
          ...(ctx.body.priceMinorUnits === undefined
            ? {}
            : { priceMinorUnits: ctx.body.priceMinorUnits }),
          ...(ctx.body.claimsCloseAt === undefined
            ? {}
            : { claimsCloseAt: ctx.body.claimsCloseAt }),
        };

        const stored = await repos.listings.create(listing);
        const view = projectListing({ listing: stored, viewer, claims: [] });
        // Unreachable: the owner always passes `listing:view` on their own row.
        if (view === null) throw new PolicyDeniedError('listing:view', 'NOT_OWNER');
        return view;
      },
    }),

    /** Edit. `claimMode` is absent from the input schema and so cannot move. */
    defineRoute({
      method: 'PATCH',
      rateLimit: 'WRITE',
      url: '/v1/listings/:id',
      authz: { kind: 'POLICY', action: 'listing:modify' },
      params: z.object({ id: ListingId }),
      query: z.object({}),
      body: UpdateListingInput,
      handler: async (ctx): Promise<ListingView> => {
        requireActor(ctx.actorId, 'listing:modify');

        const existing = await repos.listings.byId(ctx.params.id);
        // Unknown id and not-yours collapse to the same 404 upstream.
        if (existing === null) throw new PolicyDeniedError('listing:modify', 'NOT_OWNER');

        const viewer = await ctx.viewerFor(existing.ownerId);
        assertAllowed(
          can(viewer, {
            action: 'listing:modify',
            listing: { ownerId: existing.ownerId, status: existing.status },
          }),
        );

        const updated: Listing = {
          ...existing,
          updatedAt: new Date().toISOString(),
          ...(ctx.body.title === undefined ? {} : { title: ctx.body.title }),
          ...(ctx.body.description === undefined ? {} : { description: ctx.body.description }),
          ...(ctx.body.condition === undefined ? {} : { condition: ctx.body.condition }),
          ...(ctx.body.priceMinorUnits === undefined
            ? {}
            : { priceMinorUnits: ctx.body.priceMinorUnits }),
          ...(ctx.body.photoKeys === undefined ? {} : { photoKeys: ctx.body.photoKeys }),
          ...(ctx.body.audience === undefined ? {} : { audience: ctx.body.audience }),
          ...(ctx.body.claimsCloseAt === undefined
            ? {}
            : { claimsCloseAt: ctx.body.claimsCloseAt }),
        };

        const stored = await repos.listings.save(updated);
        const storedClaims = await repos.listings.claimsFor(stored.id);
        const view = projectListing({
          listing: stored,
          viewer,
          claims: storedClaims,
          exchanges: await exchangesFor(stored, storedClaims, viewer),
        });
        if (view === null) throw new PolicyDeniedError('listing:view', 'NOT_OWNER');
        return view;
      },
    }),

    /** Take it back. Pending claims are declined rather than left hanging. */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/listings/:id/withdraw',
      authz: { kind: 'POLICY', action: 'listing:withdraw' },
      params: z.object({ id: ListingId }),
      query: z.object({}),
      body: z.object({}),
      handler: async (ctx): Promise<ListingView> => {
        requireActor(ctx.actorId, 'listing:withdraw');

        const existing = await repos.listings.byId(ctx.params.id);
        if (existing === null) throw new PolicyDeniedError('listing:withdraw', 'NOT_OWNER');

        const viewer = await ctx.viewerFor(existing.ownerId);
        assertAllowed(
          can(viewer, {
            action: 'listing:withdraw',
            listing: { ownerId: existing.ownerId, status: existing.status },
          }),
        );

        const now = new Date().toISOString();
        const claims = await repos.listings.claimsFor(existing.id);
        for (const claim of claims) {
          if (claim.status !== 'PENDING') continue;
          await repos.listings.saveClaim({ ...claim, status: 'CANCELLED', updatedAt: now });
        }

        const stored = await repos.listings.save({
          ...existing,
          status: 'WITHDRAWN',
          updatedAt: now,
        });
        const storedClaims = await repos.listings.claimsFor(stored.id);
        const view = projectListing({
          listing: stored,
          viewer,
          claims: storedClaims,
          exchanges: await exchangesFor(stored, storedClaims, viewer),
        });
        if (view === null) throw new PolicyDeniedError('listing:view', 'NOT_OWNER');
        return view;
      },
    }),

    /**
     * Claim, or enter the draw.
     *
     * Under `FIRST_COME` this resolves in the same write: the claim is accepted
     * and the listing becomes `CLAIMED`. Under the other two it stays pending.
     */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/listings/:id/claims',
      authz: { kind: 'POLICY', action: 'listing:claim' },
      params: z.object({ id: ListingId }),
      query: z.object({}),
      body: ClaimListingInput,
      handler: async (ctx): Promise<ListingView> => {
        const actorId = requireActor(ctx.actorId, 'listing:claim');

        const listing = await repos.listings.byId(ctx.params.id);
        if (listing === null) {
          throw new PolicyDeniedError('listing:claim', 'NO_MATCHING_AUDIENCE');
        }

        const viewer = await ctx.viewerFor(listing.ownerId);
        const existingClaims = await repos.listings.claimsFor(listing.id);

        assertAllowed(
          can(viewer, {
            action: 'listing:claim',
            listing: {
              ownerId: listing.ownerId,
              audience: listing.audience,
              status: listing.status,
              ...(listing.claimsCloseAt === undefined
                ? {}
                : { claimsCloseAt: listing.claimsCloseAt }),
            },
            viewerHasClaimed: existingClaims.some(
              (c) => c.claimantId === actorId && c.status !== 'CANCELLED',
            ),
            now: new Date().toISOString(),
          }),
        );

        // Bounded, like every other collection. Unbounded children are a
        // storage-exhaustion vector and the draw loads them all at once.
        if (existingClaims.length >= MAX_CLAIMS_PER_LISTING) {
          throw new PolicyDeniedError('listing:claim', 'WRONG_STATE');
        }

        const now = new Date().toISOString();
        const firstCome = listing.claimMode === 'FIRST_COME';

        await repos.listings.createClaim({
          id: randomUUID() as ClaimId,
          listingId: listing.id,
          claimantId: actorId, // ← from the session, never the body
          status: firstCome ? 'ACCEPTED' : 'PENDING',
          createdAt: now,
          updatedAt: now,
          ...(ctx.body.message === undefined ? {} : { message: ctx.body.message }),
        });

        const stored = firstCome
          ? await repos.listings.save({ ...listing, status: 'CLAIMED', updatedAt: now })
          : listing;

        const afterClaims = await repos.listings.claimsFor(listing.id);
        const view = projectListing({
          listing: stored,
          viewer,
          claims: afterClaims,
          exchanges: await exchangesFor(stored, afterClaims, viewer),
        });
        if (view === null) throw new PolicyDeniedError('listing:view', 'NO_MATCHING_AUDIENCE');
        return view;
      },
    }),

    /**
     * Run the draw. Owner only, lottery only, and only once entries have closed.
     *
     * The winning entry is accepted and **every other entry is declined** -
     * leaving them pending forever is the guilt pile in another costume.
     */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/listings/:id/draw',
      authz: { kind: 'POLICY', action: 'listing:draw' },
      params: z.object({ id: ListingId }),
      query: z.object({}),
      body: z.object({}),
      handler: async (ctx): Promise<ListingView> => {
        requireActor(ctx.actorId, 'listing:draw');

        const listing = await repos.listings.byId(ctx.params.id);
        if (listing === null) throw new PolicyDeniedError('listing:draw', 'NOT_OWNER');

        const viewer = await ctx.viewerFor(listing.ownerId);
        assertAllowed(
          can(viewer, {
            action: 'listing:draw',
            listing: {
              ownerId: listing.ownerId,
              status: listing.status,
              claimMode: listing.claimMode,
              ...(listing.claimsCloseAt === undefined
                ? {}
                : { claimsCloseAt: listing.claimsCloseAt }),
            },
            now: new Date().toISOString(),
          }),
        );

        const claims = await repos.listings.claimsFor(listing.id);
        const entries = claims.filter((c) => c.status === 'PENDING');

        /**
         * A cryptographic source, converted to the `[0, 1)` the kernel wants.
         *
         * Dividing a uint32 by 2^32 is exact in float64 and cannot reach 1.
         * `Math.random()` is avoided on principle - see ADR 0017.
         */
        const randomUnit = crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
        const winner = drawWinner(entries, randomUnit);

        const now = new Date().toISOString();
        if (winner === null) {
          // Nobody entered. The listing simply stays available; there is no
          // failure to report and nothing to tell anyone.
          const view = projectListing({ listing, viewer, claims });
          if (view === null) throw new PolicyDeniedError('listing:view', 'NOT_OWNER');
          return view;
        }

        for (const entry of entries) {
          await repos.listings.saveClaim({
            ...entry,
            status: entry.id === winner.id ? 'ACCEPTED' : 'DECLINED',
            updatedAt: now,
          });
        }

        const stored = await repos.listings.save({
          ...listing,
          status: 'CLAIMED',
          updatedAt: now,
        });
        const storedClaims = await repos.listings.claimsFor(stored.id);
        const view = projectListing({
          listing: stored,
          viewer,
          claims: storedClaims,
          exchanges: await exchangesFor(stored, storedClaims, viewer),
        });
        if (view === null) throw new PolicyDeniedError('listing:view', 'NOT_OWNER');
        return view;
      },
    }),

    /** Hand-pick a claim. `OWNER_SELECTS` only - the kernel enforces that. */
    defineRoute({
      method: 'POST',
      rateLimit: 'WRITE',
      url: '/v1/claims/:id/decide',
      authz: { kind: 'POLICY', action: 'claim:decide' },
      params: z.object({ id: ClaimId }),
      query: z.object({}),
      body: ClaimDecisionInput,
      handler: async (ctx): Promise<ListingView> => {
        requireActor(ctx.actorId, 'claim:decide');

        const claim = await repos.listings.claimById(ctx.params.id);
        if (claim === null) throw new PolicyDeniedError('claim:decide', 'NOT_OWNER');

        const listing = await repos.listings.byId(claim.listingId);
        if (listing === null) throw new PolicyDeniedError('claim:decide', 'NOT_OWNER');

        const viewer = await ctx.viewerFor(listing.ownerId);
        assertAllowed(
          can(viewer, {
            action: 'claim:decide',
            listing: { ownerId: listing.ownerId, claimMode: listing.claimMode },
            claim: { status: claim.status },
          }),
        );

        const now = new Date().toISOString();
        const accepted = ctx.body.decision === 'ACCEPT';

        await repos.listings.saveClaim({
          ...claim,
          status: accepted ? 'ACCEPTED' : 'DECLINED',
          updatedAt: now,
        });

        // Accepting marks the item claimed but deliberately leaves the other
        // entries pending: the owner may want a backup if the handoff falls
        // through, so declining stays an explicit act (ADR 0017).
        const stored = accepted
          ? await repos.listings.save({ ...listing, status: 'CLAIMED', updatedAt: now })
          : listing;

        const afterClaims = await repos.listings.claimsFor(listing.id);
        const view = projectListing({
          listing: stored,
          viewer,
          claims: afterClaims,
          exchanges: await exchangesFor(stored, afterClaims, viewer),
        });
        if (view === null) throw new PolicyDeniedError('listing:view', 'NOT_OWNER');
        return view;
      },
    }),

    /**
     * Upload a photo, receiving an opaque key to attach to a listing.
     *
     * Gated on `listing:create`: the only thing a photo is for is a listing you
     * are about to offer, so the right to upload is the right to list.
     *
     * The key is a random UUID and is *not* a capability - the serving route
     * below re-checks visibility through the listing that references it.
     */
    defineRoute({
      method: 'POST',
      url: '/v1/photos',
      rateLimit: 'UPLOAD',
      authz: { kind: 'POLICY', action: 'listing:create' },
      params: z.object({}),
      query: z.object({}),
      body: UploadPhotoInput,
      bodyLimit: PHOTO_BODY_LIMIT,
      handler: async (ctx): Promise<UploadedPhoto> => {
        const actorId = requireActor(ctx.actorId, 'listing:create');
        const viewer = await ctx.viewerFor(actorId);
        assertAllowed(can(viewer, { action: 'listing:create', ownerId: actorId }));

        const bytes = decodePhoto(ctx.body.data);
        if (bytes === null) throw new ValidationError(['data']);

        // Sniffed from content. Whatever the client called it is discarded.
        const contentType = sniffImageType(bytes);
        if (contentType === null) throw new ValidationError(['data']);

        const key = randomUUID();
        await repos.photos.put(key, { contentType, bytes });
        return { key };
      },
    }),

    /**
     * Serve a photo, authorized through the listing that references it.
     *
     * The key alone grants nothing. Routing photo access through the listing is
     * what stops a key leaked in a log, a referrer, or a screenshot from
     * becoming a permanent public URL for someone's belongings.
     */
    defineRoute({
      method: 'GET',
      rateLimit: 'READ',
      url: '/v1/listings/:id/photos/:key',
      authz: { kind: 'POLICY', action: 'listing:view' },
      params: z.object({ id: ListingId, key: z.string().uuid() }),
      query: z.object({}),
      handler: async (ctx): Promise<RawResponse> => {
        const { view } = await loadVisible(ctx.params.id, ctx.viewerFor);

        // The key must actually belong to this listing. Without this check any
        // visible listing would serve as an oracle for every stored photo.
        if (!view.photoKeys.includes(ctx.params.key)) {
          throw new PolicyDeniedError('listing:view', 'NO_MATCHING_AUDIENCE');
        }

        const photo = await repos.photos.get(ctx.params.key);
        if (photo === null) throw new PolicyDeniedError('listing:view', 'NO_MATCHING_AUDIENCE');

        return rawResponse(photo.contentType, photo.bytes);
      },
    }),
  ];
}
