# 0021. Three account presets, none of them Full, and "never chose" is a state

**Status:** Accepted
**Date:** 2026-08-01

## Context

[The roadmap](../product/roadmap.md) rates this the highest value-to-effort item
in the product, for a reason worth restating: **almost nobody changes defaults**,
so the default *is* the privacy control. Everything else - the per-event editor,
the ceiling, circles - is used by a minority on a minority of events.

Today the default-sharing control in Settings is a small rule builder: one row
per audience, a level dropdown on each. It is accurate and it is the wrong shape
for the most important control in the product. A dropdown reading `TITLE` asks
the user to hold the lattice in their head and predict what a friend will see.

Separately, the model cannot currently tell "chose the conservative default" from
"never chose anything" - `sharingDefaults()` returns
`CONSERVATIVE_SHARING_DEFAULTS` when no row exists, so the two are
indistinguishable. Onboarding needs that distinction, because the whole point is
to make the choice *explicit* rather than inherited.

## Decision

### Three named presets, defined once in contracts

`PRIVATE`, `BUSY_TO_FRIENDS`, `OPEN_TO_FRIENDS`, each with rules and a
plain-language consequence:

| Preset | Rules | What a friend sees |
|---|---|---|
| `PRIVATE` | none | Nothing at all |
| `BUSY_TO_FRIENDS` | `FRIENDS → BUSY` | That you're busy; no name, place, or guests |
| `OPEN_TO_FRIENDS` | `FRIENDS → TITLE` | What it's called; not where, not with whom |

They live in `packages/contracts` beside `CONSERVATIVE_SHARING_DEFAULTS` - which
*is* `BUSY_TO_FRIENDS`, defined once and re-exported, so the fallback and the
preset can never drift into disagreeing.

Defining them server-side rather than in the client matters: a preset is a
security-relevant set of grants, and a client-only list is one that a second
client (mobile, later) would re-type slightly differently.

### There is deliberately no one-tap "Friends see everything"

`FULL` shares description, **location**, and the attendee list. As a choice about
*one event* that is fine, and the per-event editor offers it. As an **account
default** it is a standing grant over every event you will ever create, which is
[the stalking abuse case](../security/threat-model.md#stalking-via-freebusy)
written as a settings row: a friendship that goes bad, or an account that gets
taken over, then yields a complete history of where this person is and when their
home is empty.

The three presets span the range a person can hold in their head. Anything wider
stays reachable - per event, or through custom rules - but it costs a deliberate
act rather than one tap on the screen where nobody reads the labels.

Likewise **no `PUBLIC` preset**. Sharing with people you are not friends with is
never the sensible *default*; it is a per-event decision, and the interface
already treats selecting `PUBLIC` as a confirmed act.

### "Never chose" is a distinct state, and the fallback stays conservative

`SharingDefaultsView` carries `chosen: boolean`. False means no explicit choice
has ever been saved - the user is running on the conservative fallback, and the
interface says so and offers the three presets.

Two things this is **not**:

- It is not a nag. It appears once, in Settings, as a card - never a modal, never
  a badge, never repeated. A privacy prompt that pesters is one people learn to
  dismiss without reading, which is worse than not asking.
- It is not a change in behaviour. Someone who never chooses keeps exactly the
  defaults they have today. The flag makes the state *legible*; it does not make
  the unchosen state less safe, and the fallback must stay
  `BUSY_TO_FRIENDS` - an absent row is not consent to share more.

### `CUSTOM` is a first-class answer

`presetOf()` returns `CUSTOM` when the stored rules match no preset. The rule
builder stays, one disclosure down, and a user who has composed something
specific is shown *"Custom"* rather than having their configuration silently
rounded to the nearest preset.

## Consequences

- One more port method (`hasExplicitSharingDefaults`) and one more field on the
  read view. The write path is unchanged: saving any rules, preset or custom,
  marks the choice as made.
- The presets are now a security-relevant constant with a test asserting exactly
  what each grants. Changing one silently widens every unconfigured user, so it
  should be as hard to do accidentally as changing the lattice.
- Someone who wants "friends see everything by default" must set it through
  custom rules. That is friction on purpose, and it will read as a missing
  feature to anyone who has not read this file.

## Alternatives considered

**Keep the rule builder as the primary control.** Accurate, and it asks a user to
predict a projection from a dropdown. The checkup ("see what others see") already
exists precisely because that prediction is hard.

**Four presets, including Full.** Rejected above. The difference between "this
event" and "everything, forever" is the whole argument.

**Force a choice at first run, blocking the app.** A modal in front of a product
nobody has used yet gets dismissed, and a dismissed privacy choice is worse than
an unmade one because it looks decided.
