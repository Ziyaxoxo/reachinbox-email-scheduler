# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
# Use npm install instead of npm ci to tolerate lockfile drift across npm versions
RUN npm install

COPY . .
# The build emits a placeholder for the API origin. It cannot know the real
# value: Render injects environment variables at runtime, after this step. See
# next.config.js and scripts/resolve-api-url.mjs.
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache curl

COPY package.json package-lock.json* ./
# Use npm install instead of npm ci to tolerate lockfile drift across npm versions
RUN npm install --omit=dev && npm cache clean --force

# resolve-api-url.mjs rewrites the proxy destination inside the build output on
# every start, and Next.js writes its own caches there too, so the tree is owned
# by the runtime user rather than root.
COPY --chown=node:node --from=builder /app/.next ./.next
COPY --chown=node:node --from=builder /app/next.config.js ./next.config.js
COPY --chown=node:node --from=builder /app/scripts ./scripts
COPY --chown=node:node --from=builder /app/package.json ./package.json

USER node

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000 || exit 1

# "start" resolves the API origin from the runtime environment first, so this
# needs no build argument and no baked-in host.
CMD ["npm", "start"]
