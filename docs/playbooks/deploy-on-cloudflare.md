# Deploy on Cloudflare

Friendszone ships as a Cloudflare **Worker that serves static assets** — the
built web client in `apps/web/dist`. The config is [`wrangler.jsonc`](../../wrangler.jsonc)
at the repo root.

## What deploys, and what does not

**Deploys:** the web client. Vite builds it to `apps/web/dist`; the Worker serves
those files, falling back to `index.html` for client-side routes.

**Does *not* deploy: the API.** `apps/api` is a **Fastify (Node) server**, not a
Worker, and it **refuses to boot with `NODE_ENV=production`** on purpose — there
is no real authenticator yet ([ADR 0006](../adr/0006-authentication-deferred.md))
and no persistence ([ADR 0004](../adr/0004-persistence.md)). So the deployed site
is the **front-end only**: it renders, but its `/api/*` calls have nothing to
answer them until an API exists. This is deliberate, not an oversight — see
[the API, later](#the-api-later) for the two honest ways to close it.

The config is intentionally *assets-only*: **no `main` script**, so navigation
requests are served straight from the edge without invoking any Worker code.

## One-time: deploy from your machine

```bash
npx wrangler login        # opens a browser, authorizes your Cloudflare account
npm run deploy            # = build:web  +  wrangler deploy
```

`wrangler deploy` uploads `apps/web/dist` and publishes to
`https://friends-zone.<your-subdomain>.workers.dev`. To preview exactly what
Cloudflare will serve (including the SPA fallback) without deploying:

```bash
npm run preview:cf        # build:web + wrangler dev
```

## Serve traffic from the GitHub repository (Workers Builds)

This is the durable setup: connect the repo once, and every push to `main`
builds and deploys automatically. Cloudflare calls it **Workers Builds**.

### 1. Connect the repository

- Dashboard → **Workers & Pages**.
  - **New Worker:** **Create application → Import a repository**.
  - **Existing Worker:** open it → **Settings → Builds → Connect**.
- Authorize the **Cloudflare GitHub app** when prompted, and grant it access to
  this repository (you can scope it to just this repo).
- Pick the repo, and set the **production branch** to `main`.

> ⚠️ The Worker's **name in the dashboard must equal `name` in `wrangler.jsonc`**
> (`friends-zone`) or the build fails. If you let the import create the Worker,
> it uses the config name automatically.

### 2. Build settings

| Setting | Value | Why |
|---|---|---|
| **Root directory** | *(repo root — leave blank)* | Install and build run here so the npm **workspaces** resolve and Vite can read `packages/*` sources. |
| **Build command** | `npm run build:web` | Typechecks the monorepo, then `vite build` → `apps/web/dist`. |
| **Deploy command** | `npx wrangler deploy` | The default. Publishes the assets and promotes the new version to production. |
| **Non-production branch deploy command** | `npx wrangler versions upload` | The default. Pushes to other branches create a **preview version** (its own URL) *without* touching production. |

Cloudflare runs `npm ci` automatically (a `package-lock.json` is committed), then
your build command, then the deploy command, all from the root directory. No
build **variables or secrets** are needed — the static build reads no env.

### 3. That's it

Push to `main` → Cloudflare builds and deploys. Push to any other branch → you
get a preview URL to click through before merging. Build logs live under the
Worker's **Builds** tab.

## Custom domain (friends-zone.app)

Once the zone `friends-zone.app` is on this Cloudflare account: Worker →
**Settings → Domains & Routes → Add → Custom domain** → `friends-zone.app` (and
`www` if wanted). Cloudflare provisions the certificate and routes the apex to
the Worker. No `wrangler.jsonc` change is required for a custom domain.

## The API, later

When the front-end needs a live backend, pick one:

1. **Port the edge to a Worker.** Re-implement the HTTP routes on the Workers
   runtime (e.g. Hono) in front of the *unchanged* `packages/policy` kernel and
   `packages/contracts` — those are pure and already Worker-safe. Add `main` to
   `wrangler.jsonc` and route the API to it with
   `"assets": { "run_worker_first": ["/api/*"] }`, so only `/api/*` hits the
   Worker and everything else is served straight from assets. This also needs a
   real authenticator ([ADR 0006](../adr/0006-authentication-deferred.md)) and
   persistence ([ADR 0004](../adr/0004-persistence.md)) — e.g. D1 or Hyperdrive
   behind the existing repository ports.
2. **Host the Fastify API elsewhere** (a Node host) and point the client's
   `/api` calls at it. The client already sends every request to a same-origin
   `/api/*` path ([apps/web/src/lib/api.ts](../../apps/web/src/lib/api.ts)); add
   a Worker (or a route rule) that proxies `/api/*` to that origin so the
   same-origin, no-CORS story from development holds in production.

Either way the **projection engine stays the one implementation** of the
security model — the client never re-derives a visibility decision.
