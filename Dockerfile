# ─── CoreIdentity PCM API ─────────────────────────────────────────────────────
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init

# ─── DEPENDENCIES ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# ─── PRODUCTION ───────────────────────────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production
ENV PORT=3001

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S pcmapi -u 1001
USER pcmapi

COPY --chown=pcmapi:nodejs --from=deps /app/node_modules ./node_modules
COPY --chown=pcmapi:nodejs api/                  ./api/
COPY --chown=pcmapi:nodejs agents/               ./agents/
COPY --chown=pcmapi:nodejs scripts/              ./scripts/
COPY --chown=pcmapi:nodejs agent-orchestrator.js ./
COPY --chown=pcmapi:nodejs package.json          ./

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "api/app.js"]
