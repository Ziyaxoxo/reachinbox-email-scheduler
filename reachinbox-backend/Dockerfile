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
#
# A worker registers no HTTP listener, so there is nothing for a container probe
# to talk to. An earlier version of this checked `/health/worker` for worker-mode
# containers; that marked every healthy worker unhealthy, because curl got
# connection-refused and exited 1. It also could not have caught the failure it
# was written for: an API replica mislabelled as a worker still answers on 3000,
# and `curl -f` treats that route's deliberate 404 as a failure too.
#
# So the probe stays env-based. It cannot verify which mode was taken, and does
# not pretend to: `resolveMode()` failing to pick worker mode leaves the process
# serving HTTP with a healthy check, which is a real gap in the signal. Close it
# by confirming the mode after deploy instead of guessing here --
#
#   curl -s https://<api>/health/mode        # on the API service
#   docker logs <worker> | grep modeVia      # on the worker service
#
# Both are documented in the README. The alternative, an HTTP probe for worker
# mode, cannot work: the only evidence of a healthy worker is that it is not
# listening.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD if [ -n "$WORKER_MODE" ]; then \
        node -e "process.exit(0)"; \
      else \
        curl -fsS http://localhost:3000/health/live || exit 1; \
      fi

# API mode by default. Worker services select worker mode with WORKER_MODE, so a
# platform that runs this image's own CMD still starts an API replica rather
# than a worker that consumes nothing.
CMD ["node", "dist/index.js"]
