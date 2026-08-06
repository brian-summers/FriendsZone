# Friendszone API.
#
# Multi-stage: the build stage has the toolchain and the dev dependencies, the
# runtime stage has neither. See docs/adr/0027-deploy-on-aws.md.

# ── Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Manifests first, so a dependency install is cached across source-only changes.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json      packages/contracts/
COPY packages/policy/package.json         packages/policy/
COPY packages/design-tokens/package.json  packages/design-tokens/
COPY apps/api/package.json                apps/api/
COPY apps/web/package.json                apps/web/

# `npm ci` — the lockfile is authoritative. A build that resolves fresh versions
# is a build that can differ from the one that was tested.
RUN npm ci

COPY . .
RUN npm run typecheck && npm run build:web

# Drop dev dependencies from the tree that gets copied forward. PGlite alone is
# several megabytes of WebAssembly the server never loads in production.
RUN npm prune --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Init process, so SIGTERM reaches Node rather than being swallowed by PID 1.
# The graceful shutdown in index.ts closes the database on that signal.
RUN apk add --no-cache tini

ENV NODE_ENV=production

WORKDIR /app

# Non-root. The image needs no write access to anything it ships.
COPY --from=build --chown=node:node /app/node_modules   ./node_modules
COPY --from=build --chown=node:node /app/packages       ./packages
COPY --from=build --chown=node:node /app/apps/api/dist  ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=node:node /app/package.json   ./

# `schema.sql` is data, not code, so `tsc` does not emit it. `applySchema` looks
# beside the compiled module first, which is where this puts it.
COPY --from=build --chown=node:node \
  /app/apps/api/src/repositories/sql/schema.sql \
  ./apps/api/dist/repositories/sql/schema.sql

USER node

EXPOSE 8080

# Readiness, not liveness: this asks whether the database answers, which is what
# an orchestrator should use to decide whether to send traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
