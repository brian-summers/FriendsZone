# Interface design

Screen-level design decisions. Visual tokens are in
[design-system.md](design-system.md); the privacy encodings they depend on are
specified in [`visibility.ts`](../../packages/design-tokens/src/visibility.ts).

---

## 1. The Week — the home surface

**Chrome.** A single bar: `Friendszone` · Week · Month · Inbox (with an unread
count) · Things · theme toggle. Below it, `‹ March 2 – 8, 2026 ›` on the left
and `+ New` on the right.

**The grid.** A mono, tabular time gutter down the left; one column per day.

| | Mon 2 | Tue 3 | Wed 4 | Thu 5 | Fri 6 |
|---|---|---|---|---|---|
| **09:00** | *Busy* — hatched fill, no title | | | **Climbing** — solid fill | |
| **10:00** | ⟨same block⟩ | | | ⟨same block⟩, "2 going" | |
| **11:00** | ⟨same block⟩ | | | ⟨same block⟩ | |
| **12:00** | | | | | |
| **13:00** | | **Dentist** — dashed outline, Private | | | |
| **14:00** | | | | | |

The Monday block is somebody else's event shared with you at `BUSY`: hatched,
no name. Tuesday's is your own at `HIDDEN` — dashed outline, visible only to
you. Thursday's is confirmed and shared, so it reads solid.

**Chips carry two independent channels.** Hue is the user's own category
colour. Fill treatment is the visibility level — dashed outline for Private,
hatched for Busy, tinted for Name only, solid for Everything. Keeping them
independent is what lets someone colour-code their life however they like
without the colour ever implying something false about who can see it.

**On your own calendar, the treatment answers "who can see this?"** — it shows
the *widest* level any of your rules grants. That is the number that can hurt
you, and it should be the one visible without opening anything.

**On a friend's calendar, the treatment shows what you received.** Same visual
language, different meaning, and the header states which: *"Alice's week — what
she shares with you."* Never let a viewer wonder whether they are seeing
everything.

**Nothing indicates hidden events.** No ghost blocks, no "3 private events", no
faint gaps. The absence must be indistinguishable from genuinely free time —
this is a hard requirement from
[the visibility spec](../architecture/visibility-and-privacy.md), not a
stylistic preference, and it is the single easiest place for a well-meaning
interface change to break the privacy model.

**Firm versus tentative is its own visual axis.** Confirmed plans are solid.
Pending hangout slots — and any tentative event — are dashed and washed, with a
"Pending" marker and a clock glyph, so "not locked in" reads at a glance. This
axis is deliberately orthogonal to the visibility encoding (which answers *who
can see*, a different question from *how firm*); the two never share a channel.
A small legend keys firm / tentative / busy.

**The calendar is the single pane of glass.** Everything except settings happens
here: create an event, request time on a friend's week, and — by tapping a
tentative hold — accept a slot, decline, or withdraw, all in place. A hold
carries the viewer's role, so it only ever offers the action they can take.
Tentative holds are participant-scoped ([ADR 0011](../adr/0011-tentative-holds.md)):
you see a hold only for a request you are part of, never a third party's.

---

## 2. The sharing editor — the most important screen in the product

This is where a user decides who sees their therapy appointment. It gets more
care than anything else.

Titled **Who can see "Dentist"?**. One row per audience, each an ordinal slider
across the four levels — audiences are rows, levels are positions, so the
ordering of the lattice is the ordering on screen.

| Audience | Level | Rendered as |
|---|---|---|
| Everyone else | **Private** | dashed outline · 🔒 · the word *Private* |
| Friends | **Busy** | hatched fill · ▨ · the word *Busy* |
| Climbing crew (4) | **Name only** | tinted fill · ▣ · the words *Name only* |

Below the rows, a live preview built by the server, not the client:

> **Preview as ▾ Bob**
>
> Tue 3 — a hatched block, *Busy*, 09:00 – 11:00
>
> Bob cannot see the name, place, or notes.

Four decisions worth defending:

**Audiences are rows, levels are a slider.** The lattice is ordinal, so the
control is ordinal. A dropdown of four options loses the "more/less" relationship
that is the whole point.

**Live preview, rendered by the real projection engine.** Not a mock-up of what
Bob would see — the actual `projectCalendar` output for Bob. Showing someone
their own calendar through another person's eyes is worth more than any settings
copy, and it costs almost nothing because the engine already does exactly this.

**Widening asks; narrowing does not.** Moving a slider right shows a
confirmation stating the consequence in plain words. Moving it left applies
instantly with no dialogue. A user retreating toward privacy must never be
slowed down or asked whether they are sure. Friction goes on the dangerous
direction only.

**Consequences, not vocabulary.** *"Bob will be able to read the name of this
event"* — never *"visibility: TITLE"*.

### The sharing checkup

A periodic prompt: *"Here's what Bob can see of your week."* Same engine, same
preview component, no new backend. It converts a correct privacy model into a
*legible* one, which is the difference between being private and feeling
private.

---

## 3. The Inbox — asynchronous by construction

One card per request. The whole card is the ask:

> ### Bob asked about climbing
> Any of these?
>
> | | When | Your availability |
> |---|---|---|
> | ○ | Tue 3, 19:00 – 21:00 | you're free |
> | ● | Thu 5, 19:00 – 21:00 | you're free |
> | ○ | Sat 7, 12:00 – 14:00 | you're busy |
>
> `[ Works for me ]`  `[ None of these ]`
>
> No longer needs an answer after Feb 28

Your own availability is shown against each slot, so answering never means
opening a second surface to check. The expiry line is the product's voice
working: *"no longer needs an answer"*, never *"expired"*.

**No read state, anywhere.** Not stored, not rendered, and there is nowhere in
the schema to put it ([ADR 0007](../adr/0007-async-by-design.md)).

**Expiry is a date, never a countdown.** "No longer needs an answer after Feb
28" is a fact. "Expires in 2 days" is a deadline, and a ticking timer is the
precise feeling this product exists to remove.

**Declining is one tap and needs no reason.** The reason field is the thing that
makes people avoid answering at all.

**Your own availability is annotated inline** — you should never have to open a
second view to answer. It is drawn from your own calendar, so no privacy
question arises.

---

## 4. Finding a time together

Titled **When are we all free?**

> **With:** `Bob ×` `Carol ×` `Dave ×` `+ add`
> **Sometime in:** next two weeks ▾ **For:** 2 hours ▾
>
> | When | Who is free |
> |---|---|
> | Thu 5, 19:00 – 21:00 | all 3 free |
> | Sat 7, 14:00 – 16:00 | all 3 free |
> | Sun 8, 11:00 – 13:00 | 2 of 3 free |
>
> ⓘ Dave doesn't share availability with you, so he's shown as free.
> `[ Ask Dave to share ]`

That last line stays on the page and is not an explainer popover. A slot the
finder cannot actually vouch for must say so where the answer is read, or the
result is quietly wrong ([ADR 0008](../adr/0008-slot-finder-on-projections.md)).

The callout is the honest part, and it is doing security work. The suggestion
engine runs on **projections, not raw calendars** — see
[ADR 0008](../adr/0008-slot-finder-on-projections.md) — so someone who shares
nothing appears free. Rather than hide that limitation, the interface names it
and offers the fix. A wrong suggestion the user can explain is better than a
right suggestion built on data they were not entitled to.

Results are quantized to a 15-minute grid so exact boundaries are never
revealed.

---

## 5. Things — the marketplace

Brass rather than verdigris throughout, so the trading surface is instantly
distinguishable from the scheduling surface at a glance.

A photo-led card grid, with `+ Offer` in the header. Each card carries a photo,
a title, condition and price, and who is offering it:

| Photo | Title | Condition · price | From |
|---|---|---|---|
| ▢ | Desk lamp | Good · Free | Alice |
| ▢ | Wok | Like new | Carol |
| ▢ | Skis 170cm | Worn · $40 | Bob |

Photo-led and card-shaped on purpose — it should not be mistakable for the
scheduling surface at a glance.

**The exchange flow ends in two people meeting**, so it carries safety
affordances the rest of the product does not need: suggested public meeting
places, a one-tap *share this plan with a friend*, and a report control present
in the flow itself rather than buried in settings.

The resulting calendar event is capped at `BUSY` for everyone else. Third
parties learn someone is occupied; they never learn where or with whom.

---

## 6. Mobile

The week grid does not survive a phone screen. Below 640px it becomes an
**agenda list** — one day per section, chips full-width, the time gutter
collapsing to a leading mono column.

The visibility treatment survives the transition **completely**. All four
channels — fill, border, glyph, label — render at every breakpoint. Compact
density may reduce padding; it may never drop a channel. A user checking a
sharing setting one-handed on a bus is exactly the person most likely to
misread it.

---

## Helptext, and what may be hidden behind a control

Screens accumulate explanation. The pressure to tidy one up by tucking a
sentence behind an `ⓘ` is constant, and giving in to it in the wrong place is a
safety regression rather than a visual improvement — so the line is drawn once,
here.

**May be hidden** (an `<Explainer>` popover): orientation. What a section is
for, why it exists, how to use the search box. Read once, noise thereafter.

**Must stay on the page**: anything that tells someone what will happen to
them.

| Stays visible | Because |
|---|---|
| Visibility levels — fill, border, glyph, **and label** | The fourth channel is a word. [`visibility.ts`](../../packages/design-tokens/src/visibility.ts) says it plainly: *always rendered as text, never a tooltip, never hover-only* |
| Sharing consequences (`.consequence`) | "Bob will be able to read the name of this event" is the decision, not a footnote to it |
| What blocking does, and what deletion keeps | Stated at the moment of an irreversible action, or it is not really stated |
| A circle's name never leaving its owner | Someone choosing what to call a group needs to know the name is theirs alone *while they type it* ([ADR 0023](../adr/0023-circle-management.md)) |
| Why a control is disabled | A disabled control is not focusable, so a tooltip on one reaches nobody |

Two source-level tests enforce this: `helptext.test.ts` fails if a
`.consequence` ever appears inside an `<Explainer>`, and if any DOM element
grows a `title=` attribute.

**Popovers open on click, never on hover.** There is no hover on a phone; WCAG
1.4.13 requires hover content to be dismissible, hoverable, and persistent, and
a `:hover` div is none of those. The trigger is a real `<button>` with
`aria-expanded`, Escape closes it and returns focus, and an outside press
dismisses it.

**`title=` is never the answer.** Delayed, unstyleable, invisible to touch, and
inconsistently announced. One lived on the week grid's *"others see"* badge and
never fired at all — that element has `pointer-events: none`.

## Accessibility

- **Never colour alone.** Four redundant channels on every visibility state,
  enforced by [`contrast.test.ts`](../../packages/design-tokens/src/contrast.test.ts).
- WCAG AA on every foreground/ground pair in both themes, as a build gate.
- Event chips are focusable with a visible focus ring; the week grid is arrow-key
  navigable as a grid, not a tab sequence.
- Times get `<time datetime>` so screen readers announce them properly, and are
  read as "9 to 11 AM Tuesday", not "0900-1100".
- A chip's accessible name includes its visibility: *"Dentist, 9 to 11 AM,
  shared as Busy."*
- `prefers-reduced-motion` removes all transitions.
