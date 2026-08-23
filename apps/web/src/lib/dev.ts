/**
 * Development-only identity spoofing.
 *
 * Switching who you are acting as is genuinely useful while building this
 * product: the whole thesis is that one week looks different to each person,
 * and the fastest way to see that is to become each person. It is also, in
 * production, an invitation to try someone else's id.
 *
 * The server already refuses: `x-dev-actor-id` does nothing outside
 * development, asserted by `auth.test.ts` and `server.test.ts`. This file is
 * the other half — making sure the client never *offers* it.
 *
 * **`import.meta.env.DEV` is not a runtime check.** Vite substitutes the
 * literal `false` into a production build, so the ternary below collapses to
 * `[]` and the bundler removes the list with it. The seed ids are therefore
 * *absent* from shipped JavaScript rather than hidden in it — which is the
 * difference between a feature flag and a deleted feature. `dev.test.ts`
 * asserts that every affordance stays behind this guard.
 */

export interface DevActor {
  readonly id: string;
  readonly name: string;
}

/**
 * The seeded cast, in the order that tells the story: an owner, a friend in a
 * circle, a plain friend, a friend who shares nothing back, and someone
 * blocked. Ids match `apps/api/src/seed.ts`.
 *
 * A function rather than a constant so the array literal sits inside the
 * `DEV` branch, where a production build can eliminate it.
 */
export const devActors = (): readonly DevActor[] =>
  import.meta.env.DEV
    ? [
        { id: '11111111-1111-4111-8111-111111111111', name: 'Alice (owner)' },
        { id: '22222222-2222-4222-8222-222222222222', name: 'Bob (friend, climbing circle)' },
        { id: '33333333-3333-4333-8333-333333333333', name: 'Carol (friend)' },
        { id: '44444444-4444-4444-8444-444444444444', name: 'Dave (friend, shares nothing)' },
        { id: '55555555-5555-4555-8555-555555555555', name: 'Mallory (blocked by Alice)' },
      ]
    : [];

/**
 * The identity to start with before `/v1/me` answers.
 *
 * Empty in production: the session cookie is the only identity, and the shell
 * asks the server for it on boot. In development this pre-selects the first
 * actor so the app is useful without signing in.
 */
export const initialActorId = (): string => devActors()[0]?.id ?? '';
