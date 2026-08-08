// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Explainer } from './Explainer.js';

/**
 * The popover is only allowed to carry orientation text, so these tests are
 * about the two things that make it safe to use at all: it works without a
 * pointer, and it can always be dismissed.
 *
 * WCAG 1.4.13 is the reason. Content revealed on hover or focus must be
 * dismissible, hoverable, and persistent — a `:hover` div satisfies none of the
 * three, which is why this is a click-toggled disclosure with a real button.
 */

afterEach(cleanup);

const mount = () =>
  render(
    <Explainer label="About sharing defaults">
      What each audience sees when you don’t choose otherwise.
    </Explainer>,
  );

describe('Explainer', () => {
  it('starts closed, so nothing is revealed until asked for', () => {
    mount();
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('button')).toHaveProperty('ariaExpanded', 'false');
  });

  it('is a button with a real accessible name, not a bare glyph', () => {
    mount();
    // The visible character is `aria-hidden`, so the name has to come from the
    // label — a screen reader must not announce this as "i".
    const button = screen.getByRole('button', { name: 'About sharing defaults' });
    expect(button.textContent).toBe('i');
  });

  it('opens on click and points at its panel', () => {
    mount();
    const button = screen.getByRole('button');
    fireEvent.click(button);

    const panel = screen.getByRole('note');
    expect(panel.textContent).toContain('What each audience sees');
    expect(button.getAttribute('aria-controls')).toBe(panel.id);
    expect(button).toHaveProperty('ariaExpanded', 'true');
  });

  it('closes on a second click', () => {
    mount();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    mount();
    const button = screen.getByRole('button');
    fireEvent.click(button);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('note')).toBeNull();
    // Without this a keyboard user is left with focus on nothing, at the top of
    // the document, with no idea what they just dismissed.
    expect(document.activeElement).toBe(button);
  });

  it('closes when something outside is pressed', () => {
    mount();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('stays open when the panel itself is pressed', () => {
    // Selecting the text inside must not dismiss it — "hoverable" in 1.4.13.
    mount();
    fireEvent.click(screen.getByRole('button'));
    fireEvent.pointerDown(screen.getByRole('note'));
    expect(screen.queryByRole('note')).not.toBeNull();
  });
});
