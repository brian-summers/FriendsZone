import { DEFAULT_PALETTE, PALETTE_NAMES, type PaletteName } from '@friendszone/design-tokens';

/** The lighting condition. `system` defers to the OS. */
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface ThemeSelection {
  mode: ThemeChoice;
  palette: PaletteName;
}

const MODE_KEY = 'friendszone:theme';
const PALETTE_KEY = 'friendszone:palette';

/**
 * Theme selection: a **palette** and a **mode**, kept independent.
 *
 * They are two questions, and collapsing them into one list of six options
 * would mean somebody who needs the colourblind-safe hues has to accept
 * whichever lighting condition that entry happened to ship with. Nobody should
 * have to trade dark mode for legibility.
 *
 * `mode: 'system'` removes `data-theme` entirely so the media query governs.
 * The palette attribute is *always* stamped, including for the default —
 * `tokens.css` gives every palette all four palette-and-mode combinations, and
 * that only resolves deterministically if the attribute is present.
 */
export function applyTheme({ mode, palette }: ThemeSelection): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  root.setAttribute('data-palette', palette);
}

const isPalette = (v: unknown): v is PaletteName =>
  typeof v === 'string' && (PALETTE_NAMES as string[]).includes(v);

export function loadTheme(): ThemeSelection {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    const palette = localStorage.getItem(PALETTE_KEY);
    return {
      mode: mode === 'light' || mode === 'dark' ? mode : 'system',
      palette: isPalette(palette) ? palette : DEFAULT_PALETTE,
    };
  } catch {
    // Storage throws in some private modes. A theme preference is not worth
    // taking the app down for.
    return { mode: 'system', palette: DEFAULT_PALETTE };
  }
}

export function saveTheme({ mode, palette }: ThemeSelection): void {
  try {
    if (mode === 'system') localStorage.removeItem(MODE_KEY);
    else localStorage.setItem(MODE_KEY, mode);

    if (palette === DEFAULT_PALETTE) localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    /* ignore */
  }
}
