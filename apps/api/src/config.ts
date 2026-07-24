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
  DATABASE_URL: z.string().url(),
  /** 32 bytes minimum. Short secrets are a real, exploitable weakness. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PUBLIC_ORIGIN: z.string().url(),
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

  return config;
}
