import type {
  Conversation,
  ConversationView,
  Message,
  MessageView,
  PublicProfile,
  ThreadView,
  UserId,
} from '@friendszone/contracts';
import { PREVIEW_LENGTH } from '@friendszone/contracts';

/**
 * Projections for the mailbox.
 *
 * Pure, like everything else in this package: no clock, no I/O, no database.
 * Every value that shapes the answer arrives as an argument.
 *
 * The rule these functions exist to enforce is the one from
 * `projection.ts` — a stored entity never crosses the network boundary. A
 * `Conversation` carries **both** participants' read positions, and handing one
 * out would tell a sender exactly when their message was read. Everything below
 * builds a fresh object field by field; a `...conversation` spread anywhere in
 * this file is a privacy bug in the same way a `...event` spread is.
 */

/** The participant who is not the viewer. A conversation always has one. */
export function otherParty(conversation: Conversation, viewerId: UserId): UserId {
  return conversation.lowUserId === viewerId ? conversation.highUserId : conversation.lowUserId;
}

/** Whether this viewer is one of the two parties. */
export function isParticipant(conversation: Conversation, viewerId: UserId): boolean {
  return conversation.lowUserId === viewerId || conversation.highUserId === viewerId;
}

/**
 * The viewer's own read bookmark.
 *
 * Deliberately takes the viewer rather than returning both: there is no caller
 * in this system that legitimately wants the other side's, so the signature
 * does not offer it.
 */
export function readAtFor(conversation: Conversation, viewerId: UserId): string | undefined {
  return conversation.lowUserId === viewerId ? conversation.lowReadAt : conversation.highReadAt;
}

/**
 * How many messages this viewer has not read.
 *
 * Messages the viewer *sent* never count: you have read what you wrote, and a
 * mailbox that badged your own outgoing mail would be wrong in a way users
 * notice immediately.
 *
 * The comparison is strictly `>`, which leaves one real edge: a message that
 * lands in the *same millisecond* as the reader's bookmark is treated as read.
 * `>=` is not the fix — it would count the reader's own read moment forever.
 * In production two writes to one conversation inside a millisecond is
 * vanishingly unlikely and costs at most one missing badge; in tests it is
 * common enough that `messages.test.ts` sequences its writes deliberately.
 */
export function unreadCount(
  conversation: Conversation,
  messages: readonly Message[],
  viewerId: UserId,
): number {
  const readAt = readAtFor(conversation, viewerId);
  return messages.filter(
    (m) => m.senderId !== viewerId && (readAt === undefined || m.sentAt > readAt),
  ).length;
}

const previewOf = (body: string): string => {
  // One line: a newline in the list would break the row, and the rest of a
  // multi-paragraph message is not the mailbox's job to show.
  const firstLine = body.split('\n')[0] ?? '';
  return firstLine.length > PREVIEW_LENGTH
    ? `${firstLine.slice(0, PREVIEW_LENGTH - 1)}…`
    : firstLine;
};

/**
 * One row of the mailbox.
 *
 * `messages` is this conversation's messages, oldest first. `withProfile` is
 * the other party's public profile — passed in rather than looked up, because
 * this package does no I/O.
 */
export function projectConversation(
  conversation: Conversation,
  messages: readonly Message[],
  viewerId: UserId,
  withProfile: PublicProfile,
): ConversationView {
  const last = messages.at(-1);
  return {
    id: conversation.id,
    withUserId: withProfile.id,
    withHandle: withProfile.handle,
    withDisplayName: withProfile.displayName,
    ...(withProfile.avatarUrl === undefined ? {} : { withAvatarUrl: withProfile.avatarUrl }),
    preview: last === undefined ? '' : previewOf(last.body),
    lastMessageAt: conversation.lastMessageAt,
    lastMessageFromYou: last?.senderId === viewerId,
    unread: unreadCount(conversation, messages, viewerId),
    // Note the absence: no `lowReadAt`, no `highReadAt`, and no derived
    // "they have seen it". See the header of this file.
  };
}

export function projectMessage(message: Message, viewerId: UserId): MessageView {
  return {
    id: message.id,
    senderId: message.senderId,
    body: message.body,
    sentAt: message.sentAt,
    mine: message.senderId === viewerId,
  };
}

export function projectThread(
  conversation: Conversation,
  messages: readonly Message[],
  viewerId: UserId,
  withProfile: PublicProfile,
): ThreadView {
  return {
    id: conversation.id,
    withUserId: withProfile.id,
    withHandle: withProfile.handle,
    withDisplayName: withProfile.displayName,
    ...(withProfile.avatarUrl === undefined ? {} : { withAvatarUrl: withProfile.avatarUrl }),
    messages: messages.map((m) => projectMessage(m, viewerId)),
  };
}
