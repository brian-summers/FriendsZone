import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { DEV_ACTOR_HEADER } from '../http/authenticate.js';
import { createMemoryRepositories, type MemorySeed } from '../repositories/memory.js';
import { ALICE, BOB, CAROL, DAVE, MALLORY, createDemoSeed } from '../seed.js';
import { createServer } from '../server.js';

/**
 * Direct messages, at the HTTP boundary.
 *
 * The assertions worth reading twice are the negative ones. A mailbox is the
 * most natural place in this product to accidentally build a harassment
 * channel or a read receipt, and both would look like ordinary features in a
 * diff.
 */

const config: Config = {
  NODE_ENV: 'test',
  PORT: 0,
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://localhost:5432/test',
  SESSION_SECRET: 'x'.repeat(48),
  PUBLIC_ORIGIN: 'http://localhost:5173',
  MODERATOR_IDS: [],
  REPORTS_EMAIL: 'reports@friends-zone.app',
  RATE_LIMIT_ENABLED: false,
  TRUSTED_PROXY_HOPS: 0,
};

const as = (id: string) => ({ [DEV_ACTOR_HEADER]: id });
const NOBODY_ID = '99999999-9999-4999-8999-999999999999';

describe('direct messages', () => {
  let app: FastifyInstance;

  const boot = async (seed: MemorySeed = createDemoSeed()) => {
    app = await createServer({ config, repos: createMemoryRepositories(seed) });
    await app.ready();
    return app;
  };

  beforeEach(async () => {
    await boot();
  });

  const send = (from: string, to: string, body: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/me/messages',
      headers: as(from),
      payload: { toUserId: to, body },
    });

  const mailbox = async (of: string) => {
    const res = await app.inject({ method: 'GET', url: '/v1/me/conversations', headers: as(of) });
    return res.json().conversations as Array<Record<string, unknown>>;
  };

  const thread = (of: string, id: string) =>
    app.inject({ method: 'GET', url: `/v1/me/conversations/${id}`, headers: as(of) });

  /**
   * Two milliseconds, so consecutive operations get distinct ISO timestamps.
   *
   * `lastMessageAt` and the read bookmark are both millisecond-precision
   * strings, so two writes inside the same millisecond are genuinely
   * indistinguishable to the ordering and unread logic. That is a real (if
   * remote) property of the design, documented on `unreadCount` - it is not
   * something these tests should paper over by accident, so where sequence
   * matters they make it explicit.
   */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

  const markRead = (of: string, id: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/me/conversations/${id}/read`,
      headers: as(of),
      payload: {},
    });

  describe('who may send', () => {
    it('lets friends message each other', async () => {
      // ALICE and BOB are friends in the seed.
      const res = await send(ALICE, BOB, 'Climbing Thursday?');
      expect(res.statusCode).toBe(200);
      expect(res.json().conversationId).toEqual(expect.any(String));
    });

    it('refuses a stranger', async () => {
      // CAROL and DAVE are not friends with each other.
      expect((await send(CAROL, DAVE, 'hello')).statusCode).toBe(404);
    });

    it('refuses someone with only a pending request', async () => {
      // Asking to be someone's friend must not open a channel to talk at them.
      await app.inject({
        method: 'POST',
        url: `/v1/people/${MALLORY}/friend-request`,
        headers: as(BOB),
        payload: {},
      });
      expect((await send(BOB, MALLORY, 'answer me')).statusCode).toBe(404);
    });

    it('answers a blocked recipient exactly as a nonexistent one', async () => {
      // ALICE blocked MALLORY in the seed. If these differed in status or body,
      // MALLORY could probe for the block by trying to write.
      const blocked = await send(MALLORY, ALICE, 'hi');
      const missing = await send(MALLORY, NOBODY_ID, 'hi');
      expect(blocked.statusCode).toBe(missing.statusCode);
      expect(blocked.body).toBe(missing.body);
      expect(blocked.statusCode).toBe(404);
    });

    it('refuses messaging yourself', async () => {
      expect((await send(ALICE, ALICE, 'note to self')).statusCode).toBe(404);
    });

    it('refuses an anonymous sender', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/me/messages',
        payload: { toUserId: BOB, body: 'hi' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('takes the sender from the session, never the body', async () => {
      // There is no field for it, so this asserts the shape rather than a
      // rejection: a body that tries to name a sender is simply ignored.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/me/messages',
        headers: as(ALICE),
        payload: { toUserId: BOB, body: 'hi', senderId: CAROL },
      });
      expect(res.statusCode).toBe(200);
      const [conversation] = await mailbox(BOB);
      const view = await thread(BOB, conversation!['id'] as string);
      expect(view.json().messages[0].senderId).toBe(ALICE);
    });
  });

  describe('the mailbox', () => {
    it('shows one row per conversation, newest first', async () => {
      await send(ALICE, BOB, 'first');
      await tick();
      await send(ALICE, CAROL, 'second');

      const rows = await mailbox(ALICE);
      expect(rows).toHaveLength(2);
      expect(rows[0]!['withUserId']).toBe(CAROL);
      // Stated as a property too, so the assertion still means something if
      // the fixture ever grows a third conversation.
      const times = rows.map((r) => r['lastMessageAt'] as string);
      expect([...times].sort().reverse()).toEqual(times);
    });

    it('reuses one conversation per pair rather than making a second', async () => {
      await send(ALICE, BOB, 'one');
      await send(BOB, ALICE, 'two');
      expect(await mailbox(ALICE)).toHaveLength(1);
      expect(await mailbox(BOB)).toHaveLength(1);
    });

    it('counts unread for the recipient and not for the sender', async () => {
      await send(ALICE, BOB, 'hello');
      expect((await mailbox(BOB))[0]!['unread']).toBe(1);
      // You have read what you wrote.
      expect((await mailbox(ALICE))[0]!['unread']).toBe(0);
    });

    it('clears unread once the recipient opens it', async () => {
      await send(ALICE, BOB, 'hello');
      const id = (await mailbox(BOB))[0]!['id'] as string;
      await markRead(BOB, id);
      expect((await mailbox(BOB))[0]!['unread']).toBe(0);
    });

    it('drops a conversation with someone who is blocked', async () => {
      await send(ALICE, BOB, 'hello');
      expect(await mailbox(ALICE)).toHaveLength(1);

      await app.inject({
        method: 'PUT',
        url: `/v1/people/${BOB}/block`,
        headers: as(ALICE),
        payload: {},
      });
      // Blocking should remove them from your inbox, not leave a row you
      // cannot open.
      expect(await mailbox(ALICE)).toEqual([]);
      expect(await mailbox(BOB)).toEqual([]);
    });
  });

  describe('no read receipts', () => {
    it('never tells the sender their message was read', async () => {
      await send(ALICE, BOB, 'did you see this');
      const id = (await mailbox(BOB))[0]!['id'] as string;
      await markRead(BOB, id);

      // Nothing in ALICE's mailbox row changes, and nothing in the serialised
      // body names a read time. This is the assertion that stops a future
      // "seen" feature from arriving by accident.
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/conversations',
        headers: as(ALICE),
      });
      expect(res.body).not.toContain('readAt');
      expect(res.body).not.toContain('ReadAt');
      expect(res.body).not.toContain('seen');
      expect(res.json().conversations[0].unread).toBe(0);
    });

    it('keeps read state out of the thread view too', async () => {
      await send(ALICE, BOB, 'hi');
      const id = (await mailbox(BOB))[0]!['id'] as string;
      await markRead(BOB, id);

      const res = await thread(ALICE, id);
      expect(res.body).not.toContain('readAt');
      expect(res.body).not.toContain('ReadAt');
    });

    it('does not let one reader clear the other unread count', async () => {
      /**
       * Both sides cannot be unread at once - sending marks the sender read,
       * which is correct and is why two earlier versions of this test passed
       * for the wrong reason. The property that actually matters is narrower:
       * ALICE moving *her* bookmark must not touch BOB's.
       */
      await send(ALICE, BOB, 'unread for bob');
      const id = (await mailbox(ALICE))[0]!['id'] as string;
      expect((await mailbox(BOB))[0]!['unread']).toBe(1);

      await tick();
      await markRead(ALICE, id);

      // BOB has still not opened it.
      expect((await mailbox(BOB))[0]!['unread']).toBe(1);
    });
  });

  describe('reading a thread', () => {
    it('is refused for a third party', async () => {
      await send(ALICE, BOB, 'private');
      const id = (await mailbox(ALICE))[0]!['id'] as string;
      expect((await thread(CAROL, id)).statusCode).toBe(404);
    });

    it('survives unfriending but not a block', async () => {
      await send(ALICE, BOB, 'still here');
      const id = (await mailbox(ALICE))[0]!['id'] as string;

      await app.inject({
        method: 'DELETE',
        url: `/v1/people/${BOB}/friendship`,
        headers: as(ALICE),
        payload: {},
      });
      // Unfriending stops new messages; it does not confiscate correspondence
      // that already happened (the reasoning of ADR 0022).
      expect((await thread(ALICE, id)).statusCode).toBe(200);
      expect((await send(ALICE, BOB, 'again')).statusCode).toBe(404);

      await app.inject({
        method: 'PUT',
        url: `/v1/people/${BOB}/block`,
        headers: as(ALICE),
        payload: {},
      });
      // A block does end it. `thread:read` is deliberately not block-exempt.
      expect((await thread(ALICE, id)).statusCode).toBe(404);
      expect((await thread(BOB, id)).statusCode).toBe(404);
    });

    it('returns messages oldest first, with a rendering hint', async () => {
      await send(ALICE, BOB, 'first');
      await send(BOB, ALICE, 'second');
      const id = (await mailbox(ALICE))[0]!['id'] as string;

      const body = (await thread(ALICE, id)).json();
      expect(body.messages.map((m: { body: string }) => m.body)).toEqual(['first', 'second']);
      expect(body.messages.map((m: { mine: boolean }) => m.mine)).toEqual([true, false]);
    });

    it('refuses an unknown conversation id the same way as someone else’s', async () => {
      await send(ALICE, BOB, 'private');
      const real = (await mailbox(ALICE))[0]!['id'] as string;
      const fake = '88888888-8888-4888-8888-888888888888';

      const notMine = await thread(CAROL, real);
      const notReal = await thread(CAROL, fake);
      expect(notMine.statusCode).toBe(notReal.statusCode);
      expect(notMine.body).toBe(notReal.body);
    });
  });

  describe('validation', () => {
    it('refuses an empty message', async () => {
      expect((await send(ALICE, BOB, '   ')).statusCode).toBe(400);
    });

    it('refuses one past the length bound', async () => {
      expect((await send(ALICE, BOB, 'x'.repeat(4001))).statusCode).toBe(400);
    });
  });
});
