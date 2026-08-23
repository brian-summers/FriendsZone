# 0029. Direct messages are a mailbox; discoverability is the user's to set

**Status:** Accepted
**Date:** 2026-08-23

## Context

Two gaps, related by the same question — *who is allowed to reach you?*

**People were hard to find and requests were easy to miss.** Search, friend
requests, unfriending and blocking all lived inside Settings. Adding a friend is
the first thing a new account must do, and answering a request is the one
mildly time-sensitive thing this product has; burying both behind a settings
menu meant a request could sit unseen for a week.

**There was no way to say "don't find me".** Search returned anyone who was not
in a block relationship. `PublicProfile` is deliberately minimal, so being
found costs a handle and a display name — but "minimal" is not "nothing", and
some people have a specific person they do not want to be findable by.

**And there was no way to say anything at all.** The product could arrange a
hangout but not ask *"still on for Thursday?"*. Every existing channel — a
hangout note, a report — is attached to some other object.

## Decision

### Messaging is a mailbox, not a chat

A list of conversations, an unread count, a thread you open, and a box to write
in. What is deliberately absent is the vocabulary of a chat app: no presence, no
typing indicator, and **no read receipts**.

That last one is [ADR 0007](0007-async-by-design.md) applied to a new surface.
The stored `Conversation` carries a read bookmark *per participant*, and it is
never projected to the other side. A sender who knows you have read their
message and not replied is a sender applying pressure, which is precisely what
this product exists to remove. `messages.test.ts` asserts the serialised body of
both the mailbox and the thread contains no `readAt`, no `ReadAt` and no `seen`
— a string assertion, because the failure mode is a future field arriving by
accident rather than by decision.

Two read columns rather than one shared value, for the same reason `blocks` has
two rows: one party's action must not change the other's state.

**Friends only, and `FRIEND` exactly.** Not `PENDING` — asking to be someone's
friend must not open a channel to talk at them while they think about it.
`message:send` is deliberately **not** in `BLOCK_EXEMPT_ACTIONS`, unlike
`report:*`, and the refusal is the same 404 that messaging a nonexistent account
produces, so nobody can probe for a block by trying to write.

**Reading survives an unfriend but not a block.** These are different
relaxations and only one is granted. Unfriending drops `relationship` to `NONE`
and `thread:read` still allows — correspondence that already happened is not
confiscated, the same reasoning as [ADR 0022](0022-export-and-deletion.md) on
the counterparty's copy of a shared plan. Blocking ends it, because the block
gate runs above the switch and `thread:read` is not exempt. Adding an exemption
there would have meant someone you blocked could reopen the thread, and
non-negotiable #3 forbids that by default.

**Conversations are addressed by recipient, never by id.** `SendMessageInput`
carries `toUserId`; the server finds or creates the thread. A caller therefore
cannot post into a conversation they are not part of by guessing an id, because
there is no field in which to name one.

### Discoverability has three values, and the missing fourth is the point

| Value | Matches |
|---|---|
| `EVERYONE` | handle prefix, or display-name substring. The default |
| `EXACT_HANDLE` | a complete handle, nothing shorter |
| `NOBODY` | never |

There is deliberately **no `FRIENDS_OF_FRIENDS`**. Answering it requires walking
the graph one hop out from the searcher, and the threat model relies on that
traversal being impossible — `/v1/people` is self-only for exactly this reason.
A setting that reads as a privacy *restriction* would have quietly built the
graph-traversal endpoint the rest of the design refuses. That is the worst place
in the product to add one.

`EXACT_HANDLE` is the interesting value: it keeps you out of substring and
name results while leaving you reachable by someone who already has your handle
— found by people you gave it to, rather than by people scrolling.

**Opting out must not be detectable.** A `NOBODY` account returns the same empty
list as a handle nobody has, asserted byte-for-byte. Nobody is ever told what
anyone else's setting is; `discoverability` is on `MeView` and on no projection
that reaches another person, because *"why can't I find them"* is itself an
answer about them.

This is a **match** rule, not an authorization one — it says what the query
means for that row — so it lives in the adapter beside the tombstone filter,
while the viewer-relative block filter stays in the route.

### People gets its own screen

`/people` is a top-level destination with a nav badge for pending requests, and
incoming requests render first, above the fold. `/messages` sits beside it with
an unread badge. Both badges are quiet numbers, never a red pulsing dot.

## Consequences

Easy: someone can be found, added, and talked to without opening Settings. A
person who does not want to be found has three honest choices, and choosing the
strictest is invisible to everyone else.

Hard: messaging is a harassment surface in a way a calendar is not. The
mitigations are the friendship requirement, the block, the existing report flow,
and rate limiting — but they are mitigations, not a guarantee, and moderation
load will rise before anything else does.

Accepted costs:

- **No read receipts is a real product cost.** People expect them, and their
  absence will read as a missing feature before it reads as a decision. The
  copy on the screen does not apologise for it.
- **Unread is millisecond-precision.** A message landing in the same
  millisecond as the reader's bookmark is treated as read. `>=` is not the fix
   — it would count the reader's own read moment forever. The cost is at most
  one missing badge, in a case that is vanishingly unlikely outside tests.
- **Messages survive account deletion.** `MessagePort` has no `eraseUser`:
  deleting your account does not reach into someone else's mailbox and remove
  what you said to them. Consistent with ADR 0022, and it will surprise
  somebody.

## Alternatives considered

**Read receipts, defaulted off.** Rejected. A per-user toggle makes *not* having
them a signal in itself — "why is yours off?" — and the setting would have to be
projected to the other party to render, which is the disclosure.

**Messaging open to anyone, with blocking as the remedy.** Rejected: that is
opt-out harassment, and it puts the burden on the person being contacted.

**`FRIENDS_OF_FRIENDS` discoverability.** Rejected on threat-model grounds, as
above. It is the option users would most expect, and the one this design most
firmly refuses.

**Per-message read flags instead of a per-conversation bookmark.** More precise
and more storage, for a mailbox that shows a count. The bookmark is what a
standard mailbox does.
