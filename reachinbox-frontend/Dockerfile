# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# API_URL is read at build time by next.config.js, so it must be a build arg
ARG API_URL=http://localhost:3000
ENV API_URL=$API_URL

COPY package.json package-lock.json* ./
# Use npm install instead of npm ci to tolerate lockfile drift across npm versions
RUN npm install

COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache curl

COPY package.json package-lock.json* ./
# Use npm install instead of npm ci to tolerate lockfile drift across npm versions
RUN npm install --omit=dev && npm cache clean --force

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.js ./next.config.js
COPY --from=builder /app/package.json ./package.json

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000 || exit 1

CMD ["npm", "start"]
