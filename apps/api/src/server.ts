import type { UserId } from '@friendszone/contracts';
import type { ViewerContext } from '@friendszone/policy';
import Fastify, { type FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { Config } from './config.js';
import { createAuthenticator } from './http/authenticate.js';
import { errorToResponse, ValidationError } from './http/errors.js';
import { buildRoutes } from './routes/index.js';
import type { Repositories } from './repositories/ports.js';

/** 256 KiB. Nothing this API accepts is legitimately larger. */
const BODY_LIMIT_BYTES = 256 * 1024;

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Issue paths are safe to keep for logs; the submitted values are not, and
    // are dropped here rather than at the response boundary.
    throw new ValidationError(result.error.issues.map((issue) => issue.path.join('.')));
  }
  return result.data;
}

export async function createServer(opts: {
  config: Config;
  repos: Repositories;
}): Promise<FastifyInstance> {
  const { config, repos } = opts;

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: BODY_LIMIT_BYTES,
    // Do not echo the client's request id back into our logs as-is; a
    // client-controlled value in a log field invites log injection.
    genReqId: () => crypto.randomUUID(),
  });

  const authenticate = createAuthenticator(config);

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    // Calendar responses are per-viewer. A shared cache holding one viewer's
    // projection and serving it to another would defeat the entire model.
    reply.header('cache-control', 'no-store');
    return payload;
  });

  for (const route of buildRoutes(repos)) {
    app.route({
      method: route.method,
      url: route.url,
      handler: async (request, reply) => {
        try {
          const params = parseOrThrow(route.params, request.params);
          const query = parseOrThrow(route.query, request.query);
          // A route without a body schema gets `undefined`, and a body sent to
          // it is simply ignored — never passed through unvalidated.
          const body =
            route.body !== undefined ? parseOrThrow(route.body, request.body) : undefined;
          const actorId = authenticate(request.headers);

          /**
           * Built per owner, on demand. Handlers cannot obtain a viewer context
           * without naming whose resource they are about to touch, which makes
           * the "reused a stale context across owners" bug hard to write.
           */
          const viewerFor = async (ownerId: UserId): Promise<ViewerContext> => {
            const [relationship, sharedCircleIds] = await Promise.all([
              repos.social.relationship(actorId, ownerId),
              repos.social.sharedCircles(actorId, ownerId),
            ]);
            return { viewerId: actorId, relationship, sharedCircleIds };
          };

          const result = await route.handler({ params, query, body, actorId, viewerFor });
          return await reply.send(result);
        } catch (error) {
          const { status, body } = errorToResponse(error);
          if (status >= 500) {
            request.log.error({ err: error }, 'unhandled error');
          } else {
            // Denials are expected traffic, not incidents. Logged at info with
            // structured fields only — never the resource or the actor's data.
            request.log.info({ status, route: route.url }, 'request refused');
          }
          return await reply.status(status).send(body);
        }
      },
    });
  }

  app.setNotFoundHandler(async (_request, reply) => reply.status(404).send({ error: 'not_found' }));

  return app;
}
