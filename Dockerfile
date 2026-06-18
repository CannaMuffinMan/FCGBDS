# FCGBDS Customer System Dockerfile

FROM node:18-alpine AS builder

WORKDIR /app

# Install all dependencies (including dev deps) for TypeScript build.
COPY package*.json ./
RUN npm install

# Build from source so dist/ does not need to exist in repo.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:18-alpine AS runtime

WORKDIR /app

# Runtime utilities for health checks and update/archive workflows.
RUN apk add --no-cache \
    bash \
    curl \
    tar \
    gzip

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/public ./src/public

RUN mkdir -p logs

RUN addgroup -g 1001 -S nodejs
RUN adduser -S fcgbds -u 1001

RUN chown -R fcgbds:nodejs /app
USER fcgbds

EXPOSE 3001 3002

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]