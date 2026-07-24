// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarView, HangoutHold } from '@friendszone/contracts';
import { WeekGrid } from './WeekGrid.js';

afterEach(cleanup);

const OWNER = '11111111-1111-4111-8111-111111111111';

/** Monday of the current week, local — matches the grid's own reckoning. */
function weekStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const at = (base: Date, day: number, hour: number): string => {
  const d = new Date(base);
  d.setDate(d.getDate() + day);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

function view(base: Date): CalendarView {
  return {
    ownerId: OWNER,
    window: { start: at(base, 0, 0), end: at(base, 7, 0) },
    busy: [{ start: at(base, 0, 9), end: at(base, 0, 11) }],
    details: [
      {
        visibility: 'TITLE',
        id: 'cccccccc-cccc-4ccc-8ccc-000000000001',
        ownerId: OWNER,
        timeRange: { start: at(base, 2, 14), end: at(base, 2, 16) },
        title: 'Climbing at Vertigo',
        status: 'CONFIRMED',
      },
    ],
    openBlocks: [],
    holds: [],
  } as unknown as CalendarView;
}

function hold(base: Date): HangoutHold {
  return {
    requestId: 'eeeeeeee-eeee-4eee-8eee-000000000001',
    slotIndex: 0,
    timeRange: { start: at(base, 1, 19), end: at(base, 1, 21) },
    title: 'Climb next week?',
    proposerId: '22222222-2222-4222-8222-222222222222',
    inviteeId: OWNER,
    role: 'INVITEE',
    expiresAt: at(base, 6, 0),
  } as unknown as HangoutHold;
}

/**
 * Render-level guards on the surface where a privacy mistake would actually be
 * seen. The projection engine is tested separately; these assert that the
 * component does not undo its work — by labelling a chip wrongly, or by
 * rendering a field the server withheld.
 */
describe('WeekGrid', () => {
  it('labels a busy block without revealing anything about it', () => {
    const base = weekStart();
    render(<WeekGrid view={view(base)} weekStart={base} ownerId={OWNER} />);

    const busy = screen.getByRole('img', { name: /^Unavailable,/ });
    expect(busy.className).toContain('v-BUSY');
    expect(busy.textContent).toContain('Busy');
    // The one thing that must never appear on a BUSY chip.
    expect(busy.textContent).not.toContain('Climbing');
  });

  it('renders all four encoding channels on a detail chip', () => {
    const base = weekStart();
    render(<WeekGrid view={view(base)} weekStart={base} ownerId={OWNER} />);

    const chip = screen.getByRole('img', { name: /Climbing at Vertigo/ });
    expect(chip.className).toContain('v-TITLE'); // fill + border
    expect(chip.textContent).toContain('▣'); // glyph
    expect(chip.textContent).toContain('Name only'); // label
    expect(chip.textContent).toContain('Climbing at Vertigo');
  });

  it('names the visibility level in the accessible label', () => {
    const base = weekStart();
    render(<WeekGrid view={view(base)} weekStart={base} ownerId={OWNER} />);
    expect(screen.getByRole('img', { name: /shared as Name only/ })).toBeDefined();
  });

  it('makes chips actionable only when a handler is supplied', () => {
    const base = weekStart();
    const { rerender } = render(
      <WeekGrid view={view(base)} weekStart={base} ownerId={OWNER} />,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);

    rerender(
      <WeekGrid view={view(base)} weekStart={base} ownerId={OWNER} onChipActivate={() => {}} />,
    );
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('draws nothing at all for an empty projection', () => {
    const base = weekStart();
    const empty: CalendarView = { ...view(base), busy: [], details: [] };
    render(<WeekGrid view={empty} weekStart={base} ownerId={OWNER} />);

    // No chips, and crucially no placeholder standing in for what was hidden.
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(document.querySelectorAll('.chip')).toHaveLength(0);
  });

  it('renders a pending hold as tentative and marks its role', () => {
    const base = weekStart();
    const withHold: CalendarView = { ...view(base), holds: [hold(base)] };
    render(
      <WeekGrid view={withHold} weekStart={base} ownerId={OWNER} onHoldActivate={() => {}} />,
    );

    const chip = screen.getByRole('button', { name: /Climb next week\?/ });
    expect(chip.className).toContain('hold');
    expect(chip.textContent).toContain('Pending');
    // The accessible name distinguishes tentative from firm and names the role.
    expect(chip.getAttribute('aria-label')).toMatch(/tentative — a friend asked you/);
  });

  it('renders an open block as "Open", distinct from busy', () => {
    const base = weekStart();
    const withOpen: CalendarView = {
      ...view(base),
      busy: [],
      details: [],
      openBlocks: [{ start: at(base, 1, 13), end: at(base, 1, 16) }],
    };
    render(<WeekGrid view={withOpen} weekStart={base} ownerId={OWNER} />);
    const open = screen.getByRole('img', { name: /^Open to plans,/ });
    expect(open.className).toContain('v-OPEN');
    expect(open.textContent).toContain('Open');
  });

  it('makes a hold inert when no activation handler is given', () => {
    const base = weekStart();
    const withHold: CalendarView = { ...view(base), holds: [hold(base)], details: [], busy: [] };
    render(<WeekGrid view={withHold} weekStart={base} ownerId={OWNER} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(document.querySelector('.chip.hold')).not.toBeNull();
  });
});
