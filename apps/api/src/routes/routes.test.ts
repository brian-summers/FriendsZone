import { describe, expect, it } from 'vitest';
import { ALL_ACTIONS } from '@friendszone/policy';
import { createMemoryRepositories } from '../repositories/memory.js';
import type { Config } from '../config.js';
import { buildRoutes } from './index.js';

const config: Config = {
  NODE_ENV: 'test',
  PORT: 0,
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgres://localhost:5432/test',
  SESSION_SECRET: 'x'.repeat(48),
  PUBLIC_ORIGIN: 'http://localhost:5173',
  MODERATOR_IDS: [],
  REPORTS_EMAIL: 'reports@friends-zone.app',
  RATE_LIMIT_ENABLED: false,
  TRUSTED_PROXY_HOPS: 0,
};

/**
 * Perimeter invariants.
 *
 * These tests do not check that any particular endpoint behaves correctly.
 * They check properties of the *whole route table*, so that a future route -
 * one nobody reviewing this file has seen - still cannot ship without an
 * authorization story. This is the difference between a convention and a
 * control.
 */
describe('route table', () => {
  const routes = buildRoutes(createMemoryRepositories(), config);

  it('is not empty', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('declares an authz spec on every route', () => {
    // `authz` is a required field, so this is belt-and-braces against a cast
    // or a route constructed outside `defineRoute`.
    const undeclared = routes.filter((route) => route.authz === undefined);
    expect(undeclared.map((route) => route.url)).toEqual([]);
  });

  it('requires a substantive justification for every public route', () => {
    const weak = routes
      .filter((route) => route.authz.kind === 'PUBLIC')
      .filter((route) => {
        const spec = route.authz as Extract<typeof route.authz, { kind: 'PUBLIC' }>;
        return spec.justification.trim().length < 40;
      });
    expect(weak.map((route) => route.url)).toEqual([]);
  });

  it('keeps the public surface to an explicit allowlist', () => {
    // Adding a public endpoint should be a deliberate edit to this list, made
    // by someone who had to think about it, not a side effect of a feature PR.
    const publicUrls = routes
      .filter((route) => route.authz.kind === 'PUBLIC')
      .map((route) => `${route.method} ${route.url}`)
      .sort();
    expect(publicUrls).toEqual([
      'GET /healthz',
      // Readiness must answer before the app is in rotation at all.
      'GET /readyz',
      // Authentication cannot require authentication. Each carries a written
      // justification, asserted non-trivial by the test above, and each draws
      // from the tightest rate-limit class (ADR 0024).
      'POST /v1/auth/login',
      'POST /v1/auth/logout',
      'POST /v1/auth/register',
    ]);
  });

  it('names a known action on every policy-gated route', () => {
    for (const route of routes) {
      if (route.authz.kind !== 'POLICY') continue;
      expect(ALL_ACTIONS).toContain(route.authz.action);
    }
  });

  it('validates params and query on every route', () => {
    const unvalidated = routes.filter(
      (route) => route.params === undefined || route.query === undefined,
    );
    expect(unvalidated.map((route) => route.url)).toEqual([]);
  });

  it('registers no duplicate method+url pairs', () => {
    const keys = routes.map((route) => `${route.method} ${route.url}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every state-changing route a body schema', () => {
    // A GET reads and needs no body. Anything that mutates must declare the
    // exact shape it accepts, so no writer ever touches unvalidated input.
    const writersWithoutBody = routes.filter(
      (route) => route.method !== 'GET' && route.body === undefined,
    );
    expect(writersWithoutBody.map((route) => route.url)).toEqual([]);
  });

  it('never lets a mutating route draw from a read bucket', () => {
    // A write is more expensive and more abusable than a read. Getting this
    // backwards would be invisible until someone scripted it.
    const readBuckets = new Set(['READ', 'DEFAULT']);
    const tooLoose = routes.filter(
      (route) => route.method !== 'GET' && readBuckets.has(route.rateLimit ?? 'DEFAULT'),
    );
    expect(tooLoose.map((route) => `${route.method} ${route.url}`)).toEqual([]);
  });

  it('keeps the fan-out endpoints on their own tight buckets', () => {
    // ADR 0008 requires the slot finder be limited separately from ordinary
    // calendar reads; photo upload costs storage per call.
    const bucketOf = (url: string) =>
      routes.find((route) => route.url === url)?.rateLimit;
    expect(bucketOf('/v1/slots/find')).toBe('EXPENSIVE');
    expect(bucketOf('/v1/photos')).toBe('UPLOAD');
  });

  it('declares no body on read routes', () => {
    // A GET with a body schema is almost always a copy-paste mistake; flag it.
    const readersWithBody = routes.filter(
      (route) => route.method === 'GET' && route.body !== undefined,
    );
    expect(readersWithBody.map((route) => route.url)).toEqual([]);
  });
});
