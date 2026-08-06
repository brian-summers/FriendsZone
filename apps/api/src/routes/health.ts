import { z } from 'zod';
import { defineRoute } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';

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

/**
 * Readiness probe. Distinct from liveness on purpose.
 *
 * `/healthz` says the process is running; a load balancer uses it to decide
 * whether to *restart* something. This says the process can serve traffic —
 * which, for this app, means the database answers. Conflating them means a
 * container whose database is briefly unreachable gets killed and restarted
 * into the same condition, in a loop.
 *
 * Still returns a fixed shape on success: no version, no dependency names, no
 * latency figures. A failing check answers 503 with the same bare code every
 * other refusal uses.
 */
export const readyRoute = (repos: Repositories) =>
  defineRoute({
    method: 'GET',
    url: '/readyz',
    authz: {
      kind: 'PUBLIC',
      justification:
        'Orchestrators must reach this before a session exists, and before the app is ' +
        'in the load-balancer rotation at all. The response is a fixed literal either way ' +
        'and names no dependency, version, or tenant.',
    },
    params: z.object({}),
    query: z.object({}),
    handler: async () => {
      // A cheap read that touches the store the same way a request would.
      await repos.directory.handleTaken('__readiness_probe__');
      return { status: 'ready' as const };
    },
  });
