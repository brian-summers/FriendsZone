import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * A small popover for orientation text - the "why is this section here"
 * sentence that helps once and is noise forever after.
 *
 * **What must never go in one.** Consequence text stays on the page. If a
 * sentence tells someone what will happen to them - who will be able to read an
 * event, what a block does, what deletion keeps - it is not an explainer, and
 * hiding it behind a control the user has to know to press is a safety
 * regression. The rule and its rationale live in
 * `packages/design-tokens/src/visibility.ts`: a visibility label is
 * *"always rendered as text. Never a tooltip, never hover-only."*
 *
 * **Why click, not hover.** Three reasons, each sufficient on its own:
 *
 *  1. There is no hover on a touch screen, and the phone layout is a shipping
 *     target. A hover-only affordance is an affordance that does not exist for
 *     half the users.
 *  2. WCAG 1.4.13 (Content on Hover or Focus) requires such content to be
 *     dismissible, hoverable, and persistent. A click-toggled panel gets all
 *     three by construction; a `:hover` div gets none.
 *  3. `title=` is worse than either - an unstyleable, delayed, touch-invisible
 *     tooltip that screen readers announce inconsistently.
 *
 * The trigger is a real `<button>` with `aria-expanded`, so it is reachable by
 * keyboard and announced as a disclosure rather than as decoration.
 */

interface Props {
  /** Accessible name, e.g. "About sharing defaults". Never rendered visually. */
  label: string;
  children: ReactNode;
}

export function Explainer({ label, children }: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Focus goes back to the trigger, or a keyboard user is stranded at the
      // top of the document with no idea what they just closed.
      buttonRef.current?.focus();
    };

    // `pointerdown` rather than `click`: a click listener fires after the
    // browser has already moved focus, which makes the panel flicker shut and
    // reopen when the trigger itself is the thing being pressed.
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node) === true) return;
      setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <span className="explainer" ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className="explainer-trigger"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Decorative: the button's name comes from aria-label, so a screen
            reader says "About sharing defaults", not "lowercase i". */}
        <span aria-hidden="true">i</span>
      </button>
      {open && (
        <span className="explainer-panel" id={id} role="note">
          {children}
        </span>
      )}
    </span>
  );
}
