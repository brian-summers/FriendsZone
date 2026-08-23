// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The API is stubbed rather than exercised: this file is about the shell's
 * layout contract, and every screen below already handles a rejected fetch by
 * rendering an empty or error state. Resolving with empty payloads keeps the
 * screens on their ordinary render path so the assertion is about routing, not
 * about an error banner that happens to be short.
 */
vi.mock('./lib/api.js', () => {
  const emptyCalendar = {
    ownerId: '11111111-1111-4111-8111-111111111111',
    window: { start: new Date().toISOString(), end: new Date().toISOString() },
    busy: [],
    openBlocks: [],
    details: [],
    holds: [],
  };
  return {
    ApiError: class ApiError extends Error {
      status = 0;
    },
    api: {
      me: async () => ({ id: '11111111-1111-4111-8111-111111111111', displayName: 'Alice' }),
      people: async () => ({ people: [] }),
      received: async () => ({ requests: [] }),
      sent: async () => ({ requests: [] }),
      notifications: async () => ({ notifications: [] }),
      sharingDefaults: async () => ({ rules: [] }),
      calendar: async () => emptyCalendar,
      previewAs: async () => emptyCalendar,
      listings: async () => ({ listings: [] }),
      circles: async () => ({ circles: [] }),
      friendRequests: async () => ({ requests: [] }),
      blockedPeople: async () => ({ blocked: [] }),
      conversations: async () => ({ conversations: [] }),
      thread: async () => ({ id: 'c', withUserId: 'u', withHandle: 'u', withDisplayName: 'U', messages: [] }),
      markConversationRead: async () => ({ read: true }),
      setDiscoverability: async () => ({ discoverability: 'EVERYONE' }),
      quietHours: async () => ({ quietHours: null }),
      setQuietHours: async () => ({ quietHours: null }),
      photoUrl: (listingId: string, key: string) => `/api/v1/listings/${listingId}/photos/${key}`,
    },
  };
});

const { App } = await import('./App.js');
const { navigate } = await import('./lib/router.js');

afterEach(cleanup);

/** Mounts the shell, then routes to `path`. */
async function mainAt(path: string): Promise<HTMLElement> {
  window.history.pushState(null, '', '/');
  render(<App />);
  // The identity effect navigates home on mount; let it settle before routing,
  // or it lands after our navigation and every case reads as the week route.
  await act(async () => {});
  await act(async () => {
    navigate(path);
  });

  const main = document.querySelector('main');
  if (main === null) throw new Error('no <main> rendered');
  return main as HTMLElement;
}

describe('the shell decides which element scrolls', () => {
  // The week grid owns a scroll container of its own (.cal-scroll) so its day
  // header can stay sticky. Every other screen has none, so <main> has to
  // scroll for them - otherwise their content is clipped at the fold with no
  // way to reach it, which is invisible in tests that only assert content.
  it.each(['/inbox', '/things', '/settings', '/people'])(
    'scrolls <main> on %s',
    async (path) => {
      const main = await mainAt(path);
      expect(main.classList.contains('main-scroll')).toBe(true);
    },
  );

  it('leaves scrolling to the panes on Messages', async () => {
    // The mailbox list and the thread each scroll independently. A scrollbar
    // on <main> as well would nest two scrollers and put the newest message
    // out of reach.
    const main = await mainAt('/messages');
    expect(main.classList.contains('main-scroll')).toBe(false);
  });

  it('leaves scrolling to the grid on your own week', async () => {
    const main = await mainAt('/');
    expect(main.classList.contains('main-scroll')).toBe(false);
  });

  it('leaves scrolling to the grid on a friend’s week', async () => {
    const main = await mainAt('/people/22222222-2222-4222-8222-222222222222');
    expect(main.classList.contains('main-scroll')).toBe(false);
  });

  it('scrolls <main> on an unmatched route', async () => {
    const main = await mainAt('/nope');
    expect(main.classList.contains('main-scroll')).toBe(true);
  });
});
