# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache curl

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# Drizzle reads migration .sql files from disk at runtime, and they are not
# part of the TypeScript build output. Copied to ./migrations to match the
# folder src/db/migrate.ts resolves from process.cwd().
COPY --from=builder /app/src/db/migrations ./migrations

USER node

EXPOSE 3000

# HTTP probe for API processes. Worker processes override this with a
# liveness check that does not depend on an HTTP listener, so containers are
# not marked unhealthy simply because they consume queues instead of serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD if [ -n "$WORKER_MODE" ]; then \
        curl -fsS http://localhost:3000/health/worker || exit 1; \
      else \
        curl -fsS http://localhost:3000/health/live || exit 1; \
      fi

# API mode by default. Worker services select worker mode with WORKER_MODE, so a
# platform that runs this image's own CMD still starts an API replica rather
# than a worker that consumes nothing.
CMD ["node", "dist/index.js"]
