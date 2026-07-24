import { z } from 'zod';
import { defineRoute } from '../http/route.js';

/**
 * Liveness probe. One of the very few endpoints that is legitimately public,
 * and it earns that by returning a constant — no version string, no dependency
 * status, nothing an attacker could use to fingerprint the deployment.
 */
export const healthRoute = defineRoute({
  method: 'GET',
  url: '/healthz',
  authz: {
    kind: 'PUBLIC',
    justification:
      'Load balancers and container orchestrators must reach this before a session exists. ' +
      'The response is a fixed literal and reveals no version, dependency, or tenant information.',
  },
  params: z.object({}),
  query: z.object({}),
  handler: async () => ({ status: 'ok' as const }),
});
