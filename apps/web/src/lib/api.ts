import type {
  BookOccurrenceInput,
  CalendarView,
  CancelHangoutInput,
  ClaimListingInput,
  CreateListingInput,
  AccountExport,
  AuthResult,
  LoginInput,
  RegisterInput,
  CircleView,
  CreateCircleInput,
  UpdateCircleInput,
  DeletionReceipt,
  DisposeReportInput,
  FindSlotsInput,
  FindSlotsResult,
  FriendRequestView,
  PersonSearchResult,
  RespondToFriendRequestInput,
  ExchangeView,
  ProposeExchangeInput,
  FileReportInput,
  MeView,
  ModerationQueueRow,
  ModeratorNoteInput,
  ModeratorReportView,
  ReporterReportView,
  SubjectReportView,
  ListingView,
  UpdateListingInput,
  CreateEventInput,
  CreateHangoutInput,
  EventFullView,
  EventView,
  HangoutDecision,
  HangoutRequest,
  Notification,
  PublicProfile,
  RescheduleHangoutInput,
  SharingDefaults,
  SharingDefaultsView,
  UpdateEventInput,
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
 * Development-only identity header, mirroring `DEV_ACTOR_HEADER` in the API.
 *
 * Session cookies are the real mechanism (ADR 0024) and are all a production
 * build uses. The server already ignores this header outside development, so
 * sending it would be harmless - but it would still put seeded user ids on
 * the wire of every request a real person makes, which is a leftover rather
 * than a control. `attachDevActor` is compiled away entirely; see lib/dev.ts.
 */
const DEV_ACTOR_HEADER = 'x-dev-actor-id';

const attachDevActor = (headers: Record<string, string>, actorId: string | null): void => {
  // `import.meta.env.DEV` is substituted with `false` at build time, so this
  // body is removed from the production bundle rather than skipped at runtime.
  if (import.meta.env.DEV && actorId !== null && actorId !== '') {
    headers[DEV_ACTOR_HEADER] = actorId;
  }
};

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
  attachDevActor(headers, actorId);

  const response = await fetch(`/api${path}`, {
    headers,
    // The session lives in an HttpOnly cookie, so it has to be sent explicitly
    // — `same-origin` is the default in modern browsers but stating it means a
    // future change of base URL fails loudly rather than silently signing
    // everyone out (docs/adr/0024-authentication.md).
    credentials: 'same-origin',
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
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  actorId: string | null,
  payload: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  attachDevActor(headers, actorId);

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
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
const put = <T>(path: string, actorId: string | null, payload: unknown) =>
  send<T>('PUT', path, actorId, payload);
const del = <T>(path: string, actorId: string | null) =>
  send<T>('DELETE', path, actorId, {});

const window_ = (start: Date, end: Date): string =>
  `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;

export const api = {
  // ── Authentication ────────────────────────────────────────────────
  //
  // No token is returned or stored: the session is an HttpOnly cookie the
  // browser carries for us, and one that JavaScript can read is one an XSS can
  // steal (ADR 0006's constraint, ADR 0024's implementation).
  register: (input: RegisterInput, _actorId?: string | null) =>
    post<AuthResult>('/v1/auth/register', null, input),

  login: (input: LoginInput, _actorId?: string | null) =>
    post<AuthResult>('/v1/auth/login', null, input),

  logout: () => post<{ ok: true }>('/v1/auth/logout', null, {}),

  me: (actorId: string | null, signal?: AbortSignal) =>
    get<MeView>('/v1/me', actorId, signal),

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

  updateEvent: (id: string, input: UpdateEventInput, actorId: string | null) =>
    patch<EventFullView>(`/v1/events/${id}`, actorId, input),

  deleteEvent: (id: string, actorId: string | null) =>
    del<{ deleted: true }>(`/v1/events/${id}`, actorId),

  /** Carries `preset` and `chosen` alongside the rules — see ADR 0021. */
  sharingDefaults: (actorId: string | null, signal?: AbortSignal) =>
    get<SharingDefaultsView>('/v1/me/sharing-defaults', actorId, signal),

  setSharingDefaults: (input: SharingDefaults, actorId: string | null) =>
    put<SharingDefaultsView>('/v1/me/sharing-defaults', actorId, input),

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

  /**
   * "When are we all free?" — an intersection over per-viewer projections.
   *
   * A POST because the participant list is a body, not because it writes.
   */
  findSlots: (input: FindSlotsInput, actorId: string | null) =>
    post<FindSlotsResult>('/v1/slots/find', actorId, input),

  // ── Friends, requests, and blocking ───────────────────────────────
  //
  // `status` on a search result comes from the server, like everything else
  // here. The client never derives who can see what — that is the one rule
  // apps/web has (docs/adr/0028-friend-requests-and-blocking.md).
  searchPeople: (q: string, actorId: string | null, signal?: AbortSignal) =>
    get<{ results: PersonSearchResult[] }>(
      `/v1/people/search?q=${encodeURIComponent(q)}`,
      actorId,
      signal,
    ),

  friendRequests: (actorId: string | null, signal?: AbortSignal) =>
    get<{ requests: FriendRequestView[] }>('/v1/me/friend-requests', actorId, signal),

  sendFriendRequest: (userId: string, actorId: string | null) =>
    post<FriendRequestView>(`/v1/people/${userId}/friend-request`, actorId, {}),

  respondToFriendRequest: (
    userId: string,
    decision: RespondToFriendRequestInput['decision'],
    actorId: string | null,
  ) => post<{ status: 'FRIEND' | 'NONE' }>(`/v1/me/friend-requests/${userId}`, actorId, { decision }),

  /** Unfriend, or withdraw a request you sent — one call, because one write. */
  removeFriendship: (userId: string, actorId: string | null) =>
    del<{ removed: true }>(`/v1/people/${userId}/friendship`, actorId),

  blockPerson: (userId: string, actorId: string | null) =>
    put<{ blocked: true }>(`/v1/people/${userId}/block`, actorId, {}),

  /**
   * Lifts **your** block only. If they also blocked you, that stands — there
   * is no call here that could change it, and there is no call anywhere that
   * would tell you it exists.
   */
  unblockPerson: (userId: string, actorId: string | null) =>
    del<{ blocked: false }>(`/v1/people/${userId}/block`, actorId),

  blockedPeople: (actorId: string | null, signal?: AbortSignal) =>
    get<{ blocked: PublicProfile[] }>('/v1/me/blocks', actorId, signal),

  // ── Circles ───────────────────────────────────────────────────────
  //
  // Owner-only. There is deliberately no "circles I am in" call, because there
  // is no such endpoint — see docs/adr/0023-circle-management.md.
  circles: (actorId: string | null, signal?: AbortSignal) =>
    get<{ circles: CircleView[] }>('/v1/me/circles', actorId, signal),

  createCircle: (input: CreateCircleInput, actorId: string | null) =>
    post<CircleView>('/v1/me/circles', actorId, input),

  updateCircle: (id: string, input: UpdateCircleInput, actorId: string | null) =>
    patch<CircleView>(`/v1/me/circles/${id}`, actorId, input),

  deleteCircle: (id: string, actorId: string | null) =>
    del<{ deleted: true }>(`/v1/me/circles/${id}`, actorId),

  // ── Your account ──────────────────────────────────────────────────
  exportAccount: (actorId: string | null) =>
    get<AccountExport>('/v1/me/export', actorId),

  deleteAccount: (confirmHandle: string, actorId: string | null) =>
    post<DeletionReceipt>('/v1/me/delete', actorId, { confirmHandle }),

  // ── Things ────────────────────────────────────────────────────────
  listings: (actorId: string | null, signal?: AbortSignal) =>
    get<{ listings: ListingView[] }>('/v1/listings', actorId, signal),

  createListing: (input: CreateListingInput, actorId: string | null) =>
    post<ListingView>('/v1/listings', actorId, input),

  updateListing: (id: string, input: UpdateListingInput, actorId: string | null) =>
    patch<ListingView>(`/v1/listings/${id}`, actorId, input),

  withdrawListing: (id: string, actorId: string | null) =>
    post<ListingView>(`/v1/listings/${id}/withdraw`, actorId, {}),

  claimListing: (id: string, input: ClaimListingInput, actorId: string | null) =>
    post<ListingView>(`/v1/listings/${id}/claims`, actorId, input),

  drawListing: (id: string, actorId: string | null) =>
    post<ListingView>(`/v1/listings/${id}/draw`, actorId, {}),

  decideClaim: (claimId: string, decision: 'ACCEPT' | 'DECLINE', actorId: string | null) =>
    post<ListingView>(`/v1/claims/${claimId}/decide`, actorId, { decision }),

  /**
   * Upload one photo, returning its key.
   *
   * The `data:` prefix is stripped here rather than sent: the server has no
   * field for a client-declared MIME type, because it sniffs the real one from
   * the bytes and a value we accept is a value we would have to remember to
   * ignore.
   */
  uploadPhoto: async (file: File, actorId: string | null): Promise<string> => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('could not read file'));
      reader.readAsDataURL(file);
    });
    const comma = dataUrl.indexOf(',');
    const data = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
    const { key } = await post<{ key: string }>('/v1/photos', actorId, { data });
    return key;
  },

  /** Where a listing photo is served from. Authorized through the listing. */
  photoUrl: (listingId: string, key: string): string =>
    `/api/v1/listings/${listingId}/photos/${key}`,

  // ── The handoff ───────────────────────────────────────────────────
  proposeExchange: (claimId: string, input: ProposeExchangeInput, actorId: string | null) =>
    post<ExchangeView>(`/v1/claims/${claimId}/exchange`, actorId, input),

  respondExchange: (id: string, decision: 'ACCEPT' | 'DECLINE', actorId: string | null) =>
    post<ExchangeView>(`/v1/exchanges/${id}/respond`, actorId, { decision }),

  cancelExchange: (id: string, actorId: string | null) =>
    post<ExchangeView>(`/v1/exchanges/${id}/cancel`, actorId, {}),

  completeExchange: (id: string, actorId: string | null) =>
    post<ExchangeView>(`/v1/exchanges/${id}/complete`, actorId, {}),

  // ── Reporting ─────────────────────────────────────────────────────
  fileReport: (input: FileReportInput, actorId: string | null) =>
    post<ReporterReportView>('/v1/reports', actorId, input),

  myReports: (actorId: string | null, signal?: AbortSignal) =>
    get<{ reports: ReporterReportView[] }>('/v1/reports', actorId, signal),

  /**
   * Reports about you that a moderator has opened a thread on.
   *
   * A separate call from `myReports`, deliberately — the two carry different
   * projections and merging them client-side is how a reporter's words end up
   * rendered to the person they reported.
   */
  reportsAboutMe: (actorId: string | null, signal?: AbortSignal) =>
    get<{ reports: SubjectReportView[] }>('/v1/reports/about-me', actorId, signal),

  /** The thread is derived from who you are; there is no way to name it. */
  replyToReport: (id: string, body: string, actorId: string | null) =>
    post<{ posted: true }>(`/v1/reports/${id}/reply`, actorId, { body }),

  // ── Moderation ────────────────────────────────────────────────────
  moderationQueue: (actorId: string | null, signal?: AbortSignal) =>
    get<{ reports: ModerationQueueRow[] }>('/v1/moderation/reports', actorId, signal),

  moderationReport: (id: string, actorId: string | null, signal?: AbortSignal) =>
    get<ModeratorReportView>(`/v1/moderation/reports/${id}`, actorId, signal),

  moderatorNote: (id: string, input: ModeratorNoteInput, actorId: string | null) =>
    post<ModeratorReportView>(`/v1/moderation/reports/${id}/notes`, actorId, input),

  disposeReport: (id: string, input: DisposeReportInput, actorId: string | null) =>
    post<ModeratorReportView>(`/v1/moderation/reports/${id}/dispose`, actorId, input),

  /** Evidence photos are served through their report, never by key alone. */
  evidencePhotoUrl: (reportId: string, key: string): string =>
    `/api/v1/moderation/reports/${reportId}/photos/${key}`,
};
