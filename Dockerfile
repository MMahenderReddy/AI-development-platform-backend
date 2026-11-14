# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Install OS-level build deps (pdf-parse needs canvas optionals on some archs)
RUN apk add --no-cache python3 make g++ git

COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Install git (required by simple-git for code generation)
RUN apk add --no-cache git

# Non-root user for sandbox isolation
RUN addgroup -S orch && adduser -S orch -G orch

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Create workspace directory owned by orch user
RUN mkdir -p /workspaces && chown orch:orch /workspaces

USER orch

ENV NODE_ENV=production \
    PORT=4564 \
    ORCHESTRATOR_WORKSPACE_DIR=/workspaces

EXPOSE 4564

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4564/health | grep '"status":"ok"' || exit 1

CMD ["node", "src/server.js"]
