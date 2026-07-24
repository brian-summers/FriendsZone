import { useSyncExternalStore } from 'react';

/**
 * A tiny History-API router.
 *
 * No dependency, on purpose. The app has a handful of routes and no need for
 * loaders, nested layouts, or data APIs, so a full router would be more surface
 * than the problem. This is ~40 lines, it is testable, and it uses
 * `useSyncExternalStore` so React stays the source of truth for the current
 * path without a context provider.
 *
 * Routes are matched by a small pattern language: `:param` captures a segment.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Programmatic navigation. Pushes history and re-renders subscribers. */
export function navigate(to: string): void {
  if (to === window.location.pathname + window.location.search) return;
  window.history.pushState(null, '', to);
  notify();
}

// Back/forward buttons.
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', notify);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): string => window.location.pathname;

/** The current pathname, reactive. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, getSnapshot, () => '/');
}

export type RouteParams = Readonly<Record<string, string>>;

export interface Match {
  readonly pattern: string;
  readonly params: RouteParams;
}

/**
 * Match a pathname against `patterns`, returning the first hit.
 *
 * Order matters: list more specific patterns before their wildcards. Returns
 * `null` for no match, which the caller renders as the not-found route.
 */
export function matchRoute(pathname: string, patterns: readonly string[]): Match | null {
  const segments = pathname.replace(/\/+$/, '').split('/').filter(Boolean);

  for (const pattern of patterns) {
    const patternSegments = pattern.replace(/\/+$/, '').split('/').filter(Boolean);
    if (patternSegments.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let ok = true;

    for (let i = 0; i < patternSegments.length; i += 1) {
      const p = patternSegments[i]!;
      const s = segments[i]!;
      if (p.startsWith(':')) {
        params[p.slice(1)] = decodeURIComponent(s);
      } else if (p !== s) {
        ok = false;
        break;
      }
    }

    if (ok) return { pattern, params };
  }

  // The root path collapses to zero segments; match it explicitly.
  if (segments.length === 0 && patterns.includes('/')) {
    return { pattern: '/', params: {} };
  }

  return null;
}

/**
 * An accessible in-app link. Left-clicks are intercepted for client routing;
 * modified clicks (new tab, download) fall through to the browser, which is the
 * behaviour users expect from something that is genuinely an anchor.
 */
export function linkProps(to: string): {
  href: string;
  onClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
} {
  return {
    href: to,
    onClick: (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      e.preventDefault();
      navigate(to);
    },
  };
}
