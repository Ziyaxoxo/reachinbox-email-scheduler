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

USER node

EXPOSE 3000

# HTTP probe for API processes. Worker processes override this with a
# liveness check that does not depend on an HTTP listener, so containers are
# not marked unhealthy simply because they consume queues instead of serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD if [ -n "$WORKER_MODE" ]; then \
        node -e "process.exit(0)"; \
      else \
        curl -fsS http://localhost:3000/health/live || exit 1; \
      fi

CMD ["node", "dist/index.js"]
