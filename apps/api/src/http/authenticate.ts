import { UserId } from '@friendszone/contracts';
import type { Config } from '../config.js';

/**
 * Resolve the calling principal.
 *
 * **Not implemented.** Session handling, credential storage, and account
 * recovery are deliberately out of scope for the foundation pass — see
 * docs/adr/0006-authentication-deferred.md for why, and for the constraints any
 * implementation has to satisfy.
 *
 * What matters now is that the gap is *loud*. `createAuthenticator` refuses to
 * construct in production, so this cannot be deployed by accident; and the dev
 * shortcut below is gated on the same check rather than on a convention someone
 * might forget. A skeleton that silently authenticates everyone as user 1 is
 * worse than no skeleton at all.
 */
export type Authenticator = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
) => UserId | null;

export const DEV_ACTOR_HEADER = 'x-dev-actor-id';

export function createAuthenticator(config: Config): Authenticator {
  if (config.NODE_ENV === 'production') {
    throw new Error(
      'No production authenticator is implemented. Refusing to start: see docs/adr/0006-authentication-deferred.md',
    );
  }

  return (headers) => {
    const raw = headers[DEV_ACTOR_HEADER];
    if (raw === undefined) return null;
    // A repeated header arrives as an array. Rather than picking one, refuse:
    // header smuggling relies on two parties disagreeing about which wins.
    if (typeof raw !== 'string') return null;

    // Even the development shortcut validates. A malformed id must not reach
    // the policy engine, where it would be compared against real owner ids.
    const parsed = UserId.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };
}
