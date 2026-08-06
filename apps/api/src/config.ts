import { z } from 'zod';

/**
 * Configuration is validated once, at boot, and the process exits if anything
 * is wrong.
 *
 * The alternative — reading `process.env` at the point of use with a `??`
 * fallback — is how security controls quietly turn themselves off in
 * production. A missing `SESSION_SECRET` should be a crash, not a default.
 */
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Which store to use.
   *
   *   `postgres://…` / `postgresql://…`  a real server, via `pg`
   *   `pglite://<dir>`                   Postgres 18 in-process, persisted to
   *                                      `<dir>` — a real engine with nothing
   *                                      to install (docs/adr/0026-sql-layer.md)
   *   `memory://`                        the in-memory adapters; tests and a
   *                                      throwaway demo only, and a boot
   *                                      failure in production
   */
  DATABASE_URL: z.string().url(),
  /** 32 bytes minimum. Short secrets are a real, exploitable weakness. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PUBLIC_ORIGIN: z.string().url(),

  /**
   * Comma-separated user ids permitted to use the moderation queue.
   *
   * A deploy-time value, deliberately not a database column and not a field on
   * `User`: a role stored in the database is a role that a write endpoint can be
   * tricked into granting, and a role on the profile is one careless projection
   * away from being public. This one changes only by redeploying.
   *
   * Empty by default — a deployment with no moderators has a moderation queue
   * nobody can open, which is the correct fail-closed posture for an
   * unconfigured system. See docs/adr/0018-reporting-and-moderation.md.
   */
  MODERATOR_IDS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    )
    .pipe(z.array(z.string().uuid()).max(50)),

  /** Where the content-free "a report was filed" pointer is sent. */
  REPORTS_EMAIL: z.string().email().default('reports@friends-zone.app'),

  /**
   * Rate limiting. On by default, and **undisableable in production** — see the
   * boot check below and docs/adr/0020-rate-limiting.md.
   *
   * The flag exists for the test suite, which hammers `app.inject` hundreds of
   * times and would otherwise trip buckets in tests that are about something
   * else entirely.
   */
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),


  /**
   * How many reverse proxies sit in front of this process.
   *
   * `request.ip` feeds the anonymous rate-limit bucket, so getting this wrong
   * matters in both directions:
   *
   *   too low  — every anonymous caller behind the CDN shares one bucket, and
   *              one abuser rate-limits everybody
   *   too high — `X-Forwarded-For` is caller-supplied, so a client can prepend
   *              a fake hop and get a fresh bucket per request
   *
   * Defaults to **0**, which trusts nothing. That is the safe direction: it
   * over-limits rather than allowing a bypass. Behind one CloudFront
   * distribution this is 1.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);

  if (!parsed.success) {
    // Report which variables are wrong, never their values: this output lands
    // in logs and crash reports, and a rejected secret is still a secret.
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }

  const config = parsed.data;

  if (config.NODE_ENV === 'production' && config.SESSION_SECRET.includes('replace-me')) {
    throw new Error('Refusing to start in production with the example SESSION_SECRET');
  }

  // A security control that can be quietly turned off in production is a
  // control that eventually is. Same posture as the authenticator.
  if (config.NODE_ENV === 'production' && !config.RATE_LIMIT_ENABLED) {
    throw new Error('Refusing to start in production with RATE_LIMIT_ENABLED=false');
  }

  // Losing every account on restart is not a state to discover in production.
  if (config.NODE_ENV === 'production' && config.DATABASE_URL.startsWith('memory:')) {
    throw new Error('Refusing to start in production with DATABASE_URL=memory: data would be lost');
  }

  return config;
}
