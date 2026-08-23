import { useEffect, useMemo, useState } from 'react';
import type {
  ClaimMode,
  ItemCondition,
  ListingView,
  PublicProfile,
} from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { ReportDialog } from '../components/ReportDialog.js';
import { Handoff } from '../components/Handoff.js';

/**
 * Things - give a well-loved object a second life.
 *
 * Like every other screen, this renders what the server sent and re-derives no
 * visibility decision. In particular it never counts or infers other people's
 * interest: if the server did not send `claims`, there is nothing to show, and
 * the absence is the answer rather than a zero to render.
 */

interface Props {
  actorId: string;
  peopleById: Map<string, PublicProfile>;
  onActivity: () => void;
}

const CONDITIONS: Array<[ItemCondition, string]> = [
  ['NEW', 'New'],
  ['LIKE_NEW', 'Like new'],
  ['GOOD', 'Good'],
  ['WORN', 'Worn'],
  ['FOR_PARTS', 'For parts'],
];

const MODES: Array<[ClaimMode, string, string]> = [
  ['FIRST_COME', 'First come', 'The first person to claim it gets it, straight away.'],
  ['LOTTERY', 'Draw', 'Everyone enters. After the deadline you draw one at random.'],
  ['OWNER_SELECTS', 'You choose', 'People say they’d like it. You pick when you’re ready.'],
];

const CONDITION_LABEL = new Map(CONDITIONS);
const MODE_LABEL = new Map(MODES.map(([k, label]) => [k, label]));

const formatDeadline = (instant: string): string =>
  new Date(instant).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

/** Local midnight, `days` from now, as the value a datetime-local input wants. */
const defaultDeadline = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(18, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function ThingsScreen({ actorId, peopleById, onActivity }: Props) {
  const [listings, setListings] = useState<ListingView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offering, setOffering] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    api
      .listings(actorId, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        setListings(r.listings);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof ApiError
            ? `Couldn’t load things (${err.status}).`
            : 'Could not reach the API.',
        );
        setLoading(false);
      });

    return () => controller.abort();
  }, [actorId, nonce]);

  const mine = useMemo(() => listings.filter((l) => l.isOwner), [listings]);
  const theirs = useMemo(() => listings.filter((l) => !l.isOwner), [listings]);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      reload();
      onActivity();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? 'Too late - that one’s already settled.'
            : `That didn’t work (${err.status}).`
          : 'Could not reach the API.',
      );
    }
  }

  return (
    <div className="things">
      <div className="things-head">
        <div>
          <h2>Things</h2>
          <p className="things-blurb">
            Treasures looking for a second life. Offer something to the friends you choose, and
            decide how it finds its next home.
          </p>
        </div>
        <button type="button" className="accent" onClick={() => setOffering(true)}>
          + Offer something
        </button>
      </div>

      {error !== null && (
        <p className="things-error" role="status">
          {error}
        </p>
      )}

      {offering && (
        <OfferForm
          actorId={actorId}
          onCancel={() => setOffering(false)}
          onCreated={() => {
            setOffering(false);
            reload();
            onActivity();
          }}
        />
      )}

      {loading && <p className="side-note">Loading…</p>}

      {!loading && listings.length === 0 && (
        <p className="things-empty">
          Nothing here yet. When a friend offers something you can see, it shows up here.
        </p>
      )}

      {mine.length > 0 && (
        <section className="things-section">
          <h3 className="things-section-title">Yours</h3>
          <div className="things-grid">
            {mine.map((listing) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                actorId={actorId}
                peopleById={peopleById}
                onAct={act}
              />
            ))}
          </div>
        </section>
      )}

      {theirs.length > 0 && (
        <section className="things-section">
          <h3 className="things-section-title">From friends</h3>
          <div className="things-grid">
            {theirs.map((listing) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                actorId={actorId}
                peopleById={peopleById}
                onAct={act}
              />
            ))}
          </div>
        </section>
      )}

      <p className="things-gate">
        Once a claim is accepted you can arrange the handoff. Agreeing puts it on both your
        calendars - and everyone else only ever sees that you’re busy.
      </p>
    </div>
  );
}

function ListingCard({
  listing,
  actorId,
  peopleById,
  onAct,
}: {
  listing: ListingView;
  actorId: string;
  peopleById: Map<string, PublicProfile>;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [message, setMessage] = useState('');
  const [composing, setComposing] = useState(false);
  const [reporting, setReporting] = useState(false);

  const closed =
    listing.claimsCloseAt !== undefined && Date.parse(listing.claimsCloseAt) <= Date.now();
  const settled = listing.status !== 'AVAILABLE';
  const nameOf = (id: string) => peopleById.get(id)?.displayName ?? 'A friend';

  return (
    <article className={`thing${settled ? ' thing-settled' : ''}`}>
      {listing.photoKeys.length > 0 && (
        <div className="thing-photos">
          {listing.photoKeys.map((key) => (
            <img
              key={key}
              className="thing-photo"
              src={api.photoUrl(listing.id, key)}
              alt=""
              loading="lazy"
            />
          ))}
        </div>
      )}

      <div className="thing-top">
        <h4 className="thing-title">{listing.title}</h4>
        <span className={`mode-pill mode-${listing.claimMode.toLowerCase()}`}>
          {MODE_LABEL.get(listing.claimMode)}
        </span>
      </div>

      {!listing.isOwner && <p className="thing-owner">from {nameOf(listing.ownerId)}</p>}

      {listing.description !== undefined && (
        <p className="thing-desc">{listing.description}</p>
      )}

      <p className="thing-meta">
        <span>{CONDITION_LABEL.get(listing.condition)}</span>
        {listing.priceMinorUnits === 0 && <span className="thing-free">Free</span>}
        {listing.priceMinorUnits !== undefined && listing.priceMinorUnits > 0 && (
          <span>
            {(listing.priceMinorUnits / 100).toFixed(2)} {listing.currency}
          </span>
        )}
        {listing.claimsCloseAt !== undefined && (
          // A date, never a countdown. A ticking clock is the manufactured
          // urgency this product exists to remove (ADR 0007).
          <span className="thing-deadline">
            {closed ? 'closed' : `open until ${formatDeadline(listing.claimsCloseAt)}`}
          </span>
        )}
        {settled && <span className="thing-status">{listing.status.toLowerCase()}</span>}
      </p>

      {/* ── What the viewer can do ─────────────────────────────── */}
      {!listing.isOwner && listing.yourClaim === undefined && !settled && !closed && (
        <div className="thing-actions">
          {composing ? (
            <>
              <textarea
                className="thing-message"
                rows={2}
                maxLength={4000}
                placeholder="Say something (optional)"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <div className="thing-buttons">
                <button
                  type="button"
                  className="accent"
                  onClick={() =>
                    onAct(() =>
                      api.claimListing(
                        listing.id,
                        message.trim() === '' ? {} : { message: message.trim() },
                        actorId,
                      ),
                    )
                  }
                >
                  {listing.claimMode === 'LOTTERY' ? 'Enter the draw' : 'Claim it'}
                </button>
                <button type="button" onClick={() => setComposing(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="accent" onClick={() => setComposing(true)}>
              {listing.claimMode === 'LOTTERY' ? 'Enter the draw' : 'I’d like this'}
            </button>
          )}
        </div>
      )}

      {listing.yourClaim?.status === 'ACCEPTED' && (
        <Handoff
          claimId={listing.yourClaim.id}
          counterpartyId={listing.ownerId}
          counterpartyName={nameOf(listing.ownerId)}
          exchange={listing.yourClaim.exchange}
          actorId={actorId}
          onChanged={() => void onAct(async () => undefined)}
        />
      )}

      {listing.yourClaim !== undefined && (
        <p className={`your-claim your-claim-${listing.yourClaim.status.toLowerCase()}`}>
          {listing.yourClaim.status === 'PENDING' &&
            (listing.claimMode === 'LOTTERY' ? 'You’re in the draw.' : 'You asked for this.')}
          {listing.yourClaim.status === 'ACCEPTED' && 'It’s yours - sort out the handoff together.'}
          {listing.yourClaim.status === 'DECLINED' && 'Not this time.'}
          {listing.yourClaim.status === 'CANCELLED' && 'The offer was withdrawn.'}
        </p>
      )}

      {/* ── Owner controls ─────────────────────────────────────── */}
      {/* Reporting is available on anyone else's listing whatever its state -
          a withdrawn item can still be why someone needs to report. */}
      {!listing.isOwner && (
        <div className="thing-report">
          <button type="button" className="link-btn" onClick={() => setReporting(true)}>
            Report this
          </button>
        </div>
      )}

      {reporting && (
        <ReportDialog
          subject={{ kind: 'LISTING', listingId: listing.id }}
          label={nameOf(listing.ownerId)}
          actorId={actorId}
          onClose={() => setReporting(false)}
        />
      )}

      {listing.isOwner && (
        <div className="thing-owner-controls">
          {listing.claims !== undefined && listing.claims.length > 0 && (
            <ul className="claim-list">
              {listing.claims.map((c) => (
                <li key={c.id} className="claim-row">
                  <span className="claim-who">
                    {nameOf(c.claimantId)}
                    {c.message !== undefined && <small>“{c.message}”</small>}
                  </span>
                  <span className={`claim-status claim-${c.status.toLowerCase()}`}>
                    {c.status.toLowerCase()}
                  </span>
                  {c.status === 'ACCEPTED' && (
                    <Handoff
                      claimId={c.id}
                      counterpartyId={c.claimantId}
                      counterpartyName={nameOf(c.claimantId)}
                      exchange={c.exchange}
                      actorId={actorId}
                      onChanged={() => void onAct(async () => undefined)}
                    />
                  )}
                  {listing.claimMode === 'OWNER_SELECTS' && c.status === 'PENDING' && (
                    <span className="claim-buttons">
                      <button
                        type="button"
                        onClick={() => onAct(() => api.decideClaim(c.id, 'ACCEPT', actorId))}
                      >
                        Give it to them
                      </button>
                      <button
                        type="button"
                        onClick={() => onAct(() => api.decideClaim(c.id, 'DECLINE', actorId))}
                      >
                        Decline
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {listing.claims !== undefined && listing.claims.length === 0 && !settled && (
            <p className="side-note">Nobody has asked yet.</p>
          )}

          {listing.claimMode === 'LOTTERY' && !settled && !closed && (
            <p className="side-note" id={`draw-${listing.id}`}>
              You can draw once entries close. Refusing a draw before the deadline is what
              makes it a draw.
            </p>
          )}

          <div className="thing-buttons">
            {listing.claimMode === 'LOTTERY' && !settled && (
              <button
                type="button"
                className="accent"
                disabled={!closed}
                aria-describedby={closed ? undefined : `draw-${listing.id}`}
                onClick={() => onAct(() => api.drawListing(listing.id, actorId))}
              >
                Draw a winner
              </button>
            )}
            {!settled && (
              <button
                type="button"
                onClick={() => onAct(() => api.withdrawListing(listing.id, actorId))}
              >
                Withdraw
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function OfferForm({
  actorId,
  onCancel,
  onCreated,
}: {
  actorId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [condition, setCondition] = useState<ItemCondition>('GOOD');
  const [claimMode, setClaimMode] = useState<ClaimMode>('FIRST_COME');
  const [audience, setAudience] = useState<'FRIENDS' | 'PUBLIC'>('FRIENDS');
  const [deadline, setDeadline] = useState<string>(defaultDeadline(7));
  const [useDeadline, setUseDeadline] = useState(false);
  const [photoKeys, setPhotoKeys] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // A draw has to close, or there is never a moment at which it can be drawn.
  const deadlineRequired = claimMode === 'LOTTERY';
  const deadlineOn = useDeadline || deadlineRequired;

  async function addPhotos(files: FileList | null) {
    if (files === null || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const keys: string[] = [];
      for (const file of Array.from(files).slice(0, 8 - photoKeys.length)) {
        keys.push(await api.uploadPhoto(file, actorId));
      }
      setPhotoKeys((existing) => [...existing, ...keys].slice(0, 8));
    } catch (err: unknown) {
      setError(
        err instanceof ApiError && err.status === 400
          ? 'That file isn’t an image we can take (JPEG, PNG, WebP or GIF, up to 3 MB).'
          : 'Upload failed.',
      );
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await api.createListing(
        {
          title: title.trim(),
          condition,
          currency: 'USD',
          photoKeys,
          audience: { kind: audience },
          claimMode,
          ...(description.trim() === '' ? {} : { description: description.trim() }),
          ...(deadlineOn ? { claimsCloseAt: new Date(deadline).toISOString() } : {}),
        },
        actorId,
      );
      onCreated();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError && err.status === 400
          ? 'Check the details - a closing time has to be in the future.'
          : 'Could not offer that.',
      );
      setSaving(false);
    }
  }

  return (
    <section className="offer-form">
      <h3>Offer something</h3>

      <label className="field">
        <span>What is it?</span>
        <input
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Cast iron skillet"
        />
      </label>

      <label className="field">
        <span>Tell them about it</span>
        <textarea
          rows={3}
          maxLength={4000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Seasoned for years. Heavy. Wants a hob that gets used."
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Condition</span>
          <select value={condition} onChange={(e) => setCondition(e.target.value as ItemCondition)}>
            {CONDITIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Who can see it</span>
          <select
            value={audience}
            onChange={(e) => setAudience(e.target.value as 'FRIENDS' | 'PUBLIC')}
          >
            <option value="FRIENDS">All friends</option>
            <option value="PUBLIC">Anyone</option>
          </select>
        </label>
      </div>

      <fieldset className="field mode-choice">
        <legend>How should it find a home?</legend>
        {MODES.map(([value, label, blurb]) => (
          <label key={value} className={`mode-option${claimMode === value ? ' mode-on' : ''}`}>
            <input
              type="radio"
              name="claimMode"
              value={value}
              checked={claimMode === value}
              onChange={() => setClaimMode(value)}
            />
            <span>
              <strong>{label}</strong>
              <small>{blurb}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="field">
        <label className="deadline-toggle">
          <input
            type="checkbox"
            checked={deadlineOn}
            disabled={deadlineRequired}
            onChange={(e) => setUseDeadline(e.target.checked)}
          />
          <span>
            Close claiming at a set time
            {deadlineRequired && <small> - a draw needs one, so you can draw it</small>}
          </span>
        </label>
        {deadlineOn && (
          <input
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
        )}
      </div>

      <div className="field">
        <span className="field-label">Photos</span>
        {photoKeys.length > 0 && (
          <p className="side-note">
            {photoKeys.length} added. They’ll only be visible to whoever can see the listing.
          </p>
        )}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          disabled={uploading || photoKeys.length >= 8}
          onChange={(e) => void addPhotos(e.target.files)}
        />
        {uploading && <p className="side-note">Uploading…</p>}
      </div>

      {error !== null && (
        <p className="things-error" role="status">
          {error}
        </p>
      )}

      <div className="thing-buttons">
        <button
          type="button"
          className="accent"
          disabled={title.trim() === '' || saving || uploading}
          onClick={() => void submit()}
        >
          {saving ? 'Offering…' : 'Offer it'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
