# dispatch — single-service Dockerfile
# Builds the React SPA, then runs the Fastify API which serves both
# the JSON API (/api/*) and the built SPA as static files.

# ---- build stage ----
FROM node:20-alpine AS builder
WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy workspace manifests first (layer cache)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/web/package.json ./packages/web/
COPY packages/api/package.json ./packages/api/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/

RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/ ./packages/

# Build the SPA
RUN pnpm --filter @dispatch/web build

# Build the API
RUN pnpm --filter @dispatch/api build

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/web/package.json ./packages/web/
COPY packages/api/package.json ./packages/api/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/

RUN pnpm install --prod --frozen-lockfile

# Copy build artifacts
COPY --from=builder /app/packages/web/dist ./packages/web/dist
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/drizzle ./packages/db/drizzle

# Stage 1 ingestion substrate: bundle _registry.yaml so the classifier can
# route client channel messages without a DB substrate (Stage 2).
# REGISTRY_PATH=/app/registry.yaml is set as a Railway env var to point here.
# See: packet §Ingestion Stage 1 + ADR §A1 / Rollback plan.
COPY boolean-knowledge/clients/_registry.yaml ./registry.yaml

EXPOSE 3000

# Run migrations then start the API server
CMD ["sh", "-c", "node packages/api/dist/migrate.js && node packages/api/dist/server.js"]
