export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'friendszone:theme';

/**
 * Theme selection.
 *
 * `system` removes the attribute entirely so the CSS media query governs.
 * An explicit choice stamps `data-theme` on the root, which the stylesheet
 * defines for *both* directions — so choosing light on a dark OS works, not
 * just the other way round.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function loadTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    // Storage can throw in private modes. A theme preference is not worth
    // taking the app down for.
    return 'system';
  }
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* ignore */
  }
}
