import type { UserId } from '@friendszone/contracts';
import type { Action, ViewerContext } from '@friendszone/policy';
import type { z } from 'zod';

/**
 * How a route is authorized.
 *
 * The field is not optional on `RouteDefinition`, so there is no such thing as
 * a route that forgot to think about access control — omitting it is a compile
 * error. Making a route public is still possible, but it costs you a written
 * justification that shows up in review and in the route table.
 */
export type AuthzSpec =
  | {
      kind: 'PUBLIC';
      /**
       * Why this endpoint is safe to expose unauthenticated. Asserted to be
       * non-trivial by a test, so it cannot be satisfied with "n/a".
       */
      justification: string;
    }
  | {
      kind: 'POLICY';
      /**
       * The action the handler must be cleared for before it runs. The handler
       * may perform additional per-record checks — and for calendars it must,
       * since visibility is decided per event — but it may never perform
       * *fewer*.
       */
      action: Action;
    };

/** Everything a handler is given. Handlers receive no raw Fastify objects. */
export interface RequestContext<TParams, TQuery, TBody> {
  readonly params: TParams;
  readonly query: TQuery;
  /**
   * The parsed, validated request body. `undefined` for routes that declare no
   * body schema. Because it is only ever the output of a Zod schema, a handler
   * never touches unvalidated input — the same guarantee params and query have.
   */
  readonly body: TBody;
  /** `null` when unauthenticated. Routes must not assume otherwise. */
  readonly actorId: UserId | null;
  /**
   * Resolves the viewer's relationship to a specific owner. Deliberately a
   * function of `ownerId`: a context built once per request and reused across
   * owners is the classic way to leak one friend's data into another's view.
   */
  readonly viewerFor: (ownerId: UserId) => Promise<ViewerContext>;
}

/**
 * Generic over the *schemas*, not over the parsed values.
 *
 * This matters for more than tidiness. Branded ids like `UserId` have a
 * different input type (`string`) from their output type (`string & Brand`), so
 * a `ZodType<T>` parameter collapses them back to a bare string and the brand —
 * our defence against passing the wrong id into a permission check — silently
 * disappears. Keying off the schema and reading `z.output<>` preserves it.
 */
export interface RouteDefinition<
  PSchema extends z.ZodTypeAny = z.ZodTypeAny,
  QSchema extends z.ZodTypeAny = z.ZodTypeAny,
  BSchema extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  TResult = unknown,
> {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly authz: AuthzSpec;
  readonly params: PSchema;
  readonly query: QSchema;
  /**
   * Optional. A route that mutates state declares the exact shape it accepts;
   * a GET omits this and its handler sees `body: undefined`. There is no path
   * by which a handler reads a body that was not validated first.
   */
  readonly body?: BSchema;
  readonly handler: (
    ctx: RequestContext<
      z.output<PSchema>,
      z.output<QSchema>,
      BSchema extends z.ZodTypeAny ? z.output<BSchema> : undefined
    >,
  ) => Promise<TResult>;
}

/**
 * The shape the route registry stores.
 *
 * `RouteDefinition` is invariant in its schema parameters — they appear both on
 * the schema fields and inside the handler's argument — so a concrete route is
 * not assignable to a "widened" one. Rather than fight that, the registry uses
 * a deliberately erased type. The erasure is safe because every route was fully
 * checked at its `defineRoute` call site; the registry only iterates.
 */
export interface AnyRoute {
  readonly method: RouteDefinition['method'];
  readonly url: string;
  readonly authz: AuthzSpec;
  readonly params: z.ZodTypeAny;
  readonly query: z.ZodTypeAny;
  // Explicitly admits `undefined` so a body-less route — whose `body` field is
  // typed `undefined` — is assignable here under exactOptionalPropertyTypes.
  readonly body?: z.ZodTypeAny | undefined;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  readonly handler: (ctx: RequestContext<any, any, any>) => Promise<unknown>;
}

/**
 * Identity function that exists purely to pin down generics at the definition
 * site, so `ctx.params` is fully typed inside the handler without annotations.
 */
export function defineRoute<
  PSchema extends z.ZodTypeAny,
  QSchema extends z.ZodTypeAny,
  // Defaults to "no body" so a route that omits the field infers `undefined`
  // and its handler sees `body: undefined` rather than an inference error.
  BSchema extends z.ZodTypeAny | undefined = undefined,
  TResult = unknown,
>(
  route: RouteDefinition<PSchema, QSchema, BSchema, TResult>,
): RouteDefinition<PSchema, QSchema, BSchema, TResult> {
  return route;
}
