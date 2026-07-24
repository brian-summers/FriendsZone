interface Props {
  title: string;
  blurb: string;
  status: string;
}

/**
 * An honest stub.
 *
 * It says what the screen will do and what is actually missing behind it,
 * rather than showing a fake list of items that implies working functionality.
 * A convincing placeholder is worse than an obvious one — it wastes a reviewer's
 * time and hides how much is left.
 */
export function Placeholder({ title, blurb, status }: Props) {
  return (
    <div className="placeholder">
      <h2>{title}</h2>
      <p>{blurb}</p>
      <p className="stub-note">{status}</p>
    </div>
  );
}
