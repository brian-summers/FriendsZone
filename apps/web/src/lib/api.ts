import type {
  BookOccurrenceInput,
  CalendarView,
  CancelHangoutInput,
  CreateEventInput,
  CreateHangoutInput,
  EventView,
  HangoutDecision,
  HangoutRequest,
  Notification,
  PublicProfile,
  RescheduleHangoutInput,
  UpdateHangoutInput,
} from '@friendszone/contracts';

/**
 * The API client.
 *
 * Types are imported from `@friendszone/contracts` with `import type`, so the
 * client is compile-time bound to the same definitions the server validates
 * against, and none of Zod ends up in the browser bundle.
 *
 * Requests go to `/api/*` and Vite proxies them to the API in development. That
 * keeps everything same-origin, so there is no CORS configuration anywhere —
 * and therefore no permissive `Access-Control-Allow-Origin` to leak into
 * production by accident.
 */

/**
 * Development-only identity header. Mirrors `DEV_ACTOR_HEADER` in the API,
 * which refuses to construct at all when `NODE_ENV=production`. Replace this
 * whole mechanism with session cookies when ADR 0006 is implemented.
 */
const DEV_ACTOR_HEADER = 'x-dev-actor-id';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function get<T>(path: string, actorId: string | null, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (actorId !== null) headers[DEV_ACTOR_HEADER] = actorId;

  const response = await fetch(`/api${path}`, {
    headers,
    // Calendar payloads are per-viewer. Never let the browser reuse one.
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new ApiError(response.status, `${response.status} on ${path}`);
  }
  return (await response.json()) as T;
}

async function send<T>(
  method: 'POST' | 'PATCH',
  path: string,
  actorId: string | null,
  payload: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (actorId !== null) headers[DEV_ACTOR_HEADER] = actorId;

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    cache: 'no-store',
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new ApiError(response.status, `${response.status} on ${path}`);
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, actorId: string | null, payload: unknown) =>
  send<T>('POST', path, actorId, payload);
const patch = <T>(path: string, actorId: string | null, payload: unknown) =>
  send<T>('PATCH', path, actorId, payload);

const window_ = (start: Date, end: Date): string =>
  `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;

export const api = {
  me: (actorId: string | null, signal?: AbortSignal) =>
    get<PublicProfile>('/v1/me', actorId, signal),

  people: (actorId: string | null, signal?: AbortSignal) =>
    get<{ people: PublicProfile[] }>('/v1/people', actorId, signal),

  person: (userId: string, actorId: string | null, signal?: AbortSignal) =>
    get<PublicProfile>(`/v1/people/${userId}`, actorId, signal),

  calendar: (
    ownerId: string,
    start: Date,
    end: Date,
    actorId: string | null,
    signal?: AbortSignal,
  ) => get<CalendarView>(`/v1/users/${ownerId}/calendar?${window_(start, end)}`, actorId, signal),

  /**
   * The sharing checkup: your own calendar, as a specific person sees it.
   * The server computes this with the same projection engine that serves the
   * real thing, so it is not an approximation — it is what they see.
   */
  previewAs: (
    viewerId: string,
    start: Date,
    end: Date,
    actorId: string | null,
    signal?: AbortSignal,
  ) =>
    get<CalendarView>(
      `/v1/me/calendar/preview?${window_(start, end)}&viewerId=${viewerId}`,
      actorId,
      signal,
    ),

  createEvent: (input: CreateEventInput, actorId: string | null) =>
    post<EventView>('/v1/events', actorId, input),

  // ── Hangout requests ──────────────────────────────────────────────
  createHangout: (input: CreateHangoutInput, actorId: string | null) =>
    post<HangoutRequest>('/v1/hangouts', actorId, input),

  received: (actorId: string | null, signal?: AbortSignal) =>
    get<{ requests: HangoutRequest[] }>('/v1/hangouts/received', actorId, signal),

  sent: (actorId: string | null, signal?: AbortSignal) =>
    get<{ requests: HangoutRequest[] }>('/v1/hangouts/sent', actorId, signal),

  hangout: (id: string, actorId: string | null, signal?: AbortSignal) =>
    get<HangoutRequest>(`/v1/hangouts/${id}`, actorId, signal),

  respondHangout: (id: string, decision: HangoutDecision, actorId: string | null) =>
    post<HangoutRequest>(`/v1/hangouts/${id}/respond`, actorId, decision),

  withdrawHangout: (id: string, actorId: string | null) =>
    post<HangoutRequest>(`/v1/hangouts/${id}/withdraw`, actorId, {}),

  updateHangout: (id: string, input: UpdateHangoutInput, actorId: string | null) =>
    patch<HangoutRequest>(`/v1/hangouts/${id}`, actorId, input),

  rescheduleHangout: (id: string, input: RescheduleHangoutInput, actorId: string | null) =>
    post<HangoutRequest>(`/v1/hangouts/${id}/reschedule`, actorId, input),

  cancelHangout: (id: string, input: CancelHangoutInput, actorId: string | null) =>
    post<HangoutRequest>(`/v1/hangouts/${id}/cancel`, actorId, input),

  bookOccurrence: (id: string, input: BookOccurrenceInput, actorId: string | null) =>
    post<HangoutRequest>(`/v1/hangouts/${id}/book`, actorId, input),

  notifications: (actorId: string | null, signal?: AbortSignal) =>
    get<{ notifications: Notification[] }>('/v1/notifications', actorId, signal),
};
