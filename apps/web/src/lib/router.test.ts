import { describe, expect, it } from 'vitest';
import { matchRoute } from './router.js';

const PATTERNS = ['/', '/people/:id', '/inbox', '/things', '/settings'] as const;

describe('matchRoute', () => {
  it('matches the root', () => {
    expect(matchRoute('/', PATTERNS)?.pattern).toBe('/');
    expect(matchRoute('', PATTERNS)?.pattern).toBe('/');
  });

  it('captures a param', () => {
    const match = matchRoute('/people/abc-123', PATTERNS);
    expect(match?.pattern).toBe('/people/:id');
    expect(match?.params.id).toBe('abc-123');
  });

  it('decodes an encoded param', () => {
    expect(matchRoute('/people/a%2Fb', PATTERNS)?.params.id).toBe('a/b');
  });

  it('is not confused by a trailing slash', () => {
    expect(matchRoute('/inbox/', PATTERNS)?.pattern).toBe('/inbox');
  });

  it('does not match a param pattern against the wrong depth', () => {
    // "/people" alone is not "/people/:id".
    expect(matchRoute('/people', PATTERNS)).toBeNull();
    expect(matchRoute('/people/a/b', PATTERNS)).toBeNull();
  });

  it('returns null for an unknown path', () => {
    expect(matchRoute('/nope', PATTERNS)).toBeNull();
  });
});
