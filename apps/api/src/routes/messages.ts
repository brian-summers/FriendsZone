import {
  ConversationId,
  MessageId,
  MAX_CONVERSATIONS,
  MAX_MESSAGES_PER_THREAD,
  SendMessageInput,
  UserId,
  type Conversation,
  type ConversationView,
  type Message,
  type ThreadView,
} from '@friendszone/contracts';
import {
  assertAllowed,
  can,
  isParticipant,
  otherParty,
  PolicyDeniedError,
  projectConversation,
  projectThread,
  type ViewerContext,
} from '@friendszone/policy';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineRoute } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';

/**
 * Direct messages — a mailbox, not a chat.
 *
 * Three rules govern this file:
 *
 *  1. **Friends only, and a block ends it.** Sending is gated on an accepted
 *     friendship; `message:send` is deliberately not block-exempt. A refusal is
 *     the same 404 that messaging a nonexistent account produces, so nobody can
 *     probe for a block by trying to write to someone.
 *  2. **No read receipts.** `markRead` moves the caller's own bookmark and
 *     nothing else. There is no route, field, or derived value anywhere that
 *     tells a sender their message was read (ADR 0007's reasoning, applied to
 *     messages).
 *  3. **Conversations are addressed by recipient, never by id.** `send` takes
 *     `toUserId`; the server finds or creates the thread. A caller cannot post
 *     into a conversation they are not part of by guessing an id.
 */

const empty = z.object({});

const requireActor = (actorId: UserId | null, action: string): UserId => {
  if (actorId === null) throw new PolicyDeniedError(action, 'ANONYMOUS');
  return actorId;
};

/** Canonical ordering, matching the storage constraint. */
const ordered = (a: UserId, b: UserId): [UserId, UserId] => (a < b ? [a, b] : [b, a]);

export function buildMessageRoutes(repos: Repositories) {
  /**
   * Load a conversation the caller is party to, or throw the 404 an unknown id
   * produces. Unknown and not-yours are one outcome, as everywhere else.
   *
   * The participation check happens twice, and the first one is not the
   * control. `otherParty` on a conversation you are not on returns the *low*
   * participant, so building a viewer context before checking would ask the
   * kernel about the wrong pair. The early return exists to make the context
   * correct; `can()` below is what decides.
   */
  const own = async (
    id: ConversationId,
    actorId: UserId,
    viewerFor: (ownerId: UserId) => Promise<ViewerContext>,
  ): Promise<Conversation> => {
    const conversation = await repos.messages.conversationById(id);
    if (conversation === null || !isParticipant(conversation, actorId)) {
      throw new PolicyDeniedError('thread:read', 'NOT_PARTICIPANT');
    }
    const viewer = await viewerFor(otherParty(conversation, actorId));
    assertAllowed(can(viewer, { action: 'thread:read', conversation }));
    return conversation;
  };

  return [
    /**
     * The mailbox.
     *
     * Conversations with anyone in a block relationship are omitted entirely —
     * blocking someone should remove them from your inbox, not leave a row you
     * cannot open.
     */
    defineRoute({
      method: 'GET',
      url: '/v1/me/conversations',
      authz: { kind: 'POLICY', action: 'conversation:list' },
      rateLimit: 'READ',
      params: empty,
      query: empty,
      handler: async (ctx): Promise<{ conversations: ConversationView[] }> => {
        const actorId = requireActor(ctx.actorId, 'conversation:list');
        assertAllowed(can(await ctx.viewerFor(actorId), { action: 'conversation:list' }));

        const rows = await repos.messages.conversationsFor(actorId, MAX_CONVERSATIONS);
        const out: ConversationView[] = [];
        for (const conversation of rows) {
          const withId = otherParty(conversation, actorId);
          if ((await repos.social.relationship(actorId, withId)) === 'BLOCKED') continue;

          const profile = await repos.directory.profile(withId);
          if (profile === null) continue;

          const messages = await repos.messages.messagesIn(
            conversation.id,
            MAX_MESSAGES_PER_THREAD,
          );
          out.push(projectConversation(conversation, messages, actorId, profile));
        }
        return { conversations: out };
      },
    }),

    /**
     * One thread. Reading it moves *your* bookmark and nobody else's.
     *
     * `WRITE` rather than `READ` because it mutates that bookmark — a read
     * bucket on a route that writes is exactly what `routes.test.ts` refuses.
     */
    defineRoute({
      method: 'POST',
      url: '/v1/me/conversations/:id/read',
      authz: { kind: 'POLICY', action: 'thread:read' },
      rateLimit: 'WRITE',
      params: z.object({ id: ConversationId }),
      query: empty,
      body: empty,
      handler: async (ctx): Promise<{ read: true }> => {
        const actorId = requireActor(ctx.actorId, 'thread:read');
        const conversation = await own(ctx.params.id, actorId, ctx.viewerFor);
        await repos.messages.markRead(conversation.id, actorId, new Date().toISOString());
        return { read: true };
      },
    }),

    defineRoute({
      method: 'GET',
      url: '/v1/me/conversations/:id',
      authz: { kind: 'POLICY', action: 'thread:read' },
      rateLimit: 'READ',
      params: z.object({ id: ConversationId }),
      query: empty,
      handler: async (ctx): Promise<ThreadView> => {
        const actorId = requireActor(ctx.actorId, 'thread:read');
        const conversation = await own(ctx.params.id, actorId, ctx.viewerFor);

        const withId = otherParty(conversation, actorId);
        const profile = await repos.directory.profile(withId);
        // A thread with an account that no longer exists is not readable as a
        // person; same 404 as any other refusal.
        if (profile === null) throw new PolicyDeniedError('thread:read', 'NOT_PARTICIPANT');

        const messages = await repos.messages.messagesIn(
          conversation.id,
          MAX_MESSAGES_PER_THREAD,
        );
        return projectThread(conversation, messages, actorId, profile);
      },
    }),

    /**
     * Send.
     *
     * Addressed by recipient. The conversation is found or created here, so a
     * caller never names a thread — which means they can never name one they
     * are not on.
     */
    defineRoute({
      method: 'POST',
      url: '/v1/me/messages',
      authz: { kind: 'POLICY', action: 'message:send' },
      rateLimit: 'WRITE',
      params: empty,
      query: empty,
      body: SendMessageInput,
      handler: async (ctx): Promise<{ conversationId: ConversationId }> => {
        const actorId = requireActor(ctx.actorId, 'message:send');
        const recipientId = ctx.body.toUserId;

        // The viewer context is built against the recipient, so `relationship`
        // is the sender's standing with them - which is what the kernel reads.
        const viewer = await ctx.viewerFor(recipientId);
        // A recipient who does not exist and one who blocked the sender must be
        // the same outcome, so the existence check happens before the decision
        // and throws the same error the kernel would.
        if ((await repos.directory.profile(recipientId)) === null) {
          throw new PolicyDeniedError('message:send', 'NOT_FRIENDS');
        }
        assertAllowed(can(viewer, { action: 'message:send', recipientId }));

        const now = new Date().toISOString();
        const existing = await repos.messages.conversationBetween(actorId, recipientId);
        const conversation =
          existing ??
          (await (async () => {
            const [lowUserId, highUserId] = ordered(actorId, recipientId);
            return repos.messages.saveConversation({
              id: randomUUID() as ConversationId,
              lowUserId,
              highUserId,
              createdAt: now,
              lastMessageAt: now,
            });
          })());

        const message: Message = {
          id: randomUUID() as MessageId,
          conversationId: conversation.id,
          senderId: actorId, // ← from the session, never the body
          body: ctx.body.body,
          sentAt: now,
        };
        await repos.messages.addMessage(message);
        await repos.messages.saveConversation({ ...conversation, lastMessageAt: now });

        // Sending is reading: your own message should not badge your mailbox.
        await repos.messages.markRead(conversation.id, actorId, now);

        return { conversationId: conversation.id };
      },
    }),
  ];
}
