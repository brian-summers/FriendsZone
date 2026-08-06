# 0023. A circle is owner-only, keeps ex-friends, and scrubs its rules when deleted

**Status:** Accepted
**Date:** 2026-08-01

## Context

`Circle` has existed since the foundation pass and is referenced by the audience
model, the sharing editor, and listing audiences. There has never been a way to
create one. The seeded "climbing crew" is the only circle that can exist, which
makes `CIRCLE` audiences effectively undeliverable — a capability the model
carries and the product cannot reach.

Building the management surface is small. Three decisions in it are not obvious,
and one of them is a privacy property that is easy to break by accident.

## Decision

### A circle is visible only to its owner — its name most of all

Circle names and rosters are returned to the owner and to nobody else. There is
no endpoint that answers "which circles am I in", for anyone, ever.

This is already the stated intent —
[the domain model](../architecture/domain-model.md) says *"Bob is never told he
is in 'Reluctant Work Friends'"* — but until now nothing shipped that could
violate it. Now something can, so it is worth naming the failure mode: the
tempting feature is a profile that says "you're in 3 of Alice's circles", or a
sharing checkup that explains *why* someone can see an event. Both leak a
taxonomy of the owner's social life that the owner built privately, and the
second is the more dangerous because it looks like transparency.

The checkup already answers the safe version of that question — *what* Bob can
see — without answering the unsafe one.

### The roster keeps people who are no longer friends

Removing a friendship does **not** remove that person from circle rosters. This
is existing behaviour and it is deliberate: `audienceMatches` re-checks
friendship at read time, so a stale roster entry grants nothing. That re-check is
the control; the roster is just a list.

What is new is that the owner can now *see* the roster, so it has to be honest
about it. A member who is no longer a friend is shown as inactive rather than
silently dropped: dropping them would rewrite the owner's list without asking,
and hiding them would make a name reappear if the friendship resumed, with no
explanation.

### Deleting a circle scrubs the rules that named it

A `ShareRule` referencing a deleted circle already fails closed —
`sharedCircles` cannot return an id that no longer exists, so nobody matches.
Safe, and confusing: the owner would keep seeing a rule for a circle that is
gone, in the editor, forever.

So deletion also removes `CIRCLE` rules naming it from the owner's sharing
defaults and from every event they own. The fail-closed behaviour remains the
backstop if a scrub is ever incomplete — it is defence in depth, not the plan.

Deliberately **not** done: refusing to delete a circle that is in use. That traps
a user inside a grouping they no longer want, and "delete the thing you made" is
not a request that should be denied on our convenience.

### Membership is offered from friends only

Adding a non-friend to a circle is refused at the edge. Not because it would
grant anything — the friendship re-check means it would not — but because a
roster containing people who can never match is a list that lies to its owner
about who can see their calendar.

## Consequences

- One more port, one more route group, and a `Circles` section in Settings.
- Deleting a circle now writes to every event the owner has. Bounded by their own
  calendar, and rare. A Postgres adapter should do it in one statement rather
  than a scan.
- The sharing editors can finally offer circle audiences, which is the point.
- The "no circles you're in" rule is now a thing a reviewer must actively hold.
  It is in CLAUDE.md's non-negotiables for that reason.

## Alternatives considered

**Tell members which circles they are in.** Reciprocal and friendly-sounding. It
publishes exactly the taxonomy circles exist to keep private, and "Alice put you
in Close Friends" is a sentence that damages friendships in both directions.

**Scrub rosters on unfriend.** Tidier, and it silently edits the owner's lists on
someone else's action, then loses the grouping permanently if the friendship
resumes. The re-check already makes stale entries harmless.

**Block deletion while a circle is referenced.** Traps the user; see above.
