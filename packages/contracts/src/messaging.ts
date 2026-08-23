import { z } from 'zod';
import {
  ConversationId,
  Handle,
  Instant,
  MessageId,
  ShortText,
  UserId,
} from './primitives.js';

/**
 * Direct messages.
 *
 * A mailbox, deliberately: a list of conversations, an unread count, and a
 * thread you open. What it is *not* is a chat. There are no typing indicators,
 * no presence, no delivery ticks, and - the one worth stating outright - **no
 * read receipts**.
 *
 * That last omission is the same decision as ADR 0007's "no read receipts, no
 * seen" on hangout requests, for the same reason: the product exists to remove
 * the obligation to answer now. `readAt` below is the reader's own bookmark. It
 * drives *their* unread badge and is never projected to the other party, so
 * nobody can tell whether their message has been looked at. A sender who knows
 * you have read it and not replied is a sender applying pressure, which is the
 * thing this product is against.
 *
 * ## Who may message whom
 *
 * Accepted friends only. Not `PENDING` - a friend request grants nothing
 * anywhere else in this system and must not become a channel for talking at
 * someone who has not answered it. A block ends it in both directions, and the
 * refusal is indistinguishable from messaging an account that does not exist.
 */

/**
 * A conversation between exactly two people.
 *
 * Canonically ordered like `Friendship`, so a pair has one row and cannot drift
 * into two half-conversations. Unlike `blocks`, one row is correct here: a
 * conversation is a shared object, and there is no per-direction state that one
 * party must be able to change without touching the other's - except read
 * position, which is why there are two of those.
 */
export const Conversation = z.object({
  id: ConversationId,
  lowUserId: UserId,
  highUserId: UserId,
  createdAt: Instant,
  /** Drives mailbox ordering. Updated on every send. */
  lastMessageAt: Instant,
  /**
   * Each participant's own bookmark, stored per side.
   *
   * Two fields rather than one shared value because they answer different
   * questions for different people, and because a single field would let one
   * party's reading move the other's unread count.
   */
  lowReadAt: Instant.optional(),
  highReadAt: Instant.optional(),
});
export type Conversation = z.infer<typeof Conversation>;

/** 🟠 Sensitive. Free text between two named people - never logged. */
export const MessageBody = z.string().trim().min(1).max(4000);

export const Message = z.object({
  id: MessageId,
  conversationId: ConversationId,
  senderId: UserId,
  body: MessageBody,
  sentAt: Instant,
});
export type Message = z.infer<typeof Message>;

// ── Projections ───────────────────────────────────────────────────
//
// Stored rows never cross the network boundary. These are what a viewer gets.

/**
 * One row of the mailbox.
 *
 * Note what is absent: the other party's `readAt`. It is not merely omitted
 * from the projection - asking for it is not a question this API answers.
 */
export const ConversationView = z.object({
  id: ConversationId,
  /** The other person. A conversation always has exactly one. */
  withUserId: UserId,
  withHandle: Handle,
  withDisplayName: ShortText,
  withAvatarUrl: z.string().url().max(2048).optional(),
  /** First line of the most recent message, for the list. */
  preview: z.string().max(160),
  lastMessageAt: Instant,
  /** Whether the last message was yours, so the list can say "You: …". */
  lastMessageFromYou: z.boolean(),
  /** *Your* unread count. The other party's is never computed for you. */
  unread: z.number().int().min(0),
});
export type ConversationView = z.infer<typeof ConversationView>;

export const MessageView = z.object({
  id: MessageId,
  senderId: UserId,
  body: MessageBody,
  sentAt: Instant,
  /** Rendering hint, so the client never has to compare ids to place a bubble. */
  mine: z.boolean(),
});
export type MessageView = z.infer<typeof MessageView>;

export const ThreadView = z.object({
  id: ConversationId,
  withUserId: UserId,
  withHandle: Handle,
  withDisplayName: ShortText,
  withAvatarUrl: z.string().url().max(2048).optional(),
  messages: z.array(MessageView),
});
export type ThreadView = z.infer<typeof ThreadView>;

export const SendMessageInput = z.object({
  /**
   * The recipient, not a conversation id. The server finds or creates the
   * conversation, so a caller can never address a thread they are not part of
   * by guessing an id.
   */
  toUserId: UserId,
  body: MessageBody,
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

/** Bounded, like every list in this API. */
export const MAX_CONVERSATIONS = 50;
export const MAX_MESSAGES_PER_THREAD = 100;
/** Preview length in the mailbox list. */
export const PREVIEW_LENGTH = 160;
