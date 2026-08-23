# Design system

Tokens live in [`packages/design-tokens`](../../packages/design-tokens/src/) and
are the source of truth. This document is the reasoning; the code is the
specification, and `contrast.test.ts` is the enforcement.

## The direction: an appointment book, not a dashboard

Friendszone's ancestor is the paper day planner - ruled columns, a time gutter,
hand-blocked hours. Its opposite is the notification-driven social app: red
badges, urgent gradients, motion competing for attention.

Every visual decision below leans toward the first and away from the second,
because the product's entire premise is *lowering* the stakes of making plans.
An interface that looks urgent undermines the thing it is delivering.

## Color

### Verdigris and brass

Oxidised copper against aged metal. The palette is drawn from materials that
change slowly, which is the correct emotional register for a product about
plans that can wait.

Practically, it also solves a positioning problem: calendars are blue (Google,
Outlook, Apple) and social apps are blue or purple. Verdigris is adjacent
enough to feel like scheduling software and far enough to not look like a
clone.

| Token | Light | Dark | Role |
|---|---|---|---|
| `ground` | `#F1F4F0` | `#0D1412` | Page |
| `surface` | `#FFFFFF` | `#151E1B` | Cards, panels |
| `sunken` | `#E7EBE5` | `#1D2825` | Inputs, the grid behind events |
| `rule` | `#C6D0C4` | `#31403B` | Hairlines |
| `ink` / `ink2` / `ink3` | `#131C18` / `#495650` / `#5E6C65` | `#E7EDE9` / `#A9B6B0` / `#8B9993` | Text, three weights |
| `verdigris` | `#136B58` | `#5CC2A6` | Primary action, brand |
| `brass` | `#7C591A` | `#D2A459` | Marketplace, RSVP-yes, warm accent |
| `madder` | `#9B3B32` | `#E3877D` | Destructive |
| `amber` | `#7A5A12` | `#D9B166` | Caution |

The neutrals are green-biased rather than pure grey - a faint shift toward the
accent so they read as chosen. On a warm cream ground the verdigris would turn
muddy; on a blue-grey ground it would look sickly.

### Two rules that are not negotiable

**Semantic colors are deliberately quiet.** `madder` is a muted rose-brick, not
a fire-engine red. In a product built to lower stakes, deleting an event should
read as *serious*, not as an emergency. The one place genuine alarm is warranted
- reporting a safety problem with an exchange - earns it through weight,
iconography, and confirmation copy rather than by turning the palette up.

**Never hard-code text color on a filled surface.** Use `onVerdigris` for
buttons and `--on-hue` for a filled event chip. White on verdigris is
6.42:1 in light and **2.16:1 in dark**, because dark-theme verdigris is lifted
to stay legible on a dark ground. A hard-coded `#fff` passes a light-mode
eyeball check and ships an unreadable dark-mode button. This is exactly the
class of bug a token prevents and a hex value invites.

## Palettes and modes

A theme is **two independent choices**: a palette and a mode. They are kept
separate for one reason - collapsing them into a single list of six options
would mean someone who needs the colourblind-safe hues has to accept whichever
lighting condition that entry happened to ship with. Nobody should have to
trade dark mode for legibility.

| Palette | For |
|---|---|
| **Verdigris** | The default. Oxidised copper and aged metal |
| **Harbor** | Cooler - slate and deep blue instead of green |
| **Signal** | Colour vision deficiency. Neutral chrome, so the only saturated colour on screen is the one carrying information |

`data-palette` and `data-theme` are independent attributes on the root, and
`tokens.css` spells out **all four** palette-and-mode combinations for every
palette. That is not redundancy: `:root[data-theme='dark']` and
`:root[data-palette='signal']` have equal specificity, so without the explicit
pair the winner would be decided by source order, and Signal-plus-dark would
silently get Verdigris's chrome behind Signal's hues.

### Colour vision is a build gate too

Colour carries exactly one thing here: which calendar an event belongs to.
Visibility - the part that can hurt someone - is carried by
[four redundant channels](../../packages/design-tokens/src/visibility.ts) and
never by hue.

Even so, the shipped palette had a real defect, and it was invisible until
somebody measured it. Under deuteranopia the old `moss` and `clay` hues sat
**ΔE 0.6** apart - below the ~2.3 just-noticeable difference. They were the same
colour for roughly 1 in 12 men. No amount of careful review would have caught
it, because everyone reviewing could see the difference perfectly well.

So [`cvd.ts`](../../packages/design-tokens/src/cvd.ts) simulates protanopia,
deuteranopia and tritanopia (Machado et al. 2009), and `cvd.test.ts` measures
the closest pair in every palette:

- **Every palette**: all six hues ≥ **ΔE 12** apart under every vision type.
  No two calendars can be confusable for anyone.
- **Signal**: ≥ **ΔE 15**, and its light hues are the published
  **Okabe–Ito** set, unmodified.

A search maximising separation reaches ΔE 35 - and returns neon cyan and lime.
Above roughly 20 the extra distance buys nothing anyone can perceive, so Signal
pins the standard rather than trying to beat it on a metric. "We can out-score
the reference palette" is how a known-good thing gets quietly replaced with an
unreviewed one.

One consequence worth stating, because it looks like an oversight: **a chip's
fill cannot be what makes it a distinguishable shape.** Okabe–Ito's orange is
inherently light, and no light colour reaches 3:1 against a light ground - the
arithmetic does not allow it. The 2px border does that work, mixed toward `ink`
so it darkens in light mode and lightens in dark.

### Contrast is a build gate

Every foreground is verified against every ground it is permitted on, in both
themes, at WCAG AA. The palette cannot regress without failing CI.

The rest of this repository makes invariants structural rather than procedural -
a route cannot ship without an authz spec, an action cannot ship untested.
Contrast gets the same treatment, because "check the contrast" is a review
comment people forget.

## Typography

Three faces, three jobs. All system-resident: calendar UI is dense with numerals
that must align, and a webfont arriving late reflows a grid of times. The
product is used in five-second glances - "am I free Thursday?" - where a font
swap is a large share of the whole interaction.

| Role | Stack | Used for |
|---|---|---|
| **Display** | Hoefler Text → Iowan Old Style → Palatino Linotype → Georgia | Wordmark, major headings only |
| **Body** | Segoe UI Variable Text → system-ui → Helvetica Neue | Everything else |
| **Mono** | ui-monospace → SF Mono → Cascadia Mono → Consolas | **All times, dates, durations** |

The serif is used with restraint - a nod to the appointment book, not a costume.
The monospace assignment is functional rather than decorative: a column of times
does not align under proportional digits, and misaligned times in a schedule are
a legibility failure, not a cosmetic one. Anywhere digits stack, also set
`font-variant-numeric: tabular-nums`.

Scale is a ~1.2 ratio. Dense scheduling UI needs many usable steps between
caption and heading, not four dramatic ones.

## Layout

**The time gutter.** A persistent left column of times, ruled, with content
hanging off it. It is the one structural device carried across every calendar
surface, and it is honest: the gutter encodes actual time, so its ticks mean
something.

**Corner radii shrink as precision increases.** Cards get 10px, controls 6px,
event chips 3px. An event represents a precise interval and its edges are the
meaningful part; rounding them heavily softens exactly the wrong thing.

**Density is a setting, not a decision.** Comfortable by default, compact for
users with full calendars. Compact changes spacing only - never which channels
of the visibility encoding are rendered.

## Motion

Short and few: 90/160/240ms on a single easing curve.

One prohibition worth stating explicitly: **an incoming hangout request must
never animate in a way that demands attention.** No slide-in, no pulse, no
badge that counts up while you watch. That is the read-receipt problem wearing a
different hat - see [ADR 0007](../adr/0007-async-by-design.md). New items appear
quietly, and are still there later.

All motion respects `prefers-reduced-motion`.

## Voice

**No em-dashes.** Anywhere: copy, comments, documentation. They read as a tic
to people who notice them, and once noticed they are hard to stop noticing. A
spaced hyphen carries the same aside without the texture. `docs.test.ts` fails
the build on one. En-dashes are untouched, because `19:00-21:00` is a numeric
range rather than punctuation.


Plain, specific, and never apologetic. The domain vocabulary is not the user
vocabulary:

| System says | User sees |
|---|---|
| `HIDDEN` | Private |
| `BUSY` | Busy |
| `TITLE` | Name only |
| `FULL` | Everything |
| `EXPIRED` | No longer needs an answer |
| `NO_MATCHING_AUDIENCE` | (nothing - the item simply is not there) |

The `EXPIRED` phrasing matters. "Expired" implies a failure to act. "No longer
needs an answer" is the same fact without the guilt, and removing that guilt is
the product.

Sharing controls always state the consequence in the second person: *"Bob will
be able to read the name of this event."* Not *"visibility: TITLE"*.
