import type { UserId } from '@friendszone/contracts';
import type { ViewerContext } from '@friendszone/policy';
import Fastify, { type FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { Config } from './config.js';
import { createAuthenticator } from './http/authenticate.js';
import { errorToResponse, RateLimitedError, ValidationError } from './http/errors.js';
import { isCookieResponse, isRawResponse } from './http/route.js';
import { createRateLimiter, UNLIMITED } from './http/rate-limit.js';
import { primeDummyHash } from './auth/password.js';
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
    /**
     * Trust exactly as many proxy hops as are configured, never `true`.
     *
     * `trustProxy: true` takes the leftmost `X-Forwarded-For` entry, which is
     * client-supplied — so a caller could prepend a fake address and mint a
     * fresh rate-limit bucket per request. A hop count trusts only the proxies
     * we actually put there.
     */
    trustProxy: config.TRUSTED_PROXY_HOPS,
    // Do not echo the client's request id back into our logs as-is; a
    // client-controlled value in a log field invites log injection.
    genReqId: () => crypto.randomUUID(),
  });

  const authenticate = createAuthenticator(config, repos.sessions);
  const moderatorIds = new Set<string>(config.MODERATOR_IDS);
  // Disabling is a boot failure in production; see config.ts.
  const rateLimiter = config.RATE_LIMIT_ENABLED ? createRateLimiter() : UNLIMITED;

  /**
   * Compute the dummy password hash now, not on the first failed login.
   *
   * Otherwise the very first unknown-email attempt pays for a hash the later
   * ones do not, which is exactly the timing signal `verifyAgainstNobody`
   * exists to erase.
   */
  void primeDummyHash();

  /**
   * Content Security Policy.
   *
   * The client is a self-contained Vite bundle and every image it renders is
   * served from this origin, so the policy can be strict. Two allowances are
   * deliberate and worth knowing:
   *
   *   `img-src data:`      the sign-in and offer flows build data URLs from a
   *                        `FileReader` before upload
   *   `style-src 'unsafe-inline'`
   *                        React `style={{…}}` attributes. Removing it means
   *                        moving a handful of inline styles into the stylesheet
   *                        — worth doing, and not worth blocking a deploy on
   *
   * `frame-ancestors 'none'` is the modern form of the `x-frame-options` header
   * below; both are sent because the older one is still honoured by some
   * middleboxes.
   */
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  // Only meaningful over https, and actively unhelpful over http — a browser
  // that pins a local dev origin to https is a browser that cannot reach it.
  const isHttps = config.PUBLIC_ORIGIN.startsWith('https://');

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', CSP);
    if (isHttps) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    // Calendar responses are per-viewer. A shared cache holding one viewer's
    // projection and serving it to another would defeat the entire model.
    reply.header('cache-control', 'no-store');
    return payload;
  });

  for (const route of buildRoutes(repos, config)) {
    app.route({
      method: route.method,
      url: route.url,
      ...(route.bodyLimit === undefined ? {} : { bodyLimit: route.bodyLimit }),
      handler: async (request, reply) => {
        try {
          const params = parseOrThrow(route.params, request.params);
          const query = parseOrThrow(route.query, request.query);
          // A route without a body schema gets `undefined`, and a body sent to
          // it is simply ignored — never passed through unvalidated.
          const body =
            route.body !== undefined ? parseOrThrow(route.body, request.body) : undefined;
          const actorId = await authenticate(request.headers);

          /**
           * Moderator status comes from the boot-time allowlist and nowhere
           * else — never a header, never a request field, never a stored row.
           * Resolved once here so no handler can decide it for itself.
           */
          const isModerator = actorId !== null && moderatorIds.has(actorId);

          /**
           * Rate limiting, keyed by actor where there is one.
           *
           * Deliberately *after* authentication so an authenticated caller is
           * limited as themselves rather than sharing a bucket with everyone
           * behind the same NAT. Deliberately *before* the handler so a refused
           * request costs no database work.
           *
           * The address fallback is the weak half — shared by NAT, cheap to
           * rotate — and is a speed bump on anonymous traffic rather than a
           * control. See docs/adr/0020-rate-limiting.md.
           */
          const verdict = rateLimiter.check(
            route.rateLimit ?? 'DEFAULT',
            actorId ?? `ip:${request.ip}`,
          );
          if (!verdict.allowed) throw new RateLimitedError(verdict.retryAfterSeconds);

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
            return { viewerId: actorId, relationship, sharedCircleIds, isModerator };
          };

          const cookieHeader =
            typeof request.headers['cookie'] === 'string' ? request.headers['cookie'] : undefined;

          const result = await route.handler({
            params,
            query,
            body,
            actorId,
            viewerFor,
            cookieHeader,
          });

          // Auth routes answer with a cookie attached. The `onSend` hook still
          // runs, so nosniff and no-store apply exactly as they do to JSON.
          if (isCookieResponse(result)) {
            return await reply.header('set-cookie', result.setCookie).send(result.body);
          }
          // Binary answers (photos) declare their own sniffed content type. The
          // `onSend` hook above still runs, so nosniff and no-store apply here
          // exactly as they do to JSON.
          if (isRawResponse(result)) {
            return await reply.type(result.contentType).send(Buffer.from(result.bytes));
          }
          return await reply.send(result);
        } catch (error) {
          const { status, body, headers } = errorToResponse(error);
          if (headers !== undefined) void reply.headers(headers);
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
