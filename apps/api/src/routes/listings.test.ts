import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { DEV_ACTOR_HEADER } from '../http/authenticate.js';
import { createMemoryRepositories } from '../repositories/memory.js';
import { ALICE, BOB, CAROL, CLIMBING_CREW, DAVE, MALLORY, createDemoSeed } from '../seed.js';
import { createServer } from '../server.js';

const config: Config = {
  NODE_ENV: 'test',
  PORT: 0,
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://localhost:5432/test',
  SESSION_SECRET: 'x'.repeat(48),
  PUBLIC_ORIGIN: 'http://localhost:5173',
  MODERATOR_IDS: [],
  REPORTS_EMAIL: 'reports@friends-zone.app',
  // Off here: these suites hammer `app.inject` and would otherwise trip buckets
  // in tests that are about something else. `rate-limit.test.ts` turns it on.
  RATE_LIMIT_ENABLED: false,
  TRUSTED_PROXY_HOPS: 0,
};

const as = (id: string) => ({ [DEV_ACTOR_HEADER]: id });

const inDays = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
};

/** A 1x1 PNG. Real bytes, so the sniffer has something honest to read. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('things', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createServer({ config, repos: createMemoryRepositories(createDemoSeed()) });
    await app.ready();
  });

  const offer = (body: Record<string, unknown>, actor = ALICE) =>
    app.inject({
      method: 'POST',
      url: '/v1/listings',
      headers: as(actor),
      payload: {
        title: 'Cast iron skillet',
        condition: 'GOOD',
        audience: { kind: 'FRIENDS' },
        claimMode: 'OWNER_SELECTS',
        ...body,
      },
    });

  const browse = (actor?: string) =>
    app.inject({
      method: 'GET',
      url: '/v1/listings',
      ...(actor === undefined ? {} : { headers: as(actor) }),
    });

  const claim = (id: string, actor: string, message?: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/listings/${id}/claims`,
      headers: as(actor),
      payload: message === undefined ? {} : { message },
    });

  // ── Offering ───────────────────────────────────────────────────────
  describe('offering', () => {
    it('creates a listing owned by the session, not the body', async () => {
      const res = await offer({ ownerId: BOB, status: 'EXCHANGED' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Both smuggled fields ignored: `CreateListingInput` has no place for them.
      expect(body.ownerId).toBe(ALICE);
      expect(body.status).toBe('AVAILABLE');
      expect(body.isOwner).toBe(true);
    });

    it('never returns the owner’s audience configuration', async () => {
      const res = await offer({ audience: { kind: 'CIRCLE', circleId: CLIMBING_CREW } });
      // Asserting on the serialised body, not the parsed object: a field that
      // survives JSON is a field that reached the client.
      expect(res.body).not.toContain('audience');
      expect(res.body).not.toContain(CLIMBING_CREW);
    });

    it('refuses a lottery with no deadline, which could never be drawn', async () => {
      const res = await offer({ claimMode: 'LOTTERY' });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request' });
    });

    it('refuses a deadline in the past', async () => {
      const res = await offer({ claimsCloseAt: inDays(-1) });
      expect(res.statusCode).toBe(400);
    });

    it('refuses an anonymous offer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/listings',
        payload: { title: 'x', condition: 'GOOD', audience: { kind: 'FRIENDS' }, claimMode: 'FIRST_COME' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a malformed body with a bare code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/listings',
        headers: as(ALICE),
        payload: { title: '', condition: 'NOPE', audience: { kind: 'FRIENDS' }, claimMode: 'X' },
      });
      expect(res.statusCode).toBe(400);
      // No field names, no submitted values — the response is a code and nothing else.
      expect(res.json()).toEqual({ error: 'invalid_request' });
    });
  });

  // ── Who can see what ───────────────────────────────────────────────
  describe('visibility', () => {
    it('shows a friends-only listing to a friend and to nobody else', async () => {
      const id = (await offer({})).json().id;

      expect((await browse(BOB)).json().listings.map((l: { id: string }) => l.id)).toContain(id);
      // Dave is a friend too, so use a genuine non-friend: Mallory is blocked,
      // and an anonymous caller is a stranger.
      expect((await browse()).json().listings.map((l: { id: string }) => l.id)).not.toContain(id);
    });

    it('gives a blocked viewer exactly what a stranger gets', async () => {
      const id = (await offer({ audience: { kind: 'PUBLIC' } })).json().id;

      const blocked = await app.inject({ method: 'GET', url: `/v1/listings/${id}`, headers: as(MALLORY) });
      const stranger = await app.inject({ method: 'GET', url: `/v1/listings/${randomId()}` });

      expect(blocked.statusCode).toBe(stranger.statusCode);
      expect(blocked.body).toBe(stranger.body);
      expect(blocked.statusCode).toBe(404);
    });

    it('answers 404 — never 403 — for a listing outside your audience', async () => {
      const id = (await offer({ audience: { kind: 'CIRCLE', circleId: CLIMBING_CREW } })).json().id;
      // Carol is a friend, but not in the climbing circle.
      const res = await app.inject({ method: 'GET', url: `/v1/listings/${id}`, headers: as(CAROL) });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    });

    it('makes an unknown id and a hidden one indistinguishable', async () => {
      const hidden = (await offer({ audience: { kind: 'SELF' } })).json().id;
      const known = await app.inject({ method: 'GET', url: `/v1/listings/${hidden}`, headers: as(BOB) });
      const unknown = await app.inject({ method: 'GET', url: `/v1/listings/${randomId()}`, headers: as(BOB) });
      expect(known.body).toBe(unknown.body);
      expect(known.statusCode).toBe(unknown.statusCode);
    });

    it('caps the browse page', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/listings?limit=500', headers: as(BOB) });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Claiming ───────────────────────────────────────────────────────
  describe('claiming', () => {
    it('accepts a first-come claim immediately and closes the listing', async () => {
      const id = (await offer({ claimMode: 'FIRST_COME' })).json().id;

      const res = await claim(id, BOB);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('CLAIMED');
      expect(res.json().yourClaim.status).toBe('ACCEPTED');

      // The next person is too late, and gets a conflict rather than a silent no-op.
      expect((await claim(id, CAROL)).statusCode).toBe(409);
    });

    it('leaves a lottery entry pending', async () => {
      const id = (await offer({ claimMode: 'LOTTERY', claimsCloseAt: inDays(2) })).json().id;
      const res = await claim(id, BOB);
      expect(res.json().status).toBe('AVAILABLE');
      expect(res.json().yourClaim.status).toBe('PENDING');
    });

    it('refuses a second claim from the same person', async () => {
      const id = (await offer({})).json().id;
      expect((await claim(id, BOB)).statusCode).toBe(200);
      expect((await claim(id, BOB)).statusCode).toBe(409);
    });

    it('refuses a claim once the deadline has passed', async () => {
      // Created with a live deadline, then moved into the past directly through
      // the port — the create route refuses a past deadline, as it should.
      const repos = createMemoryRepositories(createDemoSeed());
      const local = await createServer({ config, repos });
      await local.ready();

      const created = await local.inject({
        method: 'POST',
        url: '/v1/listings',
        headers: as(ALICE),
        payload: {
          title: 'Ladder',
          condition: 'GOOD',
          audience: { kind: 'FRIENDS' },
          claimMode: 'OWNER_SELECTS',
          claimsCloseAt: inDays(1),
        },
      });
      const id = created.json().id;
      const stored = await repos.listings.byId(id);
      await repos.listings.save({ ...stored!, claimsCloseAt: inDays(-1) });

      const res = await local.inject({
        method: 'POST',
        url: `/v1/listings/${id}/claims`,
        headers: as(BOB),
        payload: {},
      });
      expect(res.statusCode).toBe(409);
    });

    it('refuses a claim on your own listing', async () => {
      const id = (await offer({})).json().id;
      expect((await claim(id, ALICE)).statusCode).toBe(404);
    });

    it('refuses a claim from a blocked viewer, indistinguishably', async () => {
      const id = (await offer({ audience: { kind: 'PUBLIC' } })).json().id;
      const res = await claim(id, MALLORY);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    });

    it('never leaks another claimant to a fellow claimant', async () => {
      const id = (await offer({ claimMode: 'LOTTERY', claimsCloseAt: inDays(2) })).json().id;
      await claim(id, BOB, 'I would love this');
      const res = await claim(id, CAROL, 'me too please');

      // Carol sees her own entry and nothing about Bob — not his id, not his
      // message, and not a count that would reveal he exists.
      expect(res.json().yourClaim.message).toBe('me too please');
      expect(res.body).not.toContain(BOB);
      expect(res.body).not.toContain('I would love this');
      expect(res.json().claims).toBeUndefined();
    });

    it('gives the owner every claim, because they have to pick', async () => {
      const id = (await offer({})).json().id;
      await claim(id, BOB, 'yes please');
      await claim(id, CAROL);

      const res = await app.inject({ method: 'GET', url: `/v1/listings/${id}`, headers: as(ALICE) });
      expect(res.json().claims).toHaveLength(2);
      expect(res.json().claims.map((c: { claimantId: string }) => c.claimantId)).toEqual([BOB, CAROL]);
    });
  });

  // ── The draw ───────────────────────────────────────────────────────
  describe('the draw', () => {
    const openLottery = async () => {
      const repos = createMemoryRepositories(createDemoSeed());
      const local = await createServer({ config, repos });
      await local.ready();
      const id = (
        await local.inject({
          method: 'POST',
          url: '/v1/listings',
          headers: as(ALICE),
          payload: {
            title: 'Record player',
            condition: 'WORN',
            audience: { kind: 'FRIENDS' },
            claimMode: 'LOTTERY',
            claimsCloseAt: inDays(1),
          },
        })
      ).json().id;
      return { local, repos, id };
    };

    it('refuses a draw while entries are still open', async () => {
      const { local, id } = await openLottery();
      const res = await local.inject({
        method: 'POST',
        url: `/v1/listings/${id}/draw`,
        headers: as(ALICE),
        payload: {},
      });
      expect(res.statusCode).toBe(409);
    });

    it('picks exactly one winner and declines the rest', async () => {
      const { local, repos, id } = await openLottery();

      for (const person of [BOB, CAROL, DAVE]) {
        await local.inject({
          method: 'POST',
          url: `/v1/listings/${id}/claims`,
          headers: as(person),
          payload: {},
        });
      }

      const stored = await repos.listings.byId(id);
      await repos.listings.save({ ...stored!, claimsCloseAt: inDays(-1) });

      const res = await local.inject({
        method: 'POST',
        url: `/v1/listings/${id}/draw`,
        headers: as(ALICE),
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('CLAIMED');

      const statuses = res.json().claims.map((c: { status: string }) => c.status).sort();
      expect(statuses).toEqual(['ACCEPTED', 'DECLINED', 'DECLINED']);
    });

    it('refuses to let the owner hand-pick a lottery entry', async () => {
      // The fairness property, end to end: entrants were told it was a draw.
      const { local, repos, id } = await openLottery();
      await local.inject({
        method: 'POST',
        url: `/v1/listings/${id}/claims`,
        headers: as(BOB),
        payload: {},
      });

      const claimId = (await repos.listings.claimsFor(id))[0]!.id;
      const res = await local.inject({
        method: 'POST',
        url: `/v1/claims/${claimId}/decide`,
        headers: as(ALICE),
        payload: { decision: 'ACCEPT' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('refuses a draw by anyone but the owner', async () => {
      const { local, id } = await openLottery();
      const res = await local.inject({
        method: 'POST',
        url: `/v1/listings/${id}/draw`,
        headers: as(BOB),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Photos ─────────────────────────────────────────────────────────
  describe('photos', () => {
    const upload = (data: string, actor = ALICE) =>
      app.inject({ method: 'POST', url: '/v1/photos', headers: as(actor), payload: { data } });

    it('stores a real image and serves it back to an entitled viewer', async () => {
      const key = (await upload(PNG_BASE64)).json().key;
      const id = (await offer({ photoKeys: [key] })).json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/v1/listings/${id}/photos/${key}`,
        headers: as(BOB),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      // Never cached: a photo is authorized per viewer like everything else.
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('refuses a photo to someone who cannot see its listing', async () => {
      const key = (await upload(PNG_BASE64)).json().key;
      const id = (await offer({ photoKeys: [key], audience: { kind: 'CIRCLE', circleId: CLIMBING_CREW } })).json().id;

      // Carol is a friend but not in the circle. The key is not a capability.
      const res = await app.inject({
        method: 'GET',
        url: `/v1/listings/${id}/photos/${key}`,
        headers: as(CAROL),
      });
      expect(res.statusCode).toBe(404);
    });

    it('refuses a key that belongs to a different listing', async () => {
      const secretKey = (await upload(PNG_BASE64)).json().key;
      await offer({ photoKeys: [secretKey], audience: { kind: 'SELF' } });
      const decoyId = (await offer({ photoKeys: [] })).json().id;

      // Without the "key belongs to this listing" check, any visible listing
      // would serve as an oracle for every stored photo.
      const res = await app.inject({
        method: 'GET',
        url: `/v1/listings/${decoyId}/photos/${secretKey}`,
        headers: as(BOB),
      });
      expect(res.statusCode).toBe(404);
    });

    it('refuses an SVG, whatever it claims to be', async () => {
      // The XSS case: an SVG is an XML document that may carry <script>, and it
      // would sail past a check that trusted the client's content type.
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
      const res = await upload(svg);
      expect(res.statusCode).toBe(400);
    });

    it('refuses bytes that are not an image at all', async () => {
      expect((await upload(Buffer.from('not an image').toString('base64'))).statusCode).toBe(400);
      expect((await upload('!!!not base64!!!')).statusCode).toBe(400);
    });

    it('refuses an anonymous upload', async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/photos', payload: { data: PNG_BASE64 } });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── Owner lifecycle ────────────────────────────────────────────────
  describe('owner lifecycle', () => {
    it('lets the owner select a claim and marks the item claimed', async () => {
      const id = (await offer({})).json().id;
      await claim(id, BOB);

      const listing = await app
        .inject({ method: 'GET', url: `/v1/listings/${id}`, headers: as(ALICE) })
        .then((r) => r.json());

      const res = await app.inject({
        method: 'POST',
        url: `/v1/claims/${listing.claims[0].id}/decide`,
        headers: as(ALICE),
        payload: { decision: 'ACCEPT' },
      });
      expect(res.json().status).toBe('CLAIMED');
    });

    it('withdraws a listing and cancels its pending claims', async () => {
      const id = (await offer({})).json().id;
      await claim(id, BOB);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/listings/${id}/withdraw`,
        headers: as(ALICE),
        payload: {},
      });
      expect(res.json().status).toBe('WITHDRAWN');
      expect(res.json().claims[0].status).toBe('CANCELLED');
    });

    it('refuses edits and withdrawal by anyone but the owner', async () => {
      const id = (await offer({})).json().id;
      expect(
        (await app.inject({ method: 'PATCH', url: `/v1/listings/${id}`, headers: as(BOB), payload: { title: 'Mine now' } })).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'POST', url: `/v1/listings/${id}/withdraw`, headers: as(BOB), payload: {} })).statusCode,
      ).toBe(404);
    });

    it('cannot move a listing to another mode after the fact', async () => {
      // `UpdateListingInput` has no `claimMode`, so this is ignored rather than
      // refused — the schema is the enforcement.
      const id = (await offer({ claimMode: 'OWNER_SELECTS' })).json().id;
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/listings/${id}`,
        headers: as(ALICE),
        payload: { claimMode: 'FIRST_COME', title: 'Skillet, seasoned' },
      });
      expect(res.json().claimMode).toBe('OWNER_SELECTS');
      expect(res.json().title).toBe('Skillet, seasoned');
    });
  });
});

/** A well-formed id that is certainly not in the store. */
function randomId(): string {
  return '99999999-9999-4999-8999-999999999999';
}
