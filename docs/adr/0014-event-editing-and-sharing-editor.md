# 0014. Events are editable, and the sharing editor is real

**Status:** Accepted
**Date:** 2026-07-24

## Context

Two of the longest-standing gaps, both flagged repeatedly in the client and
docs:

- You could **create** an event but never change or delete it.
- The **per-event sharing editor** - called "the most important screen in the
  product" in [the interface design](../design/interface.md) - was read-only,
  and sharing **defaults** were read-only too. Since almost nobody changes
  per-event sharing, the default is the privacy control most people live with,
  and it could not be changed at all.

Both are squarely on the product's central goal: a calendar whose privacy you
actually control.

## Decision

**`PATCH` / `DELETE /v1/events/:id`**, gated by the existing `event:modify`
action (owner-only). No new authorization concept - editing is the same right as
creating, on an event you own. Two guards:

- **Hangout-origin events are refused** (`409`). An event created by accepting a
  hangout is managed *through its hangout* ([ADR 0012](0012-hangout-lifecycle.md))
  so the two calendar copies never drift; editing one copy directly would break
  that. The refusal points the client back to the hangout.
- Ownership check first, and "unknown id" collapses into "not yours" - the same
  indistinguishable `404` the rest of the API uses.

**The sharing editor is just `PATCH` carrying new `shareRules` and
`visibilityCeiling`.** No bespoke endpoint. The editor is a thin UI over the
event write:

- Audiences are **rows**, levels an **ordinal slider** - the visibility lattice
  is ordered, so the control is.
- Each choice states its **consequence in plain words** (from the shared design
  tokens), never the schema's vocabulary.
- **Circle rules are preserved.** The client has no circle roster, so it edits
  only the Friends and Everyone rows and leaves any circle grants untouched
  rather than silently dropping them.

**Sharing defaults are editable** via `GET` / `PUT /v1/me/sharing-defaults`
(new `sharing:manage` action, self-scoped). The Settings screen is now a real
editor for the control most people actually rely on.

**The owner learns their own event's rules.** For the editor to load current
state, the owner's `FULL` view now carries `shareRules` and
`ownVisibilityCeiling` - populated *only* in the owner branch of
`projectCalendar`, exactly like the existing `sharedAs`. A test asserts a
non-owner's `FULL` view never carries any of the three. The client still never
computes visibility itself: it writes rules, and the server's projection remains
the single source of truth. Reopen the event to see the result.

## Consequences

- The calendar is closer to a complete tool: create, edit, re-share, delete,
  and manage hangouts all happen there.
- Adding owner-only fields to `EventFullView` is the third use of the
  "populate only in the owner branch" pattern (`sharedAs`, `shareRules`,
  `ownVisibilityCeiling`). It is now clearly a pattern worth its test:
  `projection.test.ts` checks all three are absent for non-owners.
- "No rule at all" and "private" are different in the model - empty rules mean
  *inherit defaults*. The editor resolves this by writing a `HIDDEN` ceiling
  when you choose to share with no one, so "private" is unambiguous.
- Deleting is a hard remove, not a status flip. Cancelling (which keeps the row
  and hides it from non-owners) remains the hangout path; a plain event you no
  longer want is simply gone.

## Alternatives considered

**A dedicated sharing endpoint** (`PUT /v1/events/:id/sharing`). Tidy-looking,
but sharing *is* an event property; a second write path to the same row is more
surface to secure and keep consistent. One `PATCH` that happens to carry rules
is simpler and already covered by the ownership gate.

**A live preview of the pending edit** ("here's what Bob would see if you
save"), rendered by the real engine. The right long-term shape, but it needs a
"project with these unsaved rules" endpoint. Deferred: today the editor shows
plain-language consequences and the calendar reflects the result on save, which
is honest without a new endpoint. Noted as the next refinement.

**Client-side visibility preview.** Rejected on the same grounds as always - a
second implementation of the security model that will drift. The client writes
rules and asks the server.
