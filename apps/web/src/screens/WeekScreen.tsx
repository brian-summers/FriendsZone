import { useEffect, useMemo, useState } from 'react';
import type {
  CalendarView,
  EventView,
  HangoutHold,
  PublicProfile,
  TimeRange,
} from '@friendszone/contracts';
import { api, ApiError } from '../lib/api.js';
import { addDays, formatWeekLabel, startOfWeek } from '../lib/time.js';
import { WeekGrid } from '../components/WeekGrid.js';
import { EventDrawer } from '../components/EventDrawer.js';
import { NewEventDialog } from '../components/NewEventDialog.js';
import { SlotFinder } from '../components/SlotFinder.js';
import { SharingCheckup } from '../components/SharingCheckup.js';
import { RequestTimeDialog } from '../components/RequestTimeDialog.js';
import { HoldDrawer } from '../components/HoldDrawer.js';

interface Props {
  /** Whose calendar to show. */
  ownerId: string;
  /** The signed-in actor. Owner === actor means "your own calendar". */
  actorId: string;
  me: PublicProfile | null;
  people: PublicProfile[];
  ownerProfile: PublicProfile | null;
  /** Called after any mutation, so the shell can refresh derived counts. */
  onActivity: () => void;
}

/**
 * The week — the surface people spend nearly all their time on.
 *
 * One component serves both "my week" and "a friend's week"; the difference is
 * entirely whether `ownerId === actorId`. That keeps the two visually identical
 * except where they must differ (editing, the who-can-see badge, the checkup),
 * so a friend's calendar never accidentally sprouts an affordance that only
 * makes sense on your own.
 */
export function WeekScreen({ ownerId, actorId, me, people, ownerProfile, onActivity }: Props) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [view, setView] = useState<CalendarView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [openEvent, setOpenEvent] = useState<EventView | null>(null);
  const [openHold, setOpenHold] = useState<HangoutHold | null>(null);
  const [creating, setCreating] = useState<boolean | TimeRange>(false);
  const [checkupOpen, setCheckupOpen] = useState(false);
  const [requesting, setRequesting] = useState<boolean | TimeRange>(false);
  const [sentToast, setSentToast] = useState(false);
  const [finding, setFinding] = useState(false);

  const isOwn = ownerId === actorId;
  const weekStart = useMemo(() => startOfWeek(new Date(), weekOffset), [weekOffset]);

  const peopleById = useMemo(() => {
    const map = new Map<string, PublicProfile>();
    if (me) map.set(me.id, me);
    for (const p of people) map.set(p.id, p);
    return map;
  }, [me, people]);

  // Reset transient UI when the calendar being viewed changes.
  useEffect(() => {
    setOpenEvent(null);
    setOpenHold(null);
    setCreating(false);
    setCheckupOpen(false);
    setRequesting(false);
    setSentToast(false);
    setWeekOffset(0);
  }, [ownerId]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);

    api
      .calendar(ownerId, weekStart, addDays(weekStart, 7), actorId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setView(result);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setView(null);
        setError(
          err instanceof ApiError
            ? `Couldn't load that calendar (${err.status}).`
            : 'Could not reach the API. Is it running on port 8080?',
        );
      });

    return () => controller.abort();
  }, [ownerId, actorId, weekStart, reloadNonce]);

  const title = isOwn ? 'Your week' : `${ownerProfile?.displayName ?? 'Someone'}’s week`;
  const empty = view !== null && view.busy.length === 0 && view.details.length === 0;

  return (
    <>
      <div className="week-bar">
        <h2 className="week-title">{title}</h2>
        <span className="week-sub mono">{formatWeekLabel(weekStart)}</span>
        {!isOwn && <span className="week-sub">— what they share with you</span>}

        <div className="stepper">
          {isOwn && (
            <button type="button" className="accent" onClick={() => setCreating(true)}>
              + New event
            </button>
          )}
          {!isOwn && ownerProfile && (
            <button type="button" className="accent" onClick={() => setRequesting(true)}>
              Request time
            </button>
          )}
          {isOwn && people.length > 0 && (
            <button type="button" onClick={() => setFinding(true)}>
              Find a time
            </button>
          )}
          {isOwn && people.length > 0 && (
            <button type="button" onClick={() => setCheckupOpen(true)}>
              See what others see
            </button>
          )}
          <button type="button" onClick={() => setWeekOffset((w) => w - 1)} aria-label="Previous week">
            ‹
          </button>
          <button type="button" onClick={() => setWeekOffset(0)}>
            Today
          </button>
          <button type="button" onClick={() => setWeekOffset((w) => w + 1)} aria-label="Next week">
            ›
          </button>
        </div>
      </div>

      {error !== null && <p className="notice">{error}</p>}

      {sentToast && (
        <p className="toast" role="status">
          Request sent to {ownerProfile?.displayName ?? 'them'}. They’ll answer whenever.
        </p>
      )}

      {error === null && view !== null && (
        <WeekGrid
          view={view}
          weekStart={weekStart}
          ownerId={ownerId}
          onChipActivate={(event) => setOpenEvent(event)}
          onHoldActivate={(hold) => setOpenHold(hold)}
          // On your own calendar a drag creates an event; on a friend's it
          // proposes that time to them. Same gesture, whichever calendar's rules
          // apply — a friend's grid never lets you write to their calendar.
          onRangeSelect={
            isOwn
              ? (range) => setCreating(range)
              : ownerProfile
                ? (range) => setRequesting(range)
                : undefined
          }
          rangeSelectHint={isOwn ? 'add an event' : 'request that time'}
        />
      )}

      {error === null && empty && !isOwn && (
        <p className="notice">
          <strong>Nothing to show.</strong> That is deliberately ambiguous: an empty week looks the
          same whether they’re free, share nothing with you, or have blocked you. The API returned{' '}
          <span className="mono">200</span>, not an error — a refusal would confirm the account
          exists.
        </p>
      )}

      {openEvent && (
        <EventDrawer
          event={openEvent}
          isOwn={isOwn}
          actorId={actorId}
          weekStart={weekStart}
          peopleById={peopleById}
          onClose={() => setOpenEvent(null)}
          onResolved={() => {
            setOpenEvent(null);
            setReloadNonce((n) => n + 1);
            onActivity();
          }}
        />
      )}

      {finding && (
        <SlotFinder
          actorId={actorId}
          people={people}
          onClose={() => setFinding(false)}
          onPick={(slot) => {
            // Straight into the New Event dialog, pre-filled. Inviting is the
            // existing per-friend Request time flow — hangouts resolve 1:1
            // (ADR 0010), so there is no multi-party invite to offer here.
            setFinding(false);
            setCreating(slot);
          }}
        />
      )}

      {creating && me && (
        <NewEventDialog
          weekStart={weekStart}
          actorId={actorId}
          initialRange={typeof creating === 'object' ? creating : undefined}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setReloadNonce((n) => n + 1);
            setOpenEvent(created);
          }}
        />
      )}

      {checkupOpen && me && (
        <SharingCheckup
          people={people}
          weekStart={weekStart}
          actorId={actorId}
          onClose={() => setCheckupOpen(false)}
        />
      )}

      {openHold && (
        <HoldDrawer
          hold={openHold}
          actorId={actorId}
          weekStart={weekStart}
          peopleById={peopleById}
          onClose={() => setOpenHold(null)}
          onResolved={() => {
            setOpenHold(null);
            setReloadNonce((n) => n + 1);
            onActivity();
          }}
        />
      )}

      {requesting && !isOwn && ownerProfile && view && (
        <RequestTimeDialog
          invitee={ownerProfile}
          weekStart={weekStart}
          friendBusy={view.busy}
          actorId={actorId}
          initialRange={typeof requesting === 'object' ? requesting : undefined}
          onClose={() => setRequesting(false)}
          onSent={() => {
            setRequesting(false);
            setSentToast(true);
            onActivity();
            window.setTimeout(() => setSentToast(false), 4000);
          }}
        />
      )}
    </>
  );
}
