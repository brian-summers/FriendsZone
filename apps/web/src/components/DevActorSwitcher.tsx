import { devActors } from '../lib/dev.js';

/**
 * The development identity switcher.
 *
 * Its styles are inline rather than in `app.css` for one reason: Vite does not
 * tree-shake CSS. A `.devbar` rule in the stylesheet would ship to production
 * and sit there permanently, styling an element that never renders - inert, but
 * still a leftover visible to anyone reading the bundle. Inline, the rules are
 * part of this module and leave with it.
 *
 * Colours are still tokens, never literals: `var(--amber)` resolves per palette
 * and per mode exactly as it would in the stylesheet.
 *
 * Render only under `import.meta.env.DEV` - see `lib/dev.ts` for why that is a
 * build-time deletion rather than a runtime check.
 */

const wrap: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2xs)',
  padding: '0.2rem 0.4rem 0.2rem 0.6rem',
  border: '1px dashed var(--amber)',
  borderRadius: 'var(--radius-control)',
  fontSize: '0.75rem',
  color: 'var(--ink2)',
};

const label: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.625rem',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--amber)',
};

const select: React.CSSProperties = {
  font: 'inherit',
  fontSize: '0.75rem',
  background: 'var(--surface)',
  color: 'var(--ink)',
  border: '1px solid var(--rule)',
  borderRadius: 'var(--radius-control)',
  padding: '0.1rem 0.25rem',
};

interface Props {
  actorId: string;
  onChange: (id: string) => void;
}

export function DevActorSwitcher({ actorId, onChange }: Props) {
  return (
    <div style={wrap}>
      <label htmlFor="dev-actor" style={label}>
        Dev · acting as
      </label>
      <select
        id="dev-actor"
        style={select}
        value={actorId}
        onChange={(e) => onChange(e.target.value)}
      >
        {devActors().map((actor) => (
          <option key={actor.id} value={actor.id}>
            {actor.name}
          </option>
        ))}
      </select>
    </div>
  );
}
